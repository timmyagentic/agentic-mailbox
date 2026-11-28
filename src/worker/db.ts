import type { MailAlias } from '../shared/types';
import { isValidLocalPart, normalizeLocalPart, slugifyPurpose } from '../shared/validation';
import { HttpError } from './http';
import type { AliasRow, Env } from './types';

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

const ALIAS_SELECT = `
  SELECT id, local_part, domain, address, label, status, routing_mode, note,
         created_at, updated_at, last_received_at, message_count
  FROM aliases`;

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
    if (!isValidLocalPart(localPart) || /^relay-[a-f0-9]{24}$/.test(localPart)) {
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
  const existing = await env.DB.prepare(`${ALIAS_SELECT} WHERE id = ?1 AND routing_mode = 'managed'`).bind(id).first<AliasRow>();
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
     WHERE routing_mode = 'managed' AND (?1 = '' OR address LIKE ?2 OR label LIKE ?2 OR note LIKE ?2)
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
              COALESCE(last_received_at, created_at) DESC
     LIMIT ?3`,
  )
    .bind(normalizedQuery, `%${normalizedQuery}%`, limit)
    .all<AliasRow>();
  return rows.results.map(mapAlias);
}
