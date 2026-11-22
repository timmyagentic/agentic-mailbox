import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Miniflare, Response as LocalResponse } from 'miniflare';
import { createChatGPTService } from './chatgpt-local.mjs';
import { connectLocalCodex } from './codex-connection.mjs';
import { localData as data, localPort as port } from './local-settings.mjs';
import { localDeviceAuth } from './local-device-auth.mjs';

process.umask(0o077);
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
mkdirSync(data, { recursive: true, mode: 0o700 });
const identityFile = join(data, 'identity.json');
if (!existsSync(identityFile)) {
  const temporary = identityFile + '.' + process.pid;
  const secret = () => randomBytes(32).toString('base64');
  writeFileSync(temporary, JSON.stringify({
    ADMIN_PASSWORD: secret(), SESSION_SECRET: secret(), MAIL_ACCOUNT_KEY: secret(),
  }), { flag: 'wx', mode: 0o600 });
  try { linkSync(temporary, identityFile); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { rmSync(temporary); }
}
const identity = JSON.parse(readFileSync(identityFile, 'utf8'));
const origin = 'http://127.0.0.1:' + port;
const oauthFile = join(data, 'oauth.json');
const oauth = existsSync(oauthFile) ? JSON.parse(readFileSync(oauthFile, 'utf8')) : {};
const bindings = {};
for (const key of ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'OUTLOOK_CLIENT_ID', 'OUTLOOK_CLIENT_SECRET']) {
  if (typeof oauth[key] === 'string') bindings[key] = oauth[key];
}
let chatGPT;
const bundledOutlookClient = join(root, 'local', 'outlook-client-id.txt');
if (existsSync(bundledOutlookClient)) {
  bindings.OUTLOOK_DESKTOP_CLIENT_ID = readFileSync(bundledOutlookClient, 'utf8').trim();
}
const runtime = new Miniflare({
  serviceBindings: {
    LOCAL_CODEX: async request => {
      const { cookie } = await request.json();
      const profile = connectLocalCodex(origin, cookie);
      return LocalResponse.json({ profile });
    },
    CHATGPT: async request => {
      chatGPT ??= createChatGPTService({ directory: data, origin, encryptionKey: identity.MAIL_ACCOUNT_KEY });
      const result = await chatGPT(request);
      return new LocalResponse(await result.text(), { status: result.status, headers: { 'Content-Type': 'application/json' } });
    },
  },
  name: 'mailbox-local', cf: false, modules: true, scriptPath: '.wrangler/local-worker/entry.js',
  compatibilityDate: '2026-07-19', compatibilityFlags: ['nodejs_compat'],
  modulesRules: [{ type: 'Text', include: ['**/*.sql'], fallthrough: true }],
  host: '127.0.0.1', port, d1Databases: ['DB'], r2Buckets: ['ATTACHMENTS'],
  d1Persist: join(data, 'database'), r2Persist: join(data, 'attachments'),
  assets: { directory: 'dist', binding: 'ASSETS', routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
    assetConfig: { not_found_handling: 'single-page-application' } },
  bindings: { ...bindings, ...identity, LOCAL_MODE: '1', APP_NAME: 'Agentic Mailbox · 本地版',
    ADMIN_EMAIL: 'owner@localhost.local', PRIMARY_DOMAIN: '', MAIL_OAUTH_ORIGIN: origin },
});
try {
  await runtime.ready;
  const db = await runtime.getD1Database('DB');
  await db.prepare('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)').run();
  for (const folder of ['migrations', 'local']) {
    for (const name of readdirSync(folder).filter(name => name.endsWith('.sql')).sort()) {
      if (await db.prepare('SELECT name FROM local_migrations WHERE name=?').bind(name).first()) continue;
      const statements = readFileSync(join(folder, name), 'utf8').replace(/^--.*$/gm, '').split(';')
        .map(part => part.trim()).filter(Boolean).map(stmt => db.prepare(stmt));
      await db.batch([...statements, db.prepare('INSERT INTO local_migrations VALUES (?)').bind(name)]);
    }
  }
  await db.prepare('CREATE TABLE IF NOT EXISTS local_launch(ticket TEXT PRIMARY KEY, expires INTEGER NOT NULL)').run();
  await db.prepare('DELETE FROM local_launch').run();
  const issueTicket = async () => {
    const ticket = randomBytes(32).toString('hex');
    await db.batch([
      db.prepare('DELETE FROM local_launch'),
      db.prepare('INSERT INTO local_launch VALUES (?,?)').bind(ticket, Date.now() + 120_000),
    ]);
    return ticket;
  };
  const stop = async () => { await runtime.dispose(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  if (process.argv.includes('--native-launcher')) {
    const certificate = join(data, 'device-certificate.cer');
    const device = localDeviceAuth(certificate);
    const reply = value => console.log(JSON.stringify(value));
    reply({ type: 'ready', ticket: existsSync(certificate) ? undefined : await issueTicket() });
    const commands = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of commands) {
      try {
        const request = JSON.parse(line);
        if (request.type === 'challenge') {
          const challenge = device.challenge();
          reply(challenge ? { type: 'challenge', ...challenge } : { type: 'certificate-unavailable' });
        } else if (request.type === 'prove') {
          if (device.prove(request.nonce, request.signature)) reply({ type: 'authorized', ticket: await issueTicket() });
          else reply({ type: 'certificate-rejected' });
        }
      } catch {
        reply({ type: 'certificate-rejected' });
      }
    }
    await stop();
  } else {
    console.log('本地邮箱已启动', origin, '\n数据目录', data, '\n关闭窗口或按 Ctrl+C 停止。');
    if (!process.argv.includes('--no-open') && !process.env.AGENTIC_MAILBOX_NO_OPEN && !process.env.VAULT_NO_OPEN) {
      const url = origin + '/#localUnlock=' + await issueTicket();
      const opener = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'rundll32' : 'xdg-open';
      const args = platform() === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
      spawn(opener, args, { stdio: 'ignore' }).on('error', () => console.log('请手动打开本机地址，密码保存在 identity.json 的 ADMIN_PASSWORD 字段。'));
    }
  }
} catch (error) {
  await runtime.dispose();
  throw error;
}
