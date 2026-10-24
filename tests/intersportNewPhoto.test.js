/**
 * Corpus test: REAL OCR of a RE-PHOTOGRAPHED physical INTERSPORT receipt
 * (2026-10-24, third sync batch — same receipt as intersport-phone-real.txt,
 * newly pictured on a backlit keyboard, fold crease across the middle, print
 * misreads in both total-bearing zones). Encodes the fixes that this capture
 * demanded (v2.0.14 parser guards) and what must stay honest:
 *  - "(30.0%) - ŠPORTNE ZVEZDE  -24,00" is the program-discount row; OCR
 *    dropped the minus → it must never become a positive 24,90 item
 *  - "ZA PLAČILO" header fused with its ruled line ("ZAPLACILO eee _ 56,99")
 *    must never become an item
 *  - the qty×price merge still produces exactly the JAKNA item at the MEASURED
 *    79,99 unit price, and the SKU tail is stripped even when the printed 5
 *    OCR'd as "š" ("š48" — the name row of this capture)
 *  - EVERY printed total zone (DDV recap "Skupaj" and PLAČANO) was misread the
 *    same way on this photo (55,99 → 99,99), so the total stays the only value
 *    the text carries and the sum check MUST stay failing (ambiguity surfaced,
 *    never silently "fixed" with arithmetic)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt } from "../src/parseReceipt.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "fixtures", "intersport-new-real.txt"), "utf8");

if (typeof globalThis.window === "undefined") globalThis.window = { __OCR_DEBUG: false };

test("new INTERSPORT photo: exactly the real item, measured price, qty, SKU tail stripped", () => {
  const r = parseReceipt(raw);
  assert.equal(r.items.length, 1, `expected 1 item, got ${JSON.stringify(r.items)}`);
  const it = r.items[0];
  assert.equal(it.name, "JAKNA M.POH BRIMFIELD", `name: ${it.name}`);
  assert.ok(it.price.startsWith("79.99"), `price: ${it.price}`);
  assert.equal(it.quantity, 1);
});

test("new INTERSPORT photo: program-discount row never becomes an item", () => {
  const r = parseReceipt(raw);
  const names = r.items.map((i) => i.name);
  assert.ok(
    !names.some((n) => /sportne zvezde/i.test(n)),
    `discount row leaked as item: ${JSON.stringify(names)}`
  );
});

test("new INTERSPORT photo: fused ZA PLAČILO header never becomes an item", () => {
  const r = parseReceipt(raw);
  const names = r.items.map((i) => i.name);
  assert.ok(
    !names.some((n) => /zapla|pla[čc]ilo/i.test(n)),
    `plačilo header leaked as item: ${JSON.stringify(names)}`
  );
});

test("new INTERSPORT photo: date parses from the machine line", () => {
  const r = parseReceipt(raw);
  assert.match(r.date || "", /^2026-09-16/);
});

test("new INTERSPORT photo: total stays the (misread) text value and the sum check stays failing", () => {
  const r = parseReceipt(raw);
  assert.ok(r.total, "total should be found");
  assert.match(r.total, /^99\.99/, `total: ${r.total}`);
  const bad = r.checks.filter((c) => !c.ok);
  assert.equal(bad.length, 1, `expected exactly 1 failing check, got ${JSON.stringify(r.checks)}`);
  assert.match(bad[0].text, /items sum/);
});
