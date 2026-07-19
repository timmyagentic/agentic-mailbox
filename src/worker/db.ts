import type {
  AttachmentItem,
  DashboardStats,
  EmailDetail,
  EmailSummary,
  MailAlias,
} from '../shared/types';
import { isValidLocalPart, normalizeLocalPart, slugifyPurpose } from '../shared/validation';
import { HttpError } from './http';
import type { AliasRow, AttachmentRow, EmailRow, Env } from './types';

type CreateAliasInput = {
  localPart?: string;
  label?: string;
  note?: string;
  generate?: boolean;
};

type UpdateAliasInput = {
  label?: string;
  note?: string;
  status?: 'active' | 'disabled';
};

type ListEmailOptions = {
  aliasId?: string;
  query?: string;
  unreadOnly?: boolean;
  limit: number;
};

type ListFileOptions = {
  aliasId?: string;
  query?: string;
  limit: number;
};

const ALIAS_SELECT = `
  SELECT id, local_part, domain, address, label, status, routing_mode, note,
         created_at, updated_at, last_received_at, message_count
  FROM aliases`;

const EMAIL_SELECT = `
  SELECT e.id, e.alias_id, a.address AS alias_address, a.label AS alias_label,
         e.message_id, e.from_address, e.from_name, e.to_address, e.subject,
         e.preview, e.body_text, e.received_at, e.sent_at, e.raw_size, e.read_at,
         e.attachment_count
  FROM emails e
  JOIN aliases a ON a.id = e.alias_id`;

const ATTACHMENT_SELECT = `
  SELECT f.id, f.email_id, f.alias_id, a.address AS alias_address,
         e.subject AS email_subject, f.filename, f.content_type, f.size,
         f.content_id, f.disposition, f.r2_key, f.created_at
  FROM attachments f
  JOIN aliases a ON a.id = f.alias_id
  JOIN emails e ON e.id = f.email_id`;

export function mapAlias(row: AliasRow): MailAlias {
  return {
    id: row.id,
    localPart: row.local_part,
    domain: row.domain,
    address: row.address,
    label: row.label,
    status: row.status,
    routingMode: row.routing_mode,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastReceivedAt: row.last_received_at,
    messageCount: Number(row.message_count),
  };
}

export function mapEmail(row: EmailRow): EmailSummary {
  return {
    id: row.id,
    aliasId: row.alias_id,
    aliasAddress: row.alias_address,
    aliasLabel: row.alias_label,
    fromAddress: row.from_address,
    fromName: row.from_name,
    toAddress: row.to_address,
    subject: row.subject,
    preview: row.preview,
    receivedAt: row.received_at,
    readAt: row.read_at,
    rawSize: Number(row.raw_size),
    attachmentCount: Number(row.attachment_count),
  };
}

export function mapAttachment(row: AttachmentRow): AttachmentItem {
  return {
    id: row.id,
    emailId: row.email_id,
    aliasId: row.alias_id,
    aliasAddress: row.alias_address,
    emailSubject: row.email_subject,
    filename: row.filename,
    contentType: row.content_type,
    size: Number(row.size),
    createdAt: row.created_at,
  };
}

function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cleanText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function isUniqueConstraint(error: unknown): boolean {
  return String(error).toLowerCase().includes('unique constraint');
}

export async function createAlias(env: Env, input: CreateAliasInput): Promise<MailAlias> {
  const label = cleanText(input.label, 80);
  const note = cleanText(input.note, 300);
  const requested = normalizeLocalPart(cleanText(input.localPart, 64));
  const shouldGenerate = input.generate === true || !requested;

  if (!shouldGenerate && !isValidLocalPart(requested)) {
    throw new HttpError(400, 'invalid_local_part', '邮箱前缀格式不正确。');
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const localPart = shouldGenerate ? `${slugifyPurpose(label)}-${randomSuffix()}` : requested;
    if (!isValidLocalPart(localPart)) {
      throw new HttpError(400, 'invalid_local_part', '邮箱前缀格式不正确。');
    }

    const now = new Date().toISOString();
    const row: AliasRow = {
      id: crypto.randomUUID(),
      local_part: localPart,
      domain: env.PRIMARY_DOMAIN.toLowerCase(),
      address: `${localPart}@${env.PRIMARY_DOMAIN.toLowerCase()}`,
      label,
      status: 'active',
      routing_mode: 'managed',
      note,
      created_at: now,
      updated_at: now,
      last_received_at: null,
      message_count: 0,
    };

    try {
      await env.DB.prepare(
        `INSERT INTO aliases (
          id, local_part, domain, address, label, status, routing_mode, note,
          created_at, updated_at, last_received_at, message_count
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, 0)`,
      )
        .bind(
          row.id,
          row.local_part,
          row.domain,
          row.address,
          row.label,
          row.status,
          row.routing_mode,
          row.note,
          row.created_at,
          row.updated_at,
        )
        .run();
      return mapAlias(row);
    } catch (error) {
      if (!shouldGenerate || !isUniqueConstraint(error) || attempt === 3) {
        if (isUniqueConstraint(error)) {
          throw new HttpError(409, 'alias_exists', '这个邮箱地址已经存在。');
        }
        throw error;
      }
    }
  }

  throw new HttpError(409, 'alias_generation_failed', '暂时无法生成唯一地址，请重试。');
}

export async function updateAlias(env: Env, id: string, input: UpdateAliasInput): Promise<MailAlias> {
  const existing = await env.DB.prepare(`${ALIAS_SELECT} WHERE id = ?1`).bind(id).first<AliasRow>();
  if (!existing) {
    throw new HttpError(404, 'alias_not_found', '邮箱不存在。');
  }

  const label = input.label === undefined ? existing.label : cleanText(input.label, 80);
  const note = input.note === undefined ? existing.note : cleanText(input.note, 300);
  const status = input.status ?? existing.status;
  if (status !== 'active' && status !== 'disabled') {
    throw new HttpError(400, 'invalid_status', '邮箱状态不正确。');
  }

  const updatedAt = new Date().toISOString();
  await env.DB.prepare(
    'UPDATE aliases SET label = ?1, note = ?2, status = ?3, updated_at = ?4 WHERE id = ?5',
  )
    .bind(label, note, status, updatedAt, id)
    .run();

  return mapAlias({ ...existing, label, note, status, updated_at: updatedAt });
}

export async function listAliases(env: Env, query = '', limit = 100): Promise<MailAlias[]> {
  const normalizedQuery = query.trim().slice(0, 100);
  const rows = await env.DB.prepare(
    `${ALIAS_SELECT}
     WHERE (?1 = '' OR address LIKE ?2 OR label LIKE ?2 OR note LIKE ?2)
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
              COALESCE(last_received_at, created_at) DESC
     LIMIT ?3`,
  )
    .bind(normalizedQuery, `%${normalizedQuery}%`, limit)
    .all<AliasRow>();
  return rows.results.map(mapAlias);
}

export async function listEmails(env: Env, options: ListEmailOptions): Promise<EmailSummary[]> {
  const query = options.query?.trim().slice(0, 120) ?? '';
  const aliasId = options.aliasId?.trim() ?? '';
  const rows = await env.DB.prepare(
    `${EMAIL_SELECT}
     WHERE (?1 = '' OR e.alias_id = ?1)
       AND (?2 = '' OR e.subject LIKE ?3 OR e.from_address LIKE ?3 OR e.from_name LIKE ?3
            OR e.to_address LIKE ?3 OR e.preview LIKE ?3)
       AND (?4 = 0 OR e.read_at IS NULL)
     ORDER BY e.received_at DESC, e.id DESC
     LIMIT ?5`,
  )
    .bind(aliasId, query, `%${query}%`, options.unreadOnly ? 1 : 0, options.limit)
    .all<EmailRow>();
  return rows.results.map(mapEmail);
}

export async function getEmail(env: Env, id: string): Promise<EmailDetail> {
  const [email, attachments] = await Promise.all([
    env.DB.prepare(`${EMAIL_SELECT} WHERE e.id = ?1`).bind(id).first<EmailRow>(),
    env.DB.prepare(`${ATTACHMENT_SELECT} WHERE f.email_id = ?1 ORDER BY f.created_at, f.id`)
      .bind(id)
      .all<AttachmentRow>(),
  ]);

  if (!email) {
    throw new HttpError(404, 'email_not_found', '邮件不存在。');
  }

  return {
    ...mapEmail(email),
    messageId: email.message_id,
    bodyText: email.body_text,
    sentAt: email.sent_at,
    attachments: attachments.results.map(mapAttachment),
  };
}

export async function setEmailRead(env: Env, id: string, read: boolean): Promise<void> {
  const result = await env.DB.prepare('UPDATE emails SET read_at = ?1 WHERE id = ?2')
    .bind(read ? new Date().toISOString() : null, id)
    .run();
  if (!result.meta.changes) {
    throw new HttpError(404, 'email_not_found', '邮件不存在。');
  }
}

export async function listFiles(env: Env, options: ListFileOptions): Promise<AttachmentItem[]> {
  const query = options.query?.trim().slice(0, 120) ?? '';
  const aliasId = options.aliasId?.trim() ?? '';
  const rows = await env.DB.prepare(
    `${ATTACHMENT_SELECT}
     WHERE (?1 = '' OR f.alias_id = ?1)
       AND (?2 = '' OR f.filename LIKE ?3 OR f.content_type LIKE ?3
            OR a.address LIKE ?3 OR e.subject LIKE ?3)
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT ?4`,
  )
    .bind(aliasId, query, `%${query}%`, options.limit)
    .all<AttachmentRow>();
  return rows.results.map(mapAttachment);
}

export async function getAttachmentRow(env: Env, id: string): Promise<AttachmentRow> {
  const row = await env.DB.prepare(`${ATTACHMENT_SELECT} WHERE f.id = ?1`)
    .bind(id)
    .first<AttachmentRow>();
  if (!row) {
    throw new HttpError(404, 'attachment_not_found', '附件不存在。');
  }
  return row;
}

async function count(db: D1Database, sql: string): Promise<number> {
  const row = await db.prepare(sql).first<{ value: number }>();
  return Number(row?.value ?? 0);
}

export async function getStats(env: Env): Promise<DashboardStats> {
  const [aliasCount, activeAliasCount, emailCount, unreadCount, attachmentCount, attachmentBytes] =
    await Promise.all([
      count(env.DB, 'SELECT COUNT(*) AS value FROM aliases'),
      count(env.DB, "SELECT COUNT(*) AS value FROM aliases WHERE status = 'active'"),
      count(env.DB, 'SELECT COUNT(*) AS value FROM emails'),
      count(env.DB, 'SELECT COUNT(*) AS value FROM emails WHERE read_at IS NULL'),
      count(env.DB, 'SELECT COUNT(*) AS value FROM attachments'),
      count(env.DB, 'SELECT COALESCE(SUM(size), 0) AS value FROM attachments'),
    ]);

  return { aliasCount, activeAliasCount, emailCount, unreadCount, attachmentCount, attachmentBytes };
}

export async function getAliasForInbound(env: Env, address: string): Promise<AliasRow | null> {
  return env.DB.prepare(
    `${ALIAS_SELECT}
     WHERE address = ?1 COLLATE NOCASE
       AND status = 'active'
       AND routing_mode = 'managed'`,
  )
    .bind(address)
    .first<AliasRow>();
}
