import { Input } from '@heroui/react/input';
import { FormButton } from '../components/FormButton';
import {
  Archive,
  BadgeCheck,
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
  edition?: 'local' | 'hosted';
  onLogin: (password: string, member?: { username: string; register: boolean }) => Promise<void>;
  onCertificateLogin: () => Promise<void>;
  onChatGPTLogin?: () => void;
};

export function LoginView({ edition, error, busy, onLogin, onCertificateLogin, onChatGPTLogin }: LoginViewProps) {
  const [mode, setMode] = useState<'member' | 'register' | 'admin'>(edition === 'hosted' ? 'member' : 'admin');
  const [username, setUsername] = useState('');
  const member = mode !== 'admin';
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onLogin(password, member ? { username, register: mode === 'register' } : undefined);
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

          <h2 id="login-title">{mode === 'register' ? '创建个人邮箱空间' : member ? '登录个人邮箱空间' : edition === 'local' ? '本地邮箱' : '管理员登录'}</h2>
          <p className="login-intro">{member ? '邮件与附件仅在你的账号中可见。' : edition === 'local' ? '使用启动器打开，或输入本机密码。' : '使用管理员密码或设备证书登录'}</p>

          <form onSubmit={submit} className="login-form" aria-busy={busy}>
             {member && <label>用户名<Input render={(props) => <input {...props} className={undefined} />} value={username} required autoComplete="username" minLength={3} maxLength={40} title="3–40 位字母、数字、下划线或短横线" onChange={event => setUsername(event.target.value)} /></label>}
            <label htmlFor="admin-password">{member ? '密码（至少 12 位）' : '管理员密码'}</label>
            <div className="password-field">
              <LockKeyhole size={18} aria-hidden="true" />
              <Input render={(props) => <input {...props} className={undefined} />}
                id="admin-password"
                type={visible ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                placeholder={member ? '输入个人密码' : '输入管理员密码'} minLength={member ? 12 : undefined} maxLength={member ? 256 : undefined}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'login-error' : undefined}
                autoFocus
                required
              />
              <FormButton
                className="icon-button"
                type="button"
                onPress={() => setVisible((current) => !current)}
                title={visible ? '隐藏密码' : '显示密码'}
                aria-label={visible ? '隐藏密码' : '显示密码'}
                aria-pressed={visible}
              >
                {visible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
              </FormButton>
            </div>
            <FormButton className="button button--primary button--full" type="submit" isDisabled={busy || !password}>
              {busy ? '请稍候…' : mode === 'register' ? '创建账号' : member ? '登录' : '进入管理端'}
            </FormButton>
          </form>
          {edition === 'hosted' && <div className="login-mode-actions">{(['member', 'register', 'admin'] as const).filter(item => item !== mode).map(item =>
            <FormButton className="button button--secondary" type="button" key={item} onPress={() => { setMode(item); setPassword(''); setVisible(false); }}>
              {{ member: '个人登录', register: '注册账号', admin: '管理员登录' }[item]}
            </FormButton>)}</div>}
          {edition === 'local' && onChatGPTLogin && <FormButton className="button button--secondary button--full"
            type="button" isDisabled={busy} onPress={onChatGPTLogin}>Continue with ChatGPT</FormButton>}
          {!member && edition !== 'local' && <FormButton
            className="button button--secondary button--full login-certificate"
            type="button"
            onPress={() => void onCertificateLogin()}
            isDisabled={busy}
          >
            <BadgeCheck size={17} aria-hidden="true" />
            使用设备证书登录
          </FormButton>}
          {error ? <div id="login-error" className="form-error" role="alert">{error}</div> : null}

          {edition === 'hosted' && <a className="login-local-download" href="/downloads/agentic-mailbox-mac-arm64.zip">下载本地版 · Mac（Apple Silicon）</a>}
          <p className="login-submit-hint">
            <Keyboard size={17} aria-hidden="true" />
            按 Enter 提交
          </p>
          <footer className="login-footer">
            <ShieldCheck size={15} aria-hidden="true" />
            <span>{edition === 'hosted' ? '托管版 · Agentic Mailbox' : 'Agentic Mailbox'}</span>
          </footer>
        </div>
      </section>
    </main>
  );
}
