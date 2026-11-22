// Builds dist/, the folder Workers Static Assets serves: a copy of public/ with the page's placeholders filled in,
// plus a _headers file with the security policy and caching rules.
//
// `wrangler dev` and `wrangler deploy` run this automatically (see "build" in wrangler.jsonc). It reads the page
// settings (PUBLIC_URL, TURNSTILE_SITE_KEY, R2_ACCOUNT_ID) from the vars in wrangler.jsonc.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contentSecurityPolicy, r2Origin, renderPage } from '../src/shared.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Files whose address carries ?v=<version>, so browsers can keep them forever.
const VERSIONED = ['app.js', 'textsync.js', 'theme.js', 'qr.js', 'filetypes.js', 'device.js', 'vendor/qrcode.js', 'style.css'];
const DAILY = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'og-image.png'];

export function buildAssets({ outDir = path.join(root, 'dist'), publicUrl = '', turnstileSiteKey = '', turnstileSecretSet = true, r2AccountId = '', directUploads = Boolean(r2AccountId) } = {}) {
  const source = path.join(root, 'public');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(source, outDir, { recursive: true });

  const hash = crypto.createHash('sha1');
  for (const file of VERSIONED) hash.update(fs.readFileSync(path.join(source, file)));
  const version = hash.digest('hex').slice(0, 12);

  const turnstile = Boolean(turnstileSiteKey && turnstileSecretSet);
  const html = fs.readFileSync(path.join(source, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'index.html'), renderPage(html, { version, publicUrl, turnstileSiteKey: turnstile ? turnstileSiteKey : '' }));

  const policy = contentSecurityPolicy({ turnstile, uploadOrigin: directUploads ? r2Origin(r2AccountId) : '' });
  const rule = (paths, cacheControl) => paths.map((file) => `/${file}\n  Cache-Control: ${cacheControl}\n`).join('');
  fs.writeFileSync(
    path.join(outDir, '_headers'),
    [
      `/*\n  Content-Security-Policy: ${policy}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n`,
      rule(['', 'index.html'], 'no-cache'),
      rule(VERSIONED, 'public, max-age=31536000, immutable'),
      rule(DAILY, 'public, max-age=86400'),
      // Loaded only when needed (a PDF, Download all, a QR scan). Their addresses carry no version, so a week.
      rule(['vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs', 'vendor/fflate.js', 'vendor/jsQR.js'], 'public, max-age=604800'),
    ].join(''),
  );
  return { outDir, version, policy };
}

async function settingsFromWrangler() {
  const { experimental_readRawConfig } = await import('wrangler');
  const { rawConfig } = experimental_readRawConfig({ config: path.join(root, 'wrangler.jsonc') });
  const vars = rawConfig.vars ?? {};
  return {
    publicUrl: String(vars.PUBLIC_URL ?? ''),
    turnstileSiteKey: String(vars.TURNSTILE_SITE_KEY ?? ''),
    r2AccountId: String(vars.R2_ACCOUNT_ID ?? ''),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { outDir, version } = buildAssets(await settingsFromWrangler());
  console.log(`Built ${path.relative(root, outDir)} (version ${version})`);
}
