import { ArrowLeft, ArrowUpRight, ChevronRight, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { ImapProvider, MailAccount, MailProvider, MailRefreshResult, OAuthProvider } from '../../shared/types';
import { Modal } from '../components/Modal';
import { formatDate } from '../format';

export type MailboxConnectionResult = {
  provider: MailProvider;
  accountId?: string;
  status: 'saved' | 'connected' | 'sync_failed' | 'cancelled' | 'failed';
  requiresReauthorization?: boolean;
  message?: string;
};

type Props = {
  accounts: MailAccount[];
  results: MailRefreshResult[];
  refreshing: boolean;
  oauthProviders: OAuthProvider[];
  connectOpen: boolean;
  onConnectOpen: (open: boolean) => void;
  connectionResult: MailboxConnectionResult | null;
  onDismissResult: () => void;
  onOpenInbox: () => void;
  onSyncConnection: (provider: OAuthProvider, accountId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onAuthorize: (provider: OAuthProvider, accountId?: string) => Promise<void>;
  onSave: (input: { email: string; authorizationCode: string }) => Promise<void>;
};

const providers = ['gmail', 'outlook', 'qq', 'netease163'] as const;
const names: Record<MailProvider, string> = { gmail: 'Gmail', outlook: 'Outlook', qq: 'QQ 邮箱', netease163: '网易 163 邮箱' };
const providerDetails: Record<MailProvider, string> = {
  gmail: 'Google 账号',
  outlook: '个人 Outlook 或 Microsoft 365',
  qq: 'QQ 邮箱与 Foxmail',
  netease163: '个人 @163.com 邮箱',
};

const oauthBrand = { gmail: 'Google', outlook: 'Microsoft' } as const;

const imapSetup = {
  qq: {
    help: 'https://help.mail.qq.com/detail/106/985',
    instructions: '在 QQ 邮箱「账号与安全」中开启 IMAP/SMTP，并生成客户端授权码。',
    domains: ['qq.com', 'foxmail.com'],
    placeholder: 'name@qq.com',
  },
  netease163: {
    help: 'https://help.mail.yeah.net/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac286624f309a1a7089',
    instructions: '在 163 邮箱「设置 → POP3/SMTP/IMAP」中开启服务，再选择「新增授权密码」。',
    domains: ['163.com'],
    placeholder: 'name@163.com',
  },
} as const;

type Selection = { provider: MailProvider; account?: MailAccount };

function isOAuth(provider: MailProvider): provider is OAuthProvider {
  return provider === 'gmail' || provider === 'outlook';
}

export function ConnectedMailboxes({
  accounts, results, refreshing, oauthProviders, connectOpen, onConnectOpen, connectionResult, onDismissResult,
  onOpenInbox, onSyncConnection, onRefresh, onAuthorize, onSave,
}: Props) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const select = (value: Selection | null) => {
    setSelection(value);
    onConnectOpen(true);
  };

  const outcomeLabels = {
    saved: ' 已保存', connected: ' 已连接', sync_failed: ' 已授权，邮件尚未同步', cancelled: ' 授权已取消', failed: ' 连接失败',
  };
  const retryConnection = () => {
    if (!connectionResult) return;
    const { provider, accountId, status, requiresReauthorization } = connectionResult;
    if (status === 'connected') onOpenInbox();
    else if (status === 'saved') void onRefresh().then(onDismissResult);
    else if (status === 'sync_failed' && !requiresReauthorization && accountId && isOAuth(provider)) {
      void onSyncConnection(provider, accountId);
    } else {
      select({ provider, account: accounts.find((account) => account.id === accountId && account.provider === provider) });
    }
  };

  return (
    <section className="connected-mailboxes" aria-labelledby="connected-mailboxes-title">
      <div className="connected-mailboxes__header">
        <h2 id="connected-mailboxes-title">已接入邮箱</h2>
        <button className="button button--primary" type="button" onClick={() => select(null)}>接入邮箱</button>
      </div>
      {connectionResult ? (
        <div className="mailbox-connection-result">
          <div className="mailbox-connection-result__copy" role="status">
            <strong>
              {names[connectionResult.provider]}{outcomeLabels[connectionResult.status]}
            </strong>
            <p>{connectionResult.message ?? (connectionResult.status === 'saved'
              ? '现在可以同步邮件。' : '准备好后，可以重新打开服务商授权页。')}</p>
          </div>
          <button className="button button--secondary" type="button" disabled={refreshing} onClick={retryConnection}>
            {connectionResult.status === 'connected' ? '查看收件箱' : refreshing ? '正在同步…'
              : connectionResult.status === 'saved' ? '同步邮件'
                : connectionResult.status === 'sync_failed' && !connectionResult.requiresReauthorization ? '重试同步'
                  : '重新授权'}
          </button>
          <button className="icon-button" type="button" aria-label="关闭连接提示" onClick={onDismissResult}><X size={16} /></button>
        </div>
      ) : null}
      {accounts.length ? (
        <ul className="connected-mailboxes__list" aria-live="polite">
          {accounts.map((account) => {
            const result = results.find(({ id }) => id === account.id);
            const oauth = isOAuth(account.provider);
            return (
              <li key={account.id}>
                <div className="connected-mailboxes__identity">
                  <span className="mode-badge">{names[account.provider]}</span>
                  <strong>{account.address}</strong>
                </div>
                <div className="connected-mailboxes__status">
                  {refreshing ? '正在同步…' : result?.error ?? (account.lastSyncAt ? `上次同步 ${formatDate(account.lastSyncAt)}` : '等待首次同步')}
                  {!refreshing && result && result.oversized > 0 ? <small>{result.oversized} 封超过 10 MB，留在原邮箱</small> : null}
                  {!refreshing && result?.hasMore && !result.error ? <small>还有邮件待同步，再刷新一次</small> : null}
                </div>
                <button className="button button--secondary" type="button" disabled={refreshing}
                  aria-label={oauth ? `重新授权 ${account.address}` : `更新 ${account.address} 的授权码`}
                  onClick={() => select({ provider: account.provider, account })}
                >
                  {oauth ? '重新授权' : '更新授权码'}
                </button>
              </li>
            );
          })}
        </ul>
      ) : <p className="connected-mailboxes__empty">添加外部邮箱后，来信会出现在统一收件箱。</p>}
      {connectOpen ? (
        <ConnectDialog
          selection={selection} oauthProviders={oauthProviders} onSelect={setSelection}
          onClose={() => { setSelection(null); onConnectOpen(false); }} onAuthorize={onAuthorize}
          onSave={onSave}
        />
      ) : null}
    </section>
  );
}

type DialogProps = Pick<Props, 'oauthProviders' | 'onAuthorize' | 'onSave'> & {
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  onClose: () => void;
};

function ConnectDialog({ selection, oauthProviders, onSelect, onClose, onAuthorize, onSave }: DialogProps) {
  const stepRef = useRef<HTMLDivElement>(null);
  const step = selection?.provider;
  useEffect(() => { stepRef.current?.focus(); }, [step]);
  const provider = selection?.provider;
  const title = selection?.account
    ? (isOAuth(selection.provider) ? `重新授权 ${names[selection.provider]}` : `更新 ${names[selection.provider]}授权码`)
    : provider ? `连接 ${names[provider]}` : '接入邮箱';

  return (
    <Modal title={title} onClose={onClose}>
      {provider ? (
        <div ref={stepRef} className="mailbox-connect-step" tabIndex={-1} role="group" aria-label={title}>
          {!selection?.account ? (
            <button className="mailbox-connect-back" type="button" onClick={() => onSelect(null)}>
              <ArrowLeft size={15} aria-hidden="true" /> 选择其他邮箱
            </button>
          ) : <p className="mailbox-connect-note">{selection.account.address}</p>}
          {isOAuth(provider) ? (
            <OAuthSetup
              key={provider} provider={provider} ready={oauthProviders.includes(provider)}
              accountId={selection?.account?.id} onAuthorize={onAuthorize}
            />
          ) : (
            <ImapSetup key={provider} provider={provider} address={selection?.account?.address} onSave={onSave} onClose={onClose} />
          )}
        </div>
      ) : (
        <div ref={stepRef} tabIndex={-1} className="mailbox-connect-step" role="group" aria-label="选择邮箱服务商">
          <p className="mailbox-connect-note">选择你想接入的邮箱。</p>
          <ul className="mailbox-connect-providers">
            {providers.map((option) => {
              const available = !isOAuth(option) || oauthProviders.includes(option);
              const label = <span><strong>{names[option]}</strong><small>{providerDetails[option]}</small></span>;
              return (
                <li key={option}>
                  {available ? (
                    <button className="mailbox-connect-option" type="button" onClick={() => onSelect({ provider: option })}>
                      {label}<ChevronRight size={17} aria-hidden="true" />
                    </button>
                  ) : (
                    <div className="mailbox-connect-option">
                      {label}<span className="mailbox-connect-pending">暂不可用</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Modal>
  );
}

function OAuthSetup({
  provider, ready, accountId, onAuthorize,
}: Pick<Props, 'onAuthorize'> & { provider: OAuthProvider; ready: boolean; accountId?: string }) {
  const brand = oauthBrand[provider];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const proceed = async () => {
    setPending(true);
    setError('');
    try {
      await onAuthorize(provider, accountId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '暂时无法继续，请再试一次。');
    } finally {
      setPending(false);
    }
  };

  if (!ready) return <p>{names[provider]} 暂不可用，请联系站点维护者。</p>;
  return (
    <div className="mailbox-connect-body">
      <p>在 {brand} 页面选择要接入的邮箱，并允许 Mailbox Vault 读取和发送邮件。授权后会自动同步。</p>
      {error ? <p role="alert" className="mailbox-connect-error">{error}</p> : null}
      <div className="mailbox-connect-actions">
        <button className="button button--primary" type="button" disabled={pending} onClick={() => void proceed()}>
          {pending ? '正在打开授权页…' : `使用 ${brand} 继续`}
        </button>
      </div>
    </div>
  );
}

function ImapSetup({
  provider, address, onClose, onSave,
}: { provider: ImapProvider; address?: string; onClose: () => void; onSave: Props['onSave'] }) {
  const config = imapSetup[provider];
  const [email, setEmail] = useState(address ?? '');
  const [authorizationCode, setAuthorizationCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const normalized = email.trim().toLowerCase();
    if (!config.domains.some((domain) => normalized.endsWith(`@${domain}`))) {
      setError(`请输入${names[provider]}地址，或返回选择其他邮箱。`);
      return;
    }
    setBusy(true);
    try {
      await onSave({ email: normalized, authorizationCode });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法保存邮箱，请重试。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="mailbox-connect-body" onSubmit={(event) => void submit(event)}>
      {!address ? (
        <label className="form-field">
          <span>邮箱地址</span>
          <input type="email" autoComplete="off" required maxLength={88}
            value={email} onChange={(event) => setEmail(event.target.value)} placeholder={config.placeholder} />
        </label>
      ) : null}
      <label className="form-field">
        <span>客户端授权码</span>
        <input type="password" autoComplete="new-password" required maxLength={64}
          value={authorizationCode} onChange={(event) => setAuthorizationCode(event.target.value)}
          aria-describedby="mail-authorization-help" />
      </label>
      <p className="mailbox-connect-note" id="mail-authorization-help">
        {config.instructions} <a href={config.help} target="_blank" rel="noreferrer">查看获取方法 <ArrowUpRight size={14} aria-hidden="true" /></a>
      </p>
      {error ? <p role="alert" className="mailbox-connect-error">{error}</p> : null}
      <div className="mailbox-connect-actions">
        <button className="button button--primary" type="submit" disabled={busy}>
          {busy ? '正在保存…' : address ? '保存授权码' : '连接邮箱'}
        </button>
      </div>
    </form>
  );
}
