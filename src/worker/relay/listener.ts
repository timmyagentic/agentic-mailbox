import type { RelayEnv } from './profile';
import { syncMailbox } from './sync';
import { active } from './store';

export const pollIntervalMs = 10_000;

export async function runMailboxSegment(env: RelayEnv, scheduledTime: number) {
  const end = scheduledTime + 60_000;
  if (Date.now() >= end || !(await active(env))) return;
  do {
    await syncMailbox(env);
    if (Date.now() + pollIntervalMs >= end) break;
    await new Promise<void>(resolve => setTimeout(resolve, pollIntervalMs));
  } while (Date.now() < end);
}
