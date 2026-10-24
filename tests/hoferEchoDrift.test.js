/**
 * v2.0.19 corpus test: the HOFER EFT-tail capture AGAIN (same physical photo
 * as fixtures/hofer-eft-scan.txt, user's re-scan on deployed v2.0.18,
 * 2026-10-24) — this run's drift turned the machinery hostile INSTEAD of the
 * total zone: "AR | Znesel-BFT ER: 1 - 4.73" became a phantom 4.73 ITEM, and
 * the DDV-recap tail "Se RI 5 Wal CARR A 3,94 …" became a phantom 3.94 ITEM,
 * while "WIEN VISA Mm 4.13" (garbled EFT appendix) outranked the clean
 * "Vmesna vsota 4,73". Items sum 11.61 ≠ total 4.13 — no rescue could arm.
 *
 * The v2.0.19 guards sit at the SOURCE: the echo line is non-item machinery,
 * the line directly following a neto recap row is machinery tail. With both
 * phantoms excluded the existing stack composes: items 0.85 + 2.09 = 2.94 →
 * v2.0.19 arm retargets the strip to 4.73 − 2.94 = 1.79 (the keyword total
 * "Vmesna vsota 4,73" exceeds the visa-misread 4.13) → Krüger row recovered
 * (measured evidence, simulated below exactly as app.js builds it) → items
 * 4.73 ≠ total 4.13 → pay-zone rescue: strip re-measures vsota 4,73 → green.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt, payableRescue } from "../src/parseReceipt.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "fixtures", "hofer-echo-drift-real.txt"), "utf8");

if (typeof globalThis.window === "undefined") globalThis.window = { __OCR_DEBUG: false };

test("echo + recap-tail guards: phantoms never become items, real items survive", () => {
  const r = parseReceipt(raw);
  const names = r.items.map((i) => `${i.name} ${i.price}`);
  // EXACT set — the echo 4.73 and recap-tail 3.94 must be gone (was 4 items / 11.61).
  assert.equal(r.items.length, 2, `items: ${JSON.stringify(names)}`);
  assert.equal(r.items.find((i) => /šumeče/i.test(i.name))?.price, "0.85 €");
  assert.equal(r.items.find((i) => /barcaffe/i.test(i.name))?.price, "2.09 €");
  assert.ok(
    !names.some((n) => /znesel|zresek|nesek-b|se ri/i.test(n)),
    `echo/recap-tail phantoms must never appear: ${JSON.stringify(names)}`
  );
  // Tier-3 payment markers keep their rank over tier-1 "vsota" (SPAR pin):
  // the garbled EFT-appendix visa line still wins total selection…
  assert.match(r.total, /^4\.13/, `total: ${r.total}`);
  // …and the mismatch stays an honest, resolvable flag.
  assert.ok(
    r.checks.some((c) => !c.ok && /items sum 2\.94 ≠ total 4\.13/.test(c.text)),
    `expected the sum-mismatch flag: ${JSON.stringify(r.checks)}`
  );
  assert.ok(
    !r.checks.some((c) => /missing item ≈/.test(c.text)),
    `garbled recap rows must NOT arm a bucket: ${JSON.stringify(r.checks)}`
  );
});

test("measured composition: strip-measured Krüger row + measured 4.73 → green", () => {
  // The strip re-OCR's MEASURED reading of the injured line (the photo prints
  // "Kruger šum.tablete 1,79"; the primary pass garbled it to "io > 8").
  const extraItems = [
    { name: "Kruger sum.tablete", price: "1.79 €", quantity: undefined, via: "strip-retry" },
  ];
  const r = parseReceipt(raw, extraItems, []);
  assert.equal(r.items.length, 3, `items: ${JSON.stringify(r.items.map((i) => `${i.name} ${i.price}`))}`);
  assert.ok(
    r.checks.some((c) => !c.ok && /items sum 4\.73 ≠ total 4\.13/.test(c.text)),
    `post-rescue sum flag: ${JSON.stringify(r.checks)}`
  );
  const out = payableRescue(r, raw, 4.73);
  assert.ok(out, "pay-zone rescue must fire on the measured vsota 4,73 reading");
  assert.match(out.total, /^4\.73/);
  const bad = out.checks.filter((c) => !c.ok);
  // The ONLY failing check allowed is the strip-provenance note (its [?] is by
  // design: the recovered row must still be verified against the photo).
  assert.deepEqual(
    bad.map((c) => c.text.replace(/\s+/g, " ")),
    bad.length === 1 && /recovered by top-strip re-OCR/.test(bad[0].text)
      ? [bad[0].text.replace(/\s+/g, " ")]
      : [],
    `checks: ${JSON.stringify(out.checks)}`
  );
  const okCheck = out.checks.find((c) => /verified/.test(c.text));
  assert.match(okCheck.text, /measured 4\.73/);
  assert.match(okCheck.text, /no discount line/);
});

test("no unmeasured arithmetic: pre-rescue parse rejects a 4.73 measurement", () => {
  const r = parseReceipt(raw);
  // Story must not "lower" the total to a deficient items sum here: D = 2.94,
  // a measured 4.73 does NOT match it — the rescue stays off until the strip
  // has actually recovered the row (previous test).
  assert.equal(payableRescue(r, raw, 4.73), null);
});
