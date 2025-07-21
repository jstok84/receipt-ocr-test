export function parseReceipt(text) {
  function normalizeAmount(value, isSlovenian) {
    return isSlovenian
      ? value.replace(/\./g, "").replace(",", ".")
      : value.replace(/,/g, "");
  }

  function toIsoDate(dateStr) {
    const parts = dateStr.split(/[./-]/);
    if (parts.length !== 3) return null;

    let [d, m, y] = parts.map((p) => p.padStart(2, "0"));

    if (y.length === 2) {
      const yearNum = parseInt(y, 10);
      y = yearNum >= 50 ? `19${y}` : `20${y}`;
    }

    return `${y}-${m}-${d}`;
  }

  function extractTotalAmount(lines, isSlovenian) {
    const priorityKeywords = [
      "skupni znesek", "skupaj za plačilo", "skupaj z ddv", "končni znesek", "za plačilo", "total", "amount due"
    ];
    const fallbackKeywords = ["ddv", "tax", "vat"];

    let candidateLine = [...lines].reverse().find(line =>
      priorityKeywords.some(kw => line.toLowerCase().includes(kw))
    );

    if (!candidateLine) {
      candidateLine = [...lines].reverse().find(line =>
        /\d+[.,]\d{2}/.test(line) &&
        !fallbackKeywords.some(kw => line.toLowerCase().includes(kw))
      );
    }

    if (!candidateLine) return null;

    const regex = /(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))\s*(EUR|USD|\$|€)?/gi;
    let match, lastMatch = null;
    while ((match = regex.exec(candidateLine)) !== null) {
      lastMatch = match;
    }

    if (!lastMatch) return null;

    let amount = normalizeAmount(lastMatch[1], isSlovenian);
    if (lastMatch[2]) amount += " " + lastMatch[2].toUpperCase();

    return amount;
  }

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const joinedText = lines.join(" ").toLowerCase();
  const isSlovenian = [
    "račun", "kupec", "ddv", "znesek", "ponudba", "skupaj", "za plačilo", "datum ponudbe", "osnovni kapital"
  ].some(keyword => joinedText.includes(keyword));

  // Extract ISO date
  const dateRegex = /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/;
  const rawDate = lines.find(line => dateRegex.test(line))?.match(dateRegex)?.[1] ?? null;
  const date = rawDate ? toIsoDate(rawDate) : null;

  const total = extractTotalAmount(lines, isSlovenian);

  const excludeKeywords = isSlovenian
    ? [
        "transakcija", "terminal", "številka", "datum", "račun", "koda izdelka", "naslov",
        "uporabniški račun", "matična", "ddv", "obveznosti", "ime operaterja"
      ]
    : [
        "transaction", "terminal", "id", "number", "purchase", "date", "invoice", "operator",
        "address", "subtotal", "tax", "vat", "card", "total"
      ];

  const items = [];

  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    if (excludeKeywords.some(kw => lowerLine.includes(kw))) continue;
    if (line === total) continue;

    const priceRegex = /(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))\s*(EUR|USD|\$|€)?/gi;
    let match, lastMatch = null;
    while ((match = priceRegex.exec(line)) !== null) {
      lastMatch = match;
    }

    if (!lastMatch) continue;

    const priceIndex = lastMatch.index;
    let namePart = line.slice(0, priceIndex).trim();

    // ✅ Remove numeric code prefixes like `2102120 —`
    namePart = namePart.replace(/^\d{5,}\s?[—\-–—]?\s*/g, "").trim();
    if (namePart.length < 2) continue;

    const hasExcluded = excludeKeywords.some(kw =>
      new RegExp(`\\b${kw}\\b`, "i").test(namePart)
    );
    if (hasExcluded) continue;

    let price = normalizeAmount(lastMatch[1], isSlovenian);
    if (lastMatch[2]) price += " " + lastMatch[2].toUpperCase();

    items.push({ name: namePart, price });
  }

  return { date, total, items };
}
