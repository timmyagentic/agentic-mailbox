// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import MailboxRelay from '../../src/client/MailboxRelay';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('shows presets and submits the custom endpoints, then requires the code sent by SMTP', async () => {
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (path.endsWith('/setup')) {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({
        active: null,
        pending: { id: 'id', destination: 'target@example.net' },
        googleEnabled: false,
      });
    }
    return Response.json({ active: null, pending: null, googleEnabled: false });
  });
  render(<MailboxRelay />);
  const preset = await screen.findByLabelText('邮箱服务商');
  for (const [value, hostname] of [
    ['qq', 'imap.qq.com'],
    ['163', 'imap.163.com'],
    ['gmail', 'imap.gmail.com'],
  ]) {
    fireEvent.change(preset, { target: { value } });
    expect(screen.getByText(new RegExp(hostname))).toBeTruthy();
  }
  fireEvent.change(preset, { target: { value: 'custom' } });
  function fill(element: HTMLElement, value: string) {
    fireEvent.change(element, { target: { value } });
  }
  fill(screen.getByLabelText('中转邮箱'), 'relay@example.org');
  fill(screen.getByLabelText('目标邮箱'), 'target@example.net');
  fill(screen.getByLabelText('客户端授权码或专用密码'), 'fixture');
  fill(
    within(screen.getByRole('group', { name: 'IMAP 服务器' })).getByLabelText('主机名'),
    'imap.example.org',
  );
  const smtp = within(screen.getByRole('group', { name: 'SMTP 服务器' }));
  fill(smtp.getByLabelText('主机名'), 'smtp.example.org');
  fill(smtp.getByLabelText('端口'), '587');
  fill(smtp.getByLabelText('加密方式'), 'starttls');
  fireEvent.click(screen.getByRole('button', { name: '连接并发送确认码' }));
  expect(await screen.findByLabelText('12 位确认码')).toBeTruthy();
  expect(calls[0]).toMatchObject({
    provider: 'custom',
    smtp: { host: 'smtp.example.org', port: 587, tls: 'starttls' },
  });
});

it.each([
  ['idle', '正在监听来信 · IMAP IDLE'],
  ['poll', '正在检查来信 · 每 10 秒'],
  [null, '等待监听任务启动'],
] as const)('shows the negotiated receiving mode %s', async (listener, label) => {
  vi.stubGlobal('fetch', async () =>
    Response.json({
      googleEnabled: false,
      pending: null,
      active: {
        profile: { address: 'relay@example.org', destination: 'target@example.net' },
        generation: 'test',
        uidValidity: '42',
        inFlight: null,
        checkedAt: null,
        sentAt: null,
        issue: null,
        busy: false,
        listener,
      },
    }),
  );
  render(<MailboxRelay />);
  expect(await screen.findByText(label)).toBeTruthy();
});
