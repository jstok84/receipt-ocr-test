/**
 * Scan-verdict helper — evidence-panel reporting. Locked on real data shapes:
 * the phone-fixtures corpus (mouse-photo noise, HOFER phone scan) plus an
 * ambiguous partial case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt } from "../src/parseReceipt.js";
import { scanVerdict } from "../src/scanVerdict.js";

const here = dirname(fileURLToPath(import.meta.url));

if (typeof globalThis.window === "undefined") globalThis.window = { __OCR_DEBUG: false };

test("verdict: noise photo (real mouse shot OCR) → garbage with actionable detail", () => {
  const noise = "Pa:\nLR\nv\n\" a\n> \"\nBy\nre.\nd 3\nm. : :\n4\nda '\nis.\n";
  const v = scanVerdict(noise, null);
  assert.equal(v.kind, "garbage");
  assert.match(v.detail, /0 amount lines, 0 merchant keywords/);
});

test("verdict: zero text → empty", () => {
  for (const t of ["", "   \n  "]) {
    assert.equal(scanVerdict(t, null).kind, "empty");
  }
});

test("verdict: parsed receipt (real HOFER phone OCR) → receipt", () => {
  const raw = readFileSync(join(here, "fixtures", "hofer-phone-real.txt"), "utf8");
  const parsed = parseReceipt(raw);
  const v = scanVerdict(raw, parsed);
  assert.equal(v.kind, "receipt");
  assert.match(v.detail, /total 12\.14/);
});

test("verdict: partial read INTERSPORT-like (amounts but no parse) → partial", () => {
  // line fragments from the real phone INTERSPORT OCR (checkout totals garbled)
  const partial = "Artikel Kol Cena Znesek\n3849687 JAKNA W.poH SRIMFIELD 548\nSKUPAJ 79,99\n";
  const v = scanVerdict(partial, null);
  assert.equal(v.kind, "partial");
});

test("verdict: full-pipeline receipt with failing checks reports the count", () => {
  // HOFER phone fixture pre-guard behavior: a failing sum check, but parsed
  const raw = readFileSync(join(here, "fixtures", "hofer-phone-real.txt"), "utf8");
  const parsed = parseReceipt(raw);
  const failing = parsed.checks.filter(c => !c.ok).length;
  const v = scanVerdict(raw, parsed);
  assert.match(v.detail, new RegExp(`${failing} failing check`));
});
