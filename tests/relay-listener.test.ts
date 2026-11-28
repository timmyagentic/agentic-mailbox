import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollIntervalMs, runMailboxSegment, segmentWindow } from '../src/worker/relay/listener';
import type { RelayEnv } from '../src/worker/relay/profile';

afterEach(() => vi.useRealTimers());
describe('Cloudflare listener windows', () => {
  it('keeps the old listener eligible for handover even with a late minute tick', () => {
    const boundary = Date.UTC(2026, 10, 28, 6, 35, 0);
    const predecessor = segmentWindow(boundary - 5_000); // :34:55 tick
    const successor = segmentWindow(boundary + 55_000); // :35:55 tick
    expect(predecessor.epoch).toBe(boundary - 300_000);
    expect(successor.epoch).toBe(boundary);
    expect(predecessor.until - (boundary + 55_000)).toBe(35_000);
    expect(segmentWindow(boundary + 115_000)).toEqual(successor);
    expect(successor.until - successor.epoch).toBeLessThan(15 * 60_000);
    expect(pollIntervalMs).toBe(10_000);
  });
  it('ignores delivery of an already expired Cron event before opening storage or mail', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-28T06:42:00Z'));
    const prepare = vi.fn();
    await runMailboxSegment({ DB: { prepare } } as unknown as RelayEnv, Date.parse('2026-11-28T06:35:00Z'));
    expect(prepare).not.toHaveBeenCalled();
  });
});
