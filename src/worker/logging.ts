/** Only operational metadata belongs here. Never pass request bodies, URLs,
 * addresses, MIME headers, exception messages, or credentials to the logger. */
type Level = 'info' | 'warn' | 'error';
type DiagnosticEvent =
  | { event: 'http_request'; requestId: string; route: string; method: string; status: number; code?: string; durationMs: number }
  | { event: 'email_forwarded' | 'email_resent' | 'email_rejected'; processingId: string }
  | { event: 'email_forward_failed'; processingId: string; providerCode?: string };

export function logEvent(level: Level, event: DiagnosticEvent): void {
  console[level](JSON.stringify({ timestamp: new Date().toISOString(), level, ...event }));
}

export function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

// Templates keep search text and arbitrary resource identifiers out of logs.
export function requestRoute(pathname: string): string {
  if (['/api/health', '/api/session', '/api/session/certificate', '/api/forwarding', '/api/forwarding/destination',
    '/api/forwarding/sender', '/api/forwarding/verify', '/api/forwarding/confirm', '/api/forwarding/sources', '/api/aliases'].includes(pathname)) return pathname;
  if (/^\/api\/aliases\/[^/]+$/.test(pathname)) return '/api/aliases/:id';
  return pathname.startsWith('/api/') ? '/api/unknown' : 'asset';
}

export function requestMethod(method: string): string {
  return ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'].includes(method) ? method : 'OTHER';
}
