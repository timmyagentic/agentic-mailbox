import { Archive, Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { type FormEvent, useState } from 'react';

type LoginViewProps = {
  error: string;
  busy: boolean;
  onLogin: (password: string) => Promise<void>;
};

export function LoginView({ error, busy, onLogin }: LoginViewProps) {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onLogin(password);
  };

  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-brand">
          <div className="brand-mark brand-mark--large">
            <Archive size={23} />
          </div>
          <div>
            <h1>Mailbox Vault</h1>
            <p>邮箱资产管理</p>
          </div>
        </div>

        <form onSubmit={submit} className="login-form">
          <label htmlFor="admin-password">管理员密码</label>
          <div className="password-field">
            <LockKeyhole size={18} aria-hidden="true" />
            <input
              id="admin-password"
              type={visible ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
              required
            />
            <button
              className="icon-button"
              type="button"
              onClick={() => setVisible((current) => !current)}
              title={visible ? '隐藏密码' : '显示密码'}
              aria-label={visible ? '隐藏密码' : '显示密码'}
            >
              {visible ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
          {error ? <div className="form-error" role="alert">{error}</div> : null}
          <button className="button button--primary button--full" type="submit" disabled={busy || !password}>
            {busy ? '登录中...' : '进入管理端'}
          </button>
        </form>

        <footer className="login-footer">
          <span className="status-dot" />
          <span>Cloudflare Workers</span>
        </footer>
      </section>
    </main>
  );
}
