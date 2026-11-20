'use strict';

// With R2 keys set, uploads go straight from the browser to R2 using a signed link.
// No real R2 account is involved: these tests check the link and the page settings, not R2 itself.

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { startRoomShare, clientFor } = require('./harness.js');

const ACCOUNT = '0123456789abcdef0123456789abcdef';

let rs;
let client;

before(async () => {
  rs = await startRoomShare({
    vars: {
      R2_ACCOUNT_ID: ACCOUNT,
      R2_BUCKET: 'roomshare-files',
      R2_ACCESS_KEY_ID: 'test-access-key',
      R2_SECRET_ACCESS_KEY: 'test-secret-key',
    },
    page: { r2AccountId: ACCOUNT },
  });
  client = clientFor(rs.base);
});

after(() => rs.close());

test('an upload link points straight at the bucket, signed and short-lived', async () => {
  const { id, cookie } = await client.createRoom();
  const slot = await client.reserve(id, cookie, 'movie.mp4', 1_500_000_000);
  assert.equal(slot.status, 201);
  const { id: fileId, url } = await slot.json();

  const link = new URL(url);
  assert.equal(link.origin, `https://${ACCOUNT}.r2.cloudflarestorage.com`);
  assert.equal(link.pathname, `/roomshare-files/${id}/${fileId}`);
  assert.equal(link.searchParams.get('X-Amz-Expires'), '900');
  assert.match(link.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/);
  assert.ok(!url.includes('test-secret-key'), 'the secret never leaves the Worker');
});

test('files up to 2 GB are allowed, and the Worker no longer accepts uploads itself', async () => {
  const { id, cookie } = await client.createRoom();
  const ws = client.openSocket(id, cookie);
  assert.equal((await ws.next('init')).maxFileBytes, 2 * 1024 ** 3);
  ws.close();

  const slot = await (await client.reserve(id, cookie, 'a.txt', 3)).json();
  const throughWorker = await fetch(`${rs.base}/api/rooms/${id}/uploads/${slot.id}`, { method: 'PUT', headers: { cookie }, body: 'abc' });
  assert.equal(throughWorker.status, 404);
});

test('the page may upload to the bucket, and nowhere else', async () => {
  const policy = (await fetch(`${rs.base}/`)).headers.get('content-security-policy');
  assert.match(policy, new RegExp(`connect-src 'self' https://${ACCOUNT}\\.r2\\.cloudflarestorage\\.com;`));
});
