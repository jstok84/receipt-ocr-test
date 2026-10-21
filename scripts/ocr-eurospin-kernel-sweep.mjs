/**
 * EUROSPIN kernel SWEEP (2026-10-20): kernel A/B showed catrom losing the
 * FROLLINI row at PSM 6 while lanczos3-js read it — but the band window also
 * shifts everything (sharp lanczos3 read 1,55 at 42-72% and garbled 1,854 at
 * 40-75%). This sweep asks the adopt/no-adopt question properly: is
 * lanczos3-js consistently better than catrom across band windows, or was
 * the first result one lucky cell? Bands bracketing the item block, PSM 6
 * (the dominant failure mode), same pipeline as ocr-eurospin-kernel.mjs.
 */
import { createWorker } from "tesseract.js";
import sharp from "sharp";

const SRC = "samples/scan-eurospin.jpg";
const CROP = { left: 205, top: 280, width: 750, height: 1320 };
const FACTOR = 2;

function buildResampler(gray, sw, sh) {
  const px = (x, y) => gray[Math.max(0, Math.min(sh - 1, y)) * sw + Math.max(0, Math.min(sw - 1, x))];
  return function resample(mode, factor) {
    const dw = Math.round(sw * factor);
    const dh = Math.round(sh * factor);
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
    const half = taps / 2 - 1;
    const norm = mode !== "catrom";
    const xW = []; const xB = [];
    for (let dx = 0; dx < dw; dx++) {
      const sx = (dx + 0.5) / factor - 0.5;
      const base = Math.floor(sx) - half;
      const w = [];
      for (let k = 0; k < taps; k++) w.push(weightFor(sx - (base + k)));
      if (norm) { const sum = w.reduce((a, b) => a + b, 0) || 1; for (let k = 0; k < taps; k++) w[k] /= sum; }
      xB.push(base); xW.push(w);
    }
    for (let dy = 0; dy < dh; dy++) {
      const sy = (dy + 0.5) / factor - 0.5;
      const yBase = Math.floor(sy) - half;
      const yW = [];
      for (let k = 0; k < taps; k++) yW.push(weightFor(sy - (yBase + k)));
      if (norm) { const sum = yW.reduce((a, b) => a + b, 0) || 1; for (let k = 0; k < taps; k++) yW[k] /= sum; }
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
  };
}

const bands = [[0.4, 0.75], [0.42, 0.72], [0.35, 0.75], [0.3, 0.75]];
for (const band of bands) {
  const bandH = Math.round(CROP.height * (band[1] - band[0]));
  const bandTop = CROP.top + Math.round(CROP.height * band[0]);
  const { data: gray, info } = await sharp(SRC)
    .extract({ left: CROP.left, top: bandTop, width: CROP.width, height: bandH })
    .grayscale()
    .linear(1.6, -80)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const resample = buildResampler(gray, info.width, info.height);
  for (const mode of ["catrom", "lanczos3-js"]) {
    const image = await resample(mode, FACTOR);
    const w = await createWorker("slv+eng", 1);
    await w.setParameters({ preserve_interword_spaces: "1", user_defined_dpi: "300", tessedit_pageseg_mode: "6" });
    const { data } = await w.recognize(image);
    await w.terminate();
    const lines = data.text.split("\n").filter(Boolean);
    const frow = lines.find((l) => /roll/i.test(l)) ?? null;
    const hit = /1\s*[.,]\s*55/.test(data.text);
    const taralli = /1\s*[.,]\s*29/.test(data.text);
    const cok = /1\s*[.,]\s*45/.test(data.text);
    console.log(`${band.join("-")}`.padEnd(10), mode.padEnd(11), `155:${hit ? "Y" : "N"}`, `129:${taralli ? "Y" : "N"}`, `145:${cok ? "Y" : "N"}`, JSON.stringify(frow));
  }
}
