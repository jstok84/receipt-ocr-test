export function parseReceipt(text, options = { flatMode: false }) {
  const PARSER_VERSION = "v1.5.0";
  console.log("🧾 Receipt parser version:", PARSER_VERSION);

  // If flatMode toggle is on, parse text as a single flat string without splitting into lines
  // Otherwise, parse normally line-by-line (original behavior)
  const flatMode = options.flatMode === true;

  /**
   * Normalize amount strings considering Slovenian format (e.g. "1.234,56")
   * or standard (e.g. "1,234.56").
   * Returns a float-parsable string.
   */
  function normalizeAmount(value, isSlovenian) {
    if (isSlovenian) {
      if (value.includes(",")) {
        // "1.234,56" -> "1234.56"
        return value.replace(/\./g, "").replace(",", ".");
      } else {
        // If multiple dots but no comma, remove dots
        const dotCount = (value.match(/\./g) || []).length;
        if (dotCount <= 1) return value;
        return value.replace(/\./g, "");
      }
    } else {
      return value.replace(/,/g, "");
    }
  }

  /**
   * Extracts the last amount with optional currency from a given text snippet.
   * Returns { value: Number, currency: String|null } or null if none found.
   */
  function extractAmountFromText(text, isSlovenian) {
    // Match numbers with optional grouping and decimal separators, followed by optional currency
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

  /**
   * Extracts candidate total amounts from the text based on total keywords.
   * Returns an array of { text: string, value: number, currency: string|null } sorted descending by value.
   */
  function extractAllTotalCandidates(text, isSlovenian) {
    const totalKeywords = isSlovenian
      ? ["plačano", "za plačilo", "skupaj", "znesek", "končni znesek", "skupna vrednost", "skupaj z ddv"]
      : ["paid", "total", "amount due", "grand total", "amount", "to pay"];

    // We scan for each keyword inside text and extract amounts around it.
    const candidates = [];

    for (const kw of totalKeywords) {
      // Find all occurrences of keyword in text (case-insensitive)
      const regex = new RegExp(`.{0,40}${kw}.{0,40}`, "gi");
      let match;
      while ((match = regex.exec(text)) !== null) {
        const context = match[0]; // snippet around keyword
        const parsed = extractAmountFromText(context, isSlovenian);
        if (parsed && parsed.value > 0) {
          candidates.push({ text: context, value: parsed.value, currency: parsed.currency });
        }
      }
    }

    // Sort candidates descending by value (most probable total first)
    candidates.sort((a, b) => b.value - a.value);
    return candidates;
  }

  /**
   * Tries fallback total calculation from VAT/net/tax summary info inside text.
   * Returns { value, currency } or null if not found.
   */
  function tryFallbackTotal(text, isSlovenian) {
    // Regex for VAT summary lines: net + vat amounts
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

    // Additionally, try to find net and vat separately in text
    let net = null, vat = null;

    // Simple heuristics to find net and vat values by keywords
    // This scans for e.g. "net ... amount" or "ddv" (VAT in Slovenian)
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
      const total = parseFloat((net + vat).toFixed(2));
      return { value: total, currency: null };
    }

    return null;
  }

  /**
   * Extract date string from the text, looking for common date patterns.
   * Returns ISO string "YYYY-MM-DD" or null.
   */
  function extractDate(text) {
    // Date regex supporting formats like dd.mm.yyyy or dd/mm/yyyy or dd-mm-yyyy
    const dateRegex = /\b(0?[1-9]|[12][0-9]|3[01])[./-](0?[1-9]|1[0-2])[./-](\d{2}|\d{4})\b/;
    const lines = flatMode ? [text] : text.split("\n");
    for (const line of lines) {
      const match = line.match(dateRegex);
      if (match) {
        let day = parseInt(match[1], 10);
        let month = parseInt(match[2], 10);
        let year = parseInt(match[3], 10);
        if (year < 100) year += 2000; // two digit years -> 2000+
        return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
      }
    }
    return null;
  }

  /**
   * Extract item entries (name + price) from text.
   * For flat mode, we scan for amounts and parse surrounding text heuristics.
   * Returns array of { name, price }.
   */
  function extractItems(text, isSlovenian, currency) {
    const items = [];

    // Keywords and patterns to exclude lines as non-item info
    const excludeKeywords = isSlovenian
      ? ["številka", "transakcija", "ddv", "datum", "račun", "osnovni kapital", "ponudbe", "rekapitulacija", "osnova", "veljavnost ponudbe"]
      : ["transaction", "terminal", "subtotal", "tax", "vat", "invoice", "date", "validity"];

    // Known non-item patterns (partial regex from original)
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

    // We'll find all amount matches in the text
    // Then try to extract item names by grabbing text before amount, and validate exclusions.
    const amountRegex = /(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/g;
    let match;

    while ((match = amountRegex.exec(text)) !== null) {
      const rawAmount = match[1];
      const index = match.index;

      // Normalize and parse price
      const priceStr = normalizeAmount(rawAmount, isSlovenian);
      const priceFloat = parseFloat(priceStr);
      if (isNaN(priceFloat) || priceFloat <= 0) continue;

      // Extract preceding text up to 60 chars to use as item name candidate
      const prefixStart = Math.max(0, index - 60);
      let nameCandidate = text.slice(prefixStart, index).trim();

      // Remove leading quantity indicators like "1 x ", "2x "
      nameCandidate = nameCandidate.replace(/^\d+\s*x?\s*/i, "").trim();

      // Remove leading dash or similar separators
      nameCandidate = nameCandidate.replace(/^[-–—]\s*/, "");

      // Check exclude keywords
      const hasEx = excludeKeywords.some(kw => new RegExp(`\\b${kw}\\b`, "i").test(nameCandidate));
      if (nameCandidate.length < 2 || hasEx) continue;

      // Avoid duplicates: if item with same name and price already added, skip
      if (items.some(item => item.name === nameCandidate && item.price === priceFloat)) continue;

      // Push item with price and currency info
      items.push({ name: nameCandidate, price: `${priceFloat.toFixed(2)} ${currency}` });
    }

    return items;
  }

  // --- START parsing ---

  // Determine if document is Slovenian by searching for known Slovenian keywords in the text
  const lowerText = text.toLowerCase();
  const isSlovenian = [
    "račun", "kupec", "ddv", "znesek", "ponudba", "skupaj", "za plačilo", "plačano"
  ].some(kw => lowerText.includes(kw));

  // Extract all candidate totals
  const totalCandidates = extractAllTotalCandidates(text, isSlovenian);

  // Pick the highest total candidate by default
  let total = null;
  let currency = "€";
  if (totalCandidates.length > 0) {
    total = totalCandidates[0].value;
    currency = totalCandidates[0].currency ?? currency;
  }

  // Try fallback total extraction
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

  // Extract date from text
  const date = extractDate(text);

  // Extract items
  const items = extractItems(text, isSlovenian, currency);

  // Return structured parsed data
  return {
    version: PARSER_VERSION,
    date,
    total: total ? `${total.toFixed(2)} ${currency}` : null,
    items
  };
}
