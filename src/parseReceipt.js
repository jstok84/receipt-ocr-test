export function parseReceipt(text) {
  const PARSER_VERSION = "v1.5.2";
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
    const regex = /(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))\s*(EUR|USD|\$|€)?/gi;
    let match, lastMatch = null;
    while ((match = regex.exec(line)) !== null) lastMatch = match;
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

    const candidates = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!totalKeywords.some(kw => line.toLowerCase().includes(kw))) continue;
      if (line.toLowerCase().includes("keine")) continue; // from v1.4.2 to exclude 'keine'

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

  function tryFallbackTotal(lines, isSlovenian) {
    let net = null,
      vat = null,
      currency = null;

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

  function extractDate(lines) {
    const dateRegex = /\b(0?[1-9]|[12][0-9]|3[01])[./-](0?[1-9]|1[0-2])[./-](\d{2}|\d{4})\b/;
    for (const line of lines) {
      const match = line.match(dateRegex);
      if (match) {
        let day = parseInt(match[1], 10);
        let month = parseInt(match[2], 10);
        let year = parseInt(match[3], 10);
        if (year < 100) year += 2000;
        return `${year.toString().padStart(4, "0")}-${month
          .toString()
          .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
      }
    }
    return null;
  }

  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const joinedText = lines.join(" ").toLowerCase();
  const isSlovenian = [
    "račun",
    "kupec",
    "ddv",
    "znesek",
    "ponudba",
    "skupaj",
    "za plačilo",
    "plačano",
  ].some(kw => joinedText.includes(kw));

  const excludeKeywords = isSlovenian
    ? [
      "številka",
      "transakcija",
      "ddv",
      "datum",
      "račun",
      "osnovni kapital",
      "ponudbe",
      "rekapitulacija",
      "osnova",
      "veljavnost ponudbe",
      "keine",
      "telefonska",
      "telefon",
      "stran",
      "ljubljana",
      "p.p.",
      "ho t",
      "mobil",
      "si",
      "si767",
    ]
    : [
      "transaction",
      "terminal",
      "subtotal",
      "tax",
      "vat",
      "invoice",
      "date",
      "validity",
    ];

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

  const totalCandidates = extractAllTotalCandidates(lines, isSlovenian);
  let total = totalCandidates.length > 0 ? totalCandidates[0].value : null;
  let currency = totalCandidates.length > 0 ? totalCandidates[0].currency ?? "€" : "€";

  const fallbackTotal = tryFallbackTotal(lines, isSlovenian);
  if (fallbackTotal) {
    const delta = total ? Math.abs(fallbackTotal.value - total) : 0;
    const useFallback = !total || delta <= 0.05 || fallbackTotal.value > total;
    if (useFallback) {
      console.log(`✅ Using fallback total: ${fallbackTotal.value} > main: ${total}`);
      total = fallbackTotal.value;
      currency = fallbackTotal.currency ?? currency;
    } else {
      console.log(`⚠️ Ignoring fallback: ${fallbackTotal.value} vs main: ${total}`);
    }
  }

  const date = extractDate(lines);
  const items = [];

  for (const line of lines) {
    // Exclude lines by keywords anywhere in line (case-insensitive)
    if (excludeKeywords.some(kw => line.toLowerCase().includes(kw))) continue;
    if (nonItemPatterns.some(pat => pat.test(line))) continue;
    if (totalCandidates.some(tc => tc.line === line)) continue;
    if (/rekapitulacija|osnova za ddv|skupaj ddv/i.test(line)) continue;

    // Split line first by two or more spaces or tabs
    let parts = line.split(/\s{2,}|\t/).filter(Boolean);
    if (parts.length < 4) {
      // Fallback to splitting by single space if too few parts
      parts = line.trim().split(/\s+/);
    }

    if (parts.length < 4) continue; // Require minimum 4 parts for an item line

    let possibleDate = parts[0];
    const datePattern = /^\d{1,2}[./-]\d{1,2}[./-](?:\d{2}|\d{4})$/;
    let itemDate = null;
    let description, quantity, priceStr;

    if (datePattern.test(possibleDate)) {
      itemDate = possibleDate;
      if (parts.length < 4) continue;
      quantity = parts[parts.length - 3];
      priceStr = parts[parts.length - 1];
      description = parts.slice(1, parts.length - 3).join(" ");
    } else {
      priceStr = parts[parts.length - 1];
      quantity = parts[parts.length - 2];
      description = parts.slice(0, parts.length - 2).join(" ");
    }

    const priceNorm = normalizeAmount(priceStr.replace(/[^\d,.\-]/g, ""), isSlovenian);
    const price = parseFloat(priceNorm);
    if (isNaN(price) || price <= 0 || price > 10000) continue; // plausibility check

    let quantityNum = null;
    if (quantity) {
      const quantityNorm = normalizeAmount(quantity.replace(/[^\d,.\-]/g, ""), isSlovenian);
      const parsedQty = parseFloat(quantityNorm);
      quantityNum = isNaN(parsedQty) ? null : parsedQty;
    }

    if (!description || description.length < 3 || !/[a-zA-Zčšž]/i.test(description)) continue;

    items.push({
      name: description.trim(),
      price: `${price.toFixed(2)} ${currency}`,
      quantity: quantityNum !== null ? quantityNum : undefined,
      date: itemDate || undefined,
    });
  }

  return {
    version: PARSER_VERSION,
    date,
    total: total ? `${total.toFixed(2)} ${currency}` : null,
    items,
  };
}
