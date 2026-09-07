// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/client/App';
import { ApiRequestError, mailboxApi } from '../../src/client/api';
import type { BootstrapPayload, EmailDetail } from '../../src/shared/types';

vi.mock('../../src/client/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/client/api')>();
  return { ...original, mailboxApi: Object.fromEntries(Object.keys(original.mailboxApi).map((key) => [key, vi.fn()])) };
});

const email: EmailDetail = {
  id: 'email-1', aliasId: 'alias-1', aliasAddress: 'test@example.com', aliasLabel: 'Test',
  fromAddress: 'sender@example.com', fromName: 'Test Sender', toAddress: 'test@example.com',
  subject: '测试邮件', preview: '测试正文', receivedAt: '2026-09-05T12:00:00Z', readAt: null,
  rawSize: 100, attachmentCount: 0, messageId: 'test-message', bodyText: '这是测试邮件正文。', sentAt: null, attachments: [],
};
const bootstrap: BootstrapPayload = {
  appName: 'Mailbox Vault', primaryDomain: 'example.com', adminEmail: 'admin@example.com',
  stats: { aliasCount: 1, activeAliasCount: 1, emailCount: 1, unreadCount: 1, attachmentCount: 0, attachmentBytes: 0 },
  recentEmails: [email], recentAliases: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  vi.mocked(mailboxApi.session).mockResolvedValue({ authenticated: true, user: { email: 'admin@example.com' } });
  vi.mocked(mailboxApi.bootstrap).mockResolvedValue(bootstrap);
  vi.mocked(mailboxApi.aliases).mockResolvedValue({ aliases: [] });
  vi.mocked(mailboxApi.emails).mockResolvedValue({ emails: [email] });
  vi.mocked(mailboxApi.files).mockResolvedValue({ files: [] });
  vi.mocked(mailboxApi.email).mockResolvedValue({ email });
  vi.mocked(mailboxApi.setEmailRead).mockResolvedValue({ ok: true });
});
afterEach(cleanup);

async function overview() {
  render(<App />);
  await screen.findByRole('button', { name: /测试邮件/ });
}

describe('mail reading and failure recovery', () => {
  it('opens the inbox and the message when clicking a recent message in overview', async () => {
    await overview();
    fireEvent.click(screen.getByRole('button', { name: /测试邮件/ }));
    await screen.findByText(email.bodyText);
    expect(screen.getByRole('heading', { name: '收件箱' })).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('keeps a slow message closed and unread after dismissing its loading dialog', async () => {
    await overview();
    fireEvent.click(screen.getByRole('button', { name: /查看全部/ }));
    let resolve!: (value: { email: EmailDetail }) => void;
    vi.mocked(mailboxApi.email).mockReturnValue(new Promise((done) => { resolve = done; }));
    fireEvent.click(screen.getByRole('button', { name: /测试邮件/ }));
    await screen.findByText('正在加载邮件');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await act(async () => { resolve({ email }); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mailboxApi.setEmailRead).not.toHaveBeenCalled();
  });

  it('shows session expiry on the login screen instead of hiding the error', async () => {
    await overview();
    fireEvent.click(screen.getByRole('button', { name: /查看全部/ }));
    vi.mocked(mailboxApi.bootstrap).mockRejectedValue(new ApiRequestError(401, 'authentication_required', '请先登录管理端。'));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByRole('heading', { name: '管理员登录' });
    expect(screen.getByRole('alert').textContent).toContain('请先登录管理端');
  });

  it('shows data-load failures after a successful login and allows retrying refresh', async () => {
    vi.mocked(mailboxApi.session).mockResolvedValue({ authenticated: false, user: null });
    vi.mocked(mailboxApi.login).mockResolvedValue({ authenticated: true, user: { email: 'admin@example.com' } });
    vi.mocked(mailboxApi.bootstrap).mockRejectedValueOnce(new ApiRequestError(500, 'internal_error', '数据加载失败，请重试。'));
    render(<App />);
    fireEvent.change(await screen.findByLabelText('管理员密码'), { target: { value: 'local-test-password' } });
    fireEvent.click(screen.getByRole('button', { name: '进入管理端' }));
    await screen.findByRole('heading', { name: '邮箱概览' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('数据加载失败'));
    fireEvent.click(screen.getByRole('button', { name: /查看全部/ }));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByRole('button', { name: /测试邮件/ });
  });
});

it('keeps the session visible and reports failed logout instead of pretending it succeeded', async () => {
  await overview();
  vi.mocked(mailboxApi.logout).mockRejectedValue(new ApiRequestError(0, 'network_error', '网络连接失败，请重试。'));
  fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
  await screen.findByRole('status');
  expect(screen.getByRole('heading', { name: '邮箱概览' })).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('网络连接失败');
});
