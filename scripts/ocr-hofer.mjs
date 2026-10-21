/**
 * HOFER receipt photo diagnostic: 1280x961 HEIF masquerading as .jpg,
 * faded thermal print, item rows missing in the browser OCR run.
 * Variants: upscale (2x vs 4x), contrast stages (negate/unsharp/normalise/clahe),
 * which were the SPAR-banned stages this faint-print class may actually want.
 * Full text per variant -> samples/ocr-hofer-*.txt
 */
import { createWorker } from "tesseract.js";
import sharp from "sharp";
import fs from "node:fs/promises";

const SRC = "samples/hofer-scan.jpg";
const OUT = "samples";

const PARAMS = {
  tessedit_pageseg_mode: "6",
  preserve_interword_spaces: "1",
  user_defined_dpi: "300",
};

const variants = [
  { name: "up2",          prep: v => v.grayscale().resize({ width: 2560, kernel: "lanczos3" }) },
  { name: "up4",          prep: v => v.grayscale().resize({ width: 5120, kernel: "lanczos3" }) },
  { name: "up4-negate",   prep: v => v.grayscale().resize({ width: 5120, kernel: "lanczos3" }).negate() },
  { name: "up4-unsharp",  prep: v => v.grayscale().resize({ width: 5120, kernel: "lanczos3" }).sharpen({ sigma: 1 }) },
  { name: "up4-normalise",prep: v => v.grayscale().resize({ width: 5120, kernel: "lanczos3" }).normalise() },
  { name: "up4-clahe",    prep: v => v.grayscale().resize({ width: 5120, kernel: "lanczos3" }).clahe({ width: 8, height: 8 }) },
];

for (const v of variants) {
  const t0 = Date.now();
  const image = await v.prep(sharp(SRC)).png().toBuffer();
  const worker = await createWorker("slv+eng", 1);
  await worker.setParameters(PARAMS);
  const { data } = await worker.recognize(image);
  await worker.terminate();
  await fs.writeFile(`${OUT}/ocr-hofer-${v.name}.txt`, data.text, "utf8");
  const t = data.text.toLowerCase();
  const amountLines = data.text.split("\n").filter((l) => /\d[.,]\d{2}\b/.test(l)).length;
  const ms = ((Date.now() - t0) / 1000).toFixed(1);
  const anchors = [
    ["total 4,73", t.includes("4,73") || t.includes("4.73")],
    ["barcaffe", t.includes("barcaffe")],
    ["date 11.03", t.includes("11.03")],
    ["visa", t.includes("visa")],
  ].map(([k, ok]) => `${k}:${ok ? "y" : "n"}`).join(" ");
  console.log(`${v.name.padEnd(13)} chars=${String(data.text.length).padStart(4)} amountLines=${String(amountLines).padStart(2)} ${anchors} ${ms}s`);
}
