import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function connectLocalCodex(origin, cookie, configDirectory = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== origin) {
    throw new Error('Codex pairing requires the local mailbox origin.');
  }
  const profile = url.port === '8787' ? 'local' : 'local-' + url.port;
  const directory = join(configDirectory, 'agentic-mailbox', 'profiles');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, '.' + randomUUID());
  writeFileSync(temp, JSON.stringify({ origin, cookie }), { mode: 0o600, flag: 'wx' });
  renameSync(temp, join(directory, profile + '.json'));
  return profile;
}
