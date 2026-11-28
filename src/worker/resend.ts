import PostalMime from 'postal-mime';
import { internetMailbox } from '../shared/validation';
import type { EmailWorkerMessage, Env } from './types';

export async function resendEmail(
  message: EmailWorkerMessage,
  env: Env,
  from: EmailAddress,
  destination: string,
  originalRecipient: string,
  inboundRelay: string,
) {
  const original = await PostalMime.parse(message.raw, {
    attachmentEncoding: 'arraybuffer', forceRfc822Attachments: true,
  });
  const author = internetMailbox(original.from?.address);
  const replyTo = [...(original.replyTo ?? []).map(item => item.address), author, message.from]
    .map(internetMailbox).find((address): address is string => address !== null
      && address.toLowerCase() !== from.email.toLowerCase() && address.toLowerCase() !== inboundRelay.toLowerCase());
  const subject = original.subject?.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim() || '（无主题）';
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
