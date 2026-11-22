import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Only called on the native launcher's private stdin/stdout channel.
export async function phoneTransfer(db, mailboxKey, request) {
  const query = `FROM imap_accounts c JOIN aliases a ON a.id=c.id
    WHERE a.status='active' AND c.provider IN ('qq','netease163')`;
  if (request.type === 'phone-accounts') {
    const { results } = await db.prepare('SELECT a.address ' + query + ' ORDER BY a.address').all();
    return { type: 'phone-accounts', addresses: results.map(row => row.address) };
  }
  const code = String(request.code ?? '').replace(/[ -]/g, '').toLowerCase();
  if (!/^[a-f0-9]{24}$/.test(code)) throw new Error('Invalid pairing code');
  const row = await db.prepare('SELECT a.address,c.credential ' + query + ' AND a.address=?')
    .bind(request.address).first();
  if (!row) throw new Error('Account unavailable');
  const [iv, sealed] = row.credential.split('.').map(value => Buffer.from(value, 'base64'));
  const open = createDecipheriv('aes-256-gcm', Buffer.from(mailboxKey, 'base64'), iv);
  open.setAAD(Buffer.from(row.address));
  open.setAuthTag(sealed.subarray(-16));
  const password = Buffer.concat([open.update(sealed.subarray(0, -16)), open.final()]);
  const key = createHash('sha256').update('agentic-mailbox/phone/v1:' + code).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  try {
    const encrypted = cipher.update(JSON.stringify({
      address: row.address, password: password.toString(), expires: Date.now() + 120000,
    }), 'utf8');
    const bytes = Buffer.concat([nonce, encrypted, cipher.final(), cipher.getAuthTag()]);
    return { type: 'phone-transfer', envelope: 'AMB1.' + bytes.toString('hex') };
  } finally { key.fill(0); password.fill(0); }
}
