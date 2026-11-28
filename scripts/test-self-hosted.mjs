import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as tlsServer, createSecureContext, TLSSocket } from 'node:tls';
import { createServer as tcpServer } from 'node:net';
import nodemailer from 'nodemailer';
import PostalMime from 'postal-mime';

const work = await mkdtemp(join(tmpdir(), 'postway-imap-'));
const cert = join(work, 'fixture.crt'),
  key = join(work, 'fixture.key');
const source = 'relay@example.test',
  target = 'target@example.test',
  author = 'author@example.test';
const password = randomUUID(),
  adminPassword = randomUUID();
const inbox = [],
  delivered = [],
  commands = [];
let supportsIdle = false,
  refuseIdle = false,
  unavailableUntil = 0,
  dropBody = false,
  holdReceipt;
const imapClients = new Map();
const scans = [];
let connections = 0;
function addMail(raw) {
  inbox.push(raw);
  for (const [socket, state] of imapClients) {
    if (state.idleTag) socket.write('* ' + inbox.length + ' EXISTS\r\n');
  }
}
const servers = [],
  sockets = new Set();
let runtime,
  rejectData = false,
  loseAck = false,
  validity = 42;
function listen(tls, onClient, upgrade = false) {
  function serve(socket, initialGreeting) {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const onLine = onClient(socket, initialGreeting);
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk.toString();
      while (input.includes('\r\n')) {
        const end = input.indexOf('\r\n'),
          line = input.slice(0, end);
        input = input.slice(end + 2);
        onLine(line);
      }
    });
  }
  const server = upgrade
    ? tcpServer((socket) => {
        const isImap = onClient === imap;
        socket.write(isImap ? '* OK fixture ready\r\n' : '220 fixture ESMTP\r\n');
        let input = '';
        const read = (chunk) => {
          input += chunk.toString();
          if (!input.endsWith('\r\n')) return;
          const [first, second] = input.trim().split(' ');
          input = '';
          if (first === 'EHLO') socket.write('250-fixture\r\n250 STARTTLS\r\n');
          else if (second === 'CAPABILITY')
            socket.write('* CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED\r\n' + first + ' OK done\r\n');
          else if (first === 'STARTTLS' || second === 'STARTTLS') {
            socket.off('data', read);
            socket.write(isImap ? first + ' OK begin TLS\r\n' : '220 begin TLS\r\n');
            serve(
              new TLSSocket(socket, { isServer: true, secureContext: createSecureContext(tls) }),
              false,
            );
          } else socket.end('530 TLS required\r\n');
        };
        socket.on('error', () => {});
        socket.on('data', read);
      })
    : tlsServer(tls, (socket) => serve(socket, true));
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function imap(socket, greet) {
  const state = { id: ++connections, idleTag: '', loggedIn: false };
  imapClients.set(socket, state);
  socket.once('close', () => imapClients.delete(socket));
  if (Date.now() < unavailableUntil) {
    socket.destroy();
    return () => {};
  }
  if (greet) socket.write('* OK OpenPostway fixture\r\n');
  return (line) => {
    if (line === 'DONE') {
      socket.write(state.idleTag + ' OK idle ended\r\n');
      state.idleTag = '';
      return;
    }
    const [tag, verb, ...args] = line.split(' ');
    const cmd = verb === 'UID' ? 'UID ' + args[0] : verb;
    commands.push(cmd);
    const replies = [];
    let result = 'OK completed';
    if (cmd === 'CAPABILITY')
      replies.push('* CAPABILITY IMAP4rev1 ID' + (supportsIdle && state.loggedIn ? ' IDLE' : ''));
    else if (cmd === 'ID') replies.push('* ID ("name" "test")');
    else if (cmd === 'LOGIN') {
      if (!line.includes(password)) result = 'NO [AUTHENTICATIONFAILED]';
      else state.loggedIn = true;
    } else if (cmd === 'LIST') replies.push('* LIST () "/" "INBOX"');
    else if (cmd === 'LSUB') replies.push('* LSUB () "/" "INBOX"');
    else if (cmd === 'IDLE') {
      if (refuseIdle) result = 'BAD idle unavailable';
      else {
        state.idleTag = tag;
        socket.write('+ listening\r\n');
        return;
      }
    } else if (cmd === 'NOOP') {
      /* finish with the tagged response */
    } else if (cmd === 'SELECT' || cmd === 'EXAMINE') {
      replies.push(
        '* FLAGS (\\Seen)',
        '* ' + inbox.length + ' EXISTS',
        '* OK [UIDVALIDITY ' + validity + '] stable',
        '* OK [UIDNEXT ' + (inbox.length + 1) + '] next',
      );
      result = 'OK [READ-ONLY] Selected';
    } else if (cmd === 'UID FETCH' || cmd === 'FETCH') {
      if (!line.includes('BODY.PEEK[]')) scans.push({ connection: state.id, at: Date.now() });
      if (dropBody && line.includes('BODY.PEEK[]')) {
        dropBody = false;
        socket.destroy();
        return;
      }
      const range = args[cmd === 'UID FETCH' ? 1 : 0].split(':');
      const lo = Number(range[0]),
        hi = range[1] === '*' ? inbox.length : Number(range[1] ?? range[0]);
      for (
        let uid = Math.max(1, Math.min(lo, hi));
        uid <= Math.min(inbox.length, Math.max(lo, hi));
        uid++
      ) {
        const raw = inbox[uid - 1],
          length = Buffer.byteLength(raw);
        if (line.includes('BODY.PEEK[]')) {
          commands.push('PEEK');
          replies.push(`* ${uid} FETCH (UID ${uid} RFC822.SIZE ${length} BODY[]<0> {${length}}\r\n${raw})`);
        } else replies.push('* ' + uid + ' FETCH (UID ' + uid + ')');
      }
    } else result = 'BAD unsupported';
    socket.write([...replies, tag + ' ' + result].join('\r\n') + '\r\n');
  };
}
function smtp(socket, greet) {
  if (greet) socket.write('220 fixture ESMTP\r\n');
  let authenticated = false,
    destination = '',
    body = null;
  return (line) => {
    if (body) {
      if (line !== '.') {
        body.push(line.replace(/^\.\./, '.'));
        return;
      }
      const raw = body.join('\r\n');
      body = null;
      if (rejectData && destination === target) {
        rejectData = false;
        socket.write('554 message rejected\r\n');
        return;
      }
      if (destination === source) addMail(raw);
      else if (destination === target) delivered.push(raw);
      else assert.fail('unexpected SMTP envelope');
      if (loseAck) {
        loseAck = false;
        socket.destroy();
        return;
      }
      if (holdReceipt && destination === target) {
        holdReceipt.promise.then(() => socket.write('250 queued\r\n'));
      } else socket.write('250 queued\r\n');
      return;
    }
    if (line.startsWith('EHLO')) socket.write('250-fixture\r\n250 AUTH PLAIN\r\n');
    else if (line.startsWith('AUTH PLAIN ')) {
      const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString().split('\0');
      authenticated = (user === source || user === author) && pass === password;
      socket.write(authenticated ? '235 authenticated\r\n' : '535 invalid\r\n');
    } else if (!authenticated) socket.write('530 authenticate\r\n');
    else if (line.startsWith('MAIL FROM:')) socket.write('250 ok\r\n');
    else if (line.startsWith('RCPT TO:')) {
      destination = line.match(/<([^>]+)>/)?.[1];
      socket.write('250 ok\r\n');
    } else if (line === 'DATA') {
      body = [];
      socket.write('354 send\r\n');
    } else if (line === 'QUIT') socket.end('221 bye\r\n');
    else socket.write('250 ok\r\n');
  };
}

try {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  process.env.NODE_EXTRA_CA_CERTS = cert;
  const { Miniflare } = await import('miniflare');
  const tls = { key: await readFile(key), cert: await readFile(cert) };
  const imapPort = await listen(tls, imap),
    smtpPort = await listen(tls, smtp);
  const options = {
    modules: true,
    scriptPath: '.wrangler/segment-test/segment-worker.js',
    compatibilityDate: '2026-07-19',
    compatibilityFlags: ['nodejs_compat'],
    defaultPersistRoot: work,
    defaultProjectTmpPath: work,
    d1Databases: ['DB'],
    unsafeTriggerHandlers: true,
    bindings: {
      ADMIN_EMAIL: 'owner',
      ADMIN_PASSWORD: adminPassword,
      SESSION_SECRET: randomUUID(),
      MAIL_ACCOUNT_KEY: randomBytes(32).toString('base64'),
    },
  };
  runtime = new Miniflare(options);
  let db = await runtime.getD1Database('DB');
  for (const migration of (await readdir('migrations-imap')).sort()) {
    await db.exec((await readFile('migrations-imap/' + migration, 'utf8')).replaceAll('\n', ' '));
  }
  const base = 'https://settings.example.test';
  let cookie = '';
  async function api(path, data, expected = 200) {
    const res = await runtime.dispatchFetch(base + path, {
      method: data ? 'POST' : 'GET',
      headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    assert.equal(res.status, expected, path + ' ' + JSON.stringify(json?.error));
    if (res.headers.has('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return json;
  }
  assert.equal((await api('/api/session')).edition, 'imap');
  await api('/api/relay', undefined, 401);
  await api('/api/session', { password: adminPassword });
  const external = nodemailer.createTransport({
    host: '127.0.0.1',
    port: smtpPort,
    secure: true,
    tls: { ca: tls.cert },
    auth: { user: author, pass: password },
  });
  async function incoming(subject) {
    await external.sendMail({
      from: author,
      to: source,
      replyTo: 'replies@example.test',
      subject,
      text: 'source text',
      html: '<b>source text</b>',
      cc: 'extra@example.test',
      envelope: { from: author, to: [source] },
      attachments: [{ filename: 'receipt.bin', content: Buffer.from([0, 1, 255]) }],
    });
  }
  async function manual() {
    await api('/api/relay/check', {});
  }
  await incoming('older mail');
  const config = {
    provider: 'custom',
    address: source,
    destination: target,
    name: 'Relay Assistant',
    password,
    imap: { host: 'localhost', port: imapPort, tls: 'implicit' },
    smtp: { host: 'localhost', port: smtpPort, tls: 'implicit' },
  };
  const setup = await api('/api/relay/setup', config);
  assert.equal(delivered.length, 1);
  const confirmation = await PostalMime.parse(delivered.shift());
  const code = confirmation.text.match(/[0-9A-F]{12}/)[0];
  assert.ok(
    !(
      await db.prepare("SELECT credential FROM mailbox_relay WHERE slot='pending'").first('credential')
    ).includes(password),
  );
  await api('/api/relay/confirm', { id: setup.pending.id, code: '000000000000' }, 409);
  await api('/api/relay/confirm', { id: setup.pending.id, code });
  await incoming('OpenPostway integration');
  await Promise.all([manual(), manual()]);
  assert.equal(delivered.length, 1);
  const forwarded = await PostalMime.parse(delivered[0]);
  assert.equal(forwarded.from.name, 'Relay Assistant');
  assert.equal(forwarded.from.address, source);
  assert.deepEqual(
    forwarded.to.map((x) => x.address),
    [target],
  );
  assert.equal(forwarded.cc, undefined);
  assert.equal(forwarded.replyTo[0].address, 'replies@example.test');
  assert.equal(forwarded.subject, 'OpenPostway integration');
  assert.match(forwarded.text, /source text/);
  assert.match(forwarded.html, /source text/);
  assert.deepEqual([...new Uint8Array(forwarded.attachments[0].content)], [0, 1, 255]);
  assert.ok(commands.includes('PEEK'));
  assert.ok(!commands.includes('STORE'));
  assert.equal((await api('/api/relay')).active.issue, null);
  inbox.push(delivered[0]);
  await manual();
  assert.equal(delivered.length, 1);
  await incoming('uncertain receipt');
  loseAck = true;
  await manual();
  await manual();
  const { active: blocked } = await api('/api/relay');
  assert.equal(blocked.issue, 'uncertain');
  assert.equal(delivered.length, 2);
  await api('/api/relay/resolve', {
    generation: blocked.generation,
    validity: blocked.uidValidity,
    uid: blocked.inFlight,
    action: 'skip',
  });
  validity++;
  await manual();
  assert.equal((await api('/api/relay')).active.issue, 'reset');
  await api('/api/relay/resolve', {
    generation: blocked.generation,
    validity: blocked.uidValidity,
    action: 'baseline',
  });
  await runtime.dispose();
  runtime = new Miniflare(options);
  db = await runtime.getD1Database('DB');
  await manual();
  assert.equal(delivered.length, 2);
  await incoming('after restart');
  await manual();
  assert.equal(delivered.length, 3);
  await api('/api/session', { password: adminPassword });
  const upgradeSetup = await api('/api/relay/setup', {
    ...config,
    imap: { host: 'localhost', port: await listen(tls, imap, true), tls: 'starttls' },
    smtp: { host: 'localhost', port: await listen(tls, smtp, true), tls: 'starttls' },
  });
  const upgradeCode = (await PostalMime.parse(delivered.pop())).text.match(/[0-9A-F]{12}/)[0];
  await api('/api/relay/confirm', { id: upgradeSetup.pending.id, code: upgradeCode });
  await incoming('required STARTTLS');
  await manual();
  assert.equal(delivered.length, 4);
  assert.equal((await PostalMime.parse(delivered.at(-1))).subject, 'required STARTTLS');
  await incoming('permanent rejection');
  rejectData = true;
  await manual();
  await manual();
  const { active: rejected } = await api('/api/relay');
  assert.equal(rejected.issue, 'rejected');
  assert.equal(delivered.length, 4);
  await api('/api/relay/resolve', {
    generation: rejected.generation,
    validity: rejected.uidValidity,
    uid: rejected.inFlight,
    action: 'retry',
  });
  await manual();
  assert.equal(delivered.length, 5);
  async function waitFor(predicate, label, timeout = 8_000) {
    const limit = Date.now() + timeout;
    while (Date.now() < limit) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error('Timed out waiting for ' + label);
  }
  const idleCount = () => [...imapClients.values()].filter((x) => x.idleTag).length;
  function segment(epoch, duration) {
    return runtime
      .dispatchFetch(base + '/test/segment', {
        method: 'POST',
        body: JSON.stringify({ epoch, until: Date.now() + duration }),
      })
      .then(async (r) => assert.equal(r.status, 200, await r.text()));
  }
  const subjects = async () =>
    (await Promise.all(delivered.map((raw) => PostalMime.parse(raw)))).map((mail) => mail.subject);
  const hasMail = async (subject) => (await subjects()).includes(subject);
  async function arrived(subject) {
    await incoming(subject);
    await waitFor(() => hasMail(subject), subject);
  }
  const firstReceipt = delivered.length;
  supportsIdle = true;
  const old = segment(1, 7_000);
  await waitFor(() => idleCount() === 1, 'predecessor IDLE');
  await arrived('before handoff');
  await waitFor(() => idleCount() === 1, 'predecessor listening again');
  const next = segment(2, 21_000);
  await waitFor(() => idleCount() === 2, 'both IMAP listeners');
  const beforeDuplicate = connections;
  await segment(2, 2_000);
  assert.equal(connections, beforeDuplicate, 'duplicate scheduler started another socket');

  holdReceipt = Promise.withResolvers();
  await incoming('both listeners');
  await waitFor(() => hasMail('both listeners'), 'SMTP accepted in overlap');
  await Promise.all([manual(), incoming('while SMTP acknowledgment pending')]);
  assert.equal((await subjects()).filter((x) => x === 'both listeners').length, 1);
  holdReceipt.resolve();
  holdReceipt = undefined;
  await waitFor(() => hasMail('while SMTP acknowledgment pending'), 'arrival during SMTP');
  await old;
  assert.equal((await api('/api/relay')).active.listener, 'idle', 'predecessor cleared successor');
  await arrived('after handoff');

  await waitFor(() => idleCount() === 1, 'successor waiting before outage');
  unavailableUntil = Date.now() + 1350;
  for (const sock of imapClients.keys()) sock.destroy();
  await incoming('during disconnect 1');
  await incoming('during disconnect 2');
  await waitFor(() => hasMail('during disconnect 2'), 'catch up after rejected reconnect');
  await waitFor(() => idleCount() === 1, 'reconnected listener');
  dropBody = true;
  await arrived('disconnect during BODY.PEEK');
  await next;
  const expected = [
    'before handoff',
    'both listeners',
    'while SMTP acknowledgment pending',
    'after handoff',
    'during disconnect 1',
    'during disconnect 2',
    'disconnect during BODY.PEEK',
  ];
  assert.deepEqual((await subjects()).slice(firstReceipt), expected, 'each UID arrives once in order');
  assert.equal(
    await db.prepare("SELECT last_uid FROM mailbox_relay WHERE slot='active'").first('last_uid'),
    inbox.length,
  );

  supportsIdle = false;
  const baseline = connections;
  const fallback = segment(3, 13_000);
  await waitFor(() => scans.some((s) => s.connection > baseline), 'fallback initial scan');
  const firstScan = scans.find((s) => s.connection > baseline);
  await incoming('ten-second fallback');
  await waitFor(() => hasMail('ten-second fallback'), 'fallback delivered', 13_000);
  const secondScan = scans.find((s) => s.connection === firstScan.connection && s.at > firstScan.at);
  assert.ok(
    secondScan && secondScan.at - firstScan.at >= 9_900 && secondScan.at - firstScan.at < 13_000,
    '10 second fallback cadence',
  );
  assert.equal(connections, baseline + 1, 'fallback must reuse the authenticated connection');
  await fallback;

  supportsIdle = true;
  refuseIdle = true;
  const refused = segment(4, 2_500);
  await waitFor(
    async () => (await api('/api/relay')).active.listener === 'poll',
    'IDLE rejection switches to polling',
  );
  await refused;
  assert.equal((await subjects()).filter((x) => x === 'ten-second fallback').length, 1);
  supportsIdle = true;
  refuseIdle = false;
  const quiet = segment(5, 12_000);
  await waitFor(() => idleCount() === 1, 'quiet IDLE');
  const quietScans = scans.length;
  await quiet;
  assert.equal(scans.length, quietScans, 'IDLE performed a ten-second mailbox check while quiet');

  const burst = Array.from({ length: 13 }, (_, i) => 'backlog ' + (i + 1));
  const startCount = delivered.length;
  for (const subject of burst) await incoming(subject);
  const catchup = segment(6, 5_000);
  await waitFor(() => hasMail(burst.at(-1)), 'drain across the ten-UID batch boundary');
  await catchup;
  assert.deepEqual((await subjects()).slice(startCount), burst);
  const ackStart = delivered.length;
  const lostA = segment(7, 4_000);
  await waitFor(() => idleCount() === 1, 'first listener before ambiguous SMTP');
  const lostB = segment(8, 4_000);
  await waitFor(() => idleCount() === 2, 'second listener before ambiguous SMTP');
  loseAck = true;
  await incoming('SMTP accepted immediately before disconnect');
  await waitFor(
    async () => (await api('/api/relay')).active.issue === 'uncertain',
    'durable uncertain claim',
  );
  await Promise.all([manual(), lostA, lostB]);
  assert.deepEqual((await subjects()).slice(ackStart), ['SMTP accepted immediately before disconnect']);
  const unresolved = (await api('/api/relay')).active;
  await api('/api/relay/resolve', {
    generation: unresolved.generation,
    validity: unresolved.uidValidity,
    uid: unresolved.inFlight,
    action: 'skip',
  });
  console.log(
    'Verified IDLE on two live sockets, same-epoch fencing, arrivals during and after handover, disconnection and interrupted BODY.PEEK, unique SMTP receipts, and fallback on the same connection (' +
      (secondScan.at - firstScan.at) +
      ' ms).',
  );
  console.log(
    'Verified clean setup, destination confirmation, SMTP to IMAP to SMTP over implicit TLS and STARTTLS, message headers and attachment bytes, new-mail-only cursor, overlapping cron, loop prevention, ambiguous delivery, UIDVALIDITY and restart.',
  );
} finally {
  await runtime?.dispose();
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await rm(work, { recursive: true, force: true });
}
