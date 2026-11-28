import { presetHosts, type MailboxProfile, type Server } from '../../shared/mailbox';
import { internetMailbox } from '../../shared/validation';
import { HttpError } from '../http';
import type { SessionEnv } from '../types';

export interface RelayEnv extends SessionEnv {
  MAIL_ACCOUNT_KEY: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
}

export function invalid(message: string): never {
  throw new HttpError(400, 'invalid_setup', message);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, limit = 254): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > limit ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
  ) {
    invalid('请检查地址、服务器和登录信息。');
  }
  return value.trim();
}

function customServer(value: unknown): Server {
  const { host, port, tls } = record(value);
  const hostname = text(host, 253).toLowerCase();
  if (!hostname.split('.').every((s) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s)))
    invalid('请输入邮件服务器主机名。');
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 || port === 25)
    invalid('请输入可用的邮件提交或收信端口。');
  if (tls !== 'implicit' && tls !== 'starttls') invalid('请选择 TLS 连接方式。');
  return { host: hostname, port, tls };
}

function password(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\r\n\0]/.test(value))
    invalid('请输入邮箱的客户端授权码或专用密码。');
  return value;
}

export function googleEnabled(env: RelayEnv) {
  return Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN);
}

export function parseSetup(input: unknown, env: RelayEnv) {
  const data = record(input);
  const provider = data.provider;
  if (provider !== 'gmail' && provider !== 'qq' && provider !== '163' && provider !== 'custom')
    invalid('请选择邮箱服务商。');
  const address = internetMailbox(data.address);
  const destination = internetMailbox(data.destination);
  if (!address || !destination || address.toLowerCase() === destination.toLowerCase())
    invalid('请填写有效且不同的中转邮箱和目标邮箱。');
  const custom = provider === 'custom';
  const hosts = custom ? null : presetHosts[provider];
  const auth = data.auth === 'google' ? 'google' : 'password';
  if (auth === 'google' && (provider !== 'gmail' || !googleEnabled(env)))
    invalid('请先完成此实例的 Google 授权。');
  const profile: MailboxProfile = {
    provider,
    address,
    destination,
    name: data.name ? text(data.name, 80) : '',
    auth,
    imap: hosts ? { host: hosts.imap, port: 993, tls: 'implicit' } : customServer(data.imap),
    smtp: hosts ? { host: hosts.smtp, port: 465, tls: 'implicit' } : customServer(data.smtp),
    imapUser: custom && data.imapUser ? text(data.imapUser) : address,
    smtpUser: custom && data.smtpUser ? text(data.smtpUser) : address,
  };
  const imapPassword = auth === 'google' ? '' : password(data.password);
  const smtpPassword = custom && data.smtpPassword ? password(data.smtpPassword) : imapPassword;
  return { profile, passwords: { imapPassword, smtpPassword } };
}

export function sourceKey(p: MailboxProfile) {
  return JSON.stringify([p.imap.host, p.imap.port, p.imapUser.toLowerCase(), p.address.toLowerCase()]);
}
