'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { deviceName, cleanName } = require('../public/device.js');

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
  ipadDesktopMode: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  samsungTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Safari/537.36',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0',
  windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

test('devices get a readable name from their browser', () => {
  assert.equal(deviceName(UA.iphone, 5), 'iPhone · Safari');
  assert.equal(deviceName(UA.iphoneChrome, 5), 'iPhone · Chrome');
  assert.equal(deviceName(UA.ipadDesktopMode, 5), 'iPad · Safari', 'an iPad asking for desktop sites');
  assert.equal(deviceName(UA.ipadDesktopMode, 0), 'Mac · Safari');
  assert.equal(deviceName(UA.android, 5), 'Android phone · Chrome');
  assert.equal(deviceName(UA.samsungTablet, 5), 'Android tablet · Samsung Internet');
  assert.equal(deviceName(UA.windowsEdge, 0), 'Windows PC · Edge');
  assert.equal(deviceName(UA.windowsFirefox, 0), 'Windows PC · Firefox');
  assert.equal(deviceName(UA.macChrome, 0), 'Mac · Chrome');
  assert.equal(deviceName(UA.chromebook, 0), 'Chromebook · Chrome');
  assert.equal(deviceName('', 0), 'Device');
});

test('typed names are cleaned, and empty ones are refused', () => {
  const invisible = [0x200b, 0x202e, 0x2066, 0x0007].map((code) => String.fromCharCode(code)).join('');
  assert.equal(cleanName(`  Asha${invisible}'s   phone \n`), "Asha's phone");
  assert.equal(cleanName('x'.repeat(100)).length, 40);
  assert.equal(cleanName('😀'.repeat(50)), '😀'.repeat(40), 'emoji count as one character each');
  for (const empty of ['', '   ', invisible, null, undefined, 42, {}]) assert.equal(cleanName(empty), null);
});
