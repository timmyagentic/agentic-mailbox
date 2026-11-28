import { normalizeAddress } from '../shared/validation';
import { destinationAddress, legacyDestination } from './forwarding';
import { logEvent } from './logging';
import type { EmailWorkerMessage, Env } from './types';

export async function forwardEmail(message: EmailWorkerMessage, env: Env): Promise<void> {
  const processingId = crypto.randomUUID();
  async function reject(reason: string) {
    await message.setReject(reason);
    logEvent('warn', { event: 'email_rejected', processingId });
  }
  const recipient = normalizeAddress(message.to);
  const domain = env.PRIMARY_DOMAIN.trim().toLowerCase();
  if (!recipient || !recipient.endsWith('@' + domain)) return reject('Recipient domain is not managed here');
  if (message.canBeForwarded === false) return reject('Message is ineligible for forwarding');
  if (message.headers.get('X-Agentic-Mailbox-Relay')?.split(',').some(hop => hop.trim() === domain)) {
    return reject('Forwarding loop detected');
  }
  try {
    // Before an administrator first visits settings, existing aliases still use the operator's destination.
    const route = await env.DB.prepare(`SELECT destination FROM forwarding_settings WHERE relay = ?1
      UNION ALL SELECT COALESCE((SELECT destination FROM forwarding_settings WHERE owner = 'admin'), ?2)
      FROM aliases WHERE address = ?1 AND routing_mode = 'managed' AND status = 'active' LIMIT 1`)
      .bind(recipient, legacyDestination(env)).first<{ destination: string | null }>();
    if (!route) return reject('Mailbox is not registered or is disabled');
    const target = destinationAddress(env, route.destination);
    if (!target) return reject('Mailbox has no active forwarding destination');
    await message.forward(target, new Headers({ 'X-Agentic-Mailbox-Relay': domain, 'X-Agentic-Mailbox-Original-To': recipient }));
    logEvent('info', { event: 'email_forwarded', processingId });
  } catch {
    logEvent('error', { event: 'email_forward_failed', processingId });
    throw new Error(`Email forwarding failed (${processingId})`);
  }
}
