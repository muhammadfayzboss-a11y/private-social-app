// Generates the PWA PNG icons from code so the repository needs no binary design assets.
// Run with: npm run icons
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const outputDir = path.resolve('./public/icons');
fs.mkdirSync(outputDir, { recursive: true });

const table = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = buffer => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

function writePng(file, size, painter) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = painter(x, y, size);
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b; raw[offset + 3] = a;
      offset += 4;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
  return png.length;
}

const mix = (from, to, ratio) => from.map((value, index) => Math.round(value + (to[index] - value) * ratio));
const ring = (x, y, cx, cy, radius, thickness) => {
  const distance = Math.hypot(x - cx, y - cy);
  return Math.abs(distance - radius) <= thickness / 2;
};

function painter({ inset = 0 } = {}) {
  return (x, y, size) => {
    const scale = size / 512;
    const radius = 112 * scale;
    const margin = inset * scale;
    const withinX = Math.min(x - margin, size - margin - 1 - x);
    const withinY = Math.min(y - margin, size - margin - 1 - y);
    const corner = Math.max(0, radius - withinX) ** 2 + Math.max(0, radius - withinY) ** 2;
    const outside = withinX < 0 || withinY < 0 || (withinX < radius && withinY < radius && corner > radius ** 2);
    if (outside) return [0, 0, 0, 0];

    const gradient = mix([104, 74, 255], [176, 88, 240], (x + y) / (2 * size));
    const centerY = size / 2;
    const offset = 64 * scale;
    const circleRadius = 104 * scale;
    const thickness = 26 * scale;
    const onMark = ring(x, y, size / 2 - offset, centerY, circleRadius, thickness)
      || ring(x, y, size / 2, centerY, circleRadius, thickness)
      || ring(x, y, size / 2 + offset, centerY, circleRadius, thickness);
    if (onMark) return [255, 255, 255, 255];
    return [...gradient, 255];
  };
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Circle">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#684aff"/><stop offset="1" stop-color="#b058f0"/>
  </linearGradient></defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <g fill="none" stroke="#fff" stroke-width="26">
    <circle cx="192" cy="256" r="104"/><circle cx="256" cy="256" r="104"/><circle cx="320" cy="256" r="104"/>
  </g>
</svg>
`;

fs.writeFileSync(path.join(outputDir, 'icon.svg'), svg);
const written = [
  ['icon-192.png', 192, painter()],
  ['icon-512.png', 512, painter()],
  ['icon-maskable-512.png', 512, painter({ inset: -40 })],
  ['apple-touch-icon.png', 180, painter()]
].map(([name, size, paint]) => `${name} (${writePng(path.join(outputDir, name), size, paint)} bytes)`);

console.log(`Generated icon.svg and ${written.join(', ')}`);
