// Generates the PNG app icons with no dependencies: node tools/make-icons.mjs
// Shape: three list lines with a play triangle, on a dark rounded square.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [0x14, 0x16, 0x1a], FG = [0xf0, 0xb2, 0x32], LINE = [0xf1, 0xf2, 0xf4];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, px) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Shapes in a 0..1 unit square; scale < 1 shrinks the glyph (maskable safe zone).
function sample(x, y, { rounded, scale }) {
  // background
  let inBg = true;
  if (rounded) {
    const r = 0.22, cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
    inBg = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  }
  if (!inBg) return null;
  const u = (x - 0.5) / scale + 0.5, v = (y - 0.5) / scale + 0.5;
  // three list lines (rounded bars)
  const bars = [[0.2, 0.62, 0.3], [0.2, 0.62, 0.45], [0.2, 0.44, 0.6]];
  for (const [x0, x1, yc] of bars) {
    const h = 0.035, px = Math.min(Math.max(u, x0), x1);
    if ((u - px) ** 2 + (v - yc) ** 2 <= h * h) return LINE;
  }
  // play triangle bottom-right
  const ax = 0.56, ay = 0.56, bx = 0.56, by = 0.84, cx2 = 0.8, cy2 = 0.7;
  const s = (p1x, p1y, p2x, p2y) => (u - p2x) * (p1y - p2y) - (p1x - p2x) * (v - p2y);
  const d1 = s(ax, ay, bx, by), d2 = s(bx, by, cx2, cy2), d3 = s(cx2, cy2, ax, ay);
  if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return FG;
  return BG;
}

function render(size, opts) {
  const px = Buffer.alloc(size * size * 4), SS = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
      const c = sample((x + (i + 0.5) / SS) / size, (y + (j + 0.5) / SS) / size, opts);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const o = (y * size + x) * 4;
    if (a) { px[o] = r / a; px[o + 1] = g / a; px[o + 2] = b / a; }
    px[o + 3] = Math.round((a / (SS * SS)) * 255);
  }
  return png(size, px);
}

const out = new URL('../icons/', import.meta.url);
writeFileSync(new URL('icon-192.png', out), render(192, { rounded: true, scale: 1 }));
writeFileSync(new URL('icon-512.png', out), render(512, { rounded: true, scale: 1 }));
writeFileSync(new URL('icon-maskable-512.png', out), render(512, { rounded: false, scale: 0.8 }));
writeFileSync(new URL('apple-touch-icon.png', out), render(180, { rounded: false, scale: 1 }));
console.log('icons written');
