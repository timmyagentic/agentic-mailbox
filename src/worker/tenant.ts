import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import schema from '../../migrations/0001_initial.sql';
import imap from '../../migrations/0002_imap_accounts.sql';
import drafts from '../../migrations/0003_conversations_and_drafts.sql';
import oauth from '../../migrations/0004_oauth_accounts.sql';
import { handleApi } from './api';
import { sessionCookie } from './auth';
import { apiError, HttpError, json } from './http';
import { memberSecret, memberSession } from './members';
import type { MailDatabase, MailStatement } from './storage-types';
import type { Env } from './types';

class Statement implements MailStatement {
  constructor(private sql: SqlStorage, private query: string, private params: SqlStorageValue[] = []) {}
  bind(...params: SqlStorageValue[]) { return new Statement(this.sql, this.query, params); }
  execute<T>() {
    const cursor = this.sql.exec(this.query, ...this.params);
    const results = cursor.toArray() as T[];
    // rowsWritten counts index updates too. Existing callers only test zero versus nonzero,
    // but changes() is required for conditional UPDATE/INSERT semantics.
    const changes = this.sql.exec<{ n: number }>('SELECT changes() AS n').one().n;
    return { results, meta: { changes } };
  }
  async first<T>(column?: string) {
    const row = this.sql.exec(this.query, ...this.params).toArray()[0];
    return (row ? column ? row[column] : row : null) as T | null;
  }
  async all<T>() { return this.execute<T>(); }
  async run<T>() { return this.execute<T>(); }
}

function database(storage: DurableObjectStorage): MailDatabase {
  return {
    prepare(query) { return new Statement(storage.sql, query); },
    async batch<T>(statements: MailStatement[]) {
      return storage.transactionSync(() => statements.map(statement => {
        if (!(statement instanceof Statement)) throw new Error('Incompatible statement');
        return statement.execute<T>();
      }));
    },
  };
}

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
      const username = request.headers.get('X-Vault-User') ?? '';
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
      if (!storage.kv.get('mail-schema')) {
        storage.transactionSync(() => {
          for (const migration of [schema, imap, drafts, oauth]) {
            storage.sql.exec(migration.replace('PRAGMA foreign_keys = ON;', ''));
          }
          storage.kv.put('mail-schema', 1);
        });
      }
      const bucket = this.bindings.ATTACHMENTS;
      const prefix = 'members/' + this.ctx.id.toString() + '/';
      const scoped: Env = { ...this.bindings, DB: database(storage), ATTACHMENTS: {
        get: key => bucket.get(prefix + key),
        put: (key, value, options) => bucket.put(prefix + key, value, options),
        delete: keys => bucket.delete(typeof keys === 'string' ? prefix + keys : keys.map(key => prefix + key)),
      }, EXTERNAL_ONLY: true, MEMBERS: undefined, ADMIN_EMAIL: username, ADMIN_PASSWORD: '',
        ADMIN_CERT_FINGERPRINTS: undefined, SESSION_SECRET: memberSecret(this.bindings), EMAIL: undefined,
        PRIMARY_DOMAIN: '', FORWARD_TO: undefined };
      return await handleApi(request, scoped);
    } catch (error) {
      return apiError(error, crypto.randomUUID());
    }
  }
}
