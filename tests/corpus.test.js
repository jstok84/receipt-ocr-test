/**
 * Corpus test: REAL garbled OCR output of a physical SPAR receipt (Feb 2026 scan).
 * Encodes the parser's required behavior ON OCR-DEGRADED input:
 *  - date must be recovered despite OCR separator confusion
 *  - total must still resolve through candidate ranking
 *  - the item list must contain grocery lines only:
 *    NO date lines, NO payment lines, NO recap/VAT-code lines, NO total lines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt } from "../src/parseReceipt.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "fixtures", "spar-scan-real.txt"), "utf8");

if (typeof globalThis.window === "undefined") {
  globalThis.window = { __OCR_DEBUG: false };
}

test("real garbled SPAR scan: total survives garbled keyword via candidate ranking", () => {
  const r = parseReceipt(raw);
  assert.ok(r.total, "total should be found");
  assert.match(r.total, /^51\.61/);
});

test("real garbled SPAR scan: date recovered", () => {
  const r = parseReceipt(raw);
  assert.equal(r.date, "2022-02-05");
});

test("real garbled SPAR scan: item list excludes metadata, payment and recap lines", () => {
  const r = parseReceipt(raw);
  const names = r.items.map((i) => i.name.toLowerCase());
  const leaks = [
    /^irujretci/, // date line leaked
    /slupaj/, // garbled total heading leaked
    /masterca/, // payment line leaked
    /zvestoh?e/, // loyalty-points lines leaked
    /^ha /, // VAT-code recap leaked
    /^a:/, // exempted-traffic recap leaked
    /^\.13/, // VAT gross row leaked
  ];
  for (const pat of leaks) {
    assert.ok(!names.some((n) => pat.test(n)), `${pat} leaked as item(s)`);
  }
});

test("real garbled SPAR scan: grocery items actually parsed", () => {
  const r = parseReceipt(raw);
  const names = r.items.map((i) => i.name.toUpperCase());
  assert.ok(names.length >= 15, `expected >=15 grocery items, got ${names.length}`);
  for (const want of ["KROKETI 400G ZAMRZ. ZET", "BEEF JERKY DIVJAK", "OMAKA BAZILIKA"]) {
    assert.ok(names.some((n) => n.includes(want)), `"${want}" missing from: ${names.slice(0, 8)}`);
  }
});
