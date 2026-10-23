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
