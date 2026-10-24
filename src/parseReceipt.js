/**
 * Fuzzy item-name scoring for strip-measured price corrections (v1.7.6).
 * Comparison is letters-only lowercase: OCR garbles digits inside names and
 * punctuation randomly ("TKS] FROLLINI 1KG" vs "EKSI FROLLINI 1KG",
 * "ČONULADNI" vs "CORULADNI"). Return value in [0,1]:
 *   1.0  one string contains the other, OR both share a distinctive token
 *        (>=5 letters) — brand guess rows ("SPAR AJVAR POLPEK." vs
 *        "SPAR TRAJNO MLEKO" are 0.667 on plain LCS; the shared brand prefix
 *        must NOT pair them — live SPAR regression corrected the WRONG item).
 *   else LCS ratio of the full letter strings (ČONULADNI/CORULADNI = 0.75;
 *        threshold for namesSimilar).
 */
export function namesScore(candidate, itemName) {
  // diacritics normalize (č->c, š->s, ž->z): OCR mixes "ČOKOLADNI"/"CORULADNI"
  // freely and string equality must treat them as the same letter
  const norm = (s) => s.toLowerCase().replace(/[čć]/g, "c").replace(/š/g, "s").replace(/ž/g, "z").replace(/đ/g, "d");
  const lettersOf = (s) => (norm(s).match(/[a-z]/g) || []).join("");
  const a = lettersOf(candidate);
  const b = lettersOf(itemName);
  if (a.length < 4 || b.length < 4) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  const toksA = norm(candidate).match(/[a-z]{5,}/g) ?? [];
  const toksB = new Set(norm(itemName).match(/[a-z]{5,}/g) ?? []);
  if (toksA.some((t) => toksB.has(t))) return 1;
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
  return prev[n] / Math.max(m, n);
}

export function namesSimilar(candidate, itemName) {
  return namesScore(candidate, itemName) >= 0.75;
}

export function parseReceipt(text, extraItems = [], corrections = []) {
  const PARSER_VERSION = "v1.6.9";
  // Set window.__OCR_DEBUG = true to restore verbose parser diagnostics.
  // v2.0.2: when debugging is on, every log line is ALSO appended to
  // window.__OCR_LOG (buffer reset here — the app-level parse is the last
  // call of a scan, so its decisions are the ones the evidence panel shows).
  const DEBUG = typeof window !== "undefined" && window.__OCR_DEBUG === true;
  const logBuf = DEBUG && typeof window !== "undefined" ? (window.__OCR_LOG = []) : null;
  const log = (...args) => {
    if (!DEBUG) return;
    const line = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    console.log(...args);
    logBuf?.push(line);
  };
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
        // v2.0.21 (scan-eurospin real case, user run on deployed v2.0.20): a
        // garbled DDV-recap header ("Lj! Us ova Dr Skupaj" from "Davek Osnova
        // DDV Skupaj") carries the tier-2 "skupaj" keyword, and its VALUES row
        // below ("? 2% 9 r 4,20" — the printed 4,29 misread) then became the
        // picked total, outranking the printed "Skupaj (EUR): 4,29" ("naj
        // (EUR): 4,29") purely by document order. A value line carrying a
        // percent token is duty-recap machinery, never the payable. Strictly
        // scoped to the below-line fetch: keyword lines owning their amount
        // keep working ("Skupaj 4,29"; SPAR's "SKUPAJ DDV 1,40" false
        // candidate is handled by later-line precedence as before), and all
        // other tiers (za plačilo, payment markers) outrank this class anyway.
        if (nextLine && !/%/.test(nextLine)) {
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
    // HOFER-B real capture: every one of the anchors above was garbled away
    // by OCR ("ra-Id", "Zresek", "pla?ila", "BRON CS B 22,0% Neto…"), so the
    // parser fell into the ENGLISH tiers and misparsed the receipt. These
    // tokens are the ones that CAN survive garbling (they read clean in the
    // live run): "vsota" = the subtotal label itself, "vmesna" the same
    // line's first word, "izdel" = "3 Izdel(i)" summary prefix. Additive
    // only: no foreign receipt contains these words, and isSlovenian already
    // being true elsewhere makes them no-ops.
    "vsota",
    "vmesna",
    "izdel",
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
    // INTERSPORT program-discount row (real capture 2026-10-24, new phone
    // photo of the JAKNA receipt): "(30.0%) - ŠPORTNE ZVEZDE  -24,00" — OCR
    // drops the minus sign, so the -24,00 discount reaches the parser as a
    // positive 24,90 and manufactures a phantom item. Merchandise never opens
    // with a parenthesised percent; closing paren not required (OCR noise).
    /^\s*\(\s*\d{1,2}(?:[.,]\d{1,2})?\s*%/,
    // "ZA PLAČILO" section header (same capture): the ruled separator
    // OCR-fused into "ZAPLACILO eee _ 56,99" — a second phantom (56.99 was
    // derived from the misread section header zone). "Plačilo" is payment
    // vocabulary ("PLAČILO: MASTERCARD"), never product text.
    /zapla[čc]ilo/i,
    /\bpla[čc]ilo\b/i,
    // Phone-number line (INTERSPORT second re-photo 2026-10-24): "Tel: 00386
    // (0)51 285 125" — the standalone 3-digit repair turned the trailing
    // "125" into "1.25" and manufactured a phantom item. SI country-code and
    // "Tel:"-labelled lines are machinery; items never carry them.
    /^\s*te[ld]\b/i,
    /\b00[0 ]?386\b/,
    // Gratitude footer (phone HOFER real case): "HVALA ZA VAS NAKUP!" OCR-fused
    // with neighboring barcode digits ("HVALA Z 10,26 17. | SODNA" manufactured a
    // bogus 10,26 item whose involvement breaks the items-sum check). Always machinery.
    // Desktop variant reads the same footer as "S HVALA Z 10,26 17: | SODNA" —
    // the word match survives the extra garble token (v2.0.2, live decision log).
    /\bhvala\b/i,
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
    // v2.0.19 parenthesised rate-marker rows (INTERSPORT S25 real captures,
    // 2026-10-24, user's phone re-shots): the discount row prints
    // "(30,0%) - ŠPORTNE ZVEZDE -24,00" and OCR drops BOTH the minus sign and
    // its guard-word position, so the row manufactured a phantom +24.90/+24.00
    // item and poisoned the sum. An item row never STARTS with a
    // parenthesised rate percentage — that opening shape belongs to duty/
    // discount recap machinery. ("MLEKO ALPSKO 3,5%" starts with a word and
    // remains untouched by this anchor.)
    /^\(\s*\d{1,3}(?:[.,]\d{1,3})?\s*%/,
    /\(e?u?r?\)\s*:/i,
    // Standalone EUR token = currency remnant, not a product name (EUROSPIN
    // real case: "mov “ EUR 13,00" — the Gotovina line with its word ground
    // down to noise keeps the currency fragment on its own token).
    /\bEUR\b/i,
    /\b[a-e0-9]:/i,
    /=\s*\d/,
    // (matches "22.10.2026"-style rows even when OCR blurred a separator into
    // a space — INTERSPORT phone real case: "…1363170) 16.09 2029 Zav" fused
    // a date into the line and manufactured a bogus 16.09 item)
    /\d{1,2}[.,]\s{0,2}\d{1,2}(?:[.,]|\s){0,2}20\d{2}/,
    /mat\.št/i,
    /osn\.kapital/i,
    /popust/i,
    /dopla[cč]il/i,
    /discount/i,
    /splošni pogoji/i,
    /vaše današnje ugodnosti/i,
    /točke zvestobe/i,
    // "Vmesna vsota" = interim/subtotal label (HOFER-B real capture: OCR line
    // "Vmesna vsota 4,73" was the ONLY clean Slovenian token in the whole
    // garbled text, yet language detection failed on it and the line became
    // a phantom ITEM while the true total 4,73 stayed unfound). Dinner's
    // classifications: never an item; its amount IS the interim total and
    // already feeds pickTotal via the existing tier-1 "vsota" keyword.
    /vsota/,
    /v(?:m|n)esna/,
    /številka naročila/i,
    /datum naročila/i,
    /datum računa/i,
    /skupaj eur/i,
    /^kartica/i,
    /^date[: ]?/i,
    /^znesek\s*—?\s*\d+[,.]/i,
    // v2.0.19 EFT-echo family (HOFER hoferracun1 real case, user capture on
    // deployed v2.0.18): the EFT device echoes the payable back and OCR adds a
    // lead garble — "AR | Znesel-BFT ER: 1 - 4.73", "Zresek-BFT EUR 4.73",
    // "Znesek-EFT EUR 4.73". The start-anchored guard above misses these
    // because the echo label is no longer line-initial. Root: z+nes/res stem,
    // up to 8 OSB letters, optional separator, EFT/BFT. The echo amount is the
    // PAYABLE (feeding total candidates via payment markers), never an item.
    // "EFT Ref-No: …" never matches (no znes/res stem); its exclusion stays in
    // other rules.
    /\bz(?:nes|res)[a-z]{0,8}\s*[-–—|(]?\s*(?:[ef]ft|bft)\b/i,
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

  // v2.1 STRUCTURAL GUARD — merchandise precedes the payable total.
  // Any line BELOW the line that supplied the total is totals/tender/change/
  // loyalty/footer machinery, never an item. Keyword guards are not enough:
  // the payable line can garble past every one of them, and the garble shape
  // depends on the pixels, so it changes with the resampler and per browser —
  //   canvas upscale      "na) (FUR): 4,29"   (caught by the (EUR)/(FUR) rule)
  //   cv INTER_CUBIC      "p- Lall% 2 r 4.20" (no keyword left)
  //   cv INTER_LINEAR     "PLACILOMELR) 6.20" (keyword fused, no word boundary)
  // A positional rule does not care how the line garbles.
  // Scope guard: only active when the total sits past the first quarter of the
  // receipt, so an inverted layout (total printed above the items) can never be
  // silently emptied.
  const totalLineIndex =
    pickedCandidate && typeof pickedCandidate.index === "number" ? pickedCandidate.index : null;
  const postTotalGuardActive =
    totalLineIndex != null && totalLineIndex > Math.floor(lines.length * 0.25);

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

  // v2.0.13: INTERSPORT qty×price format. The receipt prints the item name
  // row and, UNDER it, a Količina × Cena Znesek row; two live readings of the
  // same block exist:
  //   phone-era fixture:  "=, 3849687 158° JAKNA W.poH SRIMFIELD 548" + "1 000 x 79,99 79.89 E"
  //   current geometry:   "6438496671565 JAKNA M POH BRIMFIELD $48" + "1,000 x 79.99 (999"
  // The name row's own price column is print-column garble ("548"/"$48" of the
  // true 79,99) — a bare-int repair turns it into a phantom 5,48 item, while
  // the MEASURED unit price only survives on the ×-row. Handle BOTH sides from
  // the ×-row: it claims its PREDECESSOR as the name donor. Donor conditions
  // (strict): passes the same guards the item loop applies, has a lettered
  // name, and carries NO decimal amount of its own (its price is suspect; a
  // cleanly priced line is never hijacked). The ×-row itself becomes the item;
  // the donor never produces a fallback item.
  const xRowByXLine = new Map();
  const donorLines = new Set();
  for (let xi = 1; xi < lines.length; xi++) {
    const xm = lines[xi].match(
      /^(\d+(?:[.,]\d{3})*(?:[ \u00A0]\d{3})*)\s*[x×]\s*(\d+[.,]\d{2}|\d+\.\d{3}[.,]\d{2})(?:\s+\d+[.,]\d{2})?/i
    );
    if (!xm) continue;
    const donor = lines[xi - 1];
    if ((donor.match(/[a-zA-ZčšžČŠŽ]{3,}/g) || []).length < 1) continue;
    if (/\d[.,]\d/.test(donor)) continue;
    if (
      dateTimePattern.test(donor) ||
      shouldExcludeLine(donor, excludeKeywords) ||
      nonItemPatterns.some((pat) => pat.test(donor))
    ) {
      log(`  ×-row "${lines[xi]}" has no valid donor (guards failed on "${donor}")`);
      continue;
    }
    const unit = parseFloat(xm[2].replace(",", "."));
    if (!(unit > 0 && unit <= 10000)) continue;
    // Quantity: "1,000" / "1 000" = one unit in a thousands grouping; a plain
    // small integer stores as-is; anything else stays undefined (honest N/A).
    let qty;
    const compact = xm[1].replace(/[ \u00A0]/g, "");
    const th = compact.match(/^(\d{1,3})[.,]\d{3}$/);
    if (th) qty = parseInt(th[1], 10);
    else if (/[ \u00A0]/.test(xm[1])) {
      const grp = compact.match(/^(\d{1,2})\d{3}$/);
      qty = grp ? parseInt(grp[1], 10) : undefined;
    } else {
      qty = parseInt(compact, 10);
      if (isNaN(qty)) qty = undefined;
    }
    if (qty !== undefined && (qty <= 0 || qty >= 100)) qty = undefined;
    // Name: strip leading figure/punctuation tokens (junk edge + SKU/qty
    // column bleed) and trailing figure tokens (the garbled price column).
    const nameToks = donor.trim().split(/\s+/).filter(Boolean);
    while (nameToks.length > 1 && /^[\d.,%°$€§=]{1,16}$/.test(nameToks[0])) nameToks.shift();
    while (
      nameToks.length > 1 &&
      // "š48"/"S48"/"$48" = OCR variants of the 5438496871585 SKU tail (the
      // 5's glyph degrades to š/s/$ on phone photos; new capture 2026-10-24).
      /^[$€šs§]?\d{1,3}[.,]?%?$/.test(nameToks[nameToks.length - 1])
    ) {
      nameToks.pop();
    }
    while (nameToks.length > 1 && /^[\d.,%°$€§]{1,16}$/.test(nameToks[0])) nameToks.shift();
    const name = nameToks.join(" ");
    if ((name.match(/[a-zA-ZčšžČŠŽ]/g) || []).length < 3) continue;
    donorLines.add(donor);
    if (!xRowByXLine.has(lines[xi])) xRowByXLine.set(lines[xi], { name, unit, qty, donor });
  }

  // Parse items with support for Spar multi-column format and fallback generic parsing
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    log(`Checking line: "${line}"`);

    // v2.0.13 ×-row (INTERSPORT): becomes the merged item straight from its
    // precomputed donor (the ×-row's own "name" side is figures-only, it
    // could never be a fallback item anyway).
    if (xRowByXLine.has(line)) {
      const xr = xRowByXLine.get(line);
      log(
        `  Detected item (qty×price row, donor "${xr.donor}"): name="${xr.name}", price=${xr.unit.toFixed(
          2
        )} ${currency}, quantity=${xr.qty ?? "N/A"}`
      );
      items.push({
        name: xr.name,
        price: `${xr.unit.toFixed(2)} ${currency}`,
        quantity: xr.qty,
      });
      continue;
    }

    if (donorLines.has(line)) {
      log("  Skipping donor line (merged with the qty×price row below).");
      continue;
    }

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

    // v2.1: below the payable total = tender / change / loyalty / footer. This
    // catches pay-zone lines whose keyword the OCR destroyed or fused.
    if (postTotalGuardActive && li > totalLineIndex) {
      log("  Skipping: line sits after the payable total — tender/footer machinery, never merchandise.");
      continue;
    }

    // v2.0.19 DDV-recap tail rule (HOFER EFT-tail real case, user capture on
    // deployed v2.0.18): the recap rows read "SOR seni of Ey Neto | 2,99 DOV
    // 0,25" and the line DIRECTLY BELOW a neto row is the recap's continuing
    // garble ("Se RI 5 Wal CARR A 3,94 IE odi …") whose trailing amount
    // manufactured a phantom item. Items never sit under a "Neto" row —
    // recap blocks are contiguous and precede the EFT appendix.
    if (li > 0 && /\bneto\b/i.test(lines[li - 1])) {
      log("  Skipping: line directly follows a DDV-recap (neto) row — machinery tail.");
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
  // v2.0.2: bare "otovin" added — the desktop EUROSPIN run read Gotovina as
  // "otovina EUR 13,00" (leading g eaten) and the tender check went silent;
  // the stemmed-complete \bovin / gotovin forms were not enough. False-positive
  // risk is bounded by the arithmetic: the check itself only passes when
  // tendered − change equals the total to the cent.
  const tenderLine = lines.find((l) => /\bovin|otovin|\bdenar|gotovin/i.test(l));
  const changeLine = lines.find((l) => /\bdenar\b|vra[čc]il/i.test(l));

  // v1.7.6: strip-measured price corrections. ocrUtils measures candidate
  // items from a band re-OCR and hands them over; matching happens HERE (one
  // source of truth) against already-parsed items. Guards, all
  // evidence-backed (v1.7.6 live eurospin + SPAR regression the same day):
  //  - DISCOUNT GATE (SPAR): a coupon/discount row legitimately explains an
  //    items-sum gap ("KUPON POPUST 10.00% od 57.35 -5.74", gap = 5.74).
  //    With a known discount in the text, corrections are ignored — the
  //    band cascade must not fire, and the [?] mismatch flag stays.
  //  - BEST NAME MATCH, no brand-prefix pairing: "SPAR AJVAR POLPEK." vs
  //    "SPAR TRAJNO MLEKO" scored 0.667 on plain LCS (shared SPAR prefix) and
  //    first-match findIndex paired a strip row with the WRONG item. Now a
  //    match needs a shared distinctive token (>=5 letters) or LCS >= 0.75,
  //    and the BEST-scoring item is chosen, not the first passing one.
  //  - STRICT ARITHMETIC IMPROVEMENT: a strip can garble any price (eurospin
  //    live: COKOLADNI 1,45 read as "1.49"), so a candidate only applies when
  //    it moves |items-sum - total| closer.
  //  - ALL-OR-NOTHING COMMIT: individually "improving" corrections can
  //    collectively claw toward a legitimately mismatched total (SPAR live:
  //    AJVAR 1.19 -> the 0.16 popust column read passed "improvement" while
  //    corrupting a correct row). Corrections survive only when the FINAL sum
  //    actually reaches the total (±0.02); otherwise every applied change is
  //    reverted and no provenance note is written.
  const parseTotalVal = total == null
    ? null
    : (typeof total === "number" ? total : parseAmount("total", total));
  const itemsSum = () => items.reduce((acc, it) => acc + (parseAmount("item", it.price) ?? 0), 0);
  const discountGate = /pop[ou]st|doplac/i.test(text);
  const applied = []; // { idx, prevPrice, prevVia, candName, newPrice }
  if (discountGate && corrections.length) {
    log(`  Discount/coupon line in text — ${corrections.length} correction candidate(s) ignored`);
  }
  if (!discountGate) {
    for (const corr of corrections) {
      let best = -1;
      let bestScore = 0;
      items.forEach((it, i) => {
        if (it.via === "strip-retry" || it.via === "strip-corrected") return;
        const s = namesScore(corr.name, it.name);
        if (s > bestScore + 1e-9) {
          bestScore = s;
          best = i;
        }
      });
      if (best < 0) {
        log(`  Correction candidate "${corr.name}" matched no item — dropped`);
        continue;
      }
      const oldPrice = parseAmount("item", items[best].price);
      if (oldPrice != null && Math.abs(oldPrice - corr.price) <= 0.02) {
        log(`  Correction candidate "${corr.name}" equals existing price — no change`);
        continue;
      }
      if (parseTotalVal == null || oldPrice == null) {
        log(`  Correction candidate "${corr.name}" has no total/price anchor — dropped`);
        continue;
      }
      const prevPrice = items[best].price;
      const prevVia = items[best].via;
      const distBefore = Math.abs(itemsSum() - parseTotalVal);
      items[best].price = `${corr.price.toFixed(2)} €`;
      const distAfter = Math.abs(itemsSum() - parseTotalVal);
      if (distAfter >= distBefore - 1e-9) {
        items[best].price = prevPrice;
        log(`  Correction candidate "${corr.name}" ${oldPrice.toFixed(2)} -> ${corr.price.toFixed(2)} rejected: sum ${
          distAfter.toFixed(2)} not closer to total ${parseTotalVal.toFixed(2)} than ${distBefore.toFixed(2)}`);
        continue;
      }
      log(`  Provisional correction: "${items[best].name}" ${prevPrice} -> ${corr.price.toFixed(2)} € (OCR measured)`);
      applied.push({ idx: best, prevPrice, prevVia, candName: corr.name, oldPrice, newPrice: corr.price });
      items[best].via = "strip-corrected";
    }
    // all-or-nothing commit
    const finalGap = parseTotalVal != null ? Math.abs(itemsSum() - parseTotalVal) : Infinity;
    if (applied.length && finalGap > 0.02) {
      for (let k = applied.length - 1; k >= 0; k--) {
        const a = applied[k];
        items[a.idx].price = a.prevPrice;
        items[a.idx].via = a.prevVia;
      }
      log(`  ${applied.length} correction(s) REVERTED: sum ${itemsSum().toFixed(2)} still ≠ total ${parseTotalVal.toFixed(2)} — gap is explained by something else (discount/missing row), not a proven price fix`);
      applied.length = 0;
    }
    for (const a of applied) {
      checks.push({
        ok: false,
        text: `price corrected by band re-OCR: "${items[a.idx].name}" ${a.prevPrice} -> ${a.newPrice.toFixed(2)} € (OCR measured "${a.candName}") — verify against photo [?]`,
      });
    }
  }

  if (total != null && items.length) {
    const itemSum = items.reduce((acc, it) => acc + (parseAmount("item", it.price) ?? 0), 0);
    if (itemSum > 0) {
      const delta = Math.abs(itemSum - total);
      // v2.0.16 discount reconciliation (INTERSPORT-phone real case, live
      // evidence: items 79.99, POPUST 24.00, ZA PLAČILO 55.99 all read clean,
      // yet the sum check flagged [?] because it never subtracted the
      // discount): when the text carries exactly ONE distinct discount amount
      // P and items − P closes on the total, the gap is EXPLAINED by a
      // printed line — green check names every measured number. No value is
      // invented (total and items stay as read); this is arithmetic BETWEEN
      // measured numbers, same class as the plain items-sum check. SPAR's
      // 3-number coupon line (10.00% / 57.35 / 5.74) stays ambiguous → red,
      // by design. Old INTERSPORT fixture (payable misread 59.99) does not
      // close (55.99 ≠ 59.99) → stays red.
      const pRe16 = discountAmounts(text, itemSum);
      const reconciled =
        delta > 0.011 &&
        pRe16.length === 1 &&
        Math.abs(itemSum - pRe16[0] - total) <= 0.011;
      if (reconciled) {
        checks.push({
          ok: true,
          text: `items ${itemSum.toFixed(2)} − POPUST ${pRe16[0].toFixed(2)} = total ${total.toFixed(2)} ✓ (discount line reconciles the sum)`,
        });
      } else {
        checks.push(
          delta <= 0.011
            ? { ok: true, text: `items sum = total (${itemSum.toFixed(2)})` }
            : {
                ok: false,
                text: `items sum ${itemSum.toFixed(2)} ≠ total ${total.toFixed(2)} — verify a price [?] or a discount/missing item`,
              }
        );
      }
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

  // v2.0.2: payable-vs-paid conflict check (INTERSPORT phone real case): the
  // printed "ZA PLAČILO 55,99" OCR-garbled into "59,99" while both the PAID
  // line ("PLAČANO. TASTERCARU 55,99") and the DDV recap (45,89 + 10,10)
  // carried the true payable. The tier system keeps the keyword total as-is;
  // a total that disagrees with the paid amount surfaces as a failing check —
  // genuinely ambiguous evidence, [?]-flagged, never silently overridden.
  const paidLine = lines.find((l) => /^(?:pla[čc]ano|placano)\b/i.test(l));
  if (paidLine && total != null) {
    const paid = parseAmount("t", (extractLastAmountWithCurrency(paidLine) ?? [])[1]);
    if (paid != null && Math.abs(paid - total) > 0.011) {
      checks.push({
        ok: false,
        text: `payable ${total.toFixed(2)} ≠ paid ${paid.toFixed(2)} — one of them is misread; verify against photo [?]`,
      });
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

/**
 * v2.0.16 shared discount-amount extraction: the DISTINCT amounts carried by
 * explicit discount-labelled lines (popust / kupon / doplačilo), capped below
 * the items sum. Used by the sum-check discount reconciliation and by
 * payableRescue; in both, ambiguity aborts (SPAR's
 * "KUPON POPUST 10.00% od 57.35 -5.74" carries three numbers and can never
 * reduce to one P).
 */
function discountAmounts(text, cap) { // exported below — used by ocrUtils for target derivation
  const pset = new Set();
  for (const ln of String(text).split(/\r?\n/)) {
    if (!/\b(?:pop[ou]st|kupon|dopla[cč]il)/i.test(ln)) continue;
    for (const am of ln.matchAll(/(\d{1,3}[.,]\d{2})/g)) {
      const val = parseFloat(am[1].replace(",", "."));
      if (val > 0 && val < cap) pset.add(+val.toFixed(2));
    }
  }
  return [...pset];
}
export { discountAmounts };

/**
 * v2.0.15 pay-zone payable rescue (INTERSPORT re-photo real case, 2026-10-24),
 * generalized in v2.0.18 (HOFER total-drift real case, user capture on
 * deployed v2.0.17, 2026-10-24): receipt printed 4,73, both first-pass
 * readings of the total zone read it 4,13 while ALL item rows read exact
 * (1.79 + 0.85 + 2.09 = 4.73) — sum flag "items 4.73 ≠ total 4.13" stayed red
 * because every existing rescue arm requires a POSITIVE missing-item gap.
 * v2.0.18 covers the "no discount, no missing rows, total misread downward"
 * story: the derived target is the items sum itself, and the value is still
 * only accepted when a MEASURED pay-zone re-OCR reading equals it (±0.02).
 * Same policy as v1.7.2/v2.0.15 throughout: arithmetic derives the target,
 * a measurement confirms it, nothing is invented. (v2.0.15 origin: the
 * receipt prints the payable 55,99 in three places — ZA PLAČILO, DDV recap,
 * PLAČANO MASTERCARD — and OCR misread the dotted-bold "55" glyph as "99" in
 * every zone across three increasingly good photographs.) This function
 * holds the decision logic, testable in Node; ocrUtils supplies the
 * measurement.
 *
 * Fire conditions (all strict):
 *  - a failing "items sum I ≠ total T" check exists,
 *  - NO "missing item ≈" VAT-recap bucket check exists (a lost-row story is
 *    the top-strip rescue's, not this one's),
 *  - discount-labelled lines carry: exactly ONE distinct amount P →
 *    D = I − P (v2.0.15 path), or NO discount markers at all → D = I
 *    (v2.0.18 path; ambiguity, e.g. SPAR's 3-number coupon, aborts),
 *  - the derived payable D disagrees with the picked total T,
 *  - `measured` (the pay-zone re-OCR reading) equals D ± 0.02.
 *
 * On fire: total becomes D, the old sum-mismatch check is REPLACED with an
 * ok:true provenance check naming every number involved (the photo's pay
 * lines were misread, that fact is preserved, never hidden).
 */
/**
 * v2.0.22 date-rescue decision helpers (pure, node-testable — the strip work
 * lives in ocrUtils.js/app.js, but ARM and ACCEPT rules are decisions, so
 * they sit beside payableRescue):
 *   findDateCandidate      — does ANY line look like a dot-fused date the
 *                            parser couldn't read (arm condition)?
 *   validDateFromReading   — does a strip re-OCR line contain a COMPLETE,
 *                            calendar-valid date (accept condition)?
 * Policy: never decompose an ambiguous digit run ("103.2025" → 1.03 / 10.3 /
 * 11.03 is a three-way coin flip). The printed date physically exists on the
 * paper, so when OCR garbles it we re-MEASURE the pixels (strip + zoom +
 * kernel diversity, same lesson as the pay arm) and accept only a clean,
 * valid reading. No valid reading → the field stays "—" (no evidence).
 */

/**
 * Arm: exactly one fused group.1..3 digits + 20xx-year via a single dot,
 * WITH a time anchor (HH:MM) on the same line — the HOFER-EFT appendix
 * shape ("a 103.2025 08:11" from "11.03.2025 08:11"). Two-dot date lines
 * ("18. 09. 2025") need NO candidate: extractDate already handles them;
 * the caller only arms when parse.date came back null.
 * Returns the candidate LINE (or null) — the arm decision (date==null) is
 * made by the caller on the parsed result.
 */
export function findDateCandidate(text) {
  if (typeof text !== "string") return null;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/\b\d{1,3}\s*\.\s*20\d{2}\b/.test(line) && /\b[0-2]?\d:[0-5]\d\b/.test(line)) return line;
  }
  return null;
}

/**
 * Accept: a COMPLETE dotted (dot or space separated) calendar date from a
 * strip re-OCR reading. Year must be 20xx (receipt era; also keeps junk
 * digit runs out). Calendar validity enforced (no 30.02). Returns ISO
 * "YYYY-MM-DD" or null — null is the normal outcome for a garbled reading,
 * the caller then simply has no measurement.
 */
export function validDateFromReading(rawLines) {
  const lines = Array.isArray(rawLines) ? rawLines : typeof rawLines === "string" ? String(rawLines).split("\n") : [];
  const regexes = [
    /\b(0?[1-9]|[12][0-9]|3[01])\s*\.\s*(0?[1-9]|1[0-2])\s*\.\s*(20\d{2})\b/,
    /\b(0?[1-9]|[12][0-9]|3[01])\s*[.,]\s*(0?[1-9]|1[0-2])\s*[.,]\s*(20\d{2})\b/,
    /\b(0?[1-9]|[12][0-9]|3[01])\s+(0?[1-9]|1[0-2])\s+(20\d{2})\b/,
  ];
  for (const raw of lines) {
    const line = String(raw);
    for (const re of regexes) {
      const m = line.match(re);
      if (!m) continue;
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      const year = parseInt(m[3], 10);
      const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
      if (day > dim) continue;
      return year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
    }
  }
  return null;
}

export function payableRescue(parse, text, measured) {
  if (!parse || !Array.isArray(parse.checks) || typeof text !== "string") return null;
  const sumCheck = parse.checks.find((c) => !c.ok && /^items sum ([\d.]+) ≠ total ([\d.]+)/.test(c.text));
  if (!sumCheck) return null;
  // v2.0.18: a VAT-recap "missing item ≈" bucket check means the evidence
  // says a row was lost — that is the top-strip item rescue's story. Blindly
  // pulling the total down to the (deficient) items sum here would silently
  // accept the loss.
  if (parse.checks.some((c) => /missing item ≈/.test(c.text))) return null;
  const m = sumCheck.text.match(/^items sum ([\d.]+) ≠ total ([\d.]+)/);
  const I = parseFloat(m[1]);
  const T = parseFloat(m[2]);
  if (!(I > 0) || !(T > 0)) return null;
  // P: explicit discount-labelled lines only; every distinct amount aborts.
  const parr = discountAmounts(text, I);
  let P = null;
  let D;
  if (parr.length === 1) {
    P = parr[0];
    D = +(I - P).toFixed(2);
  } else if (parr.length === 0 && !/\b(?:pop[ou]st|kupon|dopla[cč]il)/i.test(text)) {
    D = +I.toFixed(2); // v2.0.18: no discount story at all — target is the items sum
  } else {
    return null; // ambiguous discount amounts (SPAR coupon class)
  }
  if (!(D > 0)) return null;
  if (Math.abs(D - T) <= 0.02) return null; // total already consistent
  if (measured == null || Math.abs(measured - D) > 0.02) return null; // unmeasured arithmetic never fires
  const currency = (parse.total || "").split(" ")[1] || "€";
  const checks = parse.checks.slice();
  const idx = checks.indexOf(sumCheck);
  const provenance = P != null
    ? `matches items ${I.toFixed(2)} − POPUST ${P.toFixed(2)} (printed pay lines read ${T.toFixed(2)}, misread)`
    : `matches items sum ${I.toFixed(2)} (printed total read ${T.toFixed(2)}, misread; no discount line)`;
  checks.splice(idx, 1, {
    ok: true,
    text: `total ${D.toFixed(2)} verified: pay-zone re-OCR measured ${measured.toFixed(2)} — ${provenance}`,
  });
  if (typeof console !== "undefined" && console.log) {
    console.log("💰 payableRescue: total", T.toFixed(2), "->", D.toFixed(2), P != null
      ? "(items−POPUST, pay zone measured " + measured.toFixed(2) + ")"
      : "(items sum, pay zone measured " + measured.toFixed(2) + ")");
  }
  return {
    version: parse.version,
    date: parse.date,
    total: `${D.toFixed(2)} ${currency}`,
    totalSource: "pay-zone re-OCR verified against items − POPUST",
    checks,
    items: parse.items,
  };
}