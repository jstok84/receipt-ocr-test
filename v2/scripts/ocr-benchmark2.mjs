/**
 * Preprocessing A/B: which image stage hurts digit recognition?
 * Raw 2x grayscale (OCR benchmark winner) is the baseline; each variant adds
 * ONE cheap approximation of the browser's OpenCV pipeline stage:
 *   invert / clahe / unsharp / normalise / global-threshold.
 * Scored like ocr-benchmark.mjs, with AJVAR's 1.19 as a dedicated value token.
 */
import { createWorker } from "tesseract.js";
import sharp from "sharp";
import fs from "node:fs/promises";

const SRC = "samples/spar-scan.jpg";
const OUT = "samples";

const PARAMS = {
  tessedit_pageseg_mode: "6",
  preserve_interword_spaces: "1",
  user_defined_dpi: "300",
};

const variants = [
  { name: "A-plain-gray",    fns: [v => v.grayscale()] },
  { name: "B-invert",        fns: [v => v.grayscale().negate()] },
  { name: "C-clahe",         fns: [v => v.grayscale().clahe({ width: 8, height: 8 })] },
  { name: "D-unsharp",       fns: [v => v.grayscale().sharpen({ sigma: 1 })] },
  { name: "E-normalise",     fns: [v => v.grayscale().normalise()] },
  { name: "F-threshold128",  fns: [v => v.grayscale().threshold(128)] },
  { name: "G-stack-C-D-F",   fns: [v => v.grayscale().clahe({ width: 8, height: 8 }).sharpen({ sigma: 1 }).threshold(128)] },
];

const ITEM_TOKENS = [
  "pizza", "kroketi", "svaljki", "caj lipa", "zhagoval", "jogurt athentikos",
  "fruc", "ovseni boom", "trajno hleb", "kosmic", "beef jerky", "lino lada",
  "ovsena gozd", "snih cili", "petersilj", "carbonara", "cebula zrnasta",
  "ribani lahki", "granny", "vaf.kar", "kinder", "maslo", "vaflj",
  "jajca talna", "omaka bazilika", "ajvar polpek",
];
const VALUE_TOKENS = ["1.19 / 1,19", "57.35 / 57,35", "51.61 / 51,61", "32.23 / 32,23", "33.23 / 33,23", "5.74 / 5,74", "10.36 / 10,36"];

function normalize(s) {
  return s.toLowerCase().replaceAll("č", "c").replaceAll("š", "s").replaceAll("ž", "z");
}
function score(text) {
  const t = normalize(text);
  const items = ITEM_TOKENS.filter((w) => t.includes(normalize(w)));
  const values = VALUE_TOKENS.filter((pair) => pair.split(" / ").every((a) => t.includes(normalize(a))));
  return { items, values, score: items.length * 2 + values.length * 3 };
}

for (const v of variants) {
  const t0 = Date.now();
  let p = sharp(SRC).resize({ width: 3400, kernel: "lanczos3" });
  for (const f of v.fns) p = f(p);
  const image = await p.png().toBuffer();
  const worker = await createWorker("slv+eng", 1);
  await worker.setParameters(PARAMS);
  const { data } = await worker.recognize(image);
  await worker.terminate();
  await fs.writeFile(`${OUT}/ocr-${v.name}.txt`, data.text, "utf8");
  const s = score(data.text);
  const ms = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${v.name.padEnd(13)} score=${String(s.score).padStart(3)} items=${s.items.length}/26 values=${s.values.length}/7 ${ms}s`);
  // show what AJVAR got read as, in every variant
  const aj = data.text.split("\n").find((l) => /ajvar|ajbar|airvar/i.test(l));
  console.log(`                 ajvar line: ${(aj || "(missing)").trim().slice(0, 70)}`);
}
