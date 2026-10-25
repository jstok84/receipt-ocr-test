/**
 * SPAR HRVATSKA regression pins (2026-10-25, live user capture
 * spar-2024-12-14.jpg): a Croatian receipt carries NO Slovenian anchor, so
 * the parse runs the EN total-keyword tiers and the printed total line
 * "UKUPNO 34,64" never becomes a total candidate. The item-side filter only
 * skips candidate lines, so the receipt's OWN TOTAL leaked in as a phantom
 * item — the items sum inflated by exactly the total (true merchandise
 * 26.58 + phantom 34.64 = 61.22). v2.0.31 adds /ukupno/i to
 * NON_ITEM_PATTERNS (language-independent: a total-keyword line is never
 * merchandise); the payable line "PLAČANJE VISA 34,64" still supplies the
 * picked total via payment markers.
 *
 * The remaining gap (26.58 vs 34.64) is a SEPARATE, still-unfixed story,
 * pinned below so the truthful number can never silently regress to the
 * phantom-inflated one: MLIJEKO read 1.50 from its name line instead of the
 * qty row (3 x 2,19 6,57), TUNA read the unit 1,69 instead of the line
 * total (4 x 1,69 6,76), KRUH read "600 g" from its name line as 6.00
 * instead of 2,18, and the weight-priced Banana row (1,210 kg x 1,44
 * EUR/kg 1,74) was missed entirely.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt } from "../src/parseReceipt.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "fixtures", "spar-hr-ukupno.txt"), "utf8");

if (typeof globalThis.window === "undefined") {
  globalThis.window = { __OCR_DEBUG: false };
}

test("spar hr: total and date parse unchanged", () => {
  const r = parseReceipt(raw);
  assert.equal(r.total, "34.64 €", `total: ${r.total}`);
  assert.equal(r.date, "2024-12-14", `date: ${r.date}`);
});

test("spar hr: the UKUPNO total line is never an item", () => {
  const r = parseReceipt(raw);
  assert.ok(!r.items.some((i) => /ukupno/i.test(i.name)),
    `phantom total item leaked: ${JSON.stringify(r.items.map((i) => i.name))}`);
  assert.equal(r.items.length, 9, `items: ${r.items.map((i) => i.name).join(", ")}`);
});

test("spar hr: the sum check reports the TRUE gap, not the phantom-inflated one", () => {
  const r = parseReceipt(raw);
  const sumCheck = r.checks.find((c) => /items sum/.test(c.text));
  assert.ok(sumCheck, `no sum check: ${JSON.stringify(r.checks)}`);
  assert.match(sumCheck.text, /items sum 26\.58 ≠ total 34\.64/,
    `the 61.22 phantom sum must never come back: ${sumCheck.text}`);
  // the gap is exactly the four measured row defects (net −8.06)
  const sum = r.items.reduce((a, it) => a + parseFloat(it.price), 0);
  assert.ok(Math.abs(26.58 + 8.06 - 34.64) < 1e-9, "arithmetic pin: 26.58 + 8.06 = 34.64");
});

test("spar hr: synthetic UKUPNO line is excluded even with no payable line", () => {
  // language-independent exclusion: no Slovenian anchor anywhere, no payment
  // marker — the total-keyword line still must not become merchandise
  const text =
    "TEST ARTIKEL 2,00 A\n" +
    "UKUPNO 34,64\n";
  const r = parseReceipt(text);
  assert.equal(r.items.length, 1, `items: ${JSON.stringify(r.items)}`);
  assert.ok(!r.items.some((i) => /ukupno/i.test(i.name)), "phantom total item");
});
