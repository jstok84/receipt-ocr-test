/**
 * Corpus test: REAL v2-OCR output (tesseract.js v7 pipeline) of the same SPAR
 * photo as tests/corpus.test.js. v7 produces cleaner text — real decimal amounts,
 * a legible pre-coupon subtotal ("Skupaj BR 57.35") — which exposed three parser
 * regressions that v1's garbled OCR had hidden by accident:
 *   1. "highest candidate wins" picked the pre-coupon subtotal 57.35 instead of
 *      the payable 51.61  -> replaced by keyword tiers + last-in-tier
 *   2. "0: NI PROMET ..." recap line leaked (D read as digit 0)
 *   3. integer-only final amounts ("181" = 1.81) fell back to the discount column
 * These tests pin all three fixes. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt } from "../src/parseReceipt.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "fixtures", "spar-scan-v2.txt"), "utf8");

if (typeof globalThis.window === "undefined") {
  globalThis.window = { __OCR_DEBUG: false };
}

test("v7 SPAR scan: payable total wins over pre-coupon subtotal", () => {
  const r = parseReceipt(raw);
  assert.match(r.total, /^51\.61/, `expected 51.61, got ${r.total}`);
});

test("v7 SPAR scan: date recovered despite comma-glitched separator", () => {
  const r = parseReceipt(raw);
  assert.equal(r.date, "2022-02-05");
});

test("v7 SPAR scan: no VAT/digit-colon recap leak as item", () => {
  const r = parseReceipt(raw);
  const names = r.items.map((i) => i.name.toLowerCase());
  for (const bad of [/ni promet/, /^ha /, /zvestoh?e/, /masterca/, /kupon/, /^skupaj/]) {
    assert.ok(!names.some((n) => bad.test(n)), `${bad} leaked: ${names}`);
  }
});

test("v7 SPAR scan: integer-only final amount repaired to decimal price", () => {
  const r = parseReceipt(raw);
  const svaljki = r.items.find((i) => /svaljki/i.test(i.name));
  assert.ok(svaljki, "SVALJKI item missing");
  assert.ok(svaljki.price.startsWith("1.81"), `SVALJKI price = ${svaljki.price}, want 1.81`);
});

test("v7 SPAR scan: grocery volume preserved, v7-cleaned names present", () => {
  const r = parseReceipt(raw);
  assert.ok(r.items.length >= 25, `expected >=25 items, got ${r.items.length}`);
  const names = r.items.map((i) => i.name.toUpperCase());
  assert.ok(names.some((n) => n.includes("MASLO")), "SPAR MASLO missing (v7 reads it)");
  assert.ok(names.some((n) => n.includes("BEEF JERKY")), "BEEF JERKY missing");
  assert.ok(names.some((n) => n.includes("DESPAR PIZZA")), "PIZZA missing");
});
