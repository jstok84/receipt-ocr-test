export function parseReceipt(text) {
  const PARSER_VERSION = "v1.3.8";
  console.log("🧾 Receipt parser version:", PARSER_VERSION);

  function normalizeAmount(value, isSlovenian) {
    if (isSlovenian) {
      if (value.includes(",")) {
        const normalized = value.replace(/\./g, "").replace(",", ".");
        return normalized;
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
          "plačano", // highest priority
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
      .filter(line => !/^c\s+\d{1,2},\d{2}\s+/.test(line.toLowerCase())) // exclude VAT summary line
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
        /c\s+\d{1,2},\d{2}\s*%\s+(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))\s+(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/i
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

      // Optional legacy fallback
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
    const dateRegex = /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/;
    const foundLine = lines.find(line => dateRegex.test(line));
    if (!foundLine) return null;
    const match = foundLine.match(dateRegex);
    if (!match) return null;

    const raw = match[1];
    const parts = raw.split(/[./-]/).map(Number);
    if (parts[0] > 31) return raw;

    let [day, month, year] = parts.length === 3 ? parts : [1, 1, 2000];
    if (year < 100) year += 2000;
    if (day > 12) [day, month] = [month, day];

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
    const isFallbackMoreTrustworthy = (!total || delta <= 0.05 || fallbackTotal.value < total);

    if (isFallbackMoreTrustworthy) {
      total = fallbackTotal.value;
      currency = fallbackTotal.currency ?? currency;
    }
  }

  const date = extractDate(lines);
  const items = [];

  const nonItemPatterns = [
    /^plačano/i,
    /^c\s+\d{1,2},\d{2}\s*%\s+[\d\s.,]+—?\s*[\d\s.,]+/i, // VAT lines like "C 22,00 % 208,12 45,78"
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
    /skupaj eur/i
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

    const allAmounts = [...line.matchAll(/(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/g)];
    if (!allAmounts.length && !isServiceCostLine) {
      console.log("No amounts found in line:", line);
      continue;
    }

    const lastAmountMatch = allAmounts.length ? allAmounts[allAmounts.length - 1] : null;
    const rawAmount = lastAmountMatch ? lastAmountMatch[1] : "0";
    const price = normalizeAmount(rawAmount, isSlovenian);

    let namePart = lastAmountMatch ? line.slice(0, lastAmountMatch.index).trim() : line.trim();
    namePart = namePart.replace(/^\d+\s?[—\-–]?\s*/, "").trim();

    const hasExcludedKeyword = excludeKeywords.some(kw =>
      new RegExp(`\\b${kw}\\b`, "i").test(namePart)
    );

    if (!isServiceCostLine && (namePart.length < 2 || hasExcludedKeyword)) {
      console.log(`Skipping line due to excluded keyword or short name (${namePart}):`, line);
      continue;
    }

    const priceFloat = parseFloat(price);
    if (isNaN(priceFloat)) {
      console.log("Skipping line due to NaN price:", price);
      continue;
    }

    const itemName = namePart.length > 0 ? namePart : "Stroški storitve";
    console.log(`Parsed item: name='${itemName}', price='${priceFloat.toFixed(2)} ${currency}'`);

    items.push({ name: itemName, price: `${priceFloat.toFixed(2)} ${currency}` });
  }


  return {
    version: PARSER_VERSION,
    date,
    total: total ? `${total.toFixed(2)} ${currency}` : null,
    items,
  };
}
