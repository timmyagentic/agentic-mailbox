import { describe, expect, it } from 'vitest';
import { createSessionToken, passwordsMatch, verifySessionToken } from '../src/worker/auth';

describe('signed admin sessions', () => {
  const secret = 'test-session-secret-with-enough-entropy';
  const email = 'admin@example.com';
  const now = Date.UTC(2026, 6, 19, 8, 0, 0);

  it('creates and verifies a bound session', async () => {
    const token = await createSessionToken(email, secret, now);
    const session = await verifySessionToken(token, email, secret, now + 5_000);
    expect(session?.email).toBe(email);
  });

  it('uses a distinct session version for device certificates', async () => {
    const certificateFingerprint = 'ab'.repeat(32);
    const deviceToken = await createSessionToken(email, secret, now, certificateFingerprint);
    expect(await verifySessionToken(deviceToken, email, secret, now)).toMatchObject({
      version: 2, certificateFingerprint,
    });
    const passwordToken = await createSessionToken(email, secret, now);
    expect(await verifySessionToken(passwordToken, email, secret, now)).toMatchObject({ version: 1 });
  });

  it('rejects tampering, wrong identities and expired sessions', async () => {
    const token = await createSessionToken(email, secret, now);
    expect(await verifySessionToken(`${token}x`, email, secret, now)).toBeNull();
    expect(await verifySessionToken(token, 'other@example.com', secret, now)).toBeNull();
    expect(await verifySessionToken(token, email, secret, now + 25 * 60 * 60 * 1_000)).toBeNull();
  });

  it('compares passwords without returning early', async () => {
    expect(await passwordsMatch('correct horse', 'correct horse')).toBe(true);
    expect(await passwordsMatch('correct horse', 'wrong horse')).toBe(false);
  });
});
