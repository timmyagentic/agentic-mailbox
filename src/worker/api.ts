import { getSession } from './auth';
import { accessRoute } from './access';
import { createAlias, listAliases, updateAlias } from './db';
import { cancelPending, confirmDestination, getSettings, requestDestination, setRelaySenderName, verifyDestination } from './forwarding';
import { assertSameOrigin, HttpError, json, parseLimit, readJson } from './http';
import { memberUsername, routeMember } from './members';
import { legacySources } from './sources';
import type { Env } from './types';

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const access = accessRoute(request, env);
  if (access) return access;
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
