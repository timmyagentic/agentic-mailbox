import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

const parent = join(homedir(), platform() === 'darwin' ? 'Library/Application Support' : '.local/share');
const legacyData = join(parent, 'Mailbox Vault');

// Reuse the same store as the old launcher, including its encryption key.
export const localData = resolve(process.env.AGENTIC_MAILBOX_DATA_DIR || process.env.VAULT_DATA_DIR
  || (existsSync(legacyData) ? legacyData : join(parent, 'Agentic Mailbox')));
export const localPort = Number(process.env.AGENTIC_MAILBOX_LOCAL_PORT || process.env.VAULT_LOCAL_PORT || 8787);
