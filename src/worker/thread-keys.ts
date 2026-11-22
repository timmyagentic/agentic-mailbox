export function messageIds(value?: string): string[] {
  if (!value) return [];
  const bracketed = [...value.matchAll(/<([\x21-\x3b=\x3f-\x7e]{1,498})>/g)].map((match) => match[1]);
  if (bracketed.length) return [...new Set(bracketed)];
  const single = value.trim();
  return /^[\x21-\x3b=\x3f\x41-\x7e]+@[\x21-\x3b=\x3f\x41-\x7e]+$/.test(single) && single.length <= 498 ? [single] : [];
}

export function mailHeaders(json: string): Record<string, string> {
  try {
    const headers: unknown = JSON.parse(json);
    return Object.fromEntries(Object.entries(headers ?? {}).filter((item): item is [string, string] =>
      typeof item[1] === 'string',
    ));
  } catch {
    return {};
  }
}

export function getThreadKey(id: string, messageId: string, headers: Record<string, string>): string {
  const root = messageIds(headers.references)[0]
    ?? messageIds(headers['in-reply-to'])[0]
    ?? messageIds(messageId)[0];
  return root ? `mid:${root}` : `local:${id}`;
}
