import { readFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { ImapFlow } from 'imapflow';
import { Headers as MiniflareHeaders, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BootstrapPayload, EmailDetail, EmailSummary, MailAccount, MailRefreshResult } from '../src/shared/types';
import worker from '../src/worker/index';
import type { Env } from '../src/worker/types';

const imapEndpoints = vi.hoisted(() => new Map<string, number>());
vi.mock('../src/worker/imap', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/worker/imap')>();
  const withImapInbox: typeof original.withImapInbox = (account, cursor, consume) =>
    original.withImapInbox(account, cursor, consume, (options) => new ImapFlow({
      ...options, host: '127.0.0.1', port: imapEndpoints.get(options.host ?? ''),
      secure: false, doSTARTTLS: false,
    }));
  return { ...original, withImapInbox };
});

type TestMail = { uid: number; raw: string; seen?: boolean; size?: number };

function mail(host: string, subject: string, uid: number): TestMail {
  return {
    uid,
    raw: [
      `From: Sender <sender@example.com>`, `To: owner@${host}`, `Subject: ${subject}`,
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=sample', '',
      '--sample', 'Content-Type: text/plain; charset=utf-8', '', '测试正文', '',
      '--sample', 'Content-Type: text/plain', 'Content-Disposition: attachment; filename="receipt.txt"',
      '', 'sample attachment', '', '--sample--', '',
    ].join('\r\n'),
  };
}

function fixture(host: string, netease: boolean, messages: TestMail[]) {
  const state = { authFails: false, uidValidity: 55, commands: [] as string[] };
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let input = '';
    let loggedIn = false;
    let identifiedAfterLogin = false;
    socket.setEncoding('utf8');
    socket.write('* OK IMAP test server ready\r\n');
    socket.on('error', () => {});
    socket.on('data', (chunk: string) => {
      input += chunk;
      while (input.includes('\r\n')) {
        const end = input.indexOf('\r\n');
        const [tag, command, ...args] = input.slice(0, end).split(' ');
        input = input.slice(end + 2);
        const name = command === 'UID' ? `UID ${args[0]}` : command;
        state.commands.push(name);
        const response = [];
        let status = 'OK completed';
        switch (name) {
          case 'CAPABILITY':
            response.push('* CAPABILITY IMAP4rev1 ID');
            break;
          case 'ID':
            if (loggedIn) identifiedAfterLogin = true;
            response.push('* ID ("name" "Fixture" "version" "1")');
            break;
          case 'LOGIN':
            loggedIn = !state.authFails;
            if (!loggedIn) status = 'NO [AUTHENTICATIONFAILED] bad credential';
            break;
          case 'LIST':
            response.push(args.at(-1) === '""' ? '* LIST (\\Noselect) "/" ""' : '* LIST (\\HasNoChildren) "/" "INBOX"');
            break;
          case 'LSUB':
            response.push('* LSUB () "/" "INBOX"');
            break;
          case 'EXAMINE':
          case 'SELECT':
            if (netease && (name === 'EXAMINE' || !identifiedAfterLogin)) {
              status = 'NO Unsafe Login';
              break;
            }
            response.push('* FLAGS (\\Seen)', `* ${messages.length} EXISTS`, `* OK [UIDVALIDITY ${state.uidValidity}] stable UIDs`);
            if (!netease) response.push(`* OK [UIDNEXT ${(messages.at(-1)?.uid ?? 0) + 1}] next UID`);
            status = `OK [${name === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] selected`;
            break;
          case 'FETCH':
          case 'UID FETCH': {
            const isUid = name === 'UID FETCH';
            const [first, last = first] = args[isUid ? 1 : 0].split(':');
            const max = isUid ? messages.at(-1)?.uid ?? 0 : messages.length;
            const start = Number(first);
            const finish = last === '*' ? max : Number(last);
            const withSource = args.join(' ').includes('BODY.PEEK[]');
            if (withSource) state.commands.push('BODY.PEEK[]');
            messages.forEach((message, index) => {
              const seq = index + 1;
              const id = isUid ? message.uid : seq;
              if (id < Math.min(start, finish) || id > Math.max(start, finish)) return;
              if (withSource) {
                const bytes = Buffer.byteLength(message.raw);
                const size = message.size ?? bytes;
                const seen = message.seen ? '\\Seen' : '';
                response.push(
                  `* ${seq} FETCH (UID ${message.uid} FLAGS (${seen}) RFC822.SIZE ${size} INTERNALDATE "21-Nov-2026 09:10:00 +0000" BODY[]<0> {${bytes}}\r\n${message.raw})`,
                );
              } else {
                response.push(`* ${seq} FETCH (UID ${message.uid})`);
              }
            });
            break;
          }
          default:
            status = 'BAD unsupported test command';
        }
        response.push(`${tag} ${status}`);
        socket.write(response.join('\r\n') + '\r\n');
      }
    });
  });
  return { host, state, server, sockets };
}

const qqMail: TestMail[] = [{ ...mail('qq.com', 'QQ 测试邮件', 41), seen: true }];
const neteaseMail = [mail('163.com', '163 测试邮件', 71)];
const qq = fixture('imap.qq.com', false, qqMail);
const netease = fixture('imap.163.com', true, neteaseMail);
let miniflare: Miniflare;
let env: Env;
let cookie: string;
const origin = 'http://mailbox.example';
const code = 'ABCDEFGHIJKLMNOP';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to bind IMAP fixture');
  return address.port;
}

async function request(path: string, method = 'GET', body?: unknown, session = cookie, requestOrigin = origin) {
  const headers = new Headers({ Origin: requestOrigin });
  if (session) headers.set('Cookie', session);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return worker.fetch(new Request(origin + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}

async function migrate(file: string) {
  const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
  for (const statement of sql.replace(/^--.*$/gm, '').split(';')) {
    if (statement.trim()) await env.DB.prepare(statement.trim()).run();
  }
}

beforeAll(async () => {
  for (const { host, server } of [qq, netease]) imapEndpoints.set(host, await listen(server));
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: ['DB'], r2Buckets: ['ATTACHMENTS'],
    bindings: {
      APP_NAME: 'Mailbox Vault', PRIMARY_DOMAIN: 'emomo.net', ADMIN_EMAIL: 'owner@example.com',
      ADMIN_PASSWORD: 'local-works-only', SESSION_SECRET: 'fixture-session-signing-secret',
      MAIL_ACCOUNT_KEY: Buffer.alloc(32, 69).toString('base64'),
    },
  });
  env = await miniflare.getBindings<Env>();
  await migrate('0001_initial.sql');
  const date = '2026-11-20T14:00:00.000Z';
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO aliases (id, local_part, domain, address, created_at, updated_at) VALUES ('legacy', 'legacy', 'emomo.net', 'legacy@emomo.net', ?1, ?1)",
    ).bind(date),
    env.DB.prepare(
      "INSERT INTO emails (id, alias_id, from_address, to_address, subject, received_at) VALUES ('legacy-email', 'legacy', 'sender@example.com', 'legacy@emomo.net', '现有别名邮件', ?1)",
    ).bind(date),
  ]);
  await migrate('0002_imap_accounts.sql');
  const login = await request('/api/session', 'POST', { password: env.ADMIN_PASSWORD });
  expect(login.status).toBe(200);
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
}, 15_000);

afterAll(async () => {
  await miniflare?.dispose();
  for (const { server, sockets } of [qq, netease]) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('connected mail accounts', () => {
  it('imports both providers and legacy mail via the API, preserves attachments and retries one failed account', async () => {
    const accountBody = (email: string, authorizationCode = code) => ({ email, authorizationCode });
    expect((await request('/api/mail-accounts', 'POST', accountBody('owner@qq.com'), '')).status).toBe(401);
    expect((await request('/api/mail-accounts', 'POST', accountBody('owner@qq.com'), cookie, 'http://other.example')).status).toBe(403);
    expect((await request('/api/mail-accounts', 'POST', accountBody('owner@example.com'))).status).toBe(400);

    const add = async (email: string, authorizationCode = code) => {
      const response = await request('/api/mail-accounts', 'POST', accountBody(email, authorizationCode));
      expect(response.status).toBe(200);
      const output = await response.text();
      expect(output).not.toContain(authorizationCode);
      return (JSON.parse(output) as { account: MailAccount }).account;
    };
    const qqAccount = await add('OWNER@qq.com');
    const neteaseAccount = await add('owner@163.com', 'ABCD EFGH IJKL MNOP');
    const encrypted = await env.DB.prepare('SELECT credential FROM imap_accounts').all<{ credential: string }>();
    expect(encrypted.results).toHaveLength(2);
    expect(encrypted.results.every(({ credential }) => !credential.includes(code))).toBe(true);
    expect(encrypted.results[0].credential).not.toBe(encrypted.results[1].credential);

    const refresh = async (id: string) => {
      const response = await request(`/api/mail-accounts/${id}/refresh`, 'POST');
      expect(response.status).toBe(200);
      return (await response.json() as { result: MailRefreshResult }).result;
    };
    const ids = [qqAccount.id, neteaseAccount.id];
    const first = await Promise.all(ids.map(refresh));
    expect(first.map(({ imported, error }) => ({ imported, error }))).toEqual([
      { imported: 1, error: undefined }, { imported: 1, error: undefined },
    ]);
    expect(netease.state.commands.slice(netease.state.commands.indexOf('LOGIN'))).toContain('ID');
    expect(netease.state.commands).toContain('SELECT');
    expect(netease.state.commands).not.toContain('EXAMINE');
    expect(qq.state.commands).toContain('BODY.PEEK[]');

    const listing = await request('/api/emails');
    const { emails } = await listing.json() as { emails: EmailSummary[] };
    expect(emails.map(({ subject }) => subject).sort()).toEqual(['163 测试邮件', 'QQ 测试邮件', '现有别名邮件']);
    expect(emails.find(({ aliasId }) => aliasId === qqAccount.id)?.readAt).toBeTruthy();
    const detail = await request(`/api/emails/${emails.find(({ aliasId }) => aliasId === neteaseAccount.id)?.id}`);
    const { email } = await detail.json() as { email: EmailDetail };
    expect(email.bodyText).toContain('测试正文');
    // The pinned Miniflare binding proxy serializes its own Headers class.
    vi.stubGlobal('Headers', MiniflareHeaders);
    try {
      const download = await request(`/api/attachments/${email.attachments[0].id}/download`);
      expect(download.status).toBe(200);
      expect(await download.text()).toContain('sample attachment');
    } finally {
      vi.unstubAllGlobals();
    }

    const overview = await request('/api/bootstrap');
    const overviewData = await overview.json() as BootstrapPayload;
    expect(overviewData.mailAccounts.map(({ address }) => address)).toEqual(['owner@163.com', 'owner@qq.com']);
    expect(overviewData.recentAliases.map(({ id }) => id)).toEqual(['legacy']);
    expect(overviewData.stats.aliasCount).toBe(1);

    expect((await Promise.all(ids.map(refresh))).map(({ imported }) => imported)).toEqual([0, 0]);
    expect((await add('owner@qq.com')).id).toBe(qqAccount.id);
    qqMail.push(mail('qq.com', 'QQ 新邮件', 46));
    netease.state.authFails = true;
    const partial = await Promise.all(ids.map(refresh));
    expect(partial[0].imported).toBe(1);
    expect(partial[1].error).toMatch(/邮箱授权失败/);
    netease.state.authFails = false;
    neteaseMail.push(mail('163.com', '163 新邮件', 72));
    expect((await refresh(neteaseAccount.id)).imported).toBe(1);
    expect((await refresh(neteaseAccount.id)).imported).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM emails').first('total')).toBe(5);
  }, 20_000);
});
