// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import Forwarding from '../../src/client/Forwarding';
import type { ForwardingSettings } from '../../src/shared/types';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('saves the relay display name and can return to original-message forwarding', async () => {
  const settings: ForwardingSettings = { relay: 'relay-abc@example.net', destination: 'reader@example.org',
    senderName: null, senderAddress: 'hello@sender.example.net', pending: null, step: null };
  const calls: unknown[] = [];
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (path === '/api/forwarding/sources') return Response.json({ sources: [] });
    if (path === '/api/forwarding/sender') {
      expect(init?.method).toBe('PUT');
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      settings.senderName = body.name;
    }
    return Response.json(settings);
  });

  render(<Forwarding admin={false} />);
  fireEvent.click(await screen.findByText('设置代发身份'));
  expect(screen.getByText(settings.senderAddress)).toBeTruthy();
  expect(screen.getByLabelText('专属中转地址').textContent).toBe(settings.relay);
  fireEvent.change(screen.getByLabelText('发件人显示名'), { target: { value: '  Example Relay  ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存发件人' }));
  await screen.findByText('代发身份 · Example Relay');
  fireEvent.change(screen.getByLabelText('发件人显示名'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '保存发件人' }));
  await waitFor(() => expect(calls).toEqual([{ name: 'Example Relay' }, { name: null }]));
  await screen.findByText('设置代发身份');
});
