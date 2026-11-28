import { useEffect, useState, type FormEvent } from 'react';
import type { ForwardingSettings, LegacySource } from '../shared/types';
import { api } from './api';
import Aliases from './Aliases';

function Sources({ relay, active }: { relay: string; active: boolean }) {
  const [sources, setSources] = useState<LegacySource[]>([]);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api<{ sources: LegacySource[] }>('/api/forwarding/sources').then(data => setSources(data.sources)).catch(e => setError(e.message));
  }, []);
  return <section aria-labelledby="sources-heading">
    <h2 id="sources-heading">接入来源邮箱</h2>
    <p>{active ? '在每个来源邮箱开启自动转发，收件地址填写下方的中转地址。以后更换目标邮箱时，这些规则可以继续使用。' :
      '先确认目标邮箱，再到每个来源邮箱设置自动转发。来源服务商发来的确认信也会转到你的目标邮箱。'}</p>
    <label htmlFor="relay">专属中转地址</label>
    <div className="row relay"><output id="relay" className="address">{relay}</output>
      <button onClick={async () => {
        try { await navigator.clipboard.writeText(relay); setCopied(true); }
        catch {
          const node = document.getElementById('relay');
          if (node) {
            const range = document.createRange(); range.selectNodeContents(node);
            const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
          }
        }
      }}>{copied ? '已复制' : '复制地址'}</button></div>
    <details><summary>查看各邮箱的设置方法</summary><ul className="guide">
      <li><strong>QQ 邮箱 / 网易 163</strong>登录网页版，在设置里找到自动转发或来信规则，按服务商要求验证并保存。部分账号可能没有外部转发权限。</li>
      <li><strong>Gmail</strong>打开网页版的“转发和 POP/IMAP”，添加中转地址。在目标邮箱确认后，回到 Gmail 启用转发并保存。</li>
      <li><strong>Outlook</strong>打开网页版“设置 → 邮件 → 转发”，启用转发并保存。组织邮箱可能需要管理员允许外部转发。</li>
    </ul><p>只设置来源邮箱。请勿把最终收件邮箱的邮件转回中转地址。</p></details>
    {sources.length > 0 && <p>旧版曾连接以下来源，请逐个到服务商开启转发。<br/>{sources.map(s => s.address).join('、')}</p>}
    {error && <p role="alert">旧版来源列表读取失败。{error}</p>}
  </section>;
}

export default function Forwarding({ admin }: { admin: boolean }) {
  const [settings, setSettings] = useState<ForwardingSettings>();
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  function load() { return api<ForwardingSettings>('/api/forwarding').then(setSettings); }
  useEffect(() => { void load().catch(e => setError(e.message)); }, []);
  async function change(path: string, method: string, body: object) {
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await api<ForwardingSettings>('/api/forwarding/' + path, { method, body: JSON.stringify(body) });
      setSettings(next);
      if (path === 'sender') setNotice('发件人身份已保存。');
      else { setCode(''); setAddress(''); }
      if (path === 'confirm') setNotice('目标邮箱已启用，新来信将转发到这里。');
      if (method === 'DELETE') setNotice('已取消此次更换。');
      if (path === 'verify' && next.step === 'provider') setNotice('Cloudflare 尚未确认。请先打开目标邮箱中的验证链接。');
      if (path === 'verify' && next.step === 'code') setNotice('请查看目标邮箱最近收到的确认码。');
    } catch (e) {
      setError((e as Error).message);
      await load().catch(() => {});
    } finally { setBusy(false); }
  }
  function submitAddress(e: FormEvent) { e.preventDefault(); void change('destination', 'PUT', { address }); }
  function submitCode(e: FormEvent) { e.preventDefault(); void change('confirm', 'POST', { code }); }
  return <main className="settings"><h1>邮件转发</h1>
    <section aria-labelledby="target-heading"><h2 id="target-heading">目标邮箱</h2>
      {!settings && !error && <p role="status">正在读取设置…</p>}
      {settings && <>
        {settings.destination ? <p className="current"><span className="dot" />正在转发至 <strong>{settings.destination}</strong></p>
          : <p>填写你日常使用的收件地址，例如 Gmail。验证完成后，新邮件会投递到那里。</p>}
        <fieldset disabled={busy}>
          {settings.pending ? <div className="pending">
            <p>等待确认 <strong>{settings.pending}</strong></p>
            {settings.step === 'provider' ? <>
              <p>打开 Cloudflare 发到这个邮箱的验证邮件，点击验证链接后再继续。</p>
              <button className="primary" onClick={() => void change('verify', 'POST', { address: settings.pending })}>已验证，获取确认码</button>
            </> : <form onSubmit={submitCode}>
              <label htmlFor="code">目标邮箱收到的 12 位确认码</label><div className="row">
                <input id="code" value={code} autoComplete="one-time-code" autoCapitalize="characters" required maxLength={12}
                  pattern="[a-fA-F0-9]{12}" onChange={e => setCode(e.target.value)} />
                <button className="primary">确认启用</button></div>
              <button type="button" className="link" onClick={() => void change('verify', 'POST', { address: settings.pending })}>重新获取确认码</button>
            </form>}
            <button className="link" onClick={() => void change('destination', 'DELETE', {})}>取消更换</button>
          </div> : <form onSubmit={submitAddress}>
            <label htmlFor="destination">{settings.destination ? '更换为' : '收件地址'}</label>
            <div className="row"><input id="destination" type="email" autoComplete="email" placeholder="you@gmail.com"
              required maxLength={90} value={address} onChange={e => setAddress(e.target.value)} />
              <button className="primary">验证邮箱</button></div>
          </form>}
          <details>
            <summary>{settings.senderName ? `代发身份 · ${settings.senderName}` : '设置代发身份'}</summary>
            <p>填写名称后，服务会用 <strong>{settings.senderAddress}</strong> 给目标邮箱重新寄信。留空并保存可恢复原样转发。</p>
            <form onSubmit={e => {
              e.preventDefault();
              const name = String(new FormData(e.currentTarget).get('name') ?? '').trim();
              void change('sender', 'PUT', { name: name || null });
            }}>
              <label htmlFor="relay-sender">发件人显示名</label>
              <div className="row"><input key={settings.senderName ?? ''} id="relay-sender" name="name" maxLength={80}
                defaultValue={settings.senderName ?? ''} /><button>保存发件人</button></div>
            </form>
          </details>
        </fieldset>
      </>}
      {busy && <p role="status">正在处理…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error} {!settings && <button onClick={() => void load().then(() => setError('')).catch(e => setError(e.message))}>重试</button>}</p>}
    </section>
    {settings && <Sources relay={settings.relay} active={Boolean(settings.destination)} />}
    {admin && <Aliases />}
  </main>;
}
