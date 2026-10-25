/**
 * Scan verdict: a one-line, data-backed summary of WHAT the pipeline found,
 * computed from the finished OCR text + parse. The evidence panel reports it
 * BEFORE dumping raw text, so a noise-photo scan answers "what happened and
 * why" instead of forcing the reader through garbled lines.
 *
 * Pure text/parse analysis — decision inputs:
 *  - amount lines: any line carrying a plausible decimal amount (…[.,]dd)
 *  - merchant keyword lines: SKUPAJ/CENA/PLAČILO/… (SI retail footer/header)
 *  - parse outcome: total/items/checks presence
 */

const KEYWORDS = /(?:^|\W)(skupaj|cena|pla[čc]ilo|gotovina|kartica|popust|iskanica|artikel|znesek|ddv|racun|ra[čc]un|int|racka)(?=\W|$)/i;
const AMOUNT = /\b\d{1,3}(?:[.]\d{3})*[.,]\d{2}(?:\b|$)/;

export function scanVerdict(text, parsed) {
  const lines = String(text ?? "").split("\n").filter(l => l.trim().length > 0);
  const stats = {
    lines: lines.length,
    amountLines: lines.filter(l => AMOUNT.test(l)).length,
    keywordLines: lines.filter(l => KEYWORDS.test(l)).length,
  };
  const failing = (parsed?.checks ?? []).filter(c => !c.ok).length;
  const servedTotal = parsed?.total || null;
  const itemCount = parsed?.items?.length ?? 0;

  if (!lines.length) {
    return { kind: "empty", stats, detail: "OCR produced no text at all — nothing to parse." };
  }

  // "Read OK" requires a SERVED TOTAL. Counting items alone must never
  // headline "Read OK" — when no total was read, the items-sum check cannot
  // come to a verdict, so the receipt is at best partially verified (the
  // Phase-A false-green shape: items present → everything looked fine).
  if (servedTotal) {
    const parts = [];
    parts.push(`total ${servedTotal}`);
    parts.push(`${itemCount} item${itemCount === 1 ? "" : "s"}`);
    parts.push(`${failing} failing check${failing === 1 ? "" : "s"}`);
    return { kind: "receipt", stats, detail: `Read OK: ${parts.join(", ")}.` };
  }
  if (itemCount) {
    return {
      kind: "partial",
      stats,
      detail: `${itemCount} item${itemCount === 1 ? "" : "s"} recognized, but no total was read from the receipt — the items-sum check cannot run. Do not treat this scan as verified; check the data below against the photo.`,
    };
  }
  if (!stats.amountLines && !stats.keywordLines) {
    return {
      kind: "garbage",
      stats,
      detail: `No receipt-like content (${stats.lines} OCR lines, 0 amount lines, 0 merchant keywords) — the photo likely does not contain a readable receipt. Retake straight-on, receipt filling the frame.`,
    };
  }
  return {
    kind: "partial",
    stats,
    detail: `${stats.amountLines} amount line${stats.amountLines === 1 ? "" : "s"} and ${stats.keywordLines} keyword line${stats.keywordLines === 1 ? "" : "s"} found, but no total or items were recognized — the receipt region is partially unreadable at this capture quality.`,
  };
}
