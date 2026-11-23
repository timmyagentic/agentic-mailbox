// Copyright (c) 2026 Cloudflare, Inc.
// Reader adapted from Agentic Inbox under Apache-2.0. See LICENSE.agentic-inbox.
import { Button } from '@cloudflare/kumo';
import { Button as ActionButton } from '@heroui/react/button';
import {
  ArrowBendUpLeftIcon, ArrowBendUpRightIcon, ArrowLeftIcon, CaretDownIcon, ChatCircleIcon,
  EnvelopeSimpleIcon, FileIcon, FolderIcon, StarIcon, TrashIcon, XIcon,
} from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import type { Conversation, EmailDetail, MailFolder } from '../../shared/types';
import { formatBytes, formatDate, senderLabel } from '../format';
import { MessageBody } from './MessageBody';

export function IconButton({
  label, icon, onClick, active, disabled, className,
}: { label: string; icon: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean; className?: string }) {
  return <ActionButton type="button" aria-label={label} aria-pressed={active}
    className={['mail-icon',className].filter(Boolean).join(' ')} onPress={onClick} isDisabled={disabled}>{icon}</ActionButton>;
}

export default function MailReader({
  data, selectedId, folder, starred, onClose, onReply, onForward, onStar, onMove, onRead,
}: {
  data: Conversation | null; selectedId: string; folder: MailFolder | 'drafts'; starred: boolean;
  onClose: () => void; onReply: (mail: EmailDetail, all?: boolean) => void; onForward: (mail: EmailDetail) => void;
  onStar: (id: string, starred: boolean) => void; onMove: (id: string, folder: 'archive' | 'trash' | 'restore') => void;
  onRead: (read: boolean) => void;
}) {
  const main = data?.messages.find((message) => message.id === selectedId) ?? data?.messages.at(-1);
  const unread = data?.messages.some((message) => !message.readAt && !message.outgoing);
  const canRestore = folder === 'archive' || folder === 'trash';
  return <section aria-label="邮件会话">
    <div className="flex items-center gap-1 px-3 py-2 border-b border-kumo-line md:px-4">
      <IconButton label="返回列表" icon={<ArrowLeftIcon size={18} />} className="md:hidden" onClick={onClose} />
      {main ? <>
        <IconButton label="回复" icon={<ArrowBendUpLeftIcon size={18} />} onClick={() => onReply(main)} />
        <IconButton label="回复全部" icon={<ChatCircleIcon size={18} />} onClick={() => onReply(main, true)} />
        <IconButton label="转发" icon={<ArrowBendUpRightIcon size={18} />} onClick={() => onForward(main)} />
        <span className="h-5 w-px bg-kumo-line mx-1" />
        <IconButton label={starred ? '取消星标' : '加星标'} icon={<StarIcon size={18} weight={starred ? 'fill' : 'regular'} />} onClick={() => onStar(main.id, !starred)} />
        <IconButton label={unread ? '标记已读' : '标记未读'} icon={<EnvelopeSimpleIcon size={18} />} onClick={() => onRead(Boolean(unread))} disabled={folder !== 'inbox'} />
        <IconButton label={canRestore ? '恢复到原文件夹' : '归档'} icon={<FolderIcon size={18} />} onClick={() => onMove(main.id, canRestore ? 'restore' : 'archive')} />
        <span className="flex-1" />
        {folder === 'trash' ? null : <IconButton label="移到废纸篓" icon={<TrashIcon size={18} />} onClick={() => onMove(main.id, 'trash')} />}
      </> : null}
      <IconButton label="关闭会话" icon={<XIcon size={18} />} className="hidden md:inline-flex" onClick={onClose} />
    </div>
    {data && main ? <>
      <header className="border-b border-kumo-line px-4 py-4 md:px-6">
        <h2 className="font-semibold text-lg leading-snug m-0">{main.subject}</h2>
        <p className="text-sm text-kumo-subtle mt-1 mb-0">{data.total} 封会话邮件{data.total > 50 ? ' · 显示最近 50 封' : ''}</p>
      </header>
      {data.messages.map((mail) => <ThreadMessage key={mail.id} mail={mail}
        selected={mail.id === selectedId || mail.id === data.messages.at(-1)?.id}
        onReply={() => onReply(mail)} onForward={() => onForward(mail)} />)}
    </> : <div className="p-5 text-sm text-kumo-subtle" role="status">正在加载邮件</div>}
  </section>;
}

function ThreadMessage({ mail, selected, onReply, onForward }: {
  mail: EmailDetail; selected: boolean; onReply: () => void; onForward: () => void;
}) {
  const sender = senderLabel(mail.fromName, mail.fromAddress);
  return (
    <details open={selected || undefined} className="group border-b border-kumo-line">
      <summary className="mailbox-outline list-none cursor-pointer flex items-center gap-3 px-4 py-3 md:px-6 hover:bg-kumo-tint/50">
        <span className="rounded-full bg-kumo-fill w-9 h-9 flex items-center justify-center text-sm font-semibold shrink-0" aria-hidden="true">{sender[0]?.toUpperCase() || '@'}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{sender}</span>
          <span className="block truncate text-xs text-kumo-subtle">收件人：{mail.outgoing ? mail.toAddress : mail.aliasAddress}</span>
        </span>
        <time className="text-xs text-kumo-subtle shrink-0" dateTime={mail.receivedAt}>{formatDate(mail.receivedAt)}</time>
        <CaretDownIcon className="shrink-0 group-open:rotate-180" size={15} />
      </summary>
      <div className="px-4 pb-4 md:pl-18 md:pr-6">
        <MessageBody text={mail.bodyText} html={mail.bodyHtml} />
        {mail.attachments.length ? <ul className="m-0 mt-3 list-none p-0 flex flex-wrap gap-2">
          {mail.attachments.map((file) => <li key={file.id}><a className="flex items-center gap-2 rounded-md border border-kumo-line px-2.5 py-1.5 text-sm text-kumo-default"
            href={`/api/attachments/${encodeURIComponent(file.id)}/download`}>
            <FileIcon size={16} />{file.filename}<span className="text-xs text-kumo-subtle">{formatBytes(file.size)}</span>
          </a></li>)}
        </ul> : null}
        <div className="flex items-center gap-2 mt-4">
          <Button variant="secondary" size="sm" icon={<ArrowBendUpLeftIcon size={15} />} onClick={onReply}>回复</Button>
          <Button variant="secondary" size="sm" icon={<ArrowBendUpRightIcon size={15} />} onClick={onForward}>转发</Button>
        </div>
      </div>
    </details>
  );
}
