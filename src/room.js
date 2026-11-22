import { DurableObject } from 'cloudflare:workers';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import Device from '../public/device.js';
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
 *   meta            { id, password, createdAt, owner, closed, expiresAt }. Missing means the room does not exist.
 *                   owner is the creator's member token; closed means locked to newcomers; expiresAt is the
 *                   self-destruct time, if one is set.
 *   m:<token>       a member: { name, pid }. The pid is a short public ID, so pages can tell people apart
 *                   without ever seeing each other's tokens.
 *   f:<fileId>      a finished file
 *   u:<fileId>      an upload in progress, with its reserved size and when the reservation runs out
 *   bytes           space used and reserved by this room
 *   doc             the shared text, saved at most once a second
 *   emptyAt         when an empty room is deleted, unless someone connects first
 * File contents are in R2 under "<roomId>/<fileId>".
 *
 * A single alarm does all the timed work: dropping silent connections, giving back space from abandoned uploads,
 * ending the room when its timer runs out, and deleting it once it has been empty for the grace period.
 */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.limits = limits(env);
    // Per-connection message counts. Losing them when the room sleeps is harmless.
    this.edits = new WeakMap();
    this.actions = new WeakMap();
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
    this.meta = { id, password: hashed, createdAt: Date.now(), owner: null, closed: false, expiresAt: null };
    const token = await this.#addMember();
    this.meta.owner = token;
    await this.ctx.storage.put('meta', this.meta);
    await this.#markEmpty(); // Nobody is connected yet. If nobody ever does, the room still goes away.
    return token;
  }

  async join(token, password, bodyError) {
    if (!this.meta) return { status: 404, error: 'Room not found. It may have ended.', counted: true };
    if (this.#sockets().length >= this.limits.maxRoomUsers) return { status: 403, error: 'This room is full.' };
    // A locked room still lets its own people back in after a dropped signal.
    if (this.meta.closed && !this.members.has(token)) {
      return { status: 403, error: 'This room is locked. Ask someone inside to unlock it.' };
    }

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
    const member = { name: `Guest-${crypto.randomInt(1000, 10000)}`, pid: randomHex(4) };
    this.members.set(token, member);
    await this.ctx.storage.put(`m:${token}`, member);
    return token;
  }

  #member(token) {
    return this.meta && token ? this.members.get(token) : undefined;
  }

  async #rename(token, name) {
    const member = this.members.get(token);
    if (!member || !name || member.name === name) return false;
    member.name = name;
    await this.ctx.storage.put(`m:${token}`, member);
    return true;
  }

  /* ---------- Live connections ---------- */

  // The Worker has already checked the address and the page's origin; this checks the member cookie.
  async fetch(request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 });
    const token = memberToken(request.headers.get('cookie'));
    if (!this.#member(token) || this.#sockets().length >= this.limits.maxRoomUsers) {
      return new Response(null, { status: 403 });
    }

    // The page sends the name it wants to show (its device name, or one the person chose) with the connection.
    await this.#rename(token, Device.cleanName(new URL(request.url).searchParams.get('name')));
    const arriving = !this.#sockets().some((ws) => personOf(ws) === token); // A second tab is not a new arrival.

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ person: token, since: Date.now() });

    if (this.emptyAt) {
      this.emptyAt = null;
      await this.ctx.storage.delete('emptyAt');
    }
    await this.#scheduleAlarm();

    const sockets = this.#sockets();
    const me = this.#person(token);
    server.send(
      JSON.stringify({
        t: 'init',
        you: me.name,
        me: me.pid,
        owner: this.meta.owner === token,
        ownerId: this.members.get(this.meta.owner)?.pid ?? null,
        users: countPeople(sockets),
        people: this.#people(sockets),
        locked: Boolean(this.meta.password),
        closed: this.meta.closed === true,
        expiresAt: this.meta.expiresAt ?? null,
        // Time left, so a page whose clock is off still counts down correctly.
        expiresIn: this.meta.expiresAt ? this.meta.expiresAt - Date.now() : null,
        text: this.doc.text,
        v: this.doc.version,
        files: [...this.files.values()],
        maxFileBytes: this.limits.maxFileBytes,
        maxTextChars: this.limits.maxTextChars,
      }),
    );
    if (arriving) this.#broadcast({ t: 'joined', ...me }, { except: token, sockets });
    this.#broadcast(this.#presence(sockets), { sockets });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || !this.meta) return;
    if (data === 'ping') return ws.send('pong'); // Normally answered without waking the room.
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message?.op) this.#receiveEdit(ws, message.op);
    else if (typeof message?.t === 'string') await this.#receiveAction(ws, message);
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

  #person(token) {
    const member = this.members.get(token);
    return { pid: member?.pid, name: member?.name };
  }

  // Everyone connected, once each however many tabs they have open.
  #people(sockets = this.#sockets()) {
    return [...new Set(sockets.map(personOf))].map((token) => this.#person(token));
  }

  #presence(sockets = this.#sockets()) {
    return { t: 'presence', users: countPeople(sockets), people: this.#people(sockets) };
  }

  #broadcast(message, { except, sockets = this.#sockets() } = {}) {
    const data = JSON.stringify(message);
    for (const ws of sockets) {
      if (except && personOf(ws) === except) continue;
      try {
        ws.send(data);
      } catch {} // Already closing.
    }
  }

  async #left(gone) {
    if (!this.meta) return;
    const remaining = this.#sockets(gone);
    const stillHere = new Set(remaining.map(personOf));
    for (const token of new Set(gone.map(personOf))) {
      if (token && !stillHere.has(token)) this.#broadcast({ t: 'left', ...this.#person(token) }, { sockets: remaining });
    }
    this.#broadcast(this.#presence(remaining), { sockets: remaining });
    if (remaining.length === 0) {
      await this.#saveText();
      await this.#markEmpty();
    }
  }

  // Counts messages per connection over a window. Returns false once the connection is over its limit.
  #withinLimit(counts, ws, limit) {
    const now = Date.now();
    let window = counts.get(ws);
    if (!window || now - window.start >= this.limits.editWindowMs) {
      window = { start: now, count: 0 };
      counts.set(ws, window);
    }
    return ++window.count <= limit;
  }

  // Every change gets an answer, either the change itself to everyone or a refusal to its sender,
  // because the sender waits for one before it sends anything else.
  #receiveEdit(ws, op) {
    if (typeof op?.id !== 'string' || op.id.length > 32) return;

    const refuse = () => ws.send(JSON.stringify({ t: 'reject', id: op.id }));
    if (!this.#withinLimit(this.edits, ws, this.limits.editsPerWindow)) {
      ws.send(JSON.stringify({ t: 'notice', text: 'You are changing the text too quickly.' }));
      return refuse();
    }
    if (!isEdit(op, this.limits.maxTextChars)) return refuse();

    const applied = this.doc.accept(op);
    if (!applied) return refuse();
    this.#broadcast({ t: 'text', v: this.doc.version, id: op.id, ...applied });
    this.#scheduleSave();
  }

  // Everything on the live connection that is not a text edit. Most of it is passed on to the others as it is:
  // who is typing, upload progress, a new name. Locking and the timer belong to the person who created the room.
  async #receiveAction(ws, message) {
    if (!this.#withinLimit(this.actions, ws, this.limits.actionsPerWindow)) return;
    const token = personOf(ws);
    const me = this.#person(token);
    const notice = (text) => ws.send(JSON.stringify({ t: 'notice', text }));

    switch (message.t) {
      case 'name': {
        const name = Device.cleanName(message.name);
        if (await this.#rename(token, name)) this.#broadcast({ t: 'renamed', pid: me.pid, name });
        return;
      }
      case 'typing':
        this.#broadcast({ t: 'typing', ...me }, { except: token });
        return;
      case 'uploading': {
        const key = message.key;
        if (typeof key !== 'string' || !/^[a-z0-9]{1,32}$/i.test(key)) return;
        if (message.done) return this.#broadcast({ t: 'uploading', pid: me.pid, key, done: true }, { except: token });
        const pct = Number(message.pct);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) return;
        const size = Number.isSafeInteger(message.size) && message.size >= 0 ? message.size : null;
        this.#broadcast({ t: 'uploading', ...me, key, file: cleanFileName(message.file), size, pct: Math.round(pct) }, { except: token });
        return;
      }
      case 'lock':
        if (this.meta.owner !== token) return notice('Only the person who created the room can lock it.');
        this.meta.closed = message.closed === true;
        await this.ctx.storage.put('meta', this.meta);
        this.#broadcast({ t: 'closed', closed: this.meta.closed, by: me.name, byId: me.pid });
        return;
      case 'timer': {
        if (this.meta.owner !== token) return notice('Only the person who created the room can set a timer.');
        const seconds = message.seconds;
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > this.limits.maxTimerSeconds) return;
        this.meta.expiresAt = seconds ? Date.now() + seconds * 1000 : null;
        await this.ctx.storage.put('meta', this.meta);
        await this.#scheduleAlarm();
        this.#broadcast({ t: 'timer', expiresAt: this.meta.expiresAt, expiresIn: seconds ? seconds * 1000 : null, by: me.name, byId: me.pid });
        return;
      }
    }
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
    const member = this.#member(token);
    if (!member) return { status: 403, error: 'Join this room first.' };
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
    const upload = { id, name: cleanFileName(rawName), size, from: member.name, fromId: member.pid, expires: Date.now() + this.limits.uploadSlotMs };
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

    const file = { id: fileId, name: upload.name, size: upload.size, from: upload.from, fromId: upload.fromId, at: Date.now() };
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
    const member = this.#member(token);
    if (!member) return { status: 403, error: 'Join this room first.' };
    if (fileId && !this.files.has(fileId)) return { status: 404, error: 'File not found.' };

    const ids = fileId ? [fileId] : [...this.files.keys()];
    let freed = 0;
    for (const id of ids) {
      freed += this.files.get(id).size;
      this.files.delete(id);
    }
    this.bytes -= freed;
    // Everyone's list updates first. Storage cleanup follows and is not worth making them wait for.
    this.#broadcast(fileId ? { t: 'fileRemoved', id: fileId } : { t: 'filesCleared', by: member.name });

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
    if (this.meta.expiresAt) times.push(this.meta.expiresAt);
    for (const upload of this.uploads.values()) times.push(upload.expires);
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    if (!this.meta) return;
    const now = Date.now();

    // The self-destruct timer ran out: everyone is told, then the room goes, even with people in it.
    if (this.meta.expiresAt && now >= this.meta.expiresAt) {
      this.#broadcast({ t: 'ended', reason: 'timer' });
      return this.#destroy(4001, 'Room ended');
    }

    // A phone that loses signal or is locked stops pinging, so connections that went quiet are dropped.
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

  async #destroy(code = 1000, reason = 'Room ended') {
    const { id } = this.meta;
    const bytes = this.bytes;
    this.meta = null; // From here on the room answers as if it never existed.
    clearTimeout(this.saveTimer);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(code, reason);
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
      closed: this.meta?.closed ?? false,
      expiresAt: this.meta?.expiresAt ?? null,
      bytes: this.bytes,
      files: this.files.size,
      uploads: this.uploads.size,
      sockets: this.#sockets().length,
      text: this.doc.text,
    };
  }
}

const personOf = (ws) => ws.deserializeAttachment()?.person;

// People, not connections: every tab of one browser shares a cookie, so together they count once.
function countPeople(sockets) {
  return new Set(sockets.map(personOf)).size;
}

async function deletePrefix(bucket, prefix) {
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
