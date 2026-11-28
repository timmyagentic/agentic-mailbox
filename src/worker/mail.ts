import { normalizeAddress } from '../shared/validation';
import { destinationAddress, legacyDestination } from './forwarding';
import { resendEmail } from './resend';
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
    const route = await env.DB.prepare(`SELECT relay, sender_name, sender_address, destination FROM forwarding_settings WHERE relay = ?1
      UNION ALL SELECT s.relay, s.sender_name, s.sender_address, COALESCE(s.destination, ?2) FROM aliases a
      LEFT JOIN forwarding_settings s ON s.owner = 'admin'
      WHERE a.address = ?1 AND a.routing_mode = 'managed' AND a.status = 'active' LIMIT 1`)
      .bind(recipient, legacyDestination(env)).first<{ relay: string | null; sender_name: string | null; sender_address: string | null; destination: string | null }>();
    if (!route) return reject('Mailbox is not registered or is disabled');
    const target = destinationAddress(env, route.destination);
    if (!target) return reject('Mailbox has no active forwarding destination');
    if (route.sender_name && route.relay) {
      const email = route.sender_address ?? route.relay;
      if (email.toLowerCase() === target) return reject('Sender and destination are the same mailbox');
      await resendEmail(message, env, { name: route.sender_name, email }, target, recipient, route.relay);
      logEvent('info', { event: 'email_resent', processingId });
      return;
    }
    await message.forward(target, new Headers({ 'X-Agentic-Mailbox-Relay': domain, 'X-Agentic-Mailbox-Original-To': recipient }));
    logEvent('info', { event: 'email_forwarded', processingId });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const providerCode = typeof code === 'string' && /^E_[A-Z_0-9]{1,64}$/.test(code) ? code : undefined;
    logEvent('error', { event: 'email_forward_failed', processingId, providerCode });
    // eslint-disable-next-line preserve-caught-error -- Cloudflare logs thrown causes, which may contain private mail data.
    throw new Error(`Email forwarding failed (${processingId})`);
  }
}
