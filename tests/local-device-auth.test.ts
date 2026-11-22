import { execFileSync } from 'node:child_process';
import { sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { localDeviceAuth } from '../scripts/local-device-auth.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'mailbox-device-test-'));
const certificate = join(scratch, 'client.pem');
const key = join(scratch, 'key.pem');

beforeAll(() => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=Device fixture', '-addext', 'basicConstraints=CA:FALSE',
    '-addext', 'extendedKeyUsage=clientAuth', '-keyout', key, '-out', certificate], { stdio: 'ignore' });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

it('verifies a proof for the registered client certificate once', () => {
  const device = localDeviceAuth(certificate);
  const challenge = device.challenge();
  expect(challenge?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  const nonce = challenge!.nonce;
  const signature = sign('sha256', Buffer.from('Agentic Mailbox local login v1\n' + nonce),
    readFileSync(key)).toString('base64');
  expect(device.prove(nonce, signature)).toBe(true);
  expect(device.prove(nonce, signature)).toBe(false);
});

it('rejects wrong signatures, stale challenges and missing registrations', () => {
  const device = localDeviceAuth(certificate);
  const { nonce } = device.challenge()!;
  expect(device.prove(nonce, 'd3Jvbmc=')).toBe(false);

  const issued = device.challenge()!;
  const signature = sign('sha256', Buffer.from('Agentic Mailbox local login v1\n' + issued.nonce),
    readFileSync(key)).toString('base64');
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + 60_000);
    expect(device.prove(issued.nonce, signature)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
  expect(localDeviceAuth(join(scratch, 'missing.cer')).challenge()).toBeNull();
});
