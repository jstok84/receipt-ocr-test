/**
 * HOFER strip re-zoom experiment (2026-10-20).
 * Question: the app pipeline (crop -> stretch -> 2x) misreads the top-row price
 * ("Kruger šum.tablete 1,79 B" -> "rr 8"), while the old 4x bench read digits
 * ("1 798"). If a TOP-STRIP re-OCR at 3x/4x yields "1,79" MEASURED, an adaptive
 * strip re-OCR (triggered by the v1.6.9 missing-bucket check) can rescue the
 * clipped row without fabricating data from arithmetic.
 * Metric: does any strip variant read "1,79"/"1.79" on the Krüger line?
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

// strip fractions of the CROPPED receipt height (items region lives at the top)
const STRIPS = [
  { name: "w25", top: 0, height: Math.round(961 * 0.25) },
  { name: "w35", top: 0, height: Math.round(961 * 0.35) },
  { name: "w45", top: 0, height: Math.round(961 * 0.45) },
];

const variants = [];
for (const s of STRIPS) {
  for (const zoom of [3, 4]) {
    variants.push({
      name: `strip${s.name}-z${zoom}`,
      extract: { left: CROP.left, top: CROP.top, width: CROP.width, height: s.height },
      prep: (v) =>
        v.grayscale().linear(1.6, -80).resize({ width: CROP.width * zoom, kernel: "lanczos3" }),
    });
  }
}

for (const v of variants) {
  const t0 = Date.now();
  const image = await v.prep(sharp(SRC).extract(v.extract)).png().toBuffer();
  const worker = await createWorker("slv+eng", 1);
  await worker.setParameters({ ...PARAMS, tessedit_pageseg_mode: "6" });
  const { data } = await worker.recognize(image);
  await worker.terminate();
  await fs.writeFile(`${OUT}/ocr-hofer-strip-${v.name}.txt`, data.text, "utf8");
  const t = data.text.toLowerCase();
  const krugerLine = data.text
    .split("\n")
    .find((l) => /kl?ru| [šs]um/i.test(l) && /\d/.test(l));
  const has179 = /1[,.\s]79(\d|\b)/.test(data.text);
  const ms = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `${v.name.padEnd(12)} chars=${String(data.text.length).padStart(4)} 1,79:${has179 ? "y" : "N"}  krugerLine: ${JSON.stringify(krugerLine ?? null)}  ${ms}s`
  );
}
