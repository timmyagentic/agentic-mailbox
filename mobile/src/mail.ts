import type { DraftInput, DraftMode, EmailDetail, MailProvider } from '../../src/shared/types';

export const providers: Record<MailProvider, string> = {
  qq: 'QQ / Foxmail', netease163: '163 邮箱', gmail_app: 'Gmail 应用专用密码', gmail: 'Gmail', outlook: 'Outlook',
};

export function mailText(mail: Pick<EmailDetail, 'bodyText' | 'bodyHtml' | 'preview'>) {
  return mail.bodyText || mail.bodyHtml?.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (match, id: string) => {
      const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      if (!id.startsWith('#')) return named[id.toLowerCase()] ?? match;
      const number = id[1]?.toLowerCase() === 'x' ? Number.parseInt(id.slice(2), 16) : Number(id.slice(1));
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match;
    }).trim() || mail.preview;
}

export function makeDraft(aliasId: string, mode: DraftMode, source?: EmailDetail): DraftInput {
  const prefix = mode === 'reply' ? 'Re:' : 'Fwd:';
  const subject = source?.subject || '';
  const address = source ? (source.outgoing ? source.toAddress : source.replyAddress || source.fromAddress) : '';
  return {
    aliasId, mode, sourceEmailId: source?.id ?? null,
    to: mode === 'reply' ? address.match(/<([^<>]+)>/)?.[1] || address.split(',')[0].trim() : '',
    cc: '', bcc: '',
    subject: source && !subject.toLowerCase().startsWith(prefix.toLowerCase()) ? prefix + ' ' + subject : subject,
    bodyText: source ? ['','', '----- 原邮件 -----', '发件人：' + source.fromAddress, '主题：' + subject, '', mailText(source)].join('\n') : '',
    bodyHtml: '', includeOriginalFiles: mode === 'forward',
  };
}
