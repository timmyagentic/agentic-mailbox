import type { LegacySource } from '../shared/types';
import type { Env } from './types';

export const legacySourcesQuery = `SELECT a.address, i.provider FROM aliases a JOIN imap_accounts i ON i.id = a.id
  UNION ALL SELECT a.address, o.provider FROM aliases a JOIN oauth_accounts o ON o.id = a.id ORDER BY address`;

export async function legacySources(env: Env, username: string | null): Promise<LegacySource[]> {
  if (!username) return (await env.DB.prepare(legacySourcesQuery).all<LegacySource>()).results;
  const response = await env.MEMBERS!.getByName(username).fetch('https://member.internal/sources', {
    headers: { 'X-Agentic-Mailbox-User': username },
  });
  if (!response.ok) throw new Error('Member sources unavailable');
  return (await response.json<{ sources: LegacySource[] }>()).sources;
}
