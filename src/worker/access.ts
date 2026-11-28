import { clearedSessionCookies, createSessionToken, getSession, passwordsMatch, sessionCookie, verifiedClientFingerprint } from './auth';
import { memberUsername } from './members';
import { assertSameOrigin, HttpError, json, readJson } from './http';
import type { SessionEnv } from './types';

type LoginBody = { password?: string };

async function health(env: SessionEnv): Promise<Response> {
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

async function startAdminSession(request: Request, env: SessionEnv, fingerprint?: string): Promise<Response> {
  const token = await createSessionToken(env.ADMIN_EMAIL, env.SESSION_SECRET, Date.now(), fingerprint);
  return json(
    { authenticated: true, user: { email: env.ADMIN_EMAIL } },
    200,
    { 'Set-Cookie': sessionCookie(token, request.url) },
  );
}

async function handleCertificateLogin(request: Request, env: SessionEnv): Promise<Response> {
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

async function handleSession(request: Request, env: SessionEnv, edition?: 'imap'): Promise<Response> {
  if (request.method === 'GET') {
    const username = await memberUsername(request, env);
    const session = username ? { authenticated: true, user: { email: username } }
      : await getSession(request, env.ADMIN_EMAIL, env.SESSION_SECRET, env.ADMIN_CERT_FINGERPRINTS);
    return json({ ...session, admin: session.authenticated && !username, edition: edition ?? (env.MEMBERS ? 'hosted' : undefined) });
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

export function accessRoute(request: Request, env: SessionEnv, edition?: 'imap') {
  const path = new URL(request.url).pathname;
  if (path === '/api/health' && request.method === 'GET') return health(env);
  if (path === '/api/session') return handleSession(request, env, edition);
  if (path === '/api/session/certificate') return handleCertificateLogin(request, env);
  return null;
}
