export function parseReceipt(text) {
  // Helper: parse number string to float, handling European decimal commas
  function parseNumber(str) {
    // Remove spaces and thousands separators, replace comma decimal with dot
    const normalized = str.replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
    return parseFloat(normalized);
  }

  // Extract total using keyword-based filtering
  function extractTotal(lines) {
    const totalKeywords = [
      "total", "total amount", "grand total", "amount", "total price", "end sum", "sum", "za plačilo",
      "skupaj", "znesek", "skupna vrednost", "skupaj z ddv", "znesek za plačilo", "končni znesek"
    ];

    const currencyRegex = /(\d{1,3}(?:[.,\s]?\d{3})*[.,]\d{1,2})\s?(€|eur|usd|\$)?/gi;

    // Candidate lines with total-related keywords
    const candidateLines = lines.filter(line =>
      totalKeywords.some(kw => line.toLowerCase().includes(kw))
    );

    let candidates = [];

    for (const line of candidateLines) {
      let match;
      while ((match = currencyRegex.exec(line)) !== null) {
        const value = parseNumber(match[1]);
        if (!isNaN(value)) candidates.push(value);
      }
    }

    if (candidates.length > 0) {
      const maxTotal = Math.max(...candidates);
      return maxTotal.toFixed(2) + " €";
    }

    // Fallback: max value from whole text
    let allValues = [];
    for (const line of lines) {
      let match;
      while ((match = currencyRegex.exec(line)) !== null) {
        const value = parseNumber(match[1]);
        if (!isNaN(value)) allValues.push(value);
      }
    }
    if (allValues.length > 0) {
      const maxValue = Math.max(...allValues);
      return maxValue.toFixed(2) + " €";
    }

    return null;
  }

  // Convert date from formats like 15.07.25 or 15/07/2025 to ISO 2025-07-15
  function parseDate(str) {
    const dateRegex = /(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/;
    const match = str.match(dateRegex);
    if (!match) return null;

    let [_, d, m, y] = match;
    if (y.length === 2) y = '20' + y; // assume 2000s for 2-digit years

    // pad day and month
    d = d.padStart(2, '0');
    m = m.padStart(2, '0');

    return `${y}-${m}-${d}`;
  }

  // Clean item name by removing leading numeric codes and extra spaces
  function cleanItemName(name) {
    return name.replace(/^\d+\s*[-–—]?\s*/, '').trim();
  }

  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  // Extract date from any line that looks like a date
  let date = null;
  for (const line of lines) {
    const parsedDate = parseDate(line);
    if (parsedDate) {
      date = parsedDate;
      break;
    }
  }

  // Extract total from candidate lines or fallback
  const total = extractTotal(lines);

  // Keywords that indicate non-product lines for filtering items
  const excludeKeywords = [
    "transaction", "terminal", "id", "number", "purchase", "type", "response",
    "approval", "credit", "paid by", "card", "sub total", "subtotal", "tax", "vat", "sales tax",
    "transakcija", "terminal", "številka", "nakup", "tip", "odgovor",
    "odobritev", "kredit", "plačano z", "kartica", "vrednost brez ddv", "ddv", "skupaj"
  ];

  // Regex to find prices
  const priceRegex = /(\d{1,3}(?:[ ,.]?\d{3})*(?:[.,]\d{1,2}))\s?(€|eur|usd|\$)?/gi;

  const items = [];

  for (const line of lines) {
    // Skip lines containing total keywords or date
    if (line.toLowerCase().includes('total') || line.toLowerCase().includes('skupaj') || (date && line.includes(date))) {
      continue;
    }

    let match, lastMatch = null;
    while ((match = priceRegex.exec(line)) !== null) {
      lastMatch = match;
    }
    if (!lastMatch) continue;

    const priceIndex = lastMatch.index;
    let namePart = line.slice(0, priceIndex).trim();

    // Remove numeric codes like "2102120 — "
    namePart = cleanItemName(namePart);

    if (namePart.length < 2) continue;

    const hasExcludedKeyword = excludeKeywords.some(kw =>
      new RegExp(`\\b${kw}\\b`, "i").test(namePart)
    );
    if (hasExcludedKeyword) continue;

    let priceValue = parseNumber(lastMatch[1]);
    if (isNaN(priceValue)) continue;

    let price = priceValue.toFixed(2);
    if (lastMatch[2]) price += " " + lastMatch[2].toUpperCase();

    items.push({ name: namePart, price });
  }

  return { date, total, items };
}
