import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type {
  AttachmentItem,
  BootstrapPayload,
  DashboardStats,
  EmailSummary,
  MailAlias,
  MailRefreshResult,
  OAuthProvider,
} from '../shared/types';
import { ApiRequestError, mailboxApi } from './api';
import type { ViewName } from './workbench/InboxWorkbench';
import { AliasesView } from './views/AliasesView';
import { FilesView } from './views/FilesView';
import { ConnectedMailboxes, type MailboxConnectionResult } from './views/ConnectedMailboxes';
import { LoginView } from './views/LoginView';
import { OverviewView } from './views/OverviewView';

const InboxWorkbench = lazy(() => import('./workbench/InboxWorkbench'));
const reconnectStorageKey = 'mailbox-vault-oauth-reconnect';

function takeReconnectTarget(provider: OAuthProvider): string | undefined {
  try {
    const target = window.sessionStorage.getItem(reconnectStorageKey);
    window.sessionStorage.removeItem(reconnectStorageKey);
    return target?.startsWith(`${provider}:`) ? target.slice(provider.length + 1) : undefined;
  } catch {
    return undefined;
  }
}

const EMPTY_STATS: DashboardStats = {
  aliasCount: 0,
  activeAliasCount: 0,
  emailCount: 0,
  unreadCount: 0,
  attachmentCount: 0,
  attachmentBytes: 0,
};

type Toast = { type: 'success' | 'error'; message: string } | null;

export default function App() {
  const [checkingSession, setCheckingSession] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [activeView, setActiveView] = useState<ViewName>('inbox');
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [aliases, setAliases] = useState<MailAlias[]>([]);
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [files, setFiles] = useState<AttachmentItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResults, setRefreshResults] = useState<MailRefreshResult[]>([]);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectionResult, setConnectionResult] = useState<MailboxConnectionResult | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  const showError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : '操作失败，请稍后重试。';
    setLoginError(message);
    if (error instanceof ApiRequestError && error.status === 401) {
      setSelectedId(null);
      setAuthenticated(false);
    }
    setToast({ type: 'error', message });
  }, []);

  const loadData = useCallback(async () => {
    const [nextBootstrap, aliasPayload, emailPayload, filePayload] = await Promise.all([
      mailboxApi.bootstrap(),
      mailboxApi.aliases(),
      mailboxApi.emails(),
      mailboxApi.files(),
    ]);
    setBootstrap(nextBootstrap);
    setAliases(aliasPayload.aliases);
    setEmails(emailPayload.emails);
    setFiles(filePayload.files);
  }, []);

  useEffect(() => {
    let active = true;
    void mailboxApi
      .session()
      .then(async (session) => {
        if (!active) return;
        setAuthenticated(session.authenticated);
        const callback = new URLSearchParams(window.location.hash.slice(1));
        const provider = callback.get('mailOAuth');
        if (provider === 'gmail' || provider === 'outlook') {
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
          setActiveView('aliases');
          const accountId = takeReconnectTarget(provider);
          if (session.authenticated) {
            try {
              await mailboxApi.finishMailOAuth(provider, {
                state: callback.get('state'), code: callback.get('code'), error: callback.get('error'),
              });
              setConnectionResult({ provider, status: 'connected' });
            } catch (error) {
              if (error instanceof ApiRequestError && error.status === 401) {
                showError(error);
                return;
              }
              const cancelled = error instanceof ApiRequestError && error.code === 'oauth_authorization_cancelled';
              setConnectionResult(cancelled ? { provider, accountId, status: 'cancelled' } : {
                provider, accountId, status: 'failed',
                message: error instanceof Error ? error.message : '请重新打开授权页。',
              });
            }
          } else {
            setLoginError('邮箱管理会话已过期，请重新登录后开始授权。');
          }
        }
        if (session.authenticated) await loadData();
      })
      .catch((error) => { if (active) showError(error); })
      .finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, [loadData, showError]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), toast.type === 'success' ? 2600 : 5200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const login = async (password?: string) => {
    setLoginBusy(true);
    setLoginError('');
    try {
      const session = password === undefined
        ? await mailboxApi.loginWithCertificate()
        : await mailboxApi.login(password);
      setAuthenticated(session.authenticated);
      if (session.authenticated) {
        try {
          await loadData();
        } catch (error) {
          showError(error);
        }
      }
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : '登录失败。');
    } finally {
      setLoginBusy(false);
    }
  };

  const logout = async () => {
    try {
      await mailboxApi.logout();
    } catch (error) {
      showError(error);
      return;
    }
    setAuthenticated(false);
    setBootstrap(null);
    setAliases([]);
    setEmails([]);
    setRefreshResults([]);
    setConnectionResult(null);
    setConnectOpen(false);
    setFiles([]);
    setLoginError('');
    setToast(null);
    setSelectedId(null);
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const accounts = bootstrap?.mailAccounts ?? [];
      const results = await Promise.all(accounts.map(async (account): Promise<MailRefreshResult> => {
        try {
          return (await mailboxApi.refreshMailAccount(account.id)).result;
        } catch (error) {
          return {
            id: account.id, imported: 0, oversized: 0, hasMore: false, lastSyncAt: account.lastSyncAt,
            error: error instanceof Error ? error.message : '邮箱同步失败。',
          };
        }
      }));
      setRefreshResults(results);
      await loadData();

      const imported = results.reduce((total, result) => total + result.imported, 0);
      const errors = results.filter((result) => result.error).length;
      const more = results.some((result) => result.hasMore);
      const receipt = imported > 0 ? `同步了 ${imported} 封邮件` : '收件箱已刷新';
      setToast({
        type: errors ? 'error' : 'success',
        message: errors ? `${receipt}，${errors} 个邮箱同步失败。查看该账号的状态。`
          : more ? `${receipt}。还有邮件待同步，可再刷新一次。` : `${receipt}。`,
      });
    } catch (error) {
      showError(error);
    } finally {
      setRefreshing(false);
    }
  };

  const saveMailAccount = async (input: { email: string; authorizationCode: string }) => {
    try {
      const { account } = await mailboxApi.saveMailAccount(input);
      setBootstrap((current) => current ? {
        ...current,
        mailAccounts: [...(current.mailAccounts ?? []).filter(({ id }) => id !== account.id), account]
          .sort((a, b) => a.address.localeCompare(b.address)),
      } : current);
      setRefreshResults((current) => current.filter(({ id }) => id !== account.id));
      setConnectionResult({ provider: account.provider, status: 'connected' });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) showError(error);
      throw error;
    }
  };

  const authorizeMailbox = async (provider: OAuthProvider, accountId?: string) => {
    try {
      const { url } = await mailboxApi.startMailOAuth(provider, accountId);
      try {
        if (accountId) window.sessionStorage.setItem(reconnectStorageKey, `${provider}:${accountId}`);
        else window.sessionStorage.removeItem(reconnectStorageKey);
      } catch {
        // The authorization itself still works when browser storage is unavailable.
      }
      window.location.assign(url);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) showError(error);
      throw error;
    }
  };

  const createAlias = async (input: { localPart?: string; label: string; note?: string; generate: boolean }) => {
    setBusy(true);
    try {
      const { alias } = await mailboxApi.createAlias(input);
      setCreateOpen(false);
      await loadData();
      setToast({ type: 'success', message: `${alias.address} 已创建。` });
    } catch (error) {
      showError(error);
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const toggleAlias = async (alias: MailAlias) => {
    setBusy(true);
    try {
      const status = alias.status === 'active' ? 'disabled' : 'active';
      const { alias: updated } = await mailboxApi.updateAlias(alias.id, { status });
      setAliases((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      await loadData();
      setToast({ type: 'success', message: `${updated.address} 已${status === 'active' ? '启用' : '停用'}。` });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const navigate = (view: ViewName) => {
    if (view !== 'inbox') setSelectedId(null);
    setActiveView(view);
  };

  const openEmail = (id: string) => {
    setActiveView('inbox');
    setSelectedId(id);
  };

  if (checkingSession) {
    return (
      <main className="boot-screen">
        <div className="brand-loader"><span className="spinner" /><strong>Mailbox Vault</strong></div>
      </main>
    );
  }

  if (!authenticated) {
    return <LoginView error={loginError} busy={loginBusy} onLogin={login} onCertificateLogin={() => login()} />;
  }

  const stats = bootstrap?.stats ?? EMPTY_STATS;
  const appName = bootstrap?.appName ?? 'Mailbox Vault';
  const primaryDomain = bootstrap?.primaryDomain ?? 'emomo.net';
  const accounts = bootstrap?.mailAccounts ?? [];
  const mailSources = [...aliases, ...accounts];

  const openCreate = () => {
    setActiveView('aliases');
    setCreateOpen(true);
  };

  return (
    <>
      <Suspense fallback={<main className="boot-screen"><div className="brand-loader"><span className="spinner" />正在加载邮箱</div></main>}>
        <InboxWorkbench
          appName={appName}
          primaryDomain={primaryDomain}
          activeView={activeView}
          selectedId={selectedId}
          onSelect={setSelectedId}
          aliases={aliases}
          accounts={accounts}
          revision={emails}
          unread={stats.unreadCount}
          refreshing={refreshing}
          onNavigate={navigate}
          onConnectMailbox={() => { navigate('aliases'); setConnectOpen(true); }}
          onLogout={() => void logout()}
          onReload={loadData}
          onRefresh={refresh}
          onError={showError}
          onNotice={(message) => setToast({ type: 'success', message })}
        >
          {activeView === 'overview' ? (
            <OverviewView
              stats={stats}
              emails={emails}
              aliases={aliases}
              onNavigate={navigate}
              onCreateAlias={openCreate}
              onOpenEmail={openEmail}
            />
          ) : null}
          {activeView === 'aliases' ? (
            <div className="page">
              <ConnectedMailboxes accounts={accounts} results={refreshResults} refreshing={refreshing}
                oauthProviders={bootstrap?.oauthProviders ?? []} connectOpen={connectOpen} onConnectOpen={setConnectOpen}
                connectionResult={connectionResult} onDismissResult={() => setConnectionResult(null)}
                onRefresh={refresh} onRecheck={loadData} onAuthorize={authorizeMailbox} onSave={saveMailAccount} />
              <AliasesView
                aliases={aliases}
                primaryDomain={primaryDomain}
                createOpen={createOpen}
                busy={busy}
                onOpenCreate={() => setCreateOpen(true)}
                onCloseCreate={() => setCreateOpen(false)}
                onCreate={createAlias}
                onToggle={toggleAlias}
              />
            </div>
          ) : null}
          {activeView === 'files' ? <FilesView files={files} sources={mailSources} /> : null}
        </InboxWorkbench>
      </Suspense>

      {toast ? (
        <div className={`toast toast--${toast.type}`} role="status">
          {toast.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <span>{toast.message}</span>
          <button className="icon-button" type="button" onClick={() => setToast(null)} title="关闭" aria-label="关闭">
            <X size={15} />
          </button>
        </div>
      ) : null}
    </>
  );
}
