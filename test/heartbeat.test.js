'use strict';

// A phone that loses signal or is locked never says goodbye. The heartbeat notices, and the others are told.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const WebSocket = require('ws');

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'roomshare-heartbeat-'));
process.env.HEARTBEAT_MS = '150';
process.env.EMPTY_ROOM_GRACE_MS = '5000';
process.env.ROOM_ATTEMPTS_PER_MINUTE = '1000';

const { server } = require('../server.js');

let base;
const opened = [];

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const ws of opened) ws.terminate();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(process.env.STORAGE_DIR, { recursive: true, force: true });
});

const cookieFrom = (response) => response.headers.get('set-cookie').split(';')[0];

function connect(id, cookie, name, options = {}) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/rooms/${id}/ws?name=${encodeURIComponent(name)}`, { headers: { cookie }, ...options });
  opened.push(ws);
  ws.messages = [];
  ws.on('message', (data) => ws.messages.push(JSON.parse(data)));
  ws.waitFor = (type, timeout = 3000) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const look = () => {
        const found = ws.messages.find((m) => m.t === type);
        if (found) return resolve(found);
        if (Date.now() - started > timeout) return reject(new Error(`no ${type} within ${timeout} ms`));
        setTimeout(look, 20);
      };
      look();
    });
  return ws;
}

test('someone whose connection goes silent is reported as having left', async () => {
  const created = await fetch(`${base}/api/rooms`, { method: 'POST' });
  const { id } = await created.json();
  const laptop = connect(id, cookieFrom(created), 'Windows PC · Chrome');
  await laptop.waitFor('init');

  const joined = await fetch(`${base}/api/rooms/${id}/join`, { method: 'POST' });
  // A phone that has gone quiet: it is connected, but no longer answers the server's pings.
  const phone = connect(id, cookieFrom(joined), 'iPhone · Safari', { autoPong: false });
  await phone.waitFor('init');
  await laptop.waitFor('joined');

  const startedAt = Date.now();
  const left = await laptop.waitFor('left');
  assert.equal(left.name, 'iPhone · Safari');
  assert.ok(Date.now() - startedAt < 1000, 'noticed within a couple of heartbeats');
  laptop.close();
});
