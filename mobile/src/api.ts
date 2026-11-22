import { fetch as expoFetch } from 'expo/fetch';
import { File, Paths } from 'expo-file-system';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import { createMailboxApi } from '../../src/client/api';
import type { AttachmentItem, OAuthProvider } from '../../src/shared/types';

const site = new URL(process.env.EXPO_PUBLIC_MAILBOX_ORIGIN || 'https://mailbox.timmyagentic.si');
if (site.protocol !== 'https:' && !(__DEV__ && site.hostname === '127.0.0.1')) {
  throw new Error('Agentic Mailbox requires HTTPS.');
}
export const origin = site.origin;
export const sessionKey = 'agentic-mailbox.session.' + site.host.replace(/[^a-zA-Z0-9_.-]/g, '_');

export function mobileApi(token?: string, onExpired?: () => void) {
  async function transport(input: string, init?: RequestInit): Promise<Response> {
    if (typeof input !== 'string' || !input.startsWith('/api/')) throw new Error('Invalid mailbox API path');
    const url = new URL(input, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/api/')) throw new Error('Invalid mailbox API origin');
    const headers = new Headers(init?.headers);
    headers.set('Origin', origin);
    headers.set('X-Agentic-Mailbox-Client', 'mobile');
    if (token) headers.set('Authorization', 'Bearer ' + token);
    const response = await expoFetch(url.href, { ...init, headers, credentials: 'omit', redirect: 'error' } as Parameters<typeof expoFetch>[1]);
    if (response.status === 401 && token) onExpired?.();
    return response as unknown as Response;
  }
  const api = createMailboxApi(transport);
  return {
    ...api,
    connectOAuth: async (provider: OAuthProvider, accountId?: string) => {
      const { url } = await api.startMailOAuth(provider, accountId);
      const authorize = Linking.parse(url);
      const expected = provider === 'gmail' ? 'accounts.google.com' : 'login.microsoftonline.com';
      if (authorize.scheme !== 'https' || authorize.hostname !== expected) throw new Error('无法打开服务商授权页面。');
      const state = authorize.queryParams?.state;
      const result = await WebBrowser.openAuthSessionAsync(url, 'agentic-mailbox://oauth');
      if (result.type !== 'success') return null;
      const callback = Linking.parse(result.url);
      if (callback.scheme !== 'agentic-mailbox' || callback.hostname !== 'oauth' ||
          callback.queryParams?.mailOAuth !== provider || callback.queryParams?.state !== state || typeof state !== 'string') {
        throw new Error('邮箱授权回调无效，请重新接入。');
      }
      const value = (key: string) => {
        const found = callback.queryParams?.[key];
        return typeof found === 'string' ? found : null;
      };
      return api.finishMailOAuth(provider, { state, code: value('code'), error: value('error') });
    },
    shareAttachment: async (attachment: AttachmentItem) => {
      const result = await transport('/api/attachments/' + encodeURIComponent(attachment.id) + '/download');
      if (!result.ok) throw new Error('附件下载失败。');
      const filename = attachment.filename.split(/[\\/<>:"|?*]/).join('_').slice(0, 150) || 'attachment';
      const file = new File(Paths.cache, Date.now() + '-' + filename);
      file.write(new Uint8Array(await result.arrayBuffer()));
      try {
        await Sharing.shareAsync(file.uri, { mimeType: attachment.contentType, dialogTitle: attachment.filename });
      } finally {
        if (file.exists) file.delete();
      }
    },
  };
}

export type MobileApi = ReturnType<typeof mobileApi>;
export function message(error: unknown): string { return error instanceof Error ? error.message : '操作失败，请重试。'; }
