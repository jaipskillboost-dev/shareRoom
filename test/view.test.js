'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');

for (const name of ['PUBLIC_URL', 'RENDER_EXTERNAL_URL', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET']) delete process.env[name];
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'roomshare-view-'));
process.env.EMPTY_ROOM_GRACE_MS = '60000';
process.env.ROOM_ATTEMPTS_PER_MINUTE = '1000';

const { server, storageRoot } = require('../server.js');

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

async function newRoom() {
  const response = await fetch(`${base}/api/rooms`, { method: 'POST' });
  return { id: (await response.json()).id, cookie: response.headers.get('set-cookie').split(';')[0] };
}

async function addFile(room, name, body) {
  const response = await fetch(`${base}/api/rooms/${room.id}/files?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { cookie: room.cookie },
    body,
  });
  assert.equal(response.status, 201);
  return (await response.json()).id;
}

const view = (room, fileId, headers = {}, method = 'GET') =>
  fetch(`${base}/api/rooms/${room.id}/files/${fileId}/view`, { method, headers: { cookie: room.cookie, ...headers } });

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/* ---------- What gets shown, and as what ---------- */

test('an image is shown inline with a type from our list, ready for seeking', async () => {
  const room = await newRoom();
  const id = await addFile(room, 'photo.PNG', PNG_BYTES);
  const response = await view(room, id);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.match(response.headers.get('content-disposition'), /^inline; filename\*=UTF-8''photo\.PNG$/);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(Number(response.headers.get('content-length')), PNG_BYTES.length);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG_BYTES);
});

test('the type is decided by the file name, never by what is inside the upload', async () => {
  const room = await newRoom();
  const disguised = await addFile(room, 'holiday.png', '<html><script>alert(document.cookie)</script></html>');
  const response = await view(room, disguised);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', 'so the browser cannot decide it is a page');
});

test('HTML and scripts are only ever shown as plain text', async () => {
  const room = await newRoom();
  for (const name of ['page.html', 'script.js', 'index.htm', 'style.css', 'data.xml']) {
    const id = await addFile(room, name, '<script>alert(1)</script>');
    const response = await view(room, id);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8', name);
    assert.equal(await response.text(), '<script>alert(1)</script>', name);
  }
});

test('anything opened on its own is sandboxed: no scripts and no access to this site', async () => {
  const room = await newRoom();
  const svg = await addFile(room, 'logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const response = await view(room, svg);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /\bsandbox\b/);
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);

  for (const name of ['clip.mp4', 'song.mp3', 'notes.txt', 'photo.jpg']) {
    const id = await addFile(room, name, 'x');
    assert.match((await view(room, id)).headers.get('content-security-policy'), /\bsandbox\b/, name);
  }
});

test('a PDF is shown with its own type, and is not sandboxed because browsers cannot show PDFs inside a sandbox', async () => {
  const room = await newRoom();
  const id = await addFile(room, 'Notes.pdf', '%PDF-1.4 minimal');
  const response = await view(room, id);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'");
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('video and audio get the types browsers expect', async () => {
  const room = await newRoom();
  const expected = { 'a.mp4': 'video/mp4', 'a.webm': 'video/webm', 'a.mov': 'video/quicktime', 'a.mp3': 'audio/mpeg', 'a.wav': 'audio/wav', 'a.m4a': 'audio/mp4' };
  for (const [name, type] of Object.entries(expected)) {
    const id = await addFile(room, name, 'bytes');
    assert.equal((await view(room, id)).headers.get('content-type'), type, name);
  }
});

test('files that cannot be viewed are refused, and can still be downloaded as before', async () => {
  const room = await newRoom();
  for (const name of ['report.docx', 'budget.xlsx', 'bundle.zip', 'setup.exe', 'noextension']) {
    const id = await addFile(room, name, 'data');
    const response = await view(room, id);
    assert.equal(response.status, 415, name);
    assert.match((await response.json()).error, /Download it instead/);
  }

  const id = await addFile(room, 'photo.png', PNG_BYTES);
  const download = await fetch(`${base}/api/rooms/${room.id}/files/${id}`, { headers: { cookie: room.cookie } });
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
});

/* ---------- Range requests ---------- */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'; // 26 bytes: byte i is letter i.

test('a byte range returns just those bytes, with the headers browsers use for seeking', async () => {
  const room = await newRoom();
  const id = await addFile(room, 'clip.mp4', ALPHABET);

  const part = await view(room, id, { range: 'bytes=2-5' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 2-5/26');
  assert.equal(part.headers.get('content-length'), '4');
  assert.equal(await part.text(), 'cdef');

  assert.equal(await (await view(room, id, { range: 'bytes=20-' })).text(), 'uvwxyz', 'open-ended');
  assert.equal(await (await view(room, id, { range: 'bytes=-3' })).text(), 'xyz', 'the final bytes');
  assert.equal(await (await view(room, id, { range: 'bytes=0-0' })).text(), 'a', 'a single byte');

  const clamped = await view(room, id, { range: 'bytes=24-9999' });
  assert.equal(clamped.status, 206);
  assert.equal(clamped.headers.get('content-range'), 'bytes 24-25/26', 'an end past the file is cut to its end');
  assert.equal(await clamped.text(), 'yz');
});

test('impossible ranges are refused with the file size, and unusable ones are ignored', async () => {
  const room = await newRoom();
  const id = await addFile(room, 'clip.mp4', ALPHABET);

  for (const range of ['bytes=100-200', 'bytes=26-', 'bytes=9-3', 'bytes=-0']) {
    const response = await view(room, id, { range });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), 'bytes */26', range);
  }
  for (const range of ['bytes=a-b', 'items=0-5', 'bytes=0-1,5-6', 'bytes=-', 'garbage']) {
    const response = await view(room, id, { range });
    assert.equal(response.status, 200, `${range} is ignored and the whole file is sent`);
    assert.equal(await response.text(), ALPHABET);
  }
});

test('an empty file can be viewed, and a range on it is refused', async () => {
  const room = await newRoom();
  const id = await addFile(room, 'empty.txt', '');
  const whole = await view(room, id);
  assert.equal(whole.status, 200);
  assert.equal(await whole.text(), '');
  assert.equal((await view(room, id, { range: 'bytes=0-0' })).status, 416);
});

test('a HEAD request returns the headers and no body', async () => {
  const room = await newRoom();
  const id = await addFile(room, 'photo.png', PNG_BYTES);
  const response = await view(room, id, {}, 'HEAD');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-length'), String(PNG_BYTES.length));
  assert.equal((await response.text()).length, 0);
});

test('a large file can be read in pieces from the middle', async () => {
  const room = await newRoom();
  const body = Buffer.alloc(3_000_000);
  for (let i = 0; i < body.length; i += 1) body[i] = i % 251;
  const id = await addFile(room, 'big.webm', body);

  const response = await view(room, id, { range: 'bytes=1500000-1500999' });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), body.subarray(1_500_000, 1_501_000));
});

/* ---------- Who can look ---------- */

test('only people inside the room can view its files', async () => {
  const room = await newRoom();
  const stranger = await newRoom();
  const id = await addFile(room, 'photo.png', PNG_BYTES);

  const url = `${base}/api/rooms/${room.id}/files/${id}/view`;
  assert.equal((await fetch(url)).status, 403, 'no cookie');
  assert.equal((await fetch(url, { headers: { cookie: stranger.cookie } })).status, 403, "another room's cookie");
  assert.equal((await fetch(url, { headers: { cookie: 'member=' + 'a'.repeat(48) } })).status, 403, 'a made-up cookie');
  assert.equal((await view(room, id)).status, 200);
});

test('a deleted file can no longer be viewed, and the view address cannot be used to delete', async () => {
  const room = await newRoom();
  const id = await addFile(room, 'photo.png', PNG_BYTES);

  const wrongWay = await fetch(`${base}/api/rooms/${room.id}/files/${id}/view`, { method: 'DELETE', headers: { cookie: room.cookie } });
  assert.equal(wrongWay.status, 404);
  assert.equal((await view(room, id)).status, 200, 'it is still there');

  await fetch(`${base}/api/rooms/${room.id}/files/${id}`, { method: 'DELETE', headers: { cookie: room.cookie } });
  assert.equal((await view(room, id)).status, 404);
  assert.equal((await view(room, 'f'.repeat(32))).status, 404, 'an unknown file');
});

test('deleting a file that is being watched stops the stream and removes the file', async () => {
  const room = await newRoom();
  const id = await addFile(room, 'long.mp4', Buffer.alloc(1_500_000, 7));

  const response = await view(room, id);
  const reader = response.body.getReader();
  await reader.read(); // Playback is under way, so the file is held open.

  const removed = await fetch(`${base}/api/rooms/${room.id}/files/${id}`, { method: 'DELETE', headers: { cookie: room.cookie } });
  assert.equal(removed.status, 200);
  await sleep(100);
  assert.deepEqual(fs.readdirSync(path.join(storageRoot, room.id)), []);
  await reader.cancel().catch(() => {});
});
