export function parseReceipt(text) {
  function normalizeAmount(value, isSlovenian) {
    return isSlovenian
      ? value.replace(/\./g, "").replace(",", ".")
      : value.replace(/,/g, "");
  }

  function extractAmountFromLine(line, isSlovenian) {
    const regex = /(\d{1,3}(?:[ .,\s]?\d{3})*(?:[.,]\d{1,2}))\s*(EUR|USD|\$|€)?/gi;
    let match, lastMatch = null;
    while ((match = regex.exec(line)) !== null) {
      lastMatch = match;
    }
    if (!lastMatch) return null;
    let amount = parseFloat(normalizeAmount(lastMatch[1], isSlovenian));
    return isNaN(amount) ? null : amount;
  }

  function extractAllTotalCandidates(lines, isSlovenian) {
    const totalKeywords = isSlovenian
      ? ["za plačilo", "skupaj", "znesek", "končni znesek", "skupno", "skupaj z ddv"]
      : ["total", "amount", "grand total", "to pay", "total due", "end sum"];

    return lines
      .filter(line =>
        totalKeywords.some(kw => line.toLowerCase().includes(kw))
      )
      .map(line => ({
        line,
        value: extractAmountFromLine(line, isSlovenian) ?? 0
      }))
      .filter(entry => entry.value > 0)
      .sort((a, b) => b.value - a.value); // sort by amount descending
  }

  function extractDate(lines) {
    const dateRegex = /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/;
    const match = lines.find(line => dateRegex.test(line))?.match(dateRegex);
    if (!match) return null;

    const raw = match[1];
    const parts = raw.split(/[./-]/).map(Number);

    if (parts[0] > 31) return raw; // already ISO or invalid

    let day, month, year;
    if (parts[2] < 100) parts[2] += 2000; // normalize 2-digit year
    if (parts[0] > 12) {
      [day, month, year] = parts;
    } else if (parts[1] > 12) {
      [month, day, year] = parts;
    } else {
      [day, month, year] = parts; // fallback
    }

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

  const excludeKeywords = isSlovenian
    ? ["transakcija", "številka", "ddv", "datum", "račun", "osnovni kapital"]
    : ["transaction", "terminal", "subtotal", "tax", "vat", "invoice", "date"];

  const totalCandidates = extractAllTotalCandidates(lines, isSlovenian);
  const total = totalCandidates.length > 0
    ? totalCandidates[0].value.toFixed(2) + " €"
    : null;

  const date = extractDate(lines);

  const items = [];

  for (const line of lines) {
    if (totalCandidates.some(t => t.line === line)) continue;

    const priceMatch = line.match(/(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/);
    if (!priceMatch) continue;

    const rawAmount = priceMatch[1];
    const price = normalizeAmount(rawAmount, isSlovenian);

    let namePart = line.slice(0, priceMatch.index).trim();
    namePart = namePart.replace(/^\d{5,}\s?[—\-–]?\s*/g, "").trim(); // remove leading codes like "2102120 —"

    if (namePart.length < 2) continue;

    const hasExcludedKeyword = excludeKeywords.some(kw =>
      new RegExp(`\\b${kw}\\b`, "i").test(namePart)
    );
    if (hasExcludedKeyword) continue;

    items.push({ name: namePart, price: `${parseFloat(price).toFixed(2)} €` });
  }

  return { date, total, items };
}
