'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');
const WebSocket = require('ws');
const { startRoomShare } = require('./harness.js');

const PASSWORD_FAILURES_PER_MINUTE = 3;

// A stand-in for Cloudflare's check: only the token "good" passes, and "broken" makes it fail with a server error.
const verifyCalls = [];
const verifier = http.createServer((req, res) => {
  let data = '';
  req.on('data', (chunk) => (data += chunk));
  req.on('end', () => {
    const form = Object.fromEntries(new URLSearchParams(data));
    verifyCalls.push(form);
    if (form.response === 'broken') return res.writeHead(500).end('unavailable');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: form.response === 'good' }));
  });
});

let base;
let rs;

before(async () => {
  await new Promise((resolve) => verifier.listen(0, '127.0.0.1', resolve));
  rs = await startRoomShare({
    vars: {
      EMPTY_ROOM_GRACE_MS: '5000',
      ROOM_ATTEMPTS_PER_MINUTE: '1000',
      PASSWORD_FAILURES_PER_MINUTE: String(PASSWORD_FAILURES_PER_MINUTE),
      TURNSTILE_SITE_KEY: 'test-site-key',
      TURNSTILE_SECRET: 'test-secret',
      TURNSTILE_VERIFY_URL: `http://127.0.0.1:${verifier.address().port}/siteverify`,
    },
    page: { publicUrl: 'https://share.example.test/', turnstileSiteKey: 'test-site-key' },
  });
  base = rs.base;
});

after(async () => {
  await rs.close();
  await new Promise((resolve) => verifier.close(resolve));
});

const post = (url, payload, headers = {}) =>
  fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

const create = (extra = {}, headers) => post('/api/rooms', { turnstileToken: 'good', ...extra }, headers);
const cookieOf = (response) => response.headers.get('set-cookie').split(';')[0];

function connect(id, cookie) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/rooms/${id}/ws`, { headers: { cookie } });
  const first = new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(JSON.parse(data)));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });
  return { ws, first };
}

/* ---------- Bot check ---------- */

test('a new room needs a bot check that passes', async () => {
  assert.equal((await post('/api/rooms', {})).status, 403, 'no token');
  assert.equal((await post('/api/rooms', { turnstileToken: 'bad' })).status, 403, 'rejected token');
  assert.equal((await post('/api/rooms', { turnstileToken: 42 })).status, 403, 'token of the wrong type');
  assert.equal((await post('/api/rooms')).status, 403, 'no body at all');

  const ok = await create();
  assert.equal(ok.status, 201);
  assert.match((await ok.json()).id, /^[a-z0-9]{8}$/);
});

test('the check is sent the secret, the token and the visitor address', async () => {
  verifyCalls.length = 0;
  await create({}, { 'cf-connecting-ip': '203.0.113.7' });
  assert.deepEqual(
    { secret: verifyCalls[0].secret, response: verifyCalls[0].response, remoteip: verifyCalls[0].remoteip },
    { secret: 'test-secret', response: 'good', remoteip: '203.0.113.7' },
  );
});

test('if the check service fails, the room is refused rather than let through', async () => {
  assert.equal((await post('/api/rooms', { turnstileToken: 'broken' })).status, 403);
});

test('joining an existing room does not need the check', async () => {
  const { id } = await (await create()).json();
  assert.equal((await post(`/api/rooms/${id}/join`)).status, 200);
});

/* ---------- Passwords ---------- */

async function protectedRoom(password = 'open sesame') {
  const response = await create({ password });
  assert.equal(response.status, 201);
  const { id } = await response.json();
  return { id, owner: cookieOf(response) };
}

test('a protected room lets in only people who know the password', async () => {
  const { id } = await protectedRoom();

  const none = await post(`/api/rooms/${id}/join`);
  assert.equal(none.status, 401);
  assert.deepEqual(await none.json(), { error: 'This room is protected. Enter its password.', needsPassword: true });

  const wrong = await post(`/api/rooms/${id}/join`, { password: 'open sesame!' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { error: 'Wrong password.', needsPassword: true });
  assert.equal(wrong.headers.get('set-cookie'), null, 'a wrong password gets no cookie');

  const right = await post(`/api/rooms/${id}/join`, { password: 'open sesame' });
  assert.equal(right.status, 200);
  assert.ok(right.headers.get('set-cookie'));
});

test('the creator, and anyone already inside, can reconnect without the password', async () => {
  const { id, owner } = await protectedRoom();
  assert.equal((await post(`/api/rooms/${id}/join`, undefined, { cookie: owner })).status, 200);
  assert.equal((await post(`/api/rooms/${id}/join`, undefined, { cookie: 'member=' + 'a'.repeat(48) })).status, 401);
});

test('a protected room is protected all the way: no cookie means no live room and no files', async () => {
  const { id } = await protectedRoom();
  await assert.rejects(connect(id, '').first, /status 403/);
  const files = await fetch(`${base}/api/rooms/${id}/files/${'a'.repeat(32)}`);
  assert.equal(files.status, 403);
});

test('the live room tells its members it is locked', async () => {
  const locked = await protectedRoom();
  const open = await (await create()).json();
  const lockedSocket = connect(locked.id, locked.owner);
  assert.equal((await lockedSocket.first).locked, true);
  lockedSocket.ws.close();

  const openJoin = await post(`/api/rooms/${open.id}/join`);
  const openSocket = connect(open.id, cookieOf(openJoin));
  assert.equal((await openSocket.first).locked, false);
  openSocket.ws.close();
});

test('the password is stored only as a salted hash', async () => {
  const secret = 'correct horse battery staple';
  const { id } = await protectedRoom(secret);
  const stored = (await rs.room(id)).password;
  assert.match(stored.salt, /^[a-f0-9]{32}$/, '16 random bytes');
  assert.match(stored.key, /^[a-f0-9]{64}$/, 'a 32-byte hash');
  assert.ok(!JSON.stringify(stored).includes(secret));

  const twin = await protectedRoom(secret);
  assert.notEqual(stored.key, (await rs.room(twin.id)).password.key, 'same password, different salt, different hash');
});

test('an empty password means no password, and an overlong one is refused', async () => {
  const { id } = await (await create({ password: '' })).json();
  assert.equal((await rs.room(id)).password, null);
  assert.equal((await post(`/api/rooms/${id}/join`)).status, 200);

  assert.equal((await create({ password: 'x'.repeat(129) })).status, 400);
  assert.equal((await create({ password: 12345 })).status, 400);
  assert.equal((await create({ password: 'x'.repeat(128) })).status, 201);
});

test('guessing a room password is stopped after a few wrong tries, even for the right one', async () => {
  const { id, owner } = await protectedRoom('the real one');
  // Someone stays inside, so the room stays open however long the guessing takes.
  const inside = connect(id, owner);
  await inside.first;

  for (let i = 0; i < PASSWORD_FAILURES_PER_MINUTE; i += 1) {
    assert.equal((await post(`/api/rooms/${id}/join`, { password: `guess ${i}` })).status, 401);
  }
  const locked = await post(`/api/rooms/${id}/join`, { password: 'the real one' });
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).needsPassword, true);

  // Other rooms are not affected.
  const other = await protectedRoom('another');
  const otherInside = connect(other.id, other.owner);
  await otherInside.first;
  assert.equal((await post(`/api/rooms/${other.id}/join`, { password: 'another' })).status, 200);
  inside.ws.close();
  otherInside.ws.close();
});

test('malformed and oversized request bodies are refused cleanly', async () => {
  assert.equal((await fetch(`${base}/api/rooms`, { method: 'POST', body: '{not json' })).status, 400);
  assert.equal((await post('/api/rooms', { turnstileToken: 'good', password: 'x'.repeat(5000) })).status, 413);
  assert.equal((await post('/api/rooms', 'a string')).status, 403, 'valid JSON of the wrong shape is read as an empty request');
});

/* ---------- Pages and previews ---------- */

test('the page carries link-preview tags with the public address, and the bot check key', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<meta property="og:image" content="https:\/\/share\.example\.test\/og-image\.png">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/share\.example\.test\/">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<meta name="turnstile-site-key" content="test-site-key">/);
  assert.ok(!html.includes('__PUBLIC_URL__') && !html.includes('__VERSION__') && !html.includes('__TURNSTILE'));
});

test('the security policy opens up for the bot check and nothing else', async () => {
  const policy = (await fetch(`${base}/`)).headers.get('content-security-policy');
  assert.match(policy, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(policy, /frame-src https:\/\/challenges\.cloudflare\.com/);
  assert.match(policy, /connect-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(policy, /manifest-src 'self'/);
  assert.match(policy, /default-src 'none'/);
  assert.ok(!policy.includes('unsafe-inline') && !policy.includes('unsafe-eval'));
});
