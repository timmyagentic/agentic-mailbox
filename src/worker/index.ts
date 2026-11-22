import { chatGPTCallback } from './chatgpt';
import { routeMember } from './members';
import { handleApi } from './api';
import { apiError, HttpError, withSecurityHeaders } from './http';
import { ingestEmail } from './mail';
import { elapsedMs, logEvent, requestMethod, requestRoute } from './logging';
import type { EmailWorkerMessage, Env } from './types';

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (env.LOCAL_MODE === '1' && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new HttpError(403, 'invalid_local_host', '请使用本机地址。');
  }
  if (env.MEMBERS && ['GET', 'HEAD'].includes(request.method) && url.pathname === '/downloads/mailbox-vault-mac-arm64.zip') {
    return Response.redirect(new URL('/downloads/agentic-mailbox-mac-arm64.zip', url), 308);
  }
  if (env.MEMBERS && url.pathname === '/downloads/agentic-mailbox-mac-arm64.zip' && ['GET', 'HEAD'].includes(request.method)) {
    const archive = await env.ATTACHMENTS.get('releases/agentic-mailbox-mac-arm64.zip');
    if (!archive) throw new HttpError(404, 'download_missing', '本地版安装包暂不可用。');
    return new Response(request.method === 'HEAD' ? null : archive.body, { headers: {
      'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="agentic-mailbox-mac-arm64.zip"',
      'Content-Length': String(archive.size), 'ETag': archive.httpEtag,
    } });
  }
  if (env.LOCAL_MODE === '1' && env.CHATGPT && url.pathname === '/auth/callback' && request.method === 'GET') {
    return chatGPTCallback(url);
  }
  if (url.pathname.startsWith('/api/')) {
    return await routeMember(request, env) ?? handleApi(request, env);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new HttpError(405, 'method_not_allowed', '请求方法不支持。');
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    let response: Response;
    let code: string | undefined;
    try {
      response = await handleRequest(request, env);
    } catch (error) {
      code = error instanceof HttpError ? error.code : 'internal_error';
      response = apiError(error, requestId);
    }
    const secured = withSecurityHeaders(response);
    secured.headers.set('X-Request-Id', requestId);
    const route = requestRoute(new URL(request.url).pathname);
    // Static asset successes already have platform invocation logs.
    if (route !== 'asset' || response.status >= 400) {
      logEvent(response.status >= 500 ? 'error' : response.status >= 400 ? 'warn' : 'info', {
        event: 'http_request', requestId, route, method: requestMethod(request.method),
        status: response.status, code, durationMs: elapsedMs(started),
      });
    }
    return secured;
  },

  async email(message: EmailWorkerMessage, env: Env): Promise<void> {
    await ingestEmail(message, env);
  },
} satisfies ExportedHandler<Env>;
