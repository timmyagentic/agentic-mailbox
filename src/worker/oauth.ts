import { Buffer } from 'node:buffer';
import type { OAuthProvider } from '../shared/types';
import { normalizeAddress } from '../shared/validation';
import { openCredential, sealCredential } from './account-credentials';
import { readCookie, SESSION_COOKIE } from './auth';
import { boundedBody, HttpError } from './http';
import type { Env } from './types';

const googleScopes = 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send';
const microsoftScopes = 'offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send';
const microsoftOAuth = 'https://login.microsoftonline.com/common/oauth2/v2.0';

export const gmailApi = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const graphApi = 'https://graph.microsoft.com/v1.0/me';
export const immutableId = 'IdType="ImmutableId"';

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return value === 'gmail' || value === 'outlook';
}

function providerConfig(env: Env, provider: OAuthProvider) {
  if (!env.MAIL_OAUTH_ORIGIN) return null;
  const gmail = provider === 'gmail';
  const clientId = gmail ? env.GMAIL_CLIENT_ID : env.OUTLOOK_CLIENT_ID;
  const clientSecret = gmail ? env.GMAIL_CLIENT_SECRET : env.OUTLOOK_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  let callback: URL;
  try {
    callback = new URL(`/api/oauth/${provider}/callback`, env.MAIL_OAUTH_ORIGIN);
  } catch {
    return null;
  }
  if (callback.protocol !== 'https:' && (callback.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(callback.hostname))) return null;
  return {
    clientId, clientSecret, scope: gmail ? googleScopes : microsoftScopes,
    authorize: gmail ? 'https://accounts.google.com/o/oauth2/v2/auth' : `${microsoftOAuth}/authorize`,
    token: gmail ? 'https://oauth2.googleapis.com/token' : `${microsoftOAuth}/token`,
    callback,
  };
}

export function configuredOAuthProviders(env: Env): OAuthProvider[] {
  const providers: OAuthProvider[] = ['gmail', 'outlook'];
  return providers.filter((provider) => providerConfig(env, provider));
}

function requireConfig(env: Env, provider: OAuthProvider) {
  const config = providerConfig(env, provider);
  if (!config) throw new HttpError(503, 'oauth_unconfigured', '请先配置此服务商的 OAuth 应用。');
  return config;
}

async function sha256(value: string) {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('base64url');
}

function randomToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

function checkOrigin(url: URL, expected: URL) {
  if (url.origin !== expected.origin) {
    throw new HttpError(400, 'oauth_wrong_origin', '请使用 OAuth 应用配置的邮箱管理站点地址。');
  }
}

async function sessionHash(request: Request) {
  const session = readCookie(request, SESSION_COOKIE);
  if (!session) throw new HttpError(401, 'authentication_required', '请先登录管理端。');
  return sha256(session);
}

export async function startOAuth(env: Env, request: Request, provider: OAuthProvider, reconnect?: unknown) {
  const config = requireConfig(env, provider);
  checkOrigin(new URL(request.url), config.callback);
  let accountId: string | null = null;
  if (reconnect !== undefined) {
    const account = typeof reconnect === 'string'
      ? await env.DB.prepare('SELECT id FROM oauth_accounts WHERE id = ?1 AND provider = ?2')
        .bind(reconnect, provider).first<{ id: string }>()
      : null;
    if (!account) throw new HttpError(404, 'mail_account_missing', '这个邮箱账号不存在。');
    accountId = account.id;
  }
  const state = randomToken();
  const verifier = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_flows WHERE expires_at <= ?1').bind(now),
    env.DB.prepare(`INSERT INTO oauth_flows (state, provider, session_hash, verifier, account_id, expires_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind(state, provider, await sessionHash(request), verifier, accountId, now + 10 * 60_000),
  ]);
  const url = new URL(config.authorize);
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.callback.href, response_type: 'code',
    scope: config.scope, state, code_challenge: await sha256(verifier), code_challenge_method: 'S256',
    ...(provider === 'gmail' ? { access_type: 'offline', prompt: 'consent select_account' } : { prompt: 'select_account' }),
  }).toString();
  return url.href;
}

export function oauthCallback(env: Env, url: URL, provider: OAuthProvider) {
  const config = requireConfig(env, provider);
  checkOrigin(url, config.callback);
  // The cross-site navigation cannot carry the Strict admin cookie.
  // A fresh same-origin request completes the flow with the original session.
  const fragment = new URLSearchParams({ mailOAuth: provider });
  for (const name of ['state', 'code', 'error']) {
    const value = url.searchParams.get(name);
    if (value && value.length <= 4096) fragment.set(name, value);
  }
  return new Response(null, {
    status: 303,
    headers: { Location: `/#${fragment}`, 'Cache-Control': 'no-store' },
  });
}

type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };

async function requestTokens(env: Env, provider: OAuthProvider, params: Record<string, string>, previous?: string): Promise<Tokens> {
  const config = requireConfig(env, provider);
  const response = await fetch(config.token, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12_000),
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params }),
  }).catch(() => { throw new HttpError(502, 'oauth_unavailable', '邮箱授权服务暂时不可用。'); });
  const result = await response.json<{
    access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string;
  }>().catch(() => null);
  if (result?.error === 'invalid_grant') {
    throw new HttpError(409, 'oauth_reconnect_required', '邮箱授权已失效，请重新授权。');
  }
  if (!response.ok || !result?.access_token || !Number.isFinite(result.expires_in)) {
    throw new HttpError(502, 'oauth_token_failed', '无法获取邮箱授权，请检查 OAuth 应用配置和同意权限。');
  }
  if (result.scope) {
    const granted = new Set(result.scope.toLowerCase().split(/\s+/).map((scope) => scope.replace('https://graph.microsoft.com/', '')));
    const required = provider === 'gmail' ? googleScopes.split(' ').slice(2) : ['user.read', 'mail.read', 'mail.send'];
    if (!required.every((scope) => granted.has(scope))) {
      throw new HttpError(403, 'oauth_scope_missing', '请重新授权并同意读取和发送邮件的权限。');
    }
  }
  const refreshToken = result.refresh_token ?? previous;
  if (!refreshToken) throw new HttpError(400, 'oauth_offline_missing', '未获得离线访问权限，请重新授权。');
  return { accessToken: result.access_token, refreshToken, expiresAt: Date.now() + Number(result.expires_in) * 1000 };
}

type GmailErrorReason = 'service_disabled' | 'insufficient_scope' | 'domain_policy' | 'rate_limited';

async function gmailErrorReason(response: Response): Promise<GmailErrorReason | undefined> {
  try {
    const raw = await boundedBody(response, 16_384);
    if (!raw) return;
    type Failure = { error?: { errors?: { reason: string }[]; details?: { reason?: string }[] } };
    const data = JSON.parse(raw.toString('utf8')) as Failure | null;
    const reasons = new Set([
      ...(data?.error?.errors?.map(({ reason }) => reason) ?? []),
      ...(data?.error?.details?.map(({ reason }) => reason) ?? []),
    ]);
    if (reasons.has('SERVICE_DISABLED') || reasons.has('accessNotConfigured')) return 'service_disabled';
    if (reasons.has('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || reasons.has('insufficientPermissions')) return 'insufficient_scope';
    if (reasons.has('domainPolicy')) return 'domain_policy';
    if (['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].some((reason) => reasons.has(reason))) return 'rate_limited';
  } catch {
    // Keep the HTTP status when the provider error body cannot be read.
  }
}

export class MailProviderError extends Error {
  constructor(readonly status: number, readonly reason?: GmailErrorReason) { super('邮箱服务商暂时无法完成请求。'); }
}

export async function mailProviderFetch(url: string, token: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, {
    ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    const reason = url.startsWith(`${gmailApi}/`) && response.status === 403
      ? await gmailErrorReason(response) : undefined;
    await response.body?.cancel().catch(() => {});
    throw new MailProviderError(response.status, reason);
  }
  return response;
}

async function getIdentity(provider: OAuthProvider, token: string) {
  try {
    if (provider === 'gmail') {
      const response = await mailProviderFetch('https://openidconnect.googleapis.com/v1/userinfo', token);
      const profile = await response.json<{ sub?: string; email?: string; email_verified?: boolean }>();
      if (profile.email_verified) return { subject: profile.sub, address: profile.email };
    } else {
      const response = await mailProviderFetch(`${graphApi}?$select=id,mail,userPrincipalName`, token);
      const profile = await response.json<{ id?: string; mail?: string; userPrincipalName?: string }>();
      return { subject: profile.id, address: profile.mail || profile.userPrincipalName };
    }
  } catch {
    throw new HttpError(502, 'oauth_identity_failed', '无法确认已授权的邮箱身份。');
  }
  return {};
}

export async function finishOAuth(
  env: Env, request: Request, provider: OAuthProvider, body: { state?: unknown; code?: unknown; error?: unknown },
) {
  const config = requireConfig(env, provider);
  checkOrigin(new URL(request.url), config.callback);
  const { state, code, error } = body ?? {};
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
    throw new HttpError(400, 'oauth_state_invalid', '邮箱授权已过期或无效，请从邮箱设置重新开始。');
  }
  const flow = await env.DB.prepare(`DELETE FROM oauth_flows WHERE state = ?1 AND provider = ?2
    AND session_hash = ?3 AND expires_at > ?4 RETURNING verifier, account_id`)
    .bind(state, provider, await sessionHash(request), Date.now())
    .first<{ verifier: string; account_id: string | null }>();
  if (!flow) throw new HttpError(400, 'oauth_state_invalid', '邮箱授权已过期或无效，请从邮箱设置重新开始。');
  if (error || typeof code !== 'string' || !code || code.length > 4096) {
    throw new HttpError(400, 'oauth_authorization_cancelled', '邮箱授权未完成。');
  }

  const tokens = await requestTokens(env, provider, {
    grant_type: 'authorization_code', code, code_verifier: flow.verifier, redirect_uri: config.callback.href,
  });
  const identity = await getIdentity(provider, tokens.accessToken);
  const address = identity.address && normalizeAddress(identity.address);
  if (!address || !identity.subject) throw new HttpError(400, 'oauth_invalid_address', '未能读取授权邮箱的主地址。');

  const existing = await env.DB.prepare(`SELECT c.id, a.address FROM oauth_accounts c JOIN aliases a ON a.id = c.id
    WHERE c.provider = ?1 AND c.subject = ?2`).bind(provider, identity.subject).first<{ id: string; address: string }>();
  if ((flow.account_id && existing?.id !== flow.account_id) || (existing && existing.address !== address)) {
    throw new HttpError(409, 'oauth_account_mismatch', '请授权与原连接一致的邮箱账号。');
  }

  const credential = await sealCredential(env, address, JSON.stringify(tokens));
  if (existing) {
    const result = await env.DB.prepare('UPDATE oauth_accounts SET credential = ?1 WHERE id = ?2 AND sync_until <= ?3')
      .bind(credential, existing.id, Date.now()).run();
    if (!result.meta.changes) throw new HttpError(409, 'mail_sync_in_progress', '邮箱正在同步，请稍后重新授权。');
    return existing.id;
  }
  const id = crypto.randomUUID();
  const [local, domain] = address.split('@');
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO aliases (id, local_part, domain, address, routing_mode, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, 'external', ?5, ?5)`).bind(id, local, domain, address, now),
      env.DB.prepare('INSERT INTO oauth_accounts (id, provider, subject, credential) VALUES (?1, ?2, ?3, ?4)')
        .bind(id, provider, identity.subject, credential),
    ]);
  } catch (failure) {
    if (String(failure).includes('UNIQUE constraint failed')) {
      throw new HttpError(409, 'mail_address_exists', '这个邮箱地址已存在，请检查是否已绑定。');
    }
    throw failure;
  }
  return id;
}

export async function oauthAccessToken(env: Env, account: { id: string; provider: OAuthProvider; address: string; credential: string }) {
  const tokens = JSON.parse(await openCredential(env, account)) as Tokens;
  if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;

  const refreshed = await requestTokens(env, account.provider, {
    grant_type: 'refresh_token', refresh_token: tokens.refreshToken,
  }, tokens.refreshToken);
  const credential = await sealCredential(env, account.address, JSON.stringify(refreshed));
  const result = await env.DB.prepare('UPDATE oauth_accounts SET credential = ?1 WHERE id = ?2 AND credential = ?3')
    .bind(credential, account.id, account.credential).run();
  if (result.meta.changes) return refreshed.accessToken;
  // A concurrent send, sync, or reauthorization already saved a newer token.
  const latest = await env.DB.prepare('SELECT credential FROM oauth_accounts WHERE id = ?1')
    .bind(account.id).first<{ credential: string }>();
  if (!latest) throw new HttpError(404, 'mail_account_missing', '这个邮箱账号不存在。');
  const current = JSON.parse(await openCredential(env, { address: account.address, ...latest })) as Tokens;
  return current.accessToken;
}
