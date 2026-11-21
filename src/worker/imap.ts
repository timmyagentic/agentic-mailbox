import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import type { ImapProvider } from '../shared/types';

const hosts: Record<ImapProvider, string> = {
  qq: 'imap.qq.com',
  netease163: 'imap.163.com',
};

const BATCH_SIZE = 25;
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const REFRESH_TIMEOUT_MS = 35_000;

export type ImapCursor = { uidValidity: string | null; lastUid: number };

export type ImapMessage =
  | { kind: 'mail'; raw: Uint8Array; receivedAt: string; seen: boolean }
  | { kind: 'oversized' | 'missing' };

export function imapRefreshError(error: unknown): string {
  if (error instanceof Error) {
    const serverText = 'responseText' in error && typeof error.responseText === 'string' ? error.responseText : '';
    if (/unsafe login/i.test(`${error.message} ${serverText}`)) {
      return '邮箱服务商拒绝打开收件箱，请确认 IMAP 服务已开启后重试。';
    }
    if (('authenticationFailed' in error && error.authenticationFailed === true) || error.name === 'AuthenticationFailure') {
      return '邮箱授权失败，请确认 IMAP 已开启，并更新客户端授权码。';
    }
  }
  return '邮箱同步失败，请稍后重试。';
}

type Timeline = { uidValidity: string; uids: number[]; hasMore: boolean };
type Inbox = Timeline & { read: (uid: number) => Promise<ImapMessage> };

export async function withImapInbox<T>(
  account: { provider: ImapProvider; address: string; authorizationCode: string },
  cursor: ImapCursor,
  consume: (inbox: Inbox) => Promise<T>,
  createClient: (options: ImapFlowOptions) => ImapFlow = (options) => new ImapFlow(options),
): Promise<T> {
  const client = createClient({
    host: hosts[account.provider],
    port: 993,
    secure: true,
    auth: { user: account.address, pass: account.authorizationCode },
    clientInfo: { name: 'Mailbox Vault' },
    disableAutoIdle: true,
    disableCompression: true,
    connectionTimeout: 8_000,
    greetingTimeout: 6_000,
    socketTimeout: 8_000,
    logger: false,
  });
  // ImapFlow rejects pending commands on disconnect and also emits an error.
  client.on('error', () => {});
  const timeout = setTimeout(() => client.close(), REFRESH_TIMEOUT_MS);

  try {
    await client.connect();
    if (account.provider === 'netease163' && client.capabilities.has('ID')) {
      // Some Coremail servers answer the pre-login ID without enabling inbox access.
      // Keep this post-login ID even when ImapFlow considers its initial ID sufficient.
      if (!('run' in client) || typeof client.run !== 'function') throw new Error('IMAP ID unavailable');
      await client.run('ID', client.clientInfo);
    }

    // Coremail may reject EXAMINE. FETCH uses BODY.PEEK and leaves server flags untouched.
    const box = await client.mailboxOpen('INBOX', { readOnly: account.provider !== 'netease163' });
    if (!box.uidValidity) throw new Error('IMAP server did not supply UIDVALIDITY');
    const uidValidity = String(box.uidValidity);
    const lastUid = cursor.uidValidity === uidValidity ? cursor.lastUid : 0;

    let uids: number[] = [];
    if (box.exists > 0) {
      if (lastUid === 0) {
        // Initial import covers the most recent messages and works without UIDNEXT.
        const recent = await client.fetchAll(`${Math.max(1, box.exists - BATCH_SIZE + 1)}:${box.exists}`, { uid: true });
        uids = recent.map((message) => message.uid);
      } else {
        const firstUid = lastUid + 1;
        // UID FETCH avoids relying on provider-specific extended SEARCH syntax.
        // Filtering also handles IMAP's reversed ranges when * is below firstUid.
        for await (const { uid } of client.fetch(`${firstUid}:*`, { uid: true }, { uid: true })) {
          if (uid < firstUid) continue;
          uids.push(uid);
          uids.sort((a, b) => a - b);
          if (uids.length > BATCH_SIZE + 1) uids.pop();
        }
      }
    }
    uids.sort((a, b) => a - b);

    return await consume({
      uidValidity,
      uids: uids.slice(0, BATCH_SIZE),
      hasMore: uids.length > BATCH_SIZE,
      read: async (uid) => {
        const message = await client.fetchOne(uid, {
          source: { maxLength: MAX_MESSAGE_BYTES + 1 },
          size: true, flags: true, internalDate: true,
        }, { uid: true });
        if (!message) return { kind: 'missing' };
        const raw = message.source;
        if ((message.size ?? 0) > MAX_MESSAGE_BYTES || (raw && raw.byteLength > MAX_MESSAGE_BYTES)) {
          return { kind: 'oversized' };
        }
        if (!raw?.byteLength || (message.size !== undefined && raw.byteLength < message.size)) {
          throw new Error('IMAP message source is incomplete');
        }
        const internalDate = message.internalDate ? new Date(message.internalDate) : undefined;
        return {
          kind: 'mail', raw,
          receivedAt: internalDate && !Number.isNaN(internalDate.getTime()) ? internalDate.toISOString() : new Date().toISOString(),
          seen: message.flags?.has('\\Seen') ?? false,
        };
      },
    });
  } finally {
    clearTimeout(timeout);
    client.close();
  }
}
