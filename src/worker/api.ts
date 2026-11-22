import type { BootstrapPayload, DraftInput } from '../shared/types';
import { listMailAccounts, refreshMailAccount, saveMailAccount } from './accounts';
import {
  clearSessionCookie,
  createSessionToken,
  getSession,
  passwordsMatch,
  sessionCookie,
  verifiedClientFingerprint,
} from './auth';
import {
  createAlias,
  getAttachmentRow,
  getEmail,
  getConversation,
  listConversations,
  markConversationRead,
  updateMailPlacement,
  getStats,
  listAliases,
  listEmails,
  listFiles,
  setEmailRead,
  updateAlias,
} from './db';
import {
  discardDraft, discardDraftFile, generateDraftText, getDraft, listDrafts, saveDraft, sendDraft, uploadDraftFile,
} from './drafts';
import { assertSameOrigin, HttpError, json, parseLimit, readJson } from './http';
import { configuredOAuthProviders, finishOAuth, isOAuthProvider, oauthCallback, startOAuth } from './oauth';
import type { Env } from './types';

type LoginBody = { password?: string };
type CreateAliasBody = { localPart?: string; label?: string; note?: string; generate?: boolean };
type UpdateAliasBody = { label?: string; note?: string; status?: 'active' | 'disabled' };
type UpdateEmailBody = { read?: boolean };

async function requireSession(request: Request, env: Env): Promise<void> {
  const session = await getSession(request, env.ADMIN_EMAIL, env.SESSION_SECRET, env.ADMIN_CERT_FINGERPRINTS);
  if (!session.authenticated) {
    throw new HttpError(401, 'authentication_required', '请先登录管理端。');
  }
}

async function health(env: Env): Promise<Response> {
  try {
    await env.DB.prepare('SELECT 1').first();
    return json({
      ok: true,
      service: 'mailbox-vault',
      dependencies: { database: 'ready', objectStorage: 'configured' },
      timestamp: new Date().toISOString(),
    });
  } catch {
    return json(
      {
        ok: false,
        service: 'mailbox-vault',
        dependencies: { database: 'unavailable', objectStorage: 'configured' },
        timestamp: new Date().toISOString(),
      },
      503,
    );
  }
}

async function startAdminSession(request: Request, env: Env, fingerprint?: string): Promise<Response> {
  const token = await createSessionToken(env.ADMIN_EMAIL, env.SESSION_SECRET, Date.now(), fingerprint);
  return json(
    { authenticated: true, user: { email: env.ADMIN_EMAIL } },
    200,
    { 'Set-Cookie': sessionCookie(token, request.url) },
  );
}

async function handleCertificateLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    throw new HttpError(405, 'method_not_allowed', '请求方法不支持。');
  }
  assertSameOrigin(request);
  // JSON prevents ordinary cross-site form submissions from starting a certificate session.
  await readJson<unknown>(request);

  if (new URL(request.url).protocol !== 'https:') {
    throw new HttpError(400, 'certificate_requires_https', '请通过已启用设备证书的 HTTPS 地址登录。');
  }
  if (!env.ADMIN_CERT_FINGERPRINTS?.trim()) {
    throw new HttpError(503, 'certificate_login_unconfigured', '此站点尚未配置设备证书登录。');
  }
  const fingerprint = verifiedClientFingerprint(request, env.ADMIN_CERT_FINGERPRINTS);
  if (!fingerprint) {
    throw new HttpError(403, 'certificate_not_allowed', '未识别到可用的设备证书，请在浏览器中选择已登记的证书。');
  }
  return startAdminSession(request, env, fingerprint);
}

async function handleSession(request: Request, env: Env): Promise<Response> {
  if (request.method === 'GET') {
    return json({ ...await getSession(request, env.ADMIN_EMAIL, env.SESSION_SECRET, env.ADMIN_CERT_FINGERPRINTS),
      ...(env.MEMBERS ? { edition: 'hosted' } : env.LOCAL_MODE === '1' ? { edition: 'local' } : {}) });
  }

  assertSameOrigin(request);
  if (request.method === 'POST') {
    const body = await readJson<LoginBody>(request);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password || !(await passwordsMatch(password, env.ADMIN_PASSWORD))) {
      throw new HttpError(401, 'invalid_credentials', '密码不正确。');
    }
    return startAdminSession(request, env);
  }

  if (request.method === 'DELETE') {
    return json(
      { authenticated: false, user: null },
      200,
      { 'Set-Cookie': clearSessionCookie(request.url) },
    );
  }

  throw new HttpError(405, 'method_not_allowed', '请求方法不支持。');
}

async function bootstrap(env: Env): Promise<Response> {
  const [stats, recentEmails, recentAliases, mailAccounts] = await Promise.all([
    getStats(env),
    listEmails(env, { limit: 8 }),
    listAliases(env, '', 6),
    listMailAccounts(env),
  ]);
  return json({
    appName: env.APP_NAME,
    primaryDomain: env.PRIMARY_DOMAIN,
    adminEmail: env.ADMIN_EMAIL,
    stats,
    recentEmails,
    recentAliases,
    mailAccounts,
    local: env.LOCAL_MODE === '1',
    externalOnly: Boolean(env.EXTERNAL_ONLY || env.LOCAL_MODE === '1'),
    oauthProviders: configuredOAuthProviders(env),
  } satisfies BootstrapPayload);
}

function routeId(pathname: string, prefix: string, suffix = ''): string | null {
  if (!pathname.startsWith(prefix) || (suffix && !pathname.endsWith(suffix))) {
    return null;
  }
  const end = suffix ? -suffix.length : undefined;
  const raw = pathname.slice(prefix.length, end);
  if (!raw || raw.includes('/')) {
    return null;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function encodedFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function downloadAttachment(env: Env, id: string): Promise<Response> {
  const row = await getAttachmentRow(env, id);
  const object = await env.ATTACHMENTS.get(row.r2_key);
  if (!object || !('body' in object)) {
    throw new HttpError(404, 'attachment_object_missing', '附件文件不存在。');
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', row.content_type || 'application/octet-stream');
  headers.set('Content-Length', String(row.size));
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodedFilename(row.filename)}`);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('ETag', object.httpEtag);
  return new Response(object.body, { headers });
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname, searchParams } = url;

  if (pathname === '/api/health' && request.method === 'GET') {
    return health(env);
  }

  if (pathname === '/api/session') {
    return handleSession(request, env);
  }

  if (pathname === '/api/session/local' && env.LOCAL_MODE === '1' && request.method === 'POST') {
    assertSameOrigin(request);
    const { ticket } = await readJson<{ ticket?: string }>(request);
    if (typeof ticket !== 'string' || ticket.length !== 64) throw new HttpError(401, 'invalid_ticket', '请重新打开本地启动器。');
    const result = await env.DB.prepare('DELETE FROM local_launch WHERE ticket = ?1 AND expires > ?2')
      .bind(ticket, Date.now()).run();
    if (!result.meta.changes) throw new HttpError(401, 'expired_ticket', '本机登录链接已过期，请使用本机密码。');
    return startAdminSession(request, env);
  }

  if (pathname === '/api/session/certificate') {
    return handleCertificateLogin(request, env);
  }

  const callbackProvider = routeId(pathname, '/api/oauth/', '/callback');
  if (isOAuthProvider(callbackProvider) && request.method === 'GET') {
    return oauthCallback(env, url, callbackProvider);
  }

  await requireSession(request, env);
  if ((env.EXTERNAL_ONLY || env.LOCAL_MODE === '1') && request.method !== 'GET' && (pathname === '/api/aliases' || pathname.startsWith('/api/aliases/'))) {
    throw new HttpError(403, 'managed_domain_only', '此空间只支持连接外部邮箱。');
  }

  const startProvider = routeId(pathname, '/api/oauth/', '/start');
  if (isOAuthProvider(startProvider) && request.method === 'POST') {
    assertSameOrigin(request);
    const body = await readJson<{ accountId?: unknown }>(request);
    return json({ url: await startOAuth(env, request, startProvider, body?.accountId) });
  }

  const finishProvider = routeId(pathname, '/api/oauth/', '/finish');
  if (isOAuthProvider(finishProvider) && request.method === 'POST') {
    assertSameOrigin(request);
    const body = await readJson<{ state?: unknown; code?: unknown; error?: unknown }>(request);
    const accountId = await finishOAuth(env, request, finishProvider, body);
    return json({ ok: true, accountId });
  }

  if (pathname === '/api/bootstrap' && request.method === 'GET') {
    return bootstrap(env);
  }

  if (pathname === '/api/mail-accounts' && request.method === 'POST') {
    assertSameOrigin(request);
    const body = await readJson<{ email?: unknown; authorizationCode?: unknown }>(request);
    return json({ account: await saveMailAccount(env, body) });
  }

  const accountId = routeId(pathname, '/api/mail-accounts/', '/refresh');
  if (accountId && request.method === 'POST') {
    assertSameOrigin(request);
    return json({ result: await refreshMailAccount(env, accountId) });
  }

  if (pathname === '/api/aliases') {
    if (request.method === 'GET') {
      return json({
        aliases: await listAliases(env, searchParams.get('q') ?? '', parseLimit(searchParams.get('limit'))),
      });
    }
    if (request.method === 'POST') {
      assertSameOrigin(request);
      return json({ alias: await createAlias(env, await readJson<CreateAliasBody>(request)) }, 201);
    }
  }

  const aliasId = routeId(pathname, '/api/aliases/');
  if (aliasId && request.method === 'PATCH') {
    assertSameOrigin(request);
    return json({ alias: await updateAlias(env, aliasId, await readJson<UpdateAliasBody>(request)) });
  }

  if (pathname === '/api/conversations' && request.method === 'GET') {
    const folder = searchParams.get('folder');
    const parsedPage = Number(searchParams.get('page') ?? '1');
    const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? Math.min(parsedPage, 10_000) : 1;
    const limit = parseLimit(searchParams.get('limit'), 25, 50);
    return json(await listConversations(env, {
      folder: folder === 'sent' || folder === 'archive' || folder === 'trash' ? folder : 'inbox',
      aliasId: searchParams.get('aliasId') ?? undefined,
      query: searchParams.get('q') ?? undefined,
      unreadOnly: searchParams.get('unread') === '1',
      limit, offset: (page - 1) * limit,
    }));
  }
  const conversationId = routeId(pathname, '/api/conversations/');
  if (conversationId && request.method === 'GET') return json(await getConversation(env, conversationId));
  if (conversationId && request.method === 'PATCH') {
    assertSameOrigin(request);
    const input = await readJson<{ read?: unknown }>(request);
    if (typeof input?.read !== 'boolean') throw new HttpError(400, 'invalid_read_state', '邮件阅读状态不正确。');
    await markConversationRead(env, conversationId, input.read);
    return json({ ok: true });
  }

  if (pathname === '/api/drafts' && request.method === 'GET') return json({ drafts: await listDrafts(env) });
  if (pathname === '/api/drafts' && request.method === 'POST') {
    assertSameOrigin(request);
    return json({ draft: await saveDraft(env, await readJson<DraftInput>(request)) }, 201);
  }
  const writeId = routeId(pathname, '/api/drafts/');
  if (writeId && request.method === 'GET') return json({ draft: await getDraft(env, writeId) });
  if (writeId && (request.method === 'PUT' || request.method === 'DELETE')) {
    assertSameOrigin(request);
    if (request.method === 'PUT') {
      return json({ draft: await saveDraft(env, await readJson<DraftInput>(request), writeId) });
    }
    await discardDraft(env, writeId);
    return json({ ok: true });
  }

  const sendId = routeId(pathname, '/api/drafts/', '/send');
  if (sendId && request.method === 'POST') {
    assertSameOrigin(request);
    await readJson(request);
    return json(await sendDraft(env, sendId));
  }
  const generateId = routeId(pathname, '/api/drafts/', '/suggest');
  if (generateId && request.method === 'POST') {
    assertSameOrigin(request);
    const body = await readJson<{ instruction?: unknown }>(request);
    return json({ text: await generateDraftText(env, generateId, body?.instruction) });
  }
  const uploadId = routeId(pathname, '/api/drafts/', '/files');
  if (uploadId && request.method === 'POST') {
    assertSameOrigin(request);
    return json({ file: await uploadDraftFile(env, uploadId, request, searchParams.get('name') ?? '') }, 201);
  }
  const draftFile = pathname.match(/^\/api\/drafts\/([a-f0-9-]+)\/files\/([a-f0-9-]+)$/i);
  if (draftFile && request.method === 'DELETE') {
    assertSameOrigin(request);
    await discardDraftFile(env, draftFile[1], draftFile[2]);
    return json({ ok: true });
  }

  if (pathname === '/api/emails' && request.method === 'GET') {
    return json({
      emails: await listEmails(env, {
        aliasId: searchParams.get('aliasId') ?? undefined,
        query: searchParams.get('q') ?? undefined,
        unreadOnly: searchParams.get('unread') === '1',
        limit: parseLimit(searchParams.get('limit')),
      }),
    });
  }

  const placementId = routeId(pathname, '/api/emails/', '/placement');
  if (placementId && request.method === 'PATCH') {
    assertSameOrigin(request);
    const { starred, folder } = await readJson<{ starred?: unknown; folder?: unknown }>(request) ?? {};
    if ((starred !== undefined && typeof starred !== 'boolean')
      || (folder !== undefined && folder !== 'archive' && folder !== 'trash' && folder !== 'restore')
      || (starred === undefined && folder === undefined)) {
      throw new HttpError(400, 'invalid_mail_placement', '邮件标记或文件夹无效。');
    }
    await updateMailPlacement(env, placementId, { starred, folder });
    return json({ ok: true });
  }

  const emailId = routeId(pathname, '/api/emails/');
  if (emailId) {
    if (request.method === 'GET') {
      return json({ email: await getEmail(env, emailId) });
    }
    if (request.method === 'PATCH') {
      assertSameOrigin(request);
      const body = await readJson<UpdateEmailBody>(request);
      if (typeof body.read !== 'boolean') {
        throw new HttpError(400, 'invalid_read_state', '邮件阅读状态不正确。');
      }
      await setEmailRead(env, emailId, body.read);
      return json({ ok: true });
    }
  }

  if (pathname === '/api/files' && request.method === 'GET') {
    return json({
      files: await listFiles(env, {
        aliasId: searchParams.get('aliasId') ?? undefined,
        query: searchParams.get('q') ?? undefined,
        limit: parseLimit(searchParams.get('limit')),
      }),
    });
  }

  const attachmentId = routeId(pathname, '/api/attachments/', '/download');
  if (attachmentId && request.method === 'GET') {
    return downloadAttachment(env, attachmentId);
  }

  throw new HttpError(404, 'not_found', '接口不存在。');
}
