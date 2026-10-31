'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const jsQR = require('jsqr');
const { build } = require('../public/qr.js');

// Draws the path the way the page does (dark bars on white) and returns raw pixels for the decoder.
function rasterize({ size, path }, scale) {
  const width = size * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (const [, x, y, run] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let row = 0; row < scale; row += 1) {
      for (let col = 0; col < Number(run) * scale; col += 1) {
        const at = ((Number(y) * scale + row) * width + Number(x) * scale + col) * 4;
        pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
      }
    }
  }
  return { pixels, width };
}

function decode(text, scale = 6) {
  const { pixels, width } = rasterize(build(text), scale);
  return jsQR(pixels, width, width)?.data;
}

test('an invite link survives being drawn and scanned back', () => {
  const links = [
    'https://shareroom-rvux.onrender.com/r/9bn7tk5c',
    'http://192.168.1.42:3000/r/u7ydpn7q',
    'https://example.com/r/abcdefgh',
    'http://localhost:3000/r/23456789',
  ];
  for (const link of links) assert.equal(decode(link), link);
});

test('codes decode at small and large drawing sizes', () => {
  const link = 'https://shareroom-rvux.onrender.com/r/9bn7tk5c';
  for (const scale of [3, 4, 10, 16]) assert.equal(decode(link, scale), link, `scale ${scale}`);
});

test('the image data is a square with the required blank border', () => {
  const { size, path } = build('https://example.com/r/abcdefgh');
  assert.ok(size >= 29 + 8, 'at least a version 1 code plus its 4 module border');
  const coordinates = [...path.matchAll(/M(\d+) (\d+)h(\d+)/g)].map(([, x, y, run]) => [Number(x), Number(y), Number(run)]);
  assert.ok(coordinates.length > 50);
  for (const [x, y, run] of coordinates) {
    assert.ok(x >= 4 && y >= 4, 'nothing is drawn inside the border');
    assert.ok(x + run <= size - 4 && y < size - 4, 'nothing is drawn past the border');
  }
});

test('a different link makes a different code', () => {
  assert.notEqual(build('https://example.com/r/aaaaaaaa').path, build('https://example.com/r/bbbbbbbb').path);
});
