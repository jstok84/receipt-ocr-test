export function parseReceipt(text) {
  const PARSER_VERSION = "v2.0.0";  // fresh version tag for this rebuild
  console.log("🧾 Receipt parser version:", PARSER_VERSION);

  // ---------------------------
  // 1) Merge broken lines intelligently
  //    - Merge letter-only lines with the following lines (which can be numeric or amounts)
  //    - This helps to reconstruct multi-line items/amounts
  // ---------------------------
  function mergeBrokenLines(text) {
    const lines = text.split("\n");
    const merged = [];
    for (let i = 0; i < lines.length; i++) {
      const curr = lines[i].trim();
      const next = lines[i + 1]?.trim();

      // Merge if both lines are letter-like (incl. Slovenian chars)
      const bothLetters = curr && next &&
        /^[a-zA-Z\s\-šžčćđŠŽČĆĐ]+$/.test(curr) &&
        /^[a-zA-Z\s\-šžčćđŠŽČĆĐ]+$/.test(next);

      // Merge if current line letters, next line starts with number or currency
      const nextStartsAmount = curr && next &&
        /^[a-zA-Z\s\-šžčćđŠŽČĆĐ]+$/.test(curr) &&
        (/^[€$]?[\d]/.test(next));

      if (bothLetters || nextStartsAmount) {
        merged.push(curr + " " + next);
        i++; // skip next line
      } else {
        merged.push(curr);
      }
    }
    return merged.join("\n");
  }
  text = mergeBrokenLines(text);

  // ---------------------------
  // 2) Normalize amount strings depending on locale (Slovenian vs Others)
  //    - Handle thousand separators and decimal commas and dots consistently
  // ---------------------------
  function normalizeAmount(value, isSlovenian) {
    if (isSlovenian) {
      // Slovenian: dot = thousand sep, comma = decimal sep
      if (value.includes(",")) {
        return value.replace(/\./g, "").replace(",", ".");
      } else {
        // If multiple dots and no commas, remove dots (thousand sep)
        const dotCount = (value.match(/\./g) || []).length;
        if (dotCount <= 1) return value;
        return value.replace(/\./g, "");
      }
    } else {
      // English-like: comma = thousand sep, dot = decimal sep
      return value.replace(/,/g, "");
    }
  }

  // ---------------------------
  // 3) Parse amount + currency from a single text line (last numeric amount prioritized)
  // ---------------------------
  function extractAmountFromLine(line, isSlovenian) {
    const regex = /(\d{1,3}(?:[ .,\s]?\d{3})*(?:[.,]\d{1,2}))\s*(EUR|USD|\$|€)?/gi;
    let lastMatch = null, match;
    while ((match = regex.exec(line)) !== null) {
      lastMatch = match;
    }
    if (!lastMatch) return null;

    const rawAmount = lastMatch[1];
    const normalized = normalizeAmount(rawAmount, isSlovenian);
    const value = parseFloat(normalized);
    const currency = lastMatch[2]?.toUpperCase?.() || null;

    return isNaN(value) ? null : { value, currency };
  }

  // ---------------------------
  // 4) Extract all total candidates from lines
  //    - Look for total-related keywords, and if no amount on that line, try next line
  //    - Candidates sorted by descending amount to pick highest probable total
  // ---------------------------
  function extractAllTotalCandidates(lines, isSlovenian) {
    const totalKeywords = isSlovenian
      ? ["plačano", "za plačilo", "skupaj", "znesek", "končni znesek", "skupna vrednost", "skupaj z ddv"]
      : ["paid", "total", "amount due", "grand total", "amount", "to pay"];

    const candidates = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!totalKeywords.some(kw => line.toLowerCase().includes(kw))) continue;

      let parsed = extractAmountFromLine(line, isSlovenian);
      if (!parsed) {
        // Try next line for amount if not found in current line  
        const nextLine = lines[i + 1];
        if (nextLine) {
          parsed = extractAmountFromLine(nextLine, isSlovenian);
          if (parsed) {
            candidates.push({ line: line + " " + nextLine, value: parsed.value, currency: parsed.currency });
            continue;
          }
        }
        continue; // no amount found in this or next line — skip
      }
      if (parsed.value > 0) {
        candidates.push({ line, value: parsed.value, currency: parsed.currency });
      }
    }

    // Sort candidates descending by value to prioritize highest total
    candidates.sort((a,b) => b.value - a.value);
    return candidates;
  }

  // ---------------------------
  // 5) Try fallback total by checking VAT summary lines or net+vat sums
  // ---------------------------
  function tryFallbackTotal(lines, isSlovenian) {
    let net = null, vat = null, currency = null;

    for (const line of lines) {
      const lower = line.toLowerCase();
      const parsed = extractAmountFromLine(line, isSlovenian);
      if (!parsed) continue;

      // Pattern to find VAT summary line with two amounts (net and VAT)
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

      // Slovenian or English keywords for net and VAT
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

  // ---------------------------
  // 6) Extract date from lines
  //    - Matches dd.mm.yyyy, dd/mm/yyyy, dd-mm-yyyy, also 2-digit years
  // ---------------------------
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

  // ---------------------------
  // 7) Determine localization by keywords present
  // ---------------------------
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const fullTextLower = lines.join(" ").toLowerCase();
  const isSlovenian = ["račun","kupec","ddv","znesek","ponudba","skupaj","za plačilo","plačano"]
    .some(kw => fullTextLower.includes(kw));

  // ---------------------------
  // 8) Define exclusion keywords to avoid false item matches
  // ---------------------------
  const excludeKeywords = isSlovenian
    ? ["številka","transakcija","ddv","datum","račun","osnovni kapital","ponudbe","rekapitulacija","osnova","veljavnost ponudbe","keine"]
    : ["transaction","terminal","subtotal","tax","vat","invoice","date","validity"];

  // ---------------------------
  // 9) Regex to detect date-like amounts that should NOT be treated as prices
  //     (e.g., 24.06, 01,06, etc. indicating dates)
  // ---------------------------
  const dateLikeAmountRegex = /^\d{1,2}[.,]\d{1,2}$/;

  // ---------------------------
  // 10) Extract totals
  // ---------------------------
  let total = null, currency = "€";
  const totalCandidates = extractAllTotalCandidates(lines, isSlovenian);
  if (totalCandidates.length > 0) {
    total = totalCandidates[0].value;
    currency = totalCandidates[0].currency ?? currency;
  }
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

  // ---------------------------
  // 11) Extract date
  // ---------------------------
  const date = extractDate(lines);

  // ---------------------------
  // 12) Extract line items
  //     - Skip lines in excludeKeywords and known non-item regex patterns
  //     - Skip lines with date-like amounts
  //     - Extract last amount as price, rest of line as item name
  // ---------------------------
  const nonItemLinePatterns = [
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

  const items = [];

  for (const line of lines) {
    const isServiceCostLine = /stroški storitve/i.test(line);

    // Skip known non-items except service cost lines
    if (!isServiceCostLine && nonItemLinePatterns.some(pat => pat.test(line))) {
      // console.log("Skipping non-item line:", line);
      continue;
    }
    // Skip lines used as total candidates or VAT recap
    if (totalCandidates.some(tc => tc.line === line)) continue;
    if (/rekapitulacija|osnova za ddv|skupaj ddv/i.test(line)) continue;

    // Extract all amounts in line
    const amounts = [...line.matchAll(/(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/g)];
    if (!amounts.length && !isServiceCostLine) continue;

    const lastAmountMatch = amounts.length ? amounts[amounts.length - 1] : null;
    const rawAmount = lastAmountMatch ? lastAmountMatch[1] : "0";

    // Skip date-like amounts (to avoid parsing e.g. "24.06" as price)
    if (dateLikeAmountRegex.test(rawAmount)) continue;

    const priceStr = normalizeAmount(rawAmount, isSlovenian);
    const price = parseFloat(priceStr);
    if (isNaN(price) || price <= 0) continue;

    // Check if the token after amount is a unit like ml, kg, pcs - skip those
    const afterAmountIndex = lastAmountMatch.index + rawAmount.length;
    const afterToken = line
      .slice(afterAmountIndex)
      .trim()
      .toLowerCase()
      .split(/\s+/)[0] || "";
    if (["l", "ml", "kg", "g", "pcs", "x"].includes(afterToken)) continue;

    // Extract item name (preceding last amount)
    let name = lastAmountMatch ? line.slice(0, lastAmountMatch.index).trim() : line.trim();
    name = name.replace(/^\d+\s*x?\s*/i, "").trim(); // remove quantity prefix like '1 x'
    name = name.replace(/^[-–—•*]\s*/, ""); // remove leading bullet/dash

    // Exclude items with excluded keywords or too short names (except service cost lines)
    const hasExclude = excludeKeywords.some(kw => new RegExp(`\\b${kw}\\b`, "i").test(name));
    if (!isServiceCostLine && (name.length < 2 || hasExclude)) continue;

    if (name.length === 0 && isServiceCostLine) name = "Stroški storitve";

    items.push({ name, price: `${price.toFixed(2)} ${currency}` });
  }

  // Return final structured result
  return {
    version: PARSER_VERSION,
    date,
    total: total ? `${total.toFixed(2)} ${currency}` : null,
    items
  };
}
