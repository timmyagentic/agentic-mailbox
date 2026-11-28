import type { ImapFlow } from 'imapflow';
import type { MailboxProfile } from '../../shared/mailbox';
import type { RelayEnv } from './profile';
import { RelayFailure, upcoming, withInbox, type MailAuth } from './protocol';
import { active, routeAuth, type Route } from './store';
import { syncMailbox } from './sync';

export const pollIntervalMs = 10_000;
const segmentMs = 5 * 60_000;
// Cron executions have a seconds offset within the minute. Cover a full tick plus connection setup.
const handoffGraceMs = 90_000;
const heartbeatMs = 45_000;
export function segmentWindow(scheduledTime: number) {
  const epoch = Math.floor(scheduledTime / segmentMs) * segmentMs;
  return { epoch, until: epoch + segmentMs + handoffGraceMs };
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

// A notification can arrive during catch-up, during SMTP, or just before IDLE acknowledges.
// Keep a revision, so subscribing after an await can never discard that notification.
function mailboxNotices(client: ImapFlow, signal: AbortSignal) {
  let revision = 0;
  let waiting: (() => void) | undefined;
  const notify = () => {
    revision++;
    waiting?.();
  };
  client.on('exists', notify);
  client.on('close', notify);
  signal.addEventListener('abort', notify);
  return {
    get revision() {
      return revision;
    },
    notify,
    wait(previous: number, timeout?: number) {
      return new Promise<void>((resolve) => {
        if (revision !== previous || signal.aborted || !client.usable) return resolve();
        const finish = () => {
          clearTimeout(timer);
          waiting = undefined;
          resolve();
        };
        const timer = timeout === undefined ? undefined : setTimeout(finish, timeout);
        waiting = finish;
      });
    },
    dispose() {
      client.off('exists', notify);
      client.off('close', notify);
      signal.removeEventListener('abort', notify);
      waiting?.();
    },
  };
}

async function waitForIdle(
  client: ImapFlow,
  notices: ReturnType<typeof mailboxNotices>,
  seen: number,
  signal: AbortSignal,
) {
  let ended = false;
  const idle = client
    .idle()
    .catch(() => false)
    .finally(() => {
      ended = true;
      notices.notify();
    });
  await notices.wait(seen);
  // ImapFlow sends DONE before the next command. Wait for its tagged completion before re-entering IDLE.
  if (!ended && client.usable && !signal.aborted) await client.noop();
  const accepted = await idle;
  if (!signal.aborted && !client.usable) throw new RelayFailure('imap');
  return accepted !== false;
}

type SegmentBudget = { submits: number; batches: number };
type ListeningMode = 'idle' | 'poll';
type LiveConnection = { client: ImapFlow; validity: string; auth: MailAuth };
async function watchInbox(
  env: RelayEnv,
  current: Route,
  connection: LiveConnection,
  signal: AbortSignal,
  budget: SegmentBudget,
  setMode: (mode: ListeningMode) => Promise<unknown>,
) {
  const { client, validity, auth } = connection;
  let cursor = current.last_uid;
  const notices = mailboxNotices(client, signal);
  let idle =
    client.capabilities.has('IDLE') ||
    client.enabled.has('IMAP4REV2') ||
    (client.capabilities.has('IMAP4rev2') && !client.capabilities.has('IMAP4rev1'));
  try {
    await setMode(idle ? 'idle' : 'poll');
    while (!signal.aborted && budget.submits > 0 && budget.batches > 0) {
      if (!client.usable) throw new RelayFailure('imap');
      const seen = notices.revision;
      const available = validity === current.uid_validity ? await upcoming(client, cursor, !idle) : [];
      const candidates = available.slice(0, budget.submits);
      if (candidates.length || validity !== current.uid_validity) {
        budget.batches--;
        const result = await syncMailbox(env, {
          client,
          validity,
          expectedValidity: current.uid_validity,
          generation: current.generation,
          auth,
          candidates,
          signal,
          budget,
        });
        if (result.state === 'busy') {
          await delay(1000, signal);
          continue;
        }
        if (result.state === 'reconnect') throw new RelayFailure('imap');
        if (result.state !== 'ok') return;

        cursor = Math.max(cursor, result.cursor);
        if (!budget.submits || !budget.batches) return;
        if (available.length >= 10 || available.length > candidates.length || notices.revision !== seen)
          continue;
      }
      if (signal.aborted) break;
      if (notices.revision !== seen) continue;
      if (idle) {
        const accepted = await waitForIdle(client, notices, seen, signal);
        if (!accepted && !signal.aborted) {
          idle = false;
          await setMode('poll');
        }
      } else {
        await notices.wait(seen, pollIntervalMs);
      }
    }
  } finally {
    notices.dispose();
  }
}

export async function runMailboxSegment(
  env: RelayEnv,
  scheduledTime: number,
  window = segmentWindow(scheduledTime),
) {
  if (window.until <= Date.now()) return;
  const token = crypto.randomUUID();
  const leaseEnd = () => Math.min(window.until, Date.now() + 2 * heartbeatMs);
  const row = await env.DB.prepare(
    `UPDATE mailbox_relay SET listener_token=?,listener_epoch=?,listener_until=?,listener_mode='connecting'
    WHERE slot='active' AND (in_flight IS NULL OR lock_until>?) AND COALESCE(problem,'')!='reset'
    AND (listener_epoch<? OR (listener_epoch=? AND listener_until<=?)) RETURNING *`,
  )
    .bind(token, window.epoch, leaseEnd(), Date.now(), window.epoch, window.epoch, Date.now())
    .first<Route>();
  if (!row) return;

  const controller = new AbortController();
  const signal = controller.signal;
  const expires = setTimeout(() => controller.abort(), Math.max(0, window.until - Date.now()));
  // A killed isolate cannot run finally. A later minute can replace its expired liveness lease.
  // Renewing it is independent of IMAP and never interrupts an idle socket.
  async function heartbeat() {
    while (!signal.aborted) {
      await delay(heartbeatMs, signal);
      if (signal.aborted) return;
      const updated = await env.DB.prepare(
        "UPDATE mailbox_relay SET listener_until=? WHERE slot='active' AND listener_token=?",
      )
        .bind(leaseEnd(), token)
        .run();
      if (!updated.meta.changes) return;
    }
  }
  const heartbeats = heartbeat().catch(() => controller.abort());
  const setMode = (mode: 'idle' | 'poll') =>
    env.DB.prepare(
      `UPDATE mailbox_relay SET listener_mode=?,checked_at=?,
    problem=CASE WHEN problem IN ('imap','oauth') AND in_flight IS NULL THEN NULL ELSE problem END
    WHERE slot='active' AND listener_token=?`,
    )
      .bind(mode, Date.now(), token)
      .run();

  // A Free-plan invocation has a finite subrequest budget. A saturated segment releases its claim
  // so the next minute's supervisor can continue. The durable UID, never an event count, is the cursor.
  const budget: SegmentBudget = { submits: 32, batches: 48 };
  try {
    const profile: MailboxProfile = JSON.parse(row.profile);
    for (let attempt = 0; attempt < 4 && !signal.aborted; attempt++) {
      try {
        const current = attempt ? await active(env) : row;
        if (!current || current.generation !== row.generation || current.uid_validity !== row.uid_validity)
          return;
        const auth = await routeAuth(env, current, profile);
        await withInbox(
          profile,
          auth,
          (client, validity) =>
            watchInbox(env, current, { client, validity, auth }, signal, budget, setMode),
          signal,
        );
        return;
      } catch (error) {
        if (signal.aborted) return;
        const issue = error instanceof RelayFailure && error.issue === 'oauth' ? 'oauth' : 'imap';
        await env.DB.prepare(
          `UPDATE mailbox_relay SET listener_mode='connecting',
          problem=CASE WHEN in_flight IS NULL AND (problem IS NULL OR problem IN ('imap','oauth')) THEN ? ELSE problem END
          WHERE slot='active' AND listener_token=?`,
        )
          .bind(issue, token)
          .run();
        if (attempt < 3) await delay(1000 * 2 ** attempt, signal);
      }
    }
  } finally {
    clearTimeout(expires);
    controller.abort();
    await heartbeats;
    // A predecessor can finish after the successor has started.
    await env.DB.prepare(
      "UPDATE mailbox_relay SET listener_until=0,listener_token=NULL,listener_mode=NULL WHERE slot='active' AND listener_token=?",
    )
      .bind(token)
      .run();
  }
}
