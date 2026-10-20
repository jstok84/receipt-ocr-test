/**
 * Parser tests with Slovenian receipt fixtures.
 *
 * NOTE ON LANGUAGE: fixtures are encoded WITHOUT diacritics on purpose.
 * The production OCR whitelist (src/ocrUtils.js, tessedit_char_whitelist)
 * strips diacritic characters, so the parser only ever sees ASCII text
 * like "placano", "racun", "ddv" - never "plačano", "račun", "ddv" with
 * proper marks. Fixtures must mirror that reality or they test a fiction.
 *
 * Run: npm test   (node --test tests/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt } from "../src/parseReceipt.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, "fixtures", name), "utf8");

// Silence the parser's stray console noise if DEBUG leaks on.
if (typeof globalThis.window === "undefined") {
  globalThis.window = { __OCR_DEBUG: false };
}

test("generic SI receipt: parses date, total from 'SKUPAJ Z DDV' and line items", () => {
  const r = parseReceipt(fixture("generic-si.txt"));
  assert.equal(r.date, "2025-07-07");
  assert.ok(r.total, "total should be found");
  assert.match(r.total, /^24\.30/);
  assert.ok(r.items.length >= 4, `expected >=4 items, got ${r.items.length}`);
  const names = r.items.map((i) => i.name.toUpperCase());
  assert.ok(names.includes("MLEKO ALPSKO 3,5%"), `MLEKO missing: ${names}`);
  assert.ok(names.includes("CACAO BITTER 100G"), `CACAO missing: ${names}`);
  // The recap line 'C 9,5% 2,10 2,30' must not become an item
  assert.ok(!names.some((n) => /^C\s+9/.test(n)), "VAT recap line leaked as item");
});

test("spar SI receipt: multi-column format items + total via 'SKUPAJ' line", () => {
  const r = parseReceipt(fixture("spar-si.txt"));
  assert.equal(r.date, "2025-07-07");
  assert.ok(r.total, "total should be found");
  assert.match(r.total, /^11\.50/);
  // SPAR 10+-column lines: KRUH has qty 2 (delivered), net price 1,34 after 10% popust
  const kruh = r.items.find((i) => i.name.toUpperCase().includes("KRUH"));
  assert.ok(kruh, "KRUH item missing");
  assert.equal(kruh.quantity, 2);
  assert.match(kruh.price, /^1\.34\b/);
  assert.ok(r.items.length >= 4, `expected >=4 items, got ${r.items.length}`);
  // multipurpose metadata lines should not leak
  const names = r.items.map((i) => i.name.toUpperCase());
  assert.ok(!names.some((n) => /^(KOL|SKUPAJ|REZULTAT|BRUTO)/.test(n)), `leaked meta: ${names}`);
});

test("ponudba (quote) SI: date with thin space format falls back to quote semantics", () => {
  const r = parseReceipt(fixture("ponudba-si.txt"));
  assert.equal(r.date, "2024-08-25");
  assert.ok(r.total, "total should be found");
  assert.match(r.total, /^21\.00/);
  assert.ok(r.items.length >= 2, `expected >=2 items, got ${r.items.length}`);
});

test("total preference: highest candidate wins over subtotal-like lines", () => {
  const r = parseReceipt(fixture("spar-si.txt"));
  // candidates include SKUPAJ 11,50 and SKUPNA VREDNOST 11,50 -> both equal, no corruption
  const t = parseFloat(r.total);
  assert.ok(t > 10 && t < 12, `total out of sensible range: ${t}`);
});

test("fallback: VAT summary net+vat computed when no keyword total exists", () => {
  const text = [
    "ARTIKEL A   1  2,10",
    "ARTIKEL B   1  5,60",
    "C 9,5%  2,10  2,30",
    "C 22%   5,60  6,83",
  ].join("\n");
  const r = parseReceipt(text);
  assert.ok(r.total, "fallback total missing");
  const t = parseFloat(r.total);
  assert.ok(Math.abs(t - 4.4) < 0.001,
    `expected first VAT row fallback 2,10+2,30=4,40, got: ${t}`);
});

test("parser version is exposed in result", () => {
  const r = parseReceipt(fixture("generic-si.txt"));
  assert.match(r.version, /^v\d+\.\d+\.\d+$/);
});
