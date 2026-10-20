/**
 * SPAR coupon-regression pins (2026-10-20, live user run after v1.7.6): the
 * SPAR receipt has a LEGITIMATE items-sum gap (26 items = exactly 57.35,
 * "KUPON POPUST 10.00% od 57.35 -5.74" -> total 51.61), which must never
 * trigger band-rescue price corrections there. The live run produced 4
 * corrupting corrections: a strip row ("SPAR AJVAR POLPEK. … 1.19") paired
 * with the WRONG item ("SPAR TRAJNO MLEKO", brand-prefix LCS 0.667), a PSM-4
 * garble (VAF.KAR. 1.09 for 1,69), another garble (BAZILIKA 1.43), and the
 * popust column 0.16 read as AJVAR's price — each individually "improved"
 * toward the discounted total, collectively corrupting 4 correct rows.
 * Guards now: parser discount gate, distinctive-token matching + best-match,
 * all-or-nothing commit (corrections survive only if the final sum actually
 * reaches the total).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt, namesScore, namesSimilar } from "../src/parseReceipt.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "fixtures", "spar-coupon-browser.txt"), "utf8");

if (typeof globalThis.window === "undefined") {
  globalThis.window = { __OCR_DEBUG: false };
}

test("spar coupon run: parses as before (date, total, 26 items)", () => {
  const r = parseReceipt(raw);
  assert.equal(r.date, "2022-02-05", `date: ${r.date}`);
  assert.equal(r.total, "51.61 €", `total: ${r.total}`);
  assert.equal(r.items.length, 26, `items: ${r.items.map((i) => i.name).join(", ")}`);
});

test("spar coupon run: the legit coupon gap stays flagged, uncorrected", () => {
  const r = parseReceipt(raw);
  const trajno = r.items.find((i) => /TRAJNO/i.test(i.name));
  const ajvar = r.items.find((i) => /AJVAR/i.test(i.name));
  const bazilika = r.items.find((i) => /BAZILIKA/i.test(i.name));
  assert.ok(trajno && trajno.price.startsWith("2.37"), `trajno: ${JSON.stringify(trajno)}`);
  assert.ok(ajvar && ajvar.price.startsWith("1.19"), `ajvar: ${JSON.stringify(ajvar)}`);
  assert.ok(bazilika && bazilika.price.startsWith("1.49"), `bazilika: ${JSON.stringify(bazilika)}`);
});

test("spar coupon run: exactly the 4 live-corrupting candidates apply to NOTHING", () => {
  // candidate set reconstructed from the live evidence panel (attempts 1-2)
  const r2 = parseReceipt(raw, [], [
    { name: "SPAR AJVAR POLPEK. 3600", price: 1.19 }, // live: corrected TRAJNO to 1.19 (wrong item)
    { name: "SPAR VAF.KAR. 4006", price: 1.09 },      // live: PSM-4 garble of 1,69
    { name: "OMAKA BAZILIKA 2806", price: 1.43 },     // live: garble of 1,49
    { name: "SPAR AJVAR POLPEK.3606", price: 0.16 },  // live: popust column read as price
  ]);
  assert.ok(!r2.items.some((i) => i.via === "strip-corrected"), `corrupted items: ${r2.items.filter((i) => i.via === "strip-corrected").map((i) => i.name)}`);
  assert.ok(!r2.checks.some((c) => c.text.includes("price corrected")), "no provenance notes");
  const trajno = r2.items.find((i) => /TRAJNO/i.test(i.name));
  const vaf = r2.items.find((i) => /VAF\.KAR/i.test(i.name));
  assert.ok(trajno && trajno.price.startsWith("2.37"), `trajno must stay 2.37, got ${JSON.stringify(trajno)}`);
  assert.ok(vaf && vaf.price.startsWith("1.69"), `vaf.kar must stay 1.69, got ${JSON.stringify(vaf)}`);
});

test("spar coupon run: discount gate is parser-level (even valid corrections are ignored)", () => {
  const r = parseReceipt(raw, [], [
    { name: "OMAKA BAZILIKA 2806", price: 1.55 },
  ]);
  assert.ok(!r.items.some((i) => i.via === "strip-corrected"), "gate must ignore ALL corrections on coupon receipts");
});

const noDiscount = "Skupaj (EUR): 11,00\nTEST IZDELEK 6,00 A\nTEST ELEM 5,99 B";

test("all-or-nothing: individually improving correction that misses the total is reverted", () => {
  // 11.99 sum vs 11.00 total (gap 0.99); candidate 5.50 -> 11.49 (gap 0.49,
  // strictly closer) but the final sum still misses the total -> commit vetoed
  const r = parseReceipt(noDiscount, [], [
    { name: "TEST IZDELEK", price: 5.5 },
  ]);
  const item = r.items.find((i) => /IZDELEK/i.test(i.name));
  assert.ok(item && item.price.startsWith("6.00"), `must stay 6.00, got ${JSON.stringify(item)}`);
  assert.ok(!r.checks.some((c) => c.text.includes("price corrected")), "no note for reverted set");
});

test("all-or-nothing: a correction set that reaches the total commits", () => {
  // candidate brings the sum exactly onto the total
  const r = parseReceipt(noDiscount, [], [
    { name: "TEST IZDELEK", price: 5.01 },
  ]);
  const item = r.items.find((i) => /IZDELEK/i.test(i.name));
  assert.ok(item && item.price.startsWith("5.01"), `expected 5.01, got ${JSON.stringify(item)}`);
  assert.equal(item.via, "strip-corrected");
  assert.ok(r.checks.find((c) => c.text.includes("items sum")).ok, "sum check passes after commit");
});

test("namesScore: brand-prefix pairs rejected, eurospin garble twins accepted", () => {
  // the live SPAR wrong-item pair (shared SPAR prefix, LCS 0.667)
  assert.ok(namesScore("SPAR AJVAR POLPEK. 3600", "SPAR TRAJNO MLEKO") < 0.75, "brand prefix must not pair");
  assert.ok(!namesSimilar("SPAR AJVAR POLPEK. 3600", "SPAR TRAJNO MLEKO"));
  assert.ok(!namesSimilar("SPAR VAFLJI MASLENI 25", "SPAR TRAJNO MLEKO"));
  // pins that must keep working (v1.7.6 eurospin):
  assert.ok(namesSimilar("EKSI FROLLINI 1KG", "PFKSI FROLLINI 1KG"), "shared distinctive token");
  assert.ok(namesSimilar("SI CORULADNI 225G", "<ST ČONULADNI"), "LCS 0.75 twin");
  assert.ok(namesSimilar("LANI PRT. TARALLI M", "| ANI PRTA.TARALLT M"), "garble-twin rows");
  assert.ok(!namesSimilar("JOGURT WOLY V ANANASU", "PFKSI FROLLINI 1KG"));
});
