import { Download, Files, Inbox, Mail, MailOpen, RefreshCw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EmailDetail, EmailSummary, MailAccount, MailRefreshResult } from '../../shared/types';
import { formatBytes, formatDate, formatLongDate, initials, senderLabel } from '../format';
import { Modal } from '../components/Modal';
import { ConnectedMailboxes } from './ConnectedMailboxes';
import { mailboxApi } from '../api';

type InboxViewProps = {
  emails: EmailSummary[];
  sources: { id: string; address: string }[];
  accounts: MailAccount[];
  refreshResults: MailRefreshResult[];
  refreshing: boolean;
  onSaveAccount: (input: { email: string; authorizationCode: string }) => Promise<void>;
  detail: EmailDetail | null;
  detailLoading: boolean;
  onOpenEmail: (id: string) => void;
  onCloseEmail: () => void;
  onToggleRead: (id: string, read: boolean) => void;
  onRefresh: () => void;
};

export function InboxView({
  emails,
  sources,
  accounts,
  refreshResults,
  refreshing,
  onSaveAccount,
  detail,
  detailLoading,
  onOpenEmail,
  onCloseEmail,
  onToggleRead,
  onRefresh,
}: InboxViewProps) {
  const [query, setQuery] = useState('');
  const [aliasId, setAliasId] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const [search, setSearch] = useState<{ key: string; emails: EmailSummary[]; error?: string } | null>(null);
  const trimmedQuery = query.trim();
  const filteredMode = Boolean(aliasId || trimmedQuery || unreadOnly);
  const searchKey = JSON.stringify([aliasId, trimmedQuery, unreadOnly]);

  useEffect(() => {
    if (!filteredMode) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void mailboxApi.emails({ aliasId, query: trimmedQuery, unreadOnly, signal: controller.signal })
        .then(({ emails: matches }) => {
          if (!controller.signal.aborted) setSearch({ key: searchKey, emails: matches });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setSearch({
              key: searchKey, emails: [],
              error: error instanceof Error ? error.message : '读取筛选结果失败。',
            });
          }
        });
    }, trimmedQuery ? 200 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [aliasId, trimmedQuery, unreadOnly, filteredMode, searchKey, emails]);

  const matches = search?.key === searchKey ? search : null;
  const filtered = filteredMode ? matches?.emails ?? [] : emails;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">邮件</p>
          <h1>收件箱</h1>
          <p>{emails.filter((email) => !email.readAt).length} 封未读邮件</p>
        </div>
        <button className="button button--primary" type="button" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw size={17} />
          {refreshing ? '正在刷新…' : '一键刷新'}
        </button>
      </header>

      <ConnectedMailboxes
        accounts={accounts} results={refreshResults} refreshing={refreshing} onSave={onSaveAccount}
      />

      <div className="toolbar">
        <label className="search-field">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索发件人或主题" />
        </label>
        <select className="select-control" value={aliasId} onChange={(event) => setAliasId(event.target.value)} aria-label="筛选邮箱">
          <option value="">全部邮箱</option>
          {sources.map((alias) => (
            <option value={alias.id} key={alias.id}>{alias.address}</option>
          ))}
        </select>
        <label className="toggle-row">
          <input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} />
          <span className="toggle" aria-hidden="true" />
          仅未读
        </label>
      </div>

      <section className="data-panel email-table" aria-label="邮件列表">
        <div className="table-head email-row">
          <span />
          <span>发件人</span>
          <span>主题</span>
          <span>收件邮箱</span>
          <span>时间</span>
        </div>
        {filteredMode && !matches ? (
          <div className="loading-state"><span className="spinner" />正在读取邮件</div>
        ) : matches?.error && filteredMode ? (
          <div className="empty-state" role="alert">{matches.error}</div>
        ) : filtered.length > 0 ? (
          filtered.map((email) => (
            <button
              className={`email-row email-row--item ${email.readAt ? '' : 'email-row--unread'}`}
              type="button"
              key={email.id}
              onClick={() => onOpenEmail(email.id)}
            >
              <span className={`unread-marker ${email.readAt ? 'unread-marker--read' : ''}`} />
              <span className="email-sender">
                <span className="sender-avatar">{initials(senderLabel(email.fromName, email.fromAddress))}</span>
                <span>
                  <strong>{senderLabel(email.fromName, email.fromAddress)}</strong>
                  <small>{email.fromAddress}</small>
                </span>
              </span>
              <span className="email-subject">
                <strong>{email.subject}</strong>
                <small>{email.preview || '无正文预览'}</small>
              </span>
              <span className="email-alias">{email.aliasAddress}</span>
              <span className="email-time">
                {email.attachmentCount > 0 ? <Files size={14} /> : null}
                {formatDate(email.receivedAt)}
              </span>
            </button>
          ))
        ) : (
          <div className="empty-state">
            <Inbox size={28} />
            <strong>没有匹配的邮件</strong>
          </div>
        )}
      </section>

      {(detail || detailLoading) ? (
        <Modal
          title={detail?.subject ?? '加载邮件'}
          subtitle={detail ? `${senderLabel(detail.fromName, detail.fromAddress)} · ${formatLongDate(detail.receivedAt)}` : undefined}
          wide
          onClose={onCloseEmail}
        >
          {detailLoading || !detail ? (
            <div className="loading-state"><span className="spinner" />正在加载邮件</div>
          ) : (
            <article className="email-detail">
              <div className="email-detail__meta">
                <dl>
                  <div><dt>发件人</dt><dd>{detail.fromAddress}</dd></div>
                  <div><dt>收件邮箱</dt><dd>{detail.aliasAddress}</dd></div>
                  <div><dt>邮件大小</dt><dd>{formatBytes(detail.rawSize)}</dd></div>
                </dl>
                <button className="button button--secondary" type="button" onClick={() => onToggleRead(detail.id, Boolean(detail.readAt))}>
                  {detail.readAt ? <Mail size={16} /> : <MailOpen size={16} />}
                  {detail.readAt ? '标记未读' : '标记已读'}
                </button>
              </div>

              <pre className="email-body">{detail.bodyText || '（邮件没有纯文本正文）'}</pre>

              {detail.attachments.length > 0 ? (
                <section className="attachment-section">
                  <h3>附件 <span>{detail.attachments.length}</span></h3>
                  <div className="attachment-list">
                    {detail.attachments.map((file) => (
                      <a className="attachment-row" href={`/api/attachments/${encodeURIComponent(file.id)}/download`} key={file.id}>
                        <span className="file-icon"><Files size={17} /></span>
                        <span><strong>{file.filename}</strong><small>{file.contentType} · {formatBytes(file.size)}</small></span>
                        <Download size={17} />
                      </a>
                    ))}
                  </div>
                </section>
              ) : null}
            </article>
          )}
        </Modal>
      ) : null}
    </div>
  );
}
