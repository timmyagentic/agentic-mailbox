import type {
  AttachmentItem,
  BootstrapPayload,
  Conversation,
  ConversationSummary,
  DraftFile,
  DraftInput,
  MailDraft,
  MailFolder,
  EmailDetail,
  EmailSummary,
  MailAlias,
  MailAccount,
  MailRefreshResult,
  OAuthProvider,
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

export function createMailboxApi(transport: (path: string, init?: RequestInit) => Promise<Response> = (path, init) => fetch(path, init)) {
  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await transport(path, {
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

  return {
    startChatGPT: (intent: 'login' | 'link') =>
      api<{ url: string }>('/api/chatgpt/start', { method: 'POST', body: JSON.stringify({ intent }) }),
    finishChatGPT: (params: URLSearchParams) =>
      api<SessionPayload>('/api/chatgpt/finish', { method: 'POST', body: JSON.stringify(Object.fromEntries(params)) }),
    disconnectChatGPT: () => api<{ revoked: boolean }>('/api/chatgpt/disconnect', { method: 'POST', body: '{}' }),
    connectCodex: () => api<{ profile: string }>('/api/codex/connect', { method: 'POST', body: '{}' }),
    unlockLocal: (ticket: string) => api<SessionPayload>('/api/session/local', { method: 'POST', body: JSON.stringify({ ticket }) }),
    memberLogin: (username: string, password: string, register: boolean) =>
      api<SessionPayload>(register ? '/api/members/register' : '/api/members/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    session: () => api<SessionPayload>('/api/session'),
    login: (password: string) =>
      api<SessionPayload>('/api/session', { method: 'POST', body: JSON.stringify({ password }) }),
    loginWithCertificate: () =>
      api<SessionPayload>('/api/session/certificate', { method: 'POST', body: '{}' }),
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
    startMailOAuth: (provider: OAuthProvider, accountId?: string) =>
      api<{ url: string }>(`/api/oauth/${provider}/start`, { method: 'POST', body: JSON.stringify({ accountId }) }),
    finishMailOAuth: (provider: OAuthProvider, response: { state: string | null; code: string | null; error: string | null }) =>
      api<{ ok: true; accountId: string }>(`/api/oauth/${provider}/finish`, { method: 'POST', body: JSON.stringify(response) }),
    saveMailAccount: (input: { email: string; authorizationCode: string }) =>
      api<{ account: MailAccount }>('/api/mail-accounts', { method: 'POST', body: JSON.stringify(input) }),
    refreshMailAccount: (id: string) =>
      api<{ result: MailRefreshResult }>(`/api/mail-accounts/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
    emails: (filter: { aliasId?: string; query?: string; unreadOnly?: boolean; signal?: AbortSignal } = {}) => {
      const params = new URLSearchParams({ limit: '100' });
      if (filter.aliasId) params.set('aliasId', filter.aliasId);
      if (filter.query) params.set('q', filter.query);
      if (filter.unreadOnly) params.set('unread', '1');
      return api<{ emails: EmailSummary[] }>(`/api/emails?${params}`, { signal: filter.signal });
    },
    conversations: (filter: { folder: MailFolder; page?: number; aliasId?: string; query?: string; unreadOnly?: boolean; signal?: AbortSignal }) => {
      const params = new URLSearchParams({ folder: filter.folder, page: String(filter.page ?? 1) });
      if (filter.aliasId) params.set('aliasId', filter.aliasId);
      if (filter.query) params.set('q', filter.query);
      if (filter.unreadOnly) params.set('unread', '1');
      return api<{ conversations: ConversationSummary[]; total: number }>(`/api/conversations?${params}`, { signal: filter.signal });
    },
    conversation: (id: string, signal?: AbortSignal) =>
      api<Conversation>(`/api/conversations/${encodeURIComponent(id)}`, { signal }),
    markConversation: (id: string, read: boolean) =>
      api<{ ok: true }>(`/api/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ read }) }),
    placeEmail: (id: string, update: { starred?: boolean; folder?: 'archive' | 'trash' | 'restore' }) =>
      api<{ ok: true }>(`/api/emails/${encodeURIComponent(id)}/placement`, { method: 'PATCH', body: JSON.stringify(update) }),
    drafts: (signal?: AbortSignal) => api<{ drafts: MailDraft[] }>('/api/drafts', { signal }),
    draft: (id: string) => api<{ draft: MailDraft }>(`/api/drafts/${encodeURIComponent(id)}`),
    saveDraft: (body: DraftInput, id?: string) => api<{ draft: MailDraft }>(
      id ? `/api/drafts/${encodeURIComponent(id)}` : '/api/drafts',
      { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) },
    ),
    discardDraft: (id: string) => api<{ ok: true }>(`/api/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    sendDraft: (id: string) => api<{ id: string; rejected: string[] }>(`/api/drafts/${encodeURIComponent(id)}/send`, { method: 'POST', body: '{}' }),
    suggestDraft: (id: string, instruction: string) =>
      api<{ text: string }>(`/api/drafts/${encodeURIComponent(id)}/suggest`, { method: 'POST', body: JSON.stringify({ instruction }) }),
    addDraftFile: (id: string, file: Blob & { name: string }, filename = file.name) => api<{ file: DraftFile }>(
      `/api/drafts/${encodeURIComponent(id)}/files?name=${encodeURIComponent(filename)}`,
      { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } },
    ),
    removeDraftFile: (id: string, fileId: string) => api<{ ok: true }>(
      `/api/drafts/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' },
    ),
    email: (id: string) => api<{ email: EmailDetail }>(`/api/emails/${encodeURIComponent(id)}`),
    setEmailRead: (id: string, read: boolean) =>
      api<{ ok: boolean }>(`/api/emails/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ read }),
      }),
    files: () => api<{ files: AttachmentItem[] }>('/api/files?limit=100'),
  };
}

export const mailboxApi = createMailboxApi();
