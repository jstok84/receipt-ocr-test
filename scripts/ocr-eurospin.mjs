/**
 * EUROSPIN photo: black mesh background full of hexagon texture + crease.
 * Test: lossless tight crop isolates the paper from背景 texture; per-stage nudges.
 * Anchors: item amounts 1,55/1,29/1,45, totals 4,29/13,00/8,71.
 */
import { createWorker } from "tesseract.js";
import sharp from "sharp";
import fs from "node:fs/promises";

const SRC = "samples/scan-eurospin.jpg";
const OUT = "samples";

const PARAMS = {
  tessedit_pageseg_mode: "6",
  preserve_interword_spaces: "1",
  user_defined_dpi: "300",
};

const CROP = { left: 235, top: 280, width: 705, height: 1320 };

const variants = [
  { name: "ctl-gray2x",  prep: v => v.grayscale().resize({ width: 2560, kernel: "lanczos3" }) },
  { name: "crop-gray2x", prep: v => v.grayscale().extract(CROP).resize({ width: 2115, kernel: "lanczos3" }) },
  { name: "crop-med3",   prep: v => v.grayscale().extract(CROP).median(3).resize({ width: 2115, kernel: "lanczos3" }) },
  { name: "crop-lin",    prep: v => v.grayscale().extract(CROP).linear(1.6, -80).resize({ width: 2115, kernel: "lanczos3" }) },
  { name: "crop-sharp",  prep: v => v.grayscale().extract(CROP).sharpen({ sigma: 1 }).resize({ width: 2115, kernel: "lanczos3" }) },
];

for (const v of variants) {
  const t0 = Date.now();
  const image = await v.prep(sharp(SRC)).png().toBuffer();
  const worker = await createWorker("slv+eng", 1);
  await worker.setParameters(PARAMS);
  const { data } = await worker.recognize(image);
  await worker.terminate();
  await fs.writeFile(`${OUT}/ocr-eurospin-${v.name}.txt`, data.text, "utf8");
  const t = data.text.toLowerCase().replaceAll("č", "c").replaceAll("š", "s").replaceAll("ž", "z");
  const anchors = ["1,55", "1,29", "1,45", "4,29", "13,00", "8,71", "frollini", "taralli", "cokoladni"]
    .map((s) => `${s}:${t.includes(s) ? "y" : "n"}`);
  const ms = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${v.name.padEnd(13)} chars=${String(data.text.length).padStart(4)} ${anchors.join(" ")} ${ms}s`);
}
