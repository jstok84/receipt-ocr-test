export function parseReceipt(text) {
  const PARSER_VERSION = "v1.5.1";
  console.log("🧾 Receipt parser version:", PARSER_VERSION);

  // Normalize amounts to parseable format depending on locale
  function normalizeAmount(value, isSlovenian) {
    if (isSlovenian) {
      if (value.includes(",")) {
        // Slovenian style: dot as thousand separator, comma as decimal separator
        return value.replace(/\./g, "").replace(",", ".");
      } else {
        // No comma decimal - remove dots if >1
        const dotCount = (value.match(/\./g) || []).length;
        if (dotCount <= 1) return value;
        return value.replace(/\./g, "");
      }
    } else {
      // English style: comma thousand separator removed
      return value.replace(/,/g, "");
    }
  }

  // Extract last amount in line (supposedly price or total)
  function extractAmountFromLine(line, isSlovenian) {
    const regex = /(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))\s*(EUR|USD|\$|€)?/gi;
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

  // Extract first date found in the lines in ISO format
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

  const lines = text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  const joinedText = lines.join(" ").toLowerCase();

  // Detect Slovenian language presence for number parsing and keywords
  const isSlovenian = [
    "račun",
    "kupec",
    "ddv",
    "znesek",
    "ponudba",
    "skupaj",
    "za plačilo",
    "plačano",
  ].some(keyword => joinedText.includes(keyword));

  // Keywords for lines likely NOT containing items; used for filtering
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

  // Keywords to detect total amount lines
  const totalKeywords = isSlovenian
    ? [
      "plačano",
      "za plačilo",
      "skupaj",
      "znesek",
      "končni znesek",
      "skupna vrednost",
      "skupaj z ddv",
    ]
    : ["paid", "total", "amount due", "grand total", "amount", "to pay"];

  // Extract total candidates from lines with total keywords
  const totalCandidates = lines
    .filter(line => totalKeywords.some(kw => line.toLowerCase().includes(kw)))
    .filter(line => !/^c\s+\d{1,2},\d{1,2}\s*%\s+[\d\s.,]+—?\s*[\d\s.,]+/i.test(line.toLowerCase()))
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

  let total = totalCandidates.length > 0 ? totalCandidates[0].value : null;
  let currency = totalCandidates.length > 0 ? totalCandidates[0].currency ?? "€" : "€";

  const date = extractDate(lines);
  const items = [];

  // Patterns of lines to skip as non-items
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
    // Skip non-item lines or total candidate lines or summary lines
    if (nonItemPatterns.some(pattern => pattern.test(line))) continue;
    if (totalCandidates.some(t => t.line === line)) continue;
    if (/rekapitulacija|osnova za ddv|skupaj ddv/i.test(line)) continue;

    // DEBUG - uncomment to watch candidate lines:
     console.log("Checking line for item parsing:", JSON.stringify(line));

    // Split line by two or more spaces or tabs; fallback to single spaces if needed
    let parts = line.split(/\s{2,}|\t/).filter(Boolean);
    if (parts.length < 3) {
      parts = line.trim().split(/\s+/);
    }

    if (parts.length < 3) continue;

    let possibleDate = parts[0];
    const datePattern = /^\d{1,2}[./-]\d{1,2}[./-](?:\d{2}|\d{4})$/;
    let itemDate = null;
    let description, quantity, priceStr;

    if (datePattern.test(possibleDate)) {
      itemDate = possibleDate;

      if (parts.length < 4) continue; // Too few parts to have quantity and price

      // quantity and price are usually last 2 or 3 columns, adapt if needed
      quantity = parts[parts.length - 3];
      priceStr = parts[parts.length - 1];
      description = parts.slice(1, parts.length - 3).join(" ");
    } else {
      // No date in first column; assume last two fields quantity and price
      priceStr = parts[parts.length - 1];
      quantity = parts[parts.length - 2];
      description = parts.slice(0, parts.length - 2).join(" ");
    }

    // Normalize price and quantity
    const priceNorm = normalizeAmount(priceStr.replace(/[^\d,.\-]/g, ""), isSlovenian);
    const price = parseFloat(priceNorm);
    if (isNaN(price) || price <= 0) continue;

    let quantityNum = null;
    if (quantity) {
      const quantityNorm = normalizeAmount(quantity.replace(/[^\d,.\-]/g, ""), isSlovenian);
      const parsedQty = parseFloat(quantityNorm);
      quantityNum = isNaN(parsedQty) ? null : parsedQty;
    }

    // Skip item if description is empty or contains exclude keywords
    if (!description || excludeKeywords.some(kw => new RegExp(`\\b${kw}\\b`, "i").test(description))) continue;

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
