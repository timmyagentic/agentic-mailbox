import { ArrowRight, AtSign, Files, HardDrive, Inbox, MailOpen, Plus } from 'lucide-react';
import type { DashboardStats, EmailSummary, MailAlias } from '../../shared/types';
import { formatBytes, formatDate, senderLabel } from '../format';
import type { ViewName } from '../components/Layout';

type OverviewViewProps = {
  stats: DashboardStats;
  emails: EmailSummary[];
  aliases: MailAlias[];
  onNavigate: (view: ViewName) => void;
  onCreateAlias: () => void;
  onOpenEmail: (id: string) => void;
};

export function OverviewView({
  stats,
  emails,
  aliases,
  onNavigate,
  onCreateAlias,
  onOpenEmail,
}: OverviewViewProps) {
  const metrics = [
    { label: '启用邮箱', value: stats.activeAliasCount, detail: `共 ${stats.aliasCount} 个`, icon: AtSign, tone: 'teal' },
    { label: '邮件总数', value: stats.emailCount, detail: `${stats.unreadCount} 封未读`, icon: Inbox, tone: 'blue' },
    { label: '附件文件', value: stats.attachmentCount, detail: formatBytes(stats.attachmentBytes), icon: Files, tone: 'amber' },
    { label: '存储状态', value: '正常', detail: 'D1 + R2', icon: HardDrive, tone: 'slate' },
  ];

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">工作台</p>
          <h1>邮箱概览</h1>
          <p>当前邮箱、邮件与附件状态</p>
        </div>
        <button className="button button--primary" type="button" onClick={onCreateAlias}>
          <Plus size={17} />
          新建邮箱
        </button>
      </header>

      <section className="metrics-grid" aria-label="关键指标">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <article className="metric" key={metric.label}>
              <div className={`metric__icon metric__icon--${metric.tone}`}>
                <Icon size={18} />
              </div>
              <div>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <small>{metric.detail}</small>
              </div>
            </article>
          );
        })}
      </section>

      <div className="overview-grid">
        <section className="content-section">
          <header className="section-header">
            <div>
              <h2>最近邮件</h2>
              <span>{stats.unreadCount} 封未读</span>
            </div>
            <button className="text-button" type="button" onClick={() => onNavigate('inbox')}>
              查看全部 <ArrowRight size={15} />
            </button>
          </header>
          <div className="compact-list">
            {emails.length > 0 ? (
              emails.slice(0, 6).map((email) => (
                <button className="compact-email" type="button" key={email.id} onClick={() => onOpenEmail(email.id)}>
                  <span className={`unread-marker ${email.readAt ? 'unread-marker--read' : ''}`} />
                  <div className="compact-email__main">
                    <strong>{senderLabel(email.fromName, email.fromAddress)}</strong>
                    <span>{email.subject}</span>
                  </div>
                  {email.attachmentCount > 0 ? <Files size={15} aria-label={`${email.attachmentCount} 个附件`} /> : null}
                  <time>{formatDate(email.receivedAt)}</time>
                </button>
              ))
            ) : (
              <div className="empty-state empty-state--compact">
                <MailOpen size={23} />
                <strong>暂无邮件</strong>
              </div>
            )}
          </div>
        </section>

        <section className="content-section">
          <header className="section-header">
            <div>
              <h2>邮箱地址</h2>
              <span>{stats.activeAliasCount} 个启用</span>
            </div>
            <button className="text-button" type="button" onClick={() => onNavigate('aliases')}>
              管理 <ArrowRight size={15} />
            </button>
          </header>
          <div className="alias-summary-list">
            {aliases.length > 0 ? (
              aliases.slice(0, 6).map((alias) => (
                <div className="alias-summary" key={alias.id}>
                  <div className="alias-avatar">@</div>
                  <div>
                    <strong>{alias.address}</strong>
                    <span>{alias.label || '未命名'}</span>
                  </div>
                  <span className={`status-badge ${alias.status === 'active' ? 'status-badge--active' : ''}`}>
                    {alias.status === 'active' ? '启用' : '停用'}
                  </span>
                </div>
              ))
            ) : (
              <div className="empty-state empty-state--compact">
                <AtSign size={23} />
                <strong>暂无邮箱</strong>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
