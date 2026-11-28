// Google Desktop OAuth, with a one-use loopback redirect and PKCE. Secrets go directly to Wrangler on stdin.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const [file] = process.argv.slice(2);
if (!file) throw new Error('Usage: npm run authorize:gmail -- /path/to/google-desktop-client.json');
const { installed: app } = JSON.parse(await readFile(file, 'utf8'));
if (!app?.client_id || !app.client_secret)
  throw new Error('Download a Google OAuth Desktop app client JSON.');
const config = 'wrangler.self-hosted.jsonc';
const local = JSON.parse(await readFile(config, 'utf8'));
if (local.main !== 'src/worker/self-host.ts') throw new Error('Select an IMAP self-hosted instance first.');
const state = randomBytes(24).toString('base64url'),
  verifier = randomBytes(48).toString('base64url');
const server = createServer();
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const redirect = 'http://127.0.0.1:' + server.address().port + '/';
try {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: app.client_id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'https://mail.google.com/',
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  console.log(
    'Open this Google URL on this computer and choose your relay mailbox. Worker: ' +
      local.name +
      '\n' +
      url.href,
  );
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Authorization expired. Run the command again.')),
      5 * 60_000,
    );
    server.on('request', (req, res) => {
      const callback = new URL(req.url, redirect);
      if (
        req.method !== 'GET' ||
        req.headers.host !== new URL(redirect).host ||
        callback.pathname !== '/' ||
        callback.searchParams.get('state') !== state
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      clearTimeout(timeout);
      const value = callback.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(value ? 'Return to your terminal to finish connecting Google.' : 'Access was not granted.');
      if (value) resolve(value);
      else reject(new Error('Google authorization was declined.'));
    });
  });
  const result = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: app.client_id,
      client_secret: app.client_secret,
      redirect_uri: redirect,
      code_verifier: verifier,
    }),
  });
  const tokens = await result.json();
  if (
    !result.ok ||
    !tokens.refresh_token ||
    (tokens.scope && !tokens.scope.split(' ').includes('https://mail.google.com/'))
  ) {
    throw new Error(
      'Google did not grant offline IMAP/SMTP access. Check the consent screen and mail scope.',
    );
  }
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const saved = spawnSync(process.execPath, [cli, 'secret', 'bulk', '--config', config], {
    input: JSON.stringify({
      GMAIL_CLIENT_ID: app.client_id,
      GMAIL_CLIENT_SECRET: app.client_secret,
      GMAIL_REFRESH_TOKEN: tokens.refresh_token,
    }),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (saved.status !== 0) throw new Error('Could not save the Google authorization to this Worker.');
  console.log('Open your instance, choose Gmail, then Google OAuth.');
} finally {
  server.closeAllConnections();
  server.close();
}
