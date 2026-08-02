#!/usr/bin/env node
// scripts/smtp.mjs
//
// A minimal SMTP submission client: connect, authenticate, send one plain-text
// message, disconnect. Used by scripts/notify-changes.mjs.
//
// Zero npm dependencies — node:net, node:tls, node:crypto only. Nodemailer
// would be one `npm i` away, but this repo has no package.json and no install
// step anywhere (see documentation/decisions.md#no-build-step), and a
// notification mailer is not a good enough reason to introduce one.
//
// What it deliberately does NOT do: connection pooling, multiple recipients,
// attachments, HTML alternatives, DSN, pipelining, retry. It sends one short
// notification to one address, and anything beyond that belongs in a library.
//
// Both submission ports work:
//   465 — implicit TLS, encrypted from the first byte (the default)
//   587 — plaintext connect, then upgraded with STARTTLS
// There is no unencrypted path: a server that offers neither is refused rather
// than sent a password in the clear.

import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

const CRLF = '\r\n';

/* --------------------------------- wire --------------------------------- */

/**
 * Reads SMTP replies off a socket, one complete reply at a time.
 *
 * A reply may span several lines: continuation lines put a hyphen after the
 * code (`250-SIZE`), only the last uses a space (`250 OK`).
 *
 * Data is buffered as Bytes, never decoded through `socket.setEncoding()` —
 * on port 587 this same socket is handed to `tls.connect()` after STARTTLS,
 * and a socket left in string mode feeds the TLS layer strings it cannot parse.
 */
function channel(socket) {
  let buffer = Buffer.alloc(0);
  let waiting = null;
  let failure = null;

  function settle() {
    if (!waiting) return;
    if (failure) {
      const w = waiting;
      waiting = null;
      w.reject(failure);
      return;
    }
    const text = buffer.toString('utf8');
    const lines = text.split(CRLF);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/^\d{3}([ -]|$)/.test(line)) continue;
      if (line[3] === '-') continue;                     // continuation
      const consumed = Buffer.byteLength(lines.slice(0, i + 1).join(CRLF), 'utf8') + CRLF.length;
      const reply = { code: Number(line.slice(0, 3)), text: lines.slice(0, i + 1).join('\n') };
      buffer = buffer.subarray(consumed);
      const w = waiting;
      waiting = null;
      w.resolve(reply);
      return;
    }
  }

  const onData = (chunk) => { buffer = Buffer.concat([buffer, chunk]); settle(); };
  const onError = (err) => { failure = err; settle(); };
  const onClose = () => {
    failure = failure || new Error('SMTP server closed the connection unexpectedly');
    settle();
  };
  const onTimeout = () => { socket.destroy(new Error('SMTP timed out')); };

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  socket.on('timeout', onTimeout);

  return {
    /** Stop listening, so the socket can be handed to the TLS layer intact. */
    detach() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('timeout', onTimeout);
    },
    write(line) { socket.write(line + CRLF); },
    read() {
      return new Promise((resolve, reject) => { waiting = { resolve, reject }; settle(); });
    },
  };
}

function connected(socket, event) {
  return new Promise((resolve, reject) => {
    socket.once(event, resolve);
    socket.once('error', reject);
  });
}

/**
 * Send `command`, then require the reply to carry one of `codes`.
 *
 * `SMTP_DEBUG=1` traces the conversation, which is the only practical way to
 * see why a particular provider is unhappy. Every AUTH step is redacted by its
 * label rather than by inspecting the payload: base64 is encoding, not secrecy,
 * and a short username would slip past any length heuristic.
 *
 * @param {string|null} command  null just reads (the greeting)
 */
async function step(ch, command, codes, what) {
  const debug = process.env.SMTP_DEBUG === '1';
  if (command !== null) {
    if (debug) console.error(`[smtp] > ${what.startsWith('AUTH') ? `<${what}>` : command}`);
    ch.write(command);
  }
  const reply = await ch.read();
  if (debug) console.error(`[smtp] < ${reply.text.replace(/\n/g, ' | ')}`);
  if (!codes.includes(reply.code)) {
    throw new Error(`SMTP ${what} failed: ${reply.text.replace(/\s+/g, ' ').trim()}`);
  }
  return reply;
}

const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');

/* ------------------------------- message -------------------------------- */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** RFC 5322 date, always in UTC: `Sun, 02 Aug 2026 07:17:00 +0000`. */
function rfc5322Date(date) {
  return `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} `
    + `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:`
    + `${pad(date.getUTCSeconds())} +0000`;
}

/**
 * RFC 2047 encoded-word for a header value.
 *
 * Pure ASCII is passed through untouched. Anything else (every German umlaut in
 * an event title) is base64'd in short chunks joined by a folded space: an
 * encoded word may not exceed 75 characters, and a chunk boundary must not fall
 * inside a multi-byte character — hence chunking by code point, not by byte.
 */
function encodeHeader(value) {
  const clean = String(value).replace(/[\r\n]+/g, ' ').trim();
  if (!/[^\x20-\x7e]/.test(clean)) return clean;
  const chars = [...clean];
  const words = [];
  for (let i = 0; i < chars.length; i += 12) {
    words.push(`=?UTF-8?B?${b64(chars.slice(i, i + 12).join(''))}?=`);
  }
  return words.join(`${CRLF} `);
}

/**
 * One MIME part, base64-encoded.
 *
 * Bodies are base64'd rather than sent as-is. That makes UTF-8 safe on servers
 * that never announced 8BITMIME, keeps every line inside the 998-character
 * limit, and sidesteps dot-stuffing entirely — a base64 line can never be a
 * lone `.`, which would otherwise end the message early.
 */
function mimePart(contentType, content) {
  const encoded = Buffer.from(String(content).replace(/\r?\n/g, CRLF), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, `$1${CRLF}`);
  return [
    `Content-Type: ${contentType}; charset=utf-8`,
    'Content-Transfer-Encoding: base64',
    '',
    encoded,
  ].join(CRLF);
}

/**
 * Build the DATA payload.
 *
 * With `html` given the message is `multipart/alternative`, plain text first:
 * the parts must run least-rich to most-rich, because a client picks the *last*
 * one it can display. Without it, a bare `text/plain` message.
 */
function buildMessage({ from, to, subject, text, html, date = new Date() }) {
  const domain = /@([^@>]+)>?$/.exec(from)?.[1] || 'localhost';
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${rfc5322Date(date)}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
  ];

  if (!html) {
    return [...headers, mimePart('text/plain', text)].join(CRLF);
  }

  // A uuid can never occur inside base64 output, so the boundary is safe
  // without scanning the parts for it.
  const boundary = `=_rc_${randomUUID()}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    mimePart('text/plain', text),
    `--${boundary}`,
    mimePart('text/html', html),
    `--${boundary}--`,
    '',
  ].join(CRLF);
}

/* --------------------------------- send --------------------------------- */

/**
 * Send one plain-text message.
 *
 * @param {object}  opts
 * @param {string}  opts.host
 * @param {number} [opts.port=465]
 * @param {boolean}[opts.secure]      implicit TLS; defaults to `port === 465`
 * @param {string} [opts.user]        omit both user and pass to skip AUTH
 * @param {string} [opts.pass]
 * @param {string}  opts.from         bare address or `Name <addr>`
 * @param {string}  opts.to           bare address
 * @param {string}  opts.subject
 * @param {string}  opts.text     always required — the fallback part
 * @param {string} [opts.html]    when given, sent as multipart/alternative
 * @param {number} [opts.timeoutMs=20000]
 */
export async function sendMail(opts) {
  const host = opts.host;
  const port = Number(opts.port || 465);
  const secure = opts.secure ?? port === 465;
  const timeoutMs = Number(opts.timeoutMs || 20000);
  if (!host) throw new Error('smtp: host is required');
  if (!opts.from || !opts.to) throw new Error('smtp: from and to are required');

  let socket = secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  socket.setTimeout(timeoutMs);
  await connected(socket, secure ? 'secureConnect' : 'connect');

  let ch = channel(socket);
  try {
    await step(ch, null, [220], 'greeting');
    let caps = (await step(ch, `EHLO ${hostnameFor(opts.from)}`, [250], 'EHLO')).text;

    if (!secure) {
      if (!/^\d{3}[ -]STARTTLS\b/im.test(caps)) {
        throw new Error(`SMTP server ${host}:${port} does not offer STARTTLS — refusing to send credentials over an unencrypted connection`);
      }
      await step(ch, 'STARTTLS', [220], 'STARTTLS');
      ch.detach();
      const upgraded = tls.connect({ socket, servername: host });
      upgraded.setTimeout(timeoutMs);
      await connected(upgraded, 'secureConnect');
      socket = upgraded;
      ch = channel(socket);
      // Capabilities are re-advertised on the encrypted channel; the plaintext
      // ones are not to be trusted (and AUTH usually only appears now).
      caps = (await step(ch, `EHLO ${hostnameFor(opts.from)}`, [250], 'EHLO (TLS)')).text;
    }

    if (opts.user || opts.pass) {
      await authenticate(ch, caps, opts.user, opts.pass);
    }

    await step(ch, `MAIL FROM:<${bareAddress(opts.from)}>`, [250], 'MAIL FROM');
    await step(ch, `RCPT TO:<${bareAddress(opts.to)}>`, [250, 251], 'RCPT TO');
    await step(ch, 'DATA', [354], 'DATA');
    ch.write(buildMessage(opts));
    await step(ch, '.', [250], 'message body');

    // QUIT is a courtesy: the mail is already accepted, so a server that hangs
    // up rudely here must not turn a delivered message into a reported failure.
    try { await step(ch, 'QUIT', [221], 'QUIT'); } catch { /* already sent */ }
  } finally {
    ch.detach();
    socket.destroy();
  }
}

async function authenticate(ch, caps, user, pass) {
  const line = caps.split('\n').find((l) => /^\d{3}[ -]AUTH\b/i.test(l)) || '';
  if (/\bPLAIN\b/i.test(line)) {
    await step(ch, `AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235], 'AUTH PLAIN');
    return;
  }
  if (/\bLOGIN\b/i.test(line)) {
    await step(ch, 'AUTH LOGIN', [334], 'AUTH LOGIN');
    await step(ch, b64(user), [334], 'AUTH LOGIN (user)');
    await step(ch, b64(pass), [235], 'AUTH LOGIN (password)');
    return;
  }
  throw new Error(`SMTP server offers no supported auth mechanism (needs PLAIN or LOGIN, got: ${line.trim() || 'none'})`);
}

/** `Name <a@b.c>` → `a@b.c` */
const bareAddress = (value) => (/<([^>]+)>/.exec(String(value))?.[1] || String(value)).trim();

/** Something plausible to greet the server with; the domain we send as. */
const hostnameFor = (from) => bareAddress(from).split('@')[1] || 'localhost';

export { buildMessage, encodeHeader, rfc5322Date };
