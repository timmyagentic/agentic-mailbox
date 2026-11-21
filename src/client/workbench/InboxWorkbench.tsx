// Copyright (c) 2026 Cloudflare, Inc.
// Mailbox layout and navigation adapted from Agentic Inbox under Apache-2.0. See LICENSE.agentic-inbox.
import { Button, Input } from '@cloudflare/kumo';
import {
  ArchiveIcon, ArrowUpIcon, ArrowsClockwiseIcon, CaretLeftIcon, CaretRightIcon, FileIcon, FolderIcon,
  GaugeIcon, GearSixIcon, ListIcon, MagnifyingGlassIcon, PaperPlaneTiltIcon, PencilSimpleIcon,
  RobotIcon, SignOutIcon, StarIcon, TrashIcon, TrayIcon, UserIcon, XIcon,
} from '@phosphor-icons/react';
import { type FormEvent, type ReactNode, lazy, Suspense, useEffect, useRef, useState } from 'react';
import type {
  Conversation, ConversationSummary, DraftInput, DraftMode, EmailDetail, EmailSummary, MailAccount, MailAlias, MailDraft, MailFolder,
} from '../../shared/types';
import { ApiRequestError, mailboxApi } from '../api';
import { formatDate, formatLongDate, senderLabel } from '../format';
import type { Composer } from './ComposePanel';
import MailboxSplitView from './MailboxSplitView';
import MailReader, { IconButton } from './MailReader';
import { asHtml, textBody } from './MessageBody';

export type ViewName = 'overview' | 'inbox' | 'aliases' | 'files';

type Folder = MailFolder | 'drafts';
const folders = [
  { id: 'inbox', label: '收件箱', Icon: TrayIcon }, { id: 'sent', label: '已发送', Icon: PaperPlaneTiltIcon },
  { id: 'drafts', label: '草稿', Icon: FileIcon }, { id: 'archive', label: '归档', Icon: ArchiveIcon },
  { id: 'trash', label: '废纸篓', Icon: TrashIcon },
] as const;
const PAGE_SIZE = 25;
const ComposePanel = lazy(() => import('./ComposePanel'));

type Props = {
  appName: string; primaryDomain: string; activeView: ViewName; selectedId: string | null;
  aliases: MailAlias[]; accounts: MailAccount[]; revision: EmailSummary[]; unread: number; refreshing: boolean;
  onNavigate: (view: ViewName) => void; onSelect: (id: string | null) => void;
  onRefresh: () => Promise<void>; onReload: () => Promise<void>; onLogout: () => void;
  onError: (error: unknown) => void; onNotice: (message: string) => void; children: ReactNode;
};

function address(value: string) {
  return value.match(/<([^<>]+)>/)?.[1] ?? value.trim().split(',')[0];
}

function quote(mail: EmailDetail) {
  const body = mail.bodyText || (mail.bodyHtml ? textBody(mail.bodyHtml) : '');
  return ['----- 原邮件 -----', `发件人：${mail.fromName || mail.fromAddress}`, `时间：${formatLongDate(mail.receivedAt)}`,
    `主题：${mail.subject}`, '', body].join('\n');
}

function newComposer(aliasId: string, mode: DraftMode, source?: EmailDetail, all = false): Composer {
  const to = mode === 'reply' && source ? address(source.outgoing ? source.toAddress : source.replyAddress || source.fromAddress) : '';
  const cc = all && source ? [source.toAddress, source.cc ?? ''].join(',').split(',').map(address)
    .filter((value) => value.includes('@') && value.toLowerCase() !== to.toLowerCase() && value.toLowerCase() !== source.aliasAddress.toLowerCase()).join(', ') : '';
  const prefix = mode === 'reply' ? 'Re:' : 'Fwd:';
  const subject = source ? (source.subject.toLowerCase().startsWith(prefix.toLowerCase()) ? source.subject : `${prefix} ${source.subject}`) : '';
  const bodyText = source ? `\n\n${quote(source)}` : '';
  return { status: 'draft', files: [], input: {
    aliasId, mode, sourceEmailId: source?.id ?? null, to, cc, bcc: '', subject, bodyText,
    bodyHtml: asHtml(bodyText), includeOriginalFiles: mode === 'forward',
  } };
}

function editorFrom(draft: MailDraft): Composer {
  const { id, files, status, aliasId, mode, sourceEmailId, to, cc, bcc, subject, bodyText, bodyHtml, includeOriginalFiles } = draft;
  return { id, files, status, input: { aliasId, mode, sourceEmailId, to, cc, bcc, subject, bodyText, bodyHtml, includeOriginalFiles } };
}

export default function InboxWorkbench({
  appName, primaryDomain, activeView, selectedId, aliases, accounts, revision, unread, refreshing,
  onNavigate, onSelect, onRefresh, onReload, onLogout, onError, onNotice, children,
}: Props) {
  const [folder, setFolder] = useState<Folder>('inbox');
  const [sourceId, setSourceId] = useState('');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [listed, setListed] = useState<{ conversations: ConversationSummary[]; total: number }>({ conversations: [], total: 0 });
  const [drafts, setDrafts] = useState<MailDraft[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [detail, setDetail] = useState<{ id: string; data: Conversation } | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [composeKey, setComposeKey] = useState(0);
  const [busy, setBusy] = useState('');
  const operationActive = useRef(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [suggestion, setSuggestion] = useState<{ request: string; answer: string } | null>(null);
  const [listRevision, setListRevision] = useState(0);

  const sources = [...aliases, ...accounts];
  const senders = [...aliases.filter((alias) => alias.status === 'active' && alias.routingMode === 'managed'), ...accounts];
  const data = detail && detail.id === selectedId ? detail.data : null;
  const current = data?.messages.find((mail) => mail.id === selectedId) ?? data?.messages.at(-1);
  const isMailView = activeView === 'inbox';
  const draftList = sourceId ? drafts.filter((draft) => draft.aliasId === sourceId) : drafts;
  const total = folder === 'drafts' ? draftList.length : listed.total;
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    if (!isMailView) return;
    const controller = new AbortController();
    setListLoading(true);
    const request = folder === 'drafts'
      ? mailboxApi.drafts(controller.signal).then((result) => { if (!controller.signal.aborted) setDrafts(result.drafts); })
      : mailboxApi.conversations({ folder, aliasId: sourceId, page, query, unreadOnly: onlyUnread, signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) return;
          setListed(result);
          if (result.total > 0 && !result.conversations.length && page > 1) setPage(Math.ceil(result.total / PAGE_SIZE));
        });
    void request.catch((error: unknown) => { if (!controller.signal.aborted) onError(error); })
      .finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, [folder, sourceId, page, query, onlyUnread, revision, onError, isMailView, listRevision]);

  useEffect(() => {
    if (!selectedId || !isMailView) return;
    const controller = new AbortController();
    void mailboxApi.conversation(selectedId, controller.signal).then(async (result) => {
      if (controller.signal.aborted) return;
      setDetail({ id: selectedId, data: result });
      if (folder === 'inbox' && result.messages.some((mail) => !mail.readAt && !mail.outgoing)) {
        await mailboxApi.markConversation(selectedId, true);
        if (controller.signal.aborted) return;
        setDetail({ id: selectedId, data: markRead(result, true) });
        await onReload();
      }
    }).catch((error: unknown) => { if (!controller.signal.aborted) onError(error); });
    return () => controller.abort();
  }, [selectedId, isMailView, onError, onReload, folder]);

  const navigate = (view: ViewName) => { setMobileMenu(false); onNavigate(view); };
  const selectFolder = (next: Folder) => {
    setFolder(next); setPage(1); setSearch(''); setQuery(''); setOnlyUnread(false); onSelect(null); navigate('inbox');
  };
  const invalidateList = () => setListRevision((value) => value + 1);
  const start = (mode: DraftMode = 'new', source?: EmailDetail, all?: boolean) => {
    const preferred = source?.aliasId ?? sourceId;
    const sender = mode === 'reply' && source ? source.aliasId : senders.find((item) => item.id === preferred)?.id ?? senders[0]?.id ?? '';
    const next = newComposer(sender, mode, source, all);
    setComposeKey((id) => id + 1); setComposer(next); setSuggestion(null); setMobileMenu(false);
    return next;
  };

  async function act(label: string, action: () => Promise<void>) {
    if (operationActive.current) return;
    operationActive.current = true;
    setBusy(label);
    try { await action(); }
    catch (error) { onError(error); }
    finally { operationActive.current = false; setBusy(''); }
  }

  const persist = async (value: Composer) => {
    const { draft } = await mailboxApi.saveDraft(value.input, value.id);
    setComposer(editorFrom(draft));
    invalidateList();
    return draft;
  };
  const save = (send: boolean) => {
    if (!composer) return;
    void act(send ? 'sending' : 'saving', async () => {
      const draft = await persist(composer);
      if (!send) { onNotice('草稿已保存。'); return; }
      try {
        const result = await mailboxApi.sendDraft(draft.id);
        setComposer(null); setFolder('sent'); setPage(1); setQuery(''); setSearch(''); setOnlyUnread(false);
        onSelect(result.id);
        await onReload();
        onNotice(result.rejected.length ? `已交给发信服务，${result.rejected.length} 个地址被拒绝。` : '邮件已交给发信服务。');
      } catch (error) {
        if (error instanceof ApiRequestError && ['delivery_uncertain', 'send_in_progress', 'network_error'].includes(error.code)) {
          const status = await mailboxApi.draft(draft.id).then((reply) => editorFrom(reply.draft)).catch(() => ({ ...editorFrom(draft), status: 'uncertain' as const }));
          setComposer(status);
        }
        throw error;
      }
    });
  };
  const edit = (id: string) => void act('editing', async () => {
    const { draft } = await mailboxApi.draft(id);
    setComposeKey((key) => key + 1); setComposer(editorFrom(draft)); onSelect(null);
  });
  const discard = () => void act('discarding', async () => {
    if (composer?.id) await mailboxApi.discardDraft(composer.id);
    setComposer(null); invalidateList();
  });
  const upload = (selection: FileList) => {
    if (!composer) return;
    const files = Array.from(selection);
    void act('uploading', async () => {
      const draft = await persist(composer);
      for (const item of files) {
        const { file } = await mailboxApi.addDraftFile(draft.id, item);
        setComposer((value) => value ? { ...value, files: [...value.files, file] } : value);
      }
    });
  };
  const remove = (id: string) => void act('removing', async () => {
    if (!composer?.id) return;
    await mailboxApi.removeDraftFile(composer.id, id);
    setComposer((value) => value ? { ...value, files: value.files.filter((file) => file.id !== id) } : value);
  });
  const generate = (event: FormEvent) => {
    event.preventDefault();
    void act('generating', async () => {
      const value = composer ?? (current ? start('reply', current) : start());
      const draft = await persist(value);
      const { text } = await mailboxApi.suggestDraft(draft.id, instruction);
      const parent = data?.messages.find((mail) => mail.id === value.input.sourceEmailId);
      const bodyText = parent ? `${text}\n\n${quote(parent)}` : text;
      const { draft: generated } = await mailboxApi.saveDraft({ ...value.input, bodyText, bodyHtml: asHtml(bodyText) }, draft.id);
      setComposer(editorFrom(generated));
      setSuggestion({ request: instruction.trim() || '根据当前会话起草回复', answer: text });
      setInstruction(''); invalidateList();
      if (window.matchMedia?.('(max-width: 1023px)').matches) setAgentOpen(false);
    });
  };
  const place = (id: string, update: { starred?: boolean; folder?: 'archive' | 'trash' | 'restore' }) => void act('placing', async () => {
    await mailboxApi.placeEmail(id, update);
    if (update.folder && id === selectedId) onSelect(null);
    await onReload();
  });
  const reading = (
    <div className="h-full overflow-y-auto min-h-0 bg-kumo-base">
      {composer ? <Suspense fallback={<p className="p-4 text-sm text-kumo-subtle" role="status">正在打开写信</p>}>
        <ComposePanel key={composeKey} composer={composer} senders={senders} busy={busy}
        onChange={(changes: Partial<DraftInput>) => setComposer((value) => value ? { ...value, input: { ...value.input, ...changes } } : value)}
        onSave={() => save(false)} onSend={() => save(true)} onClose={() => setComposer(null)}
        onDiscard={discard} onUpload={upload} onRemove={remove} onAI={() => setAgentOpen(true)} />
      </Suspense> : null}
      {selectedId ? <MailReader data={data} selectedId={selectedId} folder={folder}
        starred={Boolean(listed.conversations.find((mail) => mail.id === selectedId)?.starred)} onClose={() => onSelect(null)}
        onReply={(mail, all) => start('reply', mail, all)} onForward={(mail) => start('forward', mail)}
        onStar={(id, starred) => place(id, { starred })} onMove={(id, destination) => place(id, { folder: destination })}
        onRead={(read) => void act('marking', async () => {
          await mailboxApi.markConversation(selectedId, read);
          if (data) setDetail({ id: selectedId, data: markRead(data, read) });
          await onReload();
        })} /> : null}
    </div>
  );

  return (
    <div className="vault-workbench flex overflow-hidden bg-kumo-base text-kumo-default antialiased">
      {mobileMenu ? <button type="button" aria-label="关闭导航" className="fixed inset-0 z-20 bg-black/20 border-0 md:hidden" onClick={() => setMobileMenu(false)} /> : null}
      <aside className={`flex-col w-[240px] shrink-0 border-r border-kumo-line bg-kumo-tint
        ${mobileMenu ? 'flex fixed top-0 left-0 bottom-0 z-30' : 'hidden md:flex'}`}>
        <div className="px-4 pt-4 pb-3">
          <Button variant="ghost" size="sm" icon={<CaretLeftIcon size={16} />} onClick={() => navigate('aliases')}>邮箱地址</Button>
          <div className="font-semibold text-base mt-2 truncate">{appName}</div>
          <div className="text-sm text-kumo-subtle truncate">{sources.find(({ id }) => id === sourceId)?.address ?? primaryDomain}</div>
        </div>
        <div className="px-2 pb-3">
          <Button variant="primary" icon={<PencilSimpleIcon size={18} />} className="w-full justify-start" disabled={Boolean(busy)}
            onClick={() => { navigate('inbox'); start(); }}>写信</Button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 space-y-1.5" aria-label="邮箱导航">
          {folders.map(({ id, label, Icon }) => {
            const active = isMailView && id === folder;
            const count = id === 'inbox' ? unread : id === 'drafts' ? drafts.length : 0;
            return <button key={id} type="button" onClick={() => selectFolder(id)} aria-current={active ? 'page' : undefined}
              className={`vault-outline flex items-center gap-3 w-full px-3 py-2 rounded-md border-0 cursor-pointer text-left text-sm
                ${active ? 'bg-kumo-fill text-kumo-default font-semibold' : 'bg-transparent text-kumo-subtle hover:bg-kumo-fill'}`}>
              <Icon size={18} />{label}{count > 0 ? <span className="ml-auto text-xs tabular-nums">{count}</span> : null}
            </button>;
          })}
          <div className="mt-6 px-2">
            <label htmlFor="vault-source" className="block text-xs font-medium text-kumo-subtle mb-2">邮箱来源</label>
            <select id="vault-source" className="w-full min-w-0 border border-kumo-line rounded-md px-2 py-1.5 bg-kumo-base text-sm text-kumo-default"
              aria-label="筛选邮箱" value={sourceId}
              onChange={(event) => { setSourceId(event.target.value); setPage(1); onSelect(null); if (!isMailView) navigate('inbox'); }}>
              <option value="">全部邮箱</option>
              {sources.map(({ id, address }) => <option key={id} value={id}>{address}</option>)}
            </select>
          </div>
          <div className="mt-5 space-y-1 border-t border-kumo-line pt-2">
            <Button variant={activeView === 'overview' ? 'secondary' : 'ghost'} className="w-full justify-start" size="sm" icon={<GaugeIcon size={17} />} onClick={() => navigate('overview')}>概览</Button>
            <Button variant={activeView === 'files' ? 'secondary' : 'ghost'} className="w-full justify-start" size="sm" icon={<FolderIcon size={17} />} onClick={() => navigate('files')}>附件</Button>
          </div>
        </nav>
        <div className="flex gap-2 items-center border-t border-kumo-line p-3">
          <span className="text-xs text-kumo-subtle flex-1 truncate">管理员</span>
          <IconButton label="退出登录" icon={<SignOutIcon size={18} />} onClick={onLogout} />
        </div>
      </aside>
      <main className="flex-1 flex flex-col min-w-0 bg-kumo-base">
        <header className="flex items-center gap-2 px-3 py-2.5 bg-kumo-base border-b border-kumo-line shrink-0 md:px-5 md:gap-4">
          <IconButton label="打开导航" icon={<ListIcon size={20} />} onClick={() => setMobileMenu(true)} className="md:hidden shrink-0" />
          <form className="flex-1 min-w-0 max-w-lg flex items-center gap-1" onSubmit={(event) => {
            event.preventDefault(); setQuery(search.trim()); setPage(1); onSelect(null);
            if (folder === 'drafts') setFolder('inbox');
            navigate('inbox');
          }}>
            <Input value={search} onChange={(event) => setSearch(event.target.value)} className="w-full min-w-0"
              aria-label="搜索邮件" placeholder="搜索邮件主题、发件人或正文" />
            <Button variant="ghost" shape="square" icon={<MagnifyingGlassIcon size={19} />} aria-label="搜索" type="submit" />
          </form>
          <label className="hidden sm:flex items-center gap-1 text-xs text-kumo-subtle whitespace-nowrap">
            <input type="checkbox" checked={onlyUnread} onChange={(event) => { setOnlyUnread(event.target.checked); setPage(1); }} /> 仅未读
          </label>
          <div className="flex items-center gap-1 ml-auto shrink-0">
            <IconButton label={agentOpen ? '收起 AI 面板' : '打开 AI 面板'} icon={<RobotIcon size={20} />}
              active={agentOpen} onClick={() => { if (!isMailView) navigate('inbox'); setAgentOpen((open) => !open); }} />
            <IconButton label="邮箱设置" icon={<GearSixIcon size={20} />} onClick={() => navigate(activeView === 'aliases' ? 'inbox' : 'aliases')} />
          </div>
        </header>
        <div className="flex-1 overflow-hidden workbench-content">
          {isMailView ? <MailboxSplitView isPanelOpen={Boolean(selectedId || composer)} reading={reading}>
            <div className="flex items-center gap-2 border-b border-kumo-line px-3 md:px-5 py-3 shrink-0">
              <h1 className="text-base font-semibold m-0">{query ? '搜索结果' : folders.find((item) => item.id === folder)?.label}</h1>
              <span className="flex-1" />
              <span className="text-xs text-kumo-subtle">{total} {folder === 'drafts' ? '封草稿' : '个会话'}</span>
              <IconButton label={folder === 'inbox' ? '一键刷新' : '刷新列表'} icon={<ArrowsClockwiseIcon size={18} />}
                onClick={() => { if (folder === 'inbox') void onRefresh(); else invalidateList(); }} disabled={refreshing} />
            </div>
            <div className="min-h-0 overflow-y-auto flex-1 workbench-history" aria-busy={listLoading || refreshing}>
              {folder === 'drafts' ? draftList.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((draft) => (
                <button key={draft.id} type="button" className="vault-row vault-outline text-left flex flex-col w-full px-4 py-2.5 border-0 border-b border-solid border-kumo-line bg-kumo-base hover:bg-kumo-tint cursor-pointer"
                  onClick={() => edit(draft.id)}>
                  <span className="text-sm font-semibold w-full truncate">{draft.to || draft.fromAddress}</span>
                  <span className="text-sm text-kumo-subtle w-full truncate">{draft.subject || '（无主题）'}{draft.status !== 'draft' ? ' · 发送待确认' : ''}</span>
                </button>
              )) : listed.conversations.map((mail) => <MailRow key={mail.id} mail={mail} selected={mail.id === selectedId}
                showAddress={!sourceId} onSelect={() => { if (!busy) onSelect(mail.id); }}
                onStar={() => place(mail.id, { starred: !mail.starred })} />)}
              {!total && !listLoading ? <div className="flex flex-col items-center justify-center py-24 px-6 text-center">
                <TrayIcon size={42} weight="thin" className="text-kumo-subtle mb-3" />
                <p className="text-sm font-medium">{query ? '没有匹配的邮件' : folder === 'drafts' ? '没有草稿' : '这里还没有邮件'}</p>
              </div> : null}
            </div>
            {total ? <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 border-t border-kumo-line">
              <span className="text-xs text-kumo-subtle">{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} / {total}</span>
              <div className="flex items-center border border-kumo-line rounded-md">
                <IconButton label="上一页" icon={<CaretLeftIcon size={16} />} disabled={page <= 1} onClick={() => setPage((value) => value - 1)} />
                <span className="px-2 text-xs tabular-nums">{page}</span>
                <IconButton label="下一页" icon={<CaretRightIcon size={16} />} disabled={page >= maxPage} onClick={() => setPage((value) => value + 1)} />
              </div>
            </div> : null}
          </MailboxSplitView> : <div className="h-full overflow-y-auto p-4 md:p-6 bg-kumo-recessed">{children}</div>}
        </div>
      </main>
      {agentOpen && isMailView ? <aside className="fixed top-0 bottom-0 right-0 z-30 max-w-full w-[340px] shrink-0 border-l border-kumo-line flex flex-col bg-kumo-base overflow-hidden lg:static lg:w-[min(27%,380px)]" aria-label="邮件 Agent">
        <div className="flex items-center justify-between border-b border-kumo-line">
          <h2 className="m-0 px-4 py-3 flex items-center gap-2 border-b-2 border-kumo-brand text-sm font-semibold"><RobotIcon size={17} weight="fill" /> Agent</h2>
          <IconButton label="关闭 AI 面板" icon={<XIcon size={16} />} onClick={() => setAgentOpen(false)} />
        </div>
        <div className="px-3 py-2 border-b border-kumo-line flex items-center gap-2 text-sm text-kumo-subtle">
          <span className="rounded-full border border-dashed border-kumo-brand text-kumo-brand px-2">AI</span> 邮件草稿
        </div>
        <div className="flex-1 overflow-y-auto workbench-history space-y-3 px-3 py-4 text-sm">
          {suggestion ? <>
            <div className="flex justify-end items-start gap-2"><div className="bg-kumo-brand text-white rounded-lg p-3 whitespace-pre-wrap">{suggestion.request}</div>
              <UserIcon size={17} className="shrink-0 mt-1 text-kumo-brand" /></div>
            <div className="flex items-start gap-2"><RobotIcon size={17} className="shrink-0 mt-2" />
              <div className="rounded-lg border border-kumo-line p-3 bg-kumo-fill/30 whitespace-pre-wrap wrap-anywhere">{suggestion.answer}</div>
            </div>
          </> : <p className="text-kumo-subtle m-0">选择会话，或输入要求起草一封新邮件。</p>}
          {busy === 'generating' ? <p role="status" className="text-kumo-subtle">正在起草…</p> : null}
        </div>
        <form onSubmit={generate} className="border-t border-kumo-line p-2.5 flex gap-2 items-end">
          <textarea className="flex-1 min-w-0 resize-none rounded-md border border-kumo-line bg-kumo-base p-2 text-sm"
            rows={2} aria-label="AI 起草要求" placeholder="告诉 Agent 你想怎么写…" value={instruction} onChange={(event) => setInstruction(event.target.value)} />
          <Button variant="primary" shape="square" size="sm" type="submit" aria-label="生成草稿"
            icon={<ArrowUpIcon size={17} />} disabled={Boolean(busy) || (!instruction.trim() && !current && !composer?.input.subject.trim())} />
        </form>
      </aside> : null}
    </div>
  );
}

function markRead(data: Conversation, read: boolean): Conversation {
  const at = read ? new Date().toISOString() : null;
  return { ...data, messages: data.messages.map((mail) => mail.outgoing ? mail : { ...mail, readAt: at }) };
}

function MailRow({ mail, selected, showAddress, onSelect, onStar }: {
  mail: ConversationSummary; selected: boolean; showAddress: boolean; onSelect: () => void; onStar: () => void;
}) {
  return <div className={`vault-row flex items-center border-b border-kumo-line ${selected ? 'bg-kumo-tint' : 'bg-kumo-base hover:bg-kumo-tint'}`}>
    <span aria-label={mail.unreadCount ? '未读' : undefined}
      className={`ml-3 mr-1 w-2 h-2 shrink-0 rounded-full ${mail.unreadCount ? 'bg-kumo-brand' : 'bg-transparent'}`} />
    <IconButton label={mail.starred ? '取消星标' : '加星标'} icon={<StarIcon size={16} weight={mail.starred ? 'fill' : 'regular'} />} onClick={onStar} />
    <button type="button" onClick={onSelect} className="vault-outline flex-1 text-left min-w-0 py-2.5 pr-4 pl-2 bg-transparent border-0 cursor-pointer text-kumo-default">
      <span className="flex items-center gap-2 min-w-0">
        <span className={`text-sm truncate ${mail.unreadCount ? 'font-semibold' : ''}`}>{mail.outgoing ? mail.toAddress : senderLabel(mail.fromName, mail.fromAddress)}</span>
        {mail.threadCount > 1 ? <span className="rounded-full px-1.5 bg-kumo-fill text-kumo-subtle text-xs">{mail.threadCount}</span> : null}
        <time className="ml-auto shrink-0 text-xs text-kumo-subtle" dateTime={mail.receivedAt}>{formatDate(mail.receivedAt)}</time>
      </span>
      <span className={`block text-sm truncate ${mail.unreadCount ? 'font-semibold' : 'text-kumo-subtle'}`}>{mail.subject}</span>
      {showAddress ? <span className="block text-xs truncate text-kumo-subtle">{mail.aliasAddress}</span> : null}
    </button>
  </div>;
}
