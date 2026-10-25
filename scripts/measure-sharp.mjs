/**
 * Measure a B2-pulled capture with the app's EXACT sharpness protocol
 * (src/app.js stillSharpness): centre 60% crop, sampled to width 320,
 * Tenengrad = mean(Gx^2 + Gy^2) on luma.
 *
 * createImageBitmap() applies EXIF orientation, so the app sees the ROTATED
 * image. sharp needs an explicit .rotate() to match.
 *
 * usage: node scripts/measure-sharp.mjs <file.jpg> [more.jpg ...]
 */
import sharp from "sharp";
import fs from "node:fs";

const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 };
const SAMPLE_W = 320;

function tenengrad(rgba, w, h, ch) {
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * ch;
    gray[i] = LUMA.r * rgba[o] + LUMA.g * rgba[o + 1] + LUMA.b * rgba[o + 2];
  }
  let sum = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      sum += gx * gx + gy * gy;
      n++;
    }
  }
  return n ? sum / n : 0;
}

/** dimensions AFTER EXIF orientation (what the app sees) */
async function orientedMeta(file) {
  const m = await sharp(file).metadata();
  const swap = m.orientation >= 5 && m.orientation <= 8;
  return {
    width: swap ? m.height : m.width,
    height: swap ? m.width : m.height,
    rawWidth: m.width, rawHeight: m.height,
    orientation: m.orientation, format: m.format,
  };
}

async function appSharpness(file) {
  const meta = await orientedMeta(file);
  const sw = meta.width, sh = meta.height;
  const cw = Math.max(2, Math.round(sw * 0.6));
  const ch = Math.max(2, Math.round(sh * 0.6));
  const cx = Math.round((sw - cw) / 2), cy = Math.round((sh - ch) / 2);
  const w = Math.min(SAMPLE_W, cw);
  const h = Math.max(1, Math.round(ch * (w / cw)));
  const { data, info } = await sharp(file)
    .rotate()
    .extract({ left: cx, top: cy, width: cw, height: ch })
    .resize(w, h, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { score: tenengrad(data, w, h, info.channels), w, h, cw, ch };
}

/** whole frame, downscaled to width 320 */
async function fullSharpness(file) {
  const meta = await orientedMeta(file);
  const w = Math.min(SAMPLE_W, meta.width);
  const h = Math.max(1, Math.round(meta.height * (w / meta.width)));
  const { data, info } = await sharp(file)
    .rotate()
    .resize(w, h, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { score: tenengrad(data, w, h, info.channels), w, h };
}

/** FULL-resolution Tenengrad of a horizontal band - absolute defocus measure */
async function bandSharpness(file, topF, botF) {
  const meta = await orientedMeta(file);
  const h = meta.height;
  const top = Math.round(h * topF), bot = Math.round(h * botF);
  const { data, info } = await sharp(file)
    .rotate()
    .extract({ left: 0, top, width: meta.width, height: bot - top })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { score: tenengrad(data, meta.width, bot - top, info.channels), w: meta.width, h: bot - top };
}

/** EXIF focus/camera tags */
async function exifTags(file) {
  const m = await sharp(file).metadata();
  const out = {};
  if (!m.exif) return out;
  try {
    const exifReader = (await import("exif-reader")).default;
    const parsed = exifReader(m.exif);
    const want = ["Model", "Make", "LensModel", "FNumber", "ExposureTime", "ISO",
      "FocalLength", "FocalLengthIn35mmFormat", "Orientation", "DateTimeOriginal",
      "DigitalZoomRatio", "WhiteBalance", "MeteringMode", "LightSource"];
    for (const k of want) {
      const v = parsed[k];
      if (v !== undefined && v !== null) out[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
    }
  } catch {
    out._raw = "exif-reader unavailable";
  }
  return out;
}

const files = process.argv.slice(2);
for (const f of files) {
  if (!fs.existsSync(f)) { console.log("MISSING", f); continue; }
  const meta = await orientedMeta(f);
  const app = await appSharpness(f);
  const full = await fullSharpness(f);
  const bandTop = await bandSharpness(f, 0.0, 0.33);
  const bandMid = await bandSharpness(f, 0.33, 0.66);
  const bandBot = await bandSharpness(f, 0.66, 1.0);
  const ex = await exifTags(f);
  const stat = fs.statSync(f);
  console.log("=".repeat(76));
  console.log("FILE   ", f.split(/[\\/]/).pop());
  console.log("DIMS   ", `${meta.width}x${meta.height} (raw ${meta.rawWidth}x${meta.rawHeight}, orientation ${meta.orientation})`,
    "format:", meta.format, "bytes:", stat.size);
  console.log("APP centre60% @320 Tenengrad :", app.score.toFixed(1), `(sample ${app.w}x${app.h} from ${app.cw}x${app.ch})`);
  console.log("FULL frame      @320 Tenengrad :", full.score.toFixed(1));
  console.log("FULLRES top33%  Tenengrad     :", bandTop.score.toFixed(1), `(${bandTop.w}x${bandTop.h})`);
  console.log("FULLRES mid33%  Tenengrad     :", bandMid.score.toFixed(1), `(${bandMid.w}x${bandMid.h})`);
  console.log("FULLRES bot33%  Tenengrad     :", bandBot.score.toFixed(1), `(${bandBot.w}x${bandBot.h})`);
  if (Object.keys(ex).length) console.log("EXIF   ", JSON.stringify(ex, null, 2).replace(/\n/g, "\n        "));
}
