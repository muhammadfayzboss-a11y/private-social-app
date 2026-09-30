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

// `sub` uses PNG filter type 1 (difference from the left pixel): near-constant rows compress to almost nothing.
function writePng(file, size, painter, height = size, { sub = false } = {}) {
  const width = size;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = sub ? 1 : 0;
    offset += 1;
    let previous = [0, 0, 0, 0];
    for (let x = 0; x < width; x += 1) {
      const pixel = painter(x, y, size, height);
      for (let channel = 0; channel < 4; channel += 1) raw[offset + channel] = sub ? (pixel[channel] - previous[channel] + 256) & 255 : pixel[channel];
      previous = pixel;
      offset += 4;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
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

/**
 * iOS launch screens (apple-touch-startup-image): the brand gradient with the three-ring mark, one
 * PNG per iPhone/iPad screen size so the installed app never flashes white while it starts.
 */
export const SPLASH_SIZES = [
  [1290, 2796, 430, 932, 3], [1179, 2556, 393, 852, 3], [1284, 2778, 428, 926, 3], [1170, 2532, 390, 844, 3],
  [1125, 2436, 375, 812, 3], [1242, 2688, 414, 896, 3], [828, 1792, 414, 896, 2], [1242, 2208, 414, 736, 3],
  [750, 1334, 375, 667, 2], [1080, 2340, 360, 780, 3], [1536, 2048, 768, 1024, 2], [1668, 2388, 834, 1194, 2], [2048, 2732, 1024, 1366, 2]
];

function splashPainter(width, height) {
  const mark = Math.round(Math.min(width, height) * 0.36);
  const cx = width / 2; const cy = height / 2;
  const scale = mark / 512;
  return (x, y) => {
    const gradient = mix([96, 70, 240], [150, 84, 236], y / height);
    const offset = 64 * scale; const radius = 104 * scale; const thickness = 26 * scale;
    const onMark = ring(x, y, cx - offset, cy, radius, thickness) || ring(x, y, cx, cy, radius, thickness) || ring(x, y, cx + offset, cy, radius, thickness);
    return onMark ? [255, 255, 255, 255] : [...gradient, 255];
  };
}

const splashDir = path.join(outputDir, 'splash');
fs.mkdirSync(splashDir, { recursive: true });
let splashBytes = 0;
for (const [width, height] of SPLASH_SIZES) {
  splashBytes += writePng(path.join(splashDir, `splash-${width}x${height}.png`), width, splashPainter(width, height), height, { sub: true });
}
console.log(`Generated ${SPLASH_SIZES.length} iOS launch screens (${Math.round(splashBytes / 1024)} KB total)`);
