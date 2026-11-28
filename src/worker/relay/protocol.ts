import { Buffer } from 'node:buffer';
import { createSocketsTransport, ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { smtpSocket } from './smtp-socket';
import type { MailboxProfile, RelayIssue } from '../../shared/mailbox';
import { readOriginal } from '../resend';
import type { RelayEnv } from './profile';

export class RelayFailure extends Error {
  constructor(readonly issue: RelayIssue) {
    super(issue);
  }
}

export type Passwords = { imapPassword: string; smtpPassword: string };
export type MailAuth = Passwords | { accessToken: string };

export async function mailboxAuth(
  env: RelayEnv,
  profile: MailboxProfile,
  passwords: Passwords,
): Promise<MailAuth> {
  if (profile.auth !== 'google') return passwords;
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.GMAIL_CLIENT_ID!,
        client_secret: env.GMAIL_CLIENT_SECRET!,
        refresh_token: env.GMAIL_REFRESH_TOKEN!,
      }),
    });
    const result = await response.json<{ access_token?: string }>();
    if (response.ok && result.access_token) return { accessToken: result.access_token };
  } catch {
    /* Surface only the provider and action that failed. */
  }
  throw new RelayFailure('oauth');
}

export async function withInbox<T>(
  p: MailboxProfile,
  auth: MailAuth,
  use: (client: ImapFlow, validity: string) => Promise<T>,
) {
  const { connect } = await import('cloudflare:sockets');
  const client = new ImapFlow({
    transport: createSocketsTransport((address, options) =>
      connect(address, {
        secureTransport: options?.secureTransport ?? 'off',
        allowHalfOpen: options?.allowHalfOpen ?? false,
      }),
    ),
    host: p.imap.host,
    port: p.imap.port,
    secure: p.imap.tls === 'implicit',
    doSTARTTLS: p.imap.tls === 'starttls',
    auth:
      'accessToken' in auth
        ? { user: p.imapUser, accessToken: auth.accessToken }
        : { user: p.imapUser, pass: auth.imapPassword },
    logger: false,
    disableAutoIdle: true,
    disableCompression: true,
    clientInfo: { name: 'OpenPostway' },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    if (
      p.provider === '163' &&
      client.capabilities.has('ID') &&
      'run' in client &&
      typeof client.run === 'function'
    ) {
      // Coremail may require ID again after authentication, and SELECT rather than EXAMINE.
      await client.run('ID', client.clientInfo);
    }
    const box = await client.mailboxOpen('INBOX', { readOnly: p.provider !== '163' });
    if (!box.uidValidity) throw new RelayFailure('imap');
    return await use(client, String(box.uidValidity));
  } finally {
    client.close();
  }
}

export async function latestUid(client: ImapFlow) {
  const box = client.mailbox;
  if (!box) throw new RelayFailure('imap');
  if (box.uidNext > 0) return box.uidNext - 1;
  if (!box.exists) return 0;
  const newest = await client.fetchOne(String(box.exists), { uid: true });
  if (!newest || !newest.uid) throw new RelayFailure('imap');
  return newest.uid;
}

export async function upcoming(client: ImapFlow, after: number) {
  const box = client.mailbox;
  if (!box || !box.exists || (box.uidNext && box.uidNext <= after + 1)) return [];
  // Fetch metadata separately; issuing nested FETCHes inside an ImapFlow iterator deadlocks.
  const uids: number[] = [];
  for await (const item of client.fetch(String(after + 1) + ':*', { uid: true }, { uid: true })) {
    if (item.uid > after) {
      uids.push(item.uid);
      uids.sort((a, b) => a - b);
      if (uids.length > 10) uids.pop();
    }
  }
  return uids;
}

const maxBytes = 12 * 1024 * 1024;

export async function readNewMail(client: ImapFlow, uid: number, p: MailboxProfile) {
  const item = await client.fetchOne(
    String(uid),
    { source: { maxLength: maxBytes + 1 }, size: true },
    { uid: true },
  );
  if (!item) return null; // Expunged between listing and reading.
  if ((item.size ?? 0) > maxBytes || (item.source?.length ?? 0) > maxBytes)
    throw new RelayFailure('oversize');
  if (!item.source?.length || (item.size !== undefined && item.source.length < item.size))
    throw new RelayFailure('imap');
  try {
    const { original, subject, replyTo } = await readOriginal(item.source, [p.address]);
    if (original.headers.some((h) => h.key.toLowerCase() === 'x-openpostway-relay')) return null;
    return {
      subject,
      replyTo: replyTo ?? undefined,
      text: original.text || (original.html ? undefined : '（原邮件无正文）'),
      html: original.html || undefined,
      attachments: original.attachments.map((part, i) => ({
        filename: part.filename ?? 'attachment-' + (i + 1),
        contentType: part.mimeType,
        content: Buffer.from(part.content as ArrayBuffer),
        cid: part.contentId?.replace(/^<|>$/g, ''),
        contentDisposition:
          part.disposition === 'inline' || part.related ? ('inline' as const) : ('attachment' as const),
      })),
    };
  } catch {
    throw new RelayFailure('message');
  }
}

type Content = NonNullable<Awaited<ReturnType<typeof readNewMail>>> | { subject: string; text: string };

export async function sendSmtp(p: MailboxProfile, auth: MailAuth, content: Content, messageId?: string) {
  const transport = nodemailer.createTransport({
    getSocket: smtpSocket(p.smtp),
    host: p.smtp.host,
    port: p.smtp.port,
    secure: true,
    auth:
      'accessToken' in auth
        ? { type: 'OAuth2', user: p.smtpUser, accessToken: auth.accessToken }
        : { user: p.smtpUser, pass: auth.smtpPassword },
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 25_000,
  });
  try {
    await transport.sendMail({
      ...content,
      from: { name: p.name, address: p.address },
      to: p.destination,
      envelope: { from: p.address, to: [p.destination] },
      messageId,
      headers: { 'Auto-Submitted': 'auto-generated', 'X-OpenPostway-Relay': '1' },
    });
  } catch (error) {
    if (error instanceof RelayFailure) throw error;
    const e = error as { code?: string; responseCode?: number; command?: string; timeoutType?: string };
    if ((e.responseCode ?? 0) >= 500 && ['RCPT TO', 'DATA'].includes(e.command ?? '')) {
      throw new RelayFailure('rejected');
    }
    const rejected =
      (e.responseCode && e.responseCode >= 400) ||
      ['EAUTH', 'EDNS', 'EENVELOPE', 'ERELAYCONNECT'].includes(e.code ?? '') ||
      ['CONNECT_TIMEOUT', 'GREETING_TIMEOUT'].includes(e.timeoutType ?? '');
    throw new RelayFailure(rejected ? 'smtp' : 'uncertain');
  } finally {
    transport.close();
  }
}
