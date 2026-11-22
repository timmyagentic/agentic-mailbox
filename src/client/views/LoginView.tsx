import {
  Archive,
  Eye,
  EyeOff,
  Keyboard,
  LockKeyhole,
  Mail,
  Paperclip,
  ShieldCheck,
} from 'lucide-react';
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
      <aside className="login-story" aria-labelledby="mailbox-title">
        <div className="login-brand">
          <div className="brand-mark brand-mark--large" aria-hidden="true">
            <Archive size={28} />
          </div>
          <div>
            <h1 id="mailbox-title">Agentic Mailbox</h1>
            <p>邮箱资产管理</p>
          </div>
        </div>

        <div className="login-story__copy">
          <span className="login-story__rule" aria-hidden="true" />
          <p>集中管理邮箱地址、纯文本邮件与附件。</p>
          <p>所有管理操作仅在认证会话中开放。</p>
        </div>

        <ul className="login-assurances" aria-label="管理端能力">
          <li>
            <span className="login-assurances__icon" aria-hidden="true">
              <Paperclip size={22} />
            </span>
            <span>
              <strong>私密附件保护</strong>
              <small>附件存储与访问均受管理员会话控制。</small>
            </span>
          </li>
          <li>
            <span className="login-assurances__icon" aria-hidden="true">
              <Mail size={22} />
            </span>
            <span>
              <strong>纯文本消息查看</strong>
              <small>邮件正文以纯文本呈现，降低内容执行风险。</small>
            </span>
          </li>
          <li>
            <span className="login-assurances__icon" aria-hidden="true">
              <ShieldCheck size={22} />
            </span>
            <span>
              <strong>受保护的管理员会话</strong>
              <small>登录后才可访问邮箱、邮件与附件数据。</small>
            </span>
          </li>
        </ul>

        <footer className="login-story__footer">
          <span className="status-dot" aria-hidden="true" />
          <span>服务就绪</span>
          <span aria-hidden="true">·</span>
          <span>Cloudflare Workers</span>
        </footer>
      </aside>

      <section className="login-access" aria-labelledby="login-title">
        <div className="login-panel">
          <p className="login-kicker" lang="en">PRIVATE ADMIN WORKSPACE</p>
          <h2 id="login-title">管理员登录</h2>
          <p className="login-intro">输入管理员密码以进入管理端</p>

          <form onSubmit={submit} className="login-form" aria-busy={busy}>
            <label htmlFor="admin-password">管理员密码</label>
            <div className="password-field">
              <LockKeyhole size={18} aria-hidden="true" />
              <input
                id="admin-password"
                type={visible ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="输入管理员密码"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'login-error' : undefined}
                autoFocus
                required
              />
              <button
                className="icon-button"
                type="button"
                onClick={() => setVisible((current) => !current)}
                title={visible ? '隐藏密码' : '显示密码'}
                aria-label={visible ? '隐藏密码' : '显示密码'}
                aria-pressed={visible}
              >
                {visible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
              </button>
            </div>
            {error ? <div id="login-error" className="form-error" role="alert">{error}</div> : null}
            <button className="button button--primary button--full" type="submit" disabled={busy || !password}>
              {busy ? '登录中...' : '进入管理端'}
            </button>
          </form>

          <p className="login-submit-hint">
            <Keyboard size={17} aria-hidden="true" />
            按 Enter 提交
          </p>
          <footer className="login-footer">
            <ShieldCheck size={15} aria-hidden="true" />
            <span>认证成功后建立受保护的管理会话</span>
          </footer>
        </div>
      </section>
    </main>
  );
}
