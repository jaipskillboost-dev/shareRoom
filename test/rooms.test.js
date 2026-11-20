'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const { startRoomShare, clientFor, eventually } = require('./harness.js');

const EDITS_PER_WINDOW = 50;
const MAX_TEXT_CHARS = 100_000;

let rs;
let base;
let createRoom, joinRoom, openSocket, upgradeStatus, reserve, upload, remove;

before(async () => {
  rs = await startRoomShare({
    vars: {
      EMPTY_ROOM_GRACE_MS: '200',
      MAX_FILE_BYTES: String(1024 * 1024),
      ROOM_ATTEMPTS_PER_MINUTE: '1000',
      EDITS_PER_WINDOW: String(EDITS_PER_WINDOW),
      EDIT_WINDOW_MS: '600000', // Keeps the edit counter from resetting in the middle of a test.
    },
  });
  base = rs.base;
  ({ createRoom, joinRoom, openSocket, upgradeStatus, reserve, upload, remove } = clientFor(base));
});

after(() => rs.close());

const roomGone = (id) => eventually(async () => !(await rs.room(id)).exists);

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
  assert.equal((await reserve(id, 'member=' + 'a'.repeat(48), 'x.txt', 1)).status, 403);
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
    { id: 'huge', base: 0, from: 0, to: 0, insert: 'x'.repeat(MAX_TEXT_CHARS + 1) },
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

  for (let i = 0; i <= EDITS_PER_WINDOW; i += 1) edit(alice, { id: `e${i}`, base: i, from: i, to: i, insert: 'x' });

  assert.equal((await alice.next('notice')).text, 'You are changing the text too quickly.');
  assert.equal((await alice.next('reject')).id, `e${EDITS_PER_WINDOW}`);
  for (const ws of [alice, bob]) ws.close();
});

test('the shared text and live connections survive the room being unloaded from memory', async () => {
  const { id, alice, bob, lateJoiner } = await joinedPair();
  edit(alice, { id: 'a1', base: 0, from: 0, to: 0, insert: 'kept while asleep' });
  await bob.next('text');
  await sleep(1300); // The text is saved at most once a second.

  await rs.worker.evictDurableObject('ROOM', { name: id, webSockets: 'hibernate' });

  edit(bob, { id: 'b1', base: 1, from: 0, to: 0, insert: '> ' }); // Wakes the room on the same connection.
  assert.equal((await alice.next('text')).id, 'a1');
  assert.equal((await alice.next('text')).id, 'b1');
  const { ws: carol, init } = await lateJoiner();
  assert.equal(init.text, '> kept while asleep');
  assert.equal(init.users, 3);
  for (const ws of [alice, bob, carol]) ws.close();
});

test('a "ping" from the page is answered with "pong"', async () => {
  const { id, cookie } = await createRoom();
  const ws = openSocket(id, cookie);
  await ws.next('init');
  const answer = new Promise((resolve) => ws.on('message', (data) => String(data) === 'pong' && resolve(true)));
  ws.send('ping');
  assert.equal(await answer, true);
  ws.close();
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

test('files over the limit are refused before anything is uploaded', async () => {
  const { id, cookie } = await createRoom();
  const ws = openSocket(id, cookie);
  await ws.next('init');

  const response = await reserve(id, cookie, 'big.bin', 1024 * 1024 + 1);
  assert.equal(response.status, 413);
  assert.deepEqual(await rs.objects(id), []);
  assert.equal((await rs.room(id)).bytes, 0);
  ws.close();
});

test('an upload must match the size it reserved', async () => {
  const { id, cookie } = await createRoom();
  const ws = openSocket(id, cookie); // Someone is inside, so the room stays open.
  await ws.next('init');
  const slot = await (await reserve(id, cookie, 'a.txt', 10)).json();
  const wrongSize = await fetch(new URL(slot.url, base), { method: 'PUT', headers: { cookie }, body: 'too short' });
  assert.equal(wrongSize.status, 400);

  // Even if different bytes reach storage some other way, finishing the upload checks their size.
  await rs.env.FILES.put(`${id}/${slot.id}`, 'not ten bytes long');
  const complete = await fetch(`${base}/api/rooms/${id}/uploads/${slot.id}/complete`, { method: 'POST', headers: { cookie } });
  assert.equal(complete.status, 400);
  assert.deepEqual(await rs.objects(id), []);
  assert.equal((await rs.room(id)).bytes, 0);
  ws.close();
});

test('everything is deleted once the last person leaves', async () => {
  const { id, cookie } = await createRoom();
  const alice = openSocket(id, cookie);
  await alice.next('init');
  edit(alice, { id: 'a1', base: 0, from: 0, to: 0, insert: 'gone soon' });
  await alice.next('text');
  assert.equal((await upload(id, cookie, 'a.txt', 'data')).status, 201);
  assert.equal((await rs.objects(id)).length, 1);

  alice.close();
  await alice.closed;
  await roomGone(id);

  assert.deepEqual(await rs.objects(id), []);
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

  assert.equal((await rs.room(id)).exists, true);
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
  assert.equal((await rs.room(id)).exists, true);
  second.close();
});

test('a room nobody ever connects to is cleaned up', async () => {
  const { id } = await createRoom();
  await roomGone(id);
});

test('a room closing mid-upload discards the file once it arrives', async () => {
  const { id, cookie } = await createRoom();
  const ws = openSocket(id, cookie);
  await ws.next('init');
  const slot = await (await reserve(id, cookie, 'slow.bin', 2048)).json();

  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(new Uint8Array(1024));
      await sleep(800);
      controller.enqueue(new Uint8Array(1024));
      controller.close();
    },
  });
  const pending = fetch(new URL(slot.url, base), {
    method: 'PUT',
    headers: { cookie, 'content-length': '2048' },
    body,
    duplex: 'half',
  }).catch(() => null);

  await sleep(100);
  ws.close();
  await ws.closed;
  await roomGone(id);

  const finished = await pending;
  assert.notEqual(finished?.status, 200);
  assert.deepEqual(await rs.objects(id), []);
});

test('pages carry the security policy, and versioned assets are cached for a long time', async () => {
  const page = await fetch(`${base}/r/abcdefgh`);
  assert.equal(page.status, 200);
  assert.ok(page.headers.get('content-security-policy'));
  const html = await page.text();
  const script = html.match(/src="(\/app\.js\?v=[a-f0-9]+)"/)[1];

  const asset = await fetch(base + script);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control'), /immutable/);
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
  assert.equal((await rs.room(id)).exists, true);
  other.close();
});

test("the client address is Cloudflare's, never one the visitor made up", async () => {
  const { clientIp } = await import('../src/shared.js');
  const request = (headers) => new Request('https://roomshare.example/', { headers });
  assert.equal(clientIp(request({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '6.6.6.6' })), '203.0.113.7');
  assert.equal(clientIp(request({ 'x-forwarded-for': '6.6.6.6' })), 'unknown');
});

test('deleting one file removes it for everyone and frees its space', async () => {
  const { id, cookie } = await createRoom();
  const alice = openSocket(id, cookie);
  await alice.next('init');
  const bobCookie = await joinRoom(id);
  const bob = openSocket(id, bobCookie);
  await bob.next('init');

  const keep = await (await upload(id, cookie, 'keep.txt', 'keep me')).json();
  const drop = await (await upload(id, cookie, 'drop.txt', 'drop me!!')).json();
  assert.equal((await rs.objects(id)).length, 2);

  assert.equal((await remove(id, bobCookie, drop.id)).status, 200);

  assert.equal((await alice.next('fileRemoved')).id, drop.id);
  assert.equal((await bob.next('fileRemoved')).id, drop.id);
  assert.deepEqual(await rs.objects(id), [keep.id]);
  assert.equal((await rs.room(id)).bytes, keep.size);
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
  assert.deepEqual(await rs.objects(id), []);
  const room = await rs.room(id);
  assert.equal(room.files, 0);
  assert.equal(room.bytes, 0);

  alice.close();
  bob.close();
});

test('a file can be deleted while someone is downloading it', async () => {
  const { id, cookie } = await createRoom();
  const ws = openSocket(id, cookie);
  await ws.next('init');
  const file = await (await upload(id, cookie, 'big.bin', Buffer.alloc(900_000, 1))).json();

  const response = await fetch(`${base}/api/rooms/${id}/files/${file.id}`, { headers: { cookie } });
  const reader = response.body.getReader();
  await reader.read(); // The download is under way.

  assert.equal((await remove(id, cookie, file.id)).status, 200);
  assert.deepEqual(await rs.objects(id), []);
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
  assert.equal((await rs.objects(id)).length, 1);
  ws.close();
});
