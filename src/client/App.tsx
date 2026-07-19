import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type {
  AttachmentItem,
  BootstrapPayload,
  DashboardStats,
  EmailDetail,
  EmailSummary,
  MailAlias,
} from '../shared/types';
import { ApiRequestError, mailboxApi } from './api';
import { Layout, type ViewName } from './components/Layout';
import { AliasesView } from './views/AliasesView';
import { FilesView } from './views/FilesView';
import { InboxView } from './views/InboxView';
import { LoginView } from './views/LoginView';
import { OverviewView } from './views/OverviewView';

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
  const [activeView, setActiveView] = useState<ViewName>('overview');
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [aliases, setAliases] = useState<MailAlias[]>([]);
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [files, setFiles] = useState<AttachmentItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<EmailDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  const showError = useCallback((error: unknown) => {
    if (error instanceof ApiRequestError && error.status === 401) {
      setAuthenticated(false);
    }
    setToast({ type: 'error', message: error instanceof Error ? error.message : '操作失败，请稍后重试。' });
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
    void mailboxApi
      .session()
      .then(async (session) => {
        setAuthenticated(session.authenticated);
        if (session.authenticated) {
          await loadData();
        }
      })
      .catch(showError)
      .finally(() => setCheckingSession(false));
  }, [loadData, showError]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), toast.type === 'success' ? 2600 : 5200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const login = async (password: string) => {
    setLoginBusy(true);
    setLoginError('');
    try {
      const session = await mailboxApi.login(password);
      setAuthenticated(session.authenticated);
      await loadData();
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : '登录失败。');
    } finally {
      setLoginBusy(false);
    }
  };

  const logout = async () => {
    try {
      await mailboxApi.logout();
    } finally {
      setAuthenticated(false);
      setBootstrap(null);
      setAliases([]);
      setEmails([]);
      setFiles([]);
    }
  };

  const refresh = async () => {
    setBusy(true);
    try {
      await loadData();
      setToast({ type: 'success', message: '数据已刷新。' });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
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

  const openEmail = async (id: string) => {
    setDetail(null);
    setDetailLoading(true);
    try {
      const { email } = await mailboxApi.email(id);
      setDetail(email);
      if (!email.readAt) {
        await mailboxApi.setEmailRead(id, true);
        const readAt = new Date().toISOString();
        setDetail((current) => (current?.id === id ? { ...current, readAt } : current));
        setEmails((current) => current.map((item) => (item.id === id ? { ...item, readAt } : item)));
        setBootstrap((current) =>
          current
            ? { ...current, stats: { ...current.stats, unreadCount: Math.max(0, current.stats.unreadCount - 1) } }
            : current,
        );
      }
    } catch (error) {
      showError(error);
      setDetailLoading(false);
    } finally {
      setDetailLoading(false);
    }
  };

  const toggleRead = async (id: string, currentlyRead: boolean) => {
    try {
      await mailboxApi.setEmailRead(id, !currentlyRead);
      const readAt = currentlyRead ? null : new Date().toISOString();
      setDetail((current) => (current?.id === id ? { ...current, readAt } : current));
      await loadData();
    } catch (error) {
      showError(error);
    }
  };

  if (checkingSession) {
    return (
      <main className="boot-screen">
        <div className="brand-loader"><span className="spinner" /><strong>Mailbox Vault</strong></div>
      </main>
    );
  }

  if (!authenticated) {
    return <LoginView error={loginError} busy={loginBusy} onLogin={login} />;
  }

  const stats = bootstrap?.stats ?? EMPTY_STATS;
  const appName = bootstrap?.appName ?? 'Mailbox Vault';
  const primaryDomain = bootstrap?.primaryDomain ?? 'emomo.net';
  const adminEmail = bootstrap?.adminEmail ?? '';

  const openCreate = () => {
    setActiveView('aliases');
    setCreateOpen(true);
  };

  return (
    <>
      <Layout
        appName={appName}
        primaryDomain={primaryDomain}
        adminEmail={adminEmail}
        activeView={activeView}
        stats={stats}
        onNavigate={setActiveView}
        onLogout={() => void logout()}
      >
        {activeView === 'overview' ? (
          <OverviewView
            stats={stats}
            emails={emails}
            aliases={aliases}
            onNavigate={setActiveView}
            onCreateAlias={openCreate}
            onOpenEmail={(id) => void openEmail(id)}
          />
        ) : null}
        {activeView === 'inbox' ? (
          <InboxView
            emails={emails}
            aliases={aliases}
            detail={detail}
            detailLoading={detailLoading}
            onOpenEmail={(id) => void openEmail(id)}
            onCloseEmail={() => setDetail(null)}
            onToggleRead={(id, current) => void toggleRead(id, current)}
            onRefresh={() => void refresh()}
          />
        ) : null}
        {activeView === 'aliases' ? (
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
        ) : null}
        {activeView === 'files' ? <FilesView files={files} aliases={aliases} /> : null}
      </Layout>

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
