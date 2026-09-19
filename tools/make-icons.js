/*
 * PageGloss - dependency free PNG icon generator.
 * Draws the PageGloss mark (rounded square + highlighted page lines) into
 * 16/32/48/128 px RGBA PNGs. Run with: node tools/make-icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'icons');
const SIZES = [16, 32, 48, 128];

/* ------------------------------------------------------------------- drawing */

function makeCanvas(size) {
  const pixels = new Float64Array(size * size * 4);
  return { size, pixels };
}

function blendPixel(canvas, x, y, color) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const index = (y * canvas.size + x) * 4;
  const alpha = color[3];
  if (alpha <= 0) return;
  const dstA = canvas.pixels[index + 3];
  const outA = alpha + dstA * (1 - alpha);
  if (outA <= 0) return;
  for (let channel = 0; channel < 3; channel++) {
    const src = color[channel];
    const dst = canvas.pixels[index + channel];
    canvas.pixels[index + channel] = (src * alpha + dst * dstA * (1 - alpha)) / outA;
  }
  canvas.pixels[index + 3] = outA;
}

function fillRoundedRect(canvas, x0, y0, w, h, radius, color) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const cx = Math.min(Math.max(x + 0.5, x0 + radius), x1 - radius);
      const cy = Math.min(Math.max(y + 0.5, y0 + radius), y1 - radius);
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > radius * radius) continue;
      blendPixel(canvas, x, y, color);
    }
  }
}

function fillRect(canvas, x0, y0, w, h, color) {
  fillRoundedRect(canvas, x0, y0, w, h, 0, color);
}

/* -------------------------------------------------------------------- encode */

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(canvas) {
  const { size, pixels } = canvas;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4;
      raw[offset++] = Math.round(Math.min(255, Math.max(0, pixels[index])));
      raw[offset++] = Math.round(Math.min(255, Math.max(0, pixels[index + 1])));
      raw[offset++] = Math.round(Math.min(255, Math.max(0, pixels[index + 2])));
      raw[offset++] = Math.round(Math.min(255, Math.max(0, pixels[index + 3] * 255)));
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* --------------------------------------------------------------------- glyph */

const ACCENT = [0x2f, 0x6d, 0xf6, 1];
const PAPER = [0xff, 0xff, 0xff, 1];
const HIGHLIGHT = [0xff, 0xd9, 0x6b, 1];

function drawIcon(size) {
  const canvas = makeCanvas(size);
  const u = size / 32; // design grid is 32x32

  fillRoundedRect(canvas, 0, 0, size, size, 8 * u, ACCENT);

  // Page sheet.
  fillRoundedRect(canvas, 7 * u, 5 * u, 18 * u, 22 * u, 2.6 * u, PAPER);
  // Spine.
  fillRect(canvas, 7 * u, 5 * u, 2.2 * u, 22 * u, [0xd7, 0xe2, 0xfb, 1]);

  // Text lines, the middle one highlighted (the marked term).
  const lineHeight = Math.max(1, Math.round(1.9 * u));
  const lines = [
    { y: 9.2, width: 11, color: [0x9a, 0xa5, 0xb8, 1] },
    { y: 13.2, width: 9.4, color: HIGHLIGHT },
    { y: 17.2, width: 10.6, color: [0x9a, 0xa5, 0xb8, 1] },
    { y: 21.2, width: 6.4, color: [0x9a, 0xa5, 0xb8, 1] }
  ];
  lines.forEach((line) => {
    fillRoundedRect(canvas, 11.4 * u, line.y * u, line.width * u, lineHeight, lineHeight / 2, line.color);
  });

  return canvas;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  SIZES.forEach((size) => {
    const file = path.join(OUT_DIR, `icon${size}.png`);
    fs.writeFileSync(file, encodePng(drawIcon(size)));
    console.log(`wrote ${path.relative(path.join(__dirname, '..'), file)}`);
  });
}

main();
