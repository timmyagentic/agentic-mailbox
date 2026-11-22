import PostalMime, { type Attachment, type Mailbox } from 'postal-mime';
import { buildPreview, normalizeAddress, safeFilename, truncateText } from '../shared/validation';
import { getAliasForInbound } from './db';
import { elapsedMs, logEvent, type IngestStage } from './logging';
import type { AliasRow, EmailWorkerMessage, Env } from './types';

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

function selectedHeaders(message: EmailWorkerMessage): string {
  const keys = ['message-id', 'in-reply-to', 'references', 'date', 'reply-to'];
  return JSON.stringify(
    Object.fromEntries(
      keys
        .map((key) => [key, message.headers.get(key)] as const)
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
  alias: AliasRow,
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
      const r2Key = `aliases/${alias.id}/emails/${emailId}/${id}`;
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
  if (messageId) {
    const duplicate = await env.DB.prepare(
      'SELECT id FROM emails WHERE alias_id = ?1 AND message_id = ?2 LIMIT 1',
    )
      .bind(alias.id, messageId)
      .first<{ id: string }>();
    if (duplicate) {
      logEvent('info', { event: 'email_duplicate', processingId: context.processingId, aliasId: alias.id, durationMs: elapsedMs(context.started) });
      return;
    }
  }

  const emailId = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  const subject = truncateText(parsed.subject?.trim() || '(无主题)', 500);
  const bodyText = truncateText(parsed.text ?? '', MAX_BODY_TEXT);
  const bodyHtml = truncateText(parsed.html ?? '', MAX_BODY_HTML);
  const preview = buildPreview(bodyText || bodyHtml.replace(/<[^>]+>/g, ' '));
  const sender = normalizeAddress(message.from) ?? truncateText(message.from, 320);
  context.stage = 'attachments';
  const attachments = await storeAttachments(env, alias, emailId, parsed.attachments, context);

  context.stage = 'database';

  const statements = [
    env.DB.prepare(
      `INSERT INTO emails (
        id, alias_id, message_id, from_address, from_name, to_address, subject,
        preview, body_text, body_html, received_at, sent_at, raw_size, read_at,
        attachment_count, headers_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, ?14, ?15)`,
    ).bind(
      emailId,
      alias.id,
      messageId,
      sender,
      mailboxName(parsed.from),
      recipient,
      subject,
      preview,
      bodyText,
      bodyHtml,
      receivedAt,
      safeIsoDate(parsed.date),
      message.rawSize,
      attachments.length,
      selectedHeaders(message),
    ),
    ...attachments.map((attachment) =>
      env.DB.prepare(
        `INSERT INTO attachments (
          id, email_id, alias_id, filename, content_type, size, content_id,
          disposition, r2_key, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      ).bind(
        attachment.id,
        emailId,
        alias.id,
        attachment.filename,
        attachment.contentType,
        attachment.size,
        attachment.contentId,
        attachment.disposition,
        attachment.r2Key,
        receivedAt,
      ),
    ),
    env.DB.prepare(
      `UPDATE aliases
       SET last_received_at = ?1, updated_at = ?1, message_count = message_count + 1
       WHERE id = ?2`,
    ).bind(receivedAt, alias.id),
  ];

  try {
    await env.DB.batch(statements);
  } catch (error) {
    await removeUploaded(env, attachments, context);
    throw error;
  }

  context.stage = 'forward';
  let forwarding: 'disabled' | 'succeeded' | 'failed' = 'disabled';
  if (env.FORWARD_TO) {
    const traceHeaders = new Headers({
      'X-Agentic-Mailbox-Original-To': recipient,
      'X-Agentic-Mailbox-Email-Id': emailId,
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
    emailId, aliasId: alias.id, attachmentCount: attachments.length,
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
