import { type FormEvent, type ReactNode, useState } from 'react';
import type { MailAccount, MailProvider, MailRefreshResult, OAuthProvider } from '../../shared/types';
import { Modal } from '../components/Modal';
import { formatDate } from '../format';

type Props = {
  accounts: MailAccount[];
  results: MailRefreshResult[];
  refreshing: boolean;
  oauthProviders: OAuthProvider[];
  onAuthorize: (provider: OAuthProvider, accountId?: string) => Promise<void>;
  onSave: (input: { email: string; authorizationCode: string }) => Promise<void>;
};

const providerLabels: Record<MailProvider, string> = { qq: 'QQ', netease163: '163', gmail: 'Gmail', outlook: 'Outlook' };

export function ConnectedMailboxes({ accounts, results, refreshing, oauthProviders, onAuthorize, onSave }: Props) {
  const [editor, setEditor] = useState<{ email: string; update: boolean } | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [oauthError, setOAuthError] = useState('');

  const connect = async (provider: OAuthProvider, accountId?: string) => {
    setAuthorizing(true);
    setOAuthError('');
    try {
      await onAuthorize(provider, accountId);
    } catch (error) {
      setOAuthError(error instanceof Error ? error.message : '无法开始邮箱授权。');
      setAuthorizing(false);
    }
  };

  return (
    <section className="connected-mailboxes" aria-labelledby="connected-mailboxes-title">
      <div className="connected-mailboxes__header">
        <h2 id="connected-mailboxes-title">已接入邮箱</h2>
        <button className="button button--secondary" type="button" onClick={() => { setOAuthError(''); setEditor({ email: '', update: false }); }}>
          接入邮箱
        </button>
      </div>
      {accounts.length ? (
        <ul className="connected-mailboxes__list" aria-live="polite">
          {accounts.map((account) => {
            const result = results.find(({ id }) => id === account.id);
            const provider = account.provider;
            const oauth = provider === 'gmail' || provider === 'outlook';
            const updateLabel = oauth ? '重新授权' : '更新授权码';
            return (
              <li key={account.id}>
                <div className="connected-mailboxes__identity">
                  <span className="mode-badge">{providerLabels[provider]}</span>
                  <strong>{account.address}</strong>
                </div>
                <div className="connected-mailboxes__status">
                  {refreshing ? '正在同步…' : result?.error ?? (account.lastSyncAt ? `上次同步 ${formatDate(account.lastSyncAt)}` : '等待首次同步')}
                  {!refreshing && result && result.oversized > 0 ? <small>{result.oversized} 封超过 10 MB，留在原邮箱</small> : null}
                  {!refreshing && result?.hasMore && !result.error ? <small>还有邮件待同步，再刷新一次</small> : null}
                </div>
                <button
                  className="button button--secondary" type="button"
                  disabled={refreshing || authorizing || (oauth && !oauthProviders.includes(provider))}
                  aria-label={oauth ? `重新授权 ${account.address}` : `更新 ${account.address} 的授权码`}
                  onClick={() => oauth ? void connect(provider, account.id) : setEditor({ email: account.address, update: true })}
                >
                  {updateLabel}
                </button>
              </li>
            );
          })}
        </ul>
      ) : <p className="connected-mailboxes__empty">接入 QQ、163、Gmail 或 Outlook，在同一个收件箱查看。</p>}
      {oauthError && !editor ? <p role="alert">{oauthError}</p> : null}
      {editor ? (
        <MailboxEditor {...editor} onClose={() => setEditor(null)} onSave={onSave}>
          {!editor.update ? (
            <div className="form-stack">
              {(['gmail', 'outlook'] as const).map((provider) => (
                <button key={provider} className="button button--secondary" type="button"
                  disabled={authorizing || !oauthProviders.includes(provider)} onClick={() => void connect(provider)}>
                  使用 {providerLabels[provider]} 授权
                </button>
              ))}
              {oauthProviders.length < 2 ? <p className="connected-mailboxes__empty">OAuth 按钮在服务端配置后可用。</p> : null}
              {oauthError ? <p role="alert">{oauthError}</p> : null}
            </div>
          ) : null}
        </MailboxEditor>
      ) : null}
    </section>
  );
}

function MailboxEditor({
  email: initialEmail, update, onClose, onSave, children,
}: { email: string; update: boolean; onClose: () => void; onSave: Props['onSave']; children?: ReactNode }) {
  const [email, setEmail] = useState(initialEmail);
  const [authorizationCode, setAuthorizationCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await onSave({ email, authorizationCode });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法保存邮箱，请重试。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={update ? '更新授权码' : '接入邮箱'} onClose={onClose}>
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <label className="form-field">
          <span>邮箱地址</span>
          <input
            type="email" autoComplete="off" required maxLength={88} readOnly={update}
            value={email} onChange={(event) => setEmail(event.target.value)}
            placeholder="QQ 邮箱或 163 邮箱"
          />
        </label>
        <label className="form-field">
          <span>客户端授权码</span>
          <input
            type="password" autoComplete="new-password" required maxLength={64}
            value={authorizationCode} onChange={(event) => setAuthorizationCode(event.target.value)}
            aria-describedby="mail-authorization-help"
          />
        </label>
        <p className="connected-mailboxes__empty" id="mail-authorization-help">
          在邮箱网页版开启 IMAP 服务，再生成客户端授权码。
        </p>
        {error ? <p role="alert">{error}</p> : null}
        <button className="button button--primary" disabled={busy} type="submit">
          {busy ? '正在保存…' : '保存邮箱'}
        </button>
      </form>
      {children ? <div className="mailbox-oauth-options">{children}</div> : null}
    </Modal>
  );
}
