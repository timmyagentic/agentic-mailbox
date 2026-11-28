import { handleApi } from './api';
import { apiError, HttpError, withSecurityHeaders } from './http';
import { forwardEmail } from './mail';
import { elapsedMs, logEvent, requestMethod, requestRoute } from './logging';
import type { EmailWorkerMessage, Env } from './types';

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/downloads/')) throw new HttpError(410, 'client_retired', '独立客户端已退役，请打开首页设置邮件转发。');
  if (url.pathname.startsWith('/api/')) return handleApi(request, env);

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
    await forwardEmail(message, env);
  },
} satisfies ExportedHandler<Env>;
