import type { BootstrapPayload } from '../shared/types';
import {
  clearSessionCookie,
  createSessionToken,
  getSession,
  passwordsMatch,
  sessionCookie,
} from './auth';
import {
  createAlias,
  getAttachmentRow,
  getEmail,
  getStats,
  listAliases,
  listEmails,
  listFiles,
  setEmailRead,
  updateAlias,
} from './db';
import { assertSameOrigin, HttpError, json, parseLimit, readJson } from './http';
import type { Env } from './types';

type LoginBody = { password?: string };
type CreateAliasBody = { localPart?: string; label?: string; note?: string; generate?: boolean };
type UpdateAliasBody = { label?: string; note?: string; status?: 'active' | 'disabled' };
type UpdateEmailBody = { read?: boolean };

async function requireSession(request: Request, env: Env): Promise<void> {
  const session = await getSession(request, env.ADMIN_EMAIL, env.SESSION_SECRET);
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

async function handleSession(request: Request, env: Env): Promise<Response> {
  if (request.method === 'GET') {
    return json(await getSession(request, env.ADMIN_EMAIL, env.SESSION_SECRET));
  }

  assertSameOrigin(request);
  if (request.method === 'POST') {
    const body = await readJson<LoginBody>(request);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password || !(await passwordsMatch(password, env.ADMIN_PASSWORD))) {
      throw new HttpError(401, 'invalid_credentials', '密码不正确。');
    }
    const token = await createSessionToken(env.ADMIN_EMAIL, env.SESSION_SECRET);
    return json(
      { authenticated: true, user: { email: env.ADMIN_EMAIL } },
      200,
      { 'Set-Cookie': sessionCookie(token, request.url) },
    );
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
  const [stats, recentEmails, recentAliases] = await Promise.all([
    getStats(env),
    listEmails(env, { limit: 8 }),
    listAliases(env, '', 6),
  ]);
  return json({
    appName: env.APP_NAME,
    primaryDomain: env.PRIMARY_DOMAIN,
    adminEmail: env.ADMIN_EMAIL,
    stats,
    recentEmails,
    recentAliases,
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

  await requireSession(request, env);

  if (pathname === '/api/bootstrap' && request.method === 'GET') {
    return bootstrap(env);
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
