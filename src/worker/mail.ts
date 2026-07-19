import PostalMime, { type Attachment, type Mailbox } from 'postal-mime';
import { buildPreview, normalizeAddress, safeFilename, truncateText } from '../shared/validation';
import { getAliasForInbound } from './db';
import type { AliasRow, EmailWorkerMessage, Env } from './types';

const MAX_BODY_TEXT = 500_000;
const MAX_BODY_HTML = 750_000;
const MAX_ATTACHMENTS = 50;

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

async function removeUploaded(env: Env, stored: StoredAttachment[]): Promise<void> {
  if (stored.length > 0) {
    await env.ATTACHMENTS.delete(stored.map((attachment) => attachment.r2Key));
  }
}

async function storeAttachments(
  env: Env,
  alias: AliasRow,
  emailId: string,
  attachments: Attachment[],
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
    await removeUploaded(env, stored);
    throw error;
  }
}

export async function ingestEmail(
  message: EmailWorkerMessage,
  env: Env,
): Promise<void> {
  const recipient = normalizeAddress(message.to);
  const primaryDomain = env.PRIMARY_DOMAIN.trim().toLowerCase();
  if (!recipient || !recipient.endsWith(`@${primaryDomain}`)) {
    message.setReject('Recipient domain is not managed by this mailbox');
    return;
  }

  const alias = await getAliasForInbound(env, recipient);
  if (!alias) {
    message.setReject('Mailbox is not registered or is disabled');
    return;
  }

  const raw = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  const messageId = truncateText(message.headers.get('message-id') ?? parsed.messageId ?? '', 500);

  if (messageId) {
    const duplicate = await env.DB.prepare(
      'SELECT id FROM emails WHERE alias_id = ?1 AND message_id = ?2 LIMIT 1',
    )
      .bind(alias.id, messageId)
      .first<{ id: string }>();
    if (duplicate) {
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
  const attachments = await storeAttachments(env, alias, emailId, parsed.attachments);

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
    await removeUploaded(env, attachments);
    throw error;
  }

  if (env.FORWARD_TO) {
    const traceHeaders = new Headers({
      'X-Mailbox-Vault-Original-To': recipient,
      'X-Mailbox-Vault-Email-Id': emailId,
    });
    await message.forward(env.FORWARD_TO, traceHeaders).catch((error) => {
      console.error(JSON.stringify({ event: 'forward_failed', emailId, error: String(error) }));
    });
  }

  console.log(
    JSON.stringify({
      event: 'email_ingested',
      emailId,
      aliasId: alias.id,
      attachmentCount: attachments.length,
      rawSize: message.rawSize,
    }),
  );
}
