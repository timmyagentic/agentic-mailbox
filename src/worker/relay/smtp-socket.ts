import { Buffer } from 'node:buffer';
import type { Socket as NodeSocket } from 'node:net';
import { createSocketsTransport } from 'imapflow';
import type { SMTPTransportGetSocket } from 'nodemailer/lib/smtp-transport';
import type { Server } from '../../shared/mailbox';

// Workerd can upgrade a native socket only between reads. Node's TLS wrapper keeps a read pending.
// Read the three SMTP replies explicitly before handing the verified TLS connection to Nodemailer.
async function negotiate(socket: Socket) {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  let pending = '';
  async function reply(code: string) {
    const lines: string[] = [];
    let bytes = 0;
    for (;;) {
      const end = pending.indexOf('\r\n');
      if (end < 0) {
        const chunk = await reader.read();
        if (chunk.done || (bytes += chunk.value.byteLength) > 65_536)
          throw new Error('Invalid SMTP greeting');
        pending += Buffer.from(chunk.value).toString('latin1');
        continue;
      }
      const line = pending.slice(0, end);
      pending = pending.slice(end + 2);
      if (line.slice(0, 3) !== code || ![' ', '-', ''].includes(line.charAt(3)))
        throw new Error('SMTP refused STARTTLS');
      lines.push(line);
      if (line.charAt(3) !== '-') return lines;
    }
  }
  try {
    const greeting = await reply('220');
    await writer.write(new TextEncoder().encode('EHLO openpostway.invalid\r\n'));
    const extensions = await reply('250');
    if (!extensions.some((line) => /^250[- ]STARTTLS\s*$/i.test(line)))
      throw new Error('SMTP server requires TLS support');
    await writer.write(new TextEncoder().encode('STARTTLS\r\n'));
    await reply('220');
    if (pending.length) throw new Error('Unexpected cleartext after STARTTLS');
    return greeting.join('\r\n') + '\r\n';
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

export function smtpSocket(server: Server): SMTPTransportGetSocket {
  return (_options, callback) => {
    async function open() {
      const { connect } = await import('cloudflare:sockets');
      const address = { hostname: server.host, port: server.port };
      let socket = connect(address, {
        allowHalfOpen: false,
        secureTransport: server.tls === 'implicit' ? 'on' : 'starttls',
      });
      void socket.closed.catch(() => {});
      const timer = setTimeout(() => {
        void socket.close().catch(() => {});
      }, 10_000);
      try {
        await socket.opened;
        let greeting = '';
        if (server.tls === 'starttls') {
          greeting = await negotiate(socket);
          socket = socket.startTls();
          void socket.closed.catch(() => {});
          await socket.opened;
        }
        // The streams adapter implements the Duplex, timeout and keep-alive API used by Nodemailer.
        const adapter = createSocketsTransport(() => socket);
        const stream = adapter.connect({ host: server.host, port: server.port, secure: true }, () => {
          stream.off('error', failed);
          if (greeting) stream.unshift(Buffer.from(greeting, 'latin1'));
          callback(null, { connection: stream as NodeSocket, secured: true });
        });
        function failed() {
          callback(newConnectionError());
        }
        stream.once('error', failed);
      } catch (error) {
        await socket.close().catch(() => {});
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    void open().catch(() => callback(newConnectionError()));
  };
}

function newConnectionError() {
  return Object.assign(new Error('Could not connect to SMTP over TLS'), { code: 'ERELAYCONNECT' });
}
