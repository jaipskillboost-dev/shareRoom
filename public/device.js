// Names for the people in a room: a readable default from the device ("iPhone · Safari"), and the rule for
// names people type themselves. The browser and the server both load this file, so they agree on what is allowed.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Device = factory();
})(this, function () {
  'use strict';

  const MAX_NAME = 40;
  // Control characters, zero-width characters and text-direction overrides, which could disguise a name.
  const INVISIBLE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069]];
  const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g');

  // "touchPoints" tells an iPad, which reports itself as a Mac, from a real Mac.
  function deviceName(userAgent = '', touchPoints = 0) {
    const ua = String(userAgent);
    let device = 'Device';
    if (/iPhone/.test(ua)) device = 'iPhone';
    else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) device = 'iPad';
    else if (/Android/.test(ua)) device = /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
    else if (/CrOS/.test(ua)) device = 'Chromebook';
    else if (/Windows/.test(ua)) device = 'Windows PC';
    else if (/Macintosh|Mac OS X/.test(ua)) device = 'Mac';
    else if (/Linux/.test(ua)) device = 'Linux PC';

    let browser = '';
    if (/EdgA?\/|EdgiOS/.test(ua)) browser = 'Edge';
    else if (/OPR\/|OPiOS/.test(ua)) browser = 'Opera';
    else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
    else if (/Firefox\/|FxiOS/.test(ua)) browser = 'Firefox';
    else if (/Chrome\/|CriOS/.test(ua)) browser = 'Chrome';
    else if (/Safari\//.test(ua)) browser = 'Safari';

    return browser ? `${device} · ${browser}` : device;
  }

  // A name someone typed: no control characters, single spaces, at most 40 characters. Empty means "no name".
  function cleanName(raw) {
    if (typeof raw !== 'string') return null;
    const name = raw.replace(/\s+/g, ' ').replace(INVISIBLE, '').replace(/ {2,}/g, ' ').trim(); // Line breaks become spaces.
    return name ? [...name].slice(0, MAX_NAME).join('') : null;
  }

  return { deviceName, cleanName, MAX_NAME };
});
