export function parseReceipt(text) {
  const PARSER_VERSION = "v1.6.0";
  console.log("🧾 Receipt parser version:", PARSER_VERSION);

  function mergeBrokenLines(text) {
    const lines = text.split("\n");
    const merged = [];
    for (let i = 0; i < lines.length; i++) {
      const current = lines[i].trim();
      const next = lines[i + 1]?.trim();
      if (
        current &&
        next &&
        /^[a-zA-Z\s\-]+$/.test(current) &&
        /^[a-zA-Z\s\-]+$/.test(next)
      ) {
        merged.push(current + " " + next);
        i++; // skip next
      } else {
        merged.push(current);
      }
    }
    return merged.join("\n");
  }

  text = mergeBrokenLines(text);

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
    while ((match = regex.exec(line)) !== null) {
      lastMatch = match;
    }
    if (!lastMatch) return null;

    const rawValue = lastMatch[1];
    const normalizedValue = normalizeAmount(rawValue, isSlovenian);
    const value = parseFloat(normalizedValue);
    const currency = lastMatch[2]?.toUpperCase?.() || null;
    return isNaN(value) ? null : { value, currency };
  }

  function extractAllTotalCandidates(lines, isSlovenian) {
    const totalKeywords = isSlovenian
      ? ["plačano", "za plačilo", "skupaj", "znesek", "končni znesek", "skupna vrednost", "skupaj z ddv"]
      : ["paid", "total", "amount due", "grand total", "amount", "to pay"];

    return lines
      .filter(line => totalKeywords.some(kw => line.toLowerCase().includes(kw)))
      .filter(line => !/^c\s+\d{1,2},\d{1,2}\s*%\s+[\d\s.,]+—?\s*[\d\s.,]+/i.test(line.toLowerCase()))
      .map(line => {
        const parsed = extractAmountFromLine(line, isSlovenian);
        return { line, value: parsed?.value ?? 0, currency: parsed?.currency ?? null };
      })
      .filter(entry => entry.value > 0)
      .sort((a, b) => b.value - a.value);
  }

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

    if (net != null && vat != null) {
      const total = parseFloat((net + vat).toFixed(2));
      return { value: total, currency };
    }

    return null;
  }

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
  if (fallbackTotal) {
    const delta = total ? Math.abs(fallbackTotal.value - total) : 0;
    const isBetter = !total || delta <= 0.05 || fallbackTotal.value > total;
    if (isBetter) {
      console.log(`✅ Using fallback total: ${fallbackTotal.value}`);
      total = fallbackTotal.value;
      currency = fallbackTotal.currency ?? currency;
    }
  }

  const date = extractDate(lines);
  const items = [];

  const nonItemPatterns = [
    /^plačano/i, /^c\s+\d{1,2},\d{1,2}/i,
    /^[a-zA-Z]\s*\d{1,2}[,.]\d{1,2}%\s+\d+[,.]\d+\s+\d+[,.]\d+/i,
    /^dov:/i, /^bl:/i, /^eor[: ]/i, /^zol[: ]/i,
    /^spar plus/i, /mat\.št/i, /osn\.kapital/i, /splošni pogoji/i,
    /vaše današnje ugodnosti/i, /točke zvestobe/i, /datum naročila/i,
    /datum računa/i, /^kartica/i, /^date[: ]?/i,
    /^obračunsko obdobje/i, /^vsi zneski so v/i
  ];

  for (const line of lines) {
    const isServiceLine = /stroški storitve/i.test(line);
    if (!isServiceLine && nonItemPatterns.some(p => p.test(line))) continue;
    if (excludeKeywords.some(kw => line.toLowerCase().includes(kw))) continue;

    const parsed = extractAmountFromLine(line, isSlovenian);
    if (!parsed || parsed.value === 0) continue;

    items.push({ label: line, value: parsed.value });
  }

  const company = lines[0]?.length <= 50 ? lines[0] : null;

  return {
    total,
    currency,
    date,
    items,
    company,
    version: PARSER_VERSION,
  };
}
