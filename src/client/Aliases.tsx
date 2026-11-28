import { useEffect, useState, type FormEvent } from 'react';
import type { MailAlias } from '../shared/types';
import { api } from './api';

export default function Aliases() {
  const [items, setItems] = useState<MailAlias[]>([]);
  const [local, setLocal] = useState('');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function list(query: string) {
    const result = await api<{ aliases: MailAlias[] }>('/api/aliases?q=' + encodeURIComponent(query));
    setItems(result.aliases); setApplied(query);
  }
  useEffect(() => { void list('').catch(e => setError(e.message)); }, []);
  async function action(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function create(e: FormEvent) {
    e.preventDefault(); void action(async () => {
      await api('/api/aliases', { method: 'POST', body: JSON.stringify({ localPart: local }) });
      setLocal(''); setSearch(''); await list('');
    });
  }
  return <section aria-labelledby="aliases-heading"><h2 id="aliases-heading">域名别名</h2>
    <p>已启用的托管别名共用管理员的目标邮箱。</p>
    <fieldset disabled={busy}><form onSubmit={create}><label htmlFor="local">新别名前缀</label>
      <div className="row"><input id="local" required value={local} maxLength={64} onChange={e => setLocal(e.target.value)} />
        <button>创建别名</button></div></form>
      <form className="search" onSubmit={e => { e.preventDefault(); void action(() => list(search)); }}>
        <label htmlFor="alias-search">查找已有别名</label><div className="row"><input id="alias-search" type="search"
          value={search} onChange={e => setSearch(e.target.value)} /><button>查找</button></div></form>
      <ul className="alias-list">{items.map(item => <li key={item.id}><span><strong>{item.address}</strong><small>
        {item.label && item.label + ' · '}{item.status === 'active' ? '已启用' : '已停用'}</small></span>
        <button onClick={() => void action(async () => {
          await api('/api/aliases/' + encodeURIComponent(item.id), { method: 'PATCH',
            body: JSON.stringify({ status: item.status === 'active' ? 'disabled' : 'active' }) });
          await list(applied);
        })}>{item.status === 'active' ? '停用' : '启用'}</button></li>)}</ul>
    </fieldset>
    {!items.length && !error && <p>{applied ? '没有匹配的别名。' : '还没有托管别名。'}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
