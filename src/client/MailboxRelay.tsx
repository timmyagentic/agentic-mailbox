import { useEffect, useState, type FormEvent } from 'react';
import {
  presetHosts,
  type MailboxProfile,
  type MailboxStatus,
  type Provider,
  type RelayIssue,
  type Server,
} from '../shared/mailbox';
import { api } from './api';

const providers: Record<Provider, string> = {
  gmail: 'Gmail',
  qq: 'QQ 邮箱',
  '163': '网易 163',
  custom: '其他邮箱 / 自有域名邮箱',
};
const issues: Record<RelayIssue, string> = {
  imap: '读取收件箱失败。请检查 IMAP 服务和授权，下一次检查会重试。',
  oauth: 'Google 授权已失效，请重新授权后再检查。',
  rejected: '发信服务器拒收此信。可以检查收件地址、附件或服务商限制后重试，也可以跳过。',
  smtp: 'SMTP 未接受邮件，请检查发信凭证或目标地址。下次检查会重试。',
  reset: '服务商已重建收件箱。确认后将以当前邮件为起点，只处理中转恢复后的新信。',
  uncertain: 'SMTP 的最终回执缺失。请先在目标邮箱找这封信，再选择下一步。',
  oversize: '这封邮件超过 12 MiB 的单封处理上限，请到原邮箱查看。',
  message: '无法解析这封邮件。请到原邮箱查看。',
};

function ServerFields({ kind, existing }: { kind: 'imap' | 'smtp'; existing?: Server }) {
  const label = kind.toUpperCase();
  return (
    <fieldset className="server-fields">
      <legend>{label} 服务器</legend>
      <label>
        主机名
        <input
          required
          name={kind + 'Host'}
          defaultValue={existing?.host}
          placeholder={kind + '.example.com'}
        />
      </label>
      <div className="field-pair">
        <label>
          端口
          <input
            name={kind + 'Port'}
            type="number"
            required
            min={1}
            max={65535}
            defaultValue={existing?.port ?? (kind === 'imap' ? 993 : 465)}
          />
        </label>
        <label>
          加密方式
          <select name={kind + 'Tls'} defaultValue={existing?.tls ?? 'implicit'}>
            <option value="implicit">TLS</option>
            <option value="starttls">STARTTLS</option>
          </select>
        </label>
      </div>
    </fieldset>
  );
}

function Setup({
  active,
  google,
  busy,
  submit,
}: {
  active?: MailboxProfile;
  google: boolean;
  busy: boolean;
  submit: (body: object) => void;
}) {
  const [provider, setProvider] = useState<Provider>(active?.provider ?? 'gmail');
  const [auth, setAuth] = useState<'google' | 'password'>(active?.auth ?? 'password');
  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const read = (key: string) => String(form.get(key) ?? '');
    const server = (kind: string) => ({
      host: read(kind + 'Host'),
      port: Number(read(kind + 'Port')),
      tls: read(kind + 'Tls'),
    });
    submit({
      provider,
      address: read('address'),
      destination: read('destination'),
      name: read('name'),
      auth: provider === 'gmail' ? auth : 'password',
      password: read('password'),
      smtpPassword: read('smtpPassword'),
      imap: server('imap'),
      smtp: server('smtp'),
      imapUser: read('imapUser'),
      smtpUser: read('smtpUser'),
    });
  }
  return (
    <form onSubmit={save}>
      <fieldset disabled={busy}>
        <label>
          邮箱服务商
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as Provider);
              setAuth('password');
            }}
          >
            {(['gmail', 'qq', '163', 'custom'] as const).map((p) => (
              <option key={p} value={p}>
                {providers[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          中转邮箱
          <input type="email" name="address" required defaultValue={active?.address} autoComplete="off" />
        </label>
        {provider === 'custom' ? (
          <div className="mail-servers">
            <ServerFields kind="imap" existing={active?.provider === 'custom' ? active.imap : undefined} />
            <ServerFields kind="smtp" existing={active?.provider === 'custom' ? active.smtp : undefined} />
          </div>
        ) : (
          <p className="field-hint">
            {presetHosts[provider].imap} · {presetHosts[provider].smtp}
          </p>
        )}
        {provider === 'gmail' && google && (
          <label>
            授权方式
            <select value={auth} onChange={(e) => setAuth(e.target.value as typeof auth)}>
              <option value="password">应用专用密码</option>
              <option value="google">已配置的 Google OAuth 授权</option>
            </select>
          </label>
        )}
        {(provider !== 'gmail' || auth === 'password') && (
          <label>
            {provider === 'gmail' ? 'Google 应用专用密码' : '客户端授权码或专用密码'}
            <input type="password" name="password" autoComplete="new-password" required maxLength={2048} />
          </label>
        )}
        {provider === 'custom' && (
          <details>
            <summary>单独设置登录名或发信密码</summary>
            <label>
              IMAP 用户名
              <input name="imapUser" defaultValue={active?.imapUser} placeholder="默认使用中转邮箱地址" />
            </label>
            <label>
              SMTP 用户名
              <input name="smtpUser" defaultValue={active?.smtpUser} placeholder="默认使用中转邮箱地址" />
            </label>
            <label>
              SMTP 密码
              <input
                name="smtpPassword"
                type="password"
                autoComplete="new-password"
                placeholder="默认使用上方的授权码"
              />
            </label>
          </details>
        )}
        <label>
          发件人显示名（选填）
          <input name="name" maxLength={80} defaultValue={active?.name} placeholder="邮件助手" />
        </label>
        <label>
          目标邮箱
          <input name="destination" type="email" required defaultValue={active?.destination} />
        </label>
        <p className="field-hint">确认码将由中转邮箱寄到这个地址。启用后，仅处理连接以来的新邮件。</p>
        <button className="primary">{busy ? '正在连接…' : '连接并发送确认码'}</button>
      </fieldset>
    </form>
  );
}

export default function MailboxRelay() {
  const [state, setState] = useState<MailboxStatus>();
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  async function load() {
    setState(await api<MailboxStatus>('/api/relay'));
  }
  useEffect(() => {
    void load().catch((err) => setError(err.message));
  }, []);
  async function action(path: string, data: object) {
    setBusy(true);
    setError('');
    try {
      setState(
        await api<MailboxStatus>('/api/relay/' + path, { method: 'POST', body: JSON.stringify(data) }),
      );
      setEdit(false);
      setCode('');
    } catch (err) {
      setError((err as Error).message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  const route = state?.active;
  function resolve(choice: string) {
    if (route)
      void action('resolve', {
        generation: route.generation,
        validity: route.uidValidity,
        uid: route.inFlight,
        action: choice,
      });
  }
  return (
    <main className="settings mailbox-settings">
      <h1>邮箱中转</h1>
      {error && <p role="alert">{error}</p>}
      {!state &&
        (error ? (
          <button
            onClick={() =>
              void load()
                .then(() => setError(''))
                .catch((err) => setError(err.message))
            }
          >
            重新连接
          </button>
        ) : (
          <p role="status">正在读取设置…</p>
        ))}
      {route && (
        <section>
          <h2>当前中转</h2>
          <p className="mail-path">
            <strong>{route.profile.address}</strong> → <strong>{route.profile.destination}</strong>
          </p>
          {route.checkedAt && <p>上次检查 {new Date(route.checkedAt).toLocaleString()}</p>}
          {route.sentAt && <p>上次成功代发 {new Date(route.sentAt).toLocaleString()}</p>}
          {route.issue && (
            <p role="alert">
              {issues[route.issue]}
              {route.inFlight && ' 邮件 UID ' + route.inFlight}
            </p>
          )}
          <div className="mail-actions">
            <button disabled={busy} onClick={() => void action('check', {})}>
              {busy ? '正在处理…' : '立即检查新信'}
            </button>
            <button disabled={busy} onClick={() => setEdit(!edit)}>
              {edit ? '收起设置' : '修改中转设置'}
            </button>
          </div>
          {route.inFlight && !route.busy && (
            <div className="mail-actions">
              <button disabled={busy} onClick={() => resolve('skip')}>
                跳过此信并继续
              </button>
              {route.issue !== 'oversize' && (
                <button disabled={busy} onClick={() => resolve('retry')}>
                  重新尝试此信
                </button>
              )}
            </div>
          )}
          {route.issue === 'reset' && (
            <button disabled={busy} onClick={() => resolve('baseline')}>
              从现在恢复中转
            </button>
          )}
          {!route.sentAt && !route.issue && <p>从另一个邮箱给中转地址寄一封新信，再去目标邮箱查看。</p>}
        </section>
      )}
      {state?.pending && (
        <section>
          <h2>确认目标邮箱</h2>
          <p>请查看 {state.pending.destination} 收到的确认邮件。</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action('confirm', { id: state.pending?.id, code });
            }}
          >
            <label>
              12 位确认码
              <input
                autoComplete="one-time-code"
                autoCapitalize="characters"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                pattern="[0-9A-Fa-f]{12}"
                maxLength={12}
              />
            </label>
            <div className="mail-actions">
              <button className="primary" disabled={busy}>
                启用中转
              </button>
              <button type="button" disabled={busy} onClick={() => setEdit(!edit)}>
                重新设置
              </button>
            </div>
          </form>
        </section>
      )}
      {state && (edit || (!route && !state.pending)) && (
        <section>
          <h2>连接邮箱</h2>
          <Setup
            active={route?.profile}
            google={state.googleEnabled}
            busy={busy}
            submit={(body) => void action('setup', body)}
          />
        </section>
      )}
    </main>
  );
}
