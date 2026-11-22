import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import type { Env } from '../src/worker/types';

const env = {
  ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-only-password', SESSION_SECRET: 'test-only-session-secret',
  DB: { prepare: () => ({ first: async () => ({ value: 1 }) }) },
  ASSETS: { fetch: async () => new Response('asset') },
} as unknown as Env;
const secret = 'private@example.com password=do-not-log code=654321';

function logs() {
  return [console.info, console.warn, console.error].flatMap((fn) => vi.mocked(fn).mock.calls).map(([line]) => JSON.parse(String(line)));
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('request diagnostics', () => {
  it('correlates rejected login with a safe record and response header', async () => {
    const response = await worker.fetch(new Request('https://vault.example/api/session?q='+encodeURIComponent(secret), {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-ray': secret }, body: JSON.stringify({ password: secret }),
    }), env);
    const payload = await response.json() as { error: { requestId: string } };
    expect(response.status).toBe(401);
    expect(response.headers.get('x-request-id')).toBe(payload.error.requestId);
    expect(logs()).toContainEqual(expect.objectContaining({ event: 'http_request', route: '/api/session', method: 'POST', status: 401, code: 'invalid_credentials', requestId: payload.error.requestId }));
    expect(JSON.stringify(logs())).not.toContain(secret);
    expect(payload.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('records returned dependency failures as well as thrown failures', async () => {
    const broken = { ...env, DB: { prepare: () => { throw new Error(secret); } } } as unknown as Env;
    const response = await worker.fetch(new Request('https://vault.example/api/health'), broken);
    expect(response.status).toBe(503);
    expect(logs()).toContainEqual(expect.objectContaining({ event: 'http_request', route: '/api/health', status: 503, level: 'error', durationMs: expect.any(Number) }));
    expect(JSON.stringify(logs())).not.toContain(secret);
  });

  it('never writes raw exception text or untrusted paths to logs', async () => {
    const broken = { ...env, ASSETS: { fetch: async () => { throw new Error(secret); } } } as unknown as Env;
    const response = await worker.fetch(new Request('https://vault.example/'+encodeURIComponent(secret)), broken);
    expect(response.status).toBe(500);
    expect(logs()).toContainEqual(expect.objectContaining({ event: 'http_request', route: 'asset', status: 500, code: 'internal_error' }));
    expect(JSON.stringify(logs())).not.toContain(secret);
    expect(JSON.stringify(logs())).not.toContain(encodeURIComponent(secret));
  });

  it('records successful requests without logging cookies or response data', async () => {
    const response = await worker.fetch(new Request('https://vault.example/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeTruthy();
    expect(logs()).toHaveLength(1);
    expect(logs()[0]).toMatchObject({ event: 'http_request', route: '/api/session', status: 200, level: 'info' });
    expect(JSON.stringify(logs())).not.toContain(env.ADMIN_PASSWORD);
    expect(JSON.stringify(logs())).not.toContain(env.ADMIN_EMAIL);
  });
});

const allowedFingerprint = 'a2'.repeat(32);
const otherFingerprint = 'b6'.repeat(32);
const certificateEnv = { ...env, ADMIN_CERT_FINGERPRINTS: `${allowedFingerprint}, ${otherFingerprint}` };
const verifiedCertificate = {
  certPresented: '1', certVerified: 'SUCCESS', certRevoked: '0',
  certFingerprintSHA256: allowedFingerprint.match(/../g)?.join(':').toUpperCase(),
};

function certificateRequest(
  path: string,
  init: RequestInit,
  certificate?: { certPresented: string; certVerified: string; certRevoked: string; certFingerprintSHA256?: string },
  base = 'https://vault.example',
) {
  const request = new Request(base + path, init);
  if (certificate) Object.defineProperty(request, 'cf', { value: { tlsClientAuth: certificate } });
  return request;
}

describe('administrator certificate login', () => {
  const loginPath = '/api/session/certificate';
  const jsonLogin = {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://vault.example' }, body: '{}',
  };

  it('issues a secure session and binds protected requests to the original device certificate', async () => {
    const login = await worker.fetch(certificateRequest(loginPath, jsonLogin, verifiedCertificate), certificateEnv);
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly; SameSite=Strict; Max-Age=86400; Secure/);
    const headers = { cookie: setCookie.split(';')[0] };

    const protectedPath = '/api/aliases';
    const dataEnv = {
      ...certificateEnv,
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
    } as unknown as Env;
    expect((await worker.fetch(certificateRequest(protectedPath, { headers }, verifiedCertificate), dataEnv)).status).toBe(200);
    expect((await worker.fetch(certificateRequest(protectedPath, { headers }), dataEnv)).status).toBe(401);
    expect((await worker.fetch(certificateRequest(protectedPath, { headers }, {
      ...verifiedCertificate, certFingerprintSHA256: otherFingerprint,
    }), dataEnv)).status).toBe(401);
    expect((await worker.fetch(certificateRequest(protectedPath, { headers }, {
      ...verifiedCertificate, certRevoked: '1',
    }), dataEnv)).status).toBe(401);
    expect((await worker.fetch(certificateRequest(protectedPath, { headers }, verifiedCertificate), {
      ...dataEnv, ADMIN_CERT_FINGERPRINTS: otherFingerprint,
    })).status).toBe(401);
    expect(JSON.stringify(logs())).not.toContain(allowedFingerprint);
  });

  it('rejects absent, revoked, unverified and unregistered device certificates and ignores forged headers', async () => {
    for (const certificate of [
      undefined, { ...verifiedCertificate, certPresented: '0' },
      { ...verifiedCertificate, certVerified: 'FAILED' }, { ...verifiedCertificate, certRevoked: '1' },
      { ...verifiedCertificate, certFingerprintSHA256: 'c3'.repeat(32) },
    ]) {
      const response = await worker.fetch(certificateRequest(loginPath, jsonLogin, certificate), certificateEnv);
      expect(response.status).toBe(403);
      expect(response.headers.has('set-cookie')).toBe(false);
    }
    const fakeHeaders = { ...jsonLogin.headers, 'cf-cert-verified': 'SUCCESS', 'client-cert': allowedFingerprint };
    const spoof = await worker.fetch(certificateRequest(loginPath, { ...jsonLogin, headers: fakeHeaders }), certificateEnv);
    expect(spoof.status).toBe(403);
    expect(spoof.headers.has('set-cookie')).toBe(false);
  });

  it('enforces same-origin JSON on HTTPS and leaves the password session usable', async () => {
    const wrongOrigin = certificateRequest(loginPath, {
      ...jsonLogin, headers: { ...jsonLogin.headers, origin: 'https://other.example' },
    }, verifiedCertificate);
    expect((await worker.fetch(wrongOrigin, certificateEnv)).status).toBe(403);
    const notJson = certificateRequest(loginPath, { ...jsonLogin, headers: {} }, verifiedCertificate);
    expect((await worker.fetch(notJson, certificateEnv)).status).toBe(415);
    const http = certificateRequest(loginPath, {
      ...jsonLogin, headers: { ...jsonLogin.headers, origin: 'http://vault.example' },
    }, verifiedCertificate, 'http://vault.example');
    expect((await worker.fetch(http, certificateEnv)).status).toBe(400);
    expect((await worker.fetch(certificateRequest(loginPath, jsonLogin, verifiedCertificate), env)).status).toBe(503);

    const passwordLogin = await worker.fetch(certificateRequest('/api/session', {
      ...jsonLogin, body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    }), certificateEnv);
    expect(passwordLogin.status).toBe(200);
    const cookie = passwordLogin.headers.get('set-cookie')?.split(';')[0] ?? '';
    const passwordSession = await worker.fetch(certificateRequest('/api/session', { headers: { cookie } }), certificateEnv);
    await expect(passwordSession.json()).resolves.toMatchObject({ authenticated: true });
  });
});
