export function parseReceipt(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Slovenian + English total keywords
  const totalKeywords = [
    "total", "skupaj", "znesek", "skupna vrednost", "skupaj z ddv",
    "znesek za plačilo", "končni znesek", "skupaj znesek", "amount",
    "total amount", "sum", "grand total", "end sum", "total price", "za plačilo",
  ];

  // Find last total line
  const totalLine = [...lines].reverse().find((l) =>
    totalKeywords.some((kw) => l.toLowerCase().includes(kw))
  );

  const totalMatch = totalLine?.match(
    /(\d{1,3}(?:[ ,.]?\d{3})*(?:[.,]\d{1,2})?)\s*(EUR|USD|\$|€)?/i
  );
  let total = null;
  if (totalMatch) {
    total = totalMatch[1].replace(/[\s,]/g, "").replace(",", ".");
    if (totalMatch[2]) total += " " + totalMatch[2].toUpperCase();
  }

  // Date regex
  const dateRegex =
    /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/;
  const dateLine = lines.find((l) => dateRegex.test(l));
  const dateMatch = dateLine?.match(dateRegex);
  const date = dateMatch ? dateMatch[1] : null;

  // Exclude lines starting with these keywords (whole words only)
  const excludeKeywords = [
    "transaction", "terminal", "id", "number", "purchase", "type", "response",
    "approval", "credit", "paid by", "card", "sub total", "subtotal", "tax", "total",
    // Slovenian
    "transakcija", "terminal", "številka", "nakup", "tip", "odgovor",
    "odobritev", "kredit", "plačano z", "kartica", "vrednost brez ddv", "ddv", "skupaj"
  ];

  // Helper: check if line should be excluded by keyword as a separate word
  function isExcluded(line) {
    const lower = line.toLowerCase();
    return excludeKeywords.some(kw => {
      const pattern = new RegExp(`\\b${kw}\\b`, "i");
      return pattern.test(lower);
    });
  }

  // Parse items: find last price-like pattern on the line (allows multiple prices per line)
  const items = lines
    .filter(line => !isExcluded(line))
    .map(line => {
      // Find all price matches (e.g. $12.50 or 12,50 etc)
      const priceRegex = /(\d{1,3}(?:[ ,.]?\d{3})*(?:[.,]\d{1,2}))\s*(EUR|USD|\$|€)?/gi;
      let match, lastMatch = null;
      while ((match = priceRegex.exec(line)) !== null) {
        lastMatch = match;
      }
      if (!lastMatch) return null;

      // Extract product name as everything before last price match
      const priceIndex = lastMatch.index;
      const name = line.substring(0, priceIndex).trim();

      if (name.length < 2) return null; // filter out very short names

      let price = lastMatch[1].replace(/[\s,]/g, "").replace(",", ".");
      if (lastMatch[2]) price += " " + lastMatch[2].toUpperCase();

      return { name, price };
    })
    .filter(Boolean);

  return { date, total, items };
}
