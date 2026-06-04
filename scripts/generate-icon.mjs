import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const width = 512;
const height = 512;
const pixels = Buffer.alloc(width * height * 4, 0);

function setPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return;
  }

  const offset = (y * width + x) * 4;
  pixels[offset] = r;
  pixels[offset + 1] = g;
  pixels[offset + 2] = b;
  pixels[offset + 3] = a;
}

function roundedRect(x, y, w, h, radius, color) {
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      const dx = px < x + radius ? x + radius - px : px >= x + w - radius ? px - (x + w - radius - 1) : 0;
      const dy = py < y + radius ? y + radius - py : py >= y + h - radius ? py - (y + h - radius - 1) : 0;

      if (dx * dx + dy * dy <= radius * radius || dx === 0 || dy === 0) {
        setPixel(px, py, ...color);
      }
    }
  }
}

function rect(x, y, w, h, color) {
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      setPixel(px, py, ...color);
    }
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

roundedRect(44, 44, 424, 424, 64, [31, 86, 110, 255]);
roundedRect(142, 92, 214, 324, 18, [247, 250, 251, 255]);
rect(356, 150, 54, 266, [247, 250, 251, 255]);
rect(304, 92, 56, 56, [222, 228, 232, 255]);
rect(319, 107, 25, 25, [247, 250, 251, 255]);
roundedRect(178, 214, 210, 30, 8, [237, 196, 75, 255]);
roundedRect(178, 272, 164, 22, 8, [130, 146, 156, 255]);
roundedRect(178, 318, 132, 22, 8, [130, 146, 156, 255]);

const raw = Buffer.alloc((width * 4 + 1) * height);
for (let y = 0; y < height; y += 1) {
  raw[y * (width * 4 + 1)] = 0;
  pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

await writeFile("src-tauri/icons/icon.png", png);
