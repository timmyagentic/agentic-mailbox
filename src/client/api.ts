import type {
  AttachmentItem,
  BootstrapPayload,
  EmailDetail,
  EmailSummary,
  MailAlias,
  SessionPayload,
} from '../shared/types';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, requestId?: string) {
    const safeId = requestId && /^[a-zA-Z0-9_-]{1,80}$/.test(requestId) ? requestId : undefined;
    super(safeId ? `${message}（错误编号：${safeId}）` : message);
    this.status = status;
    this.code = code;
    this.requestId = safeId;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiRequestError(0, 'network_error', '网络连接失败，请检查网络后刷新。若刚提交操作，请先刷新确认结果。');
  }

  const contentType = response.headers.get('content-type') ?? '';
  const requestId = response.headers.get('x-request-id') ?? undefined;
  let payload;
  try {
    payload = contentType.includes('application/json') ? await response.json() : null;
  } catch {
    // Preserve HTTP status below, including 401 from proxies or expired sessions.
    payload = null;
  }
  if (!response.ok) {
    const error = payload?.error;
    throw new ApiRequestError(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? '请求失败，请稍后重试。',
      error?.requestId ?? requestId,
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ApiRequestError(response.status, 'invalid_response', '服务返回了无法读取的数据，请刷新重试。', requestId);
  }
  return payload as T;
}

export const mailboxApi = {
  session: () => api<SessionPayload>('/api/session'),
  login: (password: string) =>
    api<SessionPayload>('/api/session', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => api<SessionPayload>('/api/session', { method: 'DELETE' }),
  bootstrap: () => api<BootstrapPayload>('/api/bootstrap'),
  aliases: () => api<{ aliases: MailAlias[] }>('/api/aliases?limit=100'),
  createAlias: (input: { localPart?: string; label: string; note?: string; generate: boolean }) =>
    api<{ alias: MailAlias }>('/api/aliases', { method: 'POST', body: JSON.stringify(input) }),
  updateAlias: (id: string, input: { label?: string; note?: string; status?: 'active' | 'disabled' }) =>
    api<{ alias: MailAlias }>(`/api/aliases/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  emails: () => api<{ emails: EmailSummary[] }>('/api/emails?limit=100'),
  email: (id: string) => api<{ email: EmailDetail }>(`/api/emails/${encodeURIComponent(id)}`),
  setEmailRead: (id: string, read: boolean) =>
    api<{ ok: boolean }>(`/api/emails/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ read }),
    }),
  files: () => api<{ files: AttachmentItem[] }>('/api/files?limit=100'),
};
