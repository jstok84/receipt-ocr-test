export function parseReceipt(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Keywords for detecting total lines, including Slovenian
  const totalKeywords = [
    "total", "skupaj", "znesek", "skupna vrednost", "skupaj z ddv",
    "znesek za plačilo", "končni znesek", "skupaj znesek", "amount",
    "total amount", "sum", "grand total", "end sum", "total price", "za plačilo",
  ];

  // Find last total line (to handle multiple totals)
  const totalLine = [...lines].reverse().find((l) =>
    totalKeywords.some((kw) => l.toLowerCase().includes(kw))
  );

  const totalMatch = totalLine?.match(
    /(\d{1,3}(?:[ ,.]?\d{3})*(?:[.,]\d{2})?)\s*(EUR|USD|\$|€)?/i
  );
  let total = null;
  if (totalMatch) {
    total = totalMatch[1].replace(/[\s,]/g, "").replace(",", ".");
    if (totalMatch[2]) total += " " + totalMatch[2].toUpperCase();
  }

  // Date regex for various date formats
  const dateRegex =
    /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/;
  const dateLine = lines.find((l) => dateRegex.test(l));
  const dateMatch = dateLine?.match(dateRegex);
  const date = dateMatch ? dateMatch[1] : null;

  // Keywords that indicate non-item lines (English + Slovenian)
  const excludeKeywords = [
    "transaction", "terminal", "id", "number", "purchase", "type", "response",
    "approval", "credit", "paid by", "card", "sub total", "subtotal", "tax", "total",
    // Slovenian terms
    "transakcija", "terminal", "številka", "nakup", "tip", "odgovor",
    "odobritev", "kredit", "plačano z", "kartica", "vrednost brez ddv", "ddv", "skupaj"
  ];

  // Extract items: filter out lines with non-item keywords
  const items = lines
    .filter(line => {
      const lower = line.toLowerCase();
      return !excludeKeywords.some(kw => lower.includes(kw));
    })
    .map(line => {
      // Match product name + price (price must have decimal digits)
      const match = line.match(
        /(.+?)\s+(\d{1,3}(?:[ ,.]?\d{3})*(?:[.,]\d{2}))\s*(EUR|USD|\$|€)?$/i
      );
      if (!match) return null;

      // Require reasonable product name length
      if (match[1].trim().length < 3) return null;

      const name = match[1].trim();
      let price = match[2].replace(/[\s,]/g, "").replace(",", ".");
      if (match[3]) price += " " + match[3].toUpperCase();

      return { name, price };
    })
    .filter(Boolean);

  return { date, total, items };
}
