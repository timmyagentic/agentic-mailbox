import { AtSign, Copy, Plus, Search, WandSparkles } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import type { MailAlias } from '../../shared/types';
import { formatDate } from '../format';
import { Modal } from '../components/Modal';

type CreateInput = { localPart?: string; label: string; note?: string; generate: boolean };

type AliasesViewProps = {
  aliases: MailAlias[];
  primaryDomain: string;
  createOpen: boolean;
  busy: boolean;
  onOpenCreate: () => void;
  onCloseCreate: () => void;
  onCreate: (input: CreateInput) => Promise<void>;
  onToggle: (alias: MailAlias) => Promise<void>;
};

export function AliasesView({
  aliases,
  primaryDomain,
  createOpen,
  busy,
  onOpenCreate,
  onCloseCreate,
  onCreate,
  onToggle,
}: AliasesViewProps) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'custom' | 'generated'>('custom');
  const [localPart, setLocalPart] = useState('');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [copiedId, setCopiedId] = useState('');

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return aliases.filter((alias) =>
      !normalized || [alias.address, alias.label, alias.note].join(' ').toLowerCase().includes(normalized),
    );
  }, [aliases, query]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onCreate({
      localPart: mode === 'custom' ? localPart : undefined,
      label,
      note,
      generate: mode === 'generated',
    });
    setLocalPart('');
    setLabel('');
    setNote('');
    setMode('custom');
  };

  const copyAddress = async (alias: MailAlias) => {
    await navigator.clipboard.writeText(alias.address);
    setCopiedId(alias.id);
    window.setTimeout(() => setCopiedId(''), 1200);
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">路由</p>
          <h1>邮箱地址</h1>
          <p>{aliases.filter((alias) => alias.status === 'active').length} 个地址正在接收</p>
        </div>
        <button className="button button--primary" type="button" onClick={onOpenCreate}>
          <Plus size={17} />
          新建邮箱
        </button>
      </header>

      <div className="toolbar toolbar--single">
        <label className="search-field">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索邮箱或标签" />
        </label>
      </div>

      <section className="data-panel alias-table" aria-label="邮箱地址列表">
        <div className="table-head alias-row">
          <span>邮箱地址</span>
          <span>标签</span>
          <span>邮件</span>
          <span>最近接收</span>
          <span>模式</span>
          <span>状态</span>
          <span />
        </div>
        {filtered.length > 0 ? (
          filtered.map((alias) => (
            <div className="alias-row alias-row--item" key={alias.id}>
              <span className="alias-address"><span className="alias-avatar">@</span><strong>{alias.address}</strong></span>
              <span>{alias.label || '未命名'}</span>
              <span>{alias.messageCount}</span>
              <span>{formatDate(alias.lastReceivedAt)}</span>
              <span className={`mode-badge ${alias.routingMode === 'managed' ? 'mode-badge--managed' : ''}`}>
                {alias.routingMode === 'managed' ? '托管' : '转发'}
              </span>
              <label className="toggle-row toggle-row--compact" title={alias.routingMode === 'external' ? '外部规则由 Cloudflare 管理' : undefined}>
                <input
                  type="checkbox"
                  checked={alias.status === 'active'}
                  disabled={busy || alias.routingMode === 'external'}
                  onChange={() => void onToggle(alias)}
                />
                <span className="toggle" aria-hidden="true" />
                {alias.status === 'active' ? '启用' : '停用'}
              </label>
              <button className="icon-button" type="button" onClick={() => void copyAddress(alias)} title="复制地址" aria-label="复制地址">
                <Copy size={16} />
                {copiedId === alias.id ? <span className="copy-confirm">已复制</span> : null}
              </button>
            </div>
          ))
        ) : (
          <div className="empty-state"><AtSign size={28} /><strong>没有匹配的邮箱</strong></div>
        )}
      </section>

      {createOpen ? (
        <Modal title="新建邮箱" subtitle={`@${primaryDomain}`} onClose={onCloseCreate}>
          <form className="form-stack" onSubmit={submit}>
            <div className="segmented-control" aria-label="地址生成方式">
              <button className={mode === 'custom' ? 'is-active' : ''} type="button" onClick={() => setMode('custom')}>自定义地址</button>
              <button className={mode === 'generated' ? 'is-active' : ''} type="button" onClick={() => setMode('generated')}>
                <WandSparkles size={15} />自动生成
              </button>
            </div>

            {mode === 'custom' ? (
              <label className="form-field">
                <span>邮箱地址</span>
                <div className="address-field">
                  <input
                    value={localPart}
                    onChange={(event) => setLocalPart(event.target.value.toLowerCase())}
                    pattern="[a-z0-9][a-z0-9._+\-]{0,63}"
                    maxLength={64}
                    required
                    autoFocus
                  />
                  <span>@{primaryDomain}</span>
                </div>
              </label>
            ) : null}

            <label className="form-field">
              <span>用途标签</span>
              <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} placeholder="例如 GitHub 注册" autoFocus={mode === 'generated'} />
            </label>

            <label className="form-field">
              <span>备注</span>
              <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} rows={3} />
            </label>

            <div className="form-actions">
              <button className="button button--secondary" type="button" onClick={onCloseCreate}>取消</button>
              <button className="button button--primary" type="submit" disabled={busy || (mode === 'custom' && !localPart)}>
                {busy ? '创建中...' : '创建邮箱'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
