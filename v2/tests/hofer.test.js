/**
 * Corpus test: REAL HOFER receipt (browser OCR, v7 pipeline + grayscale 2x, no
 * CLAHE). Ground truth verified on the physical photo: Krüger šum.tablete 1,79 B
 * (row clipped by the photo frame - unrecoverable by OCR), Šumece tablete 0,85 A,
 * Barcaffe 100g 2,09 A, Vmesna vsota 4,73, HOFER CENA 4,73, VISA EUR 4,73.
 * VAT rows cross-check: 2,94 (A) + 1,79 (B) = 4,73 exactly.
 * Pins:  - total = 4,73 via payment markers (VISA / HOFER CENA)
 *        - "Vmesna vsota" (interim sum) is a total candidate, NOT an item
 *        - "HOFER CENA" banner is a payment candidate, NOT an item
 *        - ECR/EFT/Trm metadata lines stay out of the item list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt } from "../src/parseReceipt.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "fixtures", "hofer-scan-real.txt"), "utf8");

if (typeof globalThis.window === "undefined") {
  globalThis.window = { __OCR_DEBUG: false };
}

test("hofer scan: payable total via payment lines", () => {
  const r = parseReceipt(raw);
  assert.match(r.total, /^4\.73/, `expected 4.73, got ${r.total}`);
});

test("hofer scan: date from 11.03.2025", () => {
  const r = parseReceipt(raw);
  assert.equal(r.date, "2025-03-11");
});

test("hofer scan: no interim-sum / banner / ECR metadata leaks", () => {
  const r = parseReceipt(raw);
  const names = r.items.map((i) => i.name.toLowerCase());
  for (const bad of [/vsota/, /hofer/, /\becr\b/, /\beft\b/, /trm-id/, /auth/, /izdel/i]) {
    assert.ok(!names.some((n) => bad.test(n)), `${bad} leaked: ${names}`);
  }
});

test("hofer scan: the one unclipped item is parsed", () => {
  const r = parseReceipt(raw);
  const names = r.items.map((i) => i.name.toUpperCase());
  const barcaffe = r.items.find((i) => /BARCAFFE/i.test(i.name));
  assert.ok(barcaffe, `BARCAFFE missing from: ${names}`);
  assert.ok(barcaffe.price.startsWith("2.09"), `BARCAFFE price = ${barcaffe.price}`);
});
