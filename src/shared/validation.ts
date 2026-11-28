const LOCAL_PART_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,63}$/;

export function normalizeLocalPart(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidLocalPart(value: string): boolean {
  return LOCAL_PART_PATTERN.test(normalizeLocalPart(value));
}

export function normalizeAddress(value: string): string | null {
  const address = value.trim().toLowerCase();
  const separator = address.lastIndexOf('@');
  if (separator <= 0 || separator !== address.indexOf('@') || separator === address.length - 1) {
    return null;
  }

  const localPart = address.slice(0, separator);
  const domain = address.slice(separator + 1).replace(/\.$/, '');
  if (!isValidLocalPart(localPart) || !domain || !domain.includes('.')) {
    return null;
  }

  return `${localPart}@${domain}`;
}

// An Internet mailbox used in a message header or as an Email Service destination.
export function internetMailbox(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  const [local, domain, extra] = address.split('@');
  if (extra !== undefined || !domain?.includes('.') || address.length > 254 || local.length > 64
    || !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(local)
    || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
  return address;
}

export function slugifyPurpose(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  return slug || 'box';
}
