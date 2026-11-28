import worker from '../../src/worker/self-host';
import { runMailboxSegment } from '../../src/worker/relay/listener';
import type { RelayEnv } from '../../src/worker/relay/profile';

// Miniflare-only entrypoint. Give each invocation a short, independently controlled window.
// Production chooses the same handler's window from Cloudflare's scheduledTime.
export default {
  ...worker,
  async fetch(request: Request, env: RelayEnv) {
    if (new URL(request.url).pathname !== '/test/segment') return worker.fetch(request, env);
    const window = await request.json<{ epoch: number; until: number }>();
    await runMailboxSegment(env, Date.now(), window);
    return new Response('done');
  },
};
