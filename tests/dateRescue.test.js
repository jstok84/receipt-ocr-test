/**
 * v2.0.22 date-rescue pins (user hoferracun1.jpg — the HOFER EFT-appendix
 * receipt whose only date printed sits in the payment appendix; OCR garbles
 * "11.03.2025 08:11" into "a 103.2025 08:11" across runs, so the date
 * extracted "2025-03-11" on good runs and null on garbled ones — pinned
 * ground truth in hofer.test.js + fixtures).
 *
 * v1.9.0 footer-shape pins (s25-hofer.jpg — HOFER phone capture): the
 * receipt prints its date ONLY in the footer as a TWO-DIGIT-YEAR date
 * ("*0728 381/058/001/006 22.10.26 17:56"). The full-page OCR reads that
 * line as fragments ("… HVALA 24 6%: 10.26 17." / "… RA a0 28 17:56") —
 * the clock time survives, the date digits do not — so the parse had no
 * date and the fused arm stayed cold. Measured fix: a time-anchor arm
 * (date==null AND an HH:MM survives) drives a BOTTOM-band strip re-OCR
 * (node evidence: bottom-20% band + grayscale/normalize + PSM 6 reads
 * "22.10.26 17:56" verbatim), and a strict two-digit-year accept
 * (zero-padded day+month, clock time DIRECTLY after the date) converts
 * the reading. The live Edge run then measured the last gap: the winning
 * strip read the date verbatim but the time's separator as a COMMA
 * ("22.10.26 17,56") — the accept-side co-anchor is ADJACENCY with the
 * separator wobble tolerated (colon/comma/dot, optional "ob"), which
 * keeps the date's own MM.YY and stray comma-prices from satisfying it.
 *
 * Policy: NO decomposition of an ambiguous digit run ("103.2025" is the
 * three-way merge 1.03 / 10.3 / 11.03 — inventing a day would be the same
 * sin as arithmetic overriding a printed total). Instead: re-MEASURE the
 * pixels with the pay-arm machinery (strip + zoom + kernel diversity) and
 * accept ONLY a complete, calendar-valid reading.
 *
 * Arm rule: date==null (caller) AND (findDateCandidate(text) — a line with
 * a single fused group.20xx-year via one dot + a time anchor — OR
 * hasTimeAnchor(text), v1.9.0).
 * Accept rule: validDateFromReading(stripLines) — complete 20xx calendar
 * date, or the strict two-digit-year footer shape (date + directly
 * following time), or null. Every helper is pure so the decisions are
 * pinned here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt, findDateCandidate, hasTimeAnchor, validDateFromReading, widenTwoDigitYear, calendarISO } from "../src/parseReceipt.js";

const here = dirname(fileURLToPath(import.meta.url));

if (typeof globalThis.window === "undefined") globalThis.window = { __OCR_DEBUG: false };

test("findDateCandidate: arms on the user's fused EFT-appendix line (verbatim fixture)", () => {
  const raw = readFileSync(join(here, "fixtures", "hofer-total-drift-real.txt"), "utf8");
  const c = findDateCandidate(raw);
  assert.ok(c && /103\.2025/.test(c) && /08:11/.test(c), `candidate: ${c}`);
});

test("findDateCandidate: no arm without a fused group.year + time shape", () => {
  assert.equal(findDateCandidate("| 4 kog- hf 00999100200\nzo | 11080-004-\n"), null);
  assert.equal(findDateCandidate(""), null);
  assert.equal(findDateCandidate(null), null);
  // fused year shape but no time anchor -> not the class we arm on
  assert.equal(findDateCandidate("a 103.2025\n"), null);
});

test("arm interplay: a parseable two-dot date line is NOT rescued (date != null)", () => {
  const raw = readFileSync(join(here, "fixtures", "scan-eurospin-user-real.txt"), "utf8");
  // The EUROSPIN line "datum: 18. 09. 2025  Ura:17:45:21" CONTAINS a
  // group.year-look ("09. 2025") — the text-level detector may flag it, but
  // the ocrUtils arm additionally requires parse.date == null, and here the
  // date parses fine. Pin that interplay so the guard can never regress to
  // strip-rescuing receipts that already read their date.
  assert.equal(parseReceipt(raw).date, "2025-09-18");
});

test("validDateFromReading: a complete clean reading is accepted", () => {
  assert.equal(validDateFromReading(["Mo 4 11.03.2025 08:11"]), "2025-03-11");
  assert.equal(validDateFromReading(["datum: 18. 09. 2025 Ura:17:45:22"]), "2025-09-18");
  assert.equal(validDateFromReading(["11.3.2025"]), "2025-03-11");
});

test("validDateFromReading: fused/ambiguous/garbled readings stay null", () => {
  assert.equal(validDateFromReading(["a 103.2025 08:11"]), null);
  assert.equal(validDateFromReading(["y i gs 2 3 31502695"]), null);
  assert.equal(validDateFromReading([null, undefined, ""]), null);
  assert.equal(validDateFromReading(), null);
});

test("validDateFromReading: calendar validity enforced (no 30.02 / 31.04)", () => {
  assert.equal(validDateFromReading(["30.02.2025"]), null);
  assert.equal(validDateFromReading(["31.04.2025"]), null);
  assert.equal(validDateFromReading(["29.02.2024"]), "2024-02-29"); // leap year
  assert.equal(validDateFromReading(["29.02.2025"]), null); // not a leap year
});

test("validDateFromReading: stray amounts elsewhere on the line do not win", () => {
  assert.equal(validDateFromReading(["Gotovina EUR 13,00"]), null);
  assert.equal(validDateFromReading(["? 2% 9 r 4,20"]), null);
});

// ---------------------------------------------------------------------------
// v1.9.0 — the HOFER phone-footer two-digit-year shape ("22.10.26 17:56")
// ---------------------------------------------------------------------------

test("hasTimeAnchor: fires on the surviving clock time of the garbled footer", () => {
  // verbatim live readings of s25-hofer.jpg's footer (full-page OCR):
  assert.equal(hasTimeAnchor("RA a0 28 17:56"), true);
  assert.equal(hasTimeAnchor("© HVALA 24 6%: 10.26 17."), false); // "17." is not HH:MM
  assert.equal(hasTimeAnchor("Mo 4 11.03.2025 08:11"), true);
  assert.equal(hasTimeAnchor("a 103.2025"), false); // fused year, no time
  assert.equal(hasTimeAnchor(""), false);
  assert.equal(hasTimeAnchor(null), false);
  assert.equal(hasTimeAnchor(42), false);
});

test("hasTimeAnchor: a fused candidate always implies the time anchor (superset arm)", () => {
  const raw = readFileSync(join(here, "fixtures", "hofer-total-drift-real.txt"), "utf8");
  if (findDateCandidate(raw)) assert.equal(hasTimeAnchor(raw), true);
});

test("validDateFromReading: the verbatim footer reading is accepted and widened", () => {
  // exactly what the bottom-band strip re-OCR read off s25-hofer.jpg:
  assert.equal(validDateFromReading(["EE. 055/001/006 22.10.26 17:56"]), "2026-10-22");
  assert.equal(validDateFromReading(["*0728 381/058/001/006 22.10.26 17:56"]), "2026-10-22");
  // THE measured live reading (norm 0.8-1 2x catrom psm 6, Edge, 2026-10-25):
  // the date came through VERBATIM but the time's separator glyph wobbled
  // colon -> comma ("17,56"), which a colon-only anchor rejected. The
  // accept-side co-anchor tolerates the wobble; dot and the Slovenian
  // "ob" connector (the 4-digit twin "25.08. 2024 ob 13:17:09" shape) too.
  assert.equal(validDateFromReading(["EE. 1.058,/001,/005 22.10.26 17,56"]), "2026-10-22");
  assert.equal(validDateFromReading(["22.10.26 17,56"]), "2026-10-22");
  assert.equal(validDateFromReading(["22.10.26 17.56"]), "2026-10-22");
  assert.equal(validDateFromReading(["22.10.26 ob 17:56"]), "2026-10-22");
  // era window: strptime %y convention (00-68 -> 20xx, 69-99 -> 19xx)
  assert.equal(validDateFromReading(["05.02.99 10:00"]), "1999-02-05");
  assert.equal(validDateFromReading(["01.01.14 09:00"]), "2014-01-01");
});

test("validDateFromReading: the time must DIRECTLY follow the date (adjacency)", () => {
  // The co-anchor is adjacency, not mere co-presence: the date's own MM.YY
  // must not be able to satisfy it, and neither may a stray price elsewhere
  // on the line (comma prices like "8,71" ARE time-shaped once the wobble
  // is tolerated). A time on a DIFFERENT part of the line does not count.
  assert.equal(validDateFromReading(["22.10.26"]), null);
  assert.equal(validDateFromReading(["22.10.26 Račun št.: 381058-001-180297 17:56"]), null);
  assert.equal(validDateFromReading(["17:56 je bil datum 22.10.26"]), null);
  // the date's own groups cannot stand in for the time (no whitespace
  // between date and time in the pattern, so "26 17" is required)
  assert.equal(validDateFromReading(["22.10.26 17"]), null);
  // junk digit runs with dots are not dates
  assert.equal(validDateFromReading(["38105800107282610 2210260 17:56"]), null);
});

test("validDateFromReading: partial-day readings (an actually-observed read) stay null", () => {
  // the 3x-gray strip variant read the footer as "2.10.26 17:56" — one
  // leading digit of the day lost. The strict zero-padded pattern cannot
  // match it, so a WRONG date is unreachable through the accept.
  assert.equal(validDateFromReading(["2.10.26 17:56"]), null);
  assert.equal(validDateFromReading(["22.1.26 17:56"]), null);
  assert.equal(validDateFromReading(["22.10.2 17:56"]), null);
  // calendar validity still enforced on the two-digit path
  assert.equal(validDateFromReading(["31.02.26 17:56"]), null);
  assert.equal(validDateFromReading(["29.02.24 17:56"]), "2024-02-29");
  assert.equal(validDateFromReading(["29.02.25 17:56"]), null);
});

test("widenTwoDigitYear / calendarISO: shared helpers", () => {
  assert.equal(widenTwoDigitYear(0), 2000);
  assert.equal(widenTwoDigitYear(26), 2026);
  assert.equal(widenTwoDigitYear(68), 2068);
  assert.equal(widenTwoDigitYear(69), 1969);
  assert.equal(widenTwoDigitYear(99), 1999);
  assert.equal(calendarISO(22, 10, 2026), "2026-10-22");
  assert.equal(calendarISO(31, 4, 2025), null);
  assert.equal(calendarISO(29, 2, 2024), "2024-02-29");
  assert.equal(calendarISO(29, 2, 2025), null);
  assert.equal(calendarISO(1, 1, 26), null); // pre-1000 years are not receipt dates
});

test("extractDate fallback: a clean two-digit-year footer line parses directly", () => {
  const r = parseReceipt(
    "760801 Brioš marmo. kolač 3,36 A\n" +
    "HOFER CENA 12.14\n" +
    "*0728 381/058/001/006 22.10.26 17:56\n" +
    "HVALA ZA VAŠ NAKUP!\n"
  );
  assert.equal(r.date, "2026-10-22");
  // the same line with the time's separator wobbled (the live reading)
  const r2 = parseReceipt(
    "760801 Brioš marmo. kolač 3,36 A\n" +
    "HOFER CENA 12.14\n" +
    "EE. 1.058,/001,/005 22.10.26 17,56\n" +
    "HVALA ZA VAŠ NAKUP!\n"
  );
  assert.equal(r2.date, "2026-10-22");
});

test("extractDate fallback: four-digit dates keep priority (fallback only)", () => {
  // a text carrying BOTH shapes resolves the four-digit date — the
  // two-digit scan runs only after the whole text failed the 4-digit ones
  const r = parseReceipt(
    "11.03.2025 08:11\n" +
    "HOFER CENA 4.73\n" +
    "*0728 381/058/001/006 22.10.26 17:56\n"
  );
  assert.equal(r.date, "2025-03-11");
});

test("extractDate fallback: the hofer-phone fixture itself still parses date=null", () => {
  // The FIXTURE text is the garbled full-page OCR ("ee /058/001/006 29 MN"
  // / "HVALA Z 10,26 17. | SODNA") — no contiguous date token exists in it,
  // and the text-level fallback must not invent one. The date comes from
  // the PIXEL-level bottom-band strip re-OCR at runtime, measured live.
  const raw = readFileSync(join(here, "fixtures", "hofer-phone-real.txt"), "utf8");
  assert.equal(parseReceipt(raw).date, null);
});
