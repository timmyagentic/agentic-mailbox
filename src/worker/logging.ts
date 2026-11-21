/** Only operational metadata belongs here. Never pass request bodies, URLs,
 * addresses, MIME headers, exception messages, or credentials to the logger. */
type Level = 'info' | 'warn' | 'error';
export type IngestStage = 'recipient' | 'alias_lookup' | 'parse' | 'deduplicate' | 'attachments' | 'database' | 'forward';

type DiagnosticEvent =
  | { event: 'http_request'; requestId: string; route: string; method: string; status: number; code?: string; durationMs: number }
  | { event: 'email_rejected'; processingId: string; reason: 'unmanaged_domain' | 'unregistered_or_disabled'; durationMs: number }
  | { event: 'email_duplicate'; processingId: string; aliasId: string; durationMs: number }
  | { event: 'email_ingested'; processingId: string; emailId: string; aliasId: string; attachmentCount: number; rawSize: number; forwarding: 'disabled' | 'succeeded' | 'failed'; durationMs: number }
  | { event: 'email_ingest_failed'; processingId: string; stage: IngestStage; durationMs: number }
  | { event: 'forward_failed'; processingId: string; emailId: string }
  | { event: 'attachment_cleanup_failed'; processingId: string; attachmentCount: number };

export function logEvent(level: Level, event: DiagnosticEvent): void {
  console[level](JSON.stringify({ timestamp: new Date().toISOString(), level, ...event }));
}

export function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

// Templates keep search text and arbitrary resource identifiers out of logs.
export function requestRoute(pathname: string): string {
  if (['/api/health', '/api/session', '/api/session/certificate', '/api/bootstrap', '/api/aliases', '/api/mail-accounts', '/api/emails', '/api/files', '/api/conversations', '/api/drafts'].includes(pathname)) {
    return pathname;
  }
  if (/^\/api\/oauth\/(?:gmail|outlook)\/(?:start|callback|finish)$/.test(pathname)) return pathname;
  if (/^\/api\/conversations\/[^/]+$/.test(pathname)) return '/api/conversations/:id';
  if (/^\/api\/drafts\/[^/]+(?:\/(?:send|suggest|files)(?:\/[^/]+)?)?$/.test(pathname)) return '/api/drafts/:id';
  if (/^\/api\/emails\/[^/]+\/placement$/.test(pathname)) return '/api/emails/:id/placement';
  if (/^\/api\/mail-accounts\/[^/]+\/refresh$/.test(pathname)) return '/api/mail-accounts/:id/refresh';
  if (/^\/api\/aliases\/[^/]+$/.test(pathname)) return '/api/aliases/:id';
  if (/^\/api\/emails\/[^/]+$/.test(pathname)) return '/api/emails/:id';
  if (/^\/api\/attachments\/[^/]+\/download$/.test(pathname)) return '/api/attachments/:id/download';
  return pathname.startsWith('/api/') ? '/api/unknown' : 'asset';
}

export function requestMethod(method: string): string {
  return ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'].includes(method) ? method : 'OTHER';
}
