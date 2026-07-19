import { Download, File, Files, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AttachmentItem, MailAlias } from '../../shared/types';
import { formatBytes, formatDate } from '../format';

type FilesViewProps = {
  files: AttachmentItem[];
  aliases: MailAlias[];
};

export function FilesView({ files, aliases }: FilesViewProps) {
  const [query, setQuery] = useState('');
  const [aliasId, setAliasId] = useState('');

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return files.filter((file) => {
      if (aliasId && file.aliasId !== aliasId) return false;
      if (!normalized) return true;
      return [file.filename, file.contentType, file.aliasAddress, file.emailSubject]
        .join(' ')
        .toLowerCase()
        .includes(normalized);
    });
  }, [aliasId, files, query]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">存储</p>
          <h1>附件</h1>
          <p>{files.length} 个邮件附件</p>
        </div>
      </header>

      <div className="toolbar">
        <label className="search-field">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名或邮件主题" />
        </label>
        <select className="select-control" value={aliasId} onChange={(event) => setAliasId(event.target.value)} aria-label="筛选邮箱">
          <option value="">全部邮箱</option>
          {aliases.map((alias) => <option value={alias.id} key={alias.id}>{alias.address}</option>)}
        </select>
      </div>

      <section className="data-panel file-table" aria-label="附件列表">
        <div className="table-head file-row">
          <span>文件</span>
          <span>来源邮件</span>
          <span>收件邮箱</span>
          <span>大小</span>
          <span>时间</span>
          <span />
        </div>
        {filtered.length > 0 ? (
          filtered.map((file) => (
            <div className="file-row file-row--item" key={file.id}>
              <span className="file-name"><span className="file-icon"><File size={17} /></span><span><strong>{file.filename}</strong><small>{file.contentType}</small></span></span>
              <span className="truncate-cell">{file.emailSubject}</span>
              <span className="truncate-cell">{file.aliasAddress}</span>
              <span>{formatBytes(file.size)}</span>
              <span>{formatDate(file.createdAt)}</span>
              <a className="icon-button" href={`/api/attachments/${encodeURIComponent(file.id)}/download`} title="下载附件" aria-label="下载附件">
                <Download size={17} />
              </a>
            </div>
          ))
        ) : (
          <div className="empty-state"><Files size={28} /><strong>没有匹配的附件</strong></div>
        )}
      </section>
    </div>
  );
}
