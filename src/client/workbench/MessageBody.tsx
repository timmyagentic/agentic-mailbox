import DOMPurify from 'dompurify';
import { useMemo } from 'react';

const tags = ['p', 'br', 'div', 'span', 'strong', 'em', 'u', 'b', 'i', 's', 'a', 'table', 'thead', 'tbody',
  'tr', 'th', 'td', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'ul', 'ol', 'li', 'hr', 'pre', 'code', 'sub', 'sup'];

export function cleanBody(html: string) {
  const safe = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: tags, ALLOWED_ATTR: ['href', 'colspan', 'rowspan', 'title'],
    ALLOW_DATA_ATTR: false,
  });
  const document = new DOMParser().parseFromString(safe, 'text/html');
  for (const link of document.querySelectorAll('a')) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  return document.body.innerHTML;
}

export function textBody(html: string) {
  const safe = cleanBody(html);
  return new DOMParser().parseFromString(safe.replace(/<br\s*\/?>|<\/(p|div|li|tr)>/ig, '\n'), 'text/html').body.textContent?.trim() ?? '';
}

export function asHtml(text: string) {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return escaped.split(/\n\n+/).map((part) => `<p>${part.replaceAll('\n', '<br>')}</p>`).join('');
}

export function MessageBody({ text, html }: { text: string; html?: string }) {
  const safe = useMemo(() => html ? cleanBody(html) : '', [html]);
  return safe
    ? <div className="mailbox-body" dangerouslySetInnerHTML={{ __html: safe }} />
    : <div className="mailbox-body"><pre>{text || '（邮件没有正文）'}</pre></div>;
}
