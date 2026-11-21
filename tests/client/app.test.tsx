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
  recentEmails: [email], recentAliases: [], mailAccounts: [],
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
    fireEvent.click(screen.getByRole('button', { name: '一键刷新' }));
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
    fireEvent.click(screen.getByRole('button', { name: '一键刷新' }));
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

it('refreshes both connected mailboxes in one click and displays an individual failure', async () => {
  const mailAccounts = [
    { id: 'qq', provider: 'qq' as const, address: 'owner@qq.com', lastSyncAt: null },
    { id: '163', provider: 'netease163' as const, address: 'owner@163.com', lastSyncAt: null },
  ];
  vi.mocked(mailboxApi.bootstrap).mockResolvedValue({ ...bootstrap, mailAccounts });
  vi.mocked(mailboxApi.refreshMailAccount).mockImplementation(async (id) => ({
    result: {
      id, imported: id === 'qq' ? 1 : 0, oversized: 0, hasMore: false, lastSyncAt: null,
      error: id === '163' ? '邮箱授权失败' : undefined,
    },
  }));

  await overview();
  fireEvent.click(screen.getByRole('button', { name: /查看全部/ }));
  vi.mocked(mailboxApi.emails).mockResolvedValue({ emails: [
    email, { ...email, id: 'qq-synced', aliasId: 'qq', aliasAddress: 'owner@qq.com', subject: 'QQ 新邮件' },
  ] });
  fireEvent.click(screen.getByRole('button', { name: '一键刷新' }));
  await screen.findByRole('button', { name: /QQ 新邮件/ });
  expect(mailboxApi.refreshMailAccount).toHaveBeenCalledTimes(2);
  expect(mailboxApi.refreshMailAccount).toHaveBeenCalledWith('qq');
  expect(mailboxApi.refreshMailAccount).toHaveBeenCalledWith('163');
  expect(screen.getByText('邮箱授权失败')).toBeTruthy();

  vi.mocked(mailboxApi.emails).mockResolvedValue({ emails: [
    { ...email, id: 'older-163', aliasId: '163', aliasAddress: 'owner@163.com', subject: '163 历史邮件' },
  ] });
  fireEvent.change(screen.getByLabelText('筛选邮箱'), { target: { value: '163' } });
  await screen.findByRole('button', { name: /163 历史邮件/ });
  expect(mailboxApi.emails).toHaveBeenCalledWith(expect.objectContaining({ aliasId: '163' }));
  expect(screen.queryByRole('button', { name: /QQ 新邮件/ })).toBeNull();
});

it('can sign in with a device certificate without entering a password', async () => {
  vi.mocked(mailboxApi.session).mockResolvedValue({ authenticated: false, user: null });
  vi.mocked(mailboxApi.loginWithCertificate).mockResolvedValue({ authenticated: true, user: { email: 'admin@example.com' } });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '使用设备证书登录' }));
  await screen.findByRole('heading', { name: '邮箱概览' });
  expect(mailboxApi.loginWithCertificate).toHaveBeenCalledTimes(1);
  expect(mailboxApi.login).not.toHaveBeenCalled();
});
