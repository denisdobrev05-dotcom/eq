// Generates PNG app icons with no external dependencies (uses Node zlib).
// Draws a dark rounded-square icon with a purple/blue gradient disc and a
// white "play" triangle plus subtle sound-wave bars. Output: icons/*.png
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // add filter byte (0) per row
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function lerp(a, b, t) { return a + (b - a) * t; }

function draw(size) {
  const w = size, h = size;
  const buf = Buffer.alloc(w * h * 4);
  const radius = size * 0.22;       // rounded corners
  const cx = size / 2, cy = size / 2;

  // gradient colors
  const c1 = [124, 58, 237];   // violet
  const c2 = [37, 99, 235];    // blue
  const bg = [13, 13, 20];     // near-black

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // rounded-rect mask
      let inside = true;
      const rx = Math.min(x, w - 1 - x);
      const ry = Math.min(y, h - 1 - y);
      if (rx < radius && ry < radius) {
        const dx = radius - rx, dy = radius - ry;
        if (dx * dx + dy * dy > radius * radius) inside = false;
      }
      if (!inside) { buf[i + 3] = 0; continue; }

      // base background
      let r = bg[0], g = bg[1], b = bg[2];

      // gradient disc
      const dxc = x - cx, dyc = y - cy;
      const dist = Math.sqrt(dxc * dxc + dyc * dyc);
      const discR = size * 0.40;
      if (dist < discR) {
        const t = (x / w + y / h) / 2;
        r = lerp(c1[0], c2[0], t);
        g = lerp(c1[1], c2[1], t);
        b = lerp(c1[2], c2[2], t);
        // edge softening
        const edge = discR - dist;
        if (edge < 6) {
          const a = edge / 6;
          r = lerp(bg[0], r, a);
          g = lerp(bg[1], g, a);
          b = lerp(bg[2], b, a);
        }
      }

      // white play triangle centered
      const tw = size * 0.20;
      const tx = x - (cx - tw * 0.35);
      const tyAbs = Math.abs(y - cy);
      if (tx >= 0 && tx <= tw) {
        const limit = (tw - tx) * 0.75;
        if (tyAbs <= limit) {
          r = 255; g = 255; b = 255;
        }
      }

      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = 255;
    }
  }
  return encodePNG(w, h, buf);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [180, 192, 512]) {
  const png = draw(size);
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png);
  console.log('wrote icon-' + size + '.png', png.length, 'bytes');
}
