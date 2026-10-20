/**
 * OCR benchmark: A/B/C test on the real SPAR receipt photo.
 * Variants: fast-vs-best language data, upscale, PSM 4 vs 6.
 * Score = ground-truth tokens found in the OCR text (26 item tokens,
 * both totals, coupon + loyalty amounts, date+time), diacritics-insensitive.
 * Full OCR text of every variant is saved to samples/ocr-<variant>.txt.
 */
import { createWorker } from "tesseract.js";
import sharp from "sharp";
import fs from "node:fs/promises";

const SRC = "samples/spar-scan.jpg";
const OUT = "samples";

const BASE_PARAMS = {
  tessedit_pageseg_mode: "6",
  preserve_interword_spaces: "1",
  user_defined_dpi: "300",
};

const BEST_LANGPATH = "https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_best@4.1.0";

const variants = [
  { name: "1-fast-psm6",          fast: true,  prep: null, psm: "6" },
  { name: "2-fast-up2-psm6",      fast: true,  prep: "up2", psm: "6" },
  { name: "3-best-psm6",          fast: false, prep: null, psm: "6" },
  { name: "4-best-up2-psm6",      fast: false, prep: "up2", psm: "6" },
  { name: "5-best-up2-psm4",      fast: false, prep: "up2", psm: "4" },
  { name: "6-fast-up2-psm4",      fast: true,  prep: "up2", psm: "4" },
];

const ITEM_TOKENS = [
  "pizza", "kroketi", "svaljki", "caj lipa", "zhagoval", "jogurt athentikos",
  "fruc", "ovseni boom", "trajno hleb", "kosmic", "beef jerky", "lino lada",
  "ovsena gozd", "snih cili", "petersilj", "carbonara", "cebula zrnasta",
  "ribani lahki", "granny", "vaf.kar", "kinder maki", "maslo", "vaflj",
  "jajca talna", "omaka bazilika", "ajvar polpek",
];
const VALUE_TOKENS = ["57.35 / 57,35", "51.61 / 51,61", "5.74 / 5,74", "32.23 / 32,23", "10.36 / 10,36", "05.02.2022 / 05,02.2022"];

function normalize(s) {
  return s.toLowerCase().replaceAll("č", "c").replaceAll("š", "s").replaceAll("ž", "z");
}

function score(text) {
  const t = normalize(text);
  const foundItems = ITEM_TOKENS.filter((w) => {
    const needle = normalize(w).split(" ").map((p) => p.replace("[.]", "[,]")).join(" ");
    return t.includes(needle);
  });
  // value tokens listed as "x / y" alternatives: either decimal form counts
  const foundValues = VALUE_TOKENS.filter((pair) => {
    return pair.split(" / ").every((alt) => t.includes(normalize(alt)));
  });
  const timeOk = t.includes("11:39");
  return { items: foundItems, values: foundValues, timeOk, score: foundItems.length * 2 + foundValues.length * 3 + (timeOk ? 2 : 0) };
}

for (const v of variants) {
  const t0 = Date.now();
  let image;
  if (v.prep === "up2") {
    image = await sharp(SRC).resize({ width: 3400, kernel: "lanczos3" }).grayscale().png().toBuffer();
  } else {
    image = await sharp(SRC).png().toBuffer();
  }
  const worker = await createWorker("slv+eng", 1, v.fast ? {} : { langPath: BEST_LANGPATH, gzip: false, cachePath: `${OUT}/tess-cache` });
  await worker.setParameters({ ...BASE_PARAMS, tessedit_pageseg_mode: v.psm });
  const { data } = await worker.recognize(image);
  await worker.terminate();
  await fs.writeFile(`${OUT}/ocr-${v.name}.txt`, data.text, "utf8");
  const s = score(data.text);
  const ms = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `${v.name.padEnd(18)} score=${String(s.score).padStart(3)}  items=${s.items.length}/26  values=${s.values.length}/6  time=${s.timeOk ? "y" : "n"}  ${ms}s  chars=${data.text.length}`
  );
}
