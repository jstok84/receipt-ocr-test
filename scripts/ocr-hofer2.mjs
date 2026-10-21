/**
 * HOFER rescue attempt round 2: bleed-through + wasted-frame treatment.
 * Metric that matters: does the missing "1,79" (Krüger row, top-clipped)
 * show up, plus amount-line count sanity.
 *   A  control (current default: gray 2x)
 *   B  +median3  (median = kills thin mirrored strokes, keeps fat glyphs)
 *   C  +median5
 *   D  +linear contrast stretch
 *   E  fixed manual crop (from direct photo inspection) + gray 2x
 *   F  manual crop + median3
 *   G  control but PSM 11 (sparse text)
 */
import { createWorker } from "tesseract.js";
import sharp from "sharp";
import fs from "node:fs/promises";

const SRC = "samples/hofer-scan.jpg";
const OUT = "samples";

const PARAMS = {
  preserve_interword_spaces: "1",
  user_defined_dpi: "300",
};

// receipt occupies roughly x 390..1040 of 1280 (from direct inspection of the photo)
const CROP = { left: 370, top: 0, width: 680, height: 961 };

const variants = [
  { name: "ctl-gray2x",      prep: v => v.grayscale().resize({ width: 2560, kernel: "lanczos3" }), psm: "6" },
  { name: "med3",            prep: v => v.grayscale().median(3).resize({ width: 2560, kernel: "lanczos3" }), psm: "6" },
  { name: "med5",            prep: v => v.grayscale().median(5).resize({ width: 2560, kernel: "lanczos3" }), psm: "6" },
  { name: "lin-stretch",     prep: v => v.grayscale().linear(1.7, -96).resize({ width: 2560, kernel: "lanczos3" }), psm: "6" },
  { name: "crop-gray2x",     prep: v => v.grayscale().extract(CROP).resize({ width: 2040, kernel: "lanczos3" }), psm: "6" },
  { name: "crop-med3",       prep: v => v.grayscale().extract(CROP).median(3).resize({ width: 2040, kernel: "lanczos3" }), psm: "6" },
  { name: "ctl-psm11",       prep: v => v.grayscale().resize({ width: 2560, kernel: "lanczos3" }), psm: "11" },
];

for (const v of variants) {
  const t0 = Date.now();
  const image = await v.prep(sharp(SRC)).png().toBuffer();
  const worker = await createWorker("slv+eng", 1);
  await worker.setParameters({ ...PARAMS, tessedit_pageseg_mode: v.psm });
  const { data } = await worker.recognize(image);
  await worker.terminate();
  await fs.writeFile(`${OUT}/ocr-hofer2-${v.name}.txt`, data.text, "utf8");
  const t = data.text.toLowerCase();
  const amountLines = data.text.split("\n").filter((l) => /\d[.,]\d{2}\b/.test(l)).length;
  const oneSeventyNine = t.includes("1,79") || t.includes("1.79");
  const ms = ((Date.now() - t0) / 1000).toFixed(1);
  const anchors = [
    ["1,79", oneSeventyNine ? "y" : "N"],
    ["barcaffe", t.includes("barcaffe") ? "y" : "n"],
    ["4,73", (t.includes("4,73") || t.includes("4.73")) ? "y" : "n"],
    ["kruger", t.includes("kruger") ? "y" : "n"],
  ].map(([k, s]) => `${k}:${s}`).join(" ");
  console.log(`${v.name.padEnd(13)} chars=${String(data.text.length).padStart(4)} amtLines=${amountLines} ${anchors} ${ms}s`);
}
