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
    const width = image.displayWidth;
    const height = image.displayHeight;
    // VideoFrame's native format is NOT RGBA — decoded JPEG/PNG frames come back
    // as I420 (planar YUV), whose allocationSize is w*h*1.5. Reading that as RGBA
    // silently produces garbage (it cost one debugging round: 3 items -> 2 items
    // and the total vanished). Ask copyTo to convert, and size the buffer for RGBA.
    const rgba = new Uint8ClampedArray(width * height * 4);
    await image.copyTo(rgba, { format: "RGBA" });
    image.close();
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
