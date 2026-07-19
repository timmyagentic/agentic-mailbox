import { describe, expect, it } from 'vitest';
import { ingestEmail } from '../src/worker/mail';
import type { AliasRow, EmailWorkerMessage, Env } from '../src/worker/types';

const RAW_EMAIL = [
  'From: GitHub <noreply@github.com>',
  'To: signup@emomo.net',
  'Message-ID: <verification-123@example.com>',
  'Date: Sun, 19 Jul 2026 08:00:00 +0000',
  'Subject: Verify your account',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="vault-boundary"',
  '',
  '--vault-boundary',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Your verification code is 123456.',
  '--vault-boundary',
  'Content-Type: text/plain; name="code.txt"',
  'Content-Disposition: attachment; filename="code.txt"',
  'Content-Transfer-Encoding: base64',
  '',
  'Y29kZT0xMjM0NTY=',
  '--vault-boundary--',
  '',
].join('\r\n');

class FakeStatement {
  params: unknown[] = [];

  constructor(readonly sql: string, private readonly alias: AliasRow | null) {}

  bind(...params: unknown[]) {
    this.params = params;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes('FROM aliases')) {
      return this.alias as T | null;
    }
    if (this.sql.includes('SELECT id FROM emails')) {
      return null;
    }
    return null;
  }
}

class FakeDatabase {
  statements: FakeStatement[] = [];
  batches: FakeStatement[][] = [];

  constructor(readonly alias: AliasRow | null) {}

  prepare(sql: string) {
    const statement = new FakeStatement(sql, this.alias);
    this.statements.push(statement);
    return statement;
  }

  async batch(statements: FakeStatement[]) {
    this.batches.push(statements);
    return [];
  }
}

class FakeBucket {
  objects = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array) {
    this.objects.set(key, value);
    return {};
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
  }
}

function makeAlias(): AliasRow {
  const now = new Date().toISOString();
  return {
    id: 'alias-1',
    local_part: 'signup',
    domain: 'emomo.net',
    address: 'signup@emomo.net',
    label: 'Signup',
    status: 'active',
    routing_mode: 'managed',
    note: '',
    created_at: now,
    updated_at: now,
    last_received_at: null,
    message_count: 0,
  };
}

function makeMessage() {
  let rejectReason = '';
  const forwarded: string[] = [];
  const bytes = new TextEncoder().encode(RAW_EMAIL);
  const message = {
    from: 'noreply@github.com',
    to: 'signup@emomo.net',
    headers: new Headers({
      subject: 'Verify your account',
      'message-id': '<verification-123@example.com>',
      date: 'Sun, 19 Jul 2026 08:00:00 +0000',
    }),
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    rawSize: bytes.byteLength,
    setReject(reason: string) {
      rejectReason = reason;
    },
    async forward(recipient: string) {
      forwarded.push(recipient);
      return { delivered: true };
    },
  } as unknown as EmailWorkerMessage;
  return { message, forwarded, getRejectReason: () => rejectReason };
}

function makeEnv(alias: AliasRow | null) {
  const database = new FakeDatabase(alias);
  const bucket = new FakeBucket();
  const env = {
    DB: database,
    ATTACHMENTS: bucket,
    PRIMARY_DOMAIN: 'emomo.net',
    FORWARD_TO: 'owner@example.com',
  } as unknown as Env;
  return { env, database, bucket };
}

describe('inbound email ingestion', () => {
  it('stores a parsed email and attachment, then forwards it', async () => {
    const { env, database, bucket } = makeEnv(makeAlias());
    const { message, forwarded, getRejectReason } = makeMessage();
    await ingestEmail(message, env);

    expect(getRejectReason()).toBe('');
    expect(bucket.objects.size).toBe(1);
    expect(database.batches).toHaveLength(1);
    expect(database.batches[0]).toHaveLength(3);
    expect(database.batches[0][0].params).toContain('Verify your account');
    expect(database.batches[0][0].params).toContain('Your verification code is 123456.');
    expect(forwarded).toEqual(['owner@example.com']);
  });

  it('rejects an address that is not registered', async () => {
    const { env, database, bucket } = makeEnv(null);
    const { message, getRejectReason } = makeMessage();
    await ingestEmail(message, env);

    expect(getRejectReason()).toBe('Mailbox is not registered or is disabled');
    expect(database.batches).toHaveLength(0);
    expect(bucket.objects.size).toBe(0);
  });
});
