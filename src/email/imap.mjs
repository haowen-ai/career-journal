import tls from 'node:tls';
import net from 'node:net';
import { parseEml } from './eml.mjs';

const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 200;
const DEFAULT_TIMEOUT_MS = 15_000;

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function parsePort(value) {
  const port = Number(value ?? 993);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('IMAP port is invalid');
  return port;
}

function environmentSecret(secretRef, env) {
  const match = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(String(secretRef ?? ''));
  if (!match) throw new Error('IMAP secretRef must use env:VARIABLE');
  const value = env[match[1]];
  if (typeof value !== 'string' || !value) throw new Error(`IMAP credential environment variable ${match[1]} is not set`);
  return value;
}

function quote(value, name) {
  const normalized = required(value, name);
  if (/[\0\r\n]/.test(normalized)) throw new Error(`${name} contains unsupported characters`);
  return `"${normalized.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

async function openTlsTransport({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const options = { host, port, rejectUnauthorized: true };
    if (!net.isIP(host)) options.servername = host;
    const socket = tls.connect(options);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('IMAPS connection timed out'));
    }, timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`IMAPS connection failed: ${error.message}`));
    });
  });
}

function lineReader(socket) {
  let buffer = Buffer.alloc(0);
  let bytes = 0;
  let ended = false;
  let failure = null;
  const waiters = [];

  const settle = () => {
    while (waiters.length) {
      const waiter = waiters[0];
      if (failure) {
        waiters.shift();
        waiter.reject(failure);
        continue;
      }
      if (waiter.type === 'line') {
        const newline = buffer.indexOf(0x0a);
        if (newline >= 0) {
          waiters.shift();
          const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
          buffer = buffer.subarray(newline + 1);
          waiter.resolve(line);
          continue;
        }
      } else if (buffer.length >= waiter.length) {
        waiters.shift();
        const value = buffer.subarray(0, waiter.length);
        buffer = buffer.subarray(waiter.length);
        waiter.resolve(value);
        continue;
      }
      if (!ended) break;
      waiters.shift();
      waiter.reject(new Error('IMAPS connection closed before the command completed'));
    }
  };
  socket.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE_BYTES) {
      failure = new Error('IMAPS response exceeded the size limit');
      socket.destroy();
      settle();
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    settle();
  });
  socket.once('error', (error) => { failure = new Error(`IMAPS connection failed: ${error.message}`); settle(); });
  socket.once('end', () => { ended = true; settle(); });
  socket.once('close', () => { ended = true; settle(); });

  return {
    next() {
      if (failure) return Promise.reject(failure);
      const newline = buffer.indexOf(0x0a);
      if (newline >= 0) {
        const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
        buffer = buffer.subarray(newline + 1);
        return Promise.resolve(line);
      }
      if (ended) return Promise.reject(new Error('IMAPS connection closed before the command completed'));
      return new Promise((resolve, reject) => waiters.push({ type: 'line', resolve, reject }));
    },
    bytes(length) {
      if (!Number.isInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) return Promise.reject(new Error('IMAP message exceeds the size limit'));
      if (failure) return Promise.reject(failure);
      if (buffer.length >= length) {
        const value = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        return Promise.resolve(value);
      }
      if (ended) return Promise.reject(new Error('IMAPS connection closed before the message completed'));
      return new Promise((resolve, reject) => waiters.push({ type: 'bytes', length, resolve, reject }));
    },
  };
}

async function taggedCommand(socket, reader, tag, command, failureMessage) {
  socket.write(`${tag} ${command}\r\n`);
  const lines = [];
  for (;;) {
    const line = await reader.next();
    lines.push(line);
    if (!line.startsWith(`${tag} `)) continue;
    if (new RegExp(`^${tag} OK(?:\\s|$)`, 'i').test(line)) return lines;
    throw new Error(failureMessage);
  }
}

function connectionInput(input, capabilities) {
  const host = required(input?.host, 'IMAP host');
  const port = parsePort(input?.port);
  const username = required(input?.username, 'IMAP username');
  const mailbox = required(input?.mailbox ?? 'INBOX', 'IMAP mailbox');
  const password = environmentSecret(input?.secretRef, capabilities.env ?? process.env);
  const now = new Date(capabilities.now ?? new Date().toISOString());
  if (Number.isNaN(now.getTime())) throw new Error('IMAP verification time must be an ISO date-time');
  return { host, port, username, mailbox, password, now };
}

async function openAuthenticated(input, capabilities) {
  const values = connectionInput(input, capabilities);
  const openTransport = capabilities.openTransport ?? openTlsTransport;
  const socket = await openTransport({ host: values.host, port: values.port, timeoutMs: capabilities.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  const reader = lineReader(socket);
  try {
    const greeting = await reader.next();
    if (!/^\* (?:OK|PREAUTH)(?:\s|$)/i.test(greeting)) throw new Error('IMAPS server did not return a ready greeting');
    await taggedCommand(socket, reader, 'CJ001', 'CAPABILITY', 'IMAPS capability check failed');
    if (!/^\* PREAUTH(?:\s|$)/i.test(greeting)) {
      await taggedCommand(socket, reader, 'CJ002', `LOGIN ${quote(values.username, 'IMAP username')} ${quote(values.password, 'IMAP credential')}`, 'IMAPS authentication failed');
    }
    const examine = await taggedCommand(socket, reader, 'CJ003', `EXAMINE ${quote(values.mailbox, 'IMAP mailbox')}`, 'IMAPS mailbox read-only probe failed');
    return { ...values, socket, reader, examine };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function logout(session) {
  try { await taggedCommand(session.socket, session.reader, 'CJ999', 'LOGOUT', 'IMAPS logout failed'); }
  finally { session.socket.destroy(); }
}

export async function probeImapConnection(input, capabilities = {}) {
  const session = await openAuthenticated(input, capabilities);
  try {
    return {
      method: 'imap-tls', server: session.host, port: session.port, username: session.username,
      mailbox: session.mailbox, verifiedAt: session.now.toISOString(),
    };
  } finally { await logout(session); }
}

function parseMailboxState(lines) {
  const text = lines.join('\n');
  const uidValidity = /\[UIDVALIDITY (\d+)\]/i.exec(text)?.[1];
  const uidNext = Number(/\[UIDNEXT (\d+)\]/i.exec(text)?.[1]);
  if (!uidValidity || !Number.isInteger(uidNext) || uidNext < 1) throw new Error('IMAPS mailbox did not report UIDVALIDITY and UIDNEXT');
  return { uidValidity, uidNext };
}

function parseCursor(value) {
  if (value == null) return null;
  const match = /^imap-uid:(\d+):(\d+)$/.exec(String(value));
  if (!match) throw new Error('Stored IMAP cursor is invalid');
  return { uidValidity: match[1], lastUid: Number(match[2]) };
}

function imapDate(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(date.getUTCDate()).padStart(2, '0')}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

async function fetchUid(session, uid, sequence) {
  const tag = `CJF${String(sequence).padStart(3, '0')}`;
  session.socket.write(`${tag} UID FETCH ${uid} (UID BODY.PEEK[])\r\n`);
  let raw = null;
  for (;;) {
    const line = await session.reader.next();
    if (line.startsWith(`${tag} `)) {
      if (!new RegExp(`^${tag} OK(?:\\s|$)`, 'i').test(line)) throw new Error(`IMAPS fetch failed for UID ${uid}`);
      if (raw === null) throw new Error(`IMAPS fetch returned no message for UID ${uid}`);
      return raw;
    }
    const literal = /\bUID\s+(\d+)\b.*\{(\d+)\}$/.exec(line);
    if (!literal || Number(literal[1]) !== uid) continue;
    raw = (await session.reader.bytes(Number(literal[2]))).toString('utf8');
    await session.reader.next();
  }
}

export async function fetchImapMailbox(input, state = {}, capabilities = {}) {
  const session = await openAuthenticated(input, capabilities);
  try {
    const mailbox = parseMailboxState(session.examine);
    const previous = parseCursor(state.beforeCursor ?? null);
    const sameMailbox = previous?.uidValidity === mailbox.uidValidity;
    const since = new Date(session.now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const query = sameMailbox ? `UID ${previous.lastUid + 1}:*` : `SINCE ${imapDate(since)}`;
    const searchLines = await taggedCommand(session.socket, session.reader, 'CJ004', `UID SEARCH ${query}`, 'IMAPS search failed');
    const uids = [...new Set(searchLines
      .filter((line) => /^\* SEARCH(?:\s|$)/i.test(line))
      .flatMap((line) => line.replace(/^\* SEARCH\s*/i, '').split(/\s+/).filter(Boolean).map(Number))
      .filter((uid) => Number.isInteger(uid) && uid > (sameMailbox ? previous.lastUid : 0) && uid < mailbox.uidNext))]
      .sort((left, right) => left - right)
      .slice(0, MAX_MESSAGES);
    const messages = [];
    for (let index = 0; index < uids.length; index += 1) {
      const uid = uids[index];
      const parsed = parseEml(await fetchUid(session, uid, index + 1));
      messages.push({
        sourceId: `imap:${mailbox.uidValidity}:${uid}`,
        messageId: parsed.messageId ?? `<imap-${mailbox.uidValidity}-${uid}@local>`,
        from: parsed.from || '(unknown sender)',
        to: parsed.to || session.username,
        subject: parsed.subject || '(no subject)',
        sentAt: parsed.sentAt,
        body: parsed.body,
      });
    }
    const lastUid = uids.length
      ? Math.max(sameMailbox ? previous.lastUid : 0, ...uids)
      : Math.max(sameMailbox ? previous.lastUid : 0, mailbox.uidNext - 1);
    return {
      beforeCursor: state.beforeCursor ?? null,
      afterCursor: `imap-uid:${mailbox.uidValidity}:${lastUid}`,
      fetchedAt: session.now.toISOString(),
      verification: {
        method: 'imap-tls', server: session.host, port: session.port, username: session.username,
        mailbox: session.mailbox, verifiedAt: session.now.toISOString(),
      },
      messages,
    };
  } finally { await logout(session); }
}
