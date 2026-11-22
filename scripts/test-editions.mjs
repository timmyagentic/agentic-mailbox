import assert from 'node:assert/strict';
import { Miniflare, Response as FixtureResponse } from 'miniflare';

const origin = 'https://mailbox.example';
const completionCalls = [];
const runtime = new Miniflare({
  modules: true, scriptPath: '.wrangler/local-worker/entry.js',
  modulesRules: [{ type: 'Text', include: ['**/*.sql'], fallthrough: true }],
  compatibilityDate: '2026-07-19', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { MEMBERS: { className: 'MemberMailbox', useSQLite: true } },
  d1Databases: ['DB'], r2Buckets: ['ATTACHMENTS'],
  outboundService: async req => {
    const url = new URL(req.url);
    if (url.hostname === 'redirected.example') {
      completionCalls.push({ path: 'unexpected_redirect' });
      return new FixtureResponse(null, { status: 500 });
    }
    if (url.hostname === 'compatible.example') {
      completionCalls.push({
        path: url.pathname, method: req.method, authorized: req.headers.get('Authorization') === 'Bearer fixture-ai-key',
        body: await req.json(),
      });
      if (JSON.parse(completionCalls.at(-1).body.messages[1].content).instruction === 'Fixture redirect') {
        return new FixtureResponse(null, { status: 307, headers: { Location: 'https://redirected.example' } });
      }
      return FixtureResponse.json({ choices: [{ message: { content: 'Thanks for the update.' } }] });
    }
    if (url.hostname === 'oauth2.googleapis.com') return FixtureResponse.json({
      access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 });
    assert.equal(req.headers.get('Authorization'), 'Bearer test-access');
    if (url.hostname === 'openidconnect.googleapis.com') return FixtureResponse.json({
      sub: 'fixture-id', email: 'owner@gmail.com', email_verified: true });
    assert.equal(url.hostname, 'gmail.googleapis.com');
    if (url.pathname.endsWith('/profile')) return FixtureResponse.json({ historyId: '101' });
    if (url.pathname.endsWith('/messages')) return FixtureResponse.json({ messages: [{ id: 'private-message' }] });
    const raw = ['From: sender@example.com', 'To: owner@gmail.com', 'Subject: member-only',
      'Message-ID: <private@example.com>', 'Content-Type: multipart/mixed; boundary=part', '',
      '--part', 'Content-Type: text/plain', '', 'private body', '--part', 'Content-Type: text/plain',
      'Content-Disposition: attachment; filename="sample.txt"', '', 'member file', '--part--', ''].join('\r\n');
    return FixtureResponse.json({ internalDate: String(Date.now()), labelIds: ['INBOX'], threadId: 'thread',
      raw: Buffer.from(raw).toString('base64url') });
  },
  bindings: { MAIL_OAUTH_ORIGIN: origin, GMAIL_CLIENT_ID: 'test-google', GMAIL_CLIENT_SECRET: 'test-client',
    OPENAI_API_KEY: 'fixture-ai-key', OPENAI_BASE_URL: 'https://compatible.example/v1/', OPENAI_MODEL: 'fixture-draft-model',
    ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'owner-test-password',
    PRIMARY_DOMAIN: 'example.com', SESSION_SECRET: 'integration-test-session', MAIL_ACCOUNT_KEY: Buffer.alloc(32, 42).toString('base64') },
});
async function request(path, cookie, data, method = data === undefined ? 'GET' : 'POST', extra = {}) {
  return runtime.dispatchFetch(origin + path, { method, headers: {
    Origin: origin, Cookie: cookie ?? '', 'Content-Type': 'application/json', ...extra,
  }, body: data === undefined ? undefined : JSON.stringify(data) });
}
async function identity(username, register) {
  const response = await request('/api/members/' + (register ? 'register' : 'login'), '', { username, password: 'fixture-secret-password' });
  assert.equal(response.status, 200, await response.text());
  return response.headers.get('Set-Cookie').split(';')[0];
}
try {
  await runtime.ready;
  const a = await identity('member-a', true);
  const b = await identity('member-b', true);
  const idA = await identity('member-a', false);
  const mobileClient = { 'X-Agentic-Mailbox-Client': 'mobile' };
  const mobileLogin = await request('/api/members/login', '', {
    username: 'member-a', password: 'fixture-secret-password',
  }, 'POST', mobileClient);
  const mobileSession = await mobileLogin.json();
  assert.match(mobileSession.sessionToken, /^member:member-a:/);
  assert.equal(mobileLogin.headers.get('Set-Cookie'), null);
  const mobile = { ...mobileClient, Authorization: 'Bearer ' + mobileSession.sessionToken };
  assert.equal((await (await request('/api/session', b, undefined, 'GET', mobile)).json()).user.email, 'member-a');
  assert.equal((await (await request('/api/session', a, undefined, 'GET', mobileClient)).json()).authenticated, false);
  const adminLogin = await request('/api/session', '', {password:'owner-test-password'}, 'POST', mobileClient);
  const adminSession = await adminLogin.json();
  assert.equal(adminSession.authenticated, true);
  const admin = { ...mobileClient, Authorization: 'Bearer ' + adminSession.sessionToken };
  assert.equal((await (await request('/api/session', '', undefined, 'GET', admin)).json()).user.email, 'owner@example.com');
  const webLogin = await request('/api/members/login', '', {username:'member-b',password:'fixture-secret-password'});
  assert.ok(webLogin.headers.get('Set-Cookie'));
  assert.equal((await webLogin.json()).sessionToken, undefined);
  assert.match(idA, /^agentic_mailbox_session=/);
  const legacy = idA.replace(/^agentic_mailbox_session=/, 'mailbox_vault_session=');
  assert.equal((await request('/api/session', legacy)).status, 200);
  assert.equal((await (await request('/api/session', legacy)).json()).authenticated, true);
  const logout = await request('/api/session', legacy, undefined, 'DELETE');
  assert.equal(logout.status, 200);
  for (const name of ['agentic_mailbox_session', 'mailbox_vault_session']) {
    assert.match(logout.headers.get('Set-Cookie'), new RegExp(name + '=;[^,]*Max-Age=0'));
  }
  assert.equal((await request('/api/members/register', '', { username: 'member-a', password: 'another-user-password' })).status, 409);
  assert.equal((await request('/api/members/login', '', { username: 'member-a', password: 'another-user-password' })).status, 401);
  assert.equal((await request('/api/bootstrap', a.replace('member-a', 'member-b'))).status, 401);
  const body = { email: 'same@qq.com', authorizationCode: 'abcdefghijklmnop' };
  const add = async cookie => {
    const resp = await request('/api/mail-accounts', cookie, body);
    const out = await resp.json();
    assert.equal(resp.status, 200, JSON.stringify(out));
    return out.account.id;
  };
  const aId = await add(a);
  const bId = await add(b);
  assert.notEqual(aId, bId);
  const home = await request('/api/bootstrap', idA, undefined, 'GET', { 'X-Agentic-Mailbox-User': 'member-b' });
  const bootstrap = await home.json();
  assert.equal(home.status, 200, JSON.stringify(bootstrap));
  assert.deepEqual(bootstrap.mailAccounts.map(account => account.id), [aId]);
  assert.equal(bootstrap.externalOnly, true);
  assert.equal(bootstrap.aiAvailable, true);
  assert.equal(JSON.stringify(bootstrap).includes('fixture-ai-key'), false);
  assert.equal((await request('/api/mail-accounts/' + aId + '/refresh', b, {})).status, 404);
  assert.equal((await request('/api/aliases', b, { localPart: 'forbidden' })).status, 403);
  const draft = await (await request('/api/drafts', a, { aliasId: aId, to: 'test@example.com', bodyText: 'private' })).json();
  assert.ok(draft.draft?.id, JSON.stringify(draft));
  const path = '/api/drafts/' + draft.draft.id;
  assert.equal((await request(path + '/suggest', b, { instruction: 'Write a brief reply.' })).status, 404);
  const generated = await request(path + '/suggest', a, { instruction: 'Write a brief reply.' });
  assert.equal(generated.status, 200, JSON.stringify(completionCalls));
  assert.equal(completionCalls.length, 1);
  const [{ path: endpoint, method, authorized, body: completion }] = completionCalls;
  assert.deepEqual({ endpoint, method, authorized }, { endpoint: '/v1/chat/completions', method: 'POST', authorized: true });
  assert.equal(completion.model, 'fixture-draft-model');
  assert.equal(completion.max_tokens, 650);
  assert.equal(JSON.parse(completion.messages[1].content).instruction, 'Write a brief reply.');
  assert.equal((await generated.json()).text, 'Thanks for the update.');
  const redirect = await request(path + '/suggest', a, { instruction: 'Fixture redirect' });
  assert.equal(redirect.status, 502);
  assert.equal(completionCalls.length, 2);
  assert.equal(completionCalls[1].path, '/v1/chat/completions');
  assert.equal((await (await request(path, a)).json()).draft.bodyText, 'private');
  assert.equal((await request(path, b)).status, 404);
  assert.equal((await request(path + '/send', b, {})).status, 404);
  assert.equal((await request(path, b, undefined, 'DELETE')).status, 409);
  assert.equal((await request('/api/drafts', b, { aliasId: aId })).status, 400);
  const up = await runtime.dispatchFetch(origin + path + '/files?name=private.txt', { method: 'POST',
    headers: { Cookie: a, Origin: origin, 'Content-Type': 'text/plain' }, body: 'private attachment' });
  assert.equal(up.status, 201, await up.text());
  assert.equal((await request(path + '/files?name=other', b, {})).status, 404);
  const bucket = await runtime.getR2Bucket('ATTACHMENTS');
  assert.match((await bucket.list()).objects[0].key, /^members\/[a-f0-9]+\/drafts\//);
  assert.equal((await (await request('/api/drafts', b)).json()).drafts.length, 0);
  assert.equal((await (await request(path, a)).json()).draft.files.length, 1);
  const mobileStart = await request('/api/oauth/gmail/start', '', {}, 'POST', mobile);
  const nativeState = new URL((await mobileStart.json()).url).searchParams.get('state');
  assert.match(nativeState, /^m\.[A-Za-z0-9_-]{43}$/);
  const mobileCallback = await runtime.dispatchFetch(origin + '/api/oauth/gmail/callback?state=' + nativeState + '&code=fixture', {
    redirect: 'manual',
  });
  const deepLink = new URL(mobileCallback.headers.get('Location'));
  assert.equal(deepLink.protocol, 'agentic-mailbox:');
  assert.equal(deepLink.hostname, 'oauth');
  assert.equal(deepLink.searchParams.get('state'), nativeState);
  assert.equal(deepLink.searchParams.get('mailOAuth'), 'gmail');
  assert.equal((await request('/api/oauth/gmail/finish', b, {state:nativeState,code:'fixture'})).status, 400);
  assert.equal((await request('/api/oauth/gmail/finish', '', {state:nativeState,code:'fixture'}, 'POST', mobile)).status, 200);
  console.log('Mobile bearer login, browser session isolation and native OAuth callback passed.');
  const begin = await (await request('/api/oauth/gmail/start', a, {})).json();
  const state = new URL(begin.url).searchParams.get('state');
  const finish = { state, code: 'test-code' };
  assert.equal((await request('/api/oauth/gmail/finish', b, finish)).status, 400);
  const connected = await (await request('/api/oauth/gmail/finish', a, finish)).json();
  assert.ok(connected.accountId, JSON.stringify(connected));
  const sync = await (await request('/api/mail-accounts/' + connected.accountId + '/refresh', a, {})).json();
  assert.equal(sync.result.imported, 1, JSON.stringify(sync));
  const mails = await (await request('/api/emails', a)).json();
  const mailPath = '/api/emails/' + mails.emails[0].id;
  assert.equal((await request(mailPath, b)).status, 404);
  const own = await (await request(mailPath, a)).json();
  const filePath = '/api/attachments/' + own.email.attachments[0].id + '/download';
  assert.match(await (await request(filePath, a)).text(), /member file/);
  assert.equal((await request(filePath, b)).status, 404);
  assert.equal((await (await request('/api/emails', b)).json()).emails.length, 0);
  console.log('Member OAuth, MIME sync and cross-user attachment downloads verified.');
  console.log('Two hosted users: registration, password, session, account, draft, send and attachment isolation passed.');
} finally { await runtime.dispose(); }
