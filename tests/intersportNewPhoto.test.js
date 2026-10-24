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
import { parseReceipt, payableRescue } from "../src/parseReceipt.js";

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

// ---- v2.0.15 payableRescue decision logic (Node-tested; ocrUtils supplies the
// ---- pay-zone MEASUREMENT — the decision only fires when the re-OCR measured
// ---- the derived payable items−POPUST ±0.02).

test("payableRescue: fires on the new-photo fixture when the pay-zone re-OCR measured 55.99", () => {
  const r = parseReceipt(raw);
  const out = payableRescue(r, raw, 55.99);
  assert.ok(out, "rescue should fire");
  assert.match(out.total, /^55\.99/);
  const bad = out.checks.filter((c) => !c.ok);
  assert.equal(bad.length, 0, `checks after rescue: ${JSON.stringify(out.checks)}`);
  const okChecks = out.checks.filter((c) => c.ok);
  assert.ok(
    okChecks.some((c) => /pay-zone re-OCR measured 55\.99/.test(c.text) && /POPUST 24\.00/.test(c.text)),
    `provenance check missing: ${JSON.stringify(okChecks)}`
  );
  assert.equal(out.items.length, 1);
});

test("payableRescue: a wrong measurement never fires (no arithmetic-only totals)", () => {
  const r = parseReceipt(raw);
  assert.equal(payableRescue(r, raw, 55.09), null, "measured ≠ items−POPUST");
  assert.equal(payableRescue(r, raw, null), null, "no measurement at all");
  assert.equal(payableRescue(r, raw, 79.99), null, "measured the item total, not the payable");
});

test("payableRescue: fires when total already = items−POPUST? No — returns null (nothing to fix)", () => {
  const r = parseReceipt(raw);
  // on the OLD capture the total parsed correctly (55.99) — the decision must
  // not rewrite a consistent total even with a matching measurement
  const consistent = { ...r, total: "55.99 €", checks: r.checks.slice(0, -1).concat([{ ok: false, text: "items sum 79.99 ≠ total 55.99 — verify a price [?] or a discount/missing item" }]) };
  // T=55.99 equals items−POPUST exactly -> no-fire
  assert.equal(payableRescue(consistent, raw, 55.99), null);
});

test("payableRescue: ambiguous discount amounts abort (SPAR coupon shape)", () => {
  const sparLike =
    "DESPAR PIZZA 2,25 A\n" +
    "KROKETI 1,40 A\n" +
    "1,55 A\n" +
    "SKUPAJ 57.35\n" +
    "KUPON POPUST 10.00% od 57.35 -5.74\n" +
    "ZA PLAČILO 99.99\n" +
    "PLAČANO: GOTOVINA 51.61\n";
  const r = parseReceipt(sparLike);
  const sumFail = r.checks.some((c) => !c.ok && /items sum/.test(c.text));
  if (sumFail) {
    assert.equal(payableRescue(r, sparLike, 51.61), null, "multi-number discount line must abort");
  }
});

test("payableRescue: no discount line at all -> cannot fire (HOFER phone fixture)", () => {
  const raw2 = readFileSync(join(here, "fixtures", "hofer-phone-real.txt"), "utf8");
  const r = parseReceipt(raw2);
  assert.equal(payableRescue(r, raw2, 12.14), null);
});

// ---- phone-line guard (this capture's drift read, locked so the standalone
// ---- 3-digit repair can never manufacture money from a telephone number)

test("phone-number line never becomes an item (Tel/00386 shapes, second re-photo read)", () => {
  const telRead =
    "INTERSPORT ISI d.o.o\n" +
    "Tel: 00386 (0)51 285 125\n" +
    "6438496871585 JAKNA M.POH BRIMFIELD š48\n" +
    "1,000 x 79,99 79 99\n" +
    "POPUST 24,00\n" +
    "PLAČANO: MASTERCARD 99,99\n";
  const r = parseReceipt(telRead);
  const names = r.items.map((i) => i.name);
  assert.ok(!names.some((n) => /tel/i.test(n)), `tel leak: ${JSON.stringify(names)}`);
  assert.equal(r.items.length, 1, `expected only JAKNA, got ${JSON.stringify(names)}`);
  // the country-code shape too, with the drifted separator ("10)51")
  const drifted =
    "Tel: 00386 10)51 285 125\n" +
    "ZA POSLEK 5,99 B\n";
  const r2 = parseReceipt(drifted);
  const names2 = r2.items.map((i) => i.name);
  assert.ok(!names2.some((n) => /tel|00386/i.test(n)), `drifted tel leak: ${JSON.stringify(names2)}`);
});
