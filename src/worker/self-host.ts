import { accessRoute } from './access';
import { getSession } from './auth';
import { apiError, assertSameOrigin, HttpError, json, readJson, withSecurityHeaders } from './http';
import { type RelayEnv } from './relay/profile';
import { RelayFailure } from './relay/protocol';
import { confirmSetup, startSetup, status } from './relay/store';
import { resolveMail, syncMailbox } from './relay/sync';
import { runMailboxSegment } from './relay/listener';

async function handle(request: Request, env: RelayEnv) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET)
    throw new HttpError(503, 'setup_required', '请先设置实例的管理员密码和会话密钥。');
  const access = accessRoute(request, env, 'imap');
  if (access) return access;
  if (
    !(await getSession(request, env.ADMIN_EMAIL, env.SESSION_SECRET, env.ADMIN_CERT_FINGERPRINTS))
      .authenticated
  ) {
    throw new HttpError(401, 'authentication_required', '请先登录转发设置。');
  }
  if (request.method === 'GET' && path === '/api/relay') return json(await status(env));
  if (request.method !== 'POST') throw new HttpError(404, 'not_found', '找不到此接口。');
  assertSameOrigin(request);
  const data = await readJson<Record<string, unknown>>(request);
  if (path === '/api/relay/setup') await startSetup(env, data);
  else if (path === '/api/relay/confirm') await confirmSetup(env, data?.id, data?.code);
  else if (path === '/api/relay/check') await syncMailbox(env);
  else if (path === '/api/relay/resolve') await resolveMail(env, data);
  else throw new HttpError(404, 'not_found', '找不到此接口。');
  return json(await status(env));
}

export default {
  async fetch(request: Request, env: RelayEnv) {
    try {
      return withSecurityHeaders(await handle(request, env));
    } catch (error) {
      const safe =
        error instanceof RelayFailure
          ? new HttpError(
              422,
              'mail_connection',
              error.issue === 'oauth'
                ? 'Google 授权无法刷新，请重新授权。'
                : '无法连接邮箱，请检查服务商设置。',
            )
          : error;
      return withSecurityHeaders(apiError(safe, crypto.randomUUID()));
    }
  },
  async scheduled(event: ScheduledController, env: RelayEnv) {
    await runMailboxSegment(env, event.scheduledTime);
  },
} satisfies ExportedHandler<RelayEnv>;
