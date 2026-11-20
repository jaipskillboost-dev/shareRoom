import { AwsClient } from 'aws4fetch';
import crypto from 'node:crypto';
import FileTypes from '../public/filetypes.js';
import { Gate } from './gate.js';
import { Room } from './room.js';
import {
  MAX_PASSWORD_CHARS,
  PAGE_ROUTE,
  ROOM_ID_ALPHABET,
  ROOM_ID_LENGTH,
  ROOM_ROUTE,
  TURNSTILE_ORIGIN,
  clientIp,
  contentDisposition,
  contentSecurityPolicy,
  memberToken,
  parseRange,
  r2Origin,
} from './shared.js';

export { Gate, Room };

// Pages, scripts, styles and icons are served by Workers Static Assets straight from dist/ (see wrangler.jsonc).
// This Worker only sees /api/*, /r/* and addresses that match no file.

export default {
  async fetch(request, env) {
    let response;
    try {
      response = await route(request, env);
    } catch (error) {
      console.error(error);
      response = json(500, { error: 'Something went wrong.' });
    }
    if (response.status === 101) return response; // A live connection. Its headers cannot be changed.
    return withSecurityHeaders(response, env);
  },
};

const json = (status, body, headers = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

const turnstileOn = (env) => Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
const directUploads = (env) => Boolean(env.R2_ACCOUNT_ID && env.R2_BUCKET && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);

function withSecurityHeaders(response, env) {
  const secured = new Response(response.body, response);
  if (!secured.headers.has('Content-Security-Policy')) {
    secured.headers.set(
      'Content-Security-Policy',
      contentSecurityPolicy({ turnstile: turnstileOn(env), uploadOrigin: directUploads(env) ? r2Origin(env.R2_ACCOUNT_ID) : '' }),
    );
  }
  secured.headers.set('X-Content-Type-Options', 'nosniff');
  secured.headers.set('Referrer-Policy', 'no-referrer'); // Room IDs are in the URL.
  return secured;
}

const gateOf = (env) => env.GATE.get(env.GATE.idFromName('gate'));
const roomOf = (env, id) => env.ROOM.get(env.ROOM.idFromName(id));
const fileKey = (roomId, fileId) => `${roomId}/${fileId}`;

async function route(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/rooms' && method === 'POST') return createRoom(request, env);

  const match = pathname.match(ROOM_ROUTE);
  if (match) {
    const [, roomId, action, fileId, suffix] = match;
    const room = roomOf(env, roomId);
    const token = memberToken(request.headers.get('cookie'));
    const reading = method === 'GET' || method === 'HEAD';

    if (action === 'join' && !fileId && method === 'POST') return joinRoom(request, env, roomId, room, token);
    if (action === 'ws' && !fileId && method === 'GET' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      if (!isSameOrigin(request)) return new Response(null, { status: 403 });
      return room.fetch(request);
    }
    if (action === 'files' && suffix !== 'complete') {
      if (fileId && suffix === 'view' && reading) return viewFile(request, env, roomId, room, token, fileId);
      if (fileId && !suffix && method === 'GET') return downloadFile(env, roomId, room, token, fileId);
      if (!suffix && method === 'DELETE') return result(await room.deleteFiles(token, fileId ?? null));
    }
    if (action === 'uploads' && suffix !== 'view') {
      if (!fileId && method === 'POST') return startUpload(request, env, roomId, room, token);
      if (fileId && !suffix && method === 'PUT' && !directUploads(env)) return receiveUpload(request, env, roomId, room, token, fileId);
      if (fileId && suffix === 'complete' && method === 'POST') return finishUpload(env, roomId, room, token, fileId);
    }
    return json(404, { error: 'Not found.' });
  }

  if (PAGE_ROUTE.test(pathname) && (method === 'GET' || method === 'HEAD')) return roomPage(request, env);
  return json(404, { error: 'Not found.' });
}

// A room answers { status, error?, ... }. This turns the answer into a response.
function result(answer, extra = {}) {
  const { status, error, needsPassword, counted, discard, token, ...rest } = answer;
  if (error) return json(status, { error, ...(needsPassword && { needsPassword: true }) });
  return json(status, { ...rest, ...extra });
}

/* ---------- Rooms ---------- */

function newRoomId() {
  return Array.from({ length: ROOM_ID_LENGTH }, () => ROOM_ID_ALPHABET[crypto.randomInt(ROOM_ID_ALPHABET.length)]).join('');
}

// Reads a small JSON body, refusing anything larger than `limit` without reading the rest.
async function readJson(request, limit = 2048) {
  if (!request.body) return { body: {} };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return { error: { status: 413, message: 'That request is too large.' } };
    }
    chunks.push(value);
  }
  if (size === 0) return { body: {} };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    return { body: parsed && typeof parsed === 'object' ? parsed : {} };
  } catch {
    return { error: { status: 400, message: 'That request could not be read.' } };
  }
}

function admit(request, roomId, token, status) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return json(status, { id: roomId }, { 'Set-Cookie': `member=${token}; Path=/api/rooms/${roomId}; HttpOnly; SameSite=Strict${secure}` });
}

// The bot check runs once per new room. If it cannot be completed, the room is refused rather than let through.
async function passesBotCheck(env, ip, token) {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip });
    const verifyUrl = env.TURNSTILE_VERIFY_URL || `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;
    const response = await fetch(verifyUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(5000) });
    return (await response.json()).success === true;
  } catch {
    return false;
  }
}

async function createRoom(request, env) {
  const gate = gateOf(env);
  const ip = clientIp(request);
  if (await gate.limited(ip)) return json(429, { error: 'Too many attempts. Wait a minute and try again.' });
  const { body, error } = await readJson(request);
  if (error) return json(error.status, { error: error.message });
  await gate.count(ip);

  if (turnstileOn(env) && !(await passesBotCheck(env, ip, body.turnstileToken))) {
    return json(403, { error: "We couldn't confirm you are human. Reload the page and try again." });
  }
  const password = body.password ?? '';
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_CHARS) {
    return json(400, { error: `The password can be at most ${MAX_PASSWORD_CHARS} characters.` });
  }
  if (!(await gate.openRoom())) return json(503, { error: 'RoomShare is busy right now. Try again in a few minutes.' });

  try {
    for (;;) {
      const id = newRoomId();
      const token = await roomOf(env, id).create(id, password || null);
      if (token) return admit(request, id, token, 201);
    }
  } catch (failure) {
    await gate.closeRoom(0);
    throw failure;
  }
}

async function joinRoom(request, env, roomId, room, token) {
  const gate = gateOf(env);
  const ip = clientIp(request);
  if (await gate.limited(ip)) return json(429, { error: 'Too many attempts. Wait a minute and try again.' });
  const { body, error } = await readJson(request);
  const answer = await room.join(token, body?.password, error ?? null);
  if (answer.counted) await gate.count(ip);
  return answer.status === 200 ? admit(request, roomId, answer.token, 200) : result(answer);
}

function isSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // Browsers always send Origin on WebSockets, so this is a non-browser client.
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

// A room link shows the home page, which then opens the room. Room links are private, so search engines are asked to keep out.
async function roomPage(request, env) {
  const page = await env.ASSETS.fetch(new Request(new URL('/', request.url), { method: request.method, headers: request.headers }));
  const response = new Response(page.body, page);
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

/* ---------- Uploads ---------- */

// With R2 keys set, the page uploads straight to R2 with a link that works for 15 minutes, so file bytes never pass
// through the Worker. Without them (wrangler dev and the tests), the link points back here instead.
async function uploadLink(env, roomId, fileId) {
  if (!directUploads(env)) return `/api/rooms/${roomId}/uploads/${fileId}`;
  const r2 = new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });
  const url = new URL(`${r2Origin(env.R2_ACCOUNT_ID)}/${env.R2_BUCKET}/${fileKey(roomId, fileId)}`);
  url.searchParams.set('X-Amz-Expires', '900');
  const signed = await r2.sign(new Request(url, { method: 'PUT' }), { aws: { signQuery: true } });
  return signed.url;
}

async function startUpload(request, env, roomId, room, token) {
  const { body, error } = await readJson(request, 4096);
  if (error) return json(error.status, { error: error.message });
  const answer = await room.reserveUpload(token, body.name, body.size);
  if (answer.error) return result(answer);
  return json(201, { id: answer.id, url: await uploadLink(env, roomId, answer.id) });
}

// Only used when uploads do not go straight to R2.
async function receiveUpload(request, env, roomId, room, token, fileId) {
  const slot = await room.uploadSlot(token, fileId);
  if (slot.error) return result(slot);
  if (Number(request.headers.get('content-length')) !== slot.size) return json(400, { error: 'The file size does not match.' });

  const key = fileKey(roomId, fileId);
  try {
    if (slot.size === 0 || !request.body) {
      await env.FILES.put(key, new Uint8Array(0));
    } else {
      const sized = new FixedLengthStream(slot.size);
      const copied = request.body.pipeTo(sized.writable);
      await env.FILES.put(key, sized.readable);
      await copied;
    }
  } catch {
    await env.FILES.delete(key);
    return json(400, { error: 'Upload did not finish.' });
  }
  // The room may have ended, or the upload expired, while the file was arriving.
  if ((await room.uploadSlot(token, fileId)).status !== 200) {
    await env.FILES.delete(key);
    return json(410, { error: 'This upload is no longer wanted.' });
  }
  return json(200, { ok: true });
}

async function finishUpload(env, roomId, room, token, fileId) {
  const key = fileKey(roomId, fileId);
  const stored = await env.FILES.head(key);
  const answer = await room.completeUpload(token, fileId, stored ? stored.size : null);
  if (answer.discard && stored) await env.FILES.delete(key);
  return answer.error ? result(answer) : json(201, answer.file);
}

/* ---------- Downloads and viewing ---------- */

async function downloadFile(env, roomId, room, token, fileId) {
  const answer = await room.getFile(token, fileId);
  if (answer.error) return result(answer);
  const object = await env.FILES.get(fileKey(roomId, fileId));
  if (!object) return json(404, { error: 'File not found.' });
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream', // A download never displays: uploads must never run on this origin.
      'Content-Length': String(answer.file.size),
      'Content-Disposition': contentDisposition('attachment', answer.file.name),
      'Cache-Control': 'no-store',
    },
  });
}

// Shows a file in the browser instead of saving it. Three rules keep this safe:
//  - Only types on the allowlist in filetypes.js are shown, and the type sent is ours, never what the upload claimed.
//  - Nothing that can run code is ever sent as a page: HTML and scripts go out as plain text.
//  - Opened on its own, a file is sandboxed (no scripts, no access to this site). PDFs are the one exception,
//    because browsers' built-in PDF viewers refuse to run inside a sandbox, but they run PDF content in their own isolated context.
async function viewFile(request, env, roomId, room, token, fileId) {
  const answer = await room.getFile(token, fileId);
  if (answer.error) return result(answer);
  const { file } = answer;
  const { kind, mime } = FileTypes.describe(file.name);
  if (kind === 'other') return json(415, { error: 'This kind of file cannot be viewed here. Download it instead.' });

  const range = parseRange(request.headers.get('range'), file.size);
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}`, 'Cache-Control': 'no-store' } });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? file.size - 1;
  const headers = {
    'Content-Type': mime,
    'Content-Length': String(file.size === 0 ? 0 : end - start + 1),
    'Content-Disposition': contentDisposition('inline', file.name),
    'Content-Security-Policy':
      kind === 'pdf' ? "frame-ancestors 'none'" : "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'",
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    ...(range && { 'Content-Range': `bytes ${start}-${end}/${file.size}` }),
  };
  const status = range ? 206 : 200;
  if (request.method === 'HEAD' || file.size === 0) return new Response(null, { status, headers });

  const object = await env.FILES.get(fileKey(roomId, fileId), range ? { range: { offset: start, length: end - start + 1 } } : {});
  if (!object) return json(404, { error: 'File not found.' });
  return new Response(object.body, { status, headers });
}
