export function parseReceipt(text) {
  function parseNumber(numStr) {
    return parseFloat(
      numStr.replace(/\./g, "").replace(",", ".").replace(/\s/g, "")
    );
  }

  function extractDate(lines) {
    const dateRegex = /(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/;
    for (const line of lines) {
      const match = line.match(dateRegex);
      if (match) {
        let [ , dd, mm, yy ] = match;
        if (yy.length === 2) yy = +yy < 50 ? "20" + yy : "19" + yy;
        return `${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
      }
    }
    return null;
  }

  function extractTotal(lines) {
    const totalKeywords = [
      "total", "grand total", "amount", "skupaj", "znesek",
      "končni znesek", "za plačilo", "skupaj z ddv"
    ];
    const currencyRegex = /(\d{1,3}(?:[.,\s]?\d{3})*[.,]\d{1,2})\s?(€|eur|usd|\$)?/gi;

    let maxAmount = 0;
    let result = null;

    for (const line of lines) {
      const lower = line.toLowerCase();
      if (totalKeywords.some(k => lower.includes(k))) {
        let match;
        while ((match = currencyRegex.exec(line)) !== null) {
          const num = parseNumber(match[1]);
          if (num > maxAmount) {
            maxAmount = num;
            result = `${num.toFixed(2)} €`;
          }
        }
      }
    }
    return result;
  }

  function cleanItemName(name) {
    return name.replace(/^\d{5,}\s?[—\-–]\s?/g, "").trim();
  }

  const lines = text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  const date = extractDate(lines);
  const total = extractTotal(lines);

  const excludeKeywords = [
    "račun", "datum", "št", "številka", "ddv", "naslov", "kraj", "obveznost",
    "skupaj", "znesek", "kupec", "operater", "naročila", "številka naročila",
    "končni znesek", "spletna prodaja", "računa", "internet sales"
  ];

  const currencyRegex = /(\d{1,3}(?:[.,\s]?\d{3})*[.,]\d{1,2})\s?(€|eur|usd|\$)?/gi;

  const items = [];

  for (const line of lines) {
    if (excludeKeywords.some(kw => line.toLowerCase().includes(kw))) continue;

    let match, lastMatch = null;
    while ((match = currencyRegex.exec(line)) !== null) {
      lastMatch = match;
    }

    if (!lastMatch) continue;

    const price = parseNumber(lastMatch[1]).toFixed(2) + " €";
    const priceIndex = lastMatch.index;
    let name = cleanItemName(line.slice(0, priceIndex).trim());

    if (name.length < 3 || /^\d+$/.test(name)) continue;
    items.push({ name, price });
  }

  return { date, total, items };
}
