export function parseReceipt(text) {
  const PARSER_VERSION = "v1.3.7";
  console.log("🧾 Receipt parser version:", PARSER_VERSION);

    function normalizeAmount(value, isSlovenian) {
      if (isSlovenian) {
        if (value.includes(",")) {
        // Typical Slovenian format: dots as thousands, comma as decimal
        const normalized = value.replace(/\./g, "").replace(",", ".");
        console.log(`  normalizeAmount (SI, with comma): '${value}' -> '${normalized}'`);
        return normalized;
        } else {
        // No comma: treat dot as decimal separator, do NOT remove dots
        console.log(`  normalizeAmount (SI, no comma): '${value}' -> '${value}'`);
        return value;
        }
    } else {
        // Non-Slovenian: remove commas as thousands separator, keep dots as decimals
        const normalized = value.replace(/,/g, "");
        console.log(`  normalizeAmount (non-SI): '${value}' -> '${normalized}'`);
        return normalized;
    } else {
        // Non-Slovenian: remove thousands separator commas, dot as decimal point
        const normalized = value.replace(/,/g, "");
        console.log(`  normalizeAmount (non-SI): '${value}' -> '${normalized}'`);
        return normalized;
    }
    }


  function extractAmountFromLine(line, isSlovenian) {
    const regex = /(\d{1,3}(?:[ .,\s]?\d{3})*(?:[.,]\d{1,2}))\s*(EUR|USD|\$|€)?/gi;
    let match, lastMatch = null;
    while ((match = regex.exec(line)) !== null) {
      lastMatch = match;
    }
    if (!lastMatch) {
      console.log("  extractAmountFromLine: No amount found in line:", line);
      return null;
    }
    const rawValue = lastMatch[1];
    const normalizedValue = normalizeAmount(rawValue, isSlovenian);
    const value = parseFloat(normalizedValue);
    const currency = lastMatch[2]?.toUpperCase?.() || null;

    console.log(`  extractAmountFromLine: line='${line}' raw='${rawValue}' normalized='${normalizedValue}' value=${value} currency=${currency}`);

    return isNaN(value) ? null : { value, currency };
  }

  function extractAllTotalCandidates(lines, isSlovenian) {
    const totalKeywords = isSlovenian
      ? ["za plačilo", "skupaj", "znesek", "končni znesek", "skupna vrednost", "skupaj z ddv"]
      : ["total", "total amount", "amount due", "grand total", "amount", "to pay"];

    const candidates = lines
      .filter(line =>
        totalKeywords.some(kw => line.toLowerCase().includes(kw))
      )
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

    console.log("  extractAllTotalCandidates found:", candidates);
    return candidates;
  }

  function tryFallbackTotal(lines, isSlovenian) {
    let net = null, vat = null;
    let currency = null;

    for (const line of lines) {
      const lower = line.toLowerCase();
      const parsed = extractAmountFromLine(line, isSlovenian);
      if (!parsed) continue;

      if (isSlovenian) {
        if (lower.includes("osnova za ddv") || lower.includes("brez ddv")) {
          net = parsed.value;
          currency = parsed.currency ?? currency;
          console.log(`  tryFallbackTotal: Found net=${net} (${line})`);
        }
        if (lower.includes("skupaj ddv") || (lower.includes("ddv") && lower.includes("%"))) {
          vat = parsed.value;
          currency = parsed.currency ?? currency;
          console.log(`  tryFallbackTotal: Found vat=${vat} (${line})`);
        }
      } else {
        if (lower.includes("net")) {
          net = parsed.value;
          currency = parsed.currency ?? currency;
          console.log(`  tryFallbackTotal: Found net=${net} (${line})`);
        }
        if (lower.includes("vat") || lower.includes("tax")) {
          vat = parsed.value;
          currency = parsed.currency ?? currency;
          console.log(`  tryFallbackTotal: Found vat=${vat} (${line})`);
        }
      }
    }

    if (net != null && vat != null) {
      const total = parseFloat((net + vat).toFixed(2));
      console.log(`💡 Fallback total from net + VAT: ${net} + ${vat} = ${total}`);
      return { value: total, currency };
    }

    return null;
  }

  function extractDate(lines) {
    const dateRegex = /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/;
    const foundLine = lines.find(line => dateRegex.test(line));
    if (!foundLine) return null;

    const match = foundLine.match(dateRegex);
    if (!match) return null;

    const raw = match[1];
    const parts = raw.split(/[./-]/).map(Number);

    if (parts[0] > 31) return raw;

    let day, month, year;
    if (parts[2] < 100) parts[2] += 2000;

    [day, month, year] = parts[0] > 12 ? parts : [parts[1], parts[0], parts[2]];

    return `${year.toString().padStart(4, "0")}-${month
      .toString()
      .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  }

  const lines = text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  const joinedText = lines.join(" ").toLowerCase();
  const isSlovenian = [
    "račun", "kupec", "ddv", "znesek", "ponudba", "skupaj", "za plačilo"
  ].some(keyword => joinedText.includes(keyword));
  console.log("Detected language isSlovenian =", isSlovenian);

  const excludeKeywords = isSlovenian
    ? ["številka", "transakcija", "ddv", "datum", "račun", "osnovni kapital", "ponudbe", "rekapitulacija", "osnova", "veljavnost ponudbe"]
    : ["transaction", "terminal", "subtotal", "tax", "vat", "invoice", "date", "validity"];

  const totalCandidates = extractAllTotalCandidates(lines, isSlovenian);

  let total = null;
  let currency = "€";

  if (totalCandidates.length > 0) {
    total = totalCandidates[0].value;
    currency = totalCandidates[0].currency ?? currency;
    console.log(`Selected total candidate: value=${total} currency=${currency}`);
  }

  const fallbackTotal = tryFallbackTotal(lines, isSlovenian);
  if (fallbackTotal && (!total || fallbackTotal.value < total)) {
    console.log("⚠️ Using fallback total from net + ddv.");
    total = fallbackTotal.value;
    currency = fallbackTotal.currency ?? currency;
  }

  const date = extractDate(lines);
  console.log("Extracted date:", date);

  const items = [];

  for (const line of lines) {
    // Skip total candidate lines and excluded keywords
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

    // Find all numbers in line
    const allAmounts = [...line.matchAll(/(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/g)];
    if (!allAmounts.length) {
      console.log("No amounts found in line:", line);
      continue;
    }

    // Choose the last number as the price candidate (most likely the actual price)
    const lastAmountMatch = allAmounts[allAmounts.length - 1];
    const rawAmount = lastAmountMatch[1];
    const price = normalizeAmount(rawAmount, isSlovenian);

    // Extract name before the price number
    let namePart = line.slice(0, lastAmountMatch.index).trim();

    // Remove leading numbering or codes like '001', '002' etc.
    namePart = namePart.replace(/^\d+\s?[—\-–]?\s*/, "").trim();

    if (namePart.length < 2) {
      console.log("Skipping line due to short namePart:", namePart);
      continue;
    }

    const hasExcludedKeyword = excludeKeywords.some(kw =>
      new RegExp(`\\b${kw}\\b`, "i").test(namePart)
    );

    if (hasExcludedKeyword) {
      console.log(`Skipping line due to excluded keyword (${namePart}):`, line);
      continue;
    }

    // Parse price float to validate
    const priceFloat = parseFloat(price);
    if (isNaN(priceFloat)) {
      console.log("Skipping line due to NaN price:", price);
      continue;
    }

    console.log(`Parsed item: name='${namePart}', price='${priceFloat.toFixed(2)} ${currency}'`);

    items.push({ name: namePart, price: `${priceFloat.toFixed(2)} ${currency}` });
  }

  return {
    version: PARSER_VERSION,
    date,
    total: total ? `${total.toFixed(2)} ${currency}` : null,
    items,
  };
}
