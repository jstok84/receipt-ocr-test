/**
 * EUROSPIN round 3: round-2 crop clipped the paper's left edge ("Gotovina" ->
 * "otovina", "ZA PLA_JIO" -> "LACILO"), which is where the totals amounts sit.
 * Shift crop left past the paper edge and sweep small rotations.
 * Win condition: "Za plačilo (EUR): 4,29" AND/OR "Gotovina 13,00"+"Vrnjen denar 8,71".
 */
import { createWorker } from "tesseract.js";
import sharp from "sharp";
import fs from "node:fs/promises";

const SRC = "samples/scan-eurospin.jpg";
const OUT = "samples";
const PARAMS = {
  preserve_interword_spaces: "1",
  user_defined_dpi: "300",
  tessedit_pageseg_mode: "6",
};
const CROP = { left: 205, top: 280, width: 750, height: 1320 };

const variants = [
  { name: "w-2-lin",  deg: -2,   extra: s => s.linear(1.6, -80) },
  { name: "w-25-lin", deg: -2.5, extra: s => s.linear(1.6, -80) },
  { name: "w-3-lin",  deg: -3,   extra: s => s.linear(1.6, -80) },
  { name: "w-2-shp",  deg: -2,   extra: s => s.sharpen({ sigma: 1 }) },
  { name: "w-15-lin", deg: -1.5, extra: s => s.linear(1.6, -80) },
  { name: "w-1-lin",  deg: -1,   extra: s => s.linear(1.6, -80) },
];

for (const v of variants) {
  const t0 = Date.now();
  let pipe = sharp(SRC).extract(CROP).grayscale();
  if (v.deg) pipe = pipe.rotate(v.deg, { background: "#ffffff" });
  const image = await v.extra(pipe).resize({ width: 2250, kernel: "lanczos3" }).png().toBuffer();
  const worker = await createWorker("slv+eng", 1);
  await worker.setParameters(PARAMS);
  const { data } = await worker.recognize(image);
  await worker.terminate();
  await fs.writeFile(`${OUT}/ocr-eurospin3-${v.name}.txt`, data.text, "utf8");
  const t = data.text.toLowerCase().replaceAll("č", "c").replaceAll("š", "s").replaceAll("ž", "z");
  const anchors = ["1,55", "1,29", "1,45", "4,29", "13,00", "8,71", "pl", "denar"]
    .map((s) => `${s}:${t.includes(s) ? "y" : "n"}`);
  const ms = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${v.name.padEnd(9)} ${anchors.join(" ")} ${ms}s`);
}
