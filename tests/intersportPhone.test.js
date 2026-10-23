/**
 * Corpus test: REAL OCR of a phone photograph of a physical INTERSPORT
 * receipt (Oct 2026, second sync batch). Encodes:
 *  - payable 59,99 was an OCR misread of 55,99 — the paid line (PLAČANO …
 *    55,99) and the DDV recap (45,89 + 10,10 = 55,99) carry the truth;
 *    the parser must SURFACE the payable-vs-paid conflict as a failing check
 *    (the tier system itself keeps the keyword total — ambiguity is shown,
 *    not silently resolved)
 *  - the fused date fragment ("…16.09 2029 Zav") must never become an item
 *    — the separator-blur date guard applies
 *  - total keyword logic still resolves ZA PLAČILO…
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt } from "../src/parseReceipt.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "fixtures", "intersport-phone-real.txt"), "utf8");

if (typeof globalThis.window === "undefined") globalThis.window = { __OCR_DEBUG: false };

test("phone INTERSPORT photo: keyword total resolves to the (misread) ZA PLAČILO value", () => {
  const r = parseReceipt(raw);
  assert.ok(r.total, "total should be found");
  assert.match(r.total, /^59\.99/);
});

test("phone INTERSPORT photo: payable-vs-paid conflict is flagged", () => {
  const r = parseReceipt(raw);
  const conflict = r.checks.filter((c) => /payable .* ≠ paid .*/.test(c.text));
  assert.equal(conflict.length, 1, `expected exactly one payable≠paid check, got ${JSON.stringify(r.checks)}`);
  assert.ok(!conflict[0].ok);
  assert.match(conflict[0].text, /payable 59\.99 ≠ paid 55\.99/);
});

test("phone INTERSPORT photo: fused date line never becomes an item", () => {
  const r = parseReceipt(raw);
  const names = r.items.map((i) => i.name);
  const leaks = names.filter((n) => /CO\.\s*RN/.test(n) || /16\.09/.test(n));
  assert.equal(leaks.length, 0, `date-fused line leaked as item(s): ${JSON.stringify(names)}`);
});

test("phone INTERSPORT photo: qty×price row merges into the item with the MEASURED unit price", () => {
  // Ground truth (paper): JAKNA W.HOOD SRIMFIELD, qty 1, unit 79,99, SKUPAJ
  // 79,99, popust 24,00, payable 55,99. The name row's price column garbled
  // to "548" (would read as a phantom 5,48); only the "1 000 x 79,99 79.89"
  // row below carries the real 79,99. v2.0.13.
  const r = parseReceipt(raw);
  const jakna = r.items.find((i) => /JAKNA/i.test(i.name));
  assert.ok(jakna, `expected a JAKNA item, got ${JSON.stringify(r.items)}`);
  assert.match(jakna.name, /JAKNA/i);
  assert.ok(!/^\d{7}\b/.test(jakna.name), "SKU digits must not lead the merged name");
  assert.ok(!/3849687/.test(jakna.name), "the whole SKU garble must be stripped from the name");
  assert.equal(jakna.price, "79.99 €");
  assert.equal(jakna.quantity, 1);
  const phantoms = r.items.filter((i) => /5\.48/.test(i.price));
  assert.equal(phantoms.length, 0, "bare-int 5.48 phantom must not survive");
});
