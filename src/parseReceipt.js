export function parseReceipt(text) {
  const PARSER_VERSION = "v1.4.2";
  console.log("🧾 Receipt parser version:", PARSER_VERSION);

  function normalizeAmount(value, isSlovenian) {
    if (isSlovenian) {
      if (value.includes(",")) {
        return value.replace(/\./g, "").replace(",", ".");
      } else {
        const dotCount = (value.match(/\./g) || []).length;
        if (dotCount <= 1) return value;
        return value.replace(/\./g, "");
      }
    } else {
      return value.replace(/,/g, "");
    }
  }

  function extractAmountFromLine(line, isSlovenian) {
    const regex = /(\d{1,3}(?:[ .,\s]?\d{3})*(?:[.,]\d{1,2}))\s*(EUR|USD|\$|€)?/gi;
    let match, lastMatch = null;
    while ((match = regex.exec(line)) !== null) lastMatch = match;
    if (!lastMatch) return null;
    const rawValue = lastMatch[1];
    const normalizedValue = normalizeAmount(rawValue, isSlovenian);
    const value = parseFloat(normalizedValue);
    const currency = lastMatch[2]?.toUpperCase?.() || null;
    return isNaN(value) ? null : { value, currency };
  }

  // Extract all total amount candidates (checks two lines if needed) and excludes 'keine'
  function extractAllTotalCandidates(lines, isSlovenian) {
    const totalKeywords = isSlovenian
      ? ["plačano", "za plačilo", "skupaj", "znesek", "končni znesek", "skupna vrednost", "skupaj z ddv"]
      : ["paid", "total", "amount due", "grand total", "amount", "to pay"];

    const candidates = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!totalKeywords.some(kw => line.toLowerCase().includes(kw))) continue;
      if (line.toLowerCase().includes("keine")) continue;

      let parsed = extractAmountFromLine(line, isSlovenian);
      if (!parsed) {
        const nextLine = lines[i + 1];
        if (nextLine) {
          parsed = extractAmountFromLine(nextLine, isSlovenian);
          if (parsed) {
            candidates.push({ line: line + " " + nextLine, value: parsed.value, currency: parsed.currency });
            continue;
          }
        }
      }
      if (parsed && parsed.value > 0) {
        candidates.push({ line, value: parsed.value, currency: parsed.currency });
      }
    }
    candidates.sort((a, b) => b.value - a.value);
    return candidates;
  }

  // Fallback to total from VAT breakdown if total failed
  function tryFallbackTotal(lines, isSlovenian) {
    let net = null, vat = null, currency = null;
    for (const line of lines) {
      const lower = line.toLowerCase();
      const parsed = extractAmountFromLine(line, isSlovenian);
      if (!parsed) continue;

      const vatMatch = line.match(/c\s+\d{1,2},\d{1,2}\s*%\s+(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))\s+(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/i);
      if (vatMatch) {
        net = parseFloat(normalizeAmount(vatMatch[1], isSlovenian));
        vat = parseFloat(normalizeAmount(vatMatch[2], isSlovenian));
        currency = parsed.currency ?? currency;
        if (!isNaN(net) && !isNaN(vat)) {
          const total = parseFloat((net + vat).toFixed(2));
          console.log(`💡 Fallback from VAT summary: ${net} + ${vat} = ${total}`);
          return { value: total, currency };
        }
      }
      if (isSlovenian) {
        if (lower.includes("osnova za ddv") || lower.includes("brez ddv")) net = parsed.value;
        if (lower.includes("skupaj ddv") || (lower.includes("ddv") && lower.includes("%"))) vat = parsed.value;
      } else {
        if (lower.includes("net")) net = parsed.value;
        if (lower.includes("vat") || lower.includes("tax")) vat = parsed.value;
      }
    }
    if (net !== null && vat !== null) {
      const total = parseFloat((net + vat).toFixed(2));
      return { value: total, currency };
    }
    return null;
  }

  // Extract date in ISO yyyy-MM-dd format from lines
  function extractDate(lines) {
    const dateRegex = /\b(0?[1-9]|[12][0-9]|3[01])[./-](0?[1-9]|1[0-2])[./-](\d{2}|\d{4})\b/;
    for (const line of lines) {
      const match = line.match(dateRegex);
      if (match) {
        let day = parseInt(match[1], 10);
        let month = parseInt(match[2], 10);
        let year = parseInt(match[3], 10);
        if (year < 100) year += 2000;
        return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
      }
    }
    return null;
  }

  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const joinedText = lines.join(" ").toLowerCase();
  const isSlovenian = ["račun", "kupec", "ddv", "znesek", "ponudba", "skupaj", "za plačilo", "plačano"]
    .some(kw => joinedText.includes(kw));

  const excludeKeywords = isSlovenian
    ? ["številka", "transakcija", "ddv", "datum", "račun", "osnovni kapital", "ponudbe", "rekapitulacija", "osnova", "veljavnost ponudbe", "keine"]
    : ["transaction", "terminal", "subtotal", "tax", "vat", "invoice", "date", "validity"];

  const dateLikeAmountRegex = /^\d{1,2}[.,]\d{1,2}$/;

  const totalCandidates = extractAllTotalCandidates(lines, isSlovenian);
  let total = null;
  let currency = "€";

  if (totalCandidates.length > 0) {
    total = totalCandidates[0].value;
    currency = totalCandidates[0].currency ?? currency;
  }

  const fallbackTotal = tryFallbackTotal(lines, isSlovenian);
  if (fallbackTotal) {
    const delta = total ? Math.abs(fallbackTotal.value - total) : 0;
    if (!total || delta <= 0.05 || fallbackTotal.value > total) {
      console.log(`✅ Using fallback total: ${fallbackTotal.value} > main: ${total}`);
      total = fallbackTotal.value;
      currency = fallbackTotal.currency ?? currency;
    } else {
      console.log(`⚠️ Ignoring fallback: ${fallbackTotal.value} vs main: ${total}`);
    }
  }

  const date = extractDate(lines);
  const items = [];

  const nonItemPatterns = [
    /^plačano/i,
    /^c\s+\d{1,2},\d{1,2}\s*%\s+[\d\s.,]+—?\s*[\d\s.,]+/i,
    /^[a-zA-Z]\s*\d{1,2}[,.]\d{1,2}%\s+\d+[,.]\d+\s+\d+[,.]\d+/i,
    /^dov:/i,
    /^bl:/i,
    /^eor[: ]/i,
    /^zol[: ]/i,
    /^spar plus/i,
    /mat\.št/i,
    /osn\.kapital/i,
    /splošni pogoji/i,
    /vaše današnje ugodnosti/i,
    /točke zvestobe/i,
    /številka naročila/i,
    /datum naročila/i,
    /datum računa/i,
    /skupaj eur/i,
    /^kartica/i,
    /^date[: ]?/i,
    /^znesek\s*—?\s*\d+[,.]/i,
    /^a\s+\d{1,2}[,.]\d+\s+\d+[,.]/i,
    /^[a-z]?\s*\d{1,2}[,.]\d+\s+\d+[,.]/i,
    /^,?\d{1,3}[,.]\d{2}\s*—?\s*\d{1,3}[,.]\d{2}/,
    /^obračunsko obdobje/i,
    /^vsi zneski so v/i,
  ];

  for (const line of lines) {
    const isServiceCostLine = /stroški storitve/i.test(line);

    if (!isServiceCostLine && nonItemPatterns.some(pat => pat.test(line))) continue;
    if (totalCandidates.some(tc => tc.line === line)) continue;
    if (/rekapitulacija|osnova za ddv|skupaj ddv/i.test(line)) continue;

    const allAmounts = [...line.matchAll(/(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/g)];
    if (!allAmounts.length && !isServiceCostLine) continue;

    // Handle multiple amounts per line - pick largest amount as price
    let priceFloat = 0;
    const amounts = allAmounts.map(m => parseFloat(normalizeAmount(m[1], isSlovenian)));
    if (amounts.length === 1) priceFloat = amounts[0];
    else if (amounts.length > 1) priceFloat = Math.max(...amounts);

    if (priceFloat <= 0) continue;

    const lastAmount = allAmounts[allAmounts.length - 1];
    const rawAmount = lastAmount ? lastAmount[1] : "0";

    if (dateLikeAmountRegex.test(rawAmount)) continue;

    const units = ["l", "ml", "kg", "g", "pcs", "x"];
    const afterIdx = lastAmount?.index + rawAmount.length;
    const afterToken = line.slice(afterIdx).trim().toLowerCase().split(/\s+/)[0] || "";
    if (units.includes(afterToken)) continue;

    let namePart = lastAmount ? line.slice(0, lastAmount.index).trim() : line.trim();
    namePart = namePart.replace(/^\d+\s*x?\s*/i,"").trim();
    namePart = namePart.replace(/^[-–—]\s*/,"");

    const hasExcluded = excludeKeywords.some(kw => new RegExp(`\\b${kw}\\b`, "i").test(namePart));
    if (!isServiceCostLine && (namePart.length < 2 || hasExcluded)) continue;

    const itemName = namePart.length > 0 ? namePart : "Stroški storitve";
    items.push({ name: itemName, price: `${priceFloat.toFixed(2)} ${currency}` });
  }

  return {
    version: PARSER_VERSION,
    date,
    total: total ? `${total.toFixed(2)} ${currency}` : null,
    items,
  };
}
