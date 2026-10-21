/**
 * Kernel isolation: identical crop (x370..1050, top 25%), identical gray+stretch
 * math — only the upscale kernel differs. If nearest also loses "1,79 8" while
 * lanczos keeps it, the browser's garbling (A B / pre B / prv 7S) is the kernel
 * gap between sharp-lanczos and canvas drawImage.
 */
import { createWorker } from "tesseract.js";
import sharp from "sharp";

const SRC = "samples/hofer-scan.jpg";
const CROP = { left: 370, top: 0, width: 680, height: Math.round(961 * 0.25) };

const variants = [
  { name: "lancios3", kernel: "lanczos3" },
  { name: "nearest", kernel: "nearest" },
  { name: "mitchell", kernel: "mitchell" },
  { name: "cubic", kernel: "cubic" },
];

for (const v of variants) {
  const image = await sharp(SRC)
    .extract(CROP)
    .grayscale()
    .linear(1.6, -80)
    .resize({ width: CROP.width * 3, kernel: v.kernel })
    .png()
    .toBuffer();
  const worker = await createWorker("slv+eng", 1);
  await worker.setParameters({ preserve_interword_spaces: "1", user_defined_dpi: "300", tessedit_pageseg_mode: "6" });
  const { data } = await worker.recognize(image);
  await worker.terminate();
  const krugerLine = data.text.split("\n").find((l) => /tablete/i.test(l));
  const has179 = /1[,.\s]79/.test(data.text);
  console.log(v.name.padEnd(10), `1,79:${has179 ? "y" : "N"}`, JSON.stringify(krugerLine ?? null));
}
