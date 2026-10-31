// Turns a link into the data for a QR code image: its size in modules (the little squares) and one SVG path
// that draws every dark module. The page draws it; the tests draw it too and decode it with a separate reader.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vendor/qrcode.js'));
  else root.Qr = factory(root.qrcode);
})(this, function (qrcode) {
  'use strict';

  const QUIET_ZONE = 4; // Blank modules every code needs around it so scanners can find its edges.

  function build(text) {
    const code = qrcode(0, 'M'); // The smallest size that fits, with medium error correction.
    code.addData(text, 'Byte');
    code.make();
    const count = code.getModuleCount();

    let path = '';
    for (let row = 0; row < count; row += 1) {
      let col = 0;
      while (col < count) {
        if (!code.isDark(row, col)) {
          col += 1;
          continue;
        }
        let run = 1; // Neighbouring dark modules in a row are drawn as one bar.
        while (col + run < count && code.isDark(row, col + run)) run += 1;
        path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h${run}v1h-${run}z`;
        col += run;
      }
    }
    return { size: count + QUIET_ZONE * 2, path };
  }

  return { build };
});
