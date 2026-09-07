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
