export function parseReceipt(text) {
  const PARSER_VERSION = "v1.3.6";
  console.log("🧾 Receipt parser version:", PARSER_VERSION);

  function normalizeAmount(value, isSlovenian) {
    return isSlovenian
      ? value.replace(/\./g, "").replace(",", ".")
      : value.replace(/,/g, "");
  }

  function extractAmountFromLine(line, isSlovenian) {
    const regex = /(\d{1,3}(?:[ .,\s]?\d{3})*(?:[.,]\d{1,2}))\s*(EUR|USD|\$|€)?/gi;
    let match, lastMatch = null;
    while ((match = regex.exec(line)) !== null) lastMatch = match;
    if (!lastMatch) return null;
    const value = parseFloat(normalizeAmount(lastMatch[1], isSlovenian));
    const currency = lastMatch[2]?.toUpperCase?.() || null;
    return isNaN(value) ? null : { value, currency };
  }

  function extractAllTotalCandidates(lines, isSlovenian) {
    const totalKeywords = isSlovenian
      ? ["za plačilo", "skupaj", "znesek", "končni znesek", "skupna vrednost", "skupaj z ddv"]
      : ["total", "total amount", "amount due", "grand total", "amount", "to pay"];

    return lines
      .filter(line =>
        totalKeywords.some(kw => line.toLowerCase().includes(kw))
      )
      .map(line => {
        const parsed = extractAmountFromLine(line, isSlovenian);
        return {
          line,
          value: parsed?.value ?? 0,
          currency: parsed?.currency ?? null,
        };
      })
      .filter(entry => entry.value > 0)
      .sort((a, b) => b.value - a.value);
  }

  function tryFallbackTotal(lines, isSlovenian) {
    let net = null, vat = null;
    let currency = null;

    for (const line of lines) {
      const lower = line.toLowerCase();
      const parsed = extractAmountFromLine(line, isSlovenian);
      if (!parsed) continue;

      if (isSlovenian) {
        if (lower.includes("osnova za ddv") || lower.includes("brez ddv"))
          net = parsed.value;
        if (lower.includes("skupaj ddv") || (lower.includes("ddv") && lower.includes("%")))
          vat = parsed.value;
      } else {
        if (lower.includes("net")) net = parsed.value;
        if (lower.includes("vat") || lower.includes("tax")) vat = parsed.value;
      }

      currency = parsed.currency ?? currency;
    }

    if (net != null && vat != null) {
      const total = parseFloat((net + vat).toFixed(2));
      console.log(`💡 Fallback total from net + VAT: ${net} + ${vat} = ${total}`);
      return { value: total, currency };
    }

    return null;
  }

  function extractDate(lines) {
    const dateRegex = /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/;
    const match = lines.find(line => dateRegex.test(line))?.match(dateRegex);
    if (!match) return null;
    const raw = match[1];
    const parts = raw.split(/[./-]/).map(Number);
    if (parts[0] > 31) return raw;
    let day, month, year;
    if (parts[2] < 100) parts[2] += 2000;
    [day, month, year] = parts[0] > 12 ? parts : [parts[1], parts[0], parts[2]];
    return `${year.toString().padStart(4, "0")}-${month
      .toString()
      .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  }

  const lines = text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  const joinedText = lines.join(" ").toLowerCase();
  const isSlovenian = [
    "račun", "kupec", "ddv", "znesek", "ponudba", "skupaj", "za plačilo"
  ].some(keyword => joinedText.includes(keyword));

  const excludeKeywords = isSlovenian
    ? ["številka", "transakcija", "ddv", "datum", "račun", "osnovni kapital", "ponudbe", "rekapitulacija", "osnova", "veljavnost ponudbe"]
    : ["transaction", "terminal", "subtotal", "tax", "vat", "invoice", "date", "validity"];

  const totalCandidates = extractAllTotalCandidates(lines, isSlovenian);
  let total = null;
  let currency = "€";

  if (totalCandidates.length > 0) {
    total = totalCandidates[0].value;
    currency = totalCandidates[0].currency ?? currency;
  }

  const fallbackTotal = tryFallbackTotal(lines, isSlovenian);
  if (fallbackTotal && (!total || fallbackTotal.value < total)) {
    console.log("⚠️  Using fallback total from net + ddv.");
    total = fallbackTotal.value;
    currency = fallbackTotal.currency ?? currency;
  }

  const date = extractDate(lines);
  const items = [];

  for (const line of lines) {
    if (/veljavnost ponudbe/i.test(line)) continue;
    if (totalCandidates.some(t => t.line === line)) continue;
    if (/rekapitulacija|osnova za ddv|skupaj ddv/i.test(line)) continue;

    const priceMatch = line.match(/(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/);
    if (!priceMatch) continue;

    const rawAmount = priceMatch[1];
    const price = normalizeAmount(rawAmount, isSlovenian);
    let namePart = line.slice(0, priceMatch.index).trim();
    namePart = namePart.replace(/^\d{1,3}\s?[—\-–]?\s*/g, "").trim();
    if (namePart.length < 2) continue;

    const hasExcludedKeyword = excludeKeywords.some(kw =>
      new RegExp(`\\b${kw}\\b`, "i").test(namePart)
    );
    if (hasExcludedKeyword) continue;

    items.push({ name: namePart, price: `${parseFloat(price).toFixed(2)} ${currency}` });
  }

  return {
    version: PARSER_VERSION,
    date,
    total: total ? `${total.toFixed(2)} ${currency}` : null,
    items
  };
}
