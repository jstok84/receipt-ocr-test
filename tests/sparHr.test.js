/**
 * SPAR HRVATSKA regression pins (live user capture spar-2024-12-14.jpg):
 * a Croatian receipt carries NO Slovenian anchor, so the parse runs the EN
 * total-keyword tiers and the printed total line "UKUPNO 34,64" never becomes
 * a total candidate. The item-side filter only skips candidate lines, so the
 * receipt's OWN TOTAL leaked in as a phantom item — the items sum inflated by
 * exactly the total (true merchandise 26.58 + phantom 34.64 = 61.22).
 * v2.0.31 adds /ukupno/i to NON_ITEM_PATTERNS (language-independent: a
 * total-keyword line is never merchandise); the payable line "PLAČANJE VISA
 * 34,64" still supplies the picked total via payment markers.
 *
 * v2.0.32 closes the remaining gap by fixing the four measured row defects
 * (previously pinned here as a "true gap" — the pins below are the NEW
 * truthful state):
 *   - MLIJEKO: donor "MLIJEKO UHT 1,5%MM 1L" was rejected by the donor
 *     decimal guard because its fat-content "1,5%" looks like a price, so the
 *     qty row below ("3 x 2,19 6.57 D") was thrown away and the name line was
 *     misread as 1,50. Percentages are packaging text, not prices.
 *   - TUNA: the ×-row emitted the UNIT price 1,69; the item price is the LINE
 *     TOTAL (qty × unit = 4 × 1,69 = 6,76) — the amount the receipt sums. The
 *     printed total "6,/6" garbled, so arithmetic is the only witness.
 *   - KRUH: "600 g" in the name line was repaired into a phantom 6,00 item
 *     (a measure unit is never a VAT code); the real price 2,18 sits on the
 *     qty-garbled row "Za 09 2,18 D", recovered via the orphan priced row.
 *   - Banana: the weight-priced row "1,210 kg(N) x 1,44 EUR/kg 1,74 D" matched
 *     no row shape and was missed entirely.
 * Result: 10 items, items sum 34.64 = total 34.64 — the check goes GREEN.
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
  assert.equal(r.items.length, 10, `items: ${r.items.map((i) => i.name).join(", ")}`);
});

test("spar hr: the four measured row defects are fixed and the sum reconciles", () => {
  const r = parseReceipt(raw);
  const byName = (re) => r.items.find((i) => re.test(i.name));
  const mlijeko = byName(/MLIJEKO/);
  assert.equal(mlijeko.price, "6.57 €", `MLIJEKO: ${JSON.stringify(mlijeko)}`);
  assert.equal(mlijeko.quantity, 3, `MLIJEKO qty: ${JSON.stringify(mlijeko)}`);
  const tuna = byName(/TUNA/);
  assert.equal(tuna.price, "6.76 €", `TUNA: ${JSON.stringify(tuna)}`);
  assert.equal(tuna.quantity, 4, `TUNA qty: ${JSON.stringify(tuna)}`);
  const kruh = byName(/KRUH/);
  assert.equal(kruh.price, "2.18 €", `KRUH: ${JSON.stringify(kruh)}`);
  const banana = byName(/Banana/);
  assert.equal(banana.price, "1.74 €", `Banana: ${JSON.stringify(banana)}`);
  // the arithmetic identity the whole receipt hangs on
  const sum = r.items.reduce((a, it) => a + parseFloat(it.price), 0);
  assert.ok(Math.abs(sum - 34.64) < 1e-9, `items sum ${sum} != 34.64`);
  const sumCheck = r.checks.find((c) => /items sum/.test(c.text));
  assert.ok(sumCheck, `no sum check: ${JSON.stringify(r.checks)}`);
  assert.match(sumCheck.text, /items sum = total \(34\.64\)/,
    `the receipt must reconcile exactly: ${sumCheck.text}`);
  assert.equal(sumCheck.ok, true, "the sum check must be green");
});

test("spar hr: the 61.22 phantom sum must never come back", () => {
  // the v2.0.31-era failure mode, pinned against regression: if the UKUPNO
  // phantom ever returns, the sum inflates by exactly the total
  const r = parseReceipt(raw);
  const sum = r.items.reduce((a, it) => a + parseFloat(it.price), 0);
  assert.ok(Math.abs(sum - 61.22) > 1e-9, `phantom-inflated sum is back: ${sum}`);
});

test("spar hr: a measure-unit weight line alone produces no phantom item", () => {
  // "600 g" must NOT be repaired into 6,00 (the v2.0.32 C3 guard); without a
  // priced row below there is simply no item
  const r = parseReceipt("KRUH PSENIC.BIJELI 600 g\nUKUPNO 34,64\n");
  assert.equal(r.items.length, 0, `phantom from a weight line: ${JSON.stringify(r.items)}`);
});

test("spar hr: the orphan row needs the VAT code (EUROSPIN garble stays out)", () => {
  // "se ? 0,37" (eurospin-browser-garble real capture) has a junk name side
  // and a passing donor, but NO trailing VAT code — it must stay skipped
  const r = parseReceipt("JESEK 4 0. ova Dr pne\nse ? 0,37\n");
  assert.equal(r.items.length, 0, `orphan rule fired without a VAT code: ${JSON.stringify(r.items)}`);
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
