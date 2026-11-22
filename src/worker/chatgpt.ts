import { getSession, readSessionCookie } from './auth';
import { assertSameOrigin, HttpError, json, readJson } from './http';
import type { Env } from './types';
import type { ChatGPTConnection } from '../shared/types';

export async function localChatGPT<T>(env: Env, action: string, body?: unknown): Promise<T> {
  if (env.LOCAL_MODE !== '1' || !env.CHATGPT) throw new HttpError(404, 'local_feature_only', '此功能仅在本机可用。');
  const response = await env.CHATGPT.fetch('https://local-chatgpt.internal/' + action, body === undefined ? {} : {
    method: 'POST', body: JSON.stringify(body),
  });
  if (!response.ok) {
    const failure = await response.json<{ message?: string }>();
    throw new HttpError(response.status, 'chatgpt_failed', failure.message || 'ChatGPT 连接失败。');
  }
  return response.json<T>();
}

export function chatGPTCallback(url: URL) {
  const params = new URLSearchParams({ chatgpt: 'return' });
  for (const key of ['state', 'code', 'client_id', 'error']) {
    const value = url.searchParams.get(key);
    if (value && value.length <= 4096) params.set(key, value);
  }
  return new Response(null, { status: 303, headers: { Location: '/#' + params, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

export async function chatGPTRoute(request: Request, env: Env, startSession: () => Promise<Response>) {
  const url = new URL(request.url);
  if (!env.CHATGPT || env.LOCAL_MODE !== '1' || url.hostname !== '127.0.0.1') throw new HttpError(404, 'local_feature_only', '请使用本机启动器打开邮箱。');
  if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', '请求方法不支持。');
  assertSameOrigin(request);
  const body = await readJson<{ intent?: string; code?: string; state?: string; client_id?: string; error?: string }>(request);
  const authenticated = (await getSession(request, env.ADMIN_EMAIL, env.SESSION_SECRET, env.ADMIN_CERT_FINGERPRINTS)).authenticated;
  const session = authenticated ? readSessionCookie(request) : null;
  const cookieName = 'agentic_chatgpt_flow';
  const cookie = '; HttpOnly; SameSite=Strict; Path=/api/chatgpt';
  if (url.pathname === '/api/chatgpt/start') {
    const linking = body.intent === 'link';
    if (linking && !session) throw new HttpError(401, 'login_required', '请先登录本机邮箱。');
    const browser = crypto.randomUUID();
    const result = await localChatGPT<{ url: string }>(env, 'start', { browser, linking, session });
    return json(result, 200, { 'Set-Cookie': cookieName + '=' + browser + cookie + '; Max-Age=600' });
  }
  if (url.pathname === '/api/chatgpt/finish') {
    const browser = (request.headers.get('Cookie') || '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    await localChatGPT<ChatGPTConnection>(env, 'finish', { browser, session, code: body.code, state: body.state, error: body.error, clientId: body.client_id });
    const response = await startSession();
    response.headers.append('Set-Cookie', cookieName + '=' + cookie + '; Max-Age=0');
    return response;
  }
  if (url.pathname === '/api/chatgpt/disconnect') {
    if (!session) throw new HttpError(401, 'login_required', '请先登录本机邮箱。');
    return json(await localChatGPT(env, 'disconnect', {}));
  }
  throw new HttpError(404, 'not_found', '未找到操作。');
}
