import { Buffer } from 'node:buffer';
import nodemailer from 'nodemailer';
import type { DraftMode, ImapProvider, OAuthProvider } from '../shared/types';
import { HttpError } from './http';
import { gmailApi, graphApi, immutableId, MailProviderError, mailProviderFetch } from './oauth';
import type { Env } from './types';

export type Delivery = {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  messageId: string;
  mode: DraftMode;
  source?: { identity: string | null; threadId: string | null; from: string };
  attachments: { filename: string; contentType: string; content: ArrayBuffer }[];
};

export class DeliveryError extends Error {
  constructor(readonly retryable: boolean, message: string) { super(message); }
}

const smtpHosts: Record<ImapProvider, string> = { gmail_app: 'smtp.gmail.com', qq: 'smtp.qq.com', netease163: 'smtp.163.com' };

export type Sender = { address: string } & (
  { authorizationCode: string; provider: ImapProvider } | { accessToken: string; provider: OAuthProvider }
);

function mimeMessage(delivery: Delivery) {
  const { from, to, cc, bcc, subject, text, html, headers, attachments, messageId } = delivery;
  return {
    from, to, cc, bcc, subject, text, html: html || undefined, headers, messageId,
    attachments: attachments.map((file) => ({
      filename: file.filename, contentType: file.contentType, content: Buffer.from(file.content),
    })),
  };
}

async function deliverOAuth(delivery: Delivery, sender: Extract<Sender, { accessToken: string }>) {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows',
    disableFileAccess: true, disableUrlAccess: true });
  const { message } = await transport.sendMail(mimeMessage(delivery));
  if (!Buffer.isBuffer(message)) throw new Error('Unable to compose MIME');
  const { source, mode } = delivery;
  let url: string;
  let body: string;
  let headers: HeadersInit;
  if (sender.provider === 'gmail') {
    url = `${gmailApi}/messages/send`;
    headers = { 'Content-Type': 'application/json' };
    body = JSON.stringify({
      raw: message.toString('base64url'),
      ...(mode === 'reply' && source?.threadId && delivery.headers['In-Reply-To'] ? { threadId: source.threadId } : {}),
    });
  } else {
    url = `${graphApi}/sendMail`;
    const original = source?.identity?.startsWith('outlook:') ? source.identity.slice('outlook:'.length) : null;
    if (original) {
      // Native MIME reply targets the original sender. Use the MIME envelope for a
      // Reply-To address, reply-all, or when the user edited the recipient list.
      const defaultReply = mode === 'reply' && delivery.to.length === 1 && !delivery.cc.length && !delivery.bcc.length
        && delivery.to[0].toLowerCase() === source?.from.toLowerCase();
      const action = mode === 'forward' ? 'forward' : defaultReply ? 'reply' : null;
      if (action) url = `${graphApi}/messages/${encodeURIComponent(original)}/${action}`;
    }
    headers = { 'Content-Type': 'text/plain', Prefer: immutableId };
    body = message.toString('base64');
    if (body.length > 4_000_000) {
      throw new HttpError(413, 'outlook_message_too_large', 'Outlook 邮件编码后超过 4 MB，请减少附件或缩短正文。');
    }
  }

  try {
    const response = await mailProviderFetch(url, sender.accessToken, { method: 'POST', headers, body });
    await response.body?.cancel().catch(() => {});
    return { messageId: delivery.messageId, rejected: [] as string[] };
  } catch (error) {
    const upstream = error instanceof MailProviderError ? error : undefined;
    const status = upstream?.status ?? 0;
    const message = upstream?.reason === 'service_disabled' ? 'Gmail API 尚未启用，请联系站点维护者。'
      : status === 401 || upstream?.reason === 'insufficient_scope' ? '请重新授权并允许发送邮件。'
      : status === 403 ? '邮箱服务商拒绝了发信请求，请联系站点维护者。'
      : status === 413 ? '邮箱服务商拒绝了这封过大的邮件，请减少附件。'
      : '邮箱服务商暂时无法发送这封邮件。';
    throw new DeliveryError(status >= 400 && status < 500 && status !== 408, message);
  }
}

export async function deliverMail(env: Env, delivery: Delivery, sender: Sender | null) {
  const { to, cc, bcc, from, subject, text, html, headers, attachments } = delivery;
  if (!sender) {
    if (!env.EMAIL) throw new HttpError(503, 'outbound_unconfigured', '自有域名发信服务尚未开通。');
    try {
      const result = await env.EMAIL.send({
        from, to, cc, bcc, subject, text, html: html || undefined, headers,
        attachments: attachments.map(({ filename, contentType, content }) => ({
          filename, type: contentType, content, disposition: 'attachment' as const,
        })),
      });
      return { messageId: result.messageId, rejected: [] as string[] };
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      const knownRejection = typeof code === 'string' && [
        'E_FIELD_MISSING', 'E_HEADER_NOT_ALLOWED', 'E_HEADER_USE_API_FIELD',
        'E_DOMAIN_NOT_ONBOARDED', 'E_FROM_ADDRESS_NOT_ALLOWED', 'E_DESTINATION_ADDRESS_NOT_ALLOWED',
        'E_MESSAGE_TOO_LARGE', 'E_RATE_LIMITED',
      ].includes(code);
      throw new DeliveryError(knownRejection, 'Cloudflare 发信服务拒绝了邮件，请检查发信域名和发信配置。');
    }
  }

  if ('accessToken' in sender) return deliverOAuth(delivery, sender);

  const transport = nodemailer.createTransport({
    host: smtpHosts[sender.provider], port: 465, secure: true,
    auth: { user: sender.address, pass: sender.authorizationCode },
    connectionTimeout: 8_000, greetingTimeout: 6_000, socketTimeout: 12_000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  try {
    const result = await transport.sendMail(mimeMessage(delivery));
    return { messageId: result.messageId, rejected: result.rejected.map(String) };
  } catch (error) {
    const details = error && typeof error === 'object' ? error as { code?: string; responseCode?: number; timeoutType?: string } : {};
    // SMTP 4xx/5xx is explicit rejection. A connection lost after DATA might have sent the message.
    const knownRejection = Boolean(
      (details.responseCode && details.responseCode >= 400 && details.responseCode < 600)
      || ['EAUTH', 'EDNS'].includes(details.code ?? '')
      || ['CONNECT_TIMEOUT', 'GREETING_TIMEOUT'].includes(details.timeoutType ?? ''),
    );
    throw new DeliveryError(knownRejection, details.code === 'EAUTH'
      ? '邮箱服务商拒绝了 SMTP 授权，请检查授权码和 SMTP 设置。'
      : '邮箱服务商暂时无法发送这封邮件。');
  } finally {
    transport.close();
  }
}
