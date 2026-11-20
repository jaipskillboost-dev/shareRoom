import { DurableObject } from 'cloudflare:workers';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import TextSync from '../public/textsync.js';
import { MAX_PASSWORD_CHARS, cleanFileName, isEdit, limits, memberToken } from './shared.js';

const scrypt = promisify(crypto.scrypt);
const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const gate = (env) => env.GATE.get(env.GATE.idFromName('gate'));

async function hashPassword(text) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('hex'), key: Buffer.from(await scrypt(text, salt, 32)).toString('hex') };
}

async function passwordMatches(stored, text) {
  const key = await scrypt(text, Buffer.from(stored.salt, 'hex'), 32);
  return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(stored.key, 'hex'));
}

/**
 * One room: its members, optional password, shared text, files and live connections.
 *
 * Connections use the WebSocket Hibernation API, so a quiet room is unloaded from memory without dropping anyone,
 * and wakes when someone types. Everything needed after waking is in storage:
 *   meta            { id, password, createdAt }. Missing means the room does not exist (or has ended).
 *   m:<token>       a member's display name
 *   f:<fileId>      a finished file
 *   u:<fileId>      an upload in progress, with its reserved size and when the reservation runs out
 *   bytes           space used and reserved by this room
 *   doc             the shared text, saved at most once a second
 *   emptyAt         when an empty room is deleted, unless someone connects first
 * File contents are in R2 under "<roomId>/<fileId>".
 *
 * A single alarm does all the timed work: dropping silent connections, giving back space from abandoned uploads,
 * and deleting the room once it has been empty for the grace period.
 */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.limits = limits(env);
    this.edits = new WeakMap(); // Per-connection edit counts. Losing them when the room sleeps is harmless.
    this.saveTimer = null;
    // Answered by Cloudflare without waking the room, so idle rooms cost nothing while people stay connected.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(() => this.#load());
  }

  async #load() {
    const storage = this.ctx.storage;
    const entries = async (prefix) => [...(await storage.list({ prefix }))].map(([key, value]) => [key.slice(prefix.length), value]);
    this.meta = (await storage.get('meta')) ?? null;
    this.members = new Map(await entries('m:'));
    this.files = new Map(await entries('f:'));
    this.uploads = new Map(await entries('u:'));
    this.bytes = (await storage.get('bytes')) ?? 0;
    this.emptyAt = (await storage.get('emptyAt')) ?? null;
    this.badPasswords = { count: 0, resetAt: 0 };
    this.doc = Object.assign(new TextSync.Doc(this.limits.maxTextChars), (await storage.get('doc')) ?? {});
  }

  /* ---------- Joining ---------- */

  /** Sets up a new room. Returns the creator's member token, or null if this ID is already taken. */
  async create(id, password) {
    if (this.meta) return null;
    const hashed = password ? await hashPassword(password) : null;
    if (this.meta) return null;
    this.meta = { id, password: hashed, createdAt: Date.now() };
    await this.ctx.storage.put('meta', this.meta);
    const token = await this.#addMember();
    await this.#markEmpty(); // Nobody is connected yet. If nobody ever does, the room still goes away.
    return token;
  }

  async join(token, password, bodyError) {
    if (!this.meta) return { status: 404, error: 'Room not found. It may have ended.', counted: true };
    if (this.#sockets().length >= this.limits.maxRoomUsers) return { status: 403, error: 'This room is full.' };

    // People already inside (a reconnect after a dropped signal) do not need the password again.
    if (this.meta.password && !this.members.has(token)) {
      if (bodyError) return { status: bodyError.status, error: bodyError.message };
      if (typeof password !== 'string' || password === '') {
        return { status: 401, error: 'This room is protected. Enter its password.', needsPassword: true };
      }
      if (this.#tooManyBadPasswords()) {
        return { status: 429, error: 'Too many wrong passwords for this room. Try again in a minute.', needsPassword: true };
      }
      if (password.length > MAX_PASSWORD_CHARS || !(await passwordMatches(this.meta.password, password))) {
        this.badPasswords.count += 1;
        return { status: 401, error: 'Wrong password.', needsPassword: true, counted: true };
      }
      if (!this.meta) return { status: 404, error: 'Room not found. It may have ended.' };
    }
    return { status: 200, token: this.members.has(token) ? token : await this.#addMember() };
  }

  #tooManyBadPasswords() {
    const now = Date.now();
    if (now > this.badPasswords.resetAt) this.badPasswords = { count: 0, resetAt: now + 60_000 };
    return this.badPasswords.count >= this.limits.passwordFailuresPerMinute;
  }

  async #addMember() {
    const token = randomHex(24);
    const name = `Guest-${crypto.randomInt(1000, 10000)}`;
    this.members.set(token, name);
    await this.ctx.storage.put(`m:${token}`, name);
    return token;
  }

  #member(token) {
    return this.meta && token ? this.members.get(token) : undefined;
  }

  /* ---------- Live connections ---------- */

  // The Worker has already checked the address and the page's origin; this checks the member cookie.
  async fetch(request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 });
    const token = memberToken(request.headers.get('cookie'));
    if (!this.#member(token) || this.#sockets().length >= this.limits.maxRoomUsers) {
      return new Response(null, { status: 403 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ person: token, since: Date.now() });

    if (this.emptyAt) {
      this.emptyAt = null;
      await this.ctx.storage.delete('emptyAt');
    }
    await this.#scheduleAlarm();

    const sockets = this.#sockets();
    server.send(
      JSON.stringify({
        t: 'init',
        you: this.members.get(token),
        users: countPeople(sockets),
        locked: Boolean(this.meta.password),
        text: this.doc.text,
        v: this.doc.version,
        files: [...this.files.values()],
        maxFileBytes: this.limits.maxFileBytes,
        maxTextChars: this.limits.maxTextChars,
      }),
    );
    this.#broadcast({ t: 'presence', users: countPeople(sockets) }, sockets);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || !this.meta) return;
    if (data === 'ping') return ws.send('pong'); // Normally answered without waking the room.
    this.#receiveEdit(ws, data);
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {}
    await this.#left([ws]);
  }

  async webSocketError(ws) {
    await this.#left([ws]);
  }

  #sockets(excluding = []) {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN && !excluding.includes(ws));
  }

  #broadcast(message, sockets = this.#sockets()) {
    const data = JSON.stringify(message);
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {} // Already closing.
    }
  }

  async #left(gone) {
    if (!this.meta) return;
    const remaining = this.#sockets(gone);
    this.#broadcast({ t: 'presence', users: countPeople(remaining) }, remaining);
    if (remaining.length === 0) {
      await this.#saveText();
      await this.#markEmpty();
    }
  }

  // Every change gets an answer, either the change itself to everyone or a refusal to its sender,
  // because the sender waits for one before it sends anything else.
  #receiveEdit(ws, data) {
    let op;
    try {
      op = JSON.parse(data)?.op;
    } catch {
      return;
    }
    if (typeof op?.id !== 'string' || op.id.length > 32) return;

    const refuse = () => ws.send(JSON.stringify({ t: 'reject', id: op.id }));
    const now = Date.now();
    let window = this.edits.get(ws);
    if (!window || now - window.start >= this.limits.editWindowMs) {
      window = { start: now, count: 0 };
      this.edits.set(ws, window);
    }
    if (++window.count > this.limits.editsPerWindow) {
      ws.send(JSON.stringify({ t: 'notice', text: 'You are changing the text too quickly.' }));
      return refuse();
    }
    if (!isEdit(op, this.limits.maxTextChars)) return refuse();

    const applied = this.doc.accept(op);
    if (!applied) return refuse();
    this.#broadcast({ t: 'text', v: this.doc.version, id: op.id, ...applied });
    this.#scheduleSave();
  }

  // Saving on every keystroke would use up the free tier's daily writes, so the text is saved at most once a second,
  // and straight away when the last person leaves.
  #scheduleSave() {
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = null;
      this.#saveText().catch(console.error);
    }, 1000);
  }

  async #saveText() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.meta) return;
    await this.ctx.storage.put('doc', { text: this.doc.text, version: this.doc.version, log: this.doc.log });
  }

  /* ---------- Files ---------- */

  /** Reserves space for an upload. The Worker then hands out a link to put the file in R2. */
  async reserveUpload(token, rawName, size) {
    const from = this.#member(token);
    if (!from) return { status: 403, error: 'Join this room first.' };
    if (!Number.isSafeInteger(size) || size < 0) return { status: 400, error: 'The file size is missing.' };
    if (size > this.limits.maxFileBytes) return { status: 413, error: 'This file is too large.' };
    if (this.files.size + this.uploads.size >= this.limits.maxRoomFiles) return { status: 409, error: 'This room has too many files.' };
    if (this.bytes + size > this.limits.maxRoomBytes) return { status: 507, error: 'Not enough storage for this file right now.' };

    this.bytes += size; // Held before waiting on the gate, so two uploads cannot both squeeze into the last space.
    if (!(await gate(this.env).reserve(size))) {
      this.bytes -= size;
      return { status: 507, error: 'Not enough storage for this file right now.' };
    }
    if (!this.meta) {
      await gate(this.env).release(size);
      return { status: 410, error: 'This room has ended.' };
    }

    const id = randomHex(16);
    const upload = { id, name: cleanFileName(rawName), size, from, expires: Date.now() + this.limits.uploadSlotMs };
    this.uploads.set(id, upload);
    await this.ctx.storage.put({ [`u:${id}`]: upload, bytes: this.bytes });
    await this.#scheduleAlarm();
    return { status: 201, id, size };
  }

  /** The reserved upload, so the Worker can check a file sent through it. */
  uploadSlot(token, fileId) {
    if (!this.#member(token)) return { status: 403, error: 'Join this room first.' };
    const upload = this.uploads.get(fileId);
    return upload ? { status: 200, size: upload.size } : { status: 404, error: 'Upload not found.' };
  }

  /**
   * Called once the file is in R2, with the size R2 reports. On any refusal with `discard`, the Worker deletes
   * what was uploaded.
   */
  async completeUpload(token, fileId, storedSize) {
    if (!this.meta) return { status: 410, error: 'This room has ended.', discard: true };
    if (!this.#member(token)) return { status: 403, error: 'Join this room first.' };
    const upload = this.uploads.get(fileId);
    if (!upload) return { status: 404, error: 'Upload not found.', discard: true };

    this.uploads.delete(fileId);
    if (storedSize !== upload.size) {
      this.bytes -= upload.size;
      await this.ctx.storage.delete(`u:${fileId}`);
      await this.ctx.storage.put('bytes', this.bytes);
      await gate(this.env).release(upload.size);
      return { status: 400, error: 'Upload did not finish.', discard: true };
    }

    const file = { id: fileId, name: upload.name, size: upload.size, from: upload.from, at: Date.now() };
    this.files.set(fileId, file);
    await this.ctx.storage.delete(`u:${fileId}`);
    await this.ctx.storage.put(`f:${fileId}`, file);
    this.#broadcast({ t: 'file', file });
    return { status: 201, file };
  }

  getFile(token, fileId) {
    if (!this.#member(token)) return { status: 403, error: 'Join this room first.' };
    const file = this.files.get(fileId);
    return file ? { status: 200, file } : { status: 404, error: 'File not found.' };
  }

  async deleteFiles(token, fileId) {
    const by = this.#member(token);
    if (!by) return { status: 403, error: 'Join this room first.' };
    if (fileId && !this.files.has(fileId)) return { status: 404, error: 'File not found.' };

    const ids = fileId ? [fileId] : [...this.files.keys()];
    let freed = 0;
    for (const id of ids) {
      freed += this.files.get(id).size;
      this.files.delete(id);
    }
    this.bytes -= freed;
    // Everyone's list updates first. Storage cleanup follows and is not worth making them wait for.
    this.#broadcast(fileId ? { t: 'fileRemoved', id: fileId } : { t: 'filesCleared', by });

    if (ids.length) {
      await this.ctx.storage.delete(ids.map((id) => `f:${id}`));
      await this.ctx.storage.put('bytes', this.bytes);
      await this.env.FILES.delete(ids.map((id) => `${this.meta.id}/${id}`));
      await gate(this.env).release(freed);
    }
    return { status: 200, deleted: ids.length };
  }

  /* ---------- Timed work ---------- */

  async #markEmpty() {
    this.emptyAt = Date.now() + this.limits.emptyRoomGraceMs;
    await this.ctx.storage.put('emptyAt', this.emptyAt);
    await this.#scheduleAlarm();
  }

  async #scheduleAlarm() {
    if (!this.meta) return;
    const times = [];
    if (this.#sockets().length) times.push(Date.now() + this.limits.presenceCheckMs);
    if (this.emptyAt) times.push(this.emptyAt);
    for (const upload of this.uploads.values()) times.push(upload.expires);
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    if (!this.meta) return;
    const now = Date.now();

    // A phone that loses signal never sends a close, so connections that stopped pinging are dropped.
    const silent = this.#sockets().filter((ws) => {
      const { since = 0 } = ws.deserializeAttachment() ?? {};
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      return now - Math.max(since, lastPing) > this.limits.staleSocketMs;
    });
    for (const ws of silent) {
      try {
        ws.close(1001, 'No answer');
      } catch {}
    }
    if (silent.length) await this.#left(silent);

    // Space reserved for uploads that never finished is given back, along with anything they left in R2.
    const expired = [...this.uploads.values()].filter((upload) => upload.expires <= now);
    if (expired.length) {
      const size = expired.reduce((sum, upload) => sum + upload.size, 0);
      for (const upload of expired) this.uploads.delete(upload.id);
      this.bytes -= size;
      await this.ctx.storage.delete(expired.map((upload) => `u:${upload.id}`));
      await this.ctx.storage.put('bytes', this.bytes);
      await this.env.FILES.delete(expired.map((upload) => `${this.meta.id}/${upload.id}`));
      await gate(this.env).release(size);
    }

    if (this.emptyAt && now >= this.emptyAt && this.#sockets().length === 0) return this.#destroy();
    await this.#scheduleAlarm();
  }

  async #destroy() {
    const { id } = this.meta;
    const bytes = this.bytes;
    this.meta = null; // From here on the room answers as if it never existed.
    clearTimeout(this.saveTimer);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'Room ended');
      } catch {}
    }
    this.members.clear();
    this.files.clear();
    this.uploads.clear();

    await deletePrefix(this.env.FILES, `${id}/`);
    await gate(this.env).closeRoom(bytes);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.#load(); // Fresh, empty state, in case the same ID is ever created again.
  }

  /** For tests and troubleshooting. Only the Worker can call it, and it never does from a public route. */
  inspect() {
    return {
      exists: Boolean(this.meta),
      password: this.meta?.password ?? null,
      bytes: this.bytes,
      files: this.files.size,
      uploads: this.uploads.size,
      sockets: this.#sockets().length,
      text: this.doc.text,
    };
  }
}

// People, not connections: every tab of one browser shares a cookie, so together they count once.
function countPeople(sockets) {
  return new Set(sockets.map((ws) => ws.deserializeAttachment()?.person)).size;
}

async function deletePrefix(bucket, prefix) {
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
