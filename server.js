'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const { WebSocket, WebSocketServer } = require('ws');
const { Doc } = require('./public/textsync.js');

const GiB = 1024 ** 3;
const envNumber = (name, fallback) => Number(process.env[name] ?? fallback);

const config = {
  port: envNumber('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  // How many reverse proxies sit in front of the server (0 = none). Client IPs and https are read from their headers.
  trustProxyHops: envNumber('TRUST_PROXY', 0),
  // A refresh or a brief network drop should not wipe the room.
  emptyRoomGraceMs: envNumber('EMPTY_ROOM_GRACE_MS', 15_000),
  heartbeatMs: envNumber('HEARTBEAT_MS', 10_000),
  transferIdleMs: envNumber('TRANSFER_IDLE_MS', 60_000),
  maxFileBytes: envNumber('MAX_FILE_BYTES', 2 * GiB),
  maxRoomBytes: envNumber('MAX_ROOM_BYTES', 10 * GiB),
  maxTotalBytes: envNumber('MAX_TOTAL_BYTES', 50 * GiB),
  maxRoomFiles: envNumber('MAX_ROOM_FILES', 500),
  maxRoomUsers: envNumber('MAX_ROOM_USERS', 500),
  maxTextChars: envNumber('MAX_TEXT_CHARS', 100_000),
  // Counts room creations and failed joins, which is what guessing room IDs looks like.
  roomAttemptsPerMinute: envNumber('ROOM_ATTEMPTS_PER_MINUTE', 30),
  // Changes to the shared text one person may send per heartbeat. Only one is in flight at a time, so typing stays far below it.
  editsPerHeartbeat: 400,
  // Rooms that may exist at once. A free server's memory and disk are small, and this stops a flood from filling them.
  maxRooms: envNumber('MAX_ROOMS', 500),
  // Wrong passwords allowed per room per minute from everyone together, so many addresses cannot guess one in parallel.
  passwordFailuresPerMinute: envNumber('PASSWORD_FAILURES_PER_MINUTE', 20),
  // The site's public address, used in link previews. Render sets RENDER_EXTERNAL_URL by itself.
  publicUrl: /^https?:\/\//.test(process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? '')
    ? (process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, '')
    : '',
  // Cloudflare Turnstile is a free bot check shown before a room is created. It is off unless both keys are set.
  turnstile: {
    siteKey: process.env.TURNSTILE_SITE_KEY ?? '',
    secret: process.env.TURNSTILE_SECRET ?? '',
    verifyUrl: process.env.TURNSTILE_VERIFY_URL ?? 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  },
};
const turnstileOn = Boolean(config.turnstile.siteKey && config.turnstile.secret);
const scrypt = promisify(crypto.scrypt);

// Only this subfolder is ever wiped, so STORAGE_DIR can safely point at a shared disk.
const storageRoot = path.join(process.env.STORAGE_DIR ?? os.tmpdir(), 'roomshare-files');

const ROOM_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'; // No 0/o or 1/i/l, for typing on a phone.
const ROOM_ID_LENGTH = 8;
const ROOM_ROUTE = /^\/api\/rooms\/([a-z0-9]{8})(?:\/(join|ws|files)(?:\/([a-f0-9]{32}))?)?$/;
const PAGE_ROUTE = /^\/(?:r\/[a-z0-9]{8})?$/;

const rooms = new Map();
let totalBytes = 0;

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const roomDir = (id) => path.join(storageRoot, id);

function newRoomId() {
  let id;
  do {
    id = Array.from({ length: ROOM_ID_LENGTH }, () => ROOM_ID_ALPHABET[crypto.randomInt(ROOM_ID_ALPHABET.length)]).join('');
  } while (rooms.has(id));
  return id;
}

async function openRoom(password = null) {
  const room = {
    id: newRoomId(),
    password, // { salt, key } when the creator set one. Never the password itself.
    badPasswords: { count: 0, resetAt: 0 },
    members: new Map(), // member token -> display name
    sockets: new Set(),
    document: new Doc(config.maxTextChars),
    files: new Map(),
    transfers: new Set(), // Open file streams, closed first so Windows allows the delete.
    bytes: 0,
    emptyTimer: null,
    destroyed: false,
  };
  await fs.promises.mkdir(roomDir(room.id), { recursive: true });
  rooms.set(room.id, room);
  startEmptyTimer(room);
  return room;
}

function startEmptyTimer(room) {
  clearTimeout(room.emptyTimer);
  room.emptyTimer = setTimeout(() => {
    if (room.sockets.size === 0) destroyRoom(room).catch(console.error);
  }, config.emptyRoomGraceMs);
  room.emptyTimer.unref();
}

async function destroyRoom(room) {
  clearTimeout(room.emptyTimer);
  room.destroyed = true;
  rooms.delete(room.id);
  totalBytes -= room.bytes;
  room.files.clear();
  room.members.clear();
  for (const stream of room.transfers) stream.destroy();
  await fs.promises.rm(roomDir(room.id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function releaseBytes(room, size) {
  if (room.destroyed) return;
  room.bytes -= size;
  totalBytes -= size;
}

function broadcast(room, message) {
  const data = JSON.stringify(message);
  for (const ws of room.sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

/* ---------- Requests ---------- */

// Each proxy appends the address it saw to X-Forwarded-For, so only the entries our own proxies added can be trusted.
// The leftmost entry is whatever the visitor sent, which would let anyone dodge the rate limit with a made-up address.
function clientIp(req) {
  const hops = config.trustProxyHops;
  if (hops > 0) {
    const chain = (req.headers['x-forwarded-for'] ?? '').split(',').map((ip) => ip.trim()).filter(Boolean);
    if (chain.length >= hops) return chain[chain.length - hops];
  }
  return req.socket.remoteAddress;
}

const roomAttempts = new Map();
setInterval(() => roomAttempts.clear(), 60_000).unref();

const overAttemptLimit = (req) => (roomAttempts.get(clientIp(req)) ?? 0) >= config.roomAttemptsPerMinute;

function countAttempt(req) {
  const ip = clientIp(req);
  roomAttempts.set(ip, (roomAttempts.get(ip) ?? 0) + 1);
}

function memberToken(req) {
  return req.headers.cookie?.match(/(?:^|;\s*)member=([a-f0-9]{48})/)?.[1];
}

function memberRoom(req, roomId) {
  const room = rooms.get(roomId);
  return room?.members.has(memberToken(req)) ? room : null;
}

function sendJson(res, status, body) {
  // An unread upload would otherwise have to be drained before the connection could be reused.
  if (!res.req.complete) res.setHeader('Connection', 'close');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function admit(req, res, room, status) {
  let token = memberToken(req);
  if (!room.members.has(token)) {
    token = randomHex(24);
    room.members.set(token, `Guest-${crypto.randomInt(1000, 10000)}`);
  }
  const https = config.trustProxyHops > 0 && req.headers['x-forwarded-proto']?.split(',').pop().trim() === 'https';
  res.setHeader(
    'Set-Cookie',
    `member=${token}; Path=/api/rooms/${room.id}; HttpOnly; SameSite=Strict${https ? '; Secure' : ''}`,
  );
  sendJson(res, status, { id: room.id });
}

// Reads a small JSON body. A body that is too large is rejected after it is read, so the reply can still be sent.
function readJson(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
      else if (size > 64 * 1024) req.destroy(); // Not worth draining.
    });
    req.on('error', reject);
    req.on('end', () => {
      if (size > limit) return reject(Object.assign(new Error('That request is too large.'), { status: 413 }));
      if (size === 0) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks));
        resolve(body && typeof body === 'object' ? body : {});
      } catch {
        reject(Object.assign(new Error('That request could not be read.'), { status: 400 }));
      }
    });
  });
}

const MAX_PASSWORD_CHARS = 128;

async function hashPassword(text) {
  const salt = crypto.randomBytes(16);
  return { salt, key: await scrypt(text, salt, 32) };
}

async function passwordMatches(room, text) {
  return crypto.timingSafeEqual(await scrypt(text, room.password.salt, 32), room.password.key);
}

// The bot check runs once per new room. If it cannot be completed, the room is refused rather than let through.
async function passesBotCheck(req, token) {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    const form = new URLSearchParams({ secret: config.turnstile.secret, response: token, remoteip: clientIp(req) ?? '' });
    const response = await fetch(config.turnstile.verifyUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(5000) });
    return (await response.json()).success === true;
  } catch {
    return false;
  }
}

async function createRoom(req, res) {
  if (overAttemptLimit(req)) return sendJson(res, 429, { error: 'Too many attempts. Wait a minute and try again.' });
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, error.status ?? 400, { error: error.message });
  }
  countAttempt(req);

  if (turnstileOn && !(await passesBotCheck(req, body.turnstileToken))) {
    return sendJson(res, 403, { error: "We couldn't confirm you are human. Reload the page and try again." });
  }
  if (rooms.size >= config.maxRooms) {
    return sendJson(res, 503, { error: 'RoomShare is busy right now. Try again in a few minutes.' });
  }
  const password = body.password ?? '';
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_CHARS) {
    return sendJson(res, 400, { error: `The password can be at most ${MAX_PASSWORD_CHARS} characters.` });
  }
  admit(req, res, await openRoom(password ? await hashPassword(password) : null), 201);
}

function tooManyBadPasswords(room) {
  const now = Date.now();
  if (now > room.badPasswords.resetAt) room.badPasswords = { count: 0, resetAt: now + 60_000 };
  return room.badPasswords.count >= config.passwordFailuresPerMinute;
}

async function joinRoom(req, res, roomId) {
  if (overAttemptLimit(req)) return sendJson(res, 429, { error: 'Too many attempts. Wait a minute and try again.' });
  const room = rooms.get(roomId);
  if (!room) {
    countAttempt(req);
    return sendJson(res, 404, { error: 'Room not found. It may have ended.' });
  }
  if (room.sockets.size >= config.maxRoomUsers) return sendJson(res, 403, { error: 'This room is full.' });

  // People already inside (a reconnect after a dropped signal) do not need the password again.
  if (room.password && !room.members.has(memberToken(req))) {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return sendJson(res, error.status ?? 400, { error: error.message });
    }
    const given = body.password;
    if (typeof given !== 'string' || given === '') {
      return sendJson(res, 401, { error: 'This room is protected. Enter its password.', needsPassword: true });
    }
    if (tooManyBadPasswords(room)) {
      return sendJson(res, 429, { error: 'Too many wrong passwords for this room. Try again in a minute.', needsPassword: true });
    }
    if (given.length > MAX_PASSWORD_CHARS || !(await passwordMatches(room, given))) {
      room.badPasswords.count += 1;
      countAttempt(req);
      return sendJson(res, 401, { error: 'Wrong password.', needsPassword: true });
    }
    if (room.destroyed) return sendJson(res, 404, { error: 'Room not found. It may have ended.' });
  }
  admit(req, res, room, 200);
}

function cleanFileName(raw) {
  const name = (raw ?? '').replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 255);
  return name || 'file';
}

async function uploadFile(req, res, room, rawName) {
  const size = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(size) || size < 0) return sendJson(res, 411, { error: 'Content-Length is required.' });
  if (size > config.maxFileBytes) return sendJson(res, 413, { error: 'This file is too large.' });
  if (room.files.size >= config.maxRoomFiles) return sendJson(res, 409, { error: 'This room has too many files.' });
  if (room.bytes + size > config.maxRoomBytes || totalBytes + size > config.maxTotalBytes) {
    return sendJson(res, 507, { error: 'Not enough storage for this file right now.' });
  }

  // Reserved up front: Content-Length is enforced by the HTTP parser, so uploads cannot overrun it.
  room.bytes += size;
  totalBytes += size;

  const id = randomHex(16);
  const filePath = path.join(roomDir(room.id), id); // Never the client's name, so no path tricks.
  const output = fs.createWriteStream(filePath, { flags: 'wx' });
  const from = room.members.get(memberToken(req));
  room.transfers.add(output);
  req.setTimeout(config.transferIdleMs, () => req.destroy());

  try {
    await pipeline(req, output);
  } catch {
    releaseBytes(room, size);
    await fs.promises.rm(filePath, { force: true }).catch(() => {});
    if (!res.destroyed) sendJson(res, 400, { error: 'Upload did not finish.' });
    return;
  } finally {
    room.transfers.delete(output);
  }

  if (room.destroyed) return sendJson(res, 410, { error: 'This room has ended.' });

  const file = { id, name: cleanFileName(rawName), size, from, at: Date.now() };
  room.files.set(id, file);
  broadcast(room, { t: 'file', file });
  sendJson(res, 201, file);
}

async function downloadFile(req, res, room, fileId) {
  const file = room.files.get(fileId);
  if (!file) return sendJson(res, 404, { error: 'File not found.' });

  const name = encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream', // Always a download: uploads must never run on this origin.
    'Content-Length': file.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
    'Cache-Control': 'no-store',
  });

  const input = fs.createReadStream(path.join(roomDir(room.id), fileId));
  input.fileId = fileId; // Lets a delete close this stream first, which Windows needs before removing the file.
  room.transfers.add(input);
  req.setTimeout(config.transferIdleMs, () => req.destroy());
  await pipeline(input, res)
    .catch(() => {}) // The downloader went away, or the room ended.
    .finally(() => room.transfers.delete(input));
}

async function deleteFiles(req, res, room, fileId) {
  if (fileId && !room.files.has(fileId)) return sendJson(res, 404, { error: 'File not found.' });

  const ids = new Set(fileId ? [fileId] : room.files.keys());
  for (const id of ids) releaseBytes(room, room.files.get(id).size);
  for (const id of ids) room.files.delete(id);

  // Everyone's list updates first. Disk cleanup follows and is not worth making them wait for.
  const by = room.members.get(memberToken(req));
  broadcast(room, fileId ? { t: 'fileRemoved', id: fileId } : { t: 'filesCleared', by });

  for (const stream of room.transfers) if (ids.has(stream.fileId)) stream.destroy();
  await Promise.all(
    [...ids].map((id) =>
      fs.promises.rm(path.join(roomDir(room.id), id), { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}),
    ),
  );
  sendJson(res, 200, { deleted: ids.size });
}

/* ---------- Static files, held compressed in RAM ---------- */

// Images are already compressed, so they are kept as they are.
function buildAsset(type, body, cacheControl, { compress = true } = {}) {
  const raw = Buffer.from(body);
  return {
    type,
    cacheControl,
    etag: `"${crypto.createHash('sha1').update(raw).digest('base64url')}"`,
    raw,
    compressed: compress,
    br: compress ? zlib.brotliCompressSync(raw) : null,
    gzip: compress ? zlib.gzipSync(raw) : null,
  };
}

const escapeAttribute = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Fills in the page's link-preview tags and bot-check key. Without a public address the tags that need one are dropped.
function renderPage(html, version) {
  return html
    .split('\n')
    .filter((line) => config.publicUrl || !line.includes('__PUBLIC_URL__'))
    .join('\n')
    .replaceAll('__VERSION__', version)
    .replaceAll('__PUBLIC_URL__', escapeAttribute(config.publicUrl))
    .replaceAll('__TURNSTILE_SITE_KEY__', escapeAttribute(turnstileOn ? config.turnstile.siteKey : ''));
}

function loadAssets() {
  const text = (file) => fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
  const bytes = (file) => fs.readFileSync(path.join(__dirname, 'public', file));
  const script = text('app.js');
  const scripts = { '/textsync.js': text('textsync.js'), '/theme.js': text('theme.js'), '/qr.js': text('qr.js') };
  const qrLibrary = text('vendor/qrcode.js');
  const styles = text('style.css');
  // Versioned URLs let browsers cache these forever, so repeat visits need no request for them.
  const hash = crypto.createHash('sha1');
  for (const source of [script, ...Object.values(scripts), qrLibrary, styles]) hash.update(source);
  const version = hash.digest('hex').slice(0, 12);

  const forever = 'public, max-age=31536000, immutable';
  const daily = 'public, max-age=86400'; // Not versioned, so a change can take up to a day to reach browsers.
  const js = 'text/javascript; charset=utf-8';
  const found = {
    page: buildAsset('text/html; charset=utf-8', renderPage(text('index.html'), version), 'no-cache'),
    '/app.js': buildAsset(js, script, forever),
    '/vendor/qrcode.js': buildAsset(js, qrLibrary, forever),
    '/style.css': buildAsset('text/css; charset=utf-8', styles, forever),
    '/manifest.webmanifest': buildAsset('application/manifest+json', text('manifest.webmanifest'), daily),
  };
  for (const [url, source] of Object.entries(scripts)) found[url] = buildAsset(js, source, forever);
  for (const image of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'og-image.png']) {
    found[`/${image}`] = buildAsset('image/png', bytes(image), daily, { compress: false });
  }
  return found;
}

const assets = loadAssets();

// Only the bot check's own address is added, and only when the check is on.
const challenge = turnstileOn ? ' https://challenges.cloudflare.com' : '';
const contentSecurityPolicy = [
  "default-src 'none'",
  `script-src 'self'${challenge}`,
  "style-src 'self'",
  `connect-src 'self'${challenge}`,
  turnstileOn ? `frame-src${challenge}` : null,
  "img-src 'self' data:",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
]
  .filter(Boolean)
  .join('; ');

function serveAsset(req, res, asset) {
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Cache-Control', asset.cacheControl);
  res.setHeader('ETag', asset.etag);
  if (req.headers['if-none-match'] === asset.etag) return res.writeHead(304).end();

  const accepted = req.headers['accept-encoding'] ?? '';
  const encoding = !asset.compressed ? null : /\bbr\b/.test(accepted) ? 'br' : /\bgzip\b/.test(accepted) ? 'gzip' : null;
  const body = encoding ? asset[encoding] : asset.raw;
  if (encoding) res.setHeader('Content-Encoding', encoding);
  res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(err);
    if (res.headersSent) res.destroy();
    else sendJson(res, 500, { error: 'Something went wrong.' });
  });
});

// Large uploads can legitimately outlast the default limit. Stalled ones hit transferIdleMs instead.
server.requestTimeout = 0;

async function route(req, res) {
  res.setHeader('Content-Security-Policy', contentSecurityPolicy);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer'); // Room IDs are in the URL.

  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (pathname === '/api/rooms' && req.method === 'POST') return createRoom(req, res);

  const match = pathname.match(ROOM_ROUTE);
  if (match) {
    const [, roomId, action, fileId] = match;
    if (action === 'join' && req.method === 'POST') return joinRoom(req, res, roomId);
    if (action === 'files') {
      const room = memberRoom(req, roomId);
      if (!room) return sendJson(res, 403, { error: 'Join this room first.' });
      if (!fileId && req.method === 'POST') return uploadFile(req, res, room, url.searchParams.get('name'));
      if (fileId && req.method === 'GET') return downloadFile(req, res, room, fileId);
      if (req.method === 'DELETE') return deleteFiles(req, res, room, fileId);
    }
    return sendJson(res, 404, { error: 'Not found.' });
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const asset = PAGE_ROUTE.test(pathname) ? assets.page : assets[pathname];
    // Room links are private, so search engines are asked to keep them out of results.
    if (asset === assets.page && pathname !== '/') res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (asset) return serveAsset(req, res, asset);
  }
  sendJson(res, 404, { error: 'Not found.' });
}

/* ---------- Live connections ---------- */

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 1024 * 1024, // Room for a paste of the largest allowed text, with its JSON escaping.
  perMessageDeflate: false, // Most changes are a few characters, so compression only adds delay.
});

function isSameOrigin(req) {
  const { origin } = req.headers;
  if (!origin) return true; // Browsers always send Origin on WebSockets, so this is a non-browser client.
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

server.on('upgrade', (req, socket, head) => {
  const refuse = (status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  const match = req.url.split('?')[0].match(ROOM_ROUTE);
  if (match?.[2] !== 'ws') return refuse('404 Not Found');
  if (!isSameOrigin(req)) return refuse('403 Forbidden');

  const room = memberRoom(req, match[1]);
  if (!room || room.sockets.size >= config.maxRoomUsers) return refuse('403 Forbidden');
  wss.handleUpgrade(req, socket, head, (ws) => addSocket(ws, room, memberToken(req)));
});

// People, not connections: every tab of one browser shares a cookie, so together they count once.
const countPeople = (room) => new Set([...room.sockets].map((ws) => ws.person)).size;

function addSocket(ws, room, token) {
  clearTimeout(room.emptyTimer);
  room.sockets.add(ws);
  ws.person = token;
  ws.isAlive = true;
  ws.editCount = 0;

  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('error', () => ws.terminate());
  ws.on('message', (data, isBinary) => {
    if (!isBinary) receiveEdit(ws, room, data);
  });
  ws.on('close', () => {
    room.sockets.delete(ws);
    if (room.destroyed) return;
    broadcast(room, { t: 'presence', users: countPeople(room) });
    if (room.sockets.size === 0) startEmptyTimer(room);
  });

  ws.send(
    JSON.stringify({
      t: 'init',
      you: room.members.get(token),
      users: countPeople(room),
      locked: Boolean(room.password),
      text: room.document.text,
      v: room.document.version,
      files: [...room.files.values()],
      maxFileBytes: config.maxFileBytes,
      maxTextChars: config.maxTextChars,
    }),
  );
  broadcast(room, { t: 'presence', users: countPeople(room) });
}

function isEdit(op) {
  return (
    Number.isInteger(op.base) &&
    op.base >= 0 &&
    Number.isInteger(op.from) &&
    op.from >= 0 &&
    Number.isInteger(op.to) &&
    op.to >= op.from &&
    typeof op.insert === 'string' &&
    op.insert.length <= config.maxTextChars
  );
}

// Every change gets an answer, either the change itself to everyone or a refusal to its sender,
// because the sender waits for one before it sends anything else.
function receiveEdit(ws, room, data) {
  let op;
  try {
    op = JSON.parse(data)?.op;
  } catch {
    return;
  }
  if (typeof op?.id !== 'string' || op.id.length > 32) return;

  const refuse = () => ws.send(JSON.stringify({ t: 'reject', id: op.id }));
  if (++ws.editCount > config.editsPerHeartbeat) {
    ws.send(JSON.stringify({ t: 'notice', text: 'You are changing the text too quickly.' }));
    return refuse();
  }
  if (!isEdit(op)) return refuse();

  const applied = room.document.accept(op);
  if (!applied) return refuse();
  broadcast(room, { t: 'text', v: room.document.version, id: op.id, ...applied });
}

// A phone that loses signal never sends a close, so presence has to be checked actively.
setInterval(() => {
  for (const room of rooms.values()) {
    for (const ws of room.sockets) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.editCount = 0;
      ws.ping();
    }
  }
}, config.heartbeatMs).unref();

/* ---------- Startup ---------- */

function wipeStorage() {
  fs.rmSync(storageRoot, { recursive: true, force: true, maxRetries: 3 });
}

// Clears anything left by a crash: no room survives a restart, so no file should either.
wipeStorage();
fs.mkdirSync(storageRoot, { recursive: true });

if (require.main === module) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      try {
        wipeStorage();
      } finally {
        process.exit(0);
      }
    });
  }
  server.listen(config.port, config.host, () => {
    console.log(`RoomShare running on http://localhost:${server.address().port}`);
  });
}

module.exports = { server, rooms, config, storageRoot, clientIp };
