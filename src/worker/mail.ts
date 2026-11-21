import PostalMime, { type Attachment, type Mailbox } from 'postal-mime';
import { buildPreview, normalizeAddress, safeFilename, truncateText } from '../shared/validation';
import { getAliasForInbound } from './db';
import { elapsedMs, logEvent, type IngestStage } from './logging';
import { getThreadKey, mailHeaders, messageIds } from './thread-keys';
import type { EmailWorkerMessage, Env } from './types';

const MAX_BODY_TEXT = 500_000;
const MAX_BODY_HTML = 750_000;
const MAX_ATTACHMENTS = 50;

type IngestContext = { processingId: string; started: number; stage: IngestStage };

type StoredAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  contentId: string;
  disposition: string;
  r2Key: string;
};

function attachmentBytes(attachment: Attachment): Uint8Array {
  if (typeof attachment.content === 'string') {
    return new TextEncoder().encode(attachment.content);
  }
  if (attachment.content instanceof Uint8Array) {
    return attachment.content;
  }
  return new Uint8Array(attachment.content);
}

function mailboxName(from: unknown): string {
  if (!from || typeof from !== 'object' || !('name' in from)) {
    return '';
  }
  return truncateText(String((from as Mailbox).name ?? ''), 180);
}

function selectedHeaders(headers: Headers): string {
  const keys = ['message-id', 'in-reply-to', 'references', 'date', 'reply-to', 'cc', 'from'];
  return JSON.stringify(
    Object.fromEntries(
      keys
        .map((key) => [key, headers.get(key)] as const)
        .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
    ),
  );
}

function safeIsoDate(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function removeUploaded(env: Env, stored: StoredAttachment[], context: IngestContext): Promise<void> {
  if (stored.length === 0) return;
  try {
    await env.ATTACHMENTS.delete(stored.map((attachment) => attachment.r2Key));
  } catch {
    // A cleanup failure must not hide the original storage failure.
    logEvent('error', { event: 'attachment_cleanup_failed', processingId: context.processingId, attachmentCount: stored.length });
  }
}

async function storeAttachments(
  env: Env,
  aliasId: string,
  emailId: string,
  attachments: Attachment[],
  context: IngestContext,
): Promise<StoredAttachment[]> {
  const stored: StoredAttachment[] = [];

  try {
    for (const [index, attachment] of attachments.slice(0, MAX_ATTACHMENTS).entries()) {
      const id = crypto.randomUUID();
      const filename = safeFilename(attachment.filename ?? undefined, `attachment-${index + 1}`);
      const content = attachmentBytes(attachment);
      const contentType = truncateText(attachment.mimeType || 'application/octet-stream', 180);
      const r2Key = `aliases/${aliasId}/emails/${emailId}/${id}`;
      await env.ATTACHMENTS.put(r2Key, content, {
        httpMetadata: {
          contentType,
          contentDisposition: `attachment; filename="${filename.replace(/["\\]/g, '_')}"`,
        },
      });
      stored.push({
        id,
        filename,
        contentType,
        size: content.byteLength,
        contentId: truncateText(attachment.contentId ?? '', 255),
        disposition: attachment.disposition ?? 'attachment',
        r2Key,
      });
    }
    return stored;
  } catch (error) {
    await removeUploaded(env, stored, context);
    throw error;
  }
}

type ParsedMail = Awaited<ReturnType<typeof PostalMime.parse>>;

type MailToStore = {
  parsed: ParsedMail;
  messageId: string;
  sender: string;
  recipient: string;
  receivedAt: string;
  rawSize: number;
  headersJson: string;
  readAt?: string | null;
  imapIdentity?: string;
};

async function hasStoredMail(env: Env, aliasId: string, messageId: string, imapIdentity?: string) {
  if (imapIdentity) {
    return env.DB.prepare(
      "SELECT id FROM emails WHERE alias_id = ?1 AND outgoing = 0 AND (imap_identity = ?2 OR (message_id = ?3 AND message_id <> '')) LIMIT 1",
    ).bind(aliasId, imapIdentity, messageId).first<{ id: string }>();
  }

  if (!messageId) return null;
  return env.DB.prepare(
    'SELECT id FROM emails WHERE alias_id = ?1 AND message_id = ?2 AND outgoing = 0 LIMIT 1',
  ).bind(aliasId, messageId).first<{ id: string }>();
}

async function saveMail(env: Env, aliasId: string, mail: MailToStore, context: IngestContext) {
  const { parsed, messageId, sender, recipient, receivedAt, rawSize, headersJson, readAt, imapIdentity } = mail;
  const emailId = crypto.randomUUID();
  const headers = mailHeaders(headersJson);
  const replyTo = messageIds(headers['in-reply-to']).at(-1);
  const parent = replyTo
    ? await env.DB.prepare(
      "SELECT thread_key FROM emails WHERE alias_id = ?1 AND message_id IN (?2, ?3) AND thread_key <> '' LIMIT 1",
    ).bind(aliasId, `<${replyTo}>`, replyTo).first<{ thread_key: string }>()
    : null;
  const threadKey = parent?.thread_key ?? getThreadKey(emailId, messageId, headers);
  const subject = truncateText(parsed.subject?.trim() || '(无主题)', 500);
  const bodyText = truncateText(parsed.text ?? '', MAX_BODY_TEXT);
  const bodyHtml = truncateText(parsed.html ?? '', MAX_BODY_HTML);
  const preview = buildPreview(bodyText || bodyHtml.replace(/<[^>]+>/g, ' '));
  context.stage = 'attachments';
  const attachments = await storeAttachments(env, aliasId, emailId, parsed.attachments, context);

  context.stage = 'database';
  try {
    const insertMail = env.DB.prepare(
      `INSERT INTO emails (
        id, alias_id, message_id, from_address, from_name, to_address, subject,
        preview, body_text, body_html, received_at, sent_at, raw_size, read_at,
        attachment_count, headers_json, imap_identity, thread_key
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
    ).bind(
      emailId, aliasId, messageId, sender, mailboxName(parsed.from), recipient, subject,
      preview, bodyText, bodyHtml, receivedAt, safeIsoDate(parsed.date), rawSize,
      readAt ?? null, attachments.length, headersJson, imapIdentity ?? null, threadKey,
    );
    const insertAttachments = attachments.map((attachment) =>
      env.DB.prepare(
        `INSERT INTO attachments (
          id, email_id, alias_id, filename, content_type, size, content_id,
          disposition, r2_key, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      ).bind(
        attachment.id, emailId, aliasId, attachment.filename, attachment.contentType,
        attachment.size, attachment.contentId, attachment.disposition, attachment.r2Key, receivedAt,
      ),
    );
    const updatedAt = new Date().toISOString();
    const updateAlias = env.DB.prepare(
      `UPDATE aliases
       SET last_received_at = COALESCE(MAX(last_received_at, ?1), ?1),
           updated_at = ?2, message_count = message_count + 1
       WHERE id = ?3`,
    ).bind(receivedAt, updatedAt, aliasId);
    await env.DB.batch([insertMail, ...insertAttachments, updateAlias]);
  } catch (error) {
    await removeUploaded(env, attachments, context);
    throw error;
  }

  return { emailId, attachmentCount: attachments.length };
}

export async function storeImapMail(
  env: Env,
  mail: { accountId: string; address: string; identity: string; raw: Uint8Array; receivedAt: string; seen: boolean },
): Promise<boolean> {
  const context: IngestContext = { processingId: crypto.randomUUID(), started: performance.now(), stage: 'parse' };
  try {
    const parsed = await PostalMime.parse(mail.raw, { attachmentEncoding: 'arraybuffer' });
    const messageId = truncateText(parsed.messageId ?? '', 500);
    context.stage = 'deduplicate';
    if (await hasStoredMail(env, mail.accountId, messageId, mail.identity)) return false;

    const sender = parsed.from?.address ?? '';
    const headersJson = JSON.stringify(Object.fromEntries(parsed.headers
      .filter(({ key }) => ['message-id', 'in-reply-to', 'references', 'date', 'reply-to', 'cc', 'from'].includes(key))
      .map(({ key, value }) => [key, value])));
    await saveMail(env, mail.accountId, {
      parsed, messageId, sender: normalizeAddress(sender) ?? truncateText(sender, 320),
      recipient: mail.address, receivedAt: mail.receivedAt, rawSize: mail.raw.byteLength, headersJson,
      readAt: mail.seen ? mail.receivedAt : null, imapIdentity: mail.identity,
    }, context);
    return true;
  } catch {
    logEvent('error', { event: 'email_ingest_failed', processingId: context.processingId, stage: context.stage, durationMs: elapsedMs(context.started) });
    throw new Error('Unable to store synchronized email');
  }
}

async function processEmail(
  message: EmailWorkerMessage,
  env: Env,
  context: IngestContext,
): Promise<void> {
  const recipient = normalizeAddress(message.to);
  const primaryDomain = env.PRIMARY_DOMAIN.trim().toLowerCase();
  if (!recipient || !recipient.endsWith(`@${primaryDomain}`)) {
    message.setReject('Recipient domain is not managed by this mailbox');
    logEvent('warn', { event: 'email_rejected', processingId: context.processingId, reason: 'unmanaged_domain', durationMs: elapsedMs(context.started) });
    return;
  }

  context.stage = 'alias_lookup';
  const alias = await getAliasForInbound(env, recipient);
  if (!alias) {
    message.setReject('Mailbox is not registered or is disabled');
    logEvent('warn', { event: 'email_rejected', processingId: context.processingId, reason: 'unregistered_or_disabled', durationMs: elapsedMs(context.started) });
    return;
  }

  context.stage = 'parse';
  const raw = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  const messageId = truncateText(message.headers.get('message-id') ?? parsed.messageId ?? '', 500);

  context.stage = 'deduplicate';
  if (await hasStoredMail(env, alias.id, messageId)) {
    logEvent('info', { event: 'email_duplicate', processingId: context.processingId, aliasId: alias.id, durationMs: elapsedMs(context.started) });
    return;
  }

  const { emailId, attachmentCount } = await saveMail(env, alias.id, {
    parsed, messageId, recipient, receivedAt: new Date().toISOString(),
    sender: normalizeAddress(message.from) ?? truncateText(message.from, 320),
    rawSize: message.rawSize, headersJson: selectedHeaders(message.headers),
  }, context);

  context.stage = 'forward';
  let forwarding: 'disabled' | 'succeeded' | 'failed' = 'disabled';
  if (env.FORWARD_TO) {
    const traceHeaders = new Headers({
      'X-Mailbox-Vault-Original-To': recipient,
      'X-Mailbox-Vault-Email-Id': emailId,
    });
    try {
      await message.forward(env.FORWARD_TO, traceHeaders);
      forwarding = 'succeeded';
    } catch {
      forwarding = 'failed';
      logEvent('error', { event: 'forward_failed', processingId: context.processingId, emailId });
    }
  }

  logEvent('info', {
    event: 'email_ingested', processingId: context.processingId,
    emailId, aliasId: alias.id, attachmentCount,
    rawSize: message.rawSize, forwarding, durationMs: elapsedMs(context.started),
  });
}

export async function ingestEmail(message: EmailWorkerMessage, env: Env): Promise<void> {
  const context: IngestContext = { processingId: crypto.randomUUID(), started: performance.now(), stage: 'recipient' };
  try {
    await processEmail(message, env, context);
  } catch {
    logEvent('error', { event: 'email_ingest_failed', processingId: context.processingId, stage: context.stage, durationMs: elapsedMs(context.started) });
    // Keep failure/retry semantics without exposing MIME content, addresses or
    // provider exception text in Cloudflare's automatic exception records.
    throw new Error(`Email processing failed (${context.processingId})`);
  }
}
