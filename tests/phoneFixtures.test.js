/**
 * Corpus test: REAL OCR output of a phone photograph of a physical HOFER
 * receipt (Oct 2026, taken at 90° rotation on a tablecloth — the sync test
 * channel's first true camera photo). Encodes required behavior:
 *  - total found from "HOFER CENA 12.14" (dot decimal merchant side)
 *  - the gratitude footer OCR-fused with barcode digits is NEVER an item
 *    ("HVALA Z 10,26 17. | SODNA" manufactured a 10,26 item pre-v2.0.1)
 *  - date: this photo's OCR genuinely dropped the date line (22.10.26 17:56
 *    never survives), so date=null is the CORRECT output — do not "fix".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt } from "../src/parseReceipt.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "fixtures", "hofer-phone-real.txt"), "utf8");

if (typeof globalThis.window === "undefined") {
  globalThis.window = { __OCR_DEBUG: false };
}

test("phone HOFER photo: total resolves to CENA 12.14", () => {
  const r = parseReceipt(raw);
  assert.ok(r.total, "total should be found");
  assert.match(r.total, /^12\.14/);
});

test("phone HOFER photo: gratitude-footer line is never an item", () => {
  const r = parseReceipt(raw);
  const names = r.items.map((i) => i.name.toLowerCase());
  assert.ok(!names.some((n) => n.startsWith("hvala")), `"HVALA Z" leaked as an item`);
});

test("phone HOFER photo: the three article items parse and sum to total", () => {
  const r = parseReceipt(raw);
  assert.equal(r.items.length, 3, `expected exactly 3 items, got ${JSON.stringify(r.items)}`);
  const sum = r.items.reduce((acc, it) => acc + parseFloat(it.price), 0);
  assert.ok(Math.abs(sum - 12.14) < 0.01, `items sum ${sum} ≠ total 12.14`);
  const bad = r.checks.filter((c) => !c.ok);
  assert.equal(bad.length, 0, `spurious failing checks: ${bad.map((c) => c.text).join(" | ")}`);
});
