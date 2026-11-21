// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/client/App';
import { ApiRequestError, mailboxApi } from '../../src/client/api';
import type { BootstrapPayload, Conversation, EmailDetail, EmailSummary } from '../../src/shared/types';

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

beforeAll(async () => {
  await import('../../src/client/workbench/InboxWorkbench');
});

beforeEach(() => {
  vi.resetAllMocks();
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  vi.mocked(mailboxApi.session).mockResolvedValue({ authenticated: true, user: { email: 'admin@example.com' } });
  vi.mocked(mailboxApi.bootstrap).mockResolvedValue(bootstrap);
  vi.mocked(mailboxApi.aliases).mockResolvedValue({ aliases: [] });
  vi.mocked(mailboxApi.emails).mockResolvedValue({ emails: [email] });
  vi.mocked(mailboxApi.conversations).mockImplementation(async () => {
    const { emails } = await mailboxApi.emails();
    return {
      total: emails.length,
      conversations: emails.map((item: EmailSummary) => ({
        ...item, threadCount: 1, unreadCount: item.readAt ? 0 : 1, starred: false, outgoing: false,
      })),
    };
  });
  vi.mocked(mailboxApi.conversation).mockResolvedValue({ messages: [email], total: 1 });
  vi.mocked(mailboxApi.markConversation).mockResolvedValue({ ok: true });
  vi.mocked(mailboxApi.drafts).mockResolvedValue({ drafts: [] });
  vi.mocked(mailboxApi.files).mockResolvedValue({ files: [] });
  vi.mocked(mailboxApi.email).mockResolvedValue({ email });
  vi.mocked(mailboxApi.setEmailRead).mockResolvedValue({ ok: true });
});
afterEach(cleanup);

async function overview() {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '概览' }));
  await screen.findByRole('button', { name: /测试邮件/ });
}

describe('mail reading and failure recovery', () => {
  it('opens the inbox and the message when clicking a recent message in overview', async () => {
    await overview();
    fireEvent.click(screen.getByRole('button', { name: /测试邮件/ }));
    await screen.findByText(email.bodyText);
    expect(screen.getByRole('heading', { name: '收件箱' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '邮件会话' })).toBeTruthy();
  });

  it('keeps a slow message closed and unread after dismissing its loading dialog', async () => {
    await overview();
    fireEvent.click(screen.getByRole('button', { name: /查看全部/ }));
    let resolve!: (value: Conversation) => void;
    vi.mocked(mailboxApi.conversation).mockReturnValue(new Promise((done) => { resolve = done; }));
    fireEvent.click(await screen.findByRole('button', { name: /测试邮件/ }));
    await screen.findByText('正在加载邮件');
    fireEvent.click(screen.getByRole('button', { name: '关闭会话' }));
    await act(async () => { resolve({ messages: [email], total: 1 }); });
    expect(screen.queryByRole('region', { name: '邮件会话' })).toBeNull();
    expect(mailboxApi.markConversation).not.toHaveBeenCalled();
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
    await screen.findByRole('heading', { name: '收件箱' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('数据加载失败'));
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

it('refreshes all four connected mailboxes in one click and displays an individual failure', async () => {
  const mailAccounts = [
    { id: 'qq', provider: 'qq' as const, address: 'owner@qq.com', lastSyncAt: null },
    { id: '163', provider: 'netease163' as const, address: 'owner@163.com', lastSyncAt: null },
    { id: 'gmail', provider: 'gmail' as const, address: 'owner@gmail.com', lastSyncAt: null },
    { id: 'outlook', provider: 'outlook' as const, address: 'owner@outlook.com', lastSyncAt: null },
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
  expect(mailboxApi.refreshMailAccount).toHaveBeenCalledTimes(4);
  expect(mailboxApi.refreshMailAccount).toHaveBeenCalledWith('qq');
  expect(mailboxApi.refreshMailAccount).toHaveBeenCalledWith('163');
  expect(mailboxApi.refreshMailAccount).toHaveBeenCalledWith('gmail');
  expect(mailboxApi.refreshMailAccount).toHaveBeenCalledWith('outlook');
  fireEvent.click(screen.getByRole('button', { name: '邮箱设置' }));
  await screen.findByText('邮箱授权失败');
  fireEvent.click(screen.getByRole('button', { name: /^收件箱/ }));

  vi.mocked(mailboxApi.emails).mockResolvedValue({ emails: [
    { ...email, id: 'older-163', aliasId: '163', aliasAddress: 'owner@163.com', subject: '163 历史邮件' },
  ] });
  fireEvent.change(screen.getByLabelText('筛选邮箱'), { target: { value: '163' } });
  await screen.findByRole('button', { name: /163 历史邮件/ });
  expect(mailboxApi.conversations).toHaveBeenCalledWith(expect.objectContaining({ aliasId: '163' }));
  expect(screen.queryByRole('button', { name: /QQ 新邮件/ })).toBeNull();
});

it('can sign in with a device certificate without entering a password', async () => {
  vi.mocked(mailboxApi.session).mockResolvedValue({ authenticated: false, user: null });
  vi.mocked(mailboxApi.loginWithCertificate).mockResolvedValue({ authenticated: true, user: { email: 'admin@example.com' } });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '使用设备证书登录' }));
  await screen.findByRole('heading', { name: '收件箱' });
  expect(mailboxApi.loginWithCertificate).toHaveBeenCalledTimes(1);
  expect(mailboxApi.login).not.toHaveBeenCalled();
});

it('offers the first sync from the page after a successful OAuth callback', async () => {
  const account = { id: 'new-outlook', address: 'owner@outlook.com', provider: 'outlook' as const, lastSyncAt: null };
  vi.mocked(mailboxApi.bootstrap).mockResolvedValue({ ...bootstrap, mailAccounts: [account], oauthProviders: ['outlook'] });
  vi.mocked(mailboxApi.finishMailOAuth).mockResolvedValue({ ok: true });
  vi.mocked(mailboxApi.refreshMailAccount).mockResolvedValue({
    result: { id: account.id, imported: 1, oversized: 0, hasMore: false, lastSyncAt: null },
  });
  window.history.replaceState(null, '', '/#mailOAuth=outlook&state=state-fixture&code=authorization-fixture');
  render(<App />);
  expect(await screen.findByText('Outlook 已连接')).toBeTruthy();
  expect(window.location.hash).toBe('');
  expect(mailboxApi.finishMailOAuth).toHaveBeenCalledExactlyOnceWith('outlook', {
    state: 'state-fixture', code: 'authorization-fixture', error: null,
  });
  fireEvent.click(screen.getByRole('button', { name: '同步邮件' }));
  await waitFor(() => expect(mailboxApi.refreshMailAccount).toHaveBeenCalledWith(account.id));
  await screen.findByText('同步了 1 封邮件。');
});

it('shows provider setup instead of a disabled OAuth button and rechecks readiness in the same dialog', async () => {
  vi.mocked(mailboxApi.emails).mockResolvedValue({ emails: [] });
  vi.mocked(mailboxApi.bootstrap).mockResolvedValueOnce(bootstrap)
    .mockResolvedValue({ ...bootstrap, oauthProviders: ['gmail'] });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '接入邮箱' }));
  const dialog = screen.getByRole('dialog', { name: '接入邮箱' });
  fireEvent.click(within(dialog).getByRole('button', { name: /Gmail/ }));
  expect(within(dialog).getByText('Gmail 尚未启用。')).toBeTruthy();
  expect(within(dialog).getByRole('link', { name: '打开 Google Cloud' }).getAttribute('href')).toContain('console.cloud.google.com');
  expect(within(dialog).queryByLabelText('客户端授权码')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: '重新检查' }));
  expect(await within(dialog).findByRole('button', { name: '使用 Google 继续' })).toBeTruthy();
  expect(mailboxApi.startMailOAuth).not.toHaveBeenCalled();
});

it('retries a cancelled reauthorization for the original account', async () => {
  const account = { id: 'existing-outlook', address: 'owner@outlook.com', provider: 'outlook' as const, lastSyncAt: null };
  vi.mocked(mailboxApi.bootstrap).mockResolvedValue({ ...bootstrap, mailAccounts: [account], oauthProviders: ['outlook'] });
  vi.mocked(mailboxApi.finishMailOAuth).mockRejectedValue(new ApiRequestError(400, 'oauth_authorization_cancelled', '邮箱授权未完成。'));
  vi.mocked(mailboxApi.startMailOAuth).mockRejectedValue(new Error('模拟服务暂不可用'));
  window.sessionStorage.setItem('mailbox-vault-oauth-reconnect', 'outlook:' + account.id);
  window.history.replaceState(null, '', '/#mailOAuth=outlook&state=state-fixture&error=access_denied');
  render(<App />);
  await screen.findByText('Outlook 授权已取消');
  fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
  const dialog = screen.getByRole('dialog', { name: '重新授权 Outlook' });
  fireEvent.click(within(dialog).getByRole('button', { name: '使用 Microsoft 继续' }));
  expect(within(dialog).getByText(account.address)).toBeTruthy();
  await within(dialog).findByRole('alert');
  expect(mailboxApi.startMailOAuth).toHaveBeenCalledExactlyOnceWith('outlook', account.id);
});

it('shows the selected IMAP guide and only saves an address for that provider', async () => {
  vi.mocked(mailboxApi.saveMailAccount).mockResolvedValue({
    account: { id: 'foxmail', provider: 'qq', address: 'owner@foxmail.com', lastSyncAt: null },
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '邮箱设置' }));
  fireEvent.click(screen.getByRole('button', { name: '接入邮箱' }));
  const dialog = screen.getByRole('dialog', { name: '接入邮箱' });
  fireEvent.click(within(dialog).getByRole('button', { name: /网易 163 邮箱/ }));
  expect(within(dialog).getByText(/新增授权密码/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: '选择其他邮箱' }));
  fireEvent.click(within(dialog).getByRole('button', { name: /QQ 邮箱/ }));
  expect(within(dialog).queryByRole('button', { name: '使用 Google 继续' })).toBeNull();
  fireEvent.change(within(dialog).getByLabelText('邮箱地址'), { target: { value: 'owner@163.com' } });
  fireEvent.change(within(dialog).getByLabelText('客户端授权码'), { target: { value: 'ABCDEFGHIJKLMNOP' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '连接邮箱' }));
  expect(await within(dialog).findByRole('alert')).toBeTruthy();
  expect(mailboxApi.saveMailAccount).not.toHaveBeenCalled();
  fireEvent.change(within(dialog).getByLabelText('邮箱地址'), { target: { value: 'owner@foxmail.com' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '连接邮箱' }));
  await screen.findByText('QQ 邮箱 已连接');
  expect(mailboxApi.saveMailAccount).toHaveBeenCalledExactlyOnceWith({
    email: 'owner@foxmail.com', authorizationCode: 'ABCDEFGHIJKLMNOP',
  });
});
