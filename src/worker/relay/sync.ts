import type { MailboxProfile, RelayIssue } from '../../shared/mailbox';
import { HttpError } from '../http';
import { latestUid, readNewMail, RelayFailure, sendSmtp, upcoming, withInbox } from './protocol';
import type { RelayEnv } from './profile';
import { active, routeAuth, type Route } from './store';

const leaseMs = 3 * 60_000;

export async function syncMailbox(env: RelayEnv) {
  const run = crypto.randomUUID();
  const now = Date.now();
  const row = await env.DB.prepare(
    `UPDATE mailbox_relay SET lock_id=?,lock_until=?,checked_at=?
    WHERE slot='active' AND lock_until<=? AND in_flight IS NULL AND COALESCE(problem,'')!='reset'
    RETURNING *`,
  )
    .bind(run, now + leaseMs, now, now)
    .first<Route>();
  if (!row) return;
  const update = (sql: string, ...args: (string | number | null)[]) =>
    env.DB.prepare('UPDATE mailbox_relay SET ' + sql + " WHERE slot='active' AND lock_id=?")
      .bind(...args, run)
      .run();
  let uid: number | null = null;
  try {
    const profile: MailboxProfile = JSON.parse(row.profile);
    const auth = await routeAuth(env, row, profile);
    await withInbox(profile, auth, async (client, validity) => {
      if (validity !== row.uid_validity) throw new RelayFailure('reset');
      for (const next of await upcoming(client, row.last_uid)) {
        uid = next;
        const content = await readNewMail(client, uid, profile);
        if (!content) {
          if (!(await update('last_uid=?,problem=NULL', uid)).meta.changes) return;
          continue;
        }
        // Persist before talking to SMTP. A lost final acknowledgment must not cause an automatic duplicate.
        if (
          !(await update('in_flight=?,problem=NULL,lock_until=?', uid, Date.now() + leaseMs)).meta.changes
        )
          return;
        const domain = profile.address.split('@')[1];
        const messageId = `<postway.${row.generation}.${validity}.${uid}@${domain}>`;
        await sendSmtp(profile, auth, content, messageId);
        if (!(await update('last_uid=?,in_flight=NULL,sent_at=?', uid, Date.now())).meta.changes) return;
        uid = null;
      }
    });
    await update('problem=NULL');
  } catch (error) {
    const issue: RelayIssue = error instanceof RelayFailure ? error.issue : 'imap';
    if (issue === 'oversize' || issue === 'message' || issue === 'uncertain' || issue === 'rejected') {
      await update('problem=?,in_flight=?', issue, uid);
    } else if (issue === 'smtp') {
      await update('problem=?,in_flight=NULL', issue);
    } else {
      // A database error after SMTP accepted DATA can also leave an unresolved attempt.
      await update("problem=CASE WHEN in_flight IS NULL THEN ? ELSE 'uncertain' END", issue);
    }
  } finally {
    await update('lock_id=NULL,lock_until=0');
  }
}

export async function resolveMail(
  env: RelayEnv,
  data: { generation?: unknown; uid?: unknown; validity?: unknown; action?: unknown },
) {
  const row = await active(env);
  if (
    !row ||
    row.generation !== data.generation ||
    row.uid_validity !== data.validity ||
    row.lock_until > Date.now()
  )
    throw changed();
  let result: D1Result;
  if (data.action === 'baseline' && row.problem === 'reset') {
    const profile: MailboxProfile = JSON.parse(row.profile);
    const auth = await routeAuth(env, row, profile);
    const mark = await withInbox(profile, auth, async (client, validity) => ({
      validity,
      uid: await latestUid(client),
    }));
    result = await env.DB.prepare(
      `UPDATE mailbox_relay SET last_uid=?,uid_validity=?,problem=NULL,lock_id=NULL,lock_until=0
      WHERE slot='active' AND generation=? AND uid_validity=? AND problem='reset' AND lock_until<=?`,
    )
      .bind(mark.uid, mark.validity, row.generation, row.uid_validity, Date.now())
      .run();
  } else {
    if (!row.in_flight || row.in_flight !== data.uid || (data.action !== 'retry' && data.action !== 'skip'))
      throw changed();
    result = await env.DB.prepare(
      `UPDATE mailbox_relay SET last_uid=CASE WHEN ?='skip' THEN in_flight ELSE last_uid END,
      in_flight=NULL,problem=NULL,lock_id=NULL,lock_until=0 WHERE slot='active' AND generation=? AND uid_validity=? AND in_flight=? AND lock_until<=?`,
    )
      .bind(data.action, row.generation, row.uid_validity, row.in_flight, Date.now())
      .run();
  }
  if (!result.meta.changes) throw changed();
}
function changed() {
  return new HttpError(409, 'relay_changed', '中转状态已变化。请刷新后重试。');
}
