/**
 * Minimal EXIF parser (no deps) — reads the raw EXIF buffer from sharp and
 * extracts the camera exposure tags we care about for the soft-capture
 * investigation: ISO, ExposureTime, FNumber, FocalLength, 35mm-equiv,
 * DateTimeOriginal, ExposureProgram, Orientation.
 *
 * usage: node scripts/exif_iso.mjs <file.jpg> [more.jpg ...]
 */
import sharp from "sharp";
import fs from "node:fs";

function findTiff(buf) {
  // EXIF buffer may start with "Exif\0\0" then TIFF, or be TIFF directly.
  for (let i = 0; i + 2 <= buf.length; i++) {
    const a = buf[i], b = buf[i + 1];
    if ((a === 0x49 && b === 0x49) || (a === 0x4D && b === 0x4D)) return i;
  }
  return -1;
}

function parseTiff(buf, base) {
  const le = buf[base] === 0x49;
  const rd16 = (o) => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
  const rd32 = (o) => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
  const tiffStart = base;
  // base+2 == 42
  let ifdOffset = rd32(base + 4);
  const readValue = (entryOff, type, count) => {
    const sizeMap = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    const size = sizeMap[type] || 1;
    let dataOff = entryOff + 8;
    if (count * size > 4) dataOff = tiffStart + rd32(entryOff + 8);
    const read = (o) => {
      switch (type) {
        case 1: return buf.readUInt8(o);
        case 2: return buf.toString("ascii", o, o + count).replace(/\0.*$/, "");
        case 3: return rd16(o);
        case 4: return rd32(o);
        case 5: return rd32(o) / rd32(o + 4);
        case 9: return le ? buf.readInt32LE(o) : buf.readInt32BE(o);
        case 10: return (le ? buf.readInt32LE(o) : buf.readInt32BE(o)) /
                       (le ? buf.readInt32LE(o + 4) : buf.readInt32BE(o + 4));
        default: return null;
      }
    };
    if (count === 1) return read(dataOff);
    const arr = [];
    for (let i = 0; i < count; i++) arr.push(read(dataOff + i * size));
    return arr;
  };
  const parseIfd = (off) => {
    const out = {};
    if (off + 2 > buf.length) return out;
    const n = rd16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      const tag = rd16(e);
      const type = rd16(e + 2);
      const count = rd32(e + 4);
      out[tag] = { type, count, value: readValue(e, type, count) };
    }
    return out;
  };
  const ifd0 = parseIfd(tiffStart + ifdOffset);
  let sub = {};
  if (ifd0[0x8769]) sub = parseIfd(tiffStart + Number(ifd0[0x8769].value));
  return { ifd0, sub };
}

const TAGS = {
  0x0112: "Orientation", 0x0110: "Model", 0x010f: "Make",
  0x829a: "ExposureTime", 0x829d: "FNumber", 0x8827: "ISO",
  0x920a: "FocalLength", 0x9202: "FocalLength35mm", 0x9003: "DateTimeOriginal",
  0x8822: "ExposureProgram", 0x8824: "LightSource", 0xa402: "ExposureMode",
};

const files = process.argv.slice(2);
for (const f of files) {
  if (!fs.existsSync(f)) { console.log("MISSING", f); continue; }
  const m = await sharp(f).metadata();
  const out = { file: f.split(/[\\/]/).pop() };
  out.dims = `${m.width}x${m.height} orient=${m.orientation}`;
  if (m.exif) {
    const t = findTiff(m.exif);
    if (t >= 0) {
      const { ifd0, sub } = parseTiff(m.exif, t);
      const all = { ...ifd0, ...sub };
      for (const [k, name] of Object.entries(TAGS)) {
        const id = Number(k);
        if (all[id]) {
          let v = all[id].value;
          if (name === "ExposureTime" && typeof v === "number") v = `${v.toFixed(5)}s (${(1 / v).toFixed(0)}/1)`;
          if (name === "FNumber" && typeof v === "number") v = `f/${v.toFixed(2)}`;
          if (name === "FocalLength" && typeof v === "number") v = `${v.toFixed(2)}mm`;
          if (name === "FocalLength35mm" && typeof v === "number") v = `${v}mm (FF)`;
          out[name] = v;
        }
      }
    } else out.exif = "no TIFF magic found";
  } else out.exif = "NONE (canvas re-encode / stripped)";
  console.log("=".repeat(72));
  for (const [k, v] of Object.entries(out)) console.log(`  ${k.padEnd(18)}: ${v}`);
}
