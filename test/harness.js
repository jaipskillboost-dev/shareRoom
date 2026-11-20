'use strict';

// Starts RoomShare's Worker locally, with its Durable Objects and R2 bucket, for one test file.
// Each file gets its own page build (link previews, bot check) and its own limits, passed as Worker vars.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '..');
const plain = (value) => JSON.parse(JSON.stringify(value));

async function startRoomShare({ vars = {}, page = {} } = {}) {
  const { createTestHarness, experimental_readRawConfig } = require('wrangler');
  const { buildAssets } = await import(pathToFileURL(path.join(root, 'scripts', 'build-assets.mjs')).href);

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomshare-assets-'));
  buildAssets({ outDir, ...page });

  const { rawConfig } = experimental_readRawConfig({ config: path.join(root, 'wrangler.jsonc') });
  const { build, $schema, ...config } = rawConfig;
  const server = createTestHarness({
    root,
    workers: [
      {
        config: {
          ...config,
          assets: { ...config.assets, directory: outDir },
          vars: { ...config.vars, ...vars },
        },
      },
    ],
  });
  const { url } = await server.listen();
  const base = url.origin;
  const worker = server.getWorker();
  const env = await worker.getEnv();

  return {
    base,
    server,
    worker,
    env,
    /** What a room holds right now: existence, bytes, file counts, password hash, connections. */
    // Results from Durable Objects arrive as proxies in Node, and a JSON round trip turns them into plain objects.
    room: async (id) => plain(await env.ROOM.get(env.ROOM.idFromName(id)).inspect()),
    gate: async () => plain(await env.GATE.get(env.GATE.idFromName('gate')).inspect()),
    /** The keys a room has in R2. */
    async objects(id) {
      const listed = await env.FILES.list({ prefix: `${id}/` });
      return listed.objects.map((object) => object.key.slice(id.length + 1)).sort();
    },
    async close() {
      await server.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    },
  };
}

/** Helpers shared by the test files, bound to one running Worker. */
function clientFor(base) {
  const cookieFrom = (response) => response.headers.get('set-cookie').split(';')[0];

  async function createRoom(body) {
    const response = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status !== 201) throw new Error(`create returned ${response.status}`);
    const { id } = await response.json();
    return { id, cookie: cookieFrom(response) };
  }

  async function joinRoom(id) {
    const response = await fetch(`${base}/api/rooms/${id}/join`, { method: 'POST' });
    if (response.status !== 200) throw new Error(`join returned ${response.status}`);
    return cookieFrom(response);
  }

  // Queues messages from the moment the socket opens, so nothing arrives before a test is listening.
  function openSocket(id, cookie, headers = {}) {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/rooms/${id}/ws`, { headers: { cookie, ...headers } });
    const inbox = [];
    const waiters = [];
    ws.on('message', (data) => {
      if (String(data) === 'pong') return;
      const message = JSON.parse(data);
      const waiter = waiters.findIndex((w) => w.type === message.t);
      if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(message);
      else inbox.push(message);
    });
    ws.on('error', () => {});
    ws.next = (type) => {
      const queued = inbox.findIndex((m) => m.t === type);
      if (queued >= 0) return Promise.resolve(inbox.splice(queued, 1)[0]);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    };
    ws.closed = new Promise((resolve) => ws.on('close', resolve));
    return ws;
  }

  function upgradeStatus(id, cookie, headers = {}) {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/api/rooms/${id}/ws`, { headers: { cookie, ...headers } });
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode);
        ws.terminate();
      });
      ws.on('open', () => {
        resolve(101);
        ws.close();
      });
      ws.on('error', () => {});
    });
  }

  /** Asks for an upload link. */
  const reserve = (id, cookie, name, size) =>
    fetch(`${base}/api/rooms/${id}/uploads`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, size }),
    });

  /**
   * Uploads the way the page does: reserve, send, complete. Returns the response of the first step that failed,
   * or of the final step.
   */
  async function upload(id, cookie, name, body) {
    const bytes = typeof body === 'string' ? Buffer.from(body) : body;
    const slot = await reserve(id, cookie, name, bytes.length);
    if (slot.status !== 201) return slot;
    const { id: fileId, url } = await slot.json();
    const sent = await fetch(new URL(url, base), { method: 'PUT', headers: { cookie }, body: bytes });
    if (!sent.ok) return sent;
    return fetch(`${base}/api/rooms/${id}/uploads/${fileId}/complete`, { method: 'POST', headers: { cookie } });
  }

  const remove = (id, cookie, fileId = '') =>
    fetch(`${base}/api/rooms/${id}/files${fileId ? `/${fileId}` : ''}`, { method: 'DELETE', headers: { cookie } });

  return { cookieFrom, createRoom, joinRoom, openSocket, upgradeStatus, reserve, upload, remove };
}

/** Waits until `check` returns something truthy, or fails after `timeout` ms. */
async function eventually(check, { timeout = 5000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition.');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

module.exports = { startRoomShare, clientFor, eventually };
