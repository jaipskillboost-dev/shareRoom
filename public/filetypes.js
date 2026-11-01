// Decides what a file is, from its name, so the server and the page agree on what can be viewed.
//
// This is an allowlist on purpose. The server never trusts the type a browser claims for an upload, and only the
// types listed here are ever sent to a browser for display. Anything that could run code when opened (HTML, scripts)
// is listed as plain text, so it is shown as its source and never as a page.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FileTypes = factory();
})(this, function () {
  'use strict';

  const TEXT = 'text/plain; charset=utf-8';

  const GROUPS = {
    image: {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      avif: 'image/avif',
      bmp: 'image/bmp',
      ico: 'image/x-icon',
      svg: 'image/svg+xml', // Shown only inside an <img>, where it cannot run scripts, and sandboxed if opened directly.
    },
    video: { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg' },
    audio: {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      ogg: 'audio/ogg',
      oga: 'audio/ogg',
      opus: 'audio/ogg',
      flac: 'audio/flac',
      weba: 'audio/webm',
    },
    pdf: { pdf: 'application/pdf' },
    text: Object.fromEntries(
      (
        'txt text md markdown log csv tsv json jsonl xml yaml yml toml ini conf cfg env properties diff patch ' +
        'html htm css scss less js mjs cjs jsx ts tsx py rb php java kt swift c h cpp hpp cs go rs sh bash zsh bat cmd ps1 sql ' +
        'r lua pl vue svelte tex bib srt vtt gitignore dockerfile makefile'
      )
        .split(' ')
        .map((extension) => [extension, TEXT]),
    ),
  };

  const BY_EXTENSION = new Map();
  for (const [kind, types] of Object.entries(GROUPS)) {
    for (const [extension, mime] of Object.entries(types)) BY_EXTENSION.set(extension, { kind, mime });
  }

  function extension(name) {
    const dot = String(name).lastIndexOf('.');
    // A name with no dot, or only a leading one (".gitignore"), is read whole, so those named files still match.
    return (dot > 0 ? name.slice(dot + 1) : String(name).replace(/^\./, '')).toLowerCase();
  }

  // { kind, mime, extension }. `kind` is image, video, audio, pdf, text, or other when the file cannot be viewed.
  function describe(name) {
    const ext = extension(name);
    const found = BY_EXTENSION.get(ext);
    return found ? { ...found, extension: ext } : { kind: 'other', mime: null, extension: ext };
  }

  const isViewable = (name) => describe(name).kind !== 'other';

  return { describe, extension, isViewable };
});
