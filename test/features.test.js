'use strict';

// Names, join and leave notices, who is typing or uploading, who sent a file, locking a room, and its timer.

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const WebSocket = require('ws');
const { startRoomShare, clientFor, eventually } = require('./harness.js');

let rs;
let base;
let client;
const opened = [];

before(async () => {
  rs = await startRoomShare({
    vars: {
      EMPTY_ROOM_GRACE_MS: '5000',
      ROOM_ATTEMPTS_PER_MINUTE: '1000',
      EDIT_WINDOW_MS: '600000', // Keeps the per-connection counters from resetting in the middle of a test.
    },
  });
  base = rs.base;
  client = clientFor(base);
});

after(async () => {
  for (const ws of opened) ws.terminate(); // Even when a test failed before closing its connections.
  await rs.close();
});

function openSocket(id, cookie, name) {
  const query = name === undefined ? '' : `?name=${encodeURIComponent(name)}`;
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/rooms/${id}/ws${query}`, { headers: { cookie } });
  opened.push(ws);
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
  ws.has = (type) => inbox.some((m) => m.t === type);
  ws.act = (message) => ws.send(JSON.stringify(message));
  ws.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  return ws;
}

async function pair() {
  const { id, cookie } = await client.createRoom();
  const owner = openSocket(id, cookie, 'Windows PC · Chrome');
  const ownerInit = await owner.next('init');
  const guestCookie = await client.joinRoom(id);
  const guest = openSocket(id, guestCookie, 'iPhone · Safari');
  const guestInit = await guest.next('init');
  return { id, cookie, guestCookie, owner, guest, ownerInit, guestInit };
}

const closeAll = (...sockets) => sockets.forEach((ws) => ws.close());

/* ---------- Names and notices ---------- */

test('the name a page connects with is used, and everyone sees who is here', async () => {
  const { owner, guest, ownerInit, guestInit } = await pair();
  assert.equal(ownerInit.you, 'Windows PC · Chrome');
  assert.match(ownerInit.me, /^[a-f0-9]{8}$/);
  assert.notEqual(ownerInit.me, guestInit.me);
  assert.deepEqual(guestInit.people.map((p) => p.name).sort(), ['Windows PC · Chrome', 'iPhone · Safari'].sort());
  closeAll(owner, guest);
});

test('the others are told when someone joins and leaves, by name', async () => {
  const { owner, guest, guestInit } = await pair();
  const joined = await owner.next('joined');
  assert.deepEqual([joined.pid, joined.name], [guestInit.me, 'iPhone · Safari']);
  assert.equal(guest.has('joined'), false, 'nobody is told about their own arrival');

  guest.close();
  const left = await owner.next('left');
  assert.deepEqual([left.pid, left.name], [guestInit.me, 'iPhone · Safari']);
  owner.close();
});

test('joining and leaving again is announced every time', async () => {
  const { id, owner, guest, guestCookie } = await pair();
  await owner.next('joined');
  guest.close();
  await owner.next('left');
  for (let round = 0; round < 2; round += 1) {
    const again = openSocket(id, guestCookie, 'iPhone · Safari');
    await again.next('init');
    assert.equal((await owner.next('joined')).name, 'iPhone · Safari', `join ${round + 2}`);
    again.close();
    assert.equal((await owner.next('left')).name, 'iPhone · Safari', `leave ${round + 2}`);
  }
  owner.close();
});

test('a second tab of someone already here is not a new arrival, and closing it is not a departure', async () => {
  const { id, owner, guest, guestCookie } = await pair();
  await owner.next('joined');
  const secondTab = openSocket(id, guestCookie, 'iPhone · Safari');
  await secondTab.next('init');
  secondTab.close();
  await secondTab.closed;
  await sleep(200);
  assert.equal(owner.has('joined'), false);
  assert.equal(owner.has('left'), false);
  closeAll(owner, guest);
});

test('names are cleaned: invisible characters removed, spaces collapsed, at most 40 characters', async () => {
  const { id, cookie } = await client.createRoom();
  const zeroWidth = String.fromCharCode(0x200b);
  const ws = openSocket(id, cookie, `  My${zeroWidth}   laptop\n${'x'.repeat(80)}`);
  const init = await ws.next('init');
  assert.equal(init.you, `My laptop ${'x'.repeat(30)}`);
  ws.close();

  const blank = openSocket(id, cookie, '   ');
  assert.equal((await blank.next('init')).you, init.you, 'an empty name keeps the one already there');
  blank.close();
});

test('changing your name tells everyone, and survives the room going to sleep', async () => {
  const { id, owner, guest, guestInit } = await pair();
  guest.act({ t: 'name', name: "Asha's phone" });
  const renamed = await owner.next('renamed');
  assert.deepEqual([renamed.pid, renamed.name], [guestInit.me, "Asha's phone"]);

  await rs.worker.evictDurableObject('ROOM', { name: id, webSockets: 'hibernate' });
  guest.act({ t: 'typing' });
  assert.equal((await owner.next('typing')).name, "Asha's phone");
  closeAll(owner, guest);
});

/* ---------- Who is doing what ---------- */

test('typing is passed on to the others, not back to the typist', async () => {
  const { owner, guest, ownerInit } = await pair();
  owner.act({ t: 'typing' });
  const typing = await guest.next('typing');
  assert.deepEqual([typing.pid, typing.name], [ownerInit.me, 'Windows PC · Chrome']);
  await sleep(150);
  assert.equal(owner.has('typing'), false);
  closeAll(owner, guest);
});

test('upload progress is passed on, and bad progress messages are ignored', async () => {
  const { owner, guest, guestInit } = await pair();
  guest.act({ t: 'uploading', key: 'abc123', file: 'holiday/../photo.jpg', size: 2048, pct: 41.6 });
  const progress = await owner.next('uploading');
  assert.deepEqual(
    [progress.pid, progress.name, progress.key, progress.file, progress.size, progress.pct],
    [guestInit.me, 'iPhone · Safari', 'abc123', 'holiday_.._photo.jpg', 2048, 42],
  );
  guest.act({ t: 'uploading', key: 'abc123', pct: 250 });
  guest.act({ t: 'uploading', key: '../../etc', pct: 10 });
  guest.act({ t: 'uploading', key: 'abc123', done: true });
  const done = await owner.next('uploading');
  assert.deepEqual([done.key, done.done], ['abc123', true], 'the two bad messages never arrived');
  closeAll(owner, guest);
});

test('each file says who sent it', async () => {
  const { id, guestCookie, owner, guest, guestInit } = await pair();
  assert.equal((await client.upload(id, guestCookie, 'notes.txt', 'hi')).status, 201);
  const { file } = await owner.next('file');
  assert.deepEqual([file.from, file.fromId], ['iPhone · Safari', guestInit.me]);
  closeAll(owner, guest);
});

test('too many live messages in a short time are dropped', async () => {
  const { owner, guest } = await pair();
  for (let i = 0; i < 80; i += 1) guest.act({ t: 'typing' });
  await sleep(500);
  let received = 0;
  while (owner.has('typing')) {
    await owner.next('typing');
    received += 1;
  }
  assert.equal(received, 60);
  closeAll(owner, guest);
});

/* ---------- Locking ---------- */

test('the creator can lock the room: newcomers are refused, people already in can come back', async () => {
  const { id, guestCookie, owner, guest, ownerInit, guestInit } = await pair();
  assert.equal(ownerInit.owner, true);
  assert.equal(guestInit.owner, false);
  assert.equal(guestInit.ownerId, ownerInit.me);

  owner.act({ t: 'lock', closed: true });
  const closed = await guest.next('closed');
  assert.deepEqual([closed.closed, closed.by], [true, 'Windows PC · Chrome']);

  const stranger = await fetch(`${base}/api/rooms/${id}/join`, { method: 'POST' });
  assert.equal(stranger.status, 403);
  assert.match((await stranger.json()).error, /locked/);
  assert.equal((await fetch(`${base}/api/rooms/${id}/join`, { method: 'POST', headers: { cookie: guestCookie } })).status, 200);

  owner.act({ t: 'lock', closed: false });
  assert.equal((await guest.next('closed')).closed, false);
  assert.equal((await fetch(`${base}/api/rooms/${id}/join`, { method: 'POST' })).status, 200);
  closeAll(owner, guest);
});

test('only the creator can lock the room or set a timer', async () => {
  const { id, owner, guest } = await pair();
  guest.act({ t: 'lock', closed: true });
  assert.match((await guest.next('notice')).text, /created the room can lock/);
  guest.act({ t: 'timer', seconds: 60 });
  assert.match((await guest.next('notice')).text, /created the room can set a timer/);
  const room = await rs.room(id);
  assert.equal(room.closed, false);
  assert.equal(room.expiresAt, null);
  closeAll(owner, guest);
});

test('a new connection learns that the room is locked', async () => {
  const { id, cookie, owner, guest } = await pair();
  owner.act({ t: 'lock', closed: true });
  await guest.next('closed');
  const tab = openSocket(id, cookie);
  assert.equal((await tab.next('init')).closed, true);
  closeAll(owner, guest, tab);
});

/* ---------- Self-destruct timer ---------- */

test('when the timer runs out, everyone is told and the room, its text and files are deleted', async () => {
  const { id, guestCookie, owner, guest } = await pair();
  assert.equal((await client.upload(id, guestCookie, 'a.txt', 'data')).status, 201);
  assert.equal((await rs.objects(id)).length, 1);

  owner.act({ t: 'timer', seconds: 1 });
  const timer = await guest.next('timer');
  assert.ok(timer.expiresIn === 1000 && timer.expiresAt > Date.now() - 5000);

  const ended = await guest.next('ended');
  assert.equal(ended.reason, 'timer');
  assert.equal(await guest.closed, 4001);
  await eventually(async () => !(await rs.room(id)).exists);
  assert.deepEqual(await rs.objects(id), []);
  assert.equal((await fetch(`${base}/api/rooms/${id}/join`, { method: 'POST', headers: { cookie: guestCookie } })).status, 404);
  await owner.closed;
});

test('the timer can be turned off, and a new connection sees the time left', async () => {
  const { id, cookie, owner, guest } = await pair();
  owner.act({ t: 'timer', seconds: 600 });
  await guest.next('timer');
  const tab = openSocket(id, cookie);
  const { expiresIn } = await tab.next('init');
  assert.ok(expiresIn > 590_000 && expiresIn <= 600_000, String(expiresIn));

  owner.act({ t: 'timer', seconds: 0 });
  assert.equal((await guest.next('timer')).expiresIn, null);
  assert.equal((await rs.room(id)).expiresAt, null);

  owner.act({ t: 'timer', seconds: 999_999 });
  owner.act({ t: 'timer', seconds: 1.5 });
  owner.act({ t: 'timer', seconds: -1 });
  await sleep(200);
  assert.equal((await rs.room(id)).expiresAt, null, 'impossible timers are ignored');
  closeAll(owner, guest, tab);
});

/* ---------- Files the page loads only when needed ---------- */

test('the zip library, the QR reader and the name helper are served as scripts', async () => {
  for (const url of ['/vendor/fflate.js', '/vendor/jsQR.js', '/device.js']) {
    const response = await fetch(base + url);
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get('content-type'), /javascript/, url);
  }
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<script src="\/device\.js\?v=[a-f0-9]+" defer><\/script>/);
});
