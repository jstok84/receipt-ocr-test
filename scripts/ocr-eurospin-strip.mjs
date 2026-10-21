/**
 * EUROSPIN strip-experiment (2026-10-20): the HOFER rescue measured the
 * garbled top-row price by re-OCRing the top 25% at 3x + PSM variety. Here:
 * can any strip variant read FROLLINI's price as 1,55 (the 2x main pass
 * reads 1,95 — suspected pixel-level 5->9)? Receipt crop from
 * scripts/ocr-eurospin3.mjs (left 205, top 280, 750x1320).
 * FROLLINI row sits at the top of the item block (~top 20% of receipt).
 */
import { createWorker } from "tesseract.js";
import sharp from "sharp";

const SRC = "samples/scan-eurospin.jpg";
const CROP = { left: 205, top: 280, width: 750, height: 1320 };

const variants = [];
for (const frac of [0.18, 0.25, 0.35]) {
  for (const zoom of [2, 3]) {
    for (const psm of ["6", "4"]) {
      variants.push({ frac, zoom, psm });
    }
  }
}

for (const v of variants) {
  const bh = Math.round(CROP.height * v.frac);
  const image = await sharp(SRC)
    .extract({ left: CROP.left, top: CROP.top, width: CROP.width, height: bh })
    .grayscale()
    .linear(1.6, -80)
    .resize({ width: CROP.width * v.zoom, kernel: "lanczos3" })
    .png()
    .toBuffer();
  const w = await createWorker("slv+eng", 1);
  await w.setParameters({ preserve_interword_spaces: "1", user_defined_dpi: "300", tessedit_pageseg_mode: v.psm });
  const { data } = await w.recognize(image);
  await w.terminate();
  const lines = data.text.split("\n").filter(Boolean);
  const frollini = lines.find((l) => /roll|fro/i.test(l));
  const hit155 = /1[.,]\s*55/.test(data.text);
  console.log(
    `f${v.frac} z${v.zoom} psm${v.psm}`.padEnd(18),
    `1,55:${hit155 ? "y" : "N"}`,
    JSON.stringify(frollini ?? null)
  );
}
