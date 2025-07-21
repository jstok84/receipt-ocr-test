export function parseReceipt(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim().replace(/\s{2,}/g, ' '))
    .filter(Boolean);

  // Remove duplicated lines like "1234 Main Street 1234 Main Street"
  const deduplicatedLines = lines.map(line => {
    const words = line.split(" ");
    const mid = Math.floor(words.length / 2);
    const firstHalf = words.slice(0, mid).join(" ");
    const secondHalf = words.slice(mid).join(" ");
    return firstHalf === secondHalf ? firstHalf : line;
  });

  // Language-aware total keywords
  const totalKeywords = [
    // English
    "total", "total amount", "grand total", "amount", "total price",
    // Slovenian
    "skupaj", "znesek", "znesek za plačilo", "skupna vrednost", "končni znesek", "skupaj z ddv"
  ];

  const taxKeywords = [
    "tax", "sales tax", "vat", "ddv"
  ];

  // Find the total line
  const totalLine = deduplicatedLines.find((l) =>
    totalKeywords.some((kw) => l.toLowerCase().includes(kw))
  );

  const totalMatch = totalLine?.match(
    /(\d{1,3}(?:[ .]?\d{3})*(?:[.,]\d{2}))\s*(€|eur|usd|\$)?/i
  );

  let total = totalMatch
    ? totalMatch[1].replace(/[ .]/g, "").replace(",", ".")
    : null;
  if (totalMatch?.[2]) total += " " + totalMatch[2].toUpperCase();

  // Extract VAT or Tax if present
  let tax: string | null = null;
  const taxLine = deduplicatedLines.find((l) =>
    taxKeywords.some((kw) => l.toLowerCase().includes(kw))
  );
  const taxMatch = taxLine?.match(
    /(\d{1,3}(?:[ .]?\d{3})*(?:[.,]\d{2}))/i
  );
  if (taxMatch) {
    tax = taxMatch[1].replace(/[ .]/g, "").replace(",", ".");
  }

  // Date support: DD.MM.YYYY, YYYY-MM-DD, etc.
  const dateRegex = /(\d{2}[./-]\d{2}[./-]\d{4}|\d{4}[./-]\d{2}[./-]\d{2})/;
  const dateMatch = deduplicatedLines.find(l => dateRegex.test(l))?.match(dateRegex);
  const date = dateMatch?.[1] ?? null;

  // Items: match product + price
  const itemRegex = /^(.+?)\s+(\d{1,3}(?:[ .]?\d{3})*(?:[.,]\d{2}))\s*(€|eur|\$|usd)?$/i;
  const items = deduplicatedLines
    .map(line => {
      const match = line.match(itemRegex);
      if (!match) return null;
      const name = match[1].trim();
      let price = match[2].replace(/[ .]/g, "").replace(",", ".");
      if (match[3]) price += " " + match[3].toUpperCase();
      return { name, price };
    })
    .filter(Boolean);

  // Metadata
  const metadata: Record<string, string> = {};
  for (const line of deduplicatedLines) {
    if (/Transaction ID[:\-]?\s*/i.test(line)) {
      metadata.transactionId = line.split(/Transaction ID[:\-]?\s*/i)[1]?.trim();
    }
    if (/Vendor ID[:\-]?\s*/i.test(line)) {
      metadata.vendorId = line.split(/Vendor ID[:\-]?\s*/i)[1]?.trim();
    }
    if (/Approval Code[:\-]?\s*/i.test(line)) {
      metadata.approvalCode = line.split(/Approval Code[:\-]?\s*/i)[1]?.trim();
    }
    if (/Paid By[:\-]?\s*/i.test(line)) {
      metadata.paymentMethod = line.split(/Paid By[:\-]?\s*/i)[1]?.trim();
    }
    if (/Card[:\-]?\s*/i.test(line)) {
      metadata.card = line.split(/Card[:\-]?\s*/i)[1]?.trim();
    }
  }

  return {
    date,
    total,
    tax,
    items,
    ...metadata
  };
}
