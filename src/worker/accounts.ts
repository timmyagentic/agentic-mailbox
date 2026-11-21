import type { ImapProvider, MailAccount, MailProvider, MailRefreshResult, OAuthProvider } from '../shared/types';
import { normalizeAddress } from '../shared/validation';
import { openCredential, sealCredential } from './account-credentials';
import { HttpError } from './http';
import { imapRefreshError, withImapInbox } from './imap';
import { storeConnectedMail } from './mail';
import { isOAuthProvider, MailProviderError, oauthAccessToken } from './oauth';
import { loadOAuthInbox, readOAuthMail } from './oauth-inbox';
import type { Env } from './types';

type AccountRow = {
  id: string;
  provider: MailProvider;
  address: string;
  last_sync_at: string | null;
};
type SyncRow = AccountRow & {
  provider: ImapProvider;
  credential: string;
  uid_validity: string | null;
  last_uid: number;
};

const accountSelect = `SELECT c.id, c.provider, a.address, c.last_sync_at
  FROM imap_accounts c JOIN aliases a ON a.id = c.id`;
const oauthSelect = `SELECT c.id, c.provider, a.address, c.last_sync_at FROM oauth_accounts c JOIN aliases a ON a.id = c.id`;
const syncLeaseMs = 90_000;

function mapAccount(row: AccountRow): MailAccount {
  return { id: row.id, provider: row.provider, address: row.address, lastSyncAt: row.last_sync_at };
}

export async function listMailAccounts(env: Env): Promise<MailAccount[]> {
  const rows = await env.DB.prepare(`${accountSelect} UNION ALL ${oauthSelect} ORDER BY address`).all<AccountRow>();
  return rows.results.map(mapAccount);
}

function providerOf(domain: string): ImapProvider | null {
  if (domain === 'qq.com' || domain === 'foxmail.com') return 'qq';
  if (domain === '163.com') return 'netease163';
  return null;
}

export async function saveMailAccount(env: Env, input: { email?: unknown; authorizationCode?: unknown }): Promise<MailAccount> {
  const address = typeof input?.email === 'string' ? normalizeAddress(input.email) : null;
  const parts = address?.split('@') ?? [];
  const provider = providerOf(parts[1]);
  const submittedCode = typeof input?.authorizationCode === 'string' ? input.authorizationCode.trim() : '';
  const code = provider === 'netease163' ? submittedCode.replace(/\s/g, '') : submittedCode;
  if (!address || !provider) throw new HttpError(400, 'invalid_mail_provider', '请输入 QQ 或 163 邮箱地址。');
  if (!/^[a-zA-Z0-9]{16}$/.test(code)) throw new HttpError(400, 'invalid_mail_auth_code', '请输入有效的 16 位客户端授权码。');

  const credential = await sealCredential(env, address, code);
  const existing = await env.DB.prepare(`${accountSelect} WHERE a.address = ?1`).bind(address).first<AccountRow>();
  if (existing) {
    const updated = await env.DB.prepare(
      'UPDATE imap_accounts SET credential = ?1 WHERE id = ?2 AND sync_until <= ?3',
    ).bind(credential, existing.id, Date.now()).run();
    if (!updated.meta.changes) throw new HttpError(409, 'mail_sync_in_progress', '邮箱正在同步，请稍后更新授权码。');
    return mapAccount(existing);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO aliases (id, local_part, domain, address, routing_mode, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'external', ?5, ?5)`,
      ).bind(id, parts[0], parts[1], address, now),
      env.DB.prepare(
        'INSERT INTO imap_accounts (id, provider, credential) VALUES (?1, ?2, ?3)',
      ).bind(id, provider, credential),
    ]);
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) {
      throw new HttpError(409, 'mail_address_exists', '这个地址已存在，请刷新后重试。');
    }
    throw error;
  }
  return { id, provider, address, lastSyncAt: null };
}

async function refreshImapAccount(env: Env, id: string): Promise<MailRefreshResult> {
  const syncId = crypto.randomUUID();
  const now = Date.now();
  const claim = await env.DB.prepare(
    `UPDATE imap_accounts SET sync_id = ?1, sync_until = ?2
     WHERE id = ?3 AND sync_until <= ?4`,
  ).bind(syncId, now + syncLeaseMs, id, now).run();
  if (!claim.meta.changes) {
    const known = await env.DB.prepare('SELECT id FROM imap_accounts WHERE id = ?1').bind(id).first();
    if (!known) throw new HttpError(404, 'mail_account_missing', '这个邮箱账号不存在。');
    throw new HttpError(409, 'mail_sync_in_progress', '这个邮箱已在同步，稍后刷新即可。');
  }

  let imported = 0;
  let oversized = 0;
  let hasMore = false;
  let lastSyncAt: string | null = null;
  try {
    const account = await env.DB.prepare(
      `SELECT c.id, c.provider, a.address, c.last_sync_at, c.credential, c.uid_validity, c.last_uid
       FROM imap_accounts c JOIN aliases a ON a.id = c.id WHERE c.id = ?1 AND c.sync_id = ?2`,
    ).bind(id, syncId).first<SyncRow>();
    if (!account) throw new Error('Unable to load synchronized account');
    lastSyncAt = account.last_sync_at;

    const authorizationCode = await openCredential(env, account);
    await withImapInbox({ ...account, authorizationCode }, {
      uidValidity: account.uid_validity, lastUid: account.last_uid,
    }, async (inbox) => {
      let lastUid = inbox.uidValidity === account.uid_validity ? account.last_uid : 0;
      const advance = async () => {
        const result = await env.DB.prepare(
          'UPDATE imap_accounts SET uid_validity = ?1, last_uid = ?2 WHERE id = ?3 AND sync_id = ?4',
        ).bind(inbox.uidValidity, lastUid, id, syncId).run();
        if (!result.meta.changes) throw new Error('Mail sync lease expired');
      };

      hasMore = inbox.hasMore;
      for (const uid of inbox.uids) {
        const message = await inbox.read(uid);
        if (message.kind === 'mail') {
          if (await storeConnectedMail(env, {
            ...message, accountId: id, address: account.address, identity: `${inbox.uidValidity}:${uid}`,
          })) imported += 1;
        } else if (message.kind === 'oversized') {
          oversized += 1;
        }
        lastUid = uid;
        await advance();
      }
      if (!inbox.uids.length && inbox.uidValidity !== account.uid_validity) await advance();
    });

    const syncedAt = new Date().toISOString();
    const result = await env.DB.prepare('UPDATE imap_accounts SET last_sync_at = ?1 WHERE id = ?2 AND sync_id = ?3')
      .bind(syncedAt, id, syncId).run();
    if (!result.meta.changes) throw new Error('Mail sync lease expired');
    return { id, imported, oversized, hasMore, lastSyncAt: syncedAt };
  } catch (error) {
    return {
      id, imported, oversized, hasMore, lastSyncAt,
      error: error instanceof HttpError ? error.message : imapRefreshError(error),
    };
  } finally {
    await env.DB.prepare('UPDATE imap_accounts SET sync_id = NULL, sync_until = 0 WHERE id = ?1 AND sync_id = ?2')
      .bind(id, syncId).run();
  }
}

export async function refreshMailAccount(env: Env, id: string): Promise<MailRefreshResult> {
  const oauth = await env.DB.prepare('SELECT id FROM oauth_accounts WHERE id = ?1').bind(id).first();
  return oauth ? refreshOAuthAccount(env, id) : refreshImapAccount(env, id);
}

async function refreshOAuthAccount(env: Env, id: string): Promise<MailRefreshResult> {
  const syncId = crypto.randomUUID();
  const now = Date.now();
  const claim = await env.DB.prepare(
    'UPDATE oauth_accounts SET sync_id = ?1, sync_until = ?2 WHERE id = ?3 AND sync_until <= ?4',
  ).bind(syncId, now + syncLeaseMs, id, now).run();
  if (!claim.meta.changes) throw new HttpError(409, 'mail_sync_in_progress', '这个邮箱已在同步，稍后刷新即可。');

  let imported = 0;
  let oversized = 0;
  let lastSyncAt: string | null = null;
  try {
    const account = await env.DB.prepare(`SELECT a.address, a.status, c.id, c.provider, c.credential, c.cursor, c.last_sync_at
      FROM oauth_accounts c JOIN aliases a ON a.id = c.id WHERE c.id = ?1 AND c.sync_id = ?2`)
      .bind(id, syncId).first<AccountRow & { provider: OAuthProvider; credential: string; cursor: string | null; status: string }>();
    if (!account) throw new Error('Unable to load synchronized account');
    lastSyncAt = account.last_sync_at;
    if (account.status !== 'active') throw new HttpError(409, 'mail_account_disabled', '这个邮箱已停用。');
    const token = await oauthAccessToken(env, account);
    const page = await loadOAuthInbox(account.provider, token, account.cursor, lastSyncAt);
    let processed = 0;
    for (const message of page.messages) {
      if (processed > 0 && Date.now() - now > 35_000) break;
      const identity = `${account.provider}:${message.id}`;
      const known = await env.DB.prepare('SELECT id FROM emails WHERE alias_id = ?1 AND imap_identity = ?2')
        .bind(id, identity).first();
      if (!known) {
        const mail = await readOAuthMail(account.provider, token, message);
        if (mail.kind === 'mail' && await storeConnectedMail(env, { ...mail, accountId: id, address: account.address, identity })) {
          imported += 1;
        }
        if (mail.kind === 'oversized') oversized += 1;
      }
      processed += 1;
    }
    const hasMore = page.hasMore || processed < page.messages.length;
    const syncedAt = hasMore ? lastSyncAt : new Date(now).toISOString();
    const updated = await env.DB.prepare('UPDATE oauth_accounts SET cursor = ?1, last_sync_at = ?2 WHERE id = ?3 AND sync_id = ?4')
      .bind(page.cursorAfter(processed) ?? account.cursor, syncedAt, id, syncId).run();
    if (!updated.meta.changes) throw new Error('Mail sync lease expired');
    return { id, imported, oversized, hasMore, lastSyncAt: syncedAt };
  } catch (error) {
    const message = error instanceof HttpError ? error.message
      : error instanceof MailProviderError && [401, 403].includes(error.status)
        ? '邮箱授权不可用，请重新授权并允许读取邮件。'
        : '无法同步此邮箱，请稍后刷新。';
    return { id, imported, oversized, hasMore: false, lastSyncAt, error: message };
  } finally {
    await env.DB.prepare('UPDATE oauth_accounts SET sync_id = NULL, sync_until = 0 WHERE id = ?1 AND sync_id = ?2')
      .bind(id, syncId).run();
  }
}

export async function getMailAccountCredentials(env: Env, id: string) {
  const account = await env.DB.prepare(`SELECT provider, credential, address FROM (
    SELECT c.provider, c.credential, a.address FROM imap_accounts c
    JOIN aliases a ON a.id = c.id WHERE c.id = ?1 AND a.status = 'active'
    UNION ALL
    SELECT c.provider, c.credential, a.address FROM oauth_accounts c
    JOIN aliases a ON a.id = c.id WHERE c.id = ?1 AND a.status = 'active'
  )`).bind(id).first<{ provider: MailProvider; credential: string; address: string }>();
  if (!account) return null;
  const { provider, address } = account;
  if (isOAuthProvider(provider)) {
    return { provider, address, accessToken: await oauthAccessToken(env, { ...account, id, provider }) };
  }
  return { provider, address, authorizationCode: await openCredential(env, account) };
}
