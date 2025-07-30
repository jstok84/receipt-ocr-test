export function parseReceipt(text) {
  const PARSER_VERSION = "v1.5.0";
  console.log("🧾 Receipt parser version:", PARSER_VERSION);

  /**
   * Merge broken lines that should logically be one line.
   * Improved heuristic: merge if next line starts lowercase or
   * both lines contain mostly letters (including Slovenian chars).
   */
  function mergeBrokenLines(text) {
    const lines = text.split("\n");
    const merged = [];
    for (let i = 0; i < lines.length; i++) {
      const current = lines[i].trim();
      const next = lines[i + 1]?.trim();

      // Regex to detect mostly text lines (letters, spaces, accented chars)
      const isTextLine = (line) => /^[a-zA-ZčČšŠžŽ\s\-.,]+$/.test(line);

      if (
        current &&
        next &&
        (isTextLine(current) && isTextLine(next) ||
        /^[a-z]/.test(next)) // next line starts lowercase (likely continuation)
      ) {
        merged.push(current + " " + next);
        i++; // skip next line, merged
      } else {
        merged.push(current);
      }
    }
    return merged.join("\n");
  }

  // Apply line merging to fix OCR broken lines
  text = mergeBrokenLines(text);

  /**
   * Normalize number strings to parseable format
   * Handles Slovenian (comma decimal) and others.
   */
  function normalizeAmount(value, isSlovenian) {
    if (isSlovenian) {
      if (value.includes(",")) {
        // Replace thousand dots and spaces, replace decimal comma with dot
        return value.replace(/[.\s]/g, "").replace(",", ".");
      } else {
        // If no comma, remove dots (thousand separators)
        const dotCount = (value.match(/\./g) || []).length;
        if (dotCount <= 1) return value;
        return value.replace(/\./g, "");
      }
    } else {
      // Remove commas as thousand separators in non-Slovenian formats
      return value.replace(/,/g, "");
    }
  }

  /**
   * Extract last amount with optional currency from a line
   */
  function extractAmountFromLine(line, isSlovenian) {
    // Matches numbers like 1,234.56 or 1.234,56 or 1234,56, optionally with currency symbols
    const regex = /(\d{1,3}(?:[ .,\s]?\d{3})*(?:[.,]\d{1,2})?)\s*(EUR|USD|\$|€)?/gi;
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

  /**
   * Find candidate total lines with keywords and extract amounts
   */
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

    // Filter lines with total-related keywords but exclude VAT summary lines
    const candidates = lines
      .filter(line =>
        totalKeywords.some(kw => line.toLowerCase().includes(kw))
      )
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

    return candidates;
  }

  /**
   * Fallback total from VAT lines or net+vat sums
   */
  function tryFallbackTotal(lines, isSlovenian) {
    let net = null,
      vat = null;
    let currency = null;

    for (const line of lines) {
      const lower = line.toLowerCase();
      const parsed = extractAmountFromLine(line, isSlovenian);
      if (!parsed) continue;

      // VAT summary line e.g. c 22,00 % 123,45 27,16
      const vatMatch = line.match(
        /c\s+\d{1,2},\d{1,2}\s*%\s+(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))\s+(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/i
      );
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

      // Slovenian labels for net and vat
      if (isSlovenian) {
        if (lower.includes("osnova za ddv") || lower.includes("brez ddv")) {
          net = parsed.value;
        }
        if (lower.includes("skupaj ddv") || (lower.includes("ddv") && lower.includes("%"))) {
          vat = parsed.value;
        }
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

  /**
   * Extract date in formats like DD.MM.YYYY or DD/MM/YYYY or DD-MM-YY
   */
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

  // Prepare lines (trim + remove empty)
  const lines = text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  // Detect language: basic Slovenian keywords present?
  const joinedText = lines.join(" ").toLowerCase();
  const isSlovenian = [
    "račun", "kupec", "ddv", "znesek", "ponudba", "skupaj", "za plačilo", "plačano"
  ].some(keyword => joinedText.includes(keyword));

  // Keywords to exclude in item names depending on language
  const excludeKeywords = isSlovenian
    ? ["številka", "transakcija", "ddv", "datum", "račun", "osnovni kapital", "ponudbe", "rekapitulacija", "osnova", "veljavnost ponudbe"]
    : ["transaction", "terminal", "subtotal", "tax", "vat", "invoice", "date", "validity"];

  // Extract total candidates & fallback total
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
    const isFallbackMoreTrustworthy =
      !total || delta <= 0.05 || fallbackTotal.value > total;

    if (isFallbackMoreTrustworthy) {
      console.log(`✅ Using fallback total: ${fallbackTotal.value} > main: ${total}`);
      total = fallbackTotal.value;
      currency = fallbackTotal.currency ?? currency;
    } else {
      console.log(`⚠️ Ignoring fallback: ${fallbackTotal.value} vs main: ${total}`);
    }
  }

  // Extract date
  const date = extractDate(lines);

  // Extract items
  const items = [];

  // Lines to exclude from items - common non-item patterns
  const nonItemPatterns = [
    /^plačano/i,
    /^c\s+\d{1,2},\d{1,2}\s*%\s+[\d\s.,]+—?\s*[\d\s.,]+/i,
    /^[a-zA-Z]\s*\d{1,2}[,.]\d{1,2}%\s+\d+[,.]\d+\s+\d+[,.]\d+/i,
    /^dov:/i, /^bl:/i, /^eor[: ]/i, /^zol[: ]/i, /^spar plus/i,
    /mat\.št/i, /osn\.kapital/i, /splošni pogoji/i,
    /vaše današnje ugodnosti/i, /točke zvestobe/i,
    /številka naročila/i, /datum naročila/i, /datum računa/i,
    /skupaj eur/i, /^kartica/i, /^date[: ]?/i,
    /^znesek\s*—?\s*\d+[,.]/i, /^a\s+\d{1,2}[,.]\d+\s+\d+[,.]/i,
    /^[a-z]?\s*\d{1,2}[,.]\d+\s+\d+[,.]/i,
    /^,?\d{1,3}[,.]\d{1,2}\s*€/i,
  ];

  for (const line of lines) {
    if (nonItemPatterns.some(rx => rx.test(line))) continue;
    if (excludeKeywords.some(kw => line.toLowerCase().includes(kw))) continue;

    const amount = extractAmountFromLine(line, isSlovenian);
    if (!amount) continue; // no price, skip

    // Filter lines with units after amount that are not prices, e.g. "kg", "l", "pcs"
    // If line contains unit right after amount, skip it as not item price line
    const unitAfterAmount = /(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))\s*(l|ml|kg|g|pcs|x)\b/i;
    if (unitAfterAmount.test(line)) continue;

    // Strip amount and currency from line to get item name
    const cleanName = line
      .replace(/(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/gi, "")
      .replace(/(EUR|USD|\$|€)/gi, "")
      .trim();

    if (!cleanName) continue; // no item name

    items.push({
      name: cleanName,
      price: amount.value,
      currency: amount.currency || currency,
    });
  }

  return {
    date,
    total,
    currency,
    items,
    version: PARSER_VERSION,
  };
}
