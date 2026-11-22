import { boundedBody, HttpError } from './http';
import type { Env } from './types';

type DraftMessage = { role: 'system' | 'user'; content: string };

export function draftAIAvailable(env: Env): boolean {
  return Boolean(env.OPENAI_API_KEY?.trim() || env.AI);
}

function chatEndpoint(env: Env): URL {
  try {
    const url = new URL(env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && env.LOCAL_MODE === '1' && loopback)) throw new Error();
    if (url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = url.pathname.replace(/\/+$/, '') + '/chat/completions';
    return url;
  } catch {
    throw new HttpError(503, 'ai_invalid_endpoint', 'AI 服务地址无效，请检查 OPENAI_BASE_URL。');
  }
}

export async function draftCompletion(env: Env, messages: DraftMessage[]): Promise<unknown> {
  const key = env.OPENAI_API_KEY?.trim();
  if (!key && !env.AI) throw new HttpError(503, 'ai_unconfigured', 'AI 草稿服务尚未配置。');
  const endpoint = key ? chatEndpoint(env) : undefined;
  try {
    if (!endpoint) {
      const result = await env.AI!.run('@cf/google/gemma-4-26b-a4b-it', { messages, max_tokens: 650 });
      return result && typeof result === 'object' && 'response' in result ? result.response : '';
    }
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini', messages,
        ...(endpoint.hostname === 'api.openai.com' ? { max_completion_tokens: 650 } : { max_tokens: 650 }),
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    const data = await boundedBody(response, 128 * 1024);
    if (!data) throw new Error();
    const result = JSON.parse(data.toString('utf8')) as { choices?: { message?: { content?: unknown } }[] };
    return result?.choices?.[0]?.message?.content;
  } catch {
    throw new HttpError(502, 'ai_draft_failed', 'AI 起草暂时不可用，请检查服务地址、API Key 和模型后重试。');
  }
}
