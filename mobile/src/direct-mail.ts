import { requireNativeModule } from 'expo-modules-core';
import * as SecureStore from 'expo-secure-store';
import { getRandomBytes } from 'expo-crypto';
import { normalize } from './phone-transfer';
export { normalize, unpack } from './phone-transfer';
import { bytesToHex, utf8ToBytes } from '@noble/ciphers/utils';

type Transport = {
  inbox(address: string, password: string): Promise<string>;
  read(address: string, password: string, validity: number, uid: number): Promise<string>;
  send(address: string, password: string, to: string, subject: string, body: string): Promise<void>;
};
const transport = requireNativeModule<Transport>('DirectMail');
const storage = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const index = 'direct-mail.addresses';
const keyFor = (address: string) => 'direct-mail.account.' + bytesToHex(utf8ToBytes(address));
export type Letter = { uid: number; validity: number; address: string; subject: string; from: string; date: number };
export async function addresses(): Promise<string[]> {
  return JSON.parse(await SecureStore.getItemAsync(index, storage) || '[]');
}
async function passwordFor(address: string) {
  const password = await SecureStore.getItemAsync(keyFor(address), storage);
  if (!password) throw Error('请重新添加此邮箱的授权码。');
  return password;
}
export async function inbox(address: string, code?: string): Promise<Letter[]> {
  const result: { validity: number; messages: Omit<Letter, 'address'|'validity'>[] } =
    JSON.parse(await transport.inbox(address, code ?? await passwordFor(address)));
  return result.messages.map(m => ({ ...m, address, validity: result.validity }));
}
export async function connect(address: string, code: string) {
  address = normalize(address);
  const rows = await inbox(address, code);
  const saved = await addresses();
  await SecureStore.setItemAsync(keyFor(address), code, storage);
  if (!saved.includes(address)) await SecureStore.setItemAsync(index, JSON.stringify([...saved, address]), storage);
  return rows;
}
export async function read(letter: Letter) {
  return transport.read(letter.address, await passwordFor(letter.address), letter.validity, letter.uid);
}
export async function send(address: string, to: string, subject: string, body: string) {
  await transport.send(address, await passwordFor(address), to.trim(), subject, body);
}
export const pairingCode = () => bytesToHex(getRandomBytes(12));
