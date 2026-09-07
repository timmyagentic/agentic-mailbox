import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PostalMime from 'postal-mime';
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

  constructor(readonly sql: string, private readonly alias: AliasRow | null, private readonly duplicate = false) {}

  bind(...params: unknown[]) {
    this.params = params;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes('FROM aliases')) {
      return this.alias as T | null;
    }
    if (this.sql.includes('SELECT id FROM emails')) {
      return this.duplicate ? { id: 'existing-email' } as T : null;
    }
    return null;
  }
}

class FakeDatabase {
  duplicate = false;
  statements: FakeStatement[] = [];
  batches: FakeStatement[][] = [];

  constructor(readonly alias: AliasRow | null) {}

  prepare(sql: string) {
    const statement = new FakeStatement(sql, this.alias, this.duplicate);
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


function diagnostics() {
  return [console.info, console.warn, console.error].flatMap((fn) => vi.mocked(fn).mock.calls).map(([line]) => JSON.parse(String(line)));
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const PRIVATE_ERROR = 'recipient=private@example.com code=654321 password=never-log-this';

describe('email diagnostics and failure semantics', () => {
  it('records successful ingestion and forwarding without MIME content', async () => {
    const { env } = makeEnv(makeAlias());
    await ingestEmail(makeMessage().message, env);
    expect(diagnostics()).toContainEqual(expect.objectContaining({ event: 'email_ingested', forwarding: 'succeeded', attachmentCount: 1, processingId: expect.any(String), durationMs: expect.any(Number) }));
    const output = JSON.stringify(diagnostics());
    for (const value of ['signup@emomo.net', 'noreply@github.com', 'Verify your account', '123456', 'code.txt', 'verification-123@example.com']) {
      expect(output).not.toContain(value);
    }
  });

  it('distinguishes domain and mailbox rejection without storing a message', async () => {
    const { env, database } = makeEnv(null);
    const { message } = makeMessage();
    await ingestEmail({ ...message, to: 'private@other.example' } as EmailWorkerMessage, env);
    await ingestEmail(makeMessage().message, env);
    expect(diagnostics().map((row) => row.reason)).toEqual(['unmanaged_domain', 'unregistered_or_disabled']);
    expect(database.batches).toHaveLength(0);
    expect(JSON.stringify(diagnostics())).not.toContain('private@other.example');
  });

  it('records duplicate skips without storing or forwarding again', async () => {
    const { env, database, bucket } = makeEnv(makeAlias());
    database.duplicate = true;
    const { message, forwarded } = makeMessage();
    await ingestEmail(message, env);
    expect(diagnostics()).toContainEqual(expect.objectContaining({ event: 'email_duplicate', aliasId: 'alias-1' }));
    expect(database.batches).toHaveLength(0);
    expect(bucket.objects.size).toBe(0);
    expect(forwarded).toHaveLength(0);
  });

  it('keeps stored mail accessible when forwarding fails and logs the partial failure safely', async () => {
    const { env, database, bucket } = makeEnv(makeAlias());
    const { message } = makeMessage();
    message.forward = vi.fn().mockRejectedValue(new Error(PRIVATE_ERROR));
    await ingestEmail(message, env);
    expect(database.batches).toHaveLength(1);
    expect(bucket.objects.size).toBe(1);
    expect(diagnostics()).toContainEqual(expect.objectContaining({ event: 'forward_failed', level: 'error' }));
    expect(diagnostics()).toContainEqual(expect.objectContaining({ event: 'email_ingested', forwarding: 'failed' }));
    expect(JSON.stringify(diagnostics())).not.toContain(PRIVATE_ERROR);
  });

  it('reports MIME failures by stage and prevents raw errors reaching platform logs', async () => {
    vi.spyOn(PostalMime, 'parse').mockRejectedValue(new Error(PRIVATE_ERROR));
    const { env, database } = makeEnv(makeAlias());
    await expect(ingestEmail(makeMessage().message, env)).rejects.toThrow(/^Email processing failed \([0-9a-f-]+\)$/);
    expect(diagnostics()).toContainEqual(expect.objectContaining({ event: 'email_ingest_failed', stage: 'parse' }));
    expect(JSON.stringify(diagnostics())).not.toContain(PRIVATE_ERROR);
    expect(database.batches).toHaveLength(0);
  });

  it('reports R2 failures without attempting database persistence', async () => {
    const { env, database, bucket } = makeEnv(makeAlias());
    vi.spyOn(bucket, 'put').mockRejectedValue(new Error(PRIVATE_ERROR));
    await expect(ingestEmail(makeMessage().message, env)).rejects.toThrow('Email processing failed');
    expect(diagnostics()).toContainEqual(expect.objectContaining({ event: 'email_ingest_failed', stage: 'attachments' }));
    expect(database.batches).toHaveLength(0);
    expect(JSON.stringify(diagnostics())).not.toContain(PRIVATE_ERROR);
  });

  it('cleans uploaded objects on database failure and preserves failure for retry', async () => {
    const { env, database, bucket } = makeEnv(makeAlias());
    vi.spyOn(database, 'batch').mockRejectedValue(new Error(PRIVATE_ERROR));
    const { message, forwarded } = makeMessage();
    await expect(ingestEmail(message, env)).rejects.toThrow('Email processing failed');
    expect(bucket.objects.size).toBe(0);
    expect(forwarded).toHaveLength(0);
    expect(diagnostics()).toContainEqual(expect.objectContaining({ event: 'email_ingest_failed', stage: 'database' }));
    expect(JSON.stringify(diagnostics())).not.toContain(PRIVATE_ERROR);
  });

  it('records cleanup failures separately from the original database failure', async () => {
    const { env, database, bucket } = makeEnv(makeAlias());
    vi.spyOn(database, 'batch').mockRejectedValue(new Error(PRIVATE_ERROR));
    vi.spyOn(bucket, 'delete').mockRejectedValue(new Error(PRIVATE_ERROR));
    await expect(ingestEmail(makeMessage().message, env)).rejects.toThrow('Email processing failed');
    expect(diagnostics()).toContainEqual(expect.objectContaining({ event: 'attachment_cleanup_failed', attachmentCount: 1 }));
    expect(diagnostics()).toContainEqual(expect.objectContaining({ event: 'email_ingest_failed', stage: 'database' }));
    expect(JSON.stringify(diagnostics())).not.toContain(PRIVATE_ERROR);
  });
});
