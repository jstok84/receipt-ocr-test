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
import { parseReceipt, namesSimilar } from "../src/parseReceipt.js";

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

test("OCR wobble: comma-drift '4, 29' still totals (two runs of the same photo differ)", () => {
  // real form, v2 app run after the good one: "Poz ID (EUR): | 4, 29"
  const r = parseReceipt("Me VO: 550 AZ RR\nPoz ID (EUR): | 4, 29\nPLACILOMER La");
  assert.equal(r.total, "4.29 €");
  assert.equal(parseReceipt("Gotovina EUR 13, 00").items.length, 0, "'13, 00' must not create items");
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

test("arithmetics validator: fixture's misread change flags [?], never overrides the total", () => {
  // The committed fixture OCR-read the change as 8,11 (real: 8,71), so
  // 13,00 − 8,11 = 4,89 ≠ 4,29 — the check FLAGS the misread. This is the
  // designed behavior: tender arithmetic is evidence, never a total source
  // (see fixture header note "REJECTED by design").
  const r = parseReceipt(raw);
  const tenderCheck = r.checks.find((c) => c.text.includes("tender"));
  assert.ok(tenderCheck && !tenderCheck.ok, `expected [?], got ${JSON.stringify(r.checks)}`);
  assert.equal(r.total, "4.29 €", "flag must not override the total");
  assert.match(tenderCheck.text, /tender 13\.00 − change 8\.11 = 4\.89 ≠ total 4\.29/);
});

test("tender matcher survives the otovina garble (live desktop run 2026-10-24)", () => {
  // Live run read "Gotovina" as "otovina" — the leading g eaten by OCR haze
  // kept \bovin / gotovin from firing, and a genuinely passing check
  // (13,00 − 8,71 = 4,29) reported nothing. Bare "otovin" restores it.
  const r = parseReceipt("Skupaj 4,29\notovina EUR 13,00\nrnjen denar EUR 8,71");
  const tenderCheck = r.checks.find((c) => c.text.includes("tender"));
  assert.ok(tenderCheck && tenderCheck.ok, `expected tender ✓, got ${JSON.stringify(r.checks)}`);
  assert.match(tenderCheck.text, /tender 13\.00 − change 8\.71 = total/);
});

/**
 * Third fixture: the user's live browser run (2026-10-20, v2 app, uncropped
 * photo). The dot-matrix separator row above the items this time carried a
 * decimal-looking fragment ("…E66 330 3.3 KRE") that became a phantom 3.30 €
 * item and broke the items-sum check. The item rows re-confirmed the known
 * FROLLINI 1,95-vs-1,55 pixel misread. Fix (v1.7.6):
 *  - garble-row nonItem rule (≥3 pure short letter tokens before the last
 *    token, line contains digits),
 *  - parseReceipt corrections: strip-measured {name, price} candidates from
 *    an item-band re-OCR replace a price when the name fuzzy-matches.
 */
const junkHeader = readFileSync(join(here, "fixtures", "eurospin-browser-junk-header.txt"), "utf8");

test("junk header run: the 'Me VO: 550…3.3' phantom row is not an item", () => {
  const r = parseReceipt(junkHeader);
  const names = r.items.map((i) => i.name.toLowerCase());
  assert.ok(!names.some((n) => /me vo|enrra|e66/.test(n)), `phantom leaked: ${r.items.map((i) => i.name)}`);
  assert.ok(!r.items.some((i) => i.price.startsWith("3.30")), `3.30 phantom leaked: ${r.items.map((i) => i.name)} / ${r.items.map((i) => i.price)}`);
});

test("junk header run: all three real item rows survive the garble rule", () => {
  const r = parseReceipt(junkHeader);
  assert.equal(r.items.length, 3, `items: ${r.items.map((i) => i.name)}`);
  const frollini = r.items.find((i) => /frollini/i.test(i.name));
  const taralli = r.items.find((i) => /tarall/i.test(i.name));
  const cokoladni = r.items.find((i) => /onuladn/i.test(i.name));
  assert.ok(frollini && frollini.price.startsWith("1.95"), `frollini: ${JSON.stringify(frollini)}`);
  assert.ok(taralli && taralli.price.startsWith("1.29"), `taralli: ${JSON.stringify(taralli)}`);
  assert.ok(cokoladni && cokoladni.price.startsWith("1.45"), `cokoladni: ${JSON.stringify(cokoladni)}`);
});

test("junk header run: without corrections the sum check flags the known misread", () => {
  const r = parseReceipt(junkHeader);
  const sumCheck = r.checks.find((c) => c.text.includes("items sum"));
  assert.ok(sumCheck && !sumCheck.ok, `expected mismatch (4.69 vs 4.29), got ${JSON.stringify(sumCheck)}`);
});

test("junk header run: correction candidate measured at 1.55 replaces FROLLINI's 1.95", () => {
  const withCorr = parseReceipt(junkHeader, [], [
    { name: "EKSI FROLLINI 1KG", price: 1.55 },
  ]);
  const frollini = withCorr.items.find((i) => /frollini/i.test(i.name));
  assert.ok(frollini && frollini.price.startsWith("1.55"), `frollini: ${JSON.stringify(frollini)}`);
  assert.equal(frollini.via, "strip-corrected");
  const note = withCorr.checks.find((c) => c.text.includes("price corrected by band re-OCR"));
  assert.ok(note && !note.ok, `expected [?] provenance note, got ${JSON.stringify(note)}`);
  const sumCheck = withCorr.checks.find((c) => c.text.includes("items sum"));
  assert.ok(sumCheck && sumCheck.ok, `expected ✓ after correction, got ${JSON.stringify(sumCheck)}`);
});

test("junk header run: correction candidate matching nothing changes nothing", () => {
  const r2 = parseReceipt(junkHeader, [], [
    { name: "JOGURT WOLY V ANANASU", price: 0.99 },
  ]);
  assert.equal(r2.items.length, 3);
  assert.ok(!r2.items.some((i) => i.price.startsWith("0.99")), "phantom correction applied");
  assert.ok(!r2.checks.some((c) => c.text.includes("price corrected")));
});

test("corrections: candidate equal to the current price is a no-op (no note)", () => {
  const r = parseReceipt("Skupaj (EUR): 4,29\nFROLLINI 1,55 A\nTARALLI 1,29 A\nONULADNI 1,45 A", [], [
    { name: "EKSI FROLLINI 1KG", price: 1.55 },
  ]);
  assert.ok(!r.checks.some((c) => c.text.includes("price corrected")));
  assert.ok(r.checks.find((c) => c.text.includes("items sum")).ok);
});

test("corrections: live-evidence garbled strip price that WORSENS the sum is rejected", () => {
  // real live run 2026-10-20: prep 0.4-0.75 2x PSM6 strip garbled ČOKOLADNI's
  // 1,45 into "2256 1.49" — applying it moves sum 4.69 -> 4.73 vs total 4.29.
  const r = parseReceipt(junkHeader, [], [
    { name: "ST ČONULADNI 2256", price: 1.49 },
  ]);
  const cok = r.items.find((i) => /onuladn/i.test(i.name));
  assert.ok(cok && cok.price.startsWith("1.45"), `must stay 1.45, got ${JSON.stringify(cok)}`);
  assert.ok(!r.checks.some((c) => c.text.includes("price corrected")), "no note for rejected correction");
  assert.ok(!r.checks.find((c) => c.text.includes("items sum")).ok, "mismatch stays flagged");
});

test("corrections: good and garbled candidates together — only the improving one applies", () => {
  const r = parseReceipt(junkHeader, [], [
    { name: "ST ČONULADNI 2256", price: 1.49 },
    { name: "EKSI FROLLINI 1KG", price: 1.55 },
  ]);
  const frollini = r.items.find((i) => /frollini/i.test(i.name));
  const cok = r.items.find((i) => /onuladn/i.test(i.name));
  assert.ok(frollini && frollini.price.startsWith("1.55"), `frollini: ${JSON.stringify(frollini)}`);
  assert.ok(cok && cok.price.startsWith("1.45"), `cokoladni must stay 1.45, got ${JSON.stringify(cok)}`);
  assert.ok(r.checks.find((c) => c.text.includes("items sum")).ok, `sum must pass: ${JSON.stringify(r.checks)}`);
});

test("namesSimilar: garble twins match, distinct SI names do not", () => {
  assert.ok(namesSimilar("EKSI FROLLINI 1KG", "PFKSI FROLLINI 1KG"));
  assert.ok(namesSimilar("SI CORULADNI 225G", "<ST ČONULADNI"));
  assert.ok(namesSimilar("LANI PRT. TARALLI M", "| ANI PRTA.TARALLT M"));
  assert.ok(!namesSimilar("JOGURT WOLY V ANANASU", "PFKSI FROLLINI 1KG"));
  assert.ok(!namesSimilar("SI CORULADNI 225G", "LANI PRTA.TARALLT M"));
  assert.ok(!namesSimilar("AB", "CDEF"), "short names never match");
});

test("garble rule guard: the reverted caps-rule's SPAR victims stay intact", () => {
  // 'ČAJ LIPA F20 306 1001' and 'SB SIR RIBANI LAHKI 25' were eaten by an
  // earlier (reverted) token-soup rule; the short-letter rule must not eat them.
  const r = parseReceipt("ČAJ LIPA F20 306 1001 1,29 A\nSB SIR RIBANI LAHKI 25 2,49 B");
  assert.equal(r.items.length, 2, `items: ${r.items.map((i) => i.name)}`);
});
