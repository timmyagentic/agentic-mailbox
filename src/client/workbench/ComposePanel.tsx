// Copyright (c) 2026 Cloudflare, Inc.
// Layout adapted from Agentic Inbox under Apache-2.0. See LICENSE.agentic-inbox.
import { Button, Input } from '@cloudflare/kumo';
import {
  ArrowBendUpLeftIcon, ArrowBendUpRightIcon, FloppyDiskIcon, ListBulletsIcon, ListNumbersIcon,
  PaperclipIcon, PaperPlaneTiltIcon, RobotIcon, TextBIcon, TextItalicIcon, TextUnderlineIcon, XIcon,
} from '@phosphor-icons/react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import type { DraftFile, DraftInput, MailDraft } from '../../shared/types';
import { formatBytes } from '../format';
import { asHtml, cleanBody } from './MessageBody';

export type Composer = { id?: string; input: DraftInput; status: MailDraft['status']; files: DraftFile[] };

type Props = {
  composer: Composer;
  senders: { id: string; address: string }[];
  busy: string;
  onChange: (changes: Partial<DraftInput>) => void;
  onSave: () => void;
  onSend: () => void;
  onClose: () => void;
  onDiscard: () => void;
  onUpload: (files: FileList) => void;
  onRemove: (fileId: string) => void;
  onAI: () => void;
};

export default function ComposePanel({
  composer, senders, busy, onChange, onSave, onSend, onClose, onDiscard, onUpload, onRemove, onAI,
}: Props) {
  const { input, files, status } = composer;
  const [showCcBcc, setShowCcBcc] = useState(Boolean(input.cc || input.bcc));
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const blocked = status !== 'draft' || Boolean(busy);
  const latestChange = useRef(onChange);
  useEffect(() => { latestChange.current = onChange; }, [onChange]);
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: false, heading: false })],
    content: input.bodyHtml ? cleanBody(input.bodyHtml) : asHtml(input.bodyText),
    editorProps: { attributes: { 'aria-label': '邮件正文', role: 'textbox', 'aria-multiline': 'true' } },
    onUpdate: ({ editor }) => latestChange.current({ bodyText: editor.getText({ blockSeparator: '\n\n' }), bodyHtml: editor.getHTML() }),
  });

  useEffect(() => {
    if (!editor) return;
    const content = input.bodyHtml || asHtml(input.bodyText);
    if (editor.getHTML() !== content) editor.commands.setContent(content, { emitUpdate: false });
  }, [editor, input.bodyHtml, input.bodyText]);

  useEffect(() => { editor?.setEditable(!blocked); }, [editor, blocked]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSend();
  };

  return (
    <section className="flex flex-col min-w-0 bg-kumo-base vault-compose" aria-label="邮件编辑器">
      <div className="flex items-center justify-between border-b border-kumo-line px-4 py-2.5 md:px-6">
        <h2 className="text-base font-semibold">
          {input.mode === 'reply' ? '回复邮件' : input.mode === 'forward' ? '转发邮件' : '写信'}
        </h2>
        <Button variant="ghost" shape="square" size="sm" aria-label="关闭写信" onClick={onClose} disabled={Boolean(busy)} icon={<XIcon size={18} />} />
      </div>
      <form className="flex flex-col min-h-0" onSubmit={submit}>
        <fieldset disabled={blocked} className="border-0 px-4 py-3 md:px-6 space-y-3 min-w-0">
          <label className="flex items-center gap-2">
            <span className="text-sm font-medium text-kumo-subtle w-14 shrink-0">发件人</span>
            <select className="w-full min-w-0 rounded-md border border-kumo-line px-2 py-1.5 bg-kumo-base text-sm" aria-label="发件人"
              value={input.aliasId} disabled={blocked || input.mode === 'reply'} required onChange={(event) => onChange({ aliasId: event.target.value })}>
              <option value="" disabled>请选择发件地址</option>
              {senders.map(({ id, address }) => <option key={id} value={id}>{address}</option>)}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <label htmlFor={`${labelId}-to`} className="w-14 shrink-0 text-sm font-medium text-kumo-subtle">收件人</label>
            <Input id={`${labelId}-to`} className="flex-1 min-w-0" size="sm" value={input.to}
              placeholder="多个地址用逗号分隔" onChange={(event) => onChange({ to: event.target.value })} />
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowCcBcc((show) => !show)}>CC / BCC</Button>
          </div>
          {showCcBcc ? (['cc', 'bcc'] as const).map((field) => (
            <label className="flex items-center gap-2" key={field}>
              <span className="w-14 shrink-0 text-sm font-medium text-kumo-subtle">{field === 'cc' ? '抄送' : '密送'}</span>
              <Input className="flex-1 min-w-0" size="sm" value={input[field]}
                onChange={(event) => onChange({ [field]: event.target.value })} />
            </label>
          )) : null}
          <label className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-sm font-medium text-kumo-subtle">主题</span>
            <Input className="flex-1 min-w-0" size="sm" value={input.subject} onChange={(event) => onChange({ subject: event.target.value })} />
          </label>
          <div className="border border-kumo-line rounded-md overflow-hidden bg-kumo-base">
            <div className="flex flex-wrap gap-0.5 border-b border-kumo-line p-1.5 bg-kumo-fill/30">
              {([
                ['粗体', <TextBIcon size={17} />, () => editor?.chain().focus().toggleBold().run()],
                ['斜体', <TextItalicIcon size={17} />, () => editor?.chain().focus().toggleItalic().run()],
                ['下划线', <TextUnderlineIcon size={17} />, () => editor?.chain().focus().toggleUnderline().run()],
                ['无序列表', <ListBulletsIcon size={17} />, () => editor?.chain().focus().toggleBulletList().run()],
                ['有序列表', <ListNumbersIcon size={17} />, () => editor?.chain().focus().toggleOrderedList().run()],
              ] as const).map(([label, icon, handler]) => (
                <Button key={label} aria-label={label} title={label} type="button" variant="ghost" size="sm" shape="square" icon={icon} onClick={handler} />
              ))}
              <Button variant="ghost" size="sm" type="button" icon={<RobotIcon size={17} />} className="ml-auto" onClick={onAI}>AI 起草</Button>
            </div>
            <EditorContent editor={editor} />
          </div>
          {input.mode === 'forward' ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={input.includeOriginalFiles} onChange={(event) => onChange({ includeOriginalFiles: event.target.checked })} />
              附带原邮件附件
            </label>
          ) : null}
          <input ref={filePicker} type="file" multiple hidden onChange={(event) => {
            if (event.target.files?.length) onUpload(event.target.files);
            event.target.value = '';
          }} />
          <div className="flex gap-2 flex-wrap items-center">
            <Button variant="ghost" size="sm" type="button" icon={<PaperclipIcon size={16} />} onClick={() => filePicker.current?.click()}>添加附件</Button>
            {files.map((file) => (
              <span key={file.id} className="rounded-md border border-kumo-line px-2 py-1 flex gap-2 items-center text-xs">
                {file.filename} · {formatBytes(file.size)}
                <Button variant="ghost" shape="square" size="xs" type="button" aria-label={`移除 ${file.filename}`} icon={<XIcon size={12} />} onClick={() => onRemove(file.id)} />
              </span>
            ))}
          </div>
        </fieldset>
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-kumo-line bg-kumo-fill/30 md:px-6">
          {confirmDiscard ? (
            <Button variant="ghost" size="sm" type="button" disabled={blocked} onClick={onDiscard}>确认丢弃</Button>
          ) : <Button variant="ghost" size="sm" type="button" disabled={blocked} onClick={() => setConfirmDiscard(true)}>丢弃</Button>}
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" type="button" loading={busy === 'saving'} disabled={blocked} icon={<FloppyDiskIcon size={15} />} onClick={onSave}>保存草稿</Button>
            <Button variant="primary" size="sm" type="submit" loading={busy === 'sending'} disabled={blocked} icon={input.mode === 'forward'
              ? <ArrowBendUpRightIcon size={15} /> : input.mode === 'reply' ? <ArrowBendUpLeftIcon size={15} /> : <PaperPlaneTiltIcon size={15} />}>
              {status === 'sent' ? '已发送' : status === 'uncertain' || status === 'sending' ? '发送待确认' : '发送'}
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}
