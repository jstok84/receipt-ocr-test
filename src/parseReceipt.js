export function parseReceipt(text, options = { flatMode: false }) {
  const PARSER_VERSION = "v1.5.0";
  console.log("🧾 Receipt parser version:", PARSER_VERSION);

  const flatMode = options.flatMode === true;

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

  function extractAmountFromText(text, isSlovenian) {
    const regex = /(\d{1,3}(?:[ .,\s]?\d{3})*(?:[.,]\d{1,2}))\s*(EUR|USD|\$|€)?/gi;
    let match, lastMatch = null;
    while ((match = regex.exec(text)) !== null) {
      lastMatch = match;
    }
    if (!lastMatch) return null;

    const rawValue = lastMatch[1];
    const normalizedValue = normalizeAmount(rawValue, isSlovenian);
    const value = parseFloat(normalizedValue);
    const currency = lastMatch[2]?.toUpperCase?.() || null;
    return isNaN(value) ? null : { value, currency };
  }

  function extractAllTotalCandidates(text, isSlovenian) {
    const totalKeywords = isSlovenian
      ? ["plačano", "za plačilo", "skupaj", "znesek", "končni znesek", "skupna vrednost", "skupaj z ddv"]
      : ["paid", "total", "amount due", "grand total", "amount", "to pay"];

    const candidates = [];
    for (const kw of totalKeywords) {
      const regex = new RegExp(`.{0,40}${kw}.{0,40}`, "gi");
      let match;
      while ((match = regex.exec(text)) !== null) {
        const context = match[0];
        const parsed = extractAmountFromText(context, isSlovenian);
        if (parsed && parsed.value > 0) {
          candidates.push({ text: context, value: parsed.value, currency: parsed.currency });
        }
      }
    }
    candidates.sort((a, b) => b.value - a.value);
    return candidates;
  }

  function tryFallbackTotal(text, isSlovenian) {
    const vatSummaryRegex = /c\s+\d{1,2},\d{1,2}\s*%\s+(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))\s+(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/i;
    const match = text.match(vatSummaryRegex);
    if (match) {
      const net = parseFloat(normalizeAmount(match[1], isSlovenian));
      const vat = parseFloat(normalizeAmount(match[2], isSlovenian));
      if (!isNaN(net) && !isNaN(vat)) {
        const total = parseFloat((net + vat).toFixed(2));
        console.log(`💡 Fallback from VAT summary: ${net} + ${vat} = ${total}`);
        return { value: total, currency: null };
      }
    }

    let net = null, vat = null;
    const lines = flatMode ? [text] : text.split("\n").map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
      const lower = line.toLowerCase();
      const parsed = extractAmountFromText(line, isSlovenian);
      if (!parsed) continue;

      if (isSlovenian) {
        if (lower.includes("osnova za ddv") || lower.includes("brez ddv")) net = parsed.value;
        if (lower.includes("skupaj ddv") || (lower.includes("ddv") && lower.includes("%"))) vat = parsed.value;
      } else {
        if (lower.includes("net")) net = parsed.value;
        if (lower.includes("vat") || lower.includes("tax")) vat = parsed.value;
      }
    }

    if (net != null && vat != null) {
      return { value: parseFloat((net + vat).toFixed(2)), currency: null };
    }
    return null;
  }

  function extractDate(text) {
    const dateRegex = /\b(0?[1-9]|[12][0-9]|3[01])[./-](0?[1-9]|1[0-2])[./-](\d{2}|\d{4})\b/;
    const lines = flatMode ? [text] : text.split("\n");
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

  // New: parse one line into {name, price} like v1.4.0 line parsing
  function parseLineItem(line, isSlovenian, currency) {
    // Try to find amount(s) in the line
    // Assume last amount is the price of the item
    const amountRegex = /(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/g;
    let matches = [];
    let match;
    while ((match = amountRegex.exec(line)) !== null) {
      matches.push({ raw: match[1], index: match.index });
    }
    if (matches.length === 0) return null;

    const lastAmount = matches[matches.length - 1];
    const priceStr = normalizeAmount(lastAmount.raw, isSlovenian);
    const price = parseFloat(priceStr);
    if (isNaN(price) || price <= 0) return null;

    // Extract item name: text before last amount, clean up
    let name = line.slice(0, lastAmount.index).trim();

    // Remove quantity prefix (e.g. "1 x ", "2x ")
    name = name.replace(/^\d+\s*x?\s*/i, "").trim();

    // Remove leading dashes or bullets
    name = name.replace(/^[-–—•\*]\s*/, "");

    // Exclude lines with keywords (same exclusions as extractItems)
    const excludeKeywords = isSlovenian
      ? ["številka", "transakcija", "ddv", "datum", "račun", "osnovni kapital", "ponudbe", "rekapitulacija", "osnova", "veljavnost ponudbe"]
      : ["transaction", "terminal", "subtotal", "tax", "vat", "invoice", "date", "validity"];

    const hasEx = excludeKeywords.some(kw => new RegExp(`\\b${kw}\\b`, "i").test(name));
    if (name.length < 2 || hasEx) return null;

    return { name, price: `${price.toFixed(2)} ${currency}` };
  }

  function extractItems(text, isSlovenian, currency) {
    const items = [];
    if (flatMode) {
      // Flat mode: try to extract items based on amounts and text heuristics as before
      // You can keep your v1.5.0 extractItems here (from your snippet)
      const excludeKeywords = isSlovenian
        ? ["številka", "transakcija", "ddv", "datum", "račun", "osnovni kapital", "ponudbe", "rekapitulacija", "osnova", "veljavnost ponudbe"]
        : ["transaction", "terminal", "subtotal", "tax", "vat", "invoice", "date", "validity"];

      const nonItemPatterns = [
        /^plačano/i,
        /^c\s+\d{1,2},\d{1,2}\s*%\s+[\d\s.,]+—?\s*[\d\s.,]+/i,
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
        /^a\s+\d{1,2}[,.]\d+\s*\d+[,.]/i,
        /^[a-z]?\s*\d{1,2}[,.]\d+\s*\d+[,.]/i,
        /^,?\d{1,3}[,.]\d{2}\s*—?\s*\d{1,3}[,.]\d{2}/,
        /^obračunsko obdobje/i,
        /^vsi zneski so v/i
      ];

      const amountRegex = /(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/g;
      let match;

      while ((match = amountRegex.exec(text)) !== null) {
        const rawAmount = match[1];
        const index = match.index;

        const priceStr = normalizeAmount(rawAmount, isSlovenian);
        const priceFloat = parseFloat(priceStr);
        if (isNaN(priceFloat) || priceFloat <= 0) continue;

        const prefixStart = Math.max(0, index - 60);
        let nameCandidate = text.slice(prefixStart, index).trim();
        nameCandidate = nameCandidate.replace(/^\d+\s*x?\s*/i, "").trim();
        nameCandidate = nameCandidate.replace(/^[-–—]\s*/, "");

        const hasEx = excludeKeywords.some(kw => new RegExp(`\\b${kw}\\b`, "i").test(nameCandidate));
        if (nameCandidate.length < 2 || hasEx) continue;

        if (items.some(item => item.name === nameCandidate && item.price === priceFloat)) continue;

        items.push({ name: nameCandidate, price: `${priceFloat.toFixed(2)} ${currency}` });
      }
    } else {
      // Line-by-line mode: parse each line separately using parseLineItem
      const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const item = parseLineItem(line, isSlovenian, currency);
        if (item) {
          // Avoid duplicates
          if (!items.some(i => i.name === item.name && i.price === item.price)) {
            items.push(item);
          }
        }
      }
    }
    return items;
  }

  // --- START parsing ---

  const lowerText = text.toLowerCase();
  const isSlovenian = [
    "račun", "kupec", "ddv", "znesek", "ponudba", "skupaj", "za plačilo", "plačano"
  ].some(kw => lowerText.includes(kw));

  const totalCandidates = extractAllTotalCandidates(text, isSlovenian);

  let total = null;
  let currency = "€";
  if (totalCandidates.length > 0) {
    total = totalCandidates[0].value;
    currency = totalCandidates[0].currency ?? currency;
  }

  const fallbackTotal = tryFallbackTotal(text, isSlovenian);
  if (fallbackTotal) {
    const delta = total ? Math.abs(fallbackTotal.value - total) : 0;
    const isFallbackBetter = !total || delta <= 0.05 || fallbackTotal.value > total;
    if (isFallbackBetter) {
      console.log(`✅ Using fallback total: ${fallbackTotal.value} > main: ${total}`);
      total = fallbackTotal.value;
      currency = fallbackTotal.currency ?? currency;
    } else {
      console.log(`⚠️ Ignoring fallback: ${fallbackTotal.value} vs main: ${total}`);
    }
  }

  const date = extractDate(text);
  const items = extractItems(text, isSlovenian, currency);

  return {
    version: PARSER_VERSION,
    date,
    total: total ? `${total.toFixed(2)} ${currency}` : null,
    items
  };
}
