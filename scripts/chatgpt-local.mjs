import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import OpenAI from 'openai';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const planScope = 'chatgpt.tokens.use.direct';
const randomValue = () => randomBytes(32).toString('base64url');

class ConnectionError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function vault(path, key) {
  return {
    read() {
      if (!existsSync(path)) return { host: 'urn:uuid:' + randomUUID() };
      const [iv, tag, encrypted] = JSON.parse(readFileSync(path, 'utf8')).map(part => Buffer.from(part, 'base64'));
      const cipher = createDecipheriv('aes-256-gcm', key, iv);
      cipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8'));
    },
    write(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      const temp = path + '.' + randomUUID();
      writeFileSync(temp, JSON.stringify([iv, cipher.getAuthTag(), encrypted].map(buf => buf.toString('base64'))),
        { mode: 0o600, flag: 'wx' });
      renameSync(temp, path);
    },
  };
}

export function createChatGPTService({ directory, origin, encryptionKey, fetchImpl = fetch }) {
  const callback = new URL('/auth/callback', origin);
  if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1') throw new Error('ChatGPT requires an IPv4 loopback callback.');
  const store = vault(join(directory, 'chatgpt-account.enc'), Buffer.from(encryptionKey, 'base64'));
  let account = store.read();
  store.write(account);
  let pending;
  let refreshing;
  let discovery;
  let keys;
  const json = (value, status = 200) => Response.json(value, { status });
  const status = () => ({
    linked: Boolean(account.subject),
    email: account.email || '',
    planEnabled: Boolean(account.tokens?.access_token && account.tokens.scope?.split(' ').includes(planScope)),
  });
  const save = next => { store.write(next); account = next; };

  async function endpoints() {
    if (discovery) return discovery;
    const res = await fetchImpl(issuer + '/.well-known/openid-configuration', { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new ConnectionError(502, '无法读取 OpenAI 登录配置。');
    const info = await res.json();
    if (info.issuer !== issuer) throw new Error('Invalid issuer');
    for (const name of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (new URL(info[name]).origin !== issuer) throw new Error('Invalid endpoint');
    }
    keys = createRemoteJWKSet(new URL(info.jwks_uri), { [customFetch]: fetchImpl });
    discovery = info;
    return info;
  }

  async function tokenRequest(params) {
    const info = await endpoints();
    const res = await fetchImpl(info.token_endpoint, {
      method: 'POST', body: new URLSearchParams({ ...params, resource }),
      redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new ConnectionError(401, 'OpenAI 登录已过期或授权未完成，请重新连接。');
    return res.json();
  }

  async function start({ browser, linking, session }) {
    if (!account.subject && !(linking && session)) throw new ConnectionError(403, '请先用本机登录方式进入邮箱，再绑定 ChatGPT。');
    const info = await endpoints();
    const state = randomValue();
    const verifier = randomValue();
    const nonce = randomValue();
    pending = { browser, state, verifier, nonce, clientId: account.clientId, session: linking ? session : null, expires: Date.now() + 600000 };
    const url = new URL(info.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: account.clientId || 'dynamic_agent_client',
      ...(account.clientId ? {} : { agent_name_hint: 'Agentic Mailbox' }),
      ext_agent_host_id: account.host, response_type: 'code', redirect_uri: callback.href,
      scope: scopes, resource, state, nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    return { url: url.href };
  }

  async function finish({ browser, session, state, code, clientId, error }) {
    const flow = pending;
    if (!flow || !browser || flow.browser !== browser || flow.state !== state || flow.expires <= Date.now() ||
        (flow.session && flow.session !== session)) throw new ConnectionError(400, '登录请求已失效，请从本机重新开始。');
    pending = undefined;
    if (error || typeof code !== 'string' || !code) throw new ConnectionError(400, 'ChatGPT 授权已取消。');
    const issued = flow.clientId || clientId;
    if (!/^oaiapp_[A-Za-z0-9_-]+$/.test(issued || '') || (clientId && clientId !== issued)) throw new ConnectionError(400, 'OpenAI 未返回匹配的应用注册。');
    if (!flow.clientId) save({ ...account, clientId: issued });
    const original = account;
    const tokens = await tokenRequest({ client_id: issued, code, code_verifier: flow.verifier,
      grant_type: 'authorization_code', redirect_uri: callback.href });
    const { payload } = await jwtVerify(tokens.id_token, keys, {
      issuer, audience: issued, requiredClaims: ['sub','exp','iat','nonce'], clockTolerance: 5,
    });
    if (payload.nonce !== flow.nonce || typeof payload.sub !== 'string' || !payload.sub ||
        (account.subject && account.subject !== payload.sub) || account !== original || pending) {
      throw new ConnectionError(403, 'ChatGPT 身份与本机绑定不匹配。');
    }
    save({ host: account.host, clientId: issued, subject: payload.sub,
      email: payload.email_verified === true && typeof payload.email === 'string' ? payload.email : '',
      tokens, expires: Date.now() + (Number(tokens.expires_in) || 0) * 1000 });
    return status();
  }

  async function accessToken() {
    if (!status().planEnabled) throw new ConnectionError(403, '请先授权使用 ChatGPT 套餐生成邮件草稿。');
    if (account.expires > Date.now() + 60000) return account.tokens.access_token;
    if (!account.tokens.refresh_token) throw new ConnectionError(401, '请重新连接 ChatGPT。');
    if (!refreshing) {
      const original = account;
      refreshing = tokenRequest({ client_id: account.clientId, grant_type: 'refresh_token',
        refresh_token: account.tokens.refresh_token }).then(tokens => {
        if (original !== account || typeof tokens.access_token !== 'string') throw new ConnectionError(401, '请重新连接 ChatGPT。');
        save({ ...account, tokens: { ...account.tokens, ...tokens }, expires: Date.now() + (Number(tokens.expires_in) || 0) * 1000 });
        if (!status().planEnabled) throw new ConnectionError(403, '当前账户没有授予套餐调用权限。');
        return tokens.access_token;
      }).finally(() => { refreshing = undefined; });
    }
    return refreshing;
  }

  async function draft({ instructions, input }) {
    const token = await accessToken();
    const models = await fetchImpl(resource + '/models', { headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!models.ok) throw new ConnectionError(502, '无法读取当前 ChatGPT 套餐的可用模型。');
    const model = (await models.json()).models?.find(item => item.visibility === 'list' && typeof item.slug === 'string');
    if (!model) throw new ConnectionError(403, '当前套餐没有可用模型。');
    const client = new OpenAI({ apiKey: token, baseURL: resource, fetch: fetchImpl, maxRetries: 0, timeout: 60000 });
    const stream = await client.responses.create({ model: model.slug, instructions,
      input: [{ role: 'user', content: input }], store: false, stream: true }, { signal: AbortSignal.timeout(60000) });
    let text = '';
    let completed = false;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') text += event.delta;
      if (event.type === 'response.completed') completed = true;
      if (text.length > 60000) break;
    }
    if (!completed || !text.trim()) throw new ConnectionError(502, 'ChatGPT 草稿生成未完成。');
    return { text: text.trim().slice(0, 8000) };
  }

  async function disconnect() {
    const old = account;
    pending = undefined;
    save({ host: old.host });
    let revoked = !old.tokens?.refresh_token;
    if (!revoked) {
      try {
        const endpoint = (await endpoints()).revocation_endpoint;
        if (new URL(endpoint).origin === issuer) {
          const res = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
            body: new URLSearchParams({ token: old.tokens.refresh_token, token_type_hint: 'refresh_token', client_id: old.clientId }) });
          revoked = res.ok;
        }
      } catch { /* Local credentials have been cleared. */ }
    }
    return { revoked };
  }

  return async request => {
    try {
      const action = new URL(request.url).pathname;
      if (action === '/status') return json(status());
      if (request.method !== 'POST') return json({}, 405);
      if (action === '/disconnect') return json(await disconnect());
      const body = await request.json();
      if (action === '/start') return json(await start(body));
      if (action === '/finish') return json(await finish(body));
      if (action === '/draft') return json(await draft(body));
      return json({}, 404);
    } catch (error) {
      return json({ message: error instanceof ConnectionError ? error.message : 'OpenAI 请求或身份验证失败，请重试。' },
        error instanceof ConnectionError ? error.status : 502);
    }
  };
}
