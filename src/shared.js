// Rules and helpers shared by the Worker, the room and the asset build. Nothing here touches Cloudflare APIs,
// so the asset build and the tests can load it in plain Node too.

const GiB = 1024 ** 3;

/** Limits, read from the Worker's vars, with defaults that fit Cloudflare's free tier. */
export function limits(env = {}) {
  const read = (name, fallback) => {
    const value = Number(env[name]);
    return env[name] === undefined || env[name] === '' || !Number.isFinite(value) ? fallback : value;
  };
  // Without R2 keys, uploads pass through the Worker, and the free plan accepts request bodies up to 100 MB.
  const throughWorker = !(env.R2_ACCOUNT_ID && env.R2_BUCKET && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
  return {
    maxFileBytes: Math.min(read('MAX_FILE_BYTES', 2 * GiB), throughWorker ? 100_000_000 : Infinity),
    maxRoomBytes: read('MAX_ROOM_BYTES', 4 * GiB),
    // R2's free tier holds 10 GB. Uploads that would pass this are refused, which leaves headroom.
    maxTotalBytes: read('MAX_TOTAL_BYTES', 8 * GiB),
    maxRoomFiles: read('MAX_ROOM_FILES', 500),
    maxRoomUsers: read('MAX_ROOM_USERS', 500),
    maxTextChars: read('MAX_TEXT_CHARS', 100_000),
    maxRooms: read('MAX_ROOMS', 200),
    // A refresh or a brief network drop should not wipe the room.
    emptyRoomGraceMs: read('EMPTY_ROOM_GRACE_MS', 15_000),
    // Counts room creations and failed joins, which is what guessing room IDs looks like.
    roomAttemptsPerMinute: read('ROOM_ATTEMPTS_PER_MINUTE', 30),
    // Wrong passwords allowed per room per minute from everyone together.
    passwordFailuresPerMinute: read('PASSWORD_FAILURES_PER_MINUTE', 20),
    // Changes to the shared text one connection may send per window. Only one is in flight at a time,
    // so typing stays far below it.
    editsPerWindow: read('EDITS_PER_WINDOW', 400),
    editWindowMs: read('EDIT_WINDOW_MS', 10_000),
    // The page sends "ping" every 15 seconds. A connection silent for longer than this is treated as gone.
    staleSocketMs: read('STALE_SOCKET_MS', 45_000),
    presenceCheckMs: read('PRESENCE_CHECK_MS', 30_000),
    // How long an upload link stays reserved before its space is given back.
    uploadSlotMs: read('UPLOAD_SLOT_MS', 30 * 60_000),
  };
}

export const ROOM_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'; // No 0/o or 1/i/l, for typing on a phone.
export const ROOM_ID_LENGTH = 8;
export const ROOM_ROUTE =
  /^\/api\/rooms\/([a-z0-9]{8})(?:\/(join|ws|files|uploads)(?:\/([a-f0-9]{32})(?:\/(view|complete))?)?)?$/;
export const PAGE_ROUTE = /^\/r\/[a-z0-9]{8}$/;
export const MAX_PASSWORD_CHARS = 128;
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

export const memberToken = (cookieHeader) => cookieHeader?.match(/(?:^|;\s*)member=([a-f0-9]{48})/)?.[1];

/** Cloudflare puts the visitor's address in this header, and visitors cannot set it themselves. */
export const clientIp = (request) => request.headers.get('cf-connecting-ip') ?? 'unknown';

/** The bucket's own address, which the page uploads to when uploads go straight to R2. */
export const r2Origin = (accountId) => (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');

export function contentSecurityPolicy({ turnstile = false, uploadOrigin = '' } = {}) {
  const challenge = turnstile ? ` ${TURNSTILE_ORIGIN}` : '';
  const upload = uploadOrigin ? ` ${uploadOrigin}` : '';
  return [
    "default-src 'none'",
    `script-src 'self'${challenge}`,
    "style-src 'self'",
    `connect-src 'self'${challenge}${upload}`,
    turnstile ? `frame-src${challenge}` : null,
    "img-src 'self' data:",
    "media-src 'self'", // Videos and audio being viewed.
    "worker-src 'self'", // The PDF reader does its work in a background worker.
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ]
    .filter(Boolean)
    .join('; ');
}

export function cleanFileName(raw) {
  const name = String(raw ?? '').replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 255);
  return name || 'file';
}

export const contentDisposition = (disposition, fileName) =>
  `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`;

// Understands the one kind of Range header browsers send for video, audio and PDFs: "bytes=start-end".
// Returns { start, end }, null when there is no usable header (send the whole file), or 'invalid' (answer 416).
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    const last = Number(match[2]); // "bytes=-500" is the final 500 bytes.
    if (last === 0) return 'invalid';
    start = Math.max(0, size - last);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start > end || start >= size ? 'invalid' : { start, end };
}

export function isEdit(op, maxTextChars) {
  return (
    Number.isInteger(op.base) &&
    op.base >= 0 &&
    Number.isInteger(op.from) &&
    op.from >= 0 &&
    Number.isInteger(op.to) &&
    op.to >= op.from &&
    typeof op.insert === 'string' &&
    op.insert.length <= maxTextChars
  );
}

const escapeAttribute = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Fills in the page's link-preview tags and bot-check key. Without a public address the tags that need one are dropped.
export function renderPage(html, { version, publicUrl = '', turnstileSiteKey = '' }) {
  const address = /^https?:\/\//.test(publicUrl) ? publicUrl.replace(/\/+$/, '') : '';
  return html
    .split('\n')
    .filter((line) => address || !line.includes('__PUBLIC_URL__'))
    .join('\n')
    .replaceAll('__VERSION__', version)
    .replaceAll('__PUBLIC_URL__', escapeAttribute(address))
    .replaceAll('__TURNSTILE_SITE_KEY__', escapeAttribute(turnstileSiteKey));
}
