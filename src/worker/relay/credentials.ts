import { HttpError } from '../http';
import type { RelayEnv } from './profile';

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function toBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

async function getCredentialKey(env: RelayEnv) {
  try {
    const bytes = fromBase64(env.MAIL_ACCOUNT_KEY?.trim() ?? '');
    if (bytes.byteLength === 32)
      return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch {
    // Report only that the service is unavailable.
  }
  throw new HttpError(503, 'mail_account_key_unavailable', '服务端尚未配置邮箱凭证加密密钥。');
}

function cipherParams(address: string, iv: Uint8Array<ArrayBuffer>) {
  return { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(address) };
}

export async function sealCredential(env: RelayEnv, address: string, code: string) {
  const key = await getCredentialKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    cipherParams(address, iv),
    key,
    new TextEncoder().encode(code),
  );
  return `${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function openCredential(env: RelayEnv, account: { address: string; credential: string }) {
  const key = await getCredentialKey(env);
  const [iv, ciphertext] = account.credential.split('.');
  const bytes = await crypto.subtle.decrypt(
    cipherParams(account.address, fromBase64(iv)),
    key,
    fromBase64(ciphertext),
  );
  return new TextDecoder().decode(bytes);
}
