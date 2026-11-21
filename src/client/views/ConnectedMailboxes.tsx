import { type FormEvent, useState } from 'react';
import type { MailAccount, MailRefreshResult } from '../../shared/types';
import { Modal } from '../components/Modal';
import { formatDate } from '../format';

type Props = {
  accounts: MailAccount[];
  results: MailRefreshResult[];
  refreshing: boolean;
  onSave: (input: { email: string; authorizationCode: string }) => Promise<void>;
};

export function ConnectedMailboxes({ accounts, results, refreshing, onSave }: Props) {
  const [editor, setEditor] = useState<{ email: string; update: boolean } | null>(null);

  return (
    <section className="connected-mailboxes" aria-labelledby="connected-mailboxes-title">
      <div className="connected-mailboxes__header">
        <h2 id="connected-mailboxes-title">已接入邮箱</h2>
        <button className="button button--secondary" type="button" onClick={() => setEditor({ email: '', update: false })}>
          接入邮箱
        </button>
      </div>
      {accounts.length ? (
        <ul className="connected-mailboxes__list" aria-live="polite">
          {accounts.map((account) => {
            const result = results.find(({ id }) => id === account.id);
            return (
              <li key={account.id}>
                <div className="connected-mailboxes__identity">
                  <span className="mode-badge">{account.provider === 'qq' ? 'QQ' : '163'}</span>
                  <strong>{account.address}</strong>
                </div>
                <div className="connected-mailboxes__status">
                  {refreshing ? '正在同步…' : result?.error ?? (account.lastSyncAt ? `上次同步 ${formatDate(account.lastSyncAt)}` : '等待首次同步')}
                  {!refreshing && result && result.oversized > 0 ? <small>{result.oversized} 封超过 10 MB，留在原邮箱</small> : null}
                  {!refreshing && result?.hasMore && !result.error ? <small>还有新邮件，再刷新一次</small> : null}
                </div>
                <button
                  className="button button--secondary" type="button" disabled={refreshing}
                  aria-label={`更新 ${account.address} 的授权码`}
                  onClick={() => setEditor({ email: account.address, update: true })}
                >
                  更新授权码
                </button>
              </li>
            );
          })}
        </ul>
      ) : <p className="connected-mailboxes__empty">接入 QQ 邮箱或 163 邮箱，和自有域名来信一起查看。</p>}
      {editor ? (
        <MailboxEditor {...editor} onClose={() => setEditor(null)} onSave={onSave} />
      ) : null}
    </section>
  );
}

function MailboxEditor({
  email: initialEmail, update, onClose, onSave,
}: { email: string; update: boolean; onClose: () => void; onSave: Props['onSave'] }) {
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
    </Modal>
  );
}
