export function parseReceipt(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const totalKeywords = [
    "total", "skupaj", "znesek", "skupna vrednost", "skupaj z ddv",
    "znesek za plačilo", "končni znesek", "skupaj znesek", "amount",
    "total amount", "sum", "grand total", "end sum", "total price", "za plačilo",
  ];

  const totalLine = lines.find((l) =>
    totalKeywords.some((kw) => l.toLowerCase().includes(kw))
  );

  const totalMatch = totalLine?.match(
    /(\d{1,3}(?:[ ,.]?\d{3})*(?:[.,]\d{2})?)\s*(EUR|USD|\$|€)?/i
  );
  let total = totalMatch ? totalMatch[1].replace(/\s/g, "") : null;
  if (totalMatch?.[2]) total += " " + totalMatch[2].toUpperCase();

  const dateRegex =
    /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/;
  const dateLine = lines.find((l) => dateRegex.test(l));
  const dateMatch = dateLine?.match(dateRegex);
  const date = dateMatch ? dateMatch[1] : null;

  const items = lines
    .map((line) => {
      const match = line.match(
        /(.+?)\s+(\d{1,3}(?:[ ,.]?\d{3})*(?:[.,]\d{2})?)\s*(EUR|USD|\$|€)?$/i
      );
      if (!match) return null;
      let price = match[2].replace(/\s/g, "");
      if (match[3]) price += " " + match[3].toUpperCase();
      return { name: match[1].trim(), price };
    })
    .filter(Boolean);

  return { date, total, items };
}
