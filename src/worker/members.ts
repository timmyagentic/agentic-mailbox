import { createSessionToken, readSessionCookie, sessionCookie, verifySessionToken } from './auth';
import { assertSameOrigin, HttpError, json, readJson } from './http';
import type { Env } from './types';

const usernamePattern = /^[a-z0-9][a-z0-9_-]{2,39}$/;
export function memberSecret(env: Env) { return env.SESSION_SECRET + '/member-session-v1'; }

export async function memberSession(env: Env, username: string) {
  const token = await createSessionToken(username, memberSecret(env));
  return `member:${username}:${token}`;
}

export async function routeMember(request: Request, env: Env): Promise<Response | null> {
  const namespace = env.MEMBERS;
  if (!namespace) return null;
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/api/members/login' || path === '/api/members/register') {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', '请求方法不支持。');
    assertSameOrigin(request);
    const result = await env.MEMBER_AUTH_LIMIT?.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' });
    if (result && !result.success) throw new HttpError(429, 'auth_rate_limit', '请稍后再试。');
    const body = await readJson<{ username?: unknown; password?: unknown }>(request);
    const username = typeof body?.username === 'string' ? body.username.toLowerCase().trim() : '';
    if (!usernamePattern.test(username) || typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 256) {
      throw new HttpError(400, 'invalid_login', '用户名为 3–40 位字母、数字、下划线或短横线，密码需 12–256 位。');
    }
    return namespace.getByName(username).fetch(new Request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agentic-Mailbox-User': username },
      body: JSON.stringify({ password: body.password }),
    }));
  }
  // These routes belong to the site itself, including the unauthenticated OAuth landing page.
  if ((path === '/api/session' && request.method !== 'GET') || path === '/api/session/certificate'
    || path === '/api/health' || /^\/api\/oauth\/(gmail|outlook)\/callback$/.test(path)) return null;
  const raw = readSessionCookie(request);
  if (!raw?.startsWith('member:')) return null;
  const [, username, token] = raw.split(':');
  if (!usernamePattern.test(username) || !await verifySessionToken(token ?? '', username, memberSecret(env))) {
    if (path === '/api/session') return json({ authenticated: false, user: null, edition: 'hosted' });
    throw new HttpError(401, 'authentication_required', '请重新登录。');
  }
  if (path === '/api/session') return json({ authenticated: true, user: { email: username }, edition: 'hosted' });
  const forwarded = new Request(request);
  forwarded.headers.set('Cookie', sessionCookie(token, request.url).split(';')[0]);
  forwarded.headers.set('X-Agentic-Mailbox-User', username);
  return namespace.getByName(username).fetch(forwarded);
}
