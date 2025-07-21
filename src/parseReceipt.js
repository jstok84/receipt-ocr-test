export function parseReceipt(text) {
  function normalizeAmount(value, isSlovenian) {
    if (isSlovenian) {
      return value.replace(/\./g, "").replace(",", ".");
    } else {
      return value.replace(/,/g, "");
    }
  }

  function extractTotalAmount(lines, isSlovenian) {
    const priorityKeywords = [
      "skupni znesek", "skupaj za plačilo", "skupaj z ddv", "končni znesek", "za plačilo", "total", "amount due"
    ];
    const fallbackKeywords = ["ddv", "tax", "vat"]; // Avoid these unless nothing else is found

    let candidateLine = [...lines].reverse().find(line =>
      priorityKeywords.some(kw => line.toLowerCase().includes(kw))
    );

    // Fallback to the highest-looking amount (not a tax line)
    if (!candidateLine) {
      candidateLine = [...lines].reverse().find(line =>
        /\d+[.,]\d{2}/.test(line) && !fallbackKeywords.some(kw => line.toLowerCase().includes(kw))
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

  const total = extractTotalAmount(lines, isSlovenian);

  const dateRegex = /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/;
  const dateMatch = lines.find(line => dateRegex.test(line))?.match(dateRegex);
  const date = dateMatch?.[1] ?? null;

  const excludeKeywords = isSlovenian
    ? [
        "transakcija", "terminal", "številka", "datum", "račun", "koda izdelka", "naslov", "uporabniški račun",
        "ddv", "matična", "obveznosti", "internet", "ime operaterja", "kraj izdaje", "znesek ddv"
      ]
    : [
        "transaction", "terminal", "id", "number", "purchase", "date", "invoice", "operator", "address",
        "subtotal", "tax", "vat", "card", "total"
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
    const namePart = line.slice(0, priceIndex).trim();

    if (namePart.length < 2) continue;

    let price = normalizeAmount(lastMatch[1], isSlovenian);
    if (lastMatch[2]) price += " " + lastMatch[2].toUpperCase();

    items.push({ name: namePart, price });
  }

  return { date, total, items };
}
