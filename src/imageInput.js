/**
 * Input identification and normalisation.
 *
 * WHY BYTES AND NOT file.type
 * Chromium reports an EMPTY file.type for .heic, so the upload gate
 * (`file.type.startsWith("image/")`) rejected every iPhone photo with
 * "unsupported file type". The same gap mislabels a HEIF/AVIF file that was
 * renamed to .jpg. Reading the first bytes of the user's own file fixes both.
 *
 * THIS IS NOT FINGERPRINTING
 * Fingerprinting derives a stable identifier from DEVICE characteristics
 * (canvas pixels, fonts, WebGL, user agent) to recognise a user across visits.
 * This reads the user's own uploaded content and returns a format string used
 * only to pick a decoder: it is not stable across sessions, is never stored or
 * transmitted, and cannot distinguish users — only formats. It replaces a
 * browser-supplied MIME string with the file's own content, so the app learns
 * strictly less about the browser than before.
 *
 * Adblockers filter network requests and DOM nodes; reading an ArrayBuffer of a
 * file the user selected is local computation with nothing to match.
 */

// HEIF/HEIC brands that carry HEVC — Chromium cannot decode these natively.
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"]);

/**
 * Identify an image container from its leading bytes.
 * Returns "jpeg" | "png" | "webp" | "avif" | "heic" | null.
 */
export function sniffImageType(bytes) {
  const b = bytes;
  if (!b || b.length < 12) return null;

  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";

  // RIFF....WEBP
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return "webp";

  // ISO-BMFF: bytes 4..7 == "ftyp", brand at 8..11
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]).trim().toLowerCase();
    if (brand === "avif" || brand === "avis") return "avif";
    if (HEIF_BRANDS.has(brand)) return "heic";
  }

  return null;
}

/** PDF: %PDF- */
export function looksLikePDF(bytes) {
  return (
    bytes && bytes.length >= 4 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
  );
}

async function readHead(file, n = 32) {
  const slice = file.slice(0, n);
  return new Uint8Array(await slice.arrayBuffer());
}

/**
 * Classify a dropped file: "image" | "pdf" | "other".
 * Bytes win; file.type is only a fallback when the head is unreadable.
 */
export async function detectFileKind(file) {
  try {
    const head = await readHead(file);
    if (looksLikePDF(head)) return "pdf";
    if (sniffImageType(head)) return "image";
  } catch {
    /* fall through to the MIME hint */
  }
  if (file.type === "application/pdf") return "pdf";
  if (file.type.startsWith("image/")) return "image";
  return "other";
}

/**
 * Decode a HEIC/HEIF file to a PNG data URL.
 *
 * libheif is a WASM build: the decode is byte-identical in every browser, so a
 * HEIC receipt parses the same in Edge, Chrome and Brave regardless of profile
 * (WASM is unaffected by fingerprinting protection). It is imported lazily so
 * the ~2 MB chunk is only fetched when a HEIC actually arrives.
 */
async function heicToDataURL(file) {
  const mod = await import("libheif-js/wasm-bundle");
  // CJS interop: the module exports the instantiated libheif module. Some
  // bundler paths surface the Emscripten factory instead — call it if so.
  const raw = mod?.default ?? mod;
  const libheif = typeof raw === "function" ? raw() : raw;
  if (!libheif || typeof libheif.HeifDecoder !== "function") {
    throw new Error("HEIF decoder unavailable");
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  const images = new libheif.HeifDecoder().decode(buf);
  if (!images.length) throw new Error("HEIF contains no decodable image");

  // A HEIC can carry thumbnails; take the largest frame.
  let best = images[0];
  for (const img of images) {
    if (img.get_width() * img.get_height() > best.get_width() * best.get_height()) best = img;
  }

  const width = best.get_width();
  const height = best.get_height();
  const out = await new Promise((resolve) => {
    best.display(
      { data: new Uint8ClampedArray(width * height * 4), width, height },
      (d) => resolve(d)
    );
  });
  if (!out) throw new Error("HEIF pixel extraction failed");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(out.data, width, height), 0, 0);
  // PNG, not JPEG: lossless, so the decoder never adds its own artefacts to the
  // pixels the OCR then reads.
  return { dataURL: canvas.toDataURL("image/png"), width, height };
}

/**
 * Turn any accepted image into something processImage can consume.
 * JPEG/PNG/WebP/AVIF pass through UNCHANGED (the File itself), so their path
 * is byte-for-byte what it was before this module existed.
 * HEIC/HEIF are decoded to a PNG data URL.
 */
export async function toProcessableSource(file) {
  let type = null;
  try {
    type = sniffImageType(await readHead(file));
  } catch {
    type = null;
  }

  if (type === "heic") {
    const { dataURL, width, height } = await heicToDataURL(file);
    return { src: dataURL, previewURL: dataURL, converted: "heic", type, width, height };
  }

  return { src: file, previewURL: URL.createObjectURL(file), converted: null, type };
}
