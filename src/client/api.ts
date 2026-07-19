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

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    const error = payload?.error;
    throw new ApiRequestError(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? '请求失败，请稍后重试。',
    );
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
