import type { ApiErrorPayload } from '../shared/types';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
}

export function apiError(error: unknown, requestId: string): Response {
  if (error instanceof HttpError) {
    return json(
      {
        error: { code: error.code, message: error.message, requestId },
      } satisfies ApiErrorPayload,
      error.status,
    );
  }

  return json(
    {
      error: {
        code: 'internal_error',
        message: '服务暂时不可用，请稍后重试。',
        requestId,
      },
    } satisfies ApiErrorPayload,
    500,
  );
}

export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'invalid_content_type', '请求必须使用 JSON。');
  }

  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, 'invalid_json', '请求 JSON 无法解析。');
  }
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new HttpError(403, 'invalid_origin', '请求来源不被允许。');
  }
}

export function parseLimit(value: string | null, fallback = 50, maximum = 100): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

export function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  secured.headers.set('X-Content-Type-Options', 'nosniff');
  secured.headers.set('X-Frame-Options', 'DENY');
  secured.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  secured.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  secured.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
  return secured;
}
