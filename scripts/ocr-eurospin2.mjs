/**
 * EUROSPIN round 2: the tight crop is human-legible (verified), so tesseract's
 * remaining failures = geometry. Try small deskew rotations + edge fixes.
 * Targets: row-1 "1,55", "Za plačilo ... 4,29" (crease line), "Gotovina/Vrnjen".
 */
import { createWorker } from "tesseract.js";
import sharp from "sharp";
import fs from "node:fs/promises";

const SRC = "samples/scan-eurospin.jpg";
const OUT = "samples";

const PARAMS = {
  preserve_interword_spaces: "1",
  user_defined_dpi: "300",
};

// slightly wider left so "KEKSI/K"/"ZA" first letters survive
const CROP = { left: 225, top: 280, width: 730, height: 1320 };

const variants = [
  { name: "rot-3-sharp",  deg: -3.0, extra: s => s.sharpen({ sigma: 1 }) },
  { name: "rot-2-sharp",  deg: -2.0, extra: s => s.sharpen({ sigma: 1 }) },
  { name: "rot-1-sharp",  deg: -1.0, extra: s => s.sharpen({ sigma: 1 }) },
  { name: "rot2-sharp",   deg: 2.0,  extra: s => s.sharpen({ sigma: 1 }) },
  { name: "rot-2-lin",    deg: -2.0, extra: s => s.linear(1.6, -80) },
  { name: "rot-2-4x",     deg: -2.0, extra: s => s, width: 2920 },
  { name: "rot0-psm4",    deg: 0,    extra: s => s.sharpen({ sigma: 1 }), psm: "4" },
];

for (const v of variants) {
  const t0 = Date.now();
  let pipe = sharp(SRC).extract(CROP).grayscale();
  if (v.deg) pipe = pipe.rotate(v.deg, { background: "#ffffff" });
  pipe = v.extra(pipe);
  const image = await pipe.resize({ width: v.width ?? 2190, kernel: "lanczos3" }).png().toBuffer();
  const worker = await createWorker("slv+eng", 1);
  await worker.setParameters({ ...PARAMS, tessedit_pageseg_mode: v.psm ?? "6" });
  const { data } = await worker.recognize(image);
  await worker.terminate();
  await fs.writeFile(`${OUT}/ocr-eurospin2-${v.name}.txt`, data.text, "utf8");
  const t = data.text.toLowerCase().replaceAll("č", "c").replaceAll("š", "s").replaceAll("ž", "z");
  const anchors = ["1,55", "1,29", "1,45", "4,29", "13,00", "8,71"]
    .map((s) => `${s}:${t.includes(s) ? "y" : "n"}`);
  const placiloLine = data.text.split("\n").find((l) => /la[čc]il|laci/i.test(l)) ?? "";
  const ms = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${v.name.padEnd(11)} ${anchors.join(" ")} | placilo="${placiloLine.trim().slice(0, 50)}" ${ms}s`);
}
