import { gcm } from '@noble/ciphers/aes';
import { hexToBytes, utf8ToBytes } from '@noble/ciphers/utils';
import { sha256 } from '@noble/hashes/sha256';

export function normalize(address: string) {
  const value = address.trim().toLowerCase();
  if (!/^[^\s@\r\n]+@(qq\.com|foxmail\.com|163\.com)$/.test(value)) throw Error('请输入 QQ、Foxmail 或 163 邮箱地址。');
  return value;
}
export function unpack(value: string, code: string): { address: string; password: string } {
  if (!/^AMB1\.(?:[0-9a-f]{2}){29,2000}$/.test(value)) throw Error('请扫描 Agentic Mailbox 的导入二维码。');
  const bytes = hexToBytes(value.slice(5));
  try {
    const key = sha256(utf8ToBytes('agentic-mailbox/phone/v1:' + code));
    const plain = gcm(key, bytes.subarray(0, 12)).decrypt(bytes.subarray(12));
    const data = JSON.parse(new TextDecoder().decode(plain));
    if (!Number.isSafeInteger(data.expires) || data.expires < Date.now() || data.expires > Date.now()+180000 ||
      typeof data.password !== 'string' || !data.password) throw Error();
    return { address: normalize(data.address), password: data.password };
  } catch { throw Error('二维码已过期或配对码不匹配，请在 Mac 上重新生成。'); }
}
