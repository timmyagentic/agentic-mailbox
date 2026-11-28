import { clearedSessionCookies, createSessionToken, getSession, passwordsMatch, sessionCookie, verifiedClientFingerprint } from './auth';
import { createAlias, listAliases, updateAlias } from './db';
import { cancelPending, confirmDestination, getSettings, requestDestination, setRelaySenderName, verifyDestination } from './forwarding';
import { assertSameOrigin, HttpError, json, parseLimit, readJson } from './http';
import { memberUsername, routeMember } from './members';
import { legacySources } from './sources';
import type { Env } from './types';

type LoginBody = { password?: string };

async function health(env: Env): Promise<Response> {
  try {
    await env.DB.prepare('SELECT 1').first();
    return json({
      ok: true,
      service: 'open-postway',
      dependencies: { database: 'ready' },
      timestamp: new Date().toISOString(),
    });
  } catch {
    return json(
      {
        ok: false,
        service: 'open-postway',
        dependencies: { database: 'unavailable' },
        timestamp: new Date().toISOString(),
      },
      503,
    );
  }
}

async function startAdminSession(request: Request, env: Env, fingerprint?: string): Promise<Response> {
  const token = await createSessionToken(env.ADMIN_EMAIL, env.SESSION_SECRET, Date.now(), fingerprint);
  return json(
    { authenticated: true, user: { email: env.ADMIN_EMAIL } },
    200,
    { 'Set-Cookie': sessionCookie(token, request.url) },
  );
}

async function handleCertificateLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    throw new HttpError(405, 'method_not_allowed', '请求方法不支持。');
  }
  assertSameOrigin(request);
  // JSON prevents ordinary cross-site form submissions from starting a certificate session.
  await readJson<unknown>(request);

  if (new URL(request.url).protocol !== 'https:') {
    throw new HttpError(400, 'certificate_requires_https', '请通过已启用设备证书的 HTTPS 地址登录。');
  }
  if (!env.ADMIN_CERT_FINGERPRINTS?.trim()) {
    throw new HttpError(503, 'certificate_login_unconfigured', '此站点尚未配置设备证书登录。');
  }
  const fingerprint = verifiedClientFingerprint(request, env.ADMIN_CERT_FINGERPRINTS);
  if (!fingerprint) {
    throw new HttpError(403, 'certificate_not_allowed', '未识别到可用的设备证书，请在浏览器中选择已登记的证书。');
  }
  return startAdminSession(request, env, fingerprint);
}

async function handleSession(request: Request, env: Env): Promise<Response> {
  if (request.method === 'GET') {
    const username = await memberUsername(request, env);
    const session = username ? { authenticated: true, user: { email: username } }
      : await getSession(request, env.ADMIN_EMAIL, env.SESSION_SECRET, env.ADMIN_CERT_FINGERPRINTS);
    return json({ ...session, admin: session.authenticated && !username, ...(env.MEMBERS ? { edition: 'hosted' } : {}) });
  }

  assertSameOrigin(request);
  if (request.method === 'POST') {
    const body = await readJson<LoginBody>(request);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password || !(await passwordsMatch(password, env.ADMIN_PASSWORD))) {
      throw new HttpError(401, 'invalid_credentials', '密码不正确。');
    }
    return startAdminSession(request, env);
  }

  if (request.method === 'DELETE') {
    return json(
      { authenticated: false, user: null },
      200,
      clearedSessionCookies(request.url),
    );
  }

  throw new HttpError(405, 'method_not_allowed', '请求方法不支持。');
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === '/api/health' && method === 'GET') return health(env);
  if (path === '/api/session') return handleSession(request, env);
  if (path === '/api/session/certificate') return handleCertificateLogin(request, env);
  const memberLogin = await routeMember(request, env);
  if (memberLogin) return memberLogin;

  const username = await memberUsername(request, env);
  if (!username && !(await getSession(request, env.ADMIN_EMAIL, env.SESSION_SECRET, env.ADMIN_CERT_FINGERPRINTS)).authenticated) {
    throw new HttpError(401, 'authentication_required', '请先登录转发设置。');
  }
  const owner = username ? 'member:' + username : 'admin';
  if (method !== 'GET') assertSameOrigin(request);
  if (path === '/api/forwarding' && method === 'GET') return json(await getSettings(env, owner));
  if (path === '/api/forwarding/sender' && method === 'PUT') {
    const body = await readJson<{ name?: unknown }>(request);
    return json(await setRelaySenderName(env, owner, body?.name));
  }
  if (path === '/api/forwarding/sources' && method === 'GET') return json({ sources: await legacySources(env, username) });
  if (path === '/api/forwarding/destination' && method === 'DELETE') {
    await readJson(request);
    return json(await cancelPending(env, owner));
  }
  if ((path === '/api/forwarding/destination' && method === 'PUT') || (path === '/api/forwarding/verify' && method === 'POST')) {
    const body = await readJson<{ address?: unknown }>(request);
    const limited = await env.MEMBER_AUTH_LIMIT?.limit({ key: 'forwarding:' + (request.headers.get('CF-Connecting-IP') || owner) });
    if (limited && !limited.success) throw new HttpError(429, 'rate_limited', '请求过于频繁，请稍后重试。');
    const change = method === 'PUT' ? requestDestination : verifyDestination;
    return json(await change(env, owner, body?.address));
  }
  if (path === '/api/forwarding/confirm' && method === 'POST') {
    const body = await readJson<{ code?: unknown }>(request);
    return json(await confirmDestination(env, owner, body?.code));
  }
  if (path === '/api/aliases' || path.startsWith('/api/aliases/')) {
    if (username) throw new HttpError(403, 'admin_required', '域名别名由管理员维护。');
    if (path === '/api/aliases' && method === 'GET') {
      return json({ aliases: await listAliases(env, url.searchParams.get('q') ?? '', parseLimit(url.searchParams.get('limit'), 100)) });
    }
    if (path === '/api/aliases' && method === 'POST') return json({ alias: await createAlias(env, await readJson(request)) }, 201);
    const id = path.match(/^\/api\/aliases\/([^/]+)$/)?.[1];
    if (id && method === 'PATCH') return json({ alias: await updateAlias(env, id, await readJson(request)) });
  }
  throw new HttpError(404, 'not_found', '找不到此接口。');
}
