/**
 * v2.0.18 corpus test: the HOFER total-drift capture (user run on deployed
 * v2.0.17, 2026-10-24). All three item rows read exact (1.79 + 0.85 + 2.09 =
 * 4.73) while the printed total line drifted to 4,13 — a NEGATIVE missing
 * gap with NO discount line, the class the entire existing rescue machinery
 * could not arm against (v1.7.2 needs missing > 0; v2.0.15 needs a POPUST
 * line). Pins the parse surface and every payableRescue decision branch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt, payableRescue } from "../src/parseReceipt.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "fixtures", "hofer-total-drift-real.txt"), "utf8");

if (typeof globalThis.window === "undefined") globalThis.window = { __OCR_DEBUG: false };

test("total-drift HOFER: parse keeps all 3 exact items, flag survives with the drifted total", () => {
  const r = parseReceipt(raw);
  const names = r.items.map((i) => i.name);
  assert.equal(r.items.length, 3, `items: ${JSON.stringify(r.items)}`);
  assert.equal(r.items.find((i) => /kruger/i.test(i.name))?.price, "1.79 €");
  assert.equal(r.items.find((i) => /barcaffe/i.test(i.name))?.price, "2.09 €");
  assert.match(r.total, /^4\.13/, `total: ${r.total}`);
  const bad = r.checks.filter((c) => !c.ok);
  assert.ok(
    bad.some((c) => /items sum 4\.73 ≠ total 4\.13/.test(c.text)),
    `expected the sum-mismatch flag: ${JSON.stringify(r.checks)}`
  );
  assert.ok(
    !r.checks.some((c) => /missing item ≈/.test(c.text)),
    `a negative gap must NOT invent a missing-item bucket: ${JSON.stringify(r.checks)}`
  );
});

test("v2.0.18 decision: rescues when the pay-zone strip MEASURES back the items sum", () => {
  const r = parseReceipt(raw);
  const out = payableRescue(r, raw, 4.73);
  assert.ok(out, "rescue should fire");
  assert.match(out.total, /^4\.73/);
  const bad = out.checks.filter((c) => !c.ok);
  assert.equal(bad.length, 0, `checks: ${JSON.stringify(out.checks)}`);
  const okCheck = out.checks.find((c) => /verified/.test(c.text));
  assert.ok(okCheck, "provenance check present");
  assert.match(okCheck.text, /measured 4\.73/);
  assert.match(okCheck.text, /no discount line/);
  assert.match(okCheck.text, /printed total read 4\.13/);
});

test("v2.0.18 decision: strip re-reading the SAME misread cannot move the total", () => {
  const r = parseReceipt(raw);
  assert.equal(payableRescue(r, raw, 4.13), null, "measured must equal the DERIVED target, not the drifted reading");
  assert.equal(payableRescue(r, raw, null), null);
});

test("v2.0.18 decision: a missing-row (bucket) story aborts — never accept a lowered total", () => {
  const r = parseReceipt(raw);
  const withBucket = {
    ...r,
    checks: r.checks.concat([{ ok: false, text: "VAT 22% recap row implies a missing item ≈ 0.60 € (neto 0.49) — row not captured by OCR" }]),
  };
  assert.equal(payableRescue(withBucket, raw, 4.73), null, "bucket check must gate the rescue");
});

test("v2.0.18 decision: measured amount that matches NEITHER side stays rejected", () => {
  const r = parseReceipt(raw);
  assert.equal(payableRescue(r, raw, 4.99), null);
});
