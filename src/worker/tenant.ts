import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { legacySourcesQuery } from './sources';
import { sessionCookie } from './auth';
import { apiError, HttpError, json } from './http';
import { memberSession } from './members';
import type { Env } from './types';

async function passwordDigest(value: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(value), 'PBKDF2', false, ['deriveBits']);
  return Buffer.from(await crypto.subtle.deriveBits({
    name: 'PBKDF2', salt: Buffer.from(salt, 'base64'), hash: 'SHA-256', iterations: 100_000,
  }, key, 256));
}

export class MemberMailbox {
  constructor(private ctx: DurableObjectState, private bindings: Env) {}
  async fetch(request: Request): Promise<Response> {
    try {
      const username = request.headers.get('X-Agentic-Mailbox-User') ?? '';
      if (this.bindings.MEMBERS?.idFromName(username).toString() !== this.ctx.id.toString()) throw new Error('Tenant mismatch');
      const path = new URL(request.url).pathname;
      const storage = this.ctx.storage;
      if (path === '/api/members/register' || path === '/api/members/login') {
        const { password } = await request.json<{ password: string }>();
        const register = path.endsWith('/register');
        const stored = await storage.get<{ salt: string; digest: string }>('identity');
        const salt = stored?.salt ?? Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
        const hash = await passwordDigest(password, salt);
        if (register) {
          await storage.transaction(async txn => {
            if (await txn.get('identity')) throw new HttpError(409, 'username_taken', '该用户名已被使用。');
            await txn.put('identity', { salt, digest: hash.toString('base64') });
          });
        } else if (!stored || !timingSafeEqual(hash, Buffer.from(stored.digest, 'base64'))) {
          throw new HttpError(401, 'invalid_credentials', '用户名或密码不正确。');
        }
        return json({ authenticated: true, user: { email: username }, edition: 'hosted' }, 200,
          { 'Set-Cookie': sessionCookie(await memberSession(this.bindings, username), request.url) });
      }
      if (path === '/sources' && request.method === 'GET') {
        const sources = storage.kv.get('mail-schema') ? storage.sql.exec(legacySourcesQuery).toArray() : [];
        return json({ sources });
      }
      throw new HttpError(404, 'not_found', '找不到此接口。');
    } catch (error) {
      return apiError(error, crypto.randomUUID());
    }
  }
}
