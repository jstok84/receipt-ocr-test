export function parseReceipt(text) {
  function extractTotalAmount(line) {
    if (!line) return null;
    const regex = /(\d{1,3}(?:[ ,.]?\d{3})*(?:[.,]\d{1,2}))\s*(EUR|USD|\$|€)?/gi;

    let match, lastMatch = null;
    while ((match = regex.exec(line)) !== null) {
      lastMatch = match;
    }

    if (!lastMatch) return null;

    let amount = lastMatch[1].replace(/[\s,]/g, "").replace(",", ".");
    if (lastMatch[2]) amount += " " + lastMatch[2].toUpperCase();

    return amount;
  }

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const totalKeywords = [
    "total", "total amount", "grand total", "amount", "total price", "end sum", "sum", "za plačilo",
    "skupaj", "znesek", "skupna vrednost", "skupaj z ddv", "znesek za plačilo", "končni znesek"
  ];

  // Find the total line
  const totalLine = [...lines].reverse().find(line =>
    totalKeywords.some(kw => line.toLowerCase().includes(kw))
  );

  const total = extractTotalAmount(totalLine);

  // Extract date
  const dateRegex = /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/;
  const dateMatch = lines.find(line => dateRegex.test(line))?.match(dateRegex);
  const date = dateMatch?.[1] ?? null;

  // Keywords that indicate non-product lines
  const excludeKeywords = [
    "transaction", "terminal", "id", "number", "purchase", "type", "response",
    "approval", "credit", "paid by", "card", "sub total", "subtotal", "tax", "vat", "sales tax",
    "transakcija", "terminal", "številka", "nakup", "tip", "odgovor",
    "odobritev", "kredit", "plačano z", "kartica", "vrednost brez ddv", "ddv", "skupaj"
  ];

  const items = [];

  for (const line of lines) {
    // ✅ Skip the line we already used for total
    if (line === totalLine) continue;

    const priceRegex = /(\d{1,3}(?:[ ,.]?\d{3})*(?:[.,]\d{1,2}))\s*(EUR|USD|\$|€)?/gi;

    let match, lastMatch = null;
    while ((match = priceRegex.exec(line)) !== null) {
      lastMatch = match;
    }

    if (!lastMatch) continue;

    const priceIndex = lastMatch.index;
    const namePart = line.slice(0, priceIndex).trim();

    if (namePart.length < 2) continue;

    const hasExcludedKeyword = excludeKeywords.some(kw =>
      new RegExp(`\\b${kw}\\b`, "i").test(namePart)
    );

    if (hasExcludedKeyword) continue;

    let price = lastMatch[1].replace(/[\s,]/g, "").replace(",", ".");
    if (lastMatch[2]) price += " " + lastMatch[2].toUpperCase();

    items.push({ name: namePart, price });
  }

  return { date, total, items };
}
