import { Buffer } from 'node:buffer';
import { createCipheriv, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unpack } from '../src/phone-transfer.ts';
import { phoneTransfer } from '../../scripts/phone-transfer.mjs';

test('opens the selected account on the paired phone and rejects a different phone, modification and expiry', async (t) => {
    const code = randomBytes(12).toString('hex');
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const address = 'fixture@163.com';
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(address));
    const ciphertext = Buffer.concat([cipher.update('fixture-code'), cipher.final(), cipher.getAuthTag()]);
    const row = { address, credential: iv.toString('base64') + '.' + ciphertext.toString('base64') };
    const db = { prepare: () => ({ bind: (email) => ({ first: () => email === address ? row : null }) }) };
    const request = { type: 'phone-export', address, code };
    const { envelope } = await phoneTransfer(db, key.toString('base64'), request);
    assert.ok(!envelope.includes(code));
    assert.deepEqual(unpack(envelope, code), { address, password: 'fixture-code' });
    assert.throws(() => unpack(envelope, randomBytes(12).toString('hex')));
    assert.throws(() => unpack(envelope.slice(0,-2) + (envelope.endsWith('00') ? 'ff' : '00'), code));
    await assert.rejects(phoneTransfer(db, key.toString('base64'), {...request,address:'other@qq.com'}));
    const future = Date.now() + 121000;
    t.mock.method(Date, 'now', () => future);
    assert.throws(() => unpack(envelope, code));
});
