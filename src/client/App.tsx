import { useEffect, useState, type FormEvent } from 'react';
import type { SessionPayload } from '../shared/types';
import { api } from './api';
import Forwarding from './Forwarding';

type Mode = 'member' | 'admin' | 'register';

function Login({ hosted, onLogin }: { hosted: boolean; onLogin: () => Promise<void> }) {
  const [mode, setMode] = useState<Mode>(hosted ? 'member' : 'admin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(certificate: boolean) {
    setBusy(true); setError('');
    try {
      const path = certificate ? '/api/session/certificate' : mode === 'admin' ? '/api/session' :
        '/api/members/' + (mode === 'register' ? 'register' : 'login');
      await api(path, { method: 'POST', body: JSON.stringify(certificate ? {} : { username, password }) });
      await onLogin();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function change(next: Mode) { setMode(next); setPassword(''); setError(''); }
  function onSubmit(event: FormEvent) { event.preventDefault(); void submit(false); }
  return <main className="login">
    <h1>{mode === 'register' ? '创建转发账号' : mode === 'admin' ? '管理员登录' : '登录转发设置'}</h1>
    <p>选择一个常用邮箱，以后在那里接收新邮件。</p>
    <form onSubmit={onSubmit}>
      <fieldset disabled={busy}>
        {mode !== 'admin' && <label>用户名<input required autoComplete="username" minLength={3} maxLength={40}
          pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{2,39}" title="3–40 位字母、数字、短横线或下划线"
          value={username} onChange={e => setUsername(e.target.value)} /></label>}
        <label>{mode === 'register' ? '密码（至少 12 位）' : '密码'}<input required type="password"
          minLength={mode === 'register' ? 12 : undefined} autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          value={password} onChange={e => setPassword(e.target.value)} /></label>
        {error && <p role="alert">{error}</p>}
        <button className="primary">{busy ? '请稍候…' : mode === 'register' ? '创建账号' : '登录'}</button>
        {mode === 'admin' && <button type="button" onClick={() => void submit(true)}>使用设备证书登录</button>}
      </fieldset>
    </form>
    {hosted && <nav aria-label="登录方式">
      {(['member', 'register', 'admin'] as const).filter(item => item !== mode).map(item =>
        <button key={item} disabled={busy} className="link" onClick={() => change(item)}>
          {{ member: '个人登录', register: '注册账号', admin: '管理员登录' }[item]}</button>)}
    </nav>}
  </main>;
}

export default function App() {
  const [session, setSession] = useState<SessionPayload>();
  const [error, setError] = useState('');
  async function refresh() {
    setSession(await api<SessionPayload>('/api/session')); setError('');
  }
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, []);
  async function logout() {
    try { await api('/api/session', { method: 'DELETE' }); await refresh(); }
    catch (e) { setError((e as Error).message); }
  }
  return <>
    <header><div className="bar"><span className="brand"><span className="mark" aria-hidden="true">↗</span>Agentic Mailbox</span>
      {session?.authenticated && <button className="link" onClick={() => void logout()}>退出登录</button>}</div></header>
    {error && <div className="notice" role="alert">{error} <button onClick={() => void refresh().catch(e => setError(e.message))}>重新连接</button></div>}
    {session?.authenticated ? <Forwarding admin={Boolean(session.admin)} /> :
      session ? <Login hosted={session.edition === 'hosted'} onLogin={refresh} /> :
        !error && <main><p role="status">正在连接转发服务…</p></main>}
  </>;
}
