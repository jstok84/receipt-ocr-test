/**
 * v2.0.21 corpus test: user's phone scan of the EUROSPIN Sežana receipt
 * (deployed v2.0.20 run, 2026-10-25). All three item rows read exact
 * (1,55 + 1,29 + 1,45 = 4,29) and the printed total "Skupaj (EUR): 4,29"
 * garbled to "naj (EUR): 4,29" — while the garbled DDV-recap header
 * "Lj! Us ova Dr Skupaj" fetched its amount from the VALUES row below,
 * "? 2% 9 r 4,20" (the printed recap 4,29 misread). The tier-2 "skupaj"
 * candidate won by document order → picked total 4.20 → phantom mismatch
 * "items sum 4.29 ≠ total 4.20" that no rescue could legitimately explain.
 * (Same class but different outcome on tests/fixtures/eurospin-scan-real.txt
 * — there the recap value row reads the CORRECT 4,29, so the two captures
 * agree on the paper: 4,29 everywhere; one digits misread.)
 * v2.0.21: a total-candidate fetched from a BELOW-line never comes from a
 * percent row — %-rows are duty-recap machinery. The printed Skupaj (EUR)
 * total wins; the receipt reads green.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReceipt } from "../src/parseReceipt.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "fixtures", "scan-eurospin-user-real.txt"), "utf8");

if (typeof globalThis.window === "undefined") globalThis.window = { __OCR_DEBUG: false };

test("scan-eurospin user capture: printed Skupaj (EUR) total wins, receipt green", () => {
  const r = parseReceipt(raw);
  assert.equal(r.total, "4.29 €", `total: ${r.total}`);
  assert.equal(r.items.length, 3, `items: ${JSON.stringify(r.items.map((i) => `${i.name} ${i.price}`))}`);
  assert.equal(r.items.find((i) => /frollini/i.test(i.name))?.price, "1.55 €");
  assert.equal(r.items.find((i) => /taralli/i.test(i.name))?.price, "1.29 €");
  assert.equal(r.items.find((i) => /čonulad|conulad/i.test(i.name))?.price, "1.45 €");
  const failing = r.checks.filter((c) => !c.ok);
  assert.deepEqual(failing, [], `no failing checks expected: ${JSON.stringify(r.checks)}`);
  assert.ok(
    r.checks.some((c) => c.ok && /items sum = total \(4\.29\)/.test(c.text)),
    `expected the exact-sum check: ${JSON.stringify(r.checks)}`
  );
});

test("recap guard: a Skupaj line whose amount sits on a %-row never forms a total", () => {
  const r = parseReceipt("Gotovina EUR 13,00\nLj skupaj\n? 2% 9 r 4,20\n");
  assert.equal(r.total, null, "recap % value row must not become the payable");
});
