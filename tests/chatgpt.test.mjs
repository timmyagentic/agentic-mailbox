import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createChatGPTService } from '../scripts/chatgpt-local.mjs';

const issuer = 'https://auth.openai.com';
const issued = 'oaiapp_mailboxtest';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256' };
let directory, key, service, nonce, challenge, subject, plan, sentDraft, refreshes;
const request = (action, body) => service(new Request('https://internal/' + action, body ? {
  method: 'POST', body: JSON.stringify(body),
} : {}));
async function upstream(url, init) {
  const path = new URL(url instanceof Request ? url.url : url).pathname;
  if (path === '/.well-known/openid-configuration') return Response.json({
    issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
    jwks_uri: issuer + '/keys', revocation_endpoint: issuer + '/revoke',
  });
  if (path === '/keys') return Response.json({ keys: [jwk] });
  if (path === '/token') {
    const form = new URLSearchParams(init.body);
    expect(form.get('client_id')).toBe(issued);
    expect(form.has('client_secret')).toBe(false);
    if (form.get('grant_type') === 'refresh_token') {
      refreshes++;
      return Response.json({ access_token: 'renewed-access', refresh_token: 'second-refresh', expires_in: 3600 });
    }
    expect(createHash('sha256').update(form.get('code_verifier')).digest('base64url')).toBe(challenge);
    const id_token = await new SignJWT({ nonce, email_verified: true, email: 'owner@example.test' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setSubject(subject).setIssuer(issuer)
      .setAudience(issued).setIssuedAt().setExpirationTime('5m').sign(privateKey);
    return Response.json({ id_token, access_token: 'issued-test-access', refresh_token: 'first-refresh',
      scope: plan ? 'openid chatgpt.tokens.use.direct' : 'openid', expires_in: 1 });
  }
  if (path === '/v1/models') return Response.json({ models: [{ visibility: 'list', slug: 'fixture-model' }] });
  if (path === '/v1/responses') {
    const payload = JSON.parse(init.body);
    expect(payload.store).toBe(false);
    expect(payload.stream).toBe(true);
    expect(payload.model).toBe('fixture-model');
    sentDraft = true;
    return new Response('data: {"type":"response.output_text.delta","delta":"Fixture draft"}\n\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (path === '/revoke') return new Response(null, { status: 200 });
  throw new Error('Unexpected upstream request');
}
const create = () => createChatGPTService({ directory, origin: 'http://127.0.0.1:8787', encryptionKey: key, fetchImpl: upstream });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mailbox-chatgpt-test-'));
  key = randomBytes(32).toString('base64');
  subject = 'owner'; plan = true; sentDraft = false; refreshes = 0; service = create();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

async function begin(linking = true) {
  const params = { browser: 'fixture-browser', session: linking ? 'existing-session' : null, linking };
  const res = await request('start', params);
  expect(res.status).toBe(200);
  const url = new URL((await res.json()).url);
  nonce = url.searchParams.get('nonce');
  challenge = url.searchParams.get('code_challenge');
  expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8787/auth/callback');
  return { url, body: { ...params, state: url.searchParams.get('state'), clientId: issued, code: 'test-code' } };
}

it('requires existing owner access to bind, verifies the identity and only drafts on request', async () => {
  expect((await request('start', { browser: 'unknown', linking: false })).status).toBe(403);
  const first = await begin();
  expect(first.url.searchParams.get('client_id')).toBe('dynamic_agent_client');
  expect((await request('finish', { ...first.body, browser: 'different' })).status).toBe(400);
  expect((await request('finish', { ...first.body, session: null })).status).toBe(400);
  expect((await request('finish', first.body)).status).toBe(200);
  expect((await request('finish', first.body)).status).toBe(400);
  expect(sentDraft).toBe(false);
  expect(readFileSync(join(directory,'chatgpt-account.enc'),'utf8')).not.toContain('first-refresh');
  service = create();
  const returning = await begin(false);
  expect(returning.url.searchParams.get('client_id')).toBe(issued);
  expect(returning.url.searchParams.get('ext_agent_host_id')).toBe(first.url.searchParams.get('ext_agent_host_id'));
  expect((await request('finish', returning.body)).status).toBe(200);
  expect(await (await request('draft', { instructions: 'Write a draft', input: 'Fixture' })).json()).toEqual({ text: 'Fixture draft' });
  expect(refreshes).toBe(1);
  expect(sentDraft).toBe(true);
  expect(await (await request('disconnect', {})).json()).toEqual({ revoked: true });
  expect((await (await request('status')).json()).linked).toBe(false);
  expect((await request('draft', {})).status).toBe(403);
});

it('enforces nonce, account binding and independent inference consent', async () => {
  const invalid = await begin();
  nonce = 'different';
  expect((await request('finish', invalid.body)).status).toBe(403);
  expect((await (await request('status')).json()).linked).toBe(false);
  plan = false;
  const valid = await begin();
  expect((await request('finish', valid.body)).status).toBe(200);
  expect((await request('draft', {})).status).toBe(403);
  const mismatch = await begin(false);
  subject = 'different-user';
  expect((await request('finish', mismatch.body)).status).toBe(403);
  expect((await (await request('status')).json()).linked).toBe(true);
});
