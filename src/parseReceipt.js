export function parseReceipt(text) {
  const PARSER_VERSION = "v1.5.3";
  console.log("🧾 Receipt parser version:", PARSER_VERSION);

  // Normalize amount string to a standard decimal number string for parseFloat
  function normalizeAmount(value, isSlovenian) {
    if (isSlovenian) {
      if (value.includes(",")) {
        // Slovenian style: dot = thousand separator; comma = decimal separator
        return value.replace(/\./g, "").replace(",", ".");
      } else {
        // No comma decimal, remove dots if more than one
        const dotCount = (value.match(/\./g) || []).length;
        if (dotCount <= 1) return value;
        return value.replace(/\./g, "");
      }
    } else {
      // English-style numbers (no decimal comma): remove commas
      return value.replace(/,/g, "");
    }
  }

  // Extract the last amount with optional currency symbol from a line using regex
  function extractLastAmountWithCurrency(line) {
    const amountWithCurrencyRegex = /(\d{1,3}(?:[ .,]\d{3})*(?:[.,]\d{1,2}))\s*(€|EUR|USD|\$)?/gi;
    let match, lastMatch = null;
    while ((match = amountWithCurrencyRegex.exec(line)) !== null) {
      lastMatch = match;
    }
    return lastMatch; // null if none found
  }

  // Extract all total amount candidates from lines containing keywords
  function extractAllTotalCandidates(lines, isSlovenian) {
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

    const candidates = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!totalKeywords.some((kw) => line.toLowerCase().includes(kw))) continue;
      if (line.toLowerCase().includes("keine")) continue; // exclude "keine" lines

      let parsedMatch = extractLastAmountWithCurrency(line);
      if (!parsedMatch) {
        const nextLine = lines[i + 1];
        if (nextLine) {
          parsedMatch = extractLastAmountWithCurrency(nextLine);
          if (parsedMatch) {
            const rawValue = parsedMatch[1];
            const currency = (parsedMatch[2] || "€").toUpperCase();
            const value = parseFloat(normalizeAmount(rawValue, isSlovenian));
            if (!isNaN(value) && value > 0)
              candidates.push({ line: line + " " + nextLine, value, currency });
            continue;
          }
        }
      } else {
        const rawValue = parsedMatch[1];
        const currency = (parsedMatch[2] || "€").toUpperCase();
        const value = parseFloat(normalizeAmount(rawValue, isSlovenian));
        if (!isNaN(value) && value > 0) candidates.push({ line, value, currency });
      }
    }
    candidates.sort((a, b) => b.value - a.value);
    return candidates;
  }

  // Fallback: derive total based on net and VAT summary lines if no explicit total found
  function tryFallbackTotal(lines, isSlovenian) {
    let net = null,
      vat = null,
      currency = null;

    for (const line of lines) {
      const lower = line.toLowerCase();
      const parsedMatch = extractLastAmountWithCurrency(line);
      if (!parsedMatch) continue;

      const vatMatch = line.match(
        /c\s+\d{1,2},\d{1,2}\s*%\s+(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))\s+(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/i
      );
      if (vatMatch) {
        net = parseFloat(normalizeAmount(vatMatch[1], isSlovenian));
        vat = parseFloat(normalizeAmount(vatMatch[2], isSlovenian));
        currency = parsedMatch[2]?.toUpperCase() || currency;
        if (!isNaN(net) && !isNaN(vat)) {
          const total = parseFloat((net + vat).toFixed(2));
          console.log(`💡 Fallback from VAT summary: ${net} + ${vat} = ${total}`);
          return { value: total, currency };
        }
      }

      if (isSlovenian) {
        if (lower.includes("osnova za ddv") || lower.includes("brez ddv")) net = parseFloat(normalizeAmount(parsedMatch[1], isSlovenian));
        if (lower.includes("skupaj ddv") || (lower.includes("ddv") && lower.includes("%"))) vat = parseFloat(normalizeAmount(parsedMatch[1], isSlovenian));
      } else {
        if (lower.includes("net")) net = parseFloat(normalizeAmount(parsedMatch[1], isSlovenian));
        if (lower.includes("vat") || lower.includes("tax")) vat = parseFloat(normalizeAmount(parsedMatch[1], isSlovenian));
      }
    }
    if (net !== null && vat !== null) {
      const total = parseFloat((net + vat).toFixed(2));
      return { value: total, currency };
    }
    return null;
  }

  // Extract ISO-8601 formatted date from any line
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

  // --- Start main parsing ---
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

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
  ].some((kw) => joinedText.includes(kw));

  // Extensive list of keywords for exclusion of non-item lines
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
    console.log(`Checking line: "${line}"`);

    // Exclude based on keywords anywhere in line (case-insensitive)
    if (excludeKeywords.some((kw) => line.toLowerCase().includes(kw))) {
      console.log("  Skipping due to exclude keyword.");
      continue;
    }
    if (nonItemPatterns.some((pat) => pat.test(line))) {
      console.log("  Skipping due to non-item pattern.");
      continue;
    }
    if (totalCandidates.some((tc) => tc.line === line)) {
      console.log("  Skipping line matching total candidate.");
      continue;
    }
    if (/rekapitulacija|osnova za ddv|skupaj ddv/i.test(line)) {
      console.log("  Skipping VAT summary or rekapitulacija line.");
      continue;
    }

    // Extract last amount with currency via regex
    const amountMatch = extractLastAmountWithCurrency(line);
    if (!amountMatch) {
      console.log("  Skipping due to no valid amount found in line.");
      continue;
    }
    const rawAmount = amountMatch[1];
    const detectedCurrency = (amountMatch[2] || currency).toUpperCase();

    const priceStr = rawAmount;
    const priceNorm = normalizeAmount(priceStr.replace(/[^\d,.\-]/g, ""), isSlovenian);
    const price = parseFloat(priceNorm);

    if (isNaN(price) || price <= 0) {
      console.log(`  Skipping due to invalid price: "${priceStr}" parsed as ${price}`);
      continue;
    }
    if (price > 10000) {
      console.log(`  Skipping due to implausible large price: ${price.toFixed(2)}`);
      continue;
    }

    // Description is everything before last amount in line
    const descEndIndex = amountMatch.index;
    let description = line.slice(0, descEndIndex).trim();

    if (!description || description.length < 3 || !/[a-zA-Zčšž]/i.test(description)) {
      console.log(`  Skipping due to invalid description: "${description}"`);
      continue;
    }

    // Try extract quantity from description tokens (last token if numeric)
    let quantityNum = undefined;
    const descTokens = description.split(/\s+/);
    if (descTokens.length > 1) {
      const lastToken = descTokens[descTokens.length - 1];
      const quantityCandidate = normalizeAmount(lastToken.replace(/[^\d,.\-]/g, ""), isSlovenian);
      const quantityParsed = parseFloat(quantityCandidate);
      if (!isNaN(quantityParsed)) {
        quantityNum = quantityParsed;
        // Remove quantity token from description
        description = descTokens.slice(0, -1).join(" ");
      }
    }

    console.log(
      `  Detected item: name="${description}", price=${price.toFixed(
        2
      )} ${detectedCurrency}, quantity=${quantityNum !== undefined ? quantityNum : "N/A"}`
    );

    items.push({
      name: description.trim(),
      price: `${price.toFixed(2)} ${detectedCurrency}`,
      quantity: quantityNum,
      date: undefined,
    });
  }

  console.log(`Extracted date: ${date}`);
  console.log(`Detected total candidates: ${totalCandidates.length}`);
  console.log(`Final total: ${total ? total.toFixed(2) + " " + currency : null}`);
  console.log(`Total items detected: ${items.length}`);

  return {
    version: PARSER_VERSION,
    date,
    total: total ? `${total.toFixed(2)} ${currency}` : null,
    items,
  };
}
