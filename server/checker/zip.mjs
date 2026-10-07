// server/checker/zip.mjs — read and write zip files with node:zlib alone.
//
// Word and PowerPoint files are zip archives of XML. The production image has
// no runtime dependencies ("dependencies": {} and no node_modules in the
// final Docker stage), so rather than ship fflate to the server this file does
// the two things the checker needs with the zlib that Node already has:
//
//   openZip(buf)      lists the entries of an uploaded archive and inflates
//                     only the ones asked for, with hard limits on the number
//                     of entries and on the bytes each one may unpack to, so a
//                     small file that unpacks to gigabytes (a "zip bomb") is
//                     refused rather than exhausting memory
//   writeZip(entries) writes a deflated archive with a fixed timestamp, so the
//                     same content always produces the same bytes (the export
//                     and the sample plan)
//
// Not supported, deliberately: ZIP64 (Office files under 15 MB never need it),
// encryption, and multi-disk archives. Each is refused with a ZipError.
import { crc32 as zlibCrc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export class ZipError extends Error {}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** CRC-32 from zlib (Node 22.2+), with a table fallback for older runtimes. */
let table;
export function crc32(data) {
  if (typeof zlibCrc32 === 'function') return zlibCrc32(data) >>> 0;
  table ??= Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = 0xffffffff;
  for (const byte of data) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Open an archive held in memory. Returns the entry names and a `read(name)`
 * that inflates one entry on demand. Limits:
 *   maxEntries     entries in the central directory
 *   maxEntryBytes  bytes any one entry may unpack to
 *   maxTotalBytes  bytes all the entries read so far may unpack to together
 */
export function openZip(buf, { maxEntries = 5000, maxEntryBytes = 40 * 1024 * 1024, maxTotalBytes = 120 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 22 || buf.readUInt32LE(0) !== LOCAL) throw new ZipError('not a zip archive');
  // The end-of-central-directory record is in the last 64 KB + 22 bytes.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD) { end = i; break; }
  }
  if (end < 0) throw new ZipError('no central directory');
  if (buf.readUInt16LE(end + 4) !== 0 || buf.readUInt16LE(end + 6) !== 0) throw new ZipError('multi-disk archives are not supported');
  const count = buf.readUInt16LE(end + 10);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported');
  if (count > maxEntries) throw new ZipError('too many entries');

  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new ZipError('damaged central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new ZipError('encrypted entries are not supported');
    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new ZipError('ZIP64 archives are not supported');
    if (name.endsWith('/')) continue; // a directory
    entries.set(name, { method, crc, compressed, size, local });
  }
  // OOXML part names are case-insensitive; keep a lower-case index for lookups.
  const lower = new Map([...entries.keys()].map((k) => [k.toLowerCase(), k]));
  let unpacked = 0;

  const find = (name) => entries.get(name) ?? entries.get(lower.get(String(name).toLowerCase()));
  return {
    names: [...entries.keys()],
    has: (name) => Boolean(find(name)),
    /** Inflate one entry to a Buffer, or return null if it is absent. */
    read(name) {
      const e = find(name);
      if (!e) return null;
      if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== LOCAL) throw new ZipError('damaged entry');
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const data = buf.subarray(start, start + e.compressed);
      if (data.length !== e.compressed) throw new ZipError('truncated entry');
      const limit = Math.min(maxEntryBytes, maxTotalBytes - unpacked);
      if (e.size > limit) throw new ZipError('entry too large when unpacked');
      let out;
      if (e.method === 0) out = Buffer.from(data);
      else if (e.method === 8) {
        // The declared size can lie; maxOutputLength is what actually stops a bomb.
        try { out = inflateRawSync(data, { maxOutputLength: Math.max(1, limit) }); }
        catch (err) { throw new ZipError(err instanceof RangeError ? 'entry too large when unpacked' : 'damaged entry'); }
      } else throw new ZipError(`unsupported compression method ${e.method}`);
      if (crc32(out) !== e.crc) throw new ZipError('entry failed its checksum');
      unpacked += out.length;
      return out;
    },
    /** Inflate one entry as UTF-8 text, or null. */
    text(name) {
      const b = this.read(name);
      return b ? b.toString('utf8').replace(/^﻿/, '') : null;
    },
  };
}

// A fixed modification time (2026-01-01 00:00) so output is byte-for-byte
// reproducible. DOS format: time = h<<11 | m<<5 | s/2; date = (y-1980)<<9 | m<<5 | d.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** Write entries [{ name, data: Buffer | string }] to a deflated zip archive. */
export function writeZip(entries, { level = 6 } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const deflated = deflateRawSync(raw, { level });
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);        // version needed: 2.0
    local.writeUInt16LE(0x0800, 6);    // flags: UTF-8 names
    local.writeUInt16LE(8, 8);         // method: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);      // version made by
    central.writeUInt16LE(20, 6);      // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, deflated);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
