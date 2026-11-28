import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, Response as FixtureResponse } from 'miniflare';

const origin = 'https://mailbox.example';
const registered = new Set();
let providerVerified = false;
const temp = await mkdtemp(join(tmpdir(), 'mailbox-routing-'));
const runtime = new Miniflare({
  defaultPersistRoot: temp, unsafeTriggerHandlers: true,
  defaultProjectTmpPath: temp, email: { send_email: [{ name: 'EMAIL' }] },
  modules: true, scriptPath: '.wrangler/routing-test/entry.js',
  compatibilityDate: '2026-07-19', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { MEMBERS: { className: 'MemberMailbox', useSQLite: true } }, d1Databases: ['DB'],
  bindings: { PRIMARY_DOMAIN: 'mail.example', ADMIN_EMAIL: 'admin@example.net', ADMIN_PASSWORD: 'fixture-admin',
    SESSION_SECRET: 'isolated-fixture-session', FORWARD_TO: 'existing@example.net', ROUTING_ACCOUNT_ID: 'test', ROUTING_API_TOKEN: 'fixture' },
  outboundService: async request => {
    assert.equal(new URL(request.url).hostname, 'api.cloudflare.com');
    if (request.method === 'POST') {
      const { email } = await request.json();
      registered.add(email);
      return FixtureResponse.json({ success: true, result: { email, verified: null } });
    }
    return FixtureResponse.json({ success: true, result: [...registered].map(email => ({ email, verified: providerVerified ? '2026-01-01' : null })) });
  },
});
async function api(path, cookie = '', method = 'GET', body) {
  return runtime.dispatchFetch(origin + path, { method,
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function signIn(path, body) {
  const response = await api(path, '', 'POST', body);
  assert.equal(response.status, 200, await response.text());
  return response.headers.get('Set-Cookie').split(';')[0];
}
try {
  const db = await runtime.getD1Database('DB');
  for (const file of (await readdir('migrations')).sort()) {
    // workerd's D1 exec splits on line breaks; using a single line also preserves multiline statements.
    const sql = (await readFile('migrations/' + file, 'utf8')).replace(/^--.*$/gm, '').replaceAll('\n', ' ');
    await db.exec(sql);
  }
  const alice = await signIn('/api/members/register', { username: 'alice', password: 'member-fixture-password' });
  const bob = await signIn('/api/members/register', { username: 'bob', password: 'member-fixture-password' });
  const admin = await signIn('/api/session', { password: 'fixture-admin' });
  await signIn('/api/members/login', { username: 'alice', password: 'member-fixture-password' });
  const settings = async cookie => {
    const response = await api('/api/forwarding', cookie);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const a = await settings(alice);
  assert.equal(a.destination, null);
  assert.notEqual(a.relay, (await settings(bob)).relay);
  assert.equal(a.relay, (await settings(alice.replace('agentic_mailbox_session', 'mailbox_vault_session'))).relay);
  const operator = await settings(admin);
  assert.equal(operator.destination, 'existing@example.net');
  assert.equal(operator.senderAddress, operator.relay);
  await db.prepare('UPDATE forwarding_settings SET sender_address = ? WHERE owner = ?').bind('hello@sender.example.net', 'admin').run();
  assert.equal((await settings(admin)).senderAddress, 'hello@sender.example.net');
  assert.equal((await settings(alice)).senderAddress, a.relay);
  assert.equal((await api('/api/forwarding', alice.replace('member:alice:', 'member:bob:'))).status, 401);
  assert.equal((await api('/api/forwarding')).status, 401);
  const target = 'new@example.net';
  const pending = await api('/api/forwarding/destination', alice, 'PUT', { address: target, owner: 'admin' });
  assert.equal(pending.status, 200, await pending.clone().text());
  assert.equal((await pending.json()).step, 'provider');
  assert.equal((await settings(bob)).pending, null);
  assert.equal((await settings(admin)).pending, null);
  assert.equal((await api('/api/aliases', alice)).status, 403);
  assert.deepEqual(await (await api('/api/forwarding/sources', alice)).json(), { sources: [] });
  providerVerified = true;
  const sent = await api('/api/forwarding/verify', alice, 'POST', { address: target });
  assert.equal(sent.status, 200, await sent.clone().text());
  assert.equal((await sent.json()).step, 'code');
  const savedText = (await readdir(temp, { recursive: true })).find(path => path.endsWith('.txt'));
  assert.ok(savedText, 'isolated confirmation mail was written');
  const code = (await readFile(join(temp, savedText), 'utf8')).match(/[0-9A-F]{12}/)[0];
  assert.equal((await api('/api/forwarding/confirm', bob, 'POST', { code })).status, 400);
  assert.equal((await api('/api/forwarding/confirm', alice, 'POST', { code })).status, 200);
  assert.equal((await settings(alice)).destination, target);
  const senderChange = await api('/api/forwarding/sender', alice, 'PUT', { name: 'Relay Assistant', owner: 'admin', senderAddress: 'hello@sender.example.net' });
  assert.equal(senderChange.status, 200, await senderChange.clone().text());
  const updatedSender = await senderChange.json();
  assert.equal(updatedSender.senderName, 'Relay Assistant');
  assert.equal(updatedSender.senderAddress, a.relay);
  assert.equal((await settings(bob)).senderName, null);
  assert.equal((await settings(admin)).senderName, null);
  const envelope = new URL('/cdn-cgi/handler/email', origin);
  envelope.searchParams.set('from', 'sender@example.net');
  envelope.searchParams.set('to', a.relay);
  const eml = ['From: sender@example.net', 'To: ' + a.relay, 'Subject: Fixture', 'Message-ID: <local@example.net>',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=fixture', '', '--fixture',
    'Content-Type: text/plain', '', 'Hello from the source mailbox.', '--fixture',
    'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename="sample.bin"',
    'Content-Transfer-Encoding: base64', '', 'AAECA/8=', '--fixture--', ''].join('\r\n');
  const delivery = await runtime.dispatchFetch(envelope.toString(), { method: 'POST', body: eml });
  assert.equal(delivery.status, 200, await delivery.text());
  const artifacts = await readdir(temp, { recursive: true });
  const textParts = artifacts.filter(path => path.endsWith('.txt') && path !== savedText);
  assert.ok((await Promise.all(textParts.map(path => readFile(join(temp, path), 'utf8')))).some(text => text.includes('Hello from the source mailbox.')));
  const attachment = artifacts.find(path => path.endsWith('.bin') && path.includes('email-attachment'));
  assert.ok(attachment, 'relay message includes the original attachment');
  assert.deepEqual(await readFile(join(temp, attachment)), Buffer.from([0, 1, 2, 3, 255]));
  envelope.searchParams.set('to', 'unknown@mail.example');
  assert.equal((await runtime.dispatchFetch(envelope.toString(), { method: 'POST', body: eml })).status, 400);
  assert.equal((await db.prepare('SELECT count(*) AS count FROM emails').first()).count, 0);
  assert.equal((await api('/api/drafts', admin)).status, 404);
  assert.equal((await api('/downloads/agentic-mailbox-mac-arm64.zip')).status, 410);
  assert.equal((await api('/api/session', alice, 'DELETE')).status, 200);
  console.log('Verified migration, hosted identities, durable relay addresses, pending destination isolation, confirmed cutover, relay sender identity, multipart body and attachment bytes, protected APIs and retired downloads.');
} finally {
  await runtime.dispose();
  await rm(temp, { recursive: true, force: true });
}
