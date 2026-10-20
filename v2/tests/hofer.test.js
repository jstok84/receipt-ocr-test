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

/**
 * Corpus test: same HOFER receipt through a different (worse) browser OCR run
 * with EFT/webshop metadata garble. Ground truth from hofer-scan-real above.
 * Pins: - "šumeče tablete 085 A" (decimal separator vanished) is repaired to 0,85
 *         via the standalone 3-digit int rule — v1.6.8
 *       - trailing 4+ digit echo ("ACH HEE i BER 5.0 41501") is NOT an item
 *         (it manufactured a phantom 5,00 €)
 *       - "Neto"-carrying DDV recap rows ("Ca ok Neto 2,6900V 0,25") are NOT items
 *       - Krüger 1,79 (B) is physically clipped from the photo: the resulting
 *         checks[] mismatch flag (2,94 ≠ 4,73) is the honest outcome, not a bug.
 */
const rawEft = readFileSync(join(here, "fixtures", "hofer-eft-scan.txt"), "utf8");

test("hofer eft scan: total and date survive terminal-garble noise", () => {
  const r = parseReceipt(rawEft);
  assert.match(r.total, /^4\.73/, `expected 4.73, got ${r.total}`);
  assert.equal(r.date, "2025-03-11");
});

test("hofer eft scan: separator-vanished '085' is repaired to a 0,85 item", () => {
  const r = parseReceipt(rawEft);
  const sumece = r.items.find((i) => /šumeče/i.test(i.name));
  assert.ok(sumece, `šumeče item missing from: ${r.items.map((i) => i.name)}`);
  assert.ok(sumece.price.startsWith("0.85"), `šumeče price = ${sumece.price}`);
  const barcaffe = r.items.find((i) => /BARCAFFE/i.test(i.name));
  assert.ok(barcaffe && barcaffe.price.startsWith("2.09"), "BARCAFFE 2,09 must survive");
});

test("hofer eft scan: EFT echo and DDV-recap rows stay out of the item list", () => {
  const r = parseReceipt(rawEft);
  const names = r.items.map((i) => i.name.toLowerCase());
  for (const bad of [/ach\b/, /\bneto\b/, /41501/, /bere/]) {
    assert.ok(!names.some((n) => bad.test(n)), `${bad} leaked: ${names}`);
  }
  assert.equal(r.items.length, 2, `expected 2 items, got ${JSON.stringify(names)}`);
});

test("hofer eft scan: missing (clipped) Krüger 1,79 keeps the mismatch honest", () => {
  const r = parseReceipt(rawEft);
  const sumCheck = (r.checks || []).find((c) => /items sum/.test(c.text));
  assert.ok(sumCheck, "items-sum check must be present");
  assert.equal(sumCheck.ok, false, `mismatch expected (0.85+2.09 ≠ 4.73): ${sumCheck.text}`);
});
