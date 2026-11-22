import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { connectLocalCodex } from '../scripts/codex-connection.mjs';

it('pairs only the specified loopback inbox into a private matching profile', () => {
  const config = mkdtempSync(join(tmpdir(), 'mailbox-codex-config-'));
  try {
    expect(() => connectLocalCodex('https://example.com', 'fixture', config)).toThrow();
    const origin = 'http://127.0.0.1:18927';
    expect(connectLocalCodex(origin, 'fixture', config)).toBe('local-18927');
    const path = join(config, 'agentic-mailbox/profiles/local-18927.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ origin, cookie: 'fixture' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(connectLocalCodex('http://127.0.0.1:8787', 'fixture-local', config)).toBe('local');
  } finally { rmSync(config, { recursive: true, force: true }); }
});
