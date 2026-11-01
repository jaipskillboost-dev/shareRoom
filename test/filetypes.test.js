'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { describe, extension, isViewable } = require('../public/filetypes.js');

test('common files are recognised by their extension, in any letter case', () => {
  const cases = [
    ['photo.JPG', 'image', 'image/jpeg'],
    ['screenshot-20261031-232415.png', 'image', 'image/png'],
    ['clip.MP4', 'video', 'video/mp4'],
    ['song.mp3', 'audio', 'audio/mpeg'],
    ['voice note.m4a', 'audio', 'audio/mp4'],
    ['Quarterly report FINAL v3.PDF', 'pdf', 'application/pdf'],
    ['notes.md', 'text', 'text/plain; charset=utf-8'],
    ['data.csv', 'text', 'text/plain; charset=utf-8'],
  ];
  for (const [name, kind, mime] of cases) assert.deepEqual([describe(name).kind, describe(name).mime], [kind, mime], name);
});

test('files that cannot be viewed are reported as other, with no type', () => {
  for (const name of ['report.docx', 'budget.xlsx', 'slides.pptx', 'bundle.zip', 'setup.exe', 'photo.heic', 'noextension', '']) {
    assert.deepEqual(describe(name), { kind: 'other', mime: null, extension: extension(name) }, name);
    assert.equal(isViewable(name), false, name);
  }
});

test('anything that could run code in a browser is never given a type a browser would run', () => {
  const dangerous = ['page.html', 'page.htm', 'script.js', 'module.mjs', 'app.jsx', 'style.css', 'data.xml', 'feed.xml', 'x.svgz', 'evil.xhtml'];
  for (const name of dangerous) {
    const { mime } = describe(name);
    assert.ok(mime === null || mime === 'text/plain; charset=utf-8', `${name} -> ${mime}`);
  }
  assert.equal(describe('page.html').kind, 'text', 'HTML is shown as its source');
  // Every type handed out is on this short list, so nothing like text/html or application/javascript can appear.
  const everyMime = new Set(
    ['png', 'jpg', 'gif', 'webp', 'svg', 'mp4', 'webm', 'mp3', 'wav', 'pdf', 'html', 'js', 'xml', 'txt'].map((ext) => describe(`f.${ext}`).mime),
  );
  for (const mime of everyMime) assert.doesNotMatch(mime, /html|javascript|ecmascript|xhtml|x-sh/, mime);
});

test('the extension is the last part of the name, and dotfiles still match', () => {
  assert.equal(extension('archive.tar.gz'), 'gz');
  assert.equal(extension('.gitignore'), 'gitignore');
  assert.equal(describe('.gitignore').kind, 'text');
  assert.equal(describe('Makefile').kind, 'text', 'well-known names with no dot are matched whole');
  assert.equal(describe('Dockerfile').kind, 'text');
  assert.equal(describe('README').kind, 'other', 'any other bare name is not guessed');
  assert.equal(describe('trailing.dot.').kind, 'other');
  assert.equal(describe('report.pdf.exe').kind, 'other', 'a disguised name is judged by its real ending');
  assert.equal(describe('photo.png.html').kind, 'text', 'and an image name ending in html is shown as text');
});
