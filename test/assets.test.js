'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

// Defaults: no public address and no bot check, as when running on a laptop.
for (const name of ['PUBLIC_URL', 'RENDER_EXTERNAL_URL', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET']) delete process.env[name];
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'roomshare-assets-'));

const { server } = require('../server.js');

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
  assert.equal(preview.headers.get('content-encoding'), null, 'images are not compressed a second time');
});

test('every script and stylesheet the page loads is served', async () => {
  const html = await (await fetch(`${base}/`)).text();
  const urls = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css|png|webmanifest))(?:\?v=[a-f0-9]+)?"/g)].map((match) => match[1]);
  assert.ok(urls.includes('/vendor/qrcode.js') && urls.includes('/qr.js') && urls.includes('/app.js'));
  for (const url of new Set(urls)) assert.equal((await fetch(base + url)).status, 200, url);
});

test('the PDF reader and its background worker are served, compressed, as scripts', async () => {
  for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    const response = await fetch(`${base}/vendor/pdfjs/${file}`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(response.status, 200, file);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8', file);
    assert.equal(response.headers.get('content-encoding'), 'br', file);
    assert.match(response.headers.get('cache-control'), /max-age=604800/);
    assert.ok(Number(response.headers.get('content-length')) > 100_000, `${file} is the real library, not an error page`);
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
