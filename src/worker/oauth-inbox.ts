import { Buffer } from 'node:buffer';
import type { OAuthProvider } from '../shared/types';
import { boundedBody } from './http';
import { gmailApi, graphApi, immutableId, MailProviderError, mailProviderFetch } from './oauth';

const batchSize = 25;
const maxRawBytes = 10 * 1024 * 1024;
const graphFolder = `${graphApi}/mailFolders/inbox/messages/delta`;
const day = 24 * 60 * 60 * 1000;

type MailRef = { id: string; receivedAt?: string; seen?: boolean; threadId?: string };
export type OAuthMail = { kind: 'mail'; raw: Uint8Array; receivedAt: string; seen: boolean; remoteThreadId?: string }
  | { kind: 'oversized' | 'missing' };

type GmailHistory = {
  historyId: string;
  pageToken?: string;
  offset?: number;
};
type GmailRecovery = {
  baseline: string;
  after: number;
  pageToken: string;
};
type GraphCursor = { link: string; offset?: number };

async function readGmail(token: string, id: string): Promise<OAuthMail> {
  const url = `${gmailApi}/messages/${encodeURIComponent(id)}?format=raw`;
  const response = await mailProviderFetch(url, token);
  // Gmail encodes MIME as base64url inside a small JSON envelope.
  const payload = await boundedBody(response, Math.ceil(maxRawBytes * 4 / 3) + 16_384);
  if (!payload) return { kind: 'oversized' };
  const message = JSON.parse(payload.toString('utf8')) as {
    raw?: string; labelIds?: string[]; internalDate?: string; threadId?: string;
  };
  if (!message.labelIds?.includes('INBOX')) return { kind: 'missing' };
  if (!message.raw) throw new Error('Missing Gmail MIME');
  const raw = Buffer.from(message.raw, 'base64url');
  if (raw.byteLength > maxRawBytes) return { kind: 'oversized' };
  return {
    kind: 'mail', raw, receivedAt: new Date(Number(message.internalDate)).toISOString(),
    seen: !message.labelIds.includes('UNREAD'), remoteThreadId: message.threadId,
  };
}

async function readOutlook(token: string, message: MailRef): Promise<OAuthMail> {
  const url = `${graphApi}/messages/${encodeURIComponent(message.id)}/$value`;
  const response = await mailProviderFetch(url, token, { headers: { Prefer: immutableId } });
  const raw = await boundedBody(response, maxRawBytes);
  if (!raw) return { kind: 'oversized' };
  return {
    kind: 'mail', raw, receivedAt: new Date(message.receivedAt ?? '').toISOString(),
    seen: message.seen ?? false, remoteThreadId: message.threadId,
  };
}

export async function readOAuthMail(provider: OAuthProvider, token: string, message: MailRef): Promise<OAuthMail> {
  try {
    return provider === 'gmail' ? await readGmail(token, message.id) : await readOutlook(token, message);
  } catch (error) {
    if (error instanceof MailProviderError && error.status === 404) return { kind: 'missing' };
    throw error;
  }
}

type InboxPage = {
  messages: MailRef[];
  cursorAfter: (processed: number) => string | null;
  hasMore: boolean;
};

async function gmailInitial(token: string, recovery?: GmailRecovery, lastSyncAt?: string): Promise<InboxPage> {
  let baseline = recovery?.baseline;
  if (!baseline) {
    const profile = await mailProviderFetch(`${gmailApi}/profile`, token);
    baseline = (await profile.json<{ historyId: string }>()).historyId;
  }
  const after = recovery?.after ?? (lastSyncAt ? Math.floor(Date.parse(lastSyncAt) / 1000) - day / 1000 : null);
  const params = new URLSearchParams({ labelIds: 'INBOX', maxResults: String(batchSize) });
  if (after !== null) params.set('q', `after:${after}`);
  if (recovery) params.set('pageToken', recovery.pageToken);
  const response = await mailProviderFetch(`${gmailApi}/messages?${params}`, token);
  const data = await response.json<{ messages?: MailRef[]; nextPageToken?: string }>();
  const more = after !== null && Boolean(data.nextPageToken);
  const messages = data.messages ?? [];
  return {
    messages,
    hasMore: more,
    cursorAfter: (processed) => processed < messages.length ? (recovery ? JSON.stringify(recovery) : null)
      : JSON.stringify(more ? { baseline, after, pageToken: data.nextPageToken } : { historyId: baseline }),
  };
}

async function gmailHistory(token: string, cursor: GmailHistory): Promise<InboxPage> {
  const params = new URLSearchParams({ startHistoryId: cursor.historyId, labelId: 'INBOX', maxResults: String(batchSize) });
  params.append('historyTypes', 'messageAdded');
  params.append('historyTypes', 'labelAdded');
  if (cursor.pageToken) params.set('pageToken', cursor.pageToken);
  const response = await mailProviderFetch(`${gmailApi}/history?${params}`, token);
  type Change = { message: MailRef; labelIds?: string[] };
  const data = await response.json<{
    historyId: string; nextPageToken?: string;
    history?: { messagesAdded?: Change[]; labelsAdded?: Change[] }[];
  }>();
  const ids = [...new Set((data.history ?? []).flatMap((entry) => [
    ...(entry.messagesAdded ?? []),
    ...(entry.labelsAdded ?? []).filter((change) => change.labelIds?.includes('INBOX')),
  ]).map(({ message }) => message.id))];
  const offset = cursor.offset ?? 0;
  return {
    messages: ids.slice(offset, offset + batchSize).map((id) => ({ id })),
    hasMore: offset + batchSize < ids.length || Boolean(data.nextPageToken),
    cursorAfter: (processed) => {
      if (offset + processed < ids.length) return JSON.stringify({ ...cursor, offset: offset + processed });
      return JSON.stringify(data.nextPageToken
        ? { historyId: cursor.historyId, pageToken: data.nextPageToken }
        : { historyId: data.historyId });
    },
  };
}

async function outlookPage(token: string, cursor: GraphCursor | null, lastSyncAt: string | null): Promise<InboxPage> {
  const start = new URL(graphFolder);
  const since = new Date(lastSyncAt ? Date.parse(lastSyncAt) - day : Date.now() - 30 * day);
  start.searchParams.set('$filter', `receivedDateTime ge ${since.toISOString()}`);
  start.searchParams.set('$orderby', 'receivedDateTime desc');
  start.searchParams.set('$select', 'id,receivedDateTime,conversationId,isRead');
  const url = new URL(cursor?.link ?? start);
  if (url.origin !== start.origin || !/^\/v1\.0\/me\/mailfolders(?:\/[^/]+|\('[^/()]+'\))\/messages\/delta$/i.test(url.pathname)) {
    throw new Error('Invalid Microsoft Graph cursor');
  }
  let response;
  try {
    response = await mailProviderFetch(url.href, token, { headers: { Prefer: `${immutableId}, odata.maxpagesize=${batchSize}` } });
  } catch (error) {
    if (cursor && error instanceof MailProviderError && error.status === 410) return outlookPage(token, null, lastSyncAt);
    throw error;
  }
  const page = await response.json<{
    value: { id: string; receivedDateTime?: string; isRead?: boolean; conversationId?: string; '@removed'?: object }[];
    '@odata.nextLink'?: string; '@odata.deltaLink'?: string;
  }>();
  const next = page['@odata.nextLink'];
  const link = next ?? page['@odata.deltaLink'];
  if (!link) throw new Error('Missing Microsoft Graph cursor');
  const refs = page.value.filter((item) => item.receivedDateTime && !item['@removed']).map((item) => ({
    id: item.id, receivedAt: item.receivedDateTime, seen: item.isRead, threadId: item.conversationId,
  }));
  const offset = cursor?.offset ?? 0;
  return {
    messages: refs.slice(offset, offset + batchSize),
    hasMore: offset + batchSize < refs.length || Boolean(next),
    cursorAfter: (processed) => JSON.stringify(offset + processed < refs.length
      ? { link: url.href, offset: offset + processed } : { link }),
  };
}

export async function loadOAuthInbox(
  provider: OAuthProvider, token: string, cursor: string | null, lastSyncAt: string | null,
): Promise<InboxPage> {
  if (provider === 'outlook') return outlookPage(token, cursor ? JSON.parse(cursor) as GraphCursor : null, lastSyncAt);
  if (!cursor) return gmailInitial(token);
  const checkpoint = JSON.parse(cursor) as GmailHistory | GmailRecovery;
  try {
    return 'historyId' in checkpoint ? await gmailHistory(token, checkpoint) : await gmailInitial(token, checkpoint);
  } catch (error) {
    if (error instanceof MailProviderError && [400, 404].includes(error.status) && lastSyncAt) {
      return gmailInitial(token, undefined, lastSyncAt);
    }
    throw error;
  }
}
