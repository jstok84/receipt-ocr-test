/**
 * Canvas-free pixel transport.
 *
 * WHY THIS EXISTS
 * Brave (and any fingerprinting-protected browser) perturbs canvas readback:
 * getImageData / toDataURL return slightly different bytes per profile. The OCR
 * pipeline used to cross the canvas boundary twice — cv.imread(canvas) going in,
 * canvas.toDataURL() coming out — so the same receipt could parse differently in
 * two profiles of the same browser.
 *
 * Measured, same PNG bytes, three contexts:
 *   canvas getImageData   Edge 5e9b7351 | Brave A 8ac0a95d | Brave B ac2e2629
 *   WebCodecs ImageDecoder      5e9b7351 | 5e9b7351        | 5e9b7351
 * So WebCodecs is byte-identical everywhere; canvas is not. This module decodes
 * to raw RGBA without touching a canvas; the caller feeds those bytes straight
 * into OpenCV Mats and the pipeline stays on the WASM side until the very end.
 *
 * The ONLY canvas touch left in the pipeline is the final PNG encoding of the
 * preprocessed grayscale Mat (one canvas, cv.imshow + toDataURL) — PNG because
 * Tesseract ingests it at a sane size: the uncompressed 24-bit BMP alternative
 * for a 2× upscaled 4000×3000 photo is ~144 MB and chokes the worker.
 */

import { sniffImageType } from "./imageInput";

async function toBytes(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === "string" && input.startsWith("data:")) {
    const comma = input.indexOf(",");
    const meta = input.slice(5, comma);
    const body = input.slice(comma + 1);
    const bytes = meta.includes("base64")
      ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(body));
    return bytes;
  }
  // File / Blob
  return new Uint8Array(await input.arrayBuffer());
}

const MIME = { jpeg: "image/jpeg", png: "image/png", avif: "image/avif", webp: "image/webp" };

/**
 * EXIF orientation tag (IFD0 0x0112) from a JPEG's APP1 segment.
 * Returns 1-8, or 1 when absent/unreadable. Only JPEG is parsed — PNG eXif
 * chunks and HEIC rotation boxes do not occur in this app's inputs (measured:
 * the one HEIC in the corpus carries no irot/imir/Exif box at all).
 */
export function parseExifOrientation(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2; // skip SOI
  while (i < bytes.length - 4) {
    if (bytes[i] !== 0xFF) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xD9 || marker === 0xDA) break; // EOI / SOS — no EXIF before here
    const len = dv.getUint16(i + 2);
    if (marker === 0xE1 && len > 8 &&
        bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78 && bytes[i + 6] === 0x69 && bytes[i + 7] === 0x66) {
      const tiff = i + 10; // skip "Exif\0\0"
      const le = bytes[tiff] === 0x49; // "II" = little endian
      const g16 = (o) => dv.getUint16(tiff + o, le);
      const ifd = tiff + dv.getUint32(tiff + 4, le);
      const n = g16(ifd - tiff);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (g16(e - tiff) === 0x0112) {
          const o = g16(e - tiff + 8);
          return o >= 1 && o <= 8 ? o : 1;
        }
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

/**
 * Rearrange a raw (coded-order) RGBA frame into its EXIF display orientation.
 * Iterates destination coordinates and maps back to source — the direction that
 * was pixel-verified against the canvas decode on the corpus (max 7/255 diff,
 * pure ICC noise; every other transform measured >98% diff).
 * `w`/`h` are the SOURCE (coded) dimensions.
 */
function applyExifOrientation(src, w, h, o) {
  if (o === 1) return { data: src, width: w, height: h };
  const swap = o >= 5;
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const dst = new Uint8ClampedArray(src.length);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let sx, sy;
      switch (o) {
        case 2: sx = w - 1 - x; sy = y; break;         // mirror horizontal
        case 3: sx = w - 1 - x; sy = h - 1 - y; break; // rotate 180
        case 4: sx = x;         sy = h - 1 - y; break; // mirror vertical
        case 5: sx = y;         sy = x; break;         // transpose
        case 6: sx = y;         sy = h - 1 - x; break; // rotate 90 CW
        case 7: sx = h - 1 - y; sy = w - 1 - x; break; // transverse
        case 8: sx = w - 1 - y; sy = x; break;         // rotate 90 CCW
      }
      const si = (sy * w + sx) * 4;
      const di = (y * ow + x) * 4;
      dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
    }
  }
  return { data: dst, width: ow, height: oh };
}

/**
 * Decode any accepted input to raw RGBA without touching a canvas.
 * Returns { data: Uint8ClampedArray, width, height, type, via }.
 * `via` records which decoder ran — useful in evidence, never used for
 * behaviour decisions.
 */
export async function decodeToRGBA(input) {
  const bytes = await toBytes(input);
  const type = sniffImageType(bytes);

  // HEIC/HEIF: no HEVC decoder in Chromium, so libheif (WASM) does it. Same
  // bytes in, same pixels out, in every browser and profile.
  if (type === "heic") {
    const mod = await import("libheif-js/wasm-bundle");
    const raw = mod?.default ?? mod;
    const libheif = typeof raw === "function" ? raw() : raw;
    if (!libheif || typeof libheif.HeifDecoder !== "function") throw new Error("HEIF decoder unavailable");
    const images = new libheif.HeifDecoder().decode(bytes);
    if (!images.length) throw new Error("HEIF contains no decodable image");
    let best = images[0];
    for (const img of images) {
      if (img.get_width() * img.get_height() > best.get_width() * best.get_height()) best = img;
    }
    const width = best.get_width();
    const height = best.get_height();
    const out = await new Promise((resolve) => {
      best.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (d) => resolve(d));
    });
    if (!out) throw new Error("HEIF pixel extraction failed");
    return { data: out.data, width, height, type, via: "libheif" };
  }

  const mime = MIME[type];
  if (mime && typeof ImageDecoder !== "undefined") {
    const dec = new ImageDecoder({ data: bytes, type: mime });
    const { image } = await dec.decode();
    // ImageDecoder reports the EXIF-rotated display geometry but hands out the
    // RAW coded frame — copyTo does not apply the rotation, it is metadata only
    // (image.rotation). Reading the buffer as displayWidth x displayHeight
    // shears the image and destroys OCR: every orientation-6 photo in the
    // corpus (all six 4000x3000 s25 shots) went from a tight receipt crop to a
    // full-frame noise cut and a 152 s Tesseract grind. Apply the transform
    // here so the bytes match what the canvas decode produced — the baseline
    // was recorded with canvas, which applies EXIF by default.
    const rawW = image.codedWidth, rawH = image.codedHeight;
    const rotation = image.rotation;
    const width = image.displayWidth;
    const height = image.displayHeight;
    // VideoFrame's native format is NOT RGBA — decoded JPEG/PNG frames come back
    // as I420 (planar YUV), whose allocationSize is w*h*1.5. Reading that as RGBA
    // silently produces garbage (it cost one debugging round: 3 items -> 2 items
    // and the total vanished). Ask copyTo to convert, and size the buffer for RGBA.
    const rgba = new Uint8ClampedArray(width * height * 4);
    await image.copyTo(rgba, { format: "RGBA" });
    image.close();
    let orientation = parseExifOrientation(bytes);
    // The transform must land exactly on the browser's display geometry. If the
    // tag and the decoder disagree (stale/corrupt tag), trust the decoder's own
    // rotation — it defines the geometry — and drop the mirror it can't report.
    const swaps = orientation >= 5;
    if ((swaps ? rawH : rawW) !== width || (swaps ? rawW : rawH) !== height) {
      orientation = rotation === 90 ? 6 : rotation === 270 ? 8 : rotation === 180 ? 3 : 1;
    }
    if (orientation !== 1) {
      const fixed = applyExifOrientation(rgba, rawW, rawH, orientation);
      return { data: fixed.data, width: fixed.width, height: fixed.height, type, via: "webcodecs" };
    }
    return { data: rgba, width, height, type, via: "webcodecs" };
  }

  // Last resort: the browser's own decode through a canvas. Correct, but this is
  // the path fingerprinting protection perturbs — only reached when WebCodecs is
  // unavailable (older engines), never in Edge/Chrome/Brave.
  const blob = new Blob([bytes], { type: mime || "application/octet-stream" });
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { data: img.data, width: bmp.width, height: bmp.height, type, via: "canvas-fallback" };
}

/** RGBA bytes -> cv.Mat (CV_8UC4, RGBA order). Caller owns the Mat. */
export function rgbaToMat(rgba, width, height) {
  if (typeof cv === "undefined") throw new Error("OpenCV.js not loaded");
  // matFromArray is the blessed OpenCV.js path; it copies the data safely.
  return cv.matFromArray(height, width, cv.CV_8UC4, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
}
