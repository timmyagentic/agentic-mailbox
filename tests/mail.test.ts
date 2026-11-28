import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { createAlias } from '../src/worker/db';
import { confirmDestination, getSettings, requestDestination, verifyDestination, cancelPending, setRelaySenderName } from '../src/worker/forwarding';
import type { Env, EmailWorkerMessage } from '../src/worker/types';

function testDatabase(db: DatabaseSync) {
  function statement(sql: string, values: SQLInputValue[] = []) {
    return {
      bind: (...next: SQLInputValue[]) => statement(sql, next),
      first: async () => db.prepare(sql).get(...values) ?? null,
      run: async () => ({ meta: db.prepare(sql).run(...values) }),
    };
  }
  return { prepare: statement };
}

function message(to: string, headers = new Headers()) {
  const forwarded = vi.fn().mockResolvedValue({ messageId: 'fixture' });
  const rejected = vi.fn();
  return { forwarded, rejected, event: {
    to, headers, forward: forwarded, setReject: rejected,
    get raw() { throw Error('The forwarding worker opened the MIME stream'); },
  } as unknown as EmailWorkerMessage };
}

let sql: DatabaseSync;
let env: Env;
let verified: boolean;
let code: string;
const target = 'owner+mail@example.org';
const other = 'other@example.org';
const owner = 'member:alice';
const send = vi.fn();
let registry: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  for (const file of readdirSync('migrations').sort()) sql.exec(readFileSync('migrations/' + file, 'utf8'));
  env = { PRIMARY_DOMAIN: 'mail.example.org', FORWARD_TO: 'old@example.org',
    DB: testDatabase(sql), EMAIL: { send }, ROUTING_ACCOUNT_ID: 'fixture', ROUTING_API_TOKEN: 'test' } as unknown as Env;
  verified = false;
  code = '';
  const known = new Set<string>();
  registry = vi.fn(async (_url: string, init: RequestInit) => {
    const result = init.method === 'POST' ? JSON.parse(String(init.body)) as { email: string }
      : [...known].map(email => ({ email, verified: verified ? '2026-01-01' : null }));
    if (!Array.isArray(result)) known.add(result.email);
    return Response.json({ success: true, result, result_info: { total_pages: 1 } });
  });
  vi.stubGlobal('fetch', registry);
  send.mockReset().mockImplementation(async ({ text }) => { code = text.match(/[0-9A-F]{12}/)[0]; });
  for (const level of ['info','warn','error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('forwarding delivery', () => {
  it('forwards existing managed aliases before first login, without storing or parsing any content', async () => {
    await createAlias(env, { localPart: 'signup' });
    const mail = message('Signup@mail.example.org');
    await worker.email(mail.event, env);
    expect(mail.forwarded).toHaveBeenCalledOnce();
    expect(mail.forwarded.mock.calls[0][0]).toBe('old@example.org');
    expect(mail.forwarded.mock.calls[0][1].get('X-Agentic-Mailbox-Original-To')).toBe('signup@mail.example.org');
    expect(sql.prepare('SELECT count(*) AS n FROM emails').get()?.n).toBe(0);
    expect(sql.prepare('SELECT count(*) AS n FROM attachments').get()?.n).toBe(0);
  });

  it('rejects disabled, unknown, external, wrong-domain, looping and unconfigured recipients', async () => {
    await createAlias(env, { localPart: 'disabled' });
    await createAlias(env, { localPart: 'external' });
    sql.exec("UPDATE aliases SET status='disabled' WHERE local_part='disabled'; UPDATE aliases SET routing_mode='external' WHERE local_part='external'");
    const member = await getSettings(env, owner);
    for (const to of ['disabled@mail.example.org','unknown@mail.example.org','external@mail.example.org','other@example.org',member.relay]) {
      const mail = message(to);
      await worker.email(mail.event, env);
      expect(mail.rejected).toHaveBeenCalledOnce(); expect(mail.forwarded).not.toHaveBeenCalled();
    }
    const mail = message((await getSettings(env, 'admin')).relay, new Headers({ 'X-Agentic-Mailbox-Relay': 'mail.example.org' }));
    await worker.email(mail.event, env);
    expect(mail.rejected).toHaveBeenCalledOnce();
  });

  it('propagates a transport failure and lets a later delivery attempt forward', async () => {
    const mail = message((await getSettings(env, 'admin')).relay);
    mail.forwarded.mockRejectedValueOnce(Error('private transport detail'));
    await expect(worker.email(mail.event, env)).rejects.toThrow('Email forwarding failed');
    await worker.email(mail.event, env);
    expect(mail.forwarded).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private transport detail');
  });
});

describe('relay sender identity', () => {
  const display = '测试邮件助手';

  function incoming(to: string, source: string, headers = new Headers()) {
    const event = message(to, headers);
    Object.defineProperties(event.event, {
      raw: { value: new Blob([source]).stream() }, from: { value: 'bounce@example.net' },
    });
    return event;
  }

  it('creates new messages from the same identity for aliases and the relay, carrying the original body and files', async () => {
    const { relay } = await setRelaySenderName(env, 'admin', display);
    const alias = (await createAlias(env, { localPart: 'orders' })).address;
    send.mockResolvedValue({});
    for (const to of [alias, relay]) {
      const raw = ['From: Author <author@example.net>', 'To: Old name <' + to + '>', 'Cc: another@example.net',
        'Bcc: hidden@example.org', 'Reply-To: Desk <reply@example.net>', 'Subject: =?UTF-8?B?5rWL6K+V?=',
        'Message-ID: <original@example.net>', 'MIME-Version: 1.0', 'Content-Type: multipart/related; boundary=outer',
        '', '--outer', 'Content-Type: multipart/alternative; boundary=inner', '', '--inner', 'Content-Type: text/plain',
        '', 'Fixture body', '--inner', 'Content-Type: text/html', '', '<p>Fixture <img src="cid:logo"></p>', '--inner--',
        '--outer', 'Content-Type: image/png; name=logo.png', 'Content-ID: <logo>', 'Content-Disposition: inline; filename=logo.png',
        'Content-Transfer-Encoding: base64', '', 'AAEC/w==', '--outer--', ''].join('\r\n');
      const mail = incoming(to, raw);
      await worker.email(mail.event, env);
      expect(mail.forwarded).not.toHaveBeenCalled();
      expect(mail.rejected).not.toHaveBeenCalled();
      const out = send.mock.lastCall![0];
      expect(out).toMatchObject({ from: { name: display, email: relay }, to: 'old@example.org', subject: '测试',
        replyTo: 'reply@example.net', headers: { 'X-Agentic-Mailbox-Original-To': to, 'X-Agentic-Mailbox-Relay': 'mail.example.org' } });
      expect(out).not.toHaveProperty('cc'); expect(out).not.toHaveProperty('bcc');
      expect(out.headers).not.toHaveProperty('Message-ID');
      expect(out.html).toContain('cid:logo'); expect(out.text).toContain('Fixture body');
      expect(out.attachments).toHaveLength(1);
      expect(out.attachments[0]).toMatchObject({ filename: 'logo.png', type: 'image/png', disposition: 'inline', contentId: 'logo' });
      expect([...new Uint8Array(out.attachments[0].content)]).toEqual([0, 1, 2, 255]);
    }
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('uses the verified target, propagates a send failure, and rejects mail already processed by this relay', async () => {
    const { relay } = await setRelaySenderName(env, owner, display);
    const raw = 'From: writer@example.org\r\nTo: other@example.net\r\nSubject: Subject\r\n\r\nBody';
    const unconfigured = incoming(relay, raw);
    await worker.email(unconfigured.event, env);
    expect(unconfigured.rejected).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const enabled = await setRelaySenderName(env, 'admin', display);
    const msg = incoming(enabled.relay, raw);
    send.mockRejectedValueOnce(Error('provider detail'));
    await expect(worker.email(msg.event, env)).rejects.toThrow('Email forwarding failed');
    expect(msg.forwarded).not.toHaveBeenCalled();
    const loop = incoming(enabled.relay, raw, new Headers({ 'X-Agentic-Mailbox-Relay': 'mail.example.org' }));
    await worker.email(loop.event, env);
    expect(loop.rejected).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
    send.mockResolvedValue({});
    await worker.email(incoming(enabled.relay, raw).event, env);
    expect(send.mock.lastCall![0].replyTo).toBe('writer@example.org');
  });

  it('isolates each sender setting and restores native forwarding when cleared', async () => {
    const admin = await setRelaySenderName(env, 'admin', display);
    expect((await getSettings(env, owner)).senderName).toBeNull();
    for (const invalid of ['', '   ', 'Fake\r\nBcc: victim@example.org', 'x'.repeat(81)]) {
      await expect(setRelaySenderName(env, 'admin', invalid)).rejects.toThrow();
    }
    expect((await setRelaySenderName(env, 'admin', null)).senderName).toBeNull();
    const mail = message(admin.relay);
    await worker.email(mail.event, env);
    expect(mail.forwarded).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
  });
});

describe('destination enrollment', () => {
  it('requires Cloudflare verification and owner-specific proof; switches all that owner’s routes atomically', async () => {
    await createAlias(env, { localPart: 'orders' });
    const admin = await requestDestination(env, 'admin', target);
    expect(admin).toMatchObject({ step: 'provider', pending: target, destination: 'old@example.org' });
    expect(send).not.toHaveBeenCalled();
    verified = true;
    const pending = await verifyDestination(env, 'admin', target);
    expect(pending.step).toBe('code');
    expect(send).toHaveBeenCalledOnce();
    const their = await getSettings(env, owner);
    expect(their.destination).toBeNull();
    await expect(confirmDestination(env, owner, code)).rejects.toThrow();
    expect((await confirmDestination(env, 'admin', code)).destination).toBe(target);
    await expect(confirmDestination(env, 'admin', code)).rejects.toThrow();
    for (const to of [admin.relay, 'orders@mail.example.org']) {
      const mail = message(to);
      await worker.email(mail.event, env);
      expect(mail.forwarded.mock.calls[0][0]).toBe(target);
    }
    const member = await requestDestination(env, owner, other);
    await verifyDestination(env, owner, other);
    await confirmDestination(env, owner, code);
    const mail = message(member.relay);
    await worker.email(mail.event, env);
    expect(mail.forwarded.mock.calls[0][0]).toBe(other);
  });

  it('preserves the active route through outages, cancels, replaced requests and expired codes', async () => {
    const first = await requestDestination(env, 'admin', target);
    verified = true; await verifyDestination(env, 'admin', target);
    const stale = code;
    await requestDestination(env, 'admin', other);
    await expect(confirmDestination(env, 'admin', stale)).rejects.toThrow();
    send.mockRejectedValueOnce(Error('fixture outage'));
    await expect(verifyDestination(env, 'admin', other)).rejects.toThrow();
    expect((await getSettings(env, 'admin')).destination).toBe(first.destination);
    await verifyDestination(env, 'admin', other);
    sql.exec('UPDATE forwarding_settings SET code_sent_at=0');
    await expect(confirmDestination(env, 'admin', code)).rejects.toThrow();
    expect(await cancelPending(env, 'admin')).toMatchObject({ destination: first.destination, pending: null });
    registry.mockRejectedValue(Error('offline'));
    await expect(requestDestination(env, 'admin', other)).rejects.toThrow('Cloudflare');
    expect((await getSettings(env, 'admin')).destination).toBe(first.destination);
  });

  it('declines invalid and managed domains and never sends a verification message to them', async () => {
    for (const target of ['x@mail.example.org', 'x@bad..com', 'x@bad.-com', 'a@example.org\nBcc: b@test.com']) {
      await expect(requestDestination(env, owner, target)).rejects.toThrow();
    }
    expect(registry).not.toHaveBeenCalled();
  });

  it('recognizes addresses on later Cloudflare pages and suppresses immediate duplicate sends', async () => {
    registry.mockImplementation(async (href: string) => {
      const last = href.includes('page=2&');
      return Response.json({ success: true, result: last ? [{ email: target, verified: 'date' }] : [], result_info: { total_pages: 2 } });
    });
    const state = await requestDestination(env, owner, target);
    expect(state.step).toBe('code');
    await verifyDestination(env, owner, target);
    expect(send).toHaveBeenCalledOnce();
  });
});
