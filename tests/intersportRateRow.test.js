/**
 * v2.0.19 corpus test: two fresh S25 phone captures of the INTERSPORT jacket
 * receipt (2026-10-24, uploaded to the sync bucket during the user's v2.0.18
 * runs — same paper as the v2.0.15/v2.0.18 INTERSPORT class). Both show the
 * discount row "(30,0%) - ŠPORTNE ZVEZDE -24,00" with OCR destroying the
 * minus sign and demoting its guard-word position:
 *   …2490: "(30.0%) - SPORTNE ZVEZDE 24,90" → phantom 24.90 ITEM (sum 104.89)
 *   …2400: "(30.0%) - ŠPORTNE ZVEZDE -24,00" (minus survives; no phantom, but
 *          ZA PLAČILO lost its amount ("x]") and the pay zones read 99,99)
 * The v2.0.19 guard: an item row never starts with a parenthesised rate
 * percentage. The pay story itself stays measurement-first: items 79.99,
 * POPUST 24.00 → D = 55.99, and only a MEASURED 55.99 moves the total.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt, payableRescue } from "../src/parseReceipt.js";

const here = dirname(fileURLToPath(import.meta.url));

if (typeof globalThis.window === "undefined") globalThis.window = { __OCR_DEBUG: false };

const cases = {
  minusLost: {
    raw: readFileSync(join(here, "fixtures", "intersport-s25-rate-row-2490-real.txt"), "utf8"),
    phantom: "24.90",
  },
  minusKept: {
    raw: readFileSync(join(here, "fixtures", "intersport-s25-rate-row-2400-real.txt"), "utf8"),
    phantom: "24.00",
  },
  // v2.0.28: the same receipt re-captured on the v2.0.27 build — OCR now
  // renders the receipt's vertical rule as a LEADING PIPE on the discount row
  // ("| (30.0%) - SPORTNE ZVEZDE -24.00"), which defeated the ^\( anchor and
  // put the phantom +24.00 item back. The pipe-stripped line must be tested
  // against the same exclusions; the live sweep then measured 55,99 on the
  // pay-zone strip, so the rescue cascade lands on the ledger total again.
  pipeLed: {
    raw: readFileSync(join(here, "fixtures", "intersport-s25-rate-row-2400-pipe-real.txt"), "utf8"),
    phantom: "24.00",
  },
};

for (const [label, { raw }] of Object.entries(cases)) {
  test(`rate-row guard (${label}): parenthesised % row never becomes an item`, () => {
    const r = parseReceipt(raw);
    const names = r.items.map((i) => `${i.name} ${i.price}`);
    assert.ok(
      !names.some((n) => /sportne|zvezd/i.test(n)),
      `rate row must not be an item: ${JSON.stringify(names)}`
    );
    const jakna = r.items.find((i) => /jakna/i.test(i.name));
    assert.ok(jakna, `JAKNA must survive: ${JSON.stringify(names)}`);
    assert.match(jakna.price, /^79\.99/);
    assert.ok(
      r.checks.some((c) => !c.ok && /items sum 79\.99 ≠ total 99\.99/.test(c.text)),
      `sum flag: ${JSON.stringify(r.checks)}`
    );
    assert.ok(
      !r.checks.some((c) => /missing item ≈/.test(c.text)),
      `DDV row here can never arm a bucket: ${JSON.stringify(r.checks)}`
    );
  });

  test(`pay decision (${label}): measured 55.99 → total via items − POPUST 24.00`, () => {
    const r = parseReceipt(raw);
    const out = payableRescue(r, raw, 55.99);
    assert.ok(out, "pay-zone rescue must fire on the measured 55.99");
    assert.match(out.total, /^55\.99/);
    const okCheck = out.checks.find((c) => /verified/.test(c.text));
    assert.ok(okCheck, `provenance present: ${JSON.stringify(out.checks)}`);
    assert.match(okCheck.text, /measured 55\.99/);
    assert.match(okCheck.text, /matches items 79\.99 − POPUST 24\.00/);
    assert.match(okCheck.text, /printed pay lines read 99\.99/);
  });

  test(`pay decision (${label}): a mismatched measurement stays rejected`, () => {
    const r = parseReceipt(raw);
    assert.equal(payableRescue(r, raw, 45.69), null, "DDV osnova is not the payable");
    assert.equal(payableRescue(r, raw, 99.99), null, "printed misread must not confirm itself");
  });
}

// v2.0.28: the pipe fix must not over-exclude. A real merchandise row that
// merely carries a leading rule ("| MLEKO …") keeps its item status — the
// exclusions match machinery SHAPES, not the pipe itself.
test("pipe tolerance: a real item row behind a leading pipe stays an item", () => {
  const raw = [
    "HOFER TRGOVINA D.O.O.",
    "| 760801 Brioš marmo. kolač 3,36 A",
    "| 736115 Skleda za mešanje 8,49 B",
    "HOFER CENA 12.14",
  ].join("\n");
  const r = parseReceipt(raw);
  const names = r.items.map((i) => i.name);
  assert.ok(names.some((n) => /skleda/i.test(n)), `Skleda must survive: ${JSON.stringify(names)}`);
  assert.ok(names.some((n) => /brio/i.test(n)), `Brioš must survive: ${JSON.stringify(names)}`);
  assert.equal(r.items.length, 2, JSON.stringify(names));
});

// v2.0.28: the donor guard (qty×price row) reads the line ABOVE it. A
// machinery line behind a pipe must not donate an item either.
test("pipe tolerance: pipe-led machinery line never donates a qty×price item", () => {
  const raw = [
    "| SKUPAJ 79,99",
    "1,000 x 79,99 79 99",
    "6438496871585 JAKNA M. POH BRIMFIELD š48 |",
    "1,000 x 79,99 79 99",
  ].join("\n");
  const r = parseReceipt(raw);
  const names = r.items.map((i) => i.name);
  assert.ok(
    !names.some((n) => /skupaj/i.test(n)),
    `SKUPAJ must not donate an item: ${JSON.stringify(names)}`
  );
  assert.ok(names.some((n) => /jakna/i.test(n)), `JAKNA must survive: ${JSON.stringify(names)}`);
});
