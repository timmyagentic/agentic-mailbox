import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseSetup, type RelayEnv } from '../src/worker/relay/profile';
import { mailboxAuth, RelayFailure } from '../src/worker/relay/protocol';

const env = {} as RelayEnv;
const input = { address: 'relay@example.org', destination: 'target@example.net', password: 'fixture' };
afterEach(() => vi.unstubAllGlobals());
describe('self-hosted mail provider configuration', () => {
  it.each([
    ['gmail', 'gmail.com'],
    ['qq', 'qq.com'],
    ['163', '163.com'],
  ])('uses the fixed servers for %s', (provider, domain) => {
    const { profile, passwords } = parseSetup(
      { ...input, provider, imap: { host: 'ignored' }, smtpPassword: 'ignored' },
      env,
    );
    expect(profile.imap).toEqual({ host: 'imap.' + domain, port: 993, tls: 'implicit' });
    expect(profile.smtp).toEqual({ host: 'smtp.' + domain, port: 465, tls: 'implicit' });
    expect(profile.smtpUser).toBe(input.address);
    expect(passwords.smtpPassword).toBe(input.password);
  });
  it('accepts distinct custom credentials and requires TLS', () => {
    const server = { host: 'mx.example.org', port: 587, tls: 'starttls' };
    const data = {
      ...input,
      provider: 'custom',
      imap: { ...server, port: 993, tls: 'implicit' },
      smtp: server,
      smtpUser: 'smtp-user',
      smtpPassword: 'separate',
    };
    const { profile, passwords } = parseSetup(data, env);
    expect(profile.smtpUser).toBe('smtp-user');
    expect(passwords.smtpPassword).toBe('separate');
    expect(() => parseSetup({ ...data, smtp: { ...server, tls: 'none' } }, env)).toThrow();
    expect(() => parseSetup({ ...data, destination: input.address.toUpperCase() }, env)).toThrow();
  });
  it('refreshes a Google token for both mail protocols and surfaces revocation', async () => {
    const google = {
      GMAIL_CLIENT_ID: 'id',
      GMAIL_CLIENT_SECRET: 'secret',
      GMAIL_REFRESH_TOKEN: 'refresh',
    } as RelayEnv;
    expect(() => parseSetup({ ...input, provider: 'gmail', auth: 'google' }, env)).toThrow();
    const { profile, passwords } = parseSetup(
      { ...input, provider: 'gmail', auth: 'google', password: '' },
      google,
    );
    const fetchToken = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: 'test-access' }))
      .mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }, { status: 400 }));
    vi.stubGlobal('fetch', fetchToken);
    expect(await mailboxAuth(google, profile, passwords)).toEqual({ accessToken: 'test-access' });
    expect(fetchToken.mock.calls[0][1].body.get('refresh_token')).toBe('refresh');
    await expect(mailboxAuth(google, profile, passwords)).rejects.toEqual(new RelayFailure('oauth'));
  });
});
