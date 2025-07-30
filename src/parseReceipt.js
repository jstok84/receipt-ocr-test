export function parseReceipt(text) {
  const PARSER_VERSION = "v1.3.9"; // updated version
  console.log("🧾 Receipt parser version:", PARSER_VERSION);

  // --- NEW: Merge broken lines that belong together ---
  // Lines ending without punctuation and next line starting lowercase or number often belong together.
  function mergeLines(lines) {
    const merged = [];
    for (let i = 0; i < lines.length; i++) {
      let currentLine = lines[i];
      while (
        i + 1 < lines.length &&
        // Current line does NOT end with punctuation or currency symbol:
        !/[.!?€$]$/.test(currentLine.trim()) &&
        // Next line starts with lowercase or number (often continuation):
        /^[a-z0-9]/.test(lines[i + 1].trim())
      ) {
        currentLine += " " + lines[i + 1].trim();
        i++;
      }
      merged.push(currentLine);
    }
    return merged;
  }

  function normalizeAmount(value, isSlovenian) {
    if (isSlovenian) {
      if (value.includes(",")) {
        // "1.234,56" -> "1234.56"
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

    const candidates = lines
      .filter(line =>
        totalKeywords.some(kw => line.toLowerCase().includes(kw))
      )
      .filter(line => !/^c\s+\d{1,2},\d{1,2}\s*%\s+[\d\s.,]+—?\s*[\d\s.,]+/i.test(line.toLowerCase())) // exclude VAT summary line
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

  function tryFallbackTotal(lines, isSlovenian) {
    let net = null,
      vat = null;
    let currency = null;

    for (const line of lines) {
      const lower = line.toLowerCase();
      const parsed = extractAmountFromLine(line, isSlovenian);
      if (!parsed) continue;

      // Detect VAT summary line like: C 22,00 % 208,12 45,78 — 253,90 €
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

      if (isSlovenian) {
        if (lower.includes("osnova za ddv") || lower.includes("brez ddv")) {
          net = parsed.value;
          currency = parsed.currency ?? currency;
        }
        if (lower.includes("skupaj ddv") || (lower.includes("ddv") && lower.includes("%"))) {
          vat = parsed.value;
          currency = parsed.currency ?? currency;
        }
      } else {
        if (lower.includes("net")) {
          net = parsed.value;
          currency = parsed.currency ?? currency;
        }
        if (lower.includes("vat") || lower.includes("tax")) {
          vat = parsed.value;
          currency = parsed.currency ?? currency;
        }
      }
    }

    if (net != null && vat != null) {
      const total = parseFloat((net + vat).toFixed(2));
      return { value: total, currency };
    }

    return null;
  }

  function extractDate(lines) {
    // Match date format dd.mm.yyyy, dd/mm/yyyy, yyyy-mm-dd, etc.
    // Day: 1-31, Month: 1-12, Year: 4 digits or 2 digits assumed 2000+
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

  // --- Start processing ---

  let lines = text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  // Apply merging logic here:
  lines = mergeLines(lines);

  const joinedText = lines.join(" ").toLowerCase();
  const isSlovenian = [
    "račun", "kupec", "ddv", "znesek", "ponudba", "skupaj", "za plačilo", "plačano"
  ].some(keyword => joinedText.includes(keyword));

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

  const date = extractDate(lines);
  const items = [];

  const nonItemPatterns = [
    /^plačano/i,
    /^c\s+\d{1,2},\d{1,2}\s*%\s+[\d\s.,]+—?\s*[\d\s.,]+/i, // VAT lines
    /^[a-zA-Z]\s*\d{1,2}[,.]\d{1,2}%\s+\d+[,.]\d+\s+\d+[,.]\d+/i,  // strict VAT line filter
    /^dov:/i,     // skip VAT lines starting with 'Dov:'
    /^bl:/i,      // skip metadata lines starting with 'BL:'
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
    /^vsi zneski so v/i
  ];

  for (const line of lines) {
    const isServiceCostLine = /stroški storitve/i.test(line);

    if (!isServiceCostLine && nonItemPatterns.some(pattern => pattern.test(line))) {
      console.log("Skipping known non-item line:", line);
      continue;
    }
    if (/veljavnost ponudbe/i.test(line)) {
      console.log("Skipping line due to 'veljavnost ponudbe':", line);
      continue;
    }
    if (totalCandidates.some(t => t.line === line)) {
      console.log("Skipping total candidate line:", line);
      continue;
    }
    if (/rekapitulacija|osnova za ddv|skupaj ddv/i.test(line)) {
      console.log("Skipping tax summary line:", line);
      continue;
    }

    // Extract all amounts in line
    const allAmounts = [...line.matchAll(/(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/g)];
    if (!allAmounts.length && !isServiceCostLine) {
      console.log("No amounts found in line:", line);
      continue;
    }

    // Use last amount as price candidate
    const lastAmountMatch = allAmounts.length ? allAmounts[allAmounts.length - 1] : null;
    const rawAmount = lastAmountMatch ? lastAmountMatch[1] : "0";
    const priceStr = normalizeAmount(rawAmount, isSlovenian);
    const priceFloat = parseFloat(priceStr);

    // New check: if last amount is followed by a unit like 'L', 'ml', 'kg', 'g', etc. => skip line (volume/quantity, not price)
    const units = ["l", "ml", "kg", "g", "pcs", "x"];
    const afterLastAmountIndex = lastAmountMatch.index + rawAmount.length;
    const afterToken = line.slice(afterLastAmountIndex).trim().toLowerCase().split(/\s+/)[0] || "";
    if (units.includes(afterToken)) {
      console.log(`Skipping line because last number looks like volume/quantity unit '${afterToken}':`, line);
      continue;
    }

    if (isNaN(priceFloat)) {
      console.log("Price is NaN, skipping line:", line);
      continue;
    }

    // Extract quantity if possible (look for number before last amount, or default 1)
    let quantity = 1;
    const quantityMatch = line.match(/(\d+)\s*x/i);
    if (quantityMatch) {
      quantity = parseInt(quantityMatch[1], 10);
    }

    // Clean item name by removing amounts and known keywords
    let itemName = line;

    // Remove last amount from item name
    const lastAmountRegex = new RegExp(rawAmount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$");
    itemName = itemName.replace(lastAmountRegex, "").trim();

    // Remove quantity notation like "2x" or "x2"
    itemName = itemName.replace(/\b\d+x\b/i, "").trim();

    // Remove currency symbols or keywords
    itemName = itemName.replace(/(EUR|USD|€|\$)/gi, "").trim();

    if (itemName.length === 0) {
      itemName = "(item)";
    }

    items.push({
      name: itemName,
      price: priceFloat,
      quantity,
    });
  }

  return {
    items,
    total,
    currency,
    date,
    version: PARSER_VERSION,
  };
}
