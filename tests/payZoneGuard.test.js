/**
 * v2.1 structural guard: merchandise precedes the payable total.
 *
 * Why this test exists: keyword-based nonItem rules cannot cover the pay-zone
 * line once the OCR mangles it, and the mangled shape depends on the pixels —
 * so it changes with the resampler and per browser. Real shapes measured while
 * wiring the canvas-free transport (EUROSPIN photo):
 *
 *   canvas upscale   "na) (FUR): 4,29"    -> already caught by the (EUR)/(FUR) rule
 *   cv INTER_CUBIC   "p- Lall% 2 r 4.20"  -> no keyword left at all
 *   cv INTER_LINEAR  "PLACILOMELR) 6.20"  -> keyword fused, no word boundary
 *
 * All three manufactured a phantom item and broke the items-sum check. The rule
 * under test does not care how the line garbles: it sits below the total, so it
 * is tender/footer machinery.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReceipt } from "../src/parseReceipt.js";

if (typeof globalThis.window === "undefined") globalThis.window = { __OCR_DEBUG: false };

const HEAD = [
  "Komline d.o.o.",
  "EUROSPIN SEZANA",
  "EKSI FROLLINI 1KG            1,55 A",
  "LANI PRIG. TARALLI M         1,29 A",
  "SI CONULADNI                 1,45 A",
  "Skupaj (EUR): 4,29",
  "Gotovina EUR 13,00",
  "Vrnjen denar EUR 8,71",
].join("\n");

test("pay-zone line whose keyword was destroyed is not an item", () => {
  const text = HEAD + "\np- Lall% 2 r 4.20";
  const p = parseReceipt(text);
  assert.equal(p.total, "4.29 €");
  assert.equal(p.items.length, 3, `expected 3 items, got ${p.items.map(i => i.name).join(" | ")}`);
  assert.ok(!p.items.some(i => /Lall/.test(i.name)), "phantom pay-zone item must not be captured");
});

test("pay-zone line with the keyword fused into a longer token is not an item", () => {
  const text = HEAD + "\nPLACILOMELR) 6.20";
  const p = parseReceipt(text);
  assert.equal(p.total, "4.29 €");
  assert.equal(p.items.length, 3, `expected 3 items, got ${p.items.map(i => i.name).join(" | ")}`);
});

test("items below a receipt's own total line still parse when the layout is inverted", () => {
  // Scope guard: the rule only applies when the total sits past the first
  // quarter. A receipt that prints its total at the top must not be emptied.
  const text = ["SKUPAJ 5,00", "MLEKO 2,00", "KRUH 3,00", "", ""].join("\n");
  const p = parseReceipt(text);
  assert.equal(p.items.length, 2, `expected 2 items, got ${p.items.map(i => i.name).join(" | ")}`);
});

test("healthy receipt: nothing after the total, item count unchanged", () => {
  const p = parseReceipt(HEAD);
  assert.equal(p.total, "4.29 €");
  assert.equal(p.items.length, 3);
});
