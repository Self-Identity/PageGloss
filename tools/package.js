/*
 * PageGloss - release packager (no external dependencies).
 * Produces build/pagegloss-<version>.zip with exactly the runtime files, using
 * a minimal ZIP writer (store + deflate via Node's zlib).
 * Run with: node tools/package.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');

const INCLUDE_DIRS = ['src', 'icons', '_locales', 'docs'];
const INCLUDE_FILES = ['manifest.json', 'LICENSE'];

// dev/ holds development-only helpers (for example the demo data seeder). It is
// never shipped: the published package must not contain demo annotations or any
// other test scaffolding.
const EXCLUDED_DIRS = ['dev', 'build', 'tests', 'tools'];

function isExcluded(full) {
  const relative = path.relative(ROOT, full).replace(/\\/g, '/');
  return EXCLUDED_DIRS.some((dir) => relative === dir || relative.indexOf(dir + '/') === 0);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (isExcluded(full)) continue;
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function collectFiles() {
  const files = [];
  INCLUDE_FILES.forEach((name) => {
    const full = path.join(ROOT, name);
    if (fs.existsSync(full)) files.push(full);
  });
  INCLUDE_DIRS.forEach((name) => {
    const full = path.join(ROOT, name);
    if (fs.existsSync(full)) walk(full, files);
  });
  return files.sort();
}

/* ----------------------------------------------------------------- zip writer */

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
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const { time, day } = dosDateTime(now);

  entries.forEach((entry) => {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, payload);

    const entryCentral = Buffer.alloc(46);
    entryCentral.writeUInt32LE(0x02014b50, 0);
    entryCentral.writeUInt16LE(20, 4);
    entryCentral.writeUInt16LE(20, 6);
    entryCentral.writeUInt16LE(0x0800, 8);
    entryCentral.writeUInt16LE(method, 10);
    entryCentral.writeUInt16LE(time, 12);
    entryCentral.writeUInt16LE(day, 14);
    entryCentral.writeUInt32LE(crc, 16);
    entryCentral.writeUInt32LE(payload.length, 20);
    entryCentral.writeUInt32LE(raw.length, 24);
    entryCentral.writeUInt16LE(name.length, 28);
    entryCentral.writeUInt16LE(0, 30);
    entryCentral.writeUInt16LE(0, 32);
    entryCentral.writeUInt16LE(0, 34);
    entryCentral.writeUInt16LE(0, 36);
    entryCentral.writeUInt32LE(0, 38);
    entryCentral.writeUInt32LE(offset, 42);
    central.push(entryCentral, name);

    offset += local.length + name.length + payload.length;
  });

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuffer, end]);
}

/* ----------------------------------------------------------------------- main */

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const files = collectFiles();
  const entries = files.map((file) => ({
    name: path.relative(ROOT, file).replace(/\\/g, '/'),
    data: fs.readFileSync(file)
  }));
  const archive = buildZip(entries);
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const target = path.join(BUILD_DIR, `pagegloss-${manifest.version}.zip`);
  fs.writeFileSync(target, archive);
  const kb = (archive.length / 1024).toFixed(1);
  console.log(`packed ${entries.length} files into ${path.relative(ROOT, target)} (${kb} KB)`);
}

main();
