import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { localData as data, localPort as port } from './local-settings.mjs';

process.umask(0o077);
const run = script => execFileSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
try {
  const provider = run('choose from list {"Google", "Microsoft"} with prompt "选择你自己的 OAuth 应用"');
  if (provider === 'false') process.exit(0);
  const callback = 'http://127.0.0.1:' + port + '/api/oauth/' + (provider === 'Google' ? 'gmail' : 'outlook') + '/callback';
  run(`display dialog "请在自己的 Web 应用中登记以下回调地址" default answer "${callback}" buttons {"取消", "继续"} default button "继续"`);
  const file = join(data, 'oauth.json');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (provider === 'Google') {
    const path = run('POSIX path of (choose file with prompt "选择你自己的 Google Web 客户端 JSON 文件")');
    const web = JSON.parse(readFileSync(path, 'utf8')).web;
    if (!web?.client_id?.endsWith('.apps.googleusercontent.com') || !web.client_secret) throw Error('Invalid client');
    config.GMAIL_CLIENT_ID = web.client_id;
    config.GMAIL_CLIENT_SECRET = web.client_secret;
  } else {
    const id = run('text returned of (display dialog "Microsoft Web 应用的客户端 ID" default answer "")').trim();
    const secret = run('text returned of (display dialog "该应用的客户端密钥值" default answer "" with hidden answer)').trim();
    if (!id || !secret) throw Error('Missing client credentials');
    config.OUTLOOK_CLIENT_ID = id;
    config.OUTLOOK_CLIENT_SECRET = secret;
  }
  const temp = file + '.' + process.pid;
  writeFileSync(temp, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
  console.log('已保存到本机。请重新启动本地邮箱。');
} catch (error) {
  if (String(error.stderr || '').includes('(-128)')) process.exit(0);
  console.error('无法保存。请检查客户端类型、凭据和文件。');
  process.exitCode = 1;
}
