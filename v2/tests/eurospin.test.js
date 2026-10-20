/**
 * Corpus test: REAL EUROSPIN receipt (Node OCR, tight manual crop + rotate -2°
 * + linear contrast stretch). Ground truth verified against the photo:
 * Keksi Frollini 1KG 1,55 A / Slani Prig.Taralli M 1,29 A / Keksi Čokoladni
 * 225G 1,45 A / Skupaj 4,29 / ZA PLAČILO 4,29 / Gotovina 13,00 / Vrnjen denar
 * 8,71 / VAT row Skupaj 4,29. Every totals line garbled in OCR (crease); the
 * item zone survived completely.
 * Pins:  - total = 4.29: the garbled "Skupaj" keyword survived at weight 2 and
 *          its amount was pulled from the next line. The items-sum fallback
 *          did NOT need to fire on this fixture, but exists for runs where
 *          totals keywords die completely (tender-side subtraction was
 *          REJECTED by design here: its change line misreads 8,71 → 8,11,
 *          which would yield a wrong 4.89 total).
 *        - Gotovina/garbles ("Jt ovina") and Vrnjen denar never become items
 *        - both cash lines are NEITHER items NOR totals (tender-side rule)
 *        - VAT-fragment leaks ("kd, 0% ? 4,29", "mat (ER): 4,29") excluded
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt } from "../src/parseReceipt.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "fixtures", "eurospin-scan-real.txt"), "utf8");

if (typeof globalThis.window === "undefined") {
  globalThis.window = { __OCR_DEBUG: false };
}

test("eurospin scan: date from 18. 09. 2025", () => {
  const r = parseReceipt(raw);
  assert.equal(r.date, "2025-09-18");
});

test("eurospin scan: total via keyword candidate (garbled skupaj + next-line amount)", () => {
  const r = parseReceipt(raw);
  assert.equal(r.total, "4.29 €");
  assert.equal(r.totalSource, "keyword");
});

test("eurospin scan: all three items with correct amounts", () => {
  const r = parseReceipt(raw);
  const frollini = r.items.find((i) => /frollini/i.test(i.name));
  const taralli = r.items.find((i) => /taralli/i.test(i.name));
  const cokoladni = r.items.find((i) => /onuladn|okoladn/i.test(i.name));
  assert.ok(frollini && frollini.price.startsWith("1.55"), `frollini: ${JSON.stringify(frollini)}`);
  assert.ok(taralli && taralli.price.startsWith("1.29"), `taralli: ${JSON.stringify(taralli)}`);
  assert.ok(cokoladni && cokoladni.price.startsWith("1.45"), `cokoladni: ${JSON.stringify(cokoladni)}`);
  assert.equal(r.items.length, 3);
});

test("eurospin scan: no tender-side leaks (gotovina/denar garbles)", () => {
  const r = parseReceipt(raw);
  const names = r.items.map((i) => i.name.toLowerCase());
  for (const bad of [/ovin/, /denar/, /vra[čc]il/]) {
    assert.ok(!names.some((n) => bad.test(n)), `${bad} leaked: ${names}`);
  }
});

/**
 * Second fixture: the user's UNcropped browser run of the same receipt —
 * near-total garble (star-row separator read as "F336 36 36.30…", Gotovina as
 * "s - 3 FUR 13,0" / "otovind pe EUR 8,71"). This run exposed the reverted
 * items-sum bug: garbage items summed to a confident wrong "62.67 €".
 */
const garbled = readFileSync(join(here, "fixtures", "eurospin-browser-garble.txt"), "utf8");

test("eurospin browser garble: no total is fabricated (never 62.67 again)", () => {
  const r = parseReceipt(garbled);
  assert.equal(r.total, null, `expected Not found, got ${r.total}`);
});

test("eurospin browser garble: separator/tender/short-garble lines are not items", () => {
  const r = parseReceipt(garbled);
  const names = r.items.map((i) => i.name.toLowerCase());
  for (const bad of [/f336/, /ovin/, /\bfur\b/, /denar/, /^se \?/, /vra[čc]il/]) {
    assert.ok(!names.some((n) => bad.test(n)), `${bad} leaked: ${names}`);
  }
});

test("eurospin browser garble: no spurious real-looking items", () => {
  const r = parseReceipt(garbled);
  const names = r.items.map((i) => i.name);
  // nothing below 3 letters makes it through the garble guard
  assert.ok(
    names.every((n) => (n.match(/[a-zA-ZčšžČŠŽ]/g) || []).length >= 3),
    `short-name leak: ${names}`
  );
});

// NOTE: an uppercase token-soup separator exclusion ("Me VO: 550 AZ RR ENRRRA…")
// was attempted and reverted: with ≥5 caps tokens it ate real SPAR items whose
// short garble prefixes extended the run ("ČAJ LIPA F20 306 1001",
// "SB SIR RIBANI LAHKI 25"). The separator row stays a known cosmetic leak.

test("structural currency tag: '(EUR): <amount>' is a weight-2 total", () => {
  // real garble form: "Poz ID (EUR): | 4,29" from "Skupaj (EUR): 4,29"
  const r = parseReceipt("Poz ID (EUR): | 4,29");
  assert.equal(r.total, "4.29 €");
});

test("structural currency tag: garbled '(FUR)/'(ER)' forms equally valid", () => {
  assert.equal(parseReceipt("na) (FUR): 4,29").total, "4.29 €");
  assert.equal(parseReceipt("mat (ER): 4,29").total, "4.29 €");
});

test("arithmetics validator: items-sum matches total on the crop-run fixture", () => {
  const r = parseReceipt(raw);
  const sumCheck = r.checks.find((c) => c.text.includes("items sum"));
  assert.ok(sumCheck && sumCheck.ok, `expected ✓, got ${JSON.stringify(r.checks)}`);
  assert.equal(r.total, "4.29 €");
});

test("arithmetics validator: a misread price flags [?], never vetoes the total", () => {
  // real browser-run form: FROLLINI misread as 1,95 -> sum 4,69 vs total 4,29
  const r = parseReceipt("Skupaj (EUR): 4,29\nFROLLINI 1,95 A\nTARALLI 1,29 A\nONULADNI 1,45 A");
  const sumCheck = r.checks.find((c) => c.text.includes("items sum"));
  assert.ok(sumCheck && !sumCheck.ok, `expected mismatch flag, got ${JSON.stringify(r.checks)}`);
  assert.equal(r.total, "4.29 €", "flag must not override the total");
});

test("arithmetics validator: tender arithmetic cross-check fires when tender lines survive", () => {
  const garbledRun = parseReceipt(garbled); // no total -> no checks there
  assert.ok(!garbledRun.checks.some((c) => c.text.includes("tender")));
  // sanity: matching tender/change/total produce a ✓
  const r = parseReceipt("Skupaj 4,29\nGotovina EUR 13,00\nVrnjen denar EUR 8,71");
  const tenderCheck = r.checks.find((c) => c.text.includes("tender"));
  assert.ok(tenderCheck && tenderCheck.ok, `expected tender ✓, got ${JSON.stringify(r.checks)}`);
});
