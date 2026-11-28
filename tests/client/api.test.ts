import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/client/api';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('API error diagnostics', () => {
  it('preserves the server request ID for support', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'internal_error', message: '服务暂时不可用。', requestId: 'request-123' } }), { status: 500, headers: { 'content-type': 'application/json' } })));
    await expect(api('/api/forwarding')).rejects.toMatchObject({ status: 500, code: 'internal_error', requestId: 'request-123', message: expect.stringContaining('request-123') });
  });

  it('shows an actionable message for network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api('/api/session')).rejects.toMatchObject({ code: 'network_error', message: expect.stringContaining('网络') });
  });

  it('rejects successful HTML fallback responses instead of treating them as data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Fallback</html>', { headers: { 'content-type': 'text/html' } })));
    await expect(api('/api/session')).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
