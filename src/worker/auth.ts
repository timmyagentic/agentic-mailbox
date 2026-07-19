import type { SessionPayload } from '../shared/types';

const SESSION_COOKIE = 'mailbox_vault_session';
const SESSION_TTL_SECONDS = 24 * 60 * 60;

type SignedSession = {
  version: 1;
  email: string;
  issuedAt: number;
  expiresAt: number;
};

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

export async function createSessionToken(email: string, secret: string, now = Date.now()): Promise<string> {
  const payload: SignedSession = {
    version: 1,
    email,
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  };
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
      payload.version !== 1 ||
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

export function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      return rest.join('=');
    }
  }
  return null;
}

export async function getSession(
  request: Request,
  email: string,
  secret: string,
): Promise<SessionPayload> {
  const token = readCookie(request, SESSION_COOKIE);
  const session = token ? await verifySessionToken(token, email, secret) : null;
  return {
    authenticated: Boolean(session),
    user: session ? { email: session.email } : null,
  };
}

export function sessionCookie(token: string, requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

export function clearSessionCookie(requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}
