/**
 * Fuzzy item-name matching for strip-measured price corrections (v1.7.6).
 * Comparison is letters-only lowercase: OCR garbles digits inside names and
 * punctuation randomly ("TKS] FROLLINI 1KG" vs "EKSI FROLLINI 1KG",
 * "ČONULADNI" vs "CORULADNI"). Match = containment of the shorter string or
 * LCS ≥ 65% of the longer one (ČONULADNI/CORULADNI ≈ 0.75; distinct SI item
 * names fall well below that).
 */
export function namesSimilar(candidate, itemName) {
  const lettersOf = (s) => (s.toLowerCase().match(/[a-zčšžćđ]/g) || []).join("");
  const a = lettersOf(candidate);
  const b = lettersOf(itemName);
  if (a.length < 4 || b.length < 4) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] / Math.max(m, n) >= 0.65;
}

export function parseReceipt(text, extraItems = [], corrections = []) {
  const PARSER_VERSION = "v1.6.9";
  // Set window.__OCR_DEBUG = true to restore verbose parser diagnostics.
  const DEBUG = typeof window !== "undefined" && window.__OCR_DEBUG === true;
  const log = (...args) => { if (DEBUG) console.log(...args); };
  log("Receipt parser version:", PARSER_VERSION);

  /** Normalize amount string for parseFloat, handling Slovenian or non-Slovenian formats */
  function normalizeAmount(value, isSlovenian) {
    if (isSlovenian) {
      if (value.includes(",")) {
        return value.replace(/\./g, "").replace(",", ".");
      } else {
        const dotCount = (value.match(/\./g) || []).length;
        return dotCount <= 1 ? value : value.replace(/\./g, "");
      }
    } else {
      // If no dot is present, the comma is the decimal separator (e.g. "2,10" -> 2.10).
      // Only strip commas as thousands separators when a dot anchor exists ("1,234.56").
      if (!value.includes(".")) {
        return value.replace(",", ".");
      }
      return value.replace(/,/g, "");
    }
  }

  /** Regex to find the last amount and optional currency symbol in a line */
  function extractLastAmountWithCurrency(line) {
    // OCR wobble tolerance (EUROSPIN real case: the same photo read
    // "4,29" and "4, 29" across two app runs): the comma sometimes drifts
    // apart from the cents with a space. Rejoin `(\d), +(\d{2})` before
    // matching — comma REQUIRED, so "8 71"/"2 09" space-only splits stay out
    // (those are handled by repairTrailingIntAmount only at line end).
    const cleaned = line.replace(/(\d),\s{1,3}(\d{2})\b/g, "$1,$2");
    const regex = /(\d{1,3}(?:[ .,]\d{3})*(?:[.,]\d{1,2}))\s*(€|EUR|USD|\$)?/gi;
    let lastMatch = null, match;
    while ((match = regex.exec(cleaned)) !== null) lastMatch = match;
    return lastMatch; // null if none
  }

  /**
   * OCR often drops the decimal separator from the LAST amount of a row
   * (e.g. "... 1 2.14 0.33 181" where the real sum is 1.81). The amount regex
   * requires a decimal part, so an unrepaired line falls back to the previous
   * decimal amount — usually the discount column — being used as the price.
   * Only 3-digit candidates are repaired: 4+ digits are too ambiguous
   * (the trailing digit can be barcode-strip noise bleeding in, e.g. "1198" = 1.19).
   */
  function repairTrailingIntAmount(line) {
    const m = line.match(/^(.*\d[.,]\d{1,2})(\D*)\s+(\d{3})(\s*\D*)$/);
    if (!m) return line;
    return `${m[1]}${m[2]} ${m[3].slice(0, -2)}.${m[3].slice(-2)}${m[4]}`;
  }

  /**
   * The trailing repair above needs a decimal amount ALREADY present in the row
   * (SPAR's discount-column case). HOFER (browser EFT run, 2026-10) shows the
   * separator can vanish from the row's ONLY amount: "šumeče tablete 085 A"
   * where the real price is 0,85. Repair a standalone trailing 3-digit int —
   * but only when NO other decimal amount exists in the line, so multi-column
   * rows keep their normal path, and at most a 1-2 letter VAT code may trail it.
   */
  function repairStandaloneIntAmount(line) {
    if (/\d[.,]\d/.test(line)) return line;
    const m = line.match(/^(.*[a-zA-ZčšžČŠŽ].*?)\s+(\d{3})(\s+[a-zčšž]{1,2})?\s*$/i);
    if (!m) return line;
    return `${m[1]} ${m[2].slice(0, -2)}.${m[2].slice(-2)}${m[3] ?? ""}`;
  }

  /**
   * Extract total candidates by scanning lines with keyword TIERS:
   *   tier 3 = payable-total phrasing ("za plačilo", "amount due") — wins outright
   *   tier 2 = generic totals ("skupaj", "total")
   *   tier 1 = loose money wording ("znesek", "paid")
   * Within a tier, the LAST candidate in document order wins: a payable total
   * always comes AFTER pre-coupon subtotals on real receipts (SPAR: 57.35
   * subtotal before a 10% coupon, 51.61 payable). v1.6.x picked the HIGHEST
   * value, which only worked while OCR garbling hid the subtotal line.
   */
  function extractAllTotalCandidates(lines, isSlovenian) {
    // Slovenian keywords have ASCII twins: older OCR paths strip diacritics
    // ("PLACANO", "ZA PLACILO"), the v7 pipeline preserves them.
    const tiers = isSlovenian
      ? [
          { weight: 3, kws: ["za plačilo", "za placilo", "končni znesek", "koncni znesek"] },
          { weight: 2, kws: ["skupaj", "skupna vrednost"] },
          { weight: 1, kws: ["znesek", "plačano", "placano", "vsota"] },
        ]
      : [
          { weight: 3, kws: ["amount due", "grand total", "total due", "to pay"] },
          { weight: 2, kws: ["total", "amount"] },
          { weight: 1, kws: ["paid", "sum"] },
        ];

    // Payment markers: a card line with an amount equals the payable total
    // even when the "Skupaj" text above it is garbled or vanished (both real
    // receipts: SPAR "DAL MASTERCA EUR 51.61", Triglav "Kartica NW8YGL 216,10",
    // HOFER "Znesek-EFT EUR 4.73" / "HOFER CENA 4.73").
    // NOTE: gotovina/cash are deliberately NOT here — they are tender-side
    // amounts (cash handed over), which can exceed the payable when change is
    // given (EUROSPIN real case: "Gotovina EUR 13,00" vs "Za plačilo 4,29").
    const paymentKws = [/masterca/i, /maest[rc]o/i, /\bkartic[ao]\b/i, /\bvisa\b/i, /\beft\b/i, /h[o0]fer\s+cena/i];

    const keywords = tiers.flatMap((t) => t.kws);
    const candidates = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lower = line.toLowerCase();
      let weight = 0;
      for (const tier of tiers) {
        if (tier.kws.some((kw) => lower.includes(kw))) {
          weight = Math.max(weight, tier.weight);
        }
      }
      if (paymentKws.some((re) => re.test(line))) {
        weight = Math.max(weight, 3);
      }
      // Structural currency tag: a parenthesised (EUR)/(FUR)/(ER) remnant with a
      // colon and an amount is a totals line whose keyword garbled away
      // (EUROSPIN real case: "Poz ID (EUR): | 4,29" from "Skupaj (EUR): 4,29",
      // "na) (FUR): 4,29"). Weight 2 — same tier as "skupaj". Item names never
      // carry a parenthesised currency tag.
      if (weight === 0 && /\(\s*(?:EUR|FUR|ER)\s*\)\s*:?\s*[|:]?\s*\d/i.test(line)) {
        weight = 2;
      }
      if (weight === 0) continue;
      if (lower.includes("keine")) continue;

      let match = extractLastAmountWithCurrency(line);
      if (!match) {
        const nextLine = lines[i + 1];
        if (nextLine) {
          match = extractLastAmountWithCurrency(nextLine);
          if (match) {
            const raw = match[1];
            const curr = (match[2] || "€").toUpperCase();
            const val = parseFloat(normalizeAmount(raw, isSlovenian));
            if (!isNaN(val) && val > 0) {
              candidates.push({ line: line + " " + nextLine, value: val, currency: curr, weight, index: i });
              continue;
            }
          }
        }
      } else {
        const raw = match[1];
        const curr = (match[2] || "€").toUpperCase();
        const val = parseFloat(normalizeAmount(raw, isSlovenian));
        if (!isNaN(val) && val > 0) candidates.push({ line, value: val, currency: curr, weight, index: i });
      }
    }

    // Document order preserved; selection happens in pickTotalCandidate()
    return candidates;
  }

  /** Strongest keyword tier wins; inside a tier, the LATEST line wins. */
  function pickTotalCandidate(candidates) {
    if (!candidates.length) return null;
    return candidates.reduce((best, c) =>
      c.weight > best.weight || (c.weight === best.weight && c.index > best.index) ? c : best
    );
  }

  /** Tries fallback total extraction from VAT summary lines */
  function tryFallbackTotal(lines, isSlovenian) {
    let net = null, vat = null, currency = null;

    for (const line of lines) {
      const lower = line.toLowerCase();
      const match = extractLastAmountWithCurrency(line);
      if (!match) continue;

      const vatMatch = line.match(
        /c\s+\d{1,2},\d{1,2}\s*%\s+(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))\s+(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2}))/i
      );
      if (vatMatch) {
        net = parseFloat(normalizeAmount(vatMatch[1], isSlovenian));
        vat = parseFloat(normalizeAmount(vatMatch[2], isSlovenian));
        currency = match[2]?.toUpperCase() || currency;
        if (!isNaN(net) && !isNaN(vat)) {
          const total = parseFloat((net + vat).toFixed(2));
          log(`💡 Fallback from VAT summary: ${net} + ${vat} = ${total}`);
          return { value: total, currency };
        }
      }

      if (isSlovenian) {
        if (lower.includes("osnova za ddv") || lower.includes("brez ddv"))
          net = parseFloat(normalizeAmount(match[1], isSlovenian));
        if (lower.includes("skupaj ddv") || (lower.includes("ddv") && lower.includes("%")))
          vat = parseFloat(normalizeAmount(match[1], isSlovenian));
      } else {
        if (lower.includes("net"))
          net = parseFloat(normalizeAmount(match[1], isSlovenian));
        if (lower.includes("vat") || lower.includes("tax"))
          vat = parseFloat(normalizeAmount(match[1], isSlovenian));
      }
    }

    if (net !== null && vat !== null) {
      return { value: parseFloat((net + vat).toFixed(2)), currency };
    }
    return null;
  }

  /** Extract ISO-format date (YYYY-MM-DD) from lines if any */
  function extractDate(lines) {
    // Array of regexes to match multiple date formats including dot+space and space-separated numeric
    const dateRegexes = [
      // Matches dates like "07. 07. 2025" or "11.06.2025" with optional spaces after dots
      /\b(0?[1-9]|[12][0-9]|3[01])\.\s*(0?[1-9]|1[0-2])\.\s*(\d{4})\b/,

      // NEW: Matches space-separated numeric dates like "25 8 2024"
      /\b(0?[1-9]|[12][0-9]|3[01])\s+(0?[1-9]|1[0-2])\s+(\d{4})\b/,
          /\b(0?[1-9]|[12][0-9]|3[01])\s*[.,]\s*(0?[1-9]|1[0-2])\s*[.,]\s*(\d{4})\b/,
    ];

    for (const line of lines) {
      for (const regex of dateRegexes) {
        const match = line.match(regex);
        if (match) {
          let day = parseInt(match[1], 10);
          let month = parseInt(match[2], 10);
          let year = parseInt(match[3], 10);
          return (
            year.toString().padStart(4, "0") +
            "-" +
            month.toString().padStart(2, "0") +
            "-" +
            day.toString().padStart(2, "0")
          );
        }
      }
    }
    return null;
  }

  /** Checks whether to exclude a line by matching keywords as whole words */
  function shouldExcludeLine(line, excludeKeywords) {
    return excludeKeywords.some((kw) => new RegExp(`\\b${kw}\\b`, "i").test(line));
  }

  /** Date/time pattern to exclude lines that look like metadata with times (e.g., "25.08. 2024 ob 13:17:09") */
  const dateTimePattern = /\b\d{1,2}\.\s*\d{1,2}\.\s*\d{2,4}\b\s*ob\s*\d{1,2}:\d{2}(:\d{2})?/i;

  /** Main body of parseReceipt **/
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const joinedText = lines.join(" ").toLowerCase();
  const isSlovenian = [
    "račun",
    "kupec",
    "ddv",
    "znesek",
    "ponudba",
    "skupaj",
    "za plačilo",
    "plačano",
  ].some((kw) => joinedText.includes(kw));

  // Refined exclude keywords (avoid overly generic small words)
  const excludeKeywords = isSlovenian
    ? [
        "številka",
        "transakcija",
        "ddv",
        "datum",
        "račun",
        "osnovni kapital",
        "bruto",
        "ponudbe",
        "rekapitulacija",
        "osnova",
        "veljavnost ponudbe",
        "keine",
        "telefonska",
        "telefon",
        "stran",
        "ljubljana",
        "p.p.",
      ]
    : [
        "transaction",
        "terminal",
        "subtotal",
        "tax",
        "vat",
        "invoice",
        "date",
        "validity",
      ];

  const nonItemPatterns = [
    /^plačano/i,
    /^c\s+\d{1,2},\d{1,2}\s*%\s+[\d\s.,]+—?\s*[\d\s.,]+/i,
    /^[a-zA-Z]\s*\d{1,2}[,.]\d{1,2}%\s+\d+[,.]\d+\s+\d+[,.]\d+/i,
    /^dov:/i,
    /^bl:/i,
    /^eor[: ]/i,
    /^zol[: ]/i,
    /^spar plus/i,
    /s.?upaj/i,
    /zvesto[bnh]e/i,
    /masterca/i,
    // Tender-side lines (EUROSPIN real case): "Gotovina EUR 13,00" garbles as
    // "otovina"/"stovina"/"Jt ovina" (all retain "ovina") — cash HANDED OVER,
    // never an item; "Vrnjen denar EUR 8,71" keeps "denar" intact even garbled
    // ("rnjen denar") — change given back, never an item. "Vračilo" = same role.
    /ovin/i,
    // "FUR" = garbled "EUR" (EUROSPIN real case: "s - 3 FUR 13,0" — the
    // Gotovina line with its currency mangled into a name-like token).
    /\bfur\b/i,
    // Asterisk-row separator garbles (EUROSPIN real case: "***…" read as
    // "F336 36 36.30.30 96 36 …"): ≥5 single-space-delimited pure digit runs.
    // Real multi-column item rows separate columns with 2+ spaces, so they
    // can't match; "MLEKO ALPSKO 3,5%"-style items have no digit runs at all.
    /(?:\s|^)\d+(?:\s\d+){4,}(?:\s|$)/,
    /\bdenar\b/i,
    /vra[čc]il[ao]/i,
    /\bcash\b/i,
    // VAT recap rows (HOFER real case: "Ca ok Neto 2,6900V 0,25" and
    // "B 22,0% Neto 1,47 …" — the DDV rekapitulacija with "Neto" surviving
    // OCR; a "Neto" token never appears in real item names on SI receipts).
    /\bneto\b/i,
    // Trailing 4+ digit run = terminal/EFT echo bleed, never a real item row
    // (HOFER real case: "ACH HEE i BER 5.0 41501" — the ghost "41501" made
    // the parser manufacture a 5,00 item from the line's "5.0" fragment).
    // SPAR multi-column rows always END in a VAT code letter ("… 1.92 B"),
    // so a bare digit tail is machinery, not merchandise.
    /\s\d{4,}\s*$/,
    // Garbled VAT-code / summary fragments (EUROSPIN real case: "kd, 0% ? 4,29"
    // and "mat (ER): 4,29" from "Skupaj (EUR):"). Anchored short rate-code at
    // line start (or stray parenthesised currency remnant + colon), so real
    // items ("MLEKO ALPSKO 3,5%", "REZINA ... 17% DT ...") can't match.
    /^[a-z]{1,2},?\s*\d{1,2}(?:[.,]\d{1,2})?\s*%/i,
    /\(e?u?r?\)\s*:/i,
    // Standalone EUR token = currency remnant, not a product name (EUROSPIN
    // real case: "mov “ EUR 13,00" — the Gotovina line with its word ground
    // down to noise keeps the currency fragment on its own token).
    /\bEUR\b/i,
    /\b[a-e0-9]:/i,
    /=\s*\d/,
    /\d{1,2}[.,]\s{0,2}\d{1,2}[.,]\s{0,2}20\d{2}/,
    /mat\.št/i,
    /osn\.kapital/i,
    /popust/i,
    /dopla[cč]il/i,
    /discount/i,
    /splošni pogoji/i,
    /vaše današnje ugodnosti/i,
    /točke zvestobe/i,
    /številka naročila/i,
    /datum naročila/i,
    /datum računa/i,
    /skupaj eur/i,
    /^kartica/i,
    /^date[: ]?/i,
    /^znesek\s*—?\s*\d+[,.]/i,
    /^a\s+\d{1,2}[,.]\d+\s+\d+[,.]/i,
    /^[a-z]?\s*\d{1,2}[,.]\d+\s+\d+[,.]/i,
    /^,?\d{1,3}[,.]\d{2}\s*—?\s*\d{1,3}[,.]\d{2}/,
    /^obračunsko obdobje/i,
    /^vsi zneski so v/i,
  ];

  // Detect total candidates from lines
  const totalCandidates = extractAllTotalCandidates(lines, isSlovenian);
  const pickedCandidate = pickTotalCandidate(totalCandidates);
  let total = pickedCandidate ? pickedCandidate.value : null;
  let totalSource = null;
  if (total != null) totalSource = "keyword";
  let currency = (pickedCandidate?.currency) ?? "€";

  // Attempt fallback total from VAT net+vat summary
  const fallbackTotal = tryFallbackTotal(lines, isSlovenian);
  if (fallbackTotal) {
    const delta = total ? Math.abs(fallbackTotal.value - total) : 0;
    const useFallback = !total || delta <= 0.05 || fallbackTotal.value > total;
    if (useFallback) {
      log(`✅ Using fallback total: ${fallbackTotal.value} > main: ${total}`);
      total = fallbackTotal.value;
      totalSource = "vat";
      currency = fallbackTotal.currency ?? currency;
    } else {
      log(`⚠️ Ignoring fallback: ${fallbackTotal.value} vs main: ${total}`);
    }
  }

  const date = extractDate(lines);
  const items = [];
  // v1.6.9: optionally pre-seeded items recovered by the OCR layer's adaptive
  // top-strip re-OCR (processImage injects them here so checks[] run over the
  // complete item set). Each carries `via: "strip-retry"` for provenance.
  for (const extra of extraItems) {
    log(`  Injecting strip-recovered item: ${extra.name} ${extra.price}`);
    items.push(extra);
  }

  // Parse items with support for Spar multi-column format and fallback generic parsing
  for (const line of lines) {
    log(`Checking line: "${line}"`);

    // Skip lines with date/time metadata pattern
    if (dateTimePattern.test(line)) {
      log("  Skipping due to date/time metadata pattern.");
      continue;
    }

    if (shouldExcludeLine(line, excludeKeywords)) {
      log("  Skipping due to exclude keyword (whole word match).");
      continue;
    }

    if (nonItemPatterns.some((pat) => pat.test(line))) {
      log("  Skipping due to non-item pattern.");
      continue;
    }

    // v1.7.6 garble-row rule (EUROSPIN real case): a barcode/dot-matrix row
    // above the items ("s Me VO: 550 AZ RR ENRRRA EE HE TEE E66 330 3.3 KRE")
    // mangles into a storm of 1-3-letter tokens BETWEEN its digit fragments,
    // and its trailing "3.3" became a phantom 3.30 item, breaking the
    // items-sum check. The storm is counted strictly BETWEEN the first and
    // last digit-bearing tokens: SPAR multi-column scans keep 1-3-letter
    // bleed tokens at the line EDGES ("A ČEBULA … 0.95 B Lj -", "SB SIR …
    // 1.69 B i )") whose core is clean, and those rows must survive (an
    // earlier whole-line variant was reverted for exactly that). Junk row
    // middle = {AZ,RR,EE,HE,TEE} = 5; every fixture item row reads ≤1.
    {
      const toks = line.trim().split(/\s+/);
      let a = 0;
      let b = toks.length - 1;
      while (a < toks.length && !/\d/.test(toks[a])) a++;
      while (b >= 0 && !/\d/.test(toks[b])) b--;
      let shortMid = 0;
      for (let t = a + 1; t < b; t++) {
        if (/^[a-zA-ZčšžČŠŽ]{1,3}$/.test(toks[t])) shortMid++;
      }
      if (shortMid >= 3) {
        log(`  Skipping garbled non-item row (${shortMid} short letter tokens between digit fragments)`);
        continue;
      }
    }

    if (totalCandidates.some((tc) => tc.line === line)) {
      log("  Skipping line matching total candidate.");
      continue;
    }

    if (/rekapitulacija|osnova za ddv|skupaj ddv/i.test(line)) {
      log("  Skipping VAT summary or similar.");
      continue;
    }

    // Spar multi-column detection heuristic: >=10 parts split by several spaces/tabs
    const parts = line.split(/\s{2,}|\t/).filter((p) => p.trim() !== "");

    if (parts.length >= 10) {
      const quantityRaw = parts[0];
      const articleCode = parts[1];
      const nameTokens = parts.slice(2, parts.length - 7);
      const name = nameTokens.join(" ") || parts[2];

      const orderedQtyRaw = parts[parts.length - 7];
      const deliveredQtyRaw = parts[parts.length - 6];
      const unit = parts[parts.length - 5];
      const priceGrossRaw = parts[parts.length - 4];
      const discountRaw = parts[parts.length - 3];
      const priceNetRaw = parts[parts.length - 2];
      const vatCode = parts[parts.length - 1];

      const priceNum = parseFloat(normalizeAmount(priceNetRaw, isSlovenian));
      if (isNaN(priceNum) || priceNum <= 0) {
        log("  Skipping Spar item line due to invalid net price.");
        continue;
      }

      let quantityNum = parseFloat(normalizeAmount(deliveredQtyRaw, isSlovenian));
      if (isNaN(quantityNum)) {
        quantityNum = parseFloat(normalizeAmount(orderedQtyRaw, isSlovenian));
      }
      if (isNaN(quantityNum)) quantityNum = undefined;

      if (!name || name.length < 3) {
        log("  Skipping Spar item line due to short or empty name.");
        continue;
      }

      log(
        `  Detected Spar item: name="${name}", price=${priceNum.toFixed(
          2
        )} ${currency}, quantity=${quantityNum ?? "N/A"}`
      );

      items.push({
        name: name.trim(),
        price: `${priceNum.toFixed(2)} ${currency}`,
        quantity: quantityNum,
      });
      continue;
    }

    // Fallback generic parsing: extract last amount
    let amountMatch = extractLastAmountWithCurrency(repairTrailingIntAmount(line));
    if (!amountMatch) {
      const repaired = repairStandaloneIntAmount(line);
      if (repaired !== line) {
        log(`  Applying standalone 3-digit repair: "${line}" -> "${repaired}"`);
        amountMatch = extractLastAmountWithCurrency(repaired);
      }
    }
    if (!amountMatch) {
      log("  Skipping due to no valid amount found in line.");
      continue;
    }

    const rawAmount = amountMatch[1];
    const detectedCurrency = (amountMatch[2] || currency).toUpperCase();

    const priceStr = rawAmount;
    const priceNorm = normalizeAmount(priceStr.replace(/[^\d,.\-]/g, ""), isSlovenian);
        const price = parseFloat(priceNorm);

    if (isNaN(price) || price <= 0) {
      log(`  Skipping due to invalid price: "${priceStr}" parsed as ${price}`);
      continue;
    }

    if (price > 10000) {
      log(`  Skipping due to implausible large price: ${price.toFixed(2)}`);
      continue;
    }

    const descEndIndex = amountMatch.index;
    let description = line.slice(0, descEndIndex).trim();

    if (!description || description.length < 3 || !/[a-zA-Zčšž]/i.test(description)) {
      log(`  Skipping due to invalid description: "${description}"`);
      continue;
    }

    // Garble guard: a plausible product name carries ≥3 letters (EUROSPIN real
    // browser run: "se ? 0,37" — a stray VAT fragment). Trade-off: brands whose
    // name is essentially letters-free/symbol-heavy ("H&M") would drop too;
    // SI grocery receipts rarely print such names.
    const letterCount = (description.match(/[a-zA-ZčšžČŠŽ]/g) || []).length;
    if (letterCount < 3) {
      log(`  Skipping: name has only ${letterCount} letters ("${description}")`);
      continue;
    }

    // Clean the description: strip trailing bare-number tokens (receipt column
    // leftovers — qty/cena/popust that end up inside the name) and leading OCR
    // edge junk (punctuation-only or lone-letter tokens). Tokens containing
    // letters or a % sign ("600G", "3,5%", "L10/1") are kept as part of the name.
    // Quantity = last stripped integer below 100 (Količina column).
    let quantityNum = undefined;
    const plainNum = /^\d{1,4}(?:[.,]\d{1,3})?$/;
    const descTokens = description.split(/\s+/);
    const stripped = [];
    while (descTokens.length > 1) {
      const t = descTokens[descTokens.length - 1];
      if (plainNum.test(t)) stripped.unshift(descTokens.pop());
      else break;
    }
    for (const t of stripped) {
      const v = parseFloat(t.replace(",", "."));
      if (!isNaN(v) && v > 0 && v < 100 && Number.isInteger(v)) quantityNum = v;
    }
    while (descTokens.length > 1) {
      const t = descTokens[0];
      if (!/\w/.test(t) || t.length === 1) descTokens.shift();
      else break;
    }
    description = descTokens.join(" ");
    if (!description || description.length < 3 || !/[a-z]/i.test(description)) {
      log(`  Skipping: name reduced to junk after cleanup ("${description}")`);
      continue;
    }

    log(
      `  Detected item: name="${description}", price=${price.toFixed(
        2
      )} ${detectedCurrency}, quantity=${quantityNum ?? "N/A"}`
    );

    items.push({
      name: description.trim(),
      price: `${price.toFixed(2)} ${detectedCurrency}`,
      quantity: quantityNum,
    });
  }

  // Last-resort total was REMOVED (v1.6.2): an items-sum fallback existed here
  // briefly and got reverted on live evidence — a garbled browser run of the
  // EUROSPIN receipt turned 5 OCR-garbage lines into items and the fallback
  // summed them into a confident wrong "62.67". A sum of unverified items must
  // never masquerade as a total; "Not found" keeps the review workflow honest.

  // Arithmetic cross-checks — flags for the review workflow, never overrides
  // anything. Evidence base:
  //  - EUROSPIN: OCR read FROLLINI 1,95 where the paper likely says 1,55 ->
  //    itemsSum 4,69 vs total 4,29 flags it (mismatch)
  //  - EUROSPIN tender: Gotovina 13,00 - Vrnjen denar 8,71 = 4,29 = payable
  //    (independent confirmation of the total when all three survive OCR)
  //  - SPAR: coupon -5,74 makes itemsSum != total legitimately -> mismatches
  //    are [?] flags with a discount hint, never errors, totals never touched
  function parseAmount(prefix, s) {
    const v = parseFloat((s || "").split(" ")[0].replace(",", "."));
    return isNaN(v) ? null : v;
  }

  const checks = [];
  const tenderLine = lines.find((l) => /\bovin|\bdenar|gotovin/i.test(l));
  const changeLine = lines.find((l) => /\bdenar\b|vra[čc]il/i.test(l));

  // v1.7.6: strip-measured price corrections. ocrUtils measures candidate
  // items from a band re-OCR and hands them over; matching happens HERE (one
  // source of truth) against already-parsed items: fuzzy name match + a
  // different measured price + STRICT ARITHMETIC IMPROVEMENT of the
  // items-sum check. The improvement guard is not decoration: live eurospin
  // evidence — a band strip garbled ČOKOLADNI's 1,45 as "1.49" while
  // FROLLINI's row lost its price entirely ("zvo\""); the strip can misread
  // any price, so a correction is accepted only when it moves items closer
  // to the total (1.55 for FROLLINI: sum 4.69 -> 4.29 exact). Matching
  // nothing / equal price / worsening = no change (honest).
  const parseTotalVal = total == null
    ? null
    : (typeof total === "number" ? total : parseAmount("total", total));
  const itemsSum = () => items.reduce((acc, it) => acc + (parseAmount("item", it.price) ?? 0), 0);
  for (const corr of corrections) {
    const idx = items.findIndex(
      (it) => it.via !== "strip-retry" && it.via !== "strip-corrected" && namesSimilar(corr.name, it.name)
    );
    if (idx < 0) {
      log(`  Correction candidate "${corr.name}" matched no item — dropped`);
      continue;
    }
    const oldPrice = parseAmount("item", items[idx].price);
    if (oldPrice != null && Math.abs(oldPrice - corr.price) <= 0.02) {
      log(`  Correction candidate "${corr.name}" equals existing price — no change`);
      continue;
    }
    const prevPrice = items[idx].price;
    if (parseTotalVal == null || oldPrice == null) {
      log(`  Correction candidate "${corr.name}" has no total/price anchor — dropped`);
      continue;
    }
    const distBefore = Math.abs(itemsSum() - parseTotalVal);
    items[idx].price = `${corr.price.toFixed(2)} €`;
    const distAfter = Math.abs(itemsSum() - parseTotalVal);
    if (distAfter >= distBefore - 1e-9) {
      items[idx].price = prevPrice;
      log(`  Correction candidate "${corr.name}" ${oldPrice.toFixed(2)} -> ${corr.price.toFixed(2)} rejected: sum ${
        distAfter.toFixed(2)} not closer to total ${parseTotalVal.toFixed(2)} than ${distBefore.toFixed(2)}`);
      continue;
    }
    log(`  Correcting "${items[idx].name}" ${prevPrice} -> ${corr.price.toFixed(2)} € (OCR measured)`);
    checks.push({
      ok: false,
      text: `price corrected by band re-OCR: "${items[idx].name}" ${prevPrice} -> ${corr.price.toFixed(2)} € (OCR measured "${corr.name}") — verify against photo [?]`,
    });
    items[idx].via = "strip-corrected";
  }

  if (total != null && items.length) {
    const itemSum = items.reduce((acc, it) => acc + (parseAmount("item", it.price) ?? 0), 0);
    if (itemSum > 0) {
      const delta = Math.abs(itemSum - total);
      checks.push(
        delta <= 0.011
          ? { ok: true, text: `items sum = total (${itemSum.toFixed(2)})` }
          : {
              ok: false,
              text: `items sum ${itemSum.toFixed(2)} ≠ total ${total.toFixed(2)} — verify a price [?] or a discount/missing item`,
            }
      );
      // VAT-recap "missing bucket" refinement (v1.6.9, HOFER real case): the
      // photo clipped the Krüger 1,79 row entirely, but the DDV recap survived
      // ("B 22,0% Neto 1,47 …"). Deriving each recap row's gross from rate ×
      // neto (NOT from the garbled DDV digit — "0,82" was misread for "0,32")
      // and matching it against the items-vs-total gap names the missing
      // amount with evidence instead of leaving a bare sum mismatch. Fires
      // only on an exact (±0.02) bucket match, so SPAR-coupon gaps (5,74) and
      // multi-row losses (2,64 = two clipped rows) never produce false hits.
      if (delta > 0.011) {
        const missing = total - itemSum;
        for (const recapRow of lines.filter((l) => /\bneto\b/i.test(l))) {
          const m = recapRow.match(/([a-e0-9])?\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*%\s*neto\s+(\d{1,3}(?:[.,]\d{1,4})?)/i);
          if (!m) continue;
          const rate = parseFloat(m[2].replace(",", "."));
          const neto = parseFloat(m[3].replace(",", "."));
          if (isNaN(rate) || isNaN(neto)) continue;
          const gross = parseFloat((neto * (1 + rate / 100)).toFixed(2));
          if (Math.abs(gross - missing) <= 0.02) {
            checks.push({
              ok: false,
              text: `VAT ${m[2]}% recap row implies a missing item ≈ ${gross.toFixed(2)} ${currency} (neto ${neto.toFixed(2)}) — row not captured by OCR`,
            });
          }
        }
      }
    }
  }

  if (total != null && tenderLine && changeLine && tenderLine !== changeLine) {
    const tendered = parseAmount("t", (extractLastAmountWithCurrency(tenderLine) ?? [])[1]);
    const change = parseAmount("c", (extractLastAmountWithCurrency(changeLine) ?? [])[1]);
    if (tendered != null && change != null && tendered > change) {
      const implied = parseFloat((tendered - change).toFixed(2));
      checks.push(
        Math.abs(implied - total) <= 0.011
          ? { ok: true, text: `tender ${tendered.toFixed(2)} − change ${change.toFixed(2)} = total ✓` }
          : { ok: false, text: `tender ${tendered.toFixed(2)} − change ${change.toFixed(2)} = ${implied.toFixed(2)} ≠ total ${total.toFixed(2)}` }
      );
    }
  }

  // v1.6.9: provenance note for strip-recovered items — the app must show
  // where the row came from so the user can spot-check it against the photo.
  for (const extra of extraItems) {
    checks.push({
      ok: false,
      text: `recovered by top-strip re-OCR: "${extra.name}" ${extra.price} — verify against photo [?]`,
    });
  }

  log(`Extracted date: ${date}`);
  log(`Detected total candidates: ${totalCandidates.length}`);
  log(`Final total: ${total ? total.toFixed(2) + " " + currency : null}`);
  log(`Total items detected: ${items.length}`);

  return {
    version: PARSER_VERSION,
    date,
    total: total ? `${total.toFixed(2)} ${currency}` : null,
    totalSource,
    checks,
    items,
  };
}