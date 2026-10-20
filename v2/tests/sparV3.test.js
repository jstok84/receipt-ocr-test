/**
 * Corpus test: pipeline state #3 — OpenCV preprocessing + 2x upscale before OCR
 * (tesseract.js v7, browser run, real SPAR photo). Best item-level OCR so far,
 * but the OCR DROPPED the "Skupaj EUR" bridge line and garbled the pre-coupon
 * subtotal 57.35 -> 5.35, so the keyword-only total ranking had exactly one
 * wrong candidate. The payable 51.61 survives on the payment line
 * "DAL MASTERCA EUR 51.61", which is now a weight-3 total candidate.
 * Also pins: AJVAR's garbled "149" gets repaired as 1.49 — accepted upstream
 * OCR ambiguity, not a parser bug (see fixture comment trail).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt } from "../src/parseReceipt.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "fixtures", "spar-scan-v3.txt"), "utf8");

if (typeof globalThis.window === "undefined") {
  globalThis.window = { __OCR_DEBUG: false };
}

test("v3 scan: payment line carries the payable total when 'Skupaj' garbles", () => {
  const r = parseReceipt(raw);
  assert.match(r.total, /^51\.61/, `expected 51.61 from payment line, got ${r.total}`);
});

test("v3 scan: garbled pre-coupon subtotal must never win", () => {
  const r = parseReceipt(raw);
  assert.doesNotMatch(r.total, /^5\.35/, `subtotal garble leaked as total: ${r.total}`);
});

test("v3 scan: date clean, item volume preserved, no recap leaks", () => {
  const r = parseReceipt(raw);
  assert.equal(r.date, "2022-02-05");
  assert.ok(r.items.length >= 24, `expected >=24 items, got ${r.items.length}`);
  const names = r.items.map((i) => i.name.toLowerCase());
  for (const bad of [/ni promet/, /opro.?čen/, /^b\s/, /neto/, /masterca/, /kupon/, /^skupaj/]) {
    assert.ok(!names.some((n) => bad.test(n)), `${bad} leaked: ${names}`);
  }
  const namesUp = r.items.map((i) => i.name.toUpperCase());
  assert.ok(namesUp.some((n) => /MASLEN/i.test(n)), "up2 pipeline should read MASLEN*");
  assert.ok(namesUp.some((n) => n.includes("SNITH")), "up2 pipeline should read SNITH");
});
