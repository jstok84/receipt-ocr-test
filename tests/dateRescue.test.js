/**
 * v2.0.22 date-rescue pins (user hoferracun1.jpg — the HOFER EFT-appendix
 * receipt whose only date printed sits in the payment appendix; OCR garbles
 * "11.03.2025 08:11" into "a 103.2025 08:11" across runs, so the date
 * extracted "2025-03-11" on good runs and null on garbled ones — pinned
 * ground truth in hofer.test.js + fixtures).
 *
 * Policy: NO decomposition of an ambiguous digit run ("103.2025" is the
 * three-way merge 1.03 / 10.3 / 11.03 — inventing a day would be the same
 * sin as arithmetic overriding a printed total). Instead: re-MEASURE the
 * pixels with the pay-arm machinery (strip + zoom + kernel diversity) and
 * accept ONLY a complete, calendar-valid reading.
 *
 * Arm rule: date==null (caller) AND findDateCandidate(text) — a line with a
 * single fused group.20xx-year via one dot + a time anchor.
 * Accept rule: validDateFromReading(stripLines) — complete 20xx calendar
 * date or null. Every helper is pure so the decisions are pinned here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt, findDateCandidate, validDateFromReading } from "../src/parseReceipt.js";

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
