import PostalMime, { type RawEmail } from 'postal-mime';
import { internetMailbox } from '../shared/validation';
import type { EmailWorkerMessage, Env } from './types';

export async function readOriginal(raw: RawEmail, excluded: string[], fallbackAuthor?: string) {
  const original = await PostalMime.parse(raw, {
    attachmentEncoding: 'arraybuffer', forceRfc822Attachments: true,
  });
  const author = internetMailbox(original.from?.address);
  const replyTo = [...(original.replyTo ?? []).map(item => item.address), author, fallbackAuthor]
    .map(internetMailbox).find((address): address is string => address !== null
      && !excluded.some(item => item.toLowerCase() === address.toLowerCase()));
  const subject = original.subject?.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim() || '（无主题）';
  return { original, author, replyTo, subject };
}

export async function resendEmail(
  message: EmailWorkerMessage,
  env: Env,
  from: EmailAddress,
  destination: string,
  originalRecipient: string,
  inboundRelay: string,
) {
  const { original, author, replyTo, subject } = await readOriginal(message.raw, [from.email, inboundRelay], message.from);
  // Start a new message. Envelope recipients, Cc/Bcc and authentication headers belong to the old delivery.
  await env.EMAIL.send({
    from, to: destination, subject,
    replyTo,
    text: original.text || (original.html ? undefined : '（原邮件无正文）'),
    html: original.html || undefined,
    headers: {
      'Auto-Submitted': 'auto-generated',
      'X-Agentic-Mailbox-Relay': env.PRIMARY_DOMAIN.trim().toLowerCase(),
      'X-Agentic-Mailbox-Original-To': originalRecipient,
      ...(author ? { 'X-Agentic-Mailbox-Original-From': author } : {}),
    },
    attachments: original.attachments.map((part, index): EmailAttachment => {
      const file = { filename: part.filename || `attachment-${index + 1}`, type: part.mimeType, content: part.content };
      const contentId = part.contentId?.replace(/^<([^<>]+)>$/, '$1');
      if (contentId && (part.related || part.disposition !== 'attachment')) return { ...file, disposition: 'inline', contentId };
      return { ...file, disposition: 'attachment' };
    }),
  });
}
