import { Buffer } from 'node:buffer';
import type { MailboxProfile, MailboxStatus, RelayIssue } from '../../shared/mailbox';
import { HttpError } from '../http';
import { openCredential, sealCredential } from './credentials';
import { googleEnabled, parseSetup, sourceKey, type RelayEnv } from './profile';
import { latestUid, mailboxAuth, RelayFailure, sendSmtp, withInbox, type Passwords } from './protocol';

export type Route = {
  generation: string;
  source_key: string;
  profile: string;
  credential: string;
  uid_validity: string;
  last_uid: number;
  expires_at: number;
  confirmation: string;
  lock_until: number;
  in_flight: number | null;
  problem: RelayIssue | null;
  checked_at: number | null;
  sent_at: number | null;
};
export const active = (env: RelayEnv) =>
  env.DB.prepare("SELECT * FROM mailbox_relay WHERE slot='active'").first<Route>();

export async function status(env: RelayEnv): Promise<MailboxStatus> {
  const [row, pending] = await Promise.all([
    active(env),
    env.DB.prepare(
      "SELECT generation, json_extract(profile,'$.destination') AS destination FROM mailbox_relay WHERE slot='pending' AND expires_at > ?",
    )
      .bind(Date.now())
      .first<{ generation: string; destination: string }>(),
  ]);
  const busy = (row?.lock_until ?? 0) > Date.now();
  return {
    googleEnabled: googleEnabled(env),
    active: row
      ? {
          profile: JSON.parse(row.profile),
          generation: row.generation,
          uidValidity: row.uid_validity,
          inFlight: row.in_flight,
          checkedAt: row.checked_at,
          sentAt: row.sent_at,
          busy,
          issue: row.problem ?? (row.in_flight && !busy ? 'uncertain' : null),
        }
      : null,
    pending: pending && { id: pending.generation, destination: pending.destination },
  };
}

export async function routeAuth(env: RelayEnv, row: Route, p: MailboxProfile) {
  const secret = await openCredential(env, { address: row.generation, credential: row.credential });
  return mailboxAuth(env, p, JSON.parse(secret) as Passwords);
}

async function codeHash(id: string, value: string) {
  return Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id + '/' + value)),
  ).toString('hex');
}

export async function startSetup(env: RelayEnv, data: unknown) {
  const { profile, passwords } = parseSetup(data, env);
  const generation = crypto.randomUUID();
  const credential = await sealCredential(env, generation, JSON.stringify(passwords));
  const auth = await mailboxAuth(env, profile, passwords);
  let baseline: { validity: string; uid: number };
  try {
    baseline = await withInbox(profile, auth, async (client, validity) => ({
      validity,
      uid: await latestUid(client),
    }));
  } catch {
    throw new HttpError(422, 'imap_failed', '无法打开收件箱，请检查 IMAP 服务、服务器和授权信息。');
  }
  const code = crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO mailbox_relay
    (slot,generation,source_key,profile,credential,uid_validity,last_uid,confirmation,expires_at)
    VALUES ('pending',?,?,?,?,?,?,?,?)`,
  )
    .bind(
      generation,
      sourceKey(profile),
      JSON.stringify(profile),
      credential,
      baseline.validity,
      baseline.uid,
      await codeHash(generation, code),
      Date.now() + 15 * 60_000,
    )
    .run();
  try {
    await sendSmtp(profile, auth, {
      subject: '确认 OpenPostway 中转收件地址',
      text: '请在发起设置的页面输入确认码 ' + code + '。此码 15 分钟内有效。',
    });
  } catch (error) {
    if (error instanceof RelayFailure && error.issue === 'uncertain') {
      // The server may have accepted DATA; a code that arrives must still be usable.
      throw new HttpError(
        502,
        'confirmation_uncertain',
        'SMTP 未确认发送结果。请刷新并检查目标邮箱，收到确认码即可继续。',
      );
    }
    await env.DB.prepare("DELETE FROM mailbox_relay WHERE slot='pending' AND generation=?")
      .bind(generation)
      .run();
    throw new HttpError(422, 'smtp_failed', 'SMTP 未接受确认邮件，请检查发信服务器、凭证和目标地址。');
  }
}

export async function confirmSetup(env: RelayEnv, id: unknown, code: unknown) {
  if (typeof id !== 'string' || typeof code !== 'string' || !/^[0-9a-f]{12}$/i.test(code.trim())) {
    throw new HttpError(400, 'invalid_code', '请输入目标邮箱收到的 12 位确认码。');
  }
  // Same mailbox: retain the current cursor even if mail arrived while the replacement was pending.
  // Changing servers/accounts starts at the watermark observed when that mailbox was connected.
  const now = Date.now();
  const [change] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO mailbox_relay
    (slot,generation,source_key,profile,credential,uid_validity,last_uid)
    SELECT 'active',generation,source_key,profile,credential,uid_validity,last_uid FROM mailbox_relay
    WHERE slot='pending' AND generation=? AND confirmation=? AND expires_at>?
    ON CONFLICT(slot) DO UPDATE SET generation=excluded.generation, profile=excluded.profile, credential=excluded.credential,
      uid_validity=CASE WHEN source_key=excluded.source_key THEN uid_validity ELSE excluded.uid_validity END,
      last_uid=CASE WHEN source_key=excluded.source_key THEN last_uid ELSE excluded.last_uid END,
      source_key=excluded.source_key, lock_id=NULL, lock_until=0, checked_at=NULL, sent_at=NULL, problem=NULL
    WHERE lock_until <= ? AND in_flight IS NULL`,
    ).bind(id, await codeHash(id, code.trim().toUpperCase()), now, now),
    env.DB.prepare(
      `DELETE FROM mailbox_relay WHERE slot='pending' AND generation=?
      AND EXISTS (SELECT 1 FROM mailbox_relay WHERE slot='active' AND generation=?)`,
    ).bind(id, id),
  ]);
  if (!change.meta.changes)
    throw new HttpError(
      409,
      'confirmation_failed',
      '确认码无效或已过期，或当前中转正在处理邮件。请检查状态后重试。',
    );
}
