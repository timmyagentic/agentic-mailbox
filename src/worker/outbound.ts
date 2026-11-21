import { Buffer } from 'node:buffer';
import nodemailer from 'nodemailer';
import type { MailProvider } from '../shared/types';
import { HttpError } from './http';
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
  attachments: { filename: string; contentType: string; content: ArrayBuffer }[];
};

export class DeliveryError extends Error {
  constructor(readonly retryable: boolean, message: string) { super(message); }
}

const smtpHosts: Record<MailProvider, string> = { qq: 'smtp.qq.com', netease163: 'smtp.163.com' };

export type Sender = { authorizationCode: string; provider: MailProvider; address: string };

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

  const transport = nodemailer.createTransport({
    host: smtpHosts[sender.provider], port: 465, secure: true,
    auth: { user: sender.address, pass: sender.authorizationCode },
    connectionTimeout: 8_000, greetingTimeout: 6_000, socketTimeout: 12_000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  try {
    const result = await transport.sendMail({
      from, to, cc, bcc, subject, text, html: html || undefined, headers, messageId: delivery.messageId,
      attachments: attachments.map((file) => ({
        filename: file.filename, contentType: file.contentType, content: Buffer.from(file.content),
      })),
    });
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
