// Generates resources/icon.png (256x256 RGBA): a serpent-like ring on a dark rounded square.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const S = 256
const px = new Uint8Array(S * S * 4)
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
const crc32 = (buf) => {
  let c = -1
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const set = (x, y, r, g, b, a) => { const i = (y * S + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a }
const cx = S / 2, cy = S / 2
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  // rounded square background
  const rx = Math.max(Math.abs(x - cx) - 96, 0), ry = Math.max(Math.abs(y - cy) - 96, 0)
  const inSq = Math.hypot(rx, ry) <= 32
  if (!inSq) continue
  set(x, y, 17, 19, 26, 255)
  const d = Math.hypot(x - cx, y - cy)
  const ang = Math.atan2(y - cy, x - cx)
  const ring = d > 66 && d < 98
  // leave a gap (the mouth) and taper the tail
  const t = (ang + Math.PI) / (2 * Math.PI) // 0..1 around
  const gap = t > 0.92 && t < 0.98
  const thick = 16 * (0.45 + 0.55 * t)
  const inBand = Math.abs(d - 82) <= thick
  if (ring && inBand && !gap) {
    const g = Math.round(120 + 100 * t)
    set(x, y, 56, g, 255, 255)
  }
  // eye
  if (Math.hypot(x - (cx + 82 * Math.cos(-0.1)), y - (cy + 82 * Math.sin(-0.1))) < 5) set(x, y, 17, 19, 26, 255)
}
const raw = Buffer.alloc((S * 4 + 1) * S)
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1) }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
mkdirSync('resources', { recursive: true })
writeFileSync('resources/icon.png', png)
console.log('wrote resources/icon.png', png.length, 'bytes')
// ICO with a single PNG-compressed 256x256 entry (valid on Windows Vista and later).
const dir = Buffer.alloc(16)
dir[0] = 0 // width 256 -> 0
dir[1] = 0 // height 256 -> 0
dir[2] = 0 // palette
dir[3] = 0
dir.writeUInt16LE(1, 4) // planes
dir.writeUInt16LE(32, 6) // bpp
dir.writeUInt32LE(png.length, 8)
dir.writeUInt32LE(22, 12) // offset = 6 + 16
const hdr = Buffer.alloc(6)
hdr.writeUInt16LE(0, 0)
hdr.writeUInt16LE(1, 2)
hdr.writeUInt16LE(1, 4)
writeFileSync('resources/icon.ico', Buffer.concat([hdr, dir, png]))
console.log('wrote resources/icon.ico')
