'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { startRoomShare } = require('./harness.js');

let rs;
let base;

before(async () => {
  rs = await startRoomShare();
  base = rs.base;
});

after(() => rs.close());

const pngSize = (bytes) => ({ signature: bytes.subarray(0, 8).toString('hex'), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
const PNG_SIGNATURE = '89504e470d0a1a0a';

test('without a public address the page has no address-based preview tags, and no bot check', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(!html.includes('og:image"') && !html.includes('og:url') && !html.includes('twitter:image'));
  assert.match(html, /<meta property="og:title" content="RoomShare/); // The tags that need no address stay.
  assert.match(html, /<meta property="og:description"/);
  assert.match(html, /<meta name="turnstile-site-key" content="">/);
  assert.ok(!html.includes('__'), 'no unfilled placeholders');

  const policy = (await fetch(`${base}/`)).headers.get('content-security-policy');
  assert.ok(!policy.includes('cloudflare') && !policy.includes('frame-src'));
});

test('the manifest is valid and every icon it names is served as a PNG of the stated size', async () => {
  const response = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(response.headers.get('content-type'), 'application/manifest+json');
  const manifest = await response.json();

  assert.equal(manifest.name, 'RoomShare');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192') && manifest.icons.some((icon) => icon.sizes === '512x512'));

  for (const icon of manifest.icons) {
    const served = await fetch(base + icon.src);
    assert.equal(served.status, 200, icon.src);
    assert.equal(served.headers.get('content-type'), 'image/png');
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.deepEqual(pngSize(Buffer.from(await served.arrayBuffer())), { signature: PNG_SIGNATURE, width, height }, icon.src);
  }
});

test('the home-screen and link-preview images are served at the right sizes', async () => {
  const touch = await fetch(`${base}/apple-touch-icon.png`);
  assert.deepEqual(pngSize(Buffer.from(await touch.arrayBuffer())), { signature: PNG_SIGNATURE, width: 180, height: 180 });

  const preview = await fetch(`${base}/og-image.png`);
  assert.deepEqual(pngSize(Buffer.from(await preview.arrayBuffer())), { signature: PNG_SIGNATURE, width: 1200, height: 630 });
  assert.match(preview.headers.get('cache-control'), /max-age=86400/);
});

test('every script and stylesheet the page loads is served', async () => {
  const html = await (await fetch(`${base}/`)).text();
  const urls = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css|png|webmanifest))(?:\?v=[a-f0-9]+)?"/g)].map((match) => match[1]);
  assert.ok(urls.includes('/vendor/qrcode.js') && urls.includes('/qr.js') && urls.includes('/app.js'));
  for (const url of new Set(urls)) assert.equal((await fetch(base + url)).status, 200, url);
});

// Cloudflare compresses scripts on the way out, so compression is not checked here.
test('the PDF reader and its background worker are served as scripts', async () => {
  for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    const response = await fetch(`${base}/vendor/pdfjs/${file}`);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get('content-type'), /javascript/, file);
    assert.match(response.headers.get('cache-control'), /max-age=604800/);
    assert.ok((await response.arrayBuffer()).byteLength > 100_000, `${file} is the real library, not an error page`);
  }
});

test('the security policy lets the page play media and run the PDF worker, from itself only', async () => {
  const policy = (await fetch(`${base}/`)).headers.get('content-security-policy');
  assert.match(policy, /media-src 'self'(;|$)/);
  assert.match(policy, /worker-src 'self'(;|$)/);
  assert.match(policy, /default-src 'none'/);
  assert.ok(!policy.includes('blob:') && !policy.includes('unsafe-eval') && !policy.includes('unsafe-inline'));
});

test('room links ask search engines to stay out, and the home page does not', async () => {
  assert.equal((await fetch(`${base}/r/abcdefgh`)).headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal((await fetch(`${base}/`)).headers.get('x-robots-tag'), null);
});

test('addresses that match nothing get a 404', async () => {
  for (const url of ['/nope', '/r/short', '/api/rooms/abcdefgh/files', '/api/unknown']) {
    assert.equal((await fetch(base + url)).status, 404, url);
  }
});
