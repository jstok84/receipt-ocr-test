export function parseReceipt(text) {
  const PARSER_VERSION = "v1.6.1";
  console.log("🧾 Receipt parser version:", PARSER_VERSION);

  /** Normalize amount string for parseFloat, handling Slovenian or non-Slovenian formats */
  function normalizeAmount(value, isSlovenian) {
    if (isSlovenian) {
      if (value.includes(",")) {
        return value.replace(/\./g, "").replace(",", ".");
      } else {
        const dotCount = (value.match(/\./g) || []).length;
        return dotCount <= 1 ? value : value.replace(/\./g, "");
      }
    } else {
      return value.replace(/,/g, "");
    }
  }

  /** Regex to find the last amount and optional currency symbol in a line */
  function extractLastAmountWithCurrency(line) {
    const regex = /(\d{1,3}(?:[ .,]\d{3})*(?:[.,]\d{1,2}))\s*(€|EUR|USD|\$)?/gi;
    let lastMatch = null, match;
    while ((match = regex.exec(line)) !== null) lastMatch = match;
    return lastMatch; // null if none
  }

  /** Extract all total candidates by scanning lines with certain keywords */
  function extractAllTotalCandidates(lines, isSlovenian) {
    const keywords = isSlovenian
      ? [
          "plačano",
          "za plačilo",
          "skupaj",
          "znesek",
          "končni znesek",
          "skupna vrednost",
          "skupaj z ddv",
        ]
      : [
          "paid",
          "total",
          "amount due",
          "grand total",
          "amount",
          "to pay",
        ];

    const candidates = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!keywords.some((kw) => line.toLowerCase().includes(kw))) continue;
      if (line.toLowerCase().includes("keine")) continue;

      let match = extractLastAmountWithCurrency(line);
      if (!match) {
        const nextLine = lines[i + 1];
        if (nextLine) {
          match = extractLastAmountWithCurrency(nextLine);
          if (match) {
            const raw = match[1];
            const curr = (match[2] || "€").toUpperCase();
            const val = parseFloat(normalizeAmount(raw, isSlovenian));
            if (!isNaN(val) && val > 0) {
              candidates.push({ line: line + " " + nextLine, value: val, currency: curr });
              continue;
            }
          }
        }
      } else {
        const raw = match[1];
        const curr = (match[2] || "€").toUpperCase();
        const val = parseFloat(normalizeAmount(raw, isSlovenian));
        if (!isNaN(val) && val > 0) candidates.push({ line, value: val, currency: curr });
      }
    }

    candidates.sort((a, b) => b.value - a.value);
    return candidates;
  }

  /** Tries fallback total extraction from VAT summary lines */
  function tryFallbackTotal(lines, isSlovenian) {
    let net = null, vat = null, currency = null;

    for (const line of lines) {
      const lower = line.toLowerCase();
      const match = extractLastAmountWithCurrency(line);
      if (!match) continue;

      const vatMatch = line.match(
        /c\s+\d{1,2},\d{1,2}\s*%\s+(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))\s+(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/i
      );
      if (vatMatch) {
        net = parseFloat(normalizeAmount(vatMatch[1], isSlovenian));
        vat = parseFloat(normalizeAmount(vatMatch[2], isSlovenian));
        currency = match[2]?.toUpperCase() || currency;
        if (!isNaN(net) && !isNaN(vat)) {
          const total = parseFloat((net + vat).toFixed(2));
          console.log(`💡 Fallback from VAT summary: ${net} + ${vat} = ${total}`);
          return { value: total, currency };
        }
      }

      if (isSlovenian) {
        if (lower.includes("osnova za ddv") || lower.includes("brez ddv"))
          net = parseFloat(normalizeAmount(match[1], isSlovenian));
        if (lower.includes("skupaj ddv") || (lower.includes("ddv") && lower.includes("%")))
          vat = parseFloat(normalizeAmount(match[1], isSlovenian));
      } else {
        if (lower.includes("net"))
          net = parseFloat(normalizeAmount(match[1], isSlovenian));
        if (lower.includes("vat") || lower.includes("tax"))
          vat = parseFloat(normalizeAmount(match[1], isSlovenian));
      }
    }

    if (net !== null && vat !== null) {
      return { value: parseFloat((net + vat).toFixed(2)), currency };
    }
    return null;
  }

  /** Extract ISO-format date (YYYY-MM-DD) from lines if any */
  function extractDate(lines) {
    // Array of regexes to match multiple date formats including dot+space and space-separated numeric
    const dateRegexes = [
      // Matches dates like "07. 07. 2025" or "11.06.2025" with optional spaces after dots
      /\b(0?[1-9]|[12][0-9]|3[01])\.\s*(0?[1-9]|1[0-2])\.\s*(\d{4})\b/,

      // NEW: Matches space-separated numeric dates like "25 8 2024"
      /\b(0?[1-9]|[12][0-9]|3[01])\s+(0?[1-9]|1[0-2])\s+(\d{4})\b/,
    ];

    for (const line of lines) {
      for (const regex of dateRegexes) {
        const match = line.match(regex);
        if (match) {
          let day = parseInt(match[1], 10);
          let month = parseInt(match[2], 10);
          let year = parseInt(match[3], 10);
          return (
            year.toString().padStart(4, "0") +
            "-" +
            month.toString().padStart(2, "0") +
            "-" +
            day.toString().padStart(2, "0")
          );
        }
      }
    }
    return null;
  }


  /** Checks whether to exclude a line by matching keywords as whole words */
  function shouldExcludeLine(line, excludeKeywords) {
    return excludeKeywords.some((kw) => new RegExp(`\\b${kw}\\b`, "i").test(line));
  }

  /** Main body of parseReceipt **/
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
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

  // Refined exclude keywords (avoid overly generic small words)
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

  // Detect total candidates from lines
  const totalCandidates = extractAllTotalCandidates(lines, isSlovenian);
  let total = totalCandidates.length > 0 ? totalCandidates[0].value : null;
  let currency = totalCandidates.length > 0 ? totalCandidates[0].currency ?? "€" : "€";

  // Attempt fallback total from VAT net+vat summary
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

  // Parse items with support for Spar multi-column format and fallback generic parsing
  for (const line of lines) {
    console.log(`Checking line: "${line}"`);

    if (shouldExcludeLine(line, excludeKeywords)) {
      console.log("  Skipping due to exclude keyword (whole word match).");
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
      console.log("  Skipping VAT summary or similar.");
      continue;
    }

    // Spar multi-column detection heuristic: >=10 parts split by several spaces/tabs
    const parts = line.split(/\s{2,}|\t/).filter((p) => p.trim() !== "");

    if (parts.length >= 10) {
      const quantityRaw = parts[0];
      const articleCode = parts[1];
      const nameTokens = parts.slice(2, parts.length - 7);
      const name = nameTokens.join(" ") || parts[2];

      const orderedQtyRaw = parts[parts.length - 7];
      const deliveredQtyRaw = parts[parts.length - 6];
      const unit = parts[parts.length - 5];
      const priceGrossRaw = parts[parts.length - 4];
      const discountRaw = parts[parts.length - 3];
      const priceNetRaw = parts[parts.length - 2];
      const vatCode = parts[parts.length - 1];

      const priceNum = parseFloat(normalizeAmount(priceNetRaw, isSlovenian));
      if (isNaN(priceNum) || priceNum <= 0) {
        console.log("  Skipping Spar item line due to invalid net price.");
        continue;
      }

      let quantityNum = parseFloat(normalizeAmount(deliveredQtyRaw, isSlovenian));
      if (isNaN(quantityNum)) {
        quantityNum = parseFloat(normalizeAmount(orderedQtyRaw, isSlovenian));
      }
      if (isNaN(quantityNum)) quantityNum = undefined;

      if (!name || name.length < 3) {
        console.log("  Skipping Spar item line due to short or empty name.");
        continue;
      }

      console.log(
        `  Detected Spar item: name="${name}", price=${priceNum.toFixed(
          2
        )} ${currency}, quantity=${quantityNum ?? "N/A"}`
      );

      items.push({
        name: name.trim(),
        price: `${priceNum.toFixed(2)} ${currency}`,
        quantity: quantityNum,
      });
      continue;
    }

    // Fallback generic parsing: extract last amount
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

    const descEndIndex = amountMatch.index;
    let description = line.slice(0, descEndIndex).trim();

    if (!description || description.length < 3 || !/[a-zA-Zčšž]/i.test(description)) {
      console.log(`  Skipping due to invalid description: "${description}"`);
      continue;
    }

    let quantityNum = undefined;
    const descTokens = description.split(/\s+/);
    if (descTokens.length > 1) {
      const lastToken = descTokens[descTokens.length - 1];
      const quantityCandidate = normalizeAmount(lastToken.replace(/[^\d,.\-]/g, ""), isSlovenian);
      const quantityParsed = parseFloat(quantityCandidate);
      if (!isNaN(quantityParsed)) {
        quantityNum = quantityParsed;
        description = descTokens.slice(0, -1).join(" ");
      }
    }

    console.log(
      `  Detected item: name="${description}", price=${price.toFixed(
        2
      )} ${detectedCurrency}, quantity=${quantityNum ?? "N/A"}`
    );

    items.push({
      name: description.trim(),
      price: `${price.toFixed(2)} ${detectedCurrency}`,
      quantity: quantityNum,
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
