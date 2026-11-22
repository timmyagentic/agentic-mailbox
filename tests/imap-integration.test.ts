import { readFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';
import { Headers as MiniflareHeaders, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BootstrapPayload, Conversation, ConversationSummary, DraftInput, EmailDetail, EmailSummary, MailAccount, MailDraft, MailRefreshResult } from '../src/shared/types';
import worker from '../src/worker/index';
import type { EmailWorkerMessage, Env } from '../src/worker/types';

const smtpPort = vi.hoisted(() => ({ local: 0 }));
vi.mock('nodemailer', async (importOriginal) => {
  const upstream = await importOriginal<typeof import('nodemailer')>();
  return {
    ...upstream, default: {
      ...upstream.default,
      createTransport: (options: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } }) => {
        if ('streamTransport' in options) return upstream.default.createTransport(options as never);
        expect(options.port).toBe(465);
        expect(options.secure).toBe(true);
        expect(['smtp.qq.com', 'smtp.163.com']).toContain(options.host);
        return upstream.default.createTransport({ ...options, host: '127.0.0.1', port: smtpPort.local, secure: false, ignoreTLS: true });
      },
    },
  };
});

const deliveredSmtp: string[] = [];
let closeAfterSmtpData = false;
const smtpSockets = new Set<Socket>();
const smtp = createServer((socket) => {
  smtpSockets.add(socket);
  socket.on('close', () => smtpSockets.delete(socket));
  socket.on('error', () => {});
  socket.write('220 fixture ESMTP\r\n');
  let input = '';
  let mail: string[] | null = null;
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    input += chunk;
    while (input.includes('\r\n')) {
      const end = input.indexOf('\r\n');
      const line = input.slice(0, end);
      input = input.slice(end + 2);
      if (mail) {
        if (line === '.') {
          deliveredSmtp.push(mail.join('\r\n'));
          mail = null;
          if (closeAfterSmtpData) socket.end();
          else socket.write('250 queued\r\n');
        } else mail.push(line.replace(/^\.\./, '.'));
      } else if (line.startsWith('EHLO')) socket.write('250-fixture\r\n250 AUTH PLAIN\r\n');
      else if (line.startsWith('AUTH PLAIN')) socket.write('235 authenticated\r\n');
      else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) socket.write('250 accepted\r\n');
      else if (line === 'DATA') { mail = []; socket.write('354 send message\r\n'); }
      else if (line === 'QUIT') { socket.end('221 bye\r\n'); }
      else socket.write('500 unexpected command\r\n');
    }
  });
});

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
const origin = 'https://mailbox.example';
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
  smtpPort.local = await listen(smtp);
  for (const { host, server } of [qq, netease]) imapEndpoints.set(host, await listen(server));
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: ['DB'], r2Buckets: ['ATTACHMENTS'],
    bindings: {
      APP_NAME: 'Agentic Mailbox', PRIMARY_DOMAIN: 'emomo.net', ADMIN_EMAIL: 'owner@example.com',
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
      "INSERT INTO emails (id, alias_id, message_id, from_address, to_address, subject, received_at)        VALUES ('legacy-email', 'legacy', '<legacy-root@example.com>', 'sender@example.com', 'legacy@emomo.net', '现有别名邮件', ?1)",
    ).bind(date),
  ]);
  await migrate('0002_imap_accounts.sql');
  await migrate('0003_conversations_and_drafts.sql');
  await migrate('0004_oauth_accounts.sql');
  const login = await request('/api/session', 'POST', { password: env.ADMIN_PASSWORD });
  expect(login.status).toBe(200);
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
}, 15_000);

afterAll(async () => {
  for (const socket of smtpSockets) socket.destroy();
  if (smtp.listening) await new Promise<void>((resolve) => smtp.close(() => resolve()));
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


describe('conversation reading, draft review and outbound delivery', () => {
  it('groups old and new mail, generates a draft, records a single reply, and forwards attachments', async () => {
    const raw = mail('emomo.net', 'Re: legacy', 1).raw.replace('MIME-Version: 1.0', [
      'Message-ID: <legacy-next@example.com>', 'In-Reply-To: <legacy-root@example.com>',
      'References: <legacy-root@example.com>', 'MIME-Version: 1.0',
    ].join('\r\n'));
    const rawBytes = new TextEncoder().encode(raw);
    const forward = vi.fn(async () => {});
    const inbound = {
      from: 'sender@example.com', to: 'legacy@emomo.net', raw: new Response(rawBytes).body,
      rawSize: rawBytes.length, headers: new Headers({
        'message-id': '<legacy-next@example.com>', 'in-reply-to': '<legacy-root@example.com>', references: '<legacy-root@example.com>',
      }), setReject: vi.fn(), forward,
    } as unknown as EmailWorkerMessage;
    await worker.email(inbound, env);
    expect(inbound.setReject).not.toHaveBeenCalled();
    const home = await request('/api/conversations?folder=inbox&aliasId=legacy');
    const { conversations } = await home.json() as { conversations: ConversationSummary[] };
    expect(conversations).toHaveLength(1);
    const incoming = conversations[0];
    expect(incoming.threadCount).toBe(2);
    const oldThread = await request('/api/conversations/legacy-email');
    const thread = await oldThread.json() as Conversation;
    expect(thread.messages.map(({ id }) => id)).toEqual(['legacy-email', incoming.id]);
    expect(thread.messages[1].attachments).toHaveLength(1);

    const cloudMail: EmailMessageBuilder[] = [];
    env.EMAIL = {
      send: async (message: EmailMessage | EmailMessageBuilder) => {
        cloudMail.push(message as EmailMessageBuilder);
        return { messageId: `<cloud-${cloudMail.length}@example.com>` };
      },
    } as NonNullable<Env['EMAIL']>;
    const suggest = vi.fn(async () => ({ response: '<think>internal</think>您好，已收到。' }));
    env.AI = { run: suggest } as unknown as Env['AI'];

    const body: DraftInput = {
      aliasId: 'legacy', to: 'sender@example.com', cc: '', bcc: '', mode: 'reply', sourceEmailId: incoming.id,
      subject: 'Re: legacy', bodyText: '', bodyHtml: '', includeOriginalFiles: false,
    };
    const create = await request('/api/drafts', 'POST', body);
    expect(create.status).toBe(201);
    const { draft } = await create.json() as { draft: MailDraft };
    const suggestion = await request(`/api/drafts/${draft.id}/suggest`, 'POST', { instruction: '礼貌确认收悉' });
    expect(await suggestion.json()).toEqual({ text: '您好，已收到。' });
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(cloudMail).toHaveLength(0);
    expect((await request(`/api/drafts/${draft.id}`, 'PUT', { ...body, bodyText: '审核后的回复' })).status).toBe(200);

    const sendPath = `/api/drafts/${draft.id}/send`;
    await Promise.all([request(sendPath, 'POST', {}), request(sendPath, 'POST', {})]);
    expect(cloudMail).toHaveLength(1);
    expect(cloudMail[0]).toMatchObject({
      from: 'legacy@emomo.net', to: ['sender@example.com'], text: '审核后的回复',
      headers: { 'In-Reply-To': '<legacy-next@example.com>', References: '<legacy-root@example.com> <legacy-next@example.com>' },
    });
    const sent = await request('/api/conversations?folder=sent&aliasId=legacy');
    expect((await sent.json() as { conversations: ConversationSummary[] }).conversations[0].threadCount).toBe(3);

    const forwarded = await request('/api/drafts', 'POST', {
      ...body, mode: 'forward', to: 'forward@example.com', subject: 'Fwd: legacy',
      bodyText: '请看原件', includeOriginalFiles: true,
    } satisfies DraftInput);
    const forwardedDraft = (await forwarded.json() as { draft: MailDraft }).draft;
    const upload = await worker.fetch(new Request(origin + `/api/drafts/${forwardedDraft.id}/files?name=own.txt`, {
      method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'text/plain' }, body: 'added by sender',
    }), env);
    expect(upload.status).toBe(201);
    const forwardSend = await request(`/api/drafts/${forwardedDraft.id}/send`, 'POST', {});
    expect(forwardSend.status).toBe(200);
    expect(cloudMail[1].headers).toEqual({});
    expect(cloudMail[1].attachments?.map((asset) => asset.filename)).toEqual(['own.txt', 'receipt.txt']);
    const stored = await request(`/api/emails/${forwardedDraft.id}`);
    expect((await stored.json() as { email: EmailDetail }).email.attachments).toHaveLength(2);
  }, 20_000);

  it('uses the existing QQ and 163 credentials for SMTP and leaves uncertain delivery locked', async () => {
    for (const domain of ['qq.com', '163.com']) {
      const connection = await request('/api/mail-accounts', 'POST', { email: 'compose@' + domain, authorizationCode: code });
      expect(connection.status).toBe(200);
      const { account } = await connection.json() as { account: MailAccount };
      const response = await request('/api/drafts', 'POST', {
        aliasId: account.id, to: 'recipient@example.com', subject: '出站协议验证', bodyText: '正文内容',
      });
      const { draft } = await response.json() as { draft: MailDraft };
      const sent = await request(`/api/drafts/${draft.id}/send`, 'POST', {});
      expect(sent.status).toBe(200);
      const mime = await PostalMime.parse(deliveredSmtp.at(-1) ?? '');
      expect(mime.from?.address).toBe('compose@' + domain);
      expect(mime.subject).toBe('出站协议验证');
    }
    expect(deliveredSmtp).toHaveLength(2);

    const accountId = await env.DB.prepare("SELECT id FROM aliases WHERE address = 'compose@qq.com'").first<string>('id');
    const losingResponse = await request('/api/drafts', 'POST', {
      aliasId: accountId, to: 'recipient@example.com', subject: 'SMTP 丢失确认', bodyText: '正文内容',
    });
    const smtpDraft = (await losingResponse.json() as { draft: MailDraft }).draft;
    closeAfterSmtpData = true;
    const smtpEndpoint = `/api/drafts/${smtpDraft.id}/send`;
    try {
      expect((await request(smtpEndpoint, 'POST', {})).status).toBe(502);
      expect((await request(smtpEndpoint, 'POST', {})).status).toBe(409);
      expect(deliveredSmtp).toHaveLength(3);
    } finally {
      closeAfterSmtpData = false;
    }

    const failedSend = vi.fn(async () => { throw new Error('simulated connection loss'); });
    env.EMAIL = { send: failedSend } as NonNullable<Env['EMAIL']>;
    const response = await request('/api/drafts', 'POST', {
      aliasId: 'legacy', to: 'recipient@example.com', subject: '发送状态验证', bodyText: '正文内容',
    });
    const { draft } = await response.json() as { draft: MailDraft };
    const endpoint = `/api/drafts/${draft.id}/send`;
    expect((await request(endpoint, 'POST', {})).status).toBe(502);
    expect((await request(endpoint, 'POST', {})).status).toBe(409);
    expect(failedSend).toHaveBeenCalledTimes(1);
    const state = await request(`/api/drafts/${draft.id}`);
    expect((await state.json() as { draft: MailDraft }).draft.status).toBe('uncertain');
  }, 20_000);
});

describe('Gmail and Outlook mailbox OAuth', () => {
  it('binds both providers, refreshes all four inboxes, and dispatches replies and forwards from the correct account', async () => {
    env.MAIL_OAUTH_ORIGIN = origin;
    env.GMAIL_CLIENT_ID = 'fixture-google';
    env.GMAIL_CLIENT_SECRET = 'fixture-google-secret';
    env.OUTLOOK_CLIENT_ID = 'fixture-microsoft';
    env.OUTLOOK_CLIENT_SECRET = 'fixture-microsoft-secret';

    const gmailBase = 'https://gmail.googleapis.com/gmail/v1/users/me';
    const graphBase = 'https://graph.microsoft.com/v1.0/me';
    const graphCursor = `${graphBase}/mailFolders('folderID=')/messages/delta`;
    const time = '2026-11-21T12:00:00.000Z';
    const received = new Map([
      ['g-one', mail('gmail.com', 'Gmail 测试邮件', 81).raw],
      ['g-two', mail('gmail.com', 'Gmail 新邮件', 82).raw],
      ['o-one', mail('outlook.com', 'Outlook 测试邮件', 83).raw],
      ['o-two', mail('outlook.com', 'Outlook 新邮件', 84).raw],
    ]);
    const raw = (id: string) => received.get(id)?.replace('MIME-Version: 1.0', `Message-ID: <${id}@example.com>\r\nMIME-Version: 1.0`) ?? '';
    const accepted: { path: string; raw: string; threadId?: string }[] = [];
    const refreshed: string[] = [];
    const oauthStarts = new Map<string, URL>();
    let gmailNew = false;
    let outlookNew = false;
    let sendStatus = 0;
    let gmailProfileFailure: { status: number; reason: string } | null = null;

    const fetchFixture = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = new URL(String(input));
      expect(options?.redirect).toBe('manual');
      const bearer = new Headers(options?.headers).get('Authorization') ?? '';
      if (url.href === 'https://oauth2.googleapis.com/token' || url.hostname === 'login.microsoftonline.com') {
        const provider = url.hostname === 'oauth2.googleapis.com' ? 'gmail' : 'outlook';
        const form = options?.body as URLSearchParams;
        if (form.get('grant_type') === 'refresh_token') {
          refreshed.push(form.get('refresh_token') ?? '');
          return Response.json({ access_token: `${provider}-new-access`, expires_in: 3600,
            ...(provider === 'outlook' ? { refresh_token: 'outlook-rotated' } : {}) });
        }
        const codeValue = form.get('code') ?? '';
        const start = oauthStarts.get(codeValue);
        expect(start?.searchParams.get('redirect_uri')).toBe(form.get('redirect_uri'));
        const verifier = form.get('code_verifier') ?? '';
        const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
        expect(start?.searchParams.get('code_challenge')).toBe(challenge);
        return Response.json({ access_token: `${provider}-${codeValue}-access`, refresh_token: `${provider}-first-refresh`, expires_in: 1 });
      }

      if (url.hostname === 'openidconnect.googleapis.com') {
        if (bearer.includes('wrong-account')) {
          return Response.json({ sub: 'other-google-subject', email: 'other@gmail.com', email_verified: true });
        }
        return Response.json({ sub: 'google-subject', email: 'owner@gmail.com', email_verified: true });
      }
      if (url.href.startsWith(graphBase + '?')) {
        return Response.json({ id: 'microsoft-subject', mail: 'owner@outlook.com' });
      }
      if (url.href.startsWith(gmailBase)) {
        expect(bearer).toBe('Bearer gmail-new-access');
        if (options?.method === 'POST') {
          if (sendStatus) return new Response(null, { status: sendStatus });
          const payload = JSON.parse(String(options.body)) as { raw: string; threadId?: string };
          accepted.push({ path: url.pathname, raw: Buffer.from(payload.raw, 'base64url').toString(), threadId: payload.threadId });
          return Response.json({ id: 'gmail-accepted' });
        }
        if (url.pathname.endsWith('/profile')) {
          if (gmailProfileFailure) return Response.json({ error: {
            message: 'provider-only detail', details: [{ reason: gmailProfileFailure.reason }],
          } }, { status: gmailProfileFailure.status });
          return Response.json({ historyId: '100' });
        }
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'g-one' }] });
        if (url.pathname.endsWith('/history')) {
          const initial = url.searchParams.get('startHistoryId') === '100';
          return Response.json({
            historyId: gmailNew ? '102' : '100',
            history: gmailNew && initial ? [{ messagesAdded: [{ message: { id: 'g-one' } }, { message: { id: 'g-two' } }] }] : [],
          });
        }
        const id = url.pathname.split('/').at(-1) ?? '';
        return Response.json({
          raw: Buffer.from(raw(id)).toString('base64url'), labelIds: ['INBOX', 'UNREAD'],
          internalDate: String(Date.parse(time)), threadId: `thread-${id}`,
        });
      }
      if (url.href.startsWith(graphBase)) {
        expect(bearer).toBe('Bearer outlook-new-access');
        expect(new Headers(options?.headers).get('Prefer')).toContain('ImmutableId');
        if (options?.method === 'POST') {
          accepted.push({ path: url.pathname, raw: Buffer.from(String(options.body), 'base64').toString() });
          return new Response(null, { status: 202 });
        }
        if (url.pathname.endsWith('/delta')) {
          const prior = url.searchParams.get('$deltatoken');
          const id = !prior ? 'o-one' : outlookNew && prior === 'first' ? 'o-two' : null;
          return Response.json({
            value: id ? [{ id, receivedDateTime: time, isRead: true, conversationId: `thread-${id}` }] : [],
            '@odata.deltaLink': `${graphCursor}?$deltatoken=${outlookNew ? 'second' : 'first'}`,
          });
        }
        if (url.pathname.endsWith('/$value')) return new Response(raw(url.pathname.split('/').at(-2) ?? ''));
      }
      throw new Error('Unexpected provider fixture request');
    });

    try {
      const start = async (provider: 'gmail' | 'outlook', codeValue: string, accountId?: string) => {
        const response = await request(`/api/oauth/${provider}/start`, 'POST', { accountId });
        expect(response.status).toBe(200);
        const url = new URL((await response.json() as { url: string }).url);
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('redirect_uri')).toBe(`${origin}/api/oauth/${provider}/callback`);
        oauthStarts.set(codeValue, url);
        return { state: url.searchParams.get('state'), code: codeValue };
      };

      expect((await request('/api/oauth/gmail/start', 'POST', {}, '')).status).toBe(401);
      expect((await request('/api/oauth/gmail/start', 'POST', {}, cookie, 'http://other.example')).status).toBe(403);
      const google = await start('gmail', 'good-google');
      const callback = await request(`/api/oauth/gmail/callback?state=${google.state}&code=${google.code}`, 'GET', undefined, '');
      expect(callback.status).toBe(303);
      expect(callback.headers.get('Location')).toBe(`/#mailOAuth=gmail&state=${google.state}&code=${google.code}`);
      const otherLogin = await request('/api/session', 'POST', { password: env.ADMIN_PASSWORD }, '');
      const otherSession = otherLogin.headers.get('Set-Cookie')?.split(';')[0] ?? '';
      expect(otherSession).not.toBe(cookie);
      expect((await request('/api/oauth/gmail/finish', 'POST', google, otherSession)).status).toBe(400);
      expect((await request('/api/oauth/outlook/finish', 'POST', google)).status).toBe(400);
      const googleFinished = await request('/api/oauth/gmail/finish', 'POST', google);
      expect(googleFinished.status).toBe(200);
      const googleResult = await googleFinished.json() as { accountId: string };
      expect((await request('/api/oauth/gmail/finish', 'POST', google)).status).toBe(400);
      const microsoft = await start('outlook', 'good-microsoft');
      expect((await request('/api/oauth/outlook/finish', 'POST', microsoft)).status).toBe(200);

      const bootstrap = await (await request('/api/bootstrap')).json() as BootstrapPayload;
      const googleAccount = bootstrap.mailAccounts.find(({ provider }) => provider === 'gmail');
      const outlookAccount = bootstrap.mailAccounts.find(({ provider }) => provider === 'outlook');
      expect(googleResult.accountId).toBe(googleAccount?.id);
      const accounts = bootstrap.mailAccounts.filter(({ address }) => address.startsWith('owner@'));
      expect(accounts.map(({ provider }) => provider).sort()).toEqual(['gmail', 'netease163', 'outlook', 'qq']);
      expect(bootstrap.oauthProviders).toEqual(['gmail', 'outlook']);
      expect(bootstrap.recentAliases.map(({ id }) => id)).toEqual(['legacy']);
      expect(bootstrap.stats.aliasCount).toBe(1);
      const encrypted = await env.DB.prepare('SELECT credential FROM oauth_accounts').all<{ credential: string }>();
      expect(encrypted.results).toHaveLength(2);
      expect(encrypted.results.every(({ credential }) => !credential.includes('-refresh'))).toBe(true);

      const wrong = await start('gmail', 'wrong-account', googleAccount?.id);
      expect((await request('/api/oauth/gmail/finish', 'POST', wrong)).status).toBe(409);
      for (const [status, reason, requiresReauthorization, message] of [
        [403, 'SERVICE_DISABLED', false, 'Gmail API 尚未启用'],
        [403, 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', true, '缺少读取邮件的权限'],
        [403, 'opaque-private-detail', false, '邮箱服务商拒绝了读取请求'],
        [401, 'unauthenticated', true, '邮箱授权已失效'],
      ] as const) {
        gmailProfileFailure = { status, reason };
        const response = await request(`/api/mail-accounts/${googleResult.accountId}/refresh`, 'POST');
        const { result } = await response.json() as { result: MailRefreshResult };
        expect(result).toMatchObject({ imported: 0, lastSyncAt: null, requiresReauthorization });
        expect(result.error).toContain(message);
        expect(result.error).not.toContain('provider-only detail');
      }
      gmailProfileFailure = null;
      const refresh = async () => Promise.all(accounts.map(async ({ id }) => {
        const response = await request(`/api/mail-accounts/${id}/refresh`, 'POST');
        expect(response.status).toBe(200);
        const { result } = await response.json() as { result: MailRefreshResult };
        expect(result.error).toBeUndefined();
        return result.imported;
      }));
      expect(await refresh()).toEqual([0, 1, 1, 0]);
      expect(refreshed.sort()).toEqual(['gmail-first-refresh', 'outlook-first-refresh']);
      gmailNew = true;
      outlookNew = true;
      qqMail.push(mail('qq.com', 'QQ OAuth 回归', 47));
      neteaseMail.push(mail('163.com', '163 OAuth 回归', 73));
      expect(await refresh()).toEqual([1, 1, 1, 1]);
      expect(await refresh()).toEqual([0, 0, 0, 0]);
      expect(refreshed).toHaveLength(2);

      const { emails } = await (await request('/api/emails')).json() as { emails: EmailSummary[] };
      expect(emails.map(({ subject }) => subject)).toEqual(expect.arrayContaining([
        'Gmail 测试邮件', 'Gmail 新邮件', 'Outlook 测试邮件', 'Outlook 新邮件',
      ]));
      const submit = async (draftInput: Partial<DraftInput>, status = 200) => {
        const created = await request('/api/drafts', 'POST', {
          to: 'sender@example.com', subject: '标题', bodyText: '测试出站正文', ...draftInput,
        });
        expect(created.status).toBe(201);
        const { draft } = await created.json() as { draft: MailDraft };
        const response = await request(`/api/drafts/${draft.id}/send`, 'POST', {});
        expect(response.status).toBe(status);
        return draft.id;
      };
      for (const account of [googleAccount, outlookAccount]) {
        const aliasId = account?.id;
        const source = emails.find((email) => email.aliasId === aliasId);
        expect(source?.attachmentCount).toBe(1);
        const sourceEmailId = source?.id;
        await submit({ aliasId, bcc: 'hidden@example.com' });
        await submit({ aliasId, sourceEmailId, mode: 'reply', subject: `Re: ${source?.subject}` });
        await submit({ aliasId, sourceEmailId, mode: 'forward', includeOriginalFiles: true, subject: `Fwd: ${source?.subject}` });
      }
      expect(accepted).toHaveLength(6);
      expect(accepted.slice(0, 3).every(({ path }) => path.endsWith('/messages/send'))).toBe(true);
      expect(accepted[1].threadId).toMatch(/^thread-g-/);
      expect(accepted[2].threadId).toBeUndefined();
      expect(accepted[3].path).toBe('/v1.0/me/sendMail');
      expect(accepted[4].path).toMatch(/\/messages\/o-(one|two)\/reply$/);
      expect(accepted[5].path).toMatch(/\/messages\/o-(one|two)\/forward$/);
      expect(accepted[0].raw).toContain('Bcc: hidden@example.com');
      expect(accepted[3].raw).toContain('Bcc: hidden@example.com');
      for (const index of [1, 4]) {
        const parsed = await PostalMime.parse(accepted[index].raw);
        expect(parsed.from?.address).toBe(index === 1 ? 'owner@gmail.com' : 'owner@outlook.com');
        expect(parsed.inReplyTo).toMatch(/@(example\.com)>/);
      }
      for (const index of [2, 5]) {
        const parsed = await PostalMime.parse(accepted[index].raw);
        expect(parsed.attachments[0].filename).toBe('receipt.txt');
      }

      sendStatus = 503;
      const uncertain = await submit({ aliasId: googleAccount?.id }, 502);
      expect((await request(`/api/drafts/${uncertain}/send`, 'POST', {})).status).toBe(409);
      sendStatus = 403;
      const denied = await submit({ aliasId: googleAccount?.id }, 502);
      expect((await (await request(`/api/drafts/${denied}`)).json() as { draft: MailDraft }).draft.status).toBe('draft');
    } finally {
      fetchFixture.mockRestore();
    }
  }, 35_000);
});
