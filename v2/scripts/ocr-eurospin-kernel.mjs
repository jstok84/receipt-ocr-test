/**
 * EUROSPIN kernel A/B (2026-10-20): is the resampler the reason the browser
 * band cascade garbles FROLLINI where the sharp bench read 1,55? Same band
 * pixels ({left:205,top:280,w:750,h:1320}, y 40-75% of it, 2x), two PURE-JS
 * rescuers mirrored from the browser code:
 *   - catrom  : exact weights of src/ocrUtils.js bicubicUpscaleGrayCanvas
 *               (no normalization, 4 taps, (d+0.5)/f-0.5 center mapping)
 *   - lanczos3: separable windowed sinc, a=3, 6 taps, normalized
 * plus sharp lanczos3 (the bench winner) and nearest as control.
 * If catrom reads 1,55 here, the kernel is exonerated (browser failure is
 * app-image/geometry/PSM specific). If only lanczos3 reads it, a custom JS
 * lanczos swap in the band cascade is justified. Import-time startup reads:
 * none — pure computation, same as in-app usage.
 */
import { createWorker } from "tesseract.js";
import sharp from "sharp";

const SRC = "samples/scan-eurospin.jpg";
const CROP = { left: 205, top: 280, width: 750, height: 1320 };
const BAND = [0.4, 0.75];
const FACTOR = 2;

// --- source pixels: gray + linear(1.6,-80), same as app/bench ---
const bandH = Math.round(CROP.height * (BAND[1] - BAND[0]));
const bandTop = CROP.top + Math.round(CROP.height * BAND[0]);
const { data: gray, info } = await sharp(SRC)
  .extract({ left: CROP.left, top: bandTop, width: CROP.width, height: bandH })
  .grayscale()
  .linear(1.6, -80)
  .raw()
  .toBuffer({ resolveWithObject: true });
const sw = info.width;
const sh = info.height;
const dw = Math.round(sw * FACTOR);
const dh = Math.round(sh * FACTOR);

function resample(mode) {
  const out = Buffer.alloc(dw * dh);
  const weightFor =
    mode === "catrom"
      ? (t) => {
          const s = Math.abs(t);
          let w = 0;
          if (s <= 1) w = 1.5 * s * s * s - 2.5 * s * s + 1;
          else if (s < 2) w = -0.5 * s * s * s + 2.5 * s * s - 4 * s + 2;
          return w;
        }
      : (t) => {
          const s = Math.abs(t);
          if (s >= 3) return 0;
          if (s < 1e-8) return 1;
          const sinc = (x) => Math.sin(Math.PI * x) / (Math.PI * x);
          return sinc(s) * sinc(s / 3);
        };
  const taps = mode === "catrom" ? 4 : 6;
  const half = taps / 2 - 1; // first tap offset: base + (0..taps-1) - (taps/2)
  const px = (x, y) => gray[Math.max(0, Math.min(sh - 1, y)) * sw + Math.max(0, Math.min(sw - 1, x))];
  const xW = []; const xB = [];
  for (let dx = 0; dx < dw; dx++) {
    const sx = (dx + 0.5) / FACTOR - 0.5;
    const base = Math.floor(sx) - half;
    const w = [];
    for (let k = 0; k < taps; k++) w.push(weightFor(sx - (base + k)));
    if (mode !== "catrom") { // normalize truncated sinc
      const sum = w.reduce((a, b) => a + b, 0) || 1;
      for (let k = 0; k < taps; k++) w[k] /= sum;
    }
    xB.push(base); xW.push(w);
  }
  for (let dy = 0; dy < dh; dy++) {
    const sy = (dy + 0.5) / FACTOR - 0.5;
    const yBase = Math.floor(sy) - half;
    const yW = [];
    for (let k = 0; k < taps; k++) yW.push(weightFor(sy - (yBase + k)));
    if (mode !== "catrom") {
      const sum = yW.reduce((a, b) => a + b, 0) || 1;
      for (let k = 0; k < taps; k++) yW[k] /= sum;
    }
    // horizontal pass cached per row-tap
    for (let dy2 = dy; dy2 < Math.min(dh, dy + 1); dy2++) {}
    for (let dx = 0; dx < dw; dx++) {
      const base = xB[dx];
      const w = xW[dx];
      let acc = 0;
      for (let j = 0; j < taps; j++) {
        let colAcc = 0;
        for (let k = 0; k < taps; k++) colAcc += px(base + k, yBase + j) * w[k];
        acc += colAcc * yW[j];
      }
      out[dy * dw + dx] = Math.max(0, Math.min(255, Math.round(acc)));
    }
  }
  return sharp(out, { raw: { width: dw, height: dh, channels: 1 } }).png().toBuffer();
}

const variants = [
  ["nearest", null],
  ["catrom", await resample("catrom")],
  ["lanczos3-js", await resample("lanczos3")],
  ["lanczos3-sharp", await sharp(SRC).extract({ left: CROP.left, top: bandTop, width: CROP.width, height: bandH })
    .grayscale().linear(1.6, -80).resize({ width: dw, kernel: "lanczos3" }).png().toBuffer()],
];
// nearest control rendered by sharp for simplicity
variants[0][1] = await sharp(SRC).extract({ left: CROP.left, top: bandTop, width: CROP.width, height: bandH })
  .grayscale().linear(1.6, -80).resize({ width: dw, kernel: "nearest" }).png().toBuffer();

for (const [name, image] of variants) {
  for (const psm of (name === "nearest" ? ["6"] : ["6", "4"])) {
    const w = await createWorker("slv+eng", 1);
    await w.setParameters({ preserve_interword_spaces: "1", user_defined_dpi: "300", tessedit_pageseg_mode: psm });
    const { data } = await w.recognize(image);
    await w.terminate();
    const lines = data.text.split("\n").filter(Boolean);
    const frow = lines.find((l) => /roll/i.test(l)) ?? null;
    const hit = /1\s*[.,]\s*55/.test(data.text);
    console.log(name.padEnd(14), `psm${psm}`, `1,55:${hit ? "Y" : "N"}`, JSON.stringify(frow));
  }
}
