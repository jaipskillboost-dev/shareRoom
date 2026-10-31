'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const WebSocket = require('ws');

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'roomshare-test-'));
process.env.EMPTY_ROOM_GRACE_MS = '200';
process.env.MAX_FILE_BYTES = String(1024 * 1024);
process.env.ROOM_ATTEMPTS_PER_MINUTE = '1000';
process.env.HEARTBEAT_MS = '600000'; // Keeps the per-heartbeat edit counter from resetting in the middle of a test.

const { server, rooms, storageRoot, config, clientIp } = require('../server.js');

let base;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(process.env.STORAGE_DIR, { recursive: true, force: true });
});

const cookieFrom = (response) => response.headers.get('set-cookie').split(';')[0];

async function createRoom() {
  const response = await fetch(`${base}/api/rooms`, { method: 'POST' });
  assert.equal(response.status, 201);
  const { id } = await response.json();
  return { id, cookie: cookieFrom(response) };
}

async function joinRoom(id) {
  const response = await fetch(`${base}/api/rooms/${id}/join`, { method: 'POST' });
  assert.equal(response.status, 200);
  return cookieFrom(response);
}

// Queues messages from the moment the socket opens, so nothing arrives before a test is listening.
function openSocket(id, cookie, headers = {}) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/rooms/${id}/ws`, { headers: { cookie, ...headers } });
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    const message = JSON.parse(data);
    const waiter = waiters.findIndex((w) => w.type === message.t);
    if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(message);
    else inbox.push(message);
  });
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

const upload = (id, cookie, name, body) =>
  fetch(`${base}/api/rooms/${id}/files?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { cookie },
    body,
  });

const roomFiles = (id) => {
  const dir = path.join(storageRoot, id);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : null;
};

test('room IDs are random and unique', async () => {
  const ids = new Set();
  for (let i = 0; i < 20; i += 1) ids.add((await createRoom()).id);
  assert.equal(ids.size, 20);
  for (const id of ids) assert.match(id, /^[a-z0-9]{8}$/);
});

test('joining an unknown room fails', async () => {
  const response = await fetch(`${base}/api/rooms/abcdefgh/join`, { method: 'POST' });
  assert.equal(response.status, 404);
});

test('people who have not joined cannot reach files or the live room', async () => {
  const { id, cookie } = await createRoom();
  const ws = openSocket(id, cookie);
  await ws.next('init');

  const uploaded = await (await upload(id, cookie, 'secret.txt', 'secret')).json();
  const other = await createRoom();

  const download = await fetch(`${base}/api/rooms/${id}/files/${uploaded.id}`);
  assert.equal(download.status, 403);
  const wrongRoom = await fetch(`${base}/api/rooms/${id}/files/${uploaded.id}`, { headers: { cookie: other.cookie } });
  assert.equal(wrongRoom.status, 403);
  assert.equal((await upload(id, 'member=' + 'a'.repeat(48), 'x.txt', 'x')).status, 403);
  assert.equal(await upgradeStatus(id, other.cookie), 403);
  ws.close();
});

test('a websocket from another site is refused even with a member cookie', async () => {
  const { id, cookie } = await createRoom();
  assert.equal(await upgradeStatus(id, cookie, { origin: 'https://evil.example' }), 403);
});

const edit = (ws, op) => ws.send(JSON.stringify({ op }));

async function joinedPair() {
  const { id, cookie } = await createRoom();
  const alice = openSocket(id, cookie);
  await alice.next('init');
  const bob = openSocket(id, await joinRoom(id));
  await bob.next('init');
  const lateJoiner = async () => {
    const ws = openSocket(id, await joinRoom(id));
    return { ws, init: await ws.next('init') };
  };
  return { id, cookie, alice, bob, lateJoiner };
}

test('shared text reaches everyone, and late joiners see it', async () => {
  const { alice, bob, lateJoiner } = await joinedPair();

  edit(alice, { id: 'a1', base: 0, from: 0, to: 0, insert: 'hello' });
  const seen = await bob.next('text');
  assert.deepEqual([seen.v, seen.id, seen.from, seen.to, seen.insert], [1, 'a1', 0, 0, 'hello']);
  assert.equal((await alice.next('text')).id, 'a1'); // The sender gets its own change back as the answer.

  edit(bob, { id: 'b1', base: 1, from: 5, to: 5, insert: ' world' });
  assert.equal((await alice.next('text')).insert, ' world');

  const { ws: carol, init } = await lateJoiner();
  assert.equal(init.text, 'hello world');
  assert.equal(init.v, 2);
  assert.equal(init.users, 3);

  for (const ws of [alice, bob, carol]) ws.close();
});

test('changes made at the same moment are both kept, in the same order for everyone', async () => {
  const { alice, bob, lateJoiner } = await joinedPair();

  edit(alice, { id: 'a1', base: 0, from: 0, to: 0, insert: 'AAA' });
  edit(bob, { id: 'b1', base: 0, from: 0, to: 0, insert: 'BBB' });
  for (const ws of [alice, bob]) {
    await ws.next('text');
    assert.equal((await ws.next('text')).v, 2);
  }

  const { ws: carol, init } = await lateJoiner();
  assert.match(init.text, /^(AAABBB|BBBAAA)$/);
  for (const ws of [alice, bob, carol]) ws.close();
});

test('a change that collides with an earlier one is refused and leaves the text alone', async () => {
  const { alice, bob, lateJoiner } = await joinedPair();

  edit(alice, { id: 'a1', base: 0, from: 0, to: 0, insert: 'hello world' });
  await bob.next('text');
  edit(alice, { id: 'a2', base: 1, from: 0, to: 5, insert: 'HOWDY' });
  await bob.next('text');

  edit(bob, { id: 'b2', base: 1, from: 0, to: 5, insert: 'hi' }); // Made before bob saw the "HOWDY" change.
  assert.equal((await bob.next('reject')).id, 'b2');

  const { ws: carol, init } = await lateJoiner();
  assert.equal(init.text, 'HOWDY world');
  for (const ws of [alice, bob, carol]) ws.close();
});

test('malformed and oversized changes are refused', async () => {
  const { alice, bob, lateJoiner } = await joinedPair();

  const bad = [
    { id: 'past-end', base: 0, from: 5, to: 9, insert: 'x' },
    { id: 'backwards', base: 0, from: 3, to: 1, insert: 'x' },
    { id: 'not-text', base: 0, from: 0, to: 0, insert: 42 },
    { id: 'fractional', base: 0, from: 0.5, to: 1, insert: 'x' },
    { id: 'future', base: 7, from: 0, to: 0, insert: 'x' },
    { id: 'huge', base: 0, from: 0, to: 0, insert: 'x'.repeat(config.maxTextChars + 1) },
  ];
  for (const op of bad) {
    edit(alice, op);
    assert.equal((await alice.next('reject')).id, op.id, op.id);
  }
  alice.send('not json');
  alice.send(JSON.stringify({ op: { id: 7 } }));
  alice.send(JSON.stringify({ nothing: true }));

  const { ws: carol, init } = await lateJoiner();
  assert.equal(init.text, '');
  assert.equal(init.v, 0);
  for (const ws of [alice, bob, carol]) ws.close();
});

test('the text can be cleared, and the cleared state is what later joiners see', async () => {
  const { alice, bob, lateJoiner } = await joinedPair();

  edit(alice, { id: 'a1', base: 0, from: 0, to: 0, insert: 'draft' });
  await bob.next('text');
  edit(bob, { id: 'b1', base: 1, from: 0, to: 5, insert: '' });
  assert.equal((await alice.next('text')).id, 'a1');
  assert.deepEqual(
    (({ from, to, insert }) => [from, to, insert])(await alice.next('text')),
    [0, 5, ''],
  );

  const { ws: carol, init } = await lateJoiner();
  assert.equal(init.text, '');
  for (const ws of [alice, bob, carol]) ws.close();
});

test('too many changes in a short time are refused and the sender is told', async () => {
  const { alice, bob } = await joinedPair();

  const limit = config.editsPerHeartbeat;
  for (let i = 0; i <= limit; i += 1) edit(alice, { id: `e${i}`, base: i, from: i, to: i, insert: 'x' });

  assert.equal((await alice.next('notice')).text, 'You are changing the text too quickly.');
  assert.equal((await alice.next('reject')).id, `e${limit}`);
  for (const ws of [alice, bob]) ws.close();
});

test('a file uploaded by one member downloads intact for another', async () => {
  const { id, cookie } = await createRoom();
  const alice = openSocket(id, cookie);
  await alice.next('init');
  const bobCookie = await joinRoom(id);
  const bob = openSocket(id, bobCookie);
  await bob.next('init');

  const body = Buffer.from(Array.from({ length: 50_000 }, (_, i) => i % 251));
  const response = await upload(id, cookie, 'रिपोर्ट (final).pdf', body);
  assert.equal(response.status, 201);

  const { file } = await bob.next('file');
  assert.equal(file.name, 'रिपोर्ट (final).pdf');
  assert.equal(file.size, body.length);

  const download = await fetch(`${base}/api/rooms/${id}/files/${file.id}`, { headers: { cookie: bobCookie } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), body);

  alice.close();
  bob.close();
});

test('files over the limit are refused and leave nothing on disk', async () => {
  const { id, cookie } = await createRoom();
  const ws = openSocket(id, cookie);
  await ws.next('init');

  const response = await upload(id, cookie, 'big.bin', Buffer.alloc(1024 * 1024 + 1));
  assert.equal(response.status, 413);
  assert.deepEqual(roomFiles(id), []);
  assert.equal(rooms.get(id).bytes, 0);
  ws.close();
});

test('everything is deleted once the last person leaves', async () => {
  const { id, cookie } = await createRoom();
  const alice = openSocket(id, cookie);
  await alice.next('init');
  edit(alice, { id: 'a1', base: 0, from: 0, to: 0, insert: 'gone soon' });
  await alice.next('text');
  assert.equal((await upload(id, cookie, 'a.txt', 'data')).status, 201);
  assert.equal(roomFiles(id).length, 1);

  alice.close();
  await alice.closed;
  await sleep(400);

  assert.equal(rooms.has(id), false);
  assert.equal(roomFiles(id), null);
  const rejoin = await fetch(`${base}/api/rooms/${id}/join`, { method: 'POST', headers: { cookie } });
  assert.equal(rejoin.status, 404);
});

test('the room survives while one person remains', async () => {
  const { id, cookie } = await createRoom();
  const alice = openSocket(id, cookie);
  await alice.next('init');
  const bob = openSocket(id, await joinRoom(id));
  await bob.next('init');

  bob.close();
  await bob.closed;
  await sleep(400);

  assert.equal(rooms.has(id), true);
  alice.close();
});

test('reconnecting within the grace period keeps the room', async () => {
  const { id, cookie } = await createRoom();
  const first = openSocket(id, cookie);
  await first.next('init');
  edit(first, { id: 'f1', base: 0, from: 0, to: 0, insert: 'still here' });
  await first.next('text');

  first.close();
  await first.closed;
  await sleep(50);

  const second = openSocket(id, cookie);
  const init = await second.next('init');
  assert.equal(init.text, 'still here');
  await sleep(300);
  assert.equal(rooms.has(id), true);
  second.close();
});

test('a room nobody ever connects to is cleaned up', async () => {
  const { id } = await createRoom();
  await sleep(400);
  assert.equal(rooms.has(id), false);
});

test('a room closing mid-upload stops the upload and removes the partial file', async () => {
  const { id, cookie } = await createRoom();
  const ws = openSocket(id, cookie);
  await ws.next('init');

  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(new Uint8Array(1024));
      await sleep(600);
      controller.close();
    },
  });
  const pending = fetch(`${base}/api/rooms/${id}/files?name=slow.bin`, {
    method: 'POST',
    headers: { cookie, 'content-length': '2048' },
    body,
    duplex: 'half',
  }).catch(() => null);

  await sleep(100);
  ws.close();
  await ws.closed;
  await sleep(400);

  assert.equal(rooms.has(id), false);
  assert.equal(roomFiles(id), null);
  await pending;
});

test('pages and assets are served compressed with long-lived caching', async () => {
  const page = await fetch(`${base}/r/abcdefgh`, { headers: { 'accept-encoding': 'br' } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-encoding'), 'br');
  const html = await page.text();
  const script = html.match(/src="(\/app\.js\?v=[a-f0-9]+)"/)[1];

  const asset = await fetch(base + script, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(asset.headers.get('content-encoding'), 'gzip');
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assert.ok(page.headers.get('content-security-policy'));
});

test('several tabs from one browser count as one person, and the room needs only one to stay alive', async () => {
  const { id, cookie } = await createRoom();
  const tabs = [openSocket(id, cookie), openSocket(id, cookie), openSocket(id, cookie)];
  for (const tab of tabs) assert.equal((await tab.next('init')).users, 1);

  const other = openSocket(id, await joinRoom(id));
  assert.equal((await other.next('init')).users, 2); // Four connections, two people.
  await other.next('presence');

  for (const [index, tab] of tabs.entries()) {
    tab.close();
    await tab.closed;
    assert.equal((await other.next('presence')).users, index < 2 ? 2 : 1, `after closing tab ${index + 1}`);
  }
  assert.equal(rooms.has(id), true);
  other.close();
});

test('behind proxies, the client address is the one our own proxy added, never one the visitor made up', () => {
  const request = (forwarded) => ({ headers: { 'x-forwarded-for': forwarded }, socket: { remoteAddress: '10.0.0.9' } });
  const original = config.trustProxyHops;
  try {
    config.trustProxyHops = 0; // No proxy: the header is just a visitor's claim.
    assert.equal(clientIp(request('6.6.6.6')), '10.0.0.9');

    config.trustProxyHops = 1;
    assert.equal(clientIp(request('203.0.113.7')), '203.0.113.7');
    assert.equal(clientIp(request('6.6.6.6, 203.0.113.7')), '203.0.113.7'); // A forged entry comes first.
    assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.9' } }), '10.0.0.9'); // Header missing.

    config.trustProxyHops = 2; // For example a CDN in front of the host's own proxy.
    assert.equal(clientIp(request('6.6.6.6, 203.0.113.7, 172.16.0.4')), '203.0.113.7');
    assert.equal(clientIp(request('172.16.0.4')), '10.0.0.9'); // Shorter than expected, so do not trust it.
  } finally {
    config.trustProxyHops = original;
  }
});

const remove = (id, cookie, fileId = '') =>
  fetch(`${base}/api/rooms/${id}/files${fileId ? `/${fileId}` : ''}`, { method: 'DELETE', headers: { cookie } });

test('deleting one file removes it for everyone and frees its space', async () => {
  const { id, cookie } = await createRoom();
  const alice = openSocket(id, cookie);
  await alice.next('init');
  const bobCookie = await joinRoom(id);
  const bob = openSocket(id, bobCookie);
  await bob.next('init');

  const keep = await (await upload(id, cookie, 'keep.txt', 'keep me')).json();
  const drop = await (await upload(id, cookie, 'drop.txt', 'drop me!!')).json();
  assert.equal(roomFiles(id).length, 2);

  assert.equal((await remove(id, bobCookie, drop.id)).status, 200);

  assert.equal((await alice.next('fileRemoved')).id, drop.id);
  assert.equal((await bob.next('fileRemoved')).id, drop.id);
  assert.deepEqual(roomFiles(id), [keep.id]);
  assert.equal(rooms.get(id).bytes, keep.size);
  assert.equal((await fetch(`${base}/api/rooms/${id}/files/${drop.id}`, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(`${base}/api/rooms/${id}/files/${keep.id}`, { headers: { cookie } })).status, 200);
  assert.equal((await remove(id, cookie, drop.id)).status, 404);

  alice.close();
  bob.close();
});

test('delete all removes every file and tells everyone who did it', async () => {
  const { id, cookie } = await createRoom();
  const alice = openSocket(id, cookie);
  const { you } = await alice.next('init');
  const bob = openSocket(id, await joinRoom(id));
  await bob.next('init');

  await upload(id, cookie, 'one.txt', '1');
  await upload(id, cookie, 'two.txt', '22');
  await upload(id, cookie, 'three.txt', '333');

  assert.equal((await remove(id, cookie)).status, 200);

  assert.equal((await bob.next('filesCleared')).by, you);
  assert.deepEqual(roomFiles(id), []);
  assert.equal(rooms.get(id).files.size, 0);
  assert.equal(rooms.get(id).bytes, 0);

  alice.close();
  bob.close();
});

test('deleting a file that is being downloaded stops the download and still removes it', async () => {
  const { id, cookie } = await createRoom();
  const ws = openSocket(id, cookie);
  await ws.next('init');
  const file = await (await upload(id, cookie, 'big.bin', Buffer.alloc(900_000, 1))).json();

  const response = await fetch(`${base}/api/rooms/${id}/files/${file.id}`, { headers: { cookie } });
  const reader = response.body.getReader();
  await reader.read(); // The download is under way and holds the file open.

  assert.equal((await remove(id, cookie, file.id)).status, 200);
  assert.deepEqual(roomFiles(id), []);
  await reader.cancel().catch(() => {});
  ws.close();
});

test('people who have not joined cannot delete files', async () => {
  const { id, cookie } = await createRoom();
  const ws = openSocket(id, cookie);
  await ws.next('init');
  const file = await (await upload(id, cookie, 'mine.txt', 'mine')).json();
  const stranger = await createRoom();

  assert.equal((await remove(id, '', file.id)).status, 403);
  assert.equal((await remove(id, stranger.cookie, file.id)).status, 403);
  assert.equal((await remove(id, stranger.cookie)).status, 403);
  assert.equal(roomFiles(id).length, 1);
  ws.close();
});

