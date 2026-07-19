import { handleApi } from './api';
import { apiError, HttpError, withSecurityHeaders } from './http';
import { ingestEmail } from './mail';
import type { EmailWorkerMessage, Env } from './types';

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    return handleApi(request, env);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new HttpError(405, 'method_not_allowed', '请求方法不支持。');
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID();
    try {
      return withSecurityHeaders(await handleRequest(request, env));
    } catch (error) {
      return withSecurityHeaders(apiError(error, requestId));
    }
  },

  async email(message: EmailWorkerMessage, env: Env): Promise<void> {
    await ingestEmail(message, env);
  },
} satisfies ExportedHandler<Env>;
