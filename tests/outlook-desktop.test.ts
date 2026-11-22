import { afterEach, describe, expect, it, vi } from 'vitest';
import { sealCredential } from '../src/worker/account-credentials';
import { configuredOAuthProviders, oauthAccessToken } from '../src/worker/oauth';
import type { Env } from '../src/worker/types';

const desktopId = '5c3a3257-2882-4a7a-8a39-f724445d3c94';
const origin = 'http://127.0.0.1:8787';

describe('Outlook desktop OAuth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('enables the desktop client only for a local loopback instance', () => {
    const desktop = { OUTLOOK_DESKTOP_CLIENT_ID: desktopId } as Env;

    expect(configuredOAuthProviders({ ...desktop, MAIL_OAUTH_ORIGIN: origin, LOCAL_MODE: '1' })).toEqual(['outlook']);
    expect(configuredOAuthProviders({ ...desktop, MAIL_OAUTH_ORIGIN: origin })).toEqual([]);
    expect(configuredOAuthProviders({ ...desktop, MAIL_OAUTH_ORIGIN: 'https://mailbox.example', LOCAL_MODE: '1' })).toEqual([]);
    expect(configuredOAuthProviders({
      ...desktop, MAIL_OAUTH_ORIGIN: 'https://mailbox.example',
      OUTLOOK_CLIENT_ID: 'web-id', OUTLOOK_CLIENT_SECRET: 'test-web-secret',
    })).toEqual(['outlook']);
  });

  it.each([
    { label: 'desktop', webId: undefined, webSecret: undefined, expectedId: desktopId },
    { label: 'existing Web client', webId: 'web-id', webSecret: 'test-web-secret', expectedId: 'web-id' },
  ])('refreshes a $label token using its original client configuration', async ({ webId, webSecret, expectedId }) => {
    const write = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const env = {
      MAIL_OAUTH_ORIGIN: origin, LOCAL_MODE: '1', OUTLOOK_DESKTOP_CLIENT_ID: desktopId,
      OUTLOOK_CLIENT_ID: webId, OUTLOOK_CLIENT_SECRET: webSecret,
      MAIL_ACCOUNT_KEY: Buffer.alloc(32, 23).toString('base64'),
      DB: { prepare: () => ({ bind: () => ({ run: write }) }) },
    } as unknown as Env;
    const fetchToken = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: 'new-access', expires_in: 3600 }));
    vi.stubGlobal('fetch', fetchToken);
    const address = 'sample@outlook.com';
    const credential = await sealCredential(env, address, JSON.stringify({
      accessToken: 'old-access', refreshToken: 'test-refresh', expiresAt: 0,
    }));

    expect(await oauthAccessToken(env, { id: 'account', provider: 'outlook', address, credential })).toBe('new-access');
    expect(fetchToken).toHaveBeenCalledOnce();
    const [url, init] = fetchToken.mock.calls[0];
    expect(url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      grant_type: 'refresh_token', refresh_token: 'test-refresh', client_id: expectedId,
      ...(webSecret ? { client_secret: webSecret } : {}),
    });
    expect(write).toHaveBeenCalledOnce();
  });
});
