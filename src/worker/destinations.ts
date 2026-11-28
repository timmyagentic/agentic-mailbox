import { HttpError } from './http';
import type { Env } from './types';

type Address = { email: string; verified: string | null };
type Envelope<T> = { success: boolean; result: T; result_info?: { total_pages?: number } };

function registryUnavailable() {
  return new HttpError(503, 'routing_registry_unavailable', '暂时无法查询目标邮箱，请联系站点管理员检查 Cloudflare 邮件路由配置。');
}

async function callRegistry<T>(env: Env, suffix: string, init: RequestInit = {}) {
  if (!env.ROUTING_ACCOUNT_ID || !env.ROUTING_API_TOKEN) throw registryUnavailable();
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.ROUTING_ACCOUNT_ID)}/email/routing/addresses`;
  const response = await fetch(base + suffix, { ...init, redirect: 'manual', headers: {
    Authorization: `Bearer ${env.ROUTING_API_TOKEN}`, 'Content-Type': 'application/json',
  } }).catch(() => { throw registryUnavailable(); });
  if (!response.ok) throw registryUnavailable();
  const payload = await response.json<Envelope<T>>().catch(() => { throw registryUnavailable(); });
  if (!payload.success) throw registryUnavailable();
  return payload;
}

// The Cloudflare list endpoint has no email filter. Only expose the state of the requested address.
async function findAddress(env: Env, target: string) {
  for (let page = 1; ; page++) {
    const response = await callRegistry<Address[]>(env, `?page=${page}&per_page=50`);
    const match = response.result.find(row => row.email.toLowerCase() === target);
    if (match) return match;
    if (page >= (response.result_info?.total_pages ?? 1)) return null;
  }
}

export async function ensureRoutingAddress(env: Env, target: string): Promise<boolean> {
  const existing = await findAddress(env, target);
  if (existing) return Boolean(existing.verified);
  try {
    const created = await callRegistry<Address>(env, '', { method: 'POST', body: JSON.stringify({ email: target }) });
    return created.result.email.toLowerCase() === target && Boolean(created.result.verified);
  } catch (error) {
    // Concurrent requests can both see an address before either has created it.
    const concurrent = await findAddress(env, target);
    if (concurrent) return Boolean(concurrent.verified);
    throw error;
  }
}
