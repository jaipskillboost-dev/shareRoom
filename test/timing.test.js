'use strict';

// Room cap, dropping silent connections, and giving back space from abandoned uploads.
// These need short timers and a small room cap, so they run against their own Worker.

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const { startRoomShare, clientFor, eventually } = require('./harness.js');

let rs;
let base;
let client;

before(async () => {
  rs = await startRoomShare({
    vars: {
      MAX_ROOMS: '3',
      EMPTY_ROOM_GRACE_MS: '300',
      ROOM_ATTEMPTS_PER_MINUTE: '1000',
      STALE_SOCKET_MS: '600',
      PRESENCE_CHECK_MS: '200',
      UPLOAD_SLOT_MS: '400',
    },
  });
  base = rs.base;
  client = clientFor(base);
});

after(() => rs.close());

const create = () => fetch(`${base}/api/rooms`, { method: 'POST' });

test('new rooms are refused when the site is full, and allowed again once rooms close', async () => {
  for (let i = 0; i < 3; i += 1) assert.equal((await create()).status, 201);
  const full = await create();
  assert.equal(full.status, 503);
  assert.match((await full.json()).error, /busy/);

  // Nobody joined those rooms, so they close after the grace period, which makes space.
  await eventually(async () => (await rs.gate()).rooms === 0);
  assert.equal((await create()).status, 201);
  await eventually(async () => (await rs.gate()).rooms === 0);
});

test('a connection that stops pinging is dropped, and the others are told', async () => {
  const { id, cookie } = await client.createRoom();
  const quiet = client.openSocket(id, cookie);
  await quiet.next('init');

  const active = client.openSocket(id, await client.joinRoom(id));
  await active.next('init');
  const pinger = setInterval(() => active.send('ping'), 100);
  try {
    await active.next('presence'); // Two people.
    const after = await active.next('presence');
    assert.equal(after.users, 1, 'the silent one is gone');
    await quiet.closed;
  } finally {
    clearInterval(pinger);
    active.close();
  }
  await eventually(async () => !(await rs.room(id)).exists);
});

test('space reserved for an upload that never finishes is given back', async () => {
  const { id, cookie } = await client.createRoom();
  const ws = client.openSocket(id, cookie);
  await ws.next('init');
  const pinger = setInterval(() => ws.send('ping'), 100);
  try {
    const slot = await client.reserve(id, cookie, 'abandoned.bin', 5000);
    assert.equal(slot.status, 201);
    const { id: fileId } = await slot.json();
    // Something arrived in storage, but the page never said the upload finished.
    await rs.env.FILES.put(`${id}/${fileId}`, Buffer.alloc(5000));
    assert.equal((await rs.room(id)).bytes, 5000);
    assert.equal((await rs.gate()).bytes, 5000);

    await eventually(async () => (await rs.room(id)).uploads === 0);
    assert.equal((await rs.room(id)).bytes, 0);
    assert.equal((await rs.gate()).bytes, 0);
    assert.deepEqual(await rs.objects(id), []);

    const late = await fetch(`${base}/api/rooms/${id}/uploads/${fileId}/complete`, { method: 'POST', headers: { cookie } });
    assert.equal(late.status, 404);
  } finally {
    clearInterval(pinger);
    ws.close();
  }
  await sleep(10);
});

test('closing a room gives all of its space back to the site', async () => {
  const { id, cookie } = await client.createRoom();
  const ws = client.openSocket(id, cookie);
  await ws.next('init');
  assert.equal((await client.upload(id, cookie, 'a.txt', 'x'.repeat(1234))).status, 201);
  assert.equal((await rs.gate()).bytes, 1234);
  ws.close();
  await eventually(async () => !(await rs.room(id)).exists);
  assert.deepEqual(await rs.gate(), { rooms: 0, bytes: 0 });
});
