import type { SessionPayload } from '../shared/types';

export const SESSION_COOKIE = 'agentic_mailbox_session';
const LEGACY_SESSION_COOKIE = 'mailbox_vault_session';
const SESSION_TTL_SECONDS = 24 * 60 * 60;

type SignedSession = {
  email: string;
  issuedAt: number;
  expiresAt: number;
} & ({ version: 1 } | { version: 2; certificateFingerprint: string });

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function sign(value: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await importSigningKey(secret),
    new TextEncoder().encode(value),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

async function verifySignature(value: string, signature: string, secret: string): Promise<boolean> {
  const bytes = decodeBase64Url(signature);
  if (!bytes) {
    return false;
  }
  const signatureBytes = new Uint8Array(bytes.byteLength);
  signatureBytes.set(bytes);
  return crypto.subtle.verify(
    'HMAC',
    await importSigningKey(secret),
    signatureBytes.buffer,
    new TextEncoder().encode(value),
  );
}

export async function passwordsMatch(candidate: string, expected: string): Promise<boolean> {
  const [candidateDigest, expectedDigest] = await Promise.all(
    [candidate, expected].map((value) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  );
  const left = new Uint8Array(candidateDigest);
  const right = new Uint8Array(expectedDigest);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function normalizeFingerprint(value: string): string | undefined {
  const normalized = value.replaceAll(':', '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

export function verifiedClientFingerprint(request: Request, allowlist?: string): string | undefined {
  if (!allowlist || new URL(request.url).protocol !== 'https:') return undefined;
  const certificate = (request.cf as IncomingRequestCfProperties | undefined)?.tlsClientAuth;
  if (
    certificate?.certPresented !== '1' ||
    certificate.certVerified !== 'SUCCESS' ||
    certificate.certRevoked !== '0'
  ) return undefined;

  const fingerprint = normalizeFingerprint(certificate.certFingerprintSHA256 ?? '');
  return fingerprint && allowlist.split(/[\s,]+/).some((entry) => normalizeFingerprint(entry) === fingerprint)
    ? fingerprint
    : undefined;
}

export async function createSessionToken(
  email: string,
  secret: string,
  now = Date.now(),
  certificateFingerprint?: string,
): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const window = { email, issuedAt, expiresAt: issuedAt + SESSION_TTL_SECONDS };
  // Older Workers reject version 2, so a rollback cannot remove the device binding.
  const payload: SignedSession = certificateFingerprint
    ? { ...window, version: 2, certificateFingerprint }
    : { ...window, version: 1 };
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${encodedPayload}.${await sign(encodedPayload, secret)}`;
}

export async function verifySessionToken(
  token: string,
  expectedEmail: string,
  secret: string,
  now = Date.now(),
): Promise<SignedSession | null> {
  const [encodedPayload, signature, extra] = token.split('.');
  if (!encodedPayload || !signature || extra || !(await verifySignature(encodedPayload, signature, secret))) {
    return null;
  }

  const payloadBytes = decodeBase64Url(encodedPayload);
  if (!payloadBytes) {
    return null;
  }

  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as SignedSession;
    const nowSeconds = Math.floor(now / 1000);
    if (
      (payload.version !== 1 && payload.version !== 2) ||
      (payload.version === 2 && !/^[a-f0-9]{64}$/.test(payload.certificateFingerprint)) ||
      payload.email !== expectedEmail ||
      payload.issuedAt > nowSeconds + 60 ||
      payload.expiresAt <= nowSeconds
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      return rest.join('=');
    }
  }
  return null;
}

export function readSessionCookie(request: Request): string | null {
  return readCookie(request, SESSION_COOKIE) ?? readCookie(request, LEGACY_SESSION_COOKIE);
}

export async function getSession(
  request: Request,
  email: string,
  secret: string,
  certificateAllowlist?: string,
): Promise<SessionPayload> {
  const token = readSessionCookie(request);
  const session = token ? await verifySessionToken(token, email, secret) : null;
  const authenticated = Boolean(session && (
    session.version === 1 ||
    session.certificateFingerprint === verifiedClientFingerprint(request, certificateAllowlist)
  ));
  return { authenticated, user: authenticated ? { email } : null };
}

export function sessionCookie(token: string, requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

export function clearedSessionCookies(requestUrl: string): Headers {
  const secure = new URL(requestUrl).protocol === 'https:' ? '; Secure' : '';
  const headers = new Headers();
  for (const name of [SESSION_COOKIE, LEGACY_SESSION_COOKIE]) {
    headers.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
  }
  return headers;
}
