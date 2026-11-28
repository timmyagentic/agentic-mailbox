import { internetMailbox } from '../shared/validation';
import type { ForwardingSettings } from '../shared/types';
import { ensureRoutingAddress } from './destinations';
import { HttpError } from './http';
import type { Env } from './types';

const codeLifetime = 15 * 60_000;
const resendDelay = 60_000;

type SettingsRow = {
  relay: string; sender_name: string | null; destination: string | null; pending: string | null;
  pending_id: string | null; code_hash: string | null; code_sent_at: number | null;
};

export function destinationAddress(env: Env, value: unknown): string | null {
  const address = internetMailbox(value)?.toLowerCase();
  if (!address || address.length > 90 || address.endsWith('@' + env.PRIMARY_DOMAIN.trim().toLowerCase()) || address.endsWith('.invalid')) return null;
  return address;
}

export function legacyDestination(env: Env) {
  return destinationAddress(env, env.FORWARD_TO);
}

async function settingsRow(env: Env, owner: string): Promise<SettingsRow> {
  const select = env.DB.prepare('SELECT * FROM forwarding_settings WHERE owner = ?').bind(owner);
  const stored = await select.first<SettingsRow>();
  if (stored) return stored;
  const relay = `relay-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}@${env.PRIMARY_DOMAIN.toLowerCase()}`;
  await env.DB.prepare(`INSERT INTO forwarding_settings (owner, relay, destination)
    SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM aliases WHERE address = ?)
    ON CONFLICT(owner) DO NOTHING`).bind(owner, relay, owner === 'admin' ? legacyDestination(env) : null, relay).run();
  const row = await select.first<SettingsRow>();
  if (!row) throw new HttpError(503, 'relay_unavailable', '暂时无法分配中转地址，请重试。');
  return row;
}

function publicSettings(row: SettingsRow): ForwardingSettings {
  const validCode = row.code_hash && (row.code_sent_at ?? 0) + codeLifetime > Date.now();
  return { relay: row.relay, senderName: row.sender_name, destination: row.destination, pending: row.pending,
    step: row.pending ? (validCode ? 'code' : 'provider') : null };
}

export async function getSettings(env: Env, owner: string) {
  return publicSettings(await settingsRow(env, owner));
}

export async function setRelaySenderName(env: Env, owner: string, value: unknown) {
  if (value !== null && (typeof value !== 'string' || !value.trim() || value.trim().length > 80
    || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value))) {
    throw new HttpError(400, 'invalid_sender_name', '请输入 1 至 80 个字符的单行发件人名称。');
  }
  await settingsRow(env, owner);
  await env.DB.prepare('UPDATE forwarding_settings SET sender_name = ? WHERE owner = ?')
    .bind(typeof value === 'string' ? value.trim() : null, owner).run();
  return getSettings(env, owner);
}

async function codeHash(code: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}

export async function requestDestination(env: Env, owner: string, value: unknown) {
  const target = destinationAddress(env, value);
  if (!target) throw new HttpError(400, 'invalid_destination', '请输入有效的外部收件地址。目标不能是本站的中转域名。');
  const row = await settingsRow(env, owner);
  if (row.destination === target) throw new HttpError(409, 'already_active', '这个地址已在接收转发邮件。');
  if (row.pending !== target) {
    await env.DB.prepare(`UPDATE forwarding_settings SET pending = ?, pending_id = ?, code_hash = NULL,
      code_sent_at = NULL WHERE owner = ?`).bind(target, crypto.randomUUID(), owner).run();
  }
  return verifyDestination(env, owner, target);
}

export async function verifyDestination(env: Env, owner: string, target: unknown) {
  const row = await settingsRow(env, owner);
  if (!row.pending || row.pending !== target || !row.pending_id) {
    throw new HttpError(409, 'destination_changed', '待确认的邮箱已变化，请刷新设置。');
  }
  const now = Date.now();
  if (row.code_hash && (row.code_sent_at ?? 0) + resendDelay > now) return publicSettings(row);
  if (await ensureRoutingAddress(env, row.pending)) {
    const code = crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
    const hash = await codeHash(code);
    const claim = await env.DB.prepare(`UPDATE forwarding_settings SET code_hash = ?, code_sent_at = ?
      WHERE owner = ? AND pending_id = ? AND (code_sent_at IS NULL OR code_sent_at <= ?)`)
      .bind(hash, now, owner, row.pending_id, now - resendDelay).run();
    if (claim.meta.changes) {
      try {
        await env.EMAIL.send({ from: `forwarding@${env.PRIMARY_DOMAIN}`, to: row.pending,
          subject: '确认 Agentic Mailbox 转发目标', text: `确认码为 ${code}，15 分钟内有效。请在发起设置的页面输入。如果你没有请求转发，可以忽略这封信。` });
      } catch {
        await env.DB.prepare('UPDATE forwarding_settings SET code_hash = NULL, code_sent_at = NULL WHERE owner = ? AND code_hash = ?')
          .bind(owner, hash).run();
        throw new HttpError(503, 'confirmation_send_failed', '确认邮件未能发出，请稍后重试，或联系站点管理员检查邮件发送绑定。');
      }
    }
  }
  return getSettings(env, owner);
}

export async function confirmDestination(env: Env, owner: string, value: unknown) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (/^[0-9A-F]{12}$/.test(code)) {
    const update = await env.DB.prepare(`UPDATE forwarding_settings SET destination = pending, pending = NULL,
      pending_id = NULL, code_hash = NULL, code_sent_at = NULL
      WHERE owner = ? AND pending IS NOT NULL AND code_hash = ? AND code_sent_at > ?`)
      .bind(owner, await codeHash(code), Date.now() - codeLifetime).run();
    if (update.meta.changes) return getSettings(env, owner);
  }
  throw new HttpError(400, 'invalid_confirmation', '确认码不正确或已过期，请检查邮件或重新获取。');
}

export async function cancelPending(env: Env, owner: string) {
  await env.DB.prepare('UPDATE forwarding_settings SET pending = NULL, pending_id = NULL, code_hash = NULL, code_sent_at = NULL WHERE owner = ?')
    .bind(owner).run();
  return getSettings(env, owner);
}
