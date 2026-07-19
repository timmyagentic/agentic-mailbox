import { Download, Files, Inbox, Mail, MailOpen, RefreshCw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { EmailDetail, EmailSummary, MailAlias } from '../../shared/types';
import { formatBytes, formatDate, formatLongDate, initials, senderLabel } from '../format';
import { Modal } from '../components/Modal';

type InboxViewProps = {
  emails: EmailSummary[];
  aliases: MailAlias[];
  detail: EmailDetail | null;
  detailLoading: boolean;
  onOpenEmail: (id: string) => void;
  onCloseEmail: () => void;
  onToggleRead: (id: string, read: boolean) => void;
  onRefresh: () => void;
};

export function InboxView({
  emails,
  aliases,
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

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return emails.filter((email) => {
      if (aliasId && email.aliasId !== aliasId) return false;
      if (unreadOnly && email.readAt) return false;
      if (!normalized) return true;
      return [email.subject, email.fromAddress, email.fromName, email.toAddress, email.preview]
        .join(' ')
        .toLowerCase()
        .includes(normalized);
    });
  }, [aliasId, emails, query, unreadOnly]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">邮件</p>
          <h1>收件箱</h1>
          <p>{emails.filter((email) => !email.readAt).length} 封未读邮件</p>
        </div>
        <button className="icon-button icon-button--bordered" type="button" onClick={onRefresh} title="刷新" aria-label="刷新">
          <RefreshCw size={17} />
        </button>
      </header>

      <div className="toolbar">
        <label className="search-field">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索发件人或主题" />
        </label>
        <select className="select-control" value={aliasId} onChange={(event) => setAliasId(event.target.value)} aria-label="筛选邮箱">
          <option value="">全部邮箱</option>
          {aliases.map((alias) => (
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
        {filtered.length > 0 ? (
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
