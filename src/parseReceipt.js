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

  // Find the last line that contains total info
  const totalLineObj = [...lines]
    .reverse()
    .map((line, index) => ({ line, index: lines.length - 1 - index }))
    .find(({ line }) =>
      totalKeywords.some((kw) => line.toLowerCase().includes(kw))
    );

  const totalLine = totalLineObj?.line || null;
  const totalLineIndex = totalLineObj?.index ?? -1;
  const total = extractTotalAmount(totalLine);

  // Extract date
  const dateRegex = /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/;
  const dateMatch = lines.find((line) => dateRegex.test(line))?.match(dateRegex);
  const date = dateMatch?.[1] ?? null;

  const excludeKeywords = [
    "transaction", "terminal", "id", "number", "purchase", "type", "response",
    "approval", "credit", "paid by", "card", "sub total", "subtotal", "tax", "vat", "sales tax",
    // Slovenian
    "transakcija", "terminal", "številka", "nakup", "tip", "odgovor",
    "odobritev", "kredit", "plačano z", "kartica", "vrednost brez ddv", "ddv", "skupaj"
  ];

  function isExcluded(line) {
    const lower = line.toLowerCase();
    return excludeKeywords.some((kw) => new RegExp(`\\b${kw}\\b`, "i").test(lower));
  }

  const items = lines
    .filter((line, idx) => idx !== totalLineIndex && !isExcluded(line))
    .map((line) => {
      const priceRegex = /(\d{1,3}(?:[ ,.]?\d{3})*(?:[.,]\d{1,2}))\s*(EUR|USD|\$|€)?/gi;

      let match, lastMatch = null;
      while ((match = priceRegex.exec(line)) !== null) {
        lastMatch = match;
      }

      if (!lastMatch) return null;

      const priceIndex = lastMatch.index;
      const name = line.slice(0, priceIndex).trim();
      if (name.length < 2) return null;

      let price = lastMatch[1].replace(/[\s,]/g, "").replace(",", ".");
      if (lastMatch[2]) price += " " + lastMatch[2].toUpperCase();

      return { name, price };
    })
    .filter(Boolean);

  return { date, total, items };
}
