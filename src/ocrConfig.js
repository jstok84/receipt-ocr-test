/**
 * OCR pipeline configuration — the single home for every tunable constant
 * (branch refactor/ocr-config, 2026-10-25; pure move, no value changed).
 *
 * WHY THIS FILE EXISTS
 * The pipeline's constants used to live inline at their point of use, which
 * made them hard to find, impossible to review as a set, and easy to change in
 * one place while a twin stayed stale. Industry practice for a measured
 * pipeline like this one: keep the values in one reviewed module, each with
 * the evidence that pinned it, and keep control flow in the code.
 *
 * WHAT BELONGS HERE (and what does not):
 *   IN  — thresholds, band/cascade parameters, kernel/resampler choices,
 *         worker parameters, and domain vocabulary (keyword and pattern
 *         tables). Things a maintainer TUNES after a measurement.
 *   OUT — regexes that encode receipt-format SHAPES (the ×-row matcher, the
 *         trailing-int repairs), loop arithmetic, debug-preview sizes, and
 *         layout assumptions (portrait strip, price-right column, pay zone
 *         at the bottom). Those are structure, not policy.
 *
 * CHANGE POLICY: every value here was measured against the live corpus
 * (samples/live, sweep records SWEEP-2026-10-24.md … -v2.0.29.md). After
 * changing anything, the acceptance gate is the full corpus sweep in Edge +
 * one other browser, verdicts compared against the last record. Do not
 * "clean up" a number without a measurement behind it.
 */

// ---------------------------------------------------------------------------
// Tesseract worker
// ---------------------------------------------------------------------------

/** Language pair: Slovenian receipts carry English brand/VAT tokens. */
export const TESSERACT_LANG = "slv+eng";
/** OEM 1 = LSTM only (the v4-era whitelist/engine-mode params are retired). */
export const TESSERACT_OEM = 1;

/**
 * Delivered through setParameters (the v4 recognize-options path never
 * applied them). user_defined_dpi fixes "Invalid resolution 0 dpi"
 * defaulting to 70; preserve_interword_spaces keeps SPAR-style
 * multi-column spacing alive. PSM 6 = uniform block of text.
 */
export const TESS_PARAMS = {
  tessedit_pageseg_mode: "6",
  preserve_interword_spaces: "1",
  user_defined_dpi: "300",
};

// ---------------------------------------------------------------------------
// Pipeline stage switches — defaults for preprocessWithOpenCV(options).
// Every stage is OFF unless measured helpful; the comments carry the receipt
// that decided it. Evidence runs override via window.__OCR_OPTS.
// ---------------------------------------------------------------------------

export const PIPELINE_DEFAULTS = {
  grayscale: true,
  deskew: true, // v2.0.5: text-line angle source (see TEXT_ANGLE below)
  perspectiveCorrection: true,
  unsharpMask: false, // measured harmful on receipt digits (benchmark2 D)
  smoothing: false,
  thresholding: false,
  adaptiveThresholding: false, // measured harmful: digital noise amplification
  morph: false,
  denoise: false,
  clahe: false, // measured CATASTROPHIC on thermal receipts: 24/26 -> 4/26 items, corrupts digits ("1.19" -> "149")
  invert: false, // measured: small accuracy loss (benchmark2 B)
  autoCrop: true, // v1.6.2 bright-mask receipt-region crop, run EARLY (before deskew); the old late dark-mask cropToContent cropped INTO the receipt on cluttered photos
  autoCropMode: "axis", // v2.0.9 "axis" (bbox cut) or "rotated" (text-aligned selection, no rotation)
  textAngleSign: "neg", // v2.0.5 EUROSPIN live A/B: the flattening angle is −T in this build; "pos" rotates text AWAY from horizontal
  contrastStretch: true, // v1.7 EUROSPIN (ocr-eurospin2): stretched read 3/3 item amounts, unstretched 0-2/3
};

/** Parameters of the OFF-by-default stages (kept for evidence A/B runs). */
export const STAGE_PARAMS = {
  unsharp: { blurKsize: 5, blurSigma: 1.5, alpha: 1.5, beta: -0.5 },
  smoothing: { d: 9, sigmaColor: 75, sigmaSpace: 75 },
  adaptive: { blockFrac: 0.05, cBright: 10, cDark: 5, meanSplit: 127 },
  denoise: { ksize: 3 },
  clahe: { clip: 2.0, tile: 8 },
  morph: { ksize: 3 },
};

// ---------------------------------------------------------------------------
// Geometry stages (crop, deskew, perspective, prescale, contrast)
// ---------------------------------------------------------------------------

/**
 * Text-line angle estimator (v2.0.4): Canny + Hough lines, near-horizontal
 * window, length-weighted mean. Replaced minAreaRect-on-biggest-blob, which
 * reported junk ~10° on a ~0° tilted receipt (live INTERSPORT evidence) and
 * rotated straight receipts the wrong way. Tight quartiles measured on the
 * real photo: original +0.9°, σIQR 1.5°.
 */
export const TEXT_ANGLE = {
  cannyLow: 60,
  cannyHigh: 150,
  houghRho: 1,
  houghThetaDeg: 180, // cv.HoughLinesP takes radians: Math.PI / 180
  houghThreshold: 60,
  houghMinLineLength: 60,
  houghMaxLineGap: 12,
  windowDeg: 20, // near-horizontal acceptance window
  minLineLength: 40,
  minLines: 12, // too few confident baselines -> don't rotate
};

/**
 * Receipt-region crop (v2.0.11 projection-profile cut + v2.0.11 ink-edge
 * second rule). Validated live: reproduces the user's manual crop on
 * EUROSPIN, ~no-op on INTERSPORT (full-frame paper). Fail-safe: no
 * qualifying band falls back to the contour bbox.
 */
export const CROP = {
  brightThreshold: 160, // absolute bright-fraction cutoff: paper columns score high, desk/keyboard rows ~0
  smoothFrac: 0.04, // moving-average window as a fraction of the frame (fold shadows must not split the band)
  smoothFloorPx: 11,
  bandFracX: 0.3, // columns admit 0.3 bright-fraction …
  bandFracY: 0.2, // … rows 0.2 (shadowed paper edges thread the bottom rows: probe 0.63-0.85 bright)
  fullFrameFrac: 0.98, // band covering >=98% of frame = scan-style bright background -> ink-edge rule
  inkThreshold: 128, // dark-pixel mask for the ink-edge rule
  ringFrac: 0.01, // outermost 1% ring ZEROED first (scan page borders are black LINES, not receipt ink)
  inkBandFrac: 0.02, // dark-fraction cutoff for ink bands
  sanityFrac: 0.25, // ink band must cover >=25% x 25% (user spec floor)
  inkMarginFrac: 0.10, // 10% margin around the ink band (user spec)
  profileMarginFrac: 0.02, // 2% margin around the bright profile band
  closeKernelPx: 15, // morphological closing bridges fold shadows that would split the paper blob
  contourBoxWFrac: 0.25, // fallback contour bbox sanity: width, height …
  contourBoxHFrac: 0.25,
  contourAreaFrac: 0.15, // … and area fractions of the frame
};

/**
 * Historical pre-scale: photos narrower than this used to be drawn 2x onto
 * the canvas before imread. The kernel must stay BILINEAR (Chromium's
 * default smoothing); INTER_CUBIC measurably changed OCR on the two
 * sub-1000px corpus photos (eurospin-cropped 5->2 items, spar-2024-12-14
 * 10->8).
 */
export const PRESCALE = { minWidthPx: 1000, factor: 2 };

/** Linear contrast stretch after crop (sharp.linear(1.6, -80) equivalent). */
export const CONTRAST = { alpha: 1.6, beta: -80 };

/** Deskew deadband: |text angle| <= this stays unrotated (v2.0.5). */
export const DESKEW_DEADBAND_DEG = 1.0;

/** approxPolyDP epsilon as a fraction of the contour perimeter. */
export const PERSPECTIVE_EPSILON_FRAC = 0.02;

/**
 * Final 2x upscale fed to Tesseract (INTER_CUBIC). Empirical on the real
 * SPAR photo (scripts/ocr-benchmark.mjs): 2x lifted item recognition from
 * 20/26 to 23/26 and produced clean decimal prices. Matches tesseract docs:
 * "the same image often gets much better results if you upscale before
 * recognize".
 */
export const TESSERACT_UPSCALE = { factor: 2 };

// ---------------------------------------------------------------------------
// Strip machinery (adaptive re-OCR of receipt bands)
// ---------------------------------------------------------------------------

/**
 * Defaults for the strip extractors. The original v1.7.2 HOFER rescue
 * values: the topmost item rows sit on the paper's fold/edge where 2x OCR
 * misreads prices; Node evidence (scripts/ocr-hofer-strip.mjs): re-OCRing
 * the top 25% at 3x reads the price straight off the pixels ("Kruger
 * sum.tablete 1,79 8"); 4x variants LOST the line, so 3x is the
 * empirically-validated factor. Every cascade below passes explicit values.
 */
export const STRIP_DEFAULT_BAND = [0, 0.25];
export const STRIP_DEFAULT_FACTOR = 3;
export const STRIP_DEFAULT_KERNEL = "catrom";

/** ITU-R BT.601 luma coefficients (raw-strip grayscale math). */
export const LUMA = { r: 0.299, g: 0.587, b: 0.114 };

/**
 * Ink thresholds inside the strip canvases. topStrip reads the PREPROCESSED
 * pixels (dark < 105 on the raw means); rawStrip reads its own contrast-
 * STRETCHED pixels, which saturate, so "ink" = stretched value under 75.
 */
export const STRIP_DARK_THRESHOLD = 105;
export const STRIP_INK_THRESHOLD = 75;

/** Column-trim margin (px) added on both sides of the located ink span. */
export const STRIP_COLUMN_MARGIN_PX = 15;

/**
 * Ink-column trim (v1.7.2 final + v2.0.29 wide-gap chain): the receipt
 * column is located by TEXT INK, not brightness (live-photo probe: the
 * whole top strip is bright-ish, means 165-220 everywhere incl.
 * background, while receipt text columns carry dark pixels). The ±20px
 * smoothing window and 50px gap-merge let sparse/faint ink (the folded
 * price!) survive. v2.0.29 (EUROSPIN-cropped live measurement): a
 * receipt's PRICE column is a SEPARATE ink run from its NAME column
 * (measured runs x[0..866] names, x[1007..1216] prices on a 1326px crop =
 * 141px gap), so runs now chain while their separation stays within a
 * quarter of the width and the widest chain's OUTERMOST bounds are kept.
 * Distant objects still form their own chain and lose.
 */
export const COLUMN_TRIM = {
  minWidthFraction: 0.15,
  maxGapPx: 50,
  smoothWindowPx: 20,
  minInk: 6,
  wideGapFrac: 0.25,
  slackLeftPx: 30,
  slackRightPx: 60,
};

/**
 * Progressive drawImage upscale in steps of at most this (Chrome's
 * drawImage degrades past ~2x — kernel isolation scripts/
 * ocr-hofer-kernel.mjs: nearest reads "br B" where lanczos/mitchell/cubic
 * read "1,79 8" on identical pixels).
 */
export const PROGRESSIVE_MAX_STEP = 2;

/**
 * Strip pixel budget. Live evidence (2026-10-24, s25-hofer sweep): a 3x
 * upscale of a 3000x4000 phone photo's top band is ~16.5 MP of table
 * texture and Tesseract PSM 6 ground 164 s on it. The validated
 * small-photo strips sit far under these bounds (hofer ~2.3 MP, eurospin
 * ~1.2 MP), so the budget only bites on phone-photo receipts — where it is
 * the difference between a 26 s scan and a 190 s one.
 */
export const STRIP_PIXEL_BUDGET = { maxWidthPx: 3000, maxArea: 9e6, minFactor: 0.5 };

/**
 * Resampler taps for the canvas-side Catmull-Rom / Lanczos3 kernels.
 * "catrom" (default, browser-validated): 4-tap Catmull-Rom. "lanczos3":
 * 6-tap windowed sinc, sum-normalized — a cascade DIVERSITY axis, not a
 * replacement: the kernel sweep (scripts/ocr-eurospin-kernel-sweep.mjs)
 * shows the two flip outcomes per band window (catrom reads 1,55 @35-75%,
 * lanczos3 reads it @40-75% where catrom loses the row).
 */
export const KERNEL_TAPS = { catrom: 4, lanczos3: 6 };

// ---------------------------------------------------------------------------
// Strip attempt cascades — [stripKind, band, factor, psm, kernel]
// stripKind: "prep" = preprocessed image, "raw" = source pixels.
// Order is evidence-ranked: the attempts that won on live receipts come
// first, and every cascade early-exits on its first measurement, so
// receipts that already resolve take the identical fast path.
// ---------------------------------------------------------------------------

/**
 * Missing-item hunt (v1.7.2 HOFER rescue + v2.0.29 item-band variants).
 * Full-frame strips garbled ("prv 7S"); ink-trim helped names but the
 * price needed PSM 4 (Node tesseract on the EXACT browser strip PNG read
 * "preo B" at PSM 6 but "1,798" at PSM 4 — the segmentation, not the
 * image, was the bottleneck). The 0.4-0.75 variants are the shape the
 * item-band correction cascade validated: tall-header receipts push their
 * first item rows to ~45% of the paper (EUROSPIN-cropped live: FROLLINI
 * at y-fraction 0.43-0.45), so every top band read only the logo block.
 */
export const MISSING_ITEM_ATTEMPTS = [
  ["raw", [0, 0.25], "6", 3],
  ["prep", [0, 0.25], "6", 3],
  ["prep", [0, 0.18], "6", 3],
  ["raw", [0, 0.25], "4", 3],
  ["prep", [0, 0.25], "4", 3],
  ["prep", [0.4, 0.75], "6", 2],
  ["prep", [0.4, 0.75], "4", 2],
  ["raw", [0.4, 0.75], "6", 2],
];

/**
 * Item-band price-correction cascade (v1.7.6 EUROSPIN real case: the
 * items-sum check fires with >=2 items and the damaged region is the ITEM
 * BLOCK itself; bench scripts/ocr-eurospin-strip.mjs, 42-72% at 2x PSM 6
 * re-read the block and MEASURED the true price). Kernel diversity included
 * per the kernel sweep lesson. Candidates are filtered by the parser's
 * name-match + arithmetic-improvement + all-or-nothing guards, so
 * over-collection is safe.
 */
export const ITEM_BAND_ATTEMPTS = [
  ["prep", [0.4, 0.75], 2, "6", "catrom"],
  ["prep", [0.4, 0.75], 2, "4", "catrom"],
  ["raw", [0.4, 0.75], 2, "6", "catrom"],
  ["prep", [0.32, 0.75], 3, "6", "catrom"],
  ["prep", [0.4, 0.75], 2, "6", "lanczos3"],
];

/**
 * Pay-zone payable rescue (v2.0.15 INTERSPORT re-photo real case,
 * generalized v2.0.18 HOFER total-drift: printed 4,73 read 4,13 while all
 * item rows read exact). The five proven attempts come first so
 * previously-winning receipts take the identical early-exit path; v2.0.20
 * appended kernel diversity, x3 zoom and PSM 7 single-line mode after
 * them.
 */
export const PAY_ZONE_ATTEMPTS = [
  ["prep", [0.55, 1.0], 2, "6", "catrom"],
  ["prep", [0.4, 0.75], 2, "6", "catrom"],
  ["raw", [0.55, 1.0], 2, "6", "catrom"],
  ["prep", [0.55, 1.0], 2, "4", "catrom"],
  ["prep", [0.75, 1.0], 2, "6", "catrom"],
  ["prep", [0.4, 0.75], 3, "6", "lanczos3"],
  ["prep", [0.4, 0.75], 2, "6", "lanczos3"],
  ["raw", [0.4, 0.75], 3, "6", "lanczos3"],
  ["prep", [0.5, 0.9], 3, "7", "catrom"],
  ["raw", [0.55, 1.0], 3, "7", "catrom"],
];

/**
 * Date rescue (v2.0.22): the printed date physically exists on the paper,
 * so an ambiguous garble ("103.2025") is re-MEASURED, never decomposed.
 * Arms only when the parse extracted NO date AND a fused date-candidate
 * line survives; accepts a COMPLETE calendar-valid reading, otherwise the
 * field stays "—".
 */
export const DATE_RESCUE_ATTEMPTS = [
  ["prep", [0.3, 0.75], 2, "6", "catrom"],
  ["prep", [0.3, 0.75], 3, "6", "lanczos3"],
  ["raw", [0.3, 0.75], 2, "6", "catrom"],
  ["prep", [0.25, 0.6], 3, "6", "lanczos3"],
  ["prep", [0.45, 0.9], 2, "6", "catrom"],
  ["prep", [0.3, 0.75], 3, "7", "catrom"],
  ["raw", [0.3, 0.75], 3, "7", "lanczos3"],
];

// ---------------------------------------------------------------------------
// Guards and tolerances (parser + rescue arms)
// ---------------------------------------------------------------------------

/**
 * The measurement tolerance (EUR). Every rescue accepts a strip reading
 * only when it equals the arithmetic target within this — arithmetic
 * derives the target, a measurement confirms it, nothing is invented.
 */
export const MEASURE_TOL = 0.02;
/** Sum-check / reconciliation tolerance (the checks' green band). */
export const SUM_TOL = 0.011;
/** Minimum items-vs-total gap that arms the strip hunt (noise floor). */
export const ARM_GAP = 0.004;
/** Fallback-total acceptance window (net+vat vs keyword total). */
export const FALLBACK_DELTA = 0.05;
/** Name-match threshold for strip-measured corrections (LCS ratio; see namesScore). */
export const NAME_MATCH_THRESHOLD = 0.75;
/** Minimum letters in a parsed item name (garble guard). */
export const MIN_NAME_LETTERS = 3;
/** Minimum letters in a strip-recovered row name (missing-item hunt). */
export const MIN_STRIP_NAME_LETTERS = 3;
/** Minimum letters in a correction candidate name (item-band cascade). */
export const MIN_CORRECTION_NAME_LETTERS = 4;
/** Implausible-price ceiling; above this a row is never an item. */
export const PRICE_MAX = 10000;
/** qty×price row unit-price ceiling (same plausibility class). */
export const XROW_UNIT_MAX = 10000;
/** Quantities at/above this are not quantities (column bleed). */
export const QTY_MAX = 100;
/** SPAR multi-column rows split into at least this many whitespace parts. */
export const SPAR_MIN_PARTS = 10;
/** Barcode garble rows: short letter tokens BETWEEN digit fragments. */
export const GARBLE_SHORT_TOKENS = 3;
/**
 * Post-total structural guard: lines below the payable total are
 * machinery. Active only when the total sits past this fraction of the
 * receipt, so an inverted layout (total above items) is never emptied.
 */
export const POST_TOTAL_GUARD_FRAC = 0.25;
/** Currency assumed when no line carries one (SI receipts). */
export const CURRENCY_DEFAULT = "€";

// ---------------------------------------------------------------------------
// Domain vocabulary — Slovenian (SI) receipt machinery words and patterns,
// plus their English twins for foreign receipts. Each entry cites the real
// capture that added it; the tests in tests/ are the regression net.
// ---------------------------------------------------------------------------

/**
 * Non-item line patterns. extraItems bypass every parser guard on
 * injection, so the strip hunts apply this same test before accepting a
 * hit (v2.0.29 machinery guard). Every entry earned its place on a real
 * garbled capture — see the per-pattern notes in git history (v1.6.x …
 * v2.0.29).
 */
export const NON_ITEM_PATTERNS = [
  /^plačano/i,
  /^c\s+\d{1,2},\d{1,2}\s*%\s+[\d\s.,]+—?\s*[\d\s.,]+/i,
  /^[a-zA-Z]\s*\d{1,2}[,.]\d{1,2}%\s+\d+[,.]\d+\s+\d+[,.]\d+/i,
  /^dov:/i,
  /^bl:/i,
  /^eor[: ]/i,
  /^zol[: ]/i,
  /^spar plus/i,
  /s.?upaj/i,
  // Croatian/Bosnian "total" (live SPAR HRVATSKA capture 2026-10-25): the
  // receipt prints "UKUPNO 34,64" as its total line, but Croatian text
  // carries NO Slovenian anchor, so the parse runs the EN tiers and the
  // line never becomes a total candidate — the item-side filter (which
  // skips only candidate lines) let the receipt's OWN TOTAL through as a
  // phantom item, inflating the items sum by exactly the total (true
  // merchandise 26.58 + phantom 34.64 = 61.22). Language-independent by
  // design: any total-keyword line is never merchandise, whatever the
  // tier selection did with it. The payable line ("PLAČANJE VISA 34,64")
  // still supplies the picked total via payment markers.
  /ukupno/i,
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
  // a phantom ITEM while the true total 4,73 stayed unfound). Never an item;
  // its amount IS the interim total and already feeds pickTotal via the
  // existing tier-1 "vsota" keyword.
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

/**
 * Total-keyword tiers. Within a tier the LAST candidate in document order
 * wins: a payable total always comes AFTER pre-coupon subtotals on real
 * receipts (SPAR: 57.35 subtotal before a 10% coupon, 51.61 payable).
 * Slovenian keywords have ASCII twins (older OCR paths strip diacritics).
 * NOTE: the tier set is selected by SLOVENIAN_ANCHORS — Croatian receipts
 * ("UKUPNO 34,64", no Slovenian anchor) parse with the EN tiers, so
 * language-independent item-side exclusions (NON_ITEM_PATTERNS) are what
 * keeps a Slavic total line out of the items list there.
 */
export const TOTAL_KEYWORD_TIERS = {
  SI: [
    { weight: 3, kws: ["za plačilo", "za placilo", "končni znesek", "koncni znesek"] },
    { weight: 2, kws: ["skupaj", "skupna vrednost"] },
    { weight: 1, kws: ["znesek", "plačano", "placano", "vsota"] },
  ],
  EN: [
    { weight: 3, kws: ["amount due", "grand total", "total due", "to pay"] },
    { weight: 2, kws: ["total", "amount"] },
    { weight: 1, kws: ["paid", "sum"] },
  ],
};

/**
 * Payment markers: a card line with an amount equals the payable total
 * even when the "Skupaj" text above it is garbled or vanished (SPAR
 * "DAL MASTERCA EUR 51.61", Triglav "Kartica NW8YGL 216,10", HOFER
 * "Znesek-EFT EUR 4.73"). gotovina/cash are deliberately NOT here — they
 * are tender-side amounts, which can exceed the payable when change is
 * given (EUROSPIN: "Gotovina EUR 13,00" vs "Za plačilo 4,29").
 */
export const PAYMENT_MARKERS = [/masterca/i, /maest[rc]o/i, /\bkartic[ao]\b/i, /\bvisa\b/i, /\beft\b/i, /h[o0]fer\s+cena/i];

/** Language-detection anchors (additive; no foreign receipt contains these). */
export const SLOVENIAN_ANCHORS = [
  "račun", "kupec", "ddv", "znesek", "ponudba", "skupaj", "za plačilo", "plačano",
  // HOFER-B real capture: every anchor above was garbled away ("ra-Id",
  // "Zresek", "pla?ila"), so the parser fell into the ENGLISH tiers and
  // misparsed the receipt. These tokens survive garbling.
  "vsota", "vmesna", "izdel",
];

/** Whole-word line exclusions (metadata vocabulary, not merchandise). */
export const EXCLUDE_KEYWORDS = {
  SI: [
    "številka", "transakcija", "ddv", "datum", "račun", "osnovni kapital",
    "bruto", "ponudbe", "rekapitulacija", "osnova", "veljavnost ponudbe",
    "keine", "telefonska", "telefon", "stran", "ljubljana", "p.p.",
  ],
  EN: ["transaction", "terminal", "subtotal", "tax", "vat", "invoice", "date", "validity"],
};

/**
 * Discount markers. Four deliberately similar variants survive from
 * different eras — DO NOT unify without re-running the corpus sweep:
 *   DISCOUNT_GATE_RE    correction-cascade gate (parseReceipt) — shortest stem
 *   DISCOUNT_ARM_RE     strip-hunt arming guard (ocrUtils) — widest set
 *   DISCOUNT_LABEL_RE   discount-amount extraction + payableRescue — word-bounded
 *   DISCOUNT_PRESENT_RE pay-arm presence test (ocrUtils) — label set, no \b
 */
export const DISCOUNT_GATE_RE = /pop[ou]st|doplac/i;
export const DISCOUNT_ARM_RE = /popust|kupon|discount|dopla[cč]il/i;
export const DISCOUNT_LABEL_RE = /\b(?:pop[ou]st|kupon|dopla[cč]il)/i;
export const DISCOUNT_PRESENT_RE = /pop[ou]st|kupon|dopla[cč]il/i;

/** Pay-zone vocabulary: a line carrying one of these is a payment/total zone line. */
export const PAY_ZONE_MARKERS = /pla[čc]ano|placano|za pla|zapla|master|osnova|davek|ddv|skupaj|vsota|znesek/i;

/** Tender-side line finders for the cash − change = total check. */
export const TENDER_LINE_RE = /\bovin|otovin|\bdenar|gotovin/i;
export const CHANGE_LINE_RE = /\bdenar\b|vra[čc]il/i;
/** "PLAČANO" line-start finder for the payable-vs-paid conflict check. */
export const PAID_LINE_RE = /^(?:pla[čc]ano|placano)\b/i;
/** DDV-recap row finder ("Neto" token; also the recap-tail structural guard). */
export const NETO_ROW_RE = /\bneto\b/i;

/**
 * Keyword-total line finder for the v2.0.19 total-keyword rescue path,
 * with its card/EFT exclusion (a card line is not a keyword total).
 */
export const KEYWORD_TOTAL_RE = /\b(?:vsota|skupaj|skupna vrednost|za pla[čc]ilo|za placilo|kon[čc]ni znesek|koncni znesek)\b/i;
export const CARD_MARKER_RE = /masterca|maest[rc]|kartic|visa|\beft\b|\bbft\b|h[o0]fer\s+cena/i;

/** Date formats. extractDate reads the parsed text; the rescue reads strip lines. */
export const DATE_REGEXES = [
  // "07. 07. 2025" or "11.06.2025" with optional spaces after dots
  /\b(0?[1-9]|[12][0-9]|3[01])\.\s*(0?[1-9]|1[0-2])\.\s*(\d{4})\b/,
  // space-separated numeric dates like "25 8 2024"
  /\b(0?[1-9]|[12][0-9]|3[01])\s+(0?[1-9]|1[0-2])\s+(\d{4})\b/,
  /\b(0?[1-9]|[12][0-9]|3[01])\s*[.,]\s*(0?[1-9]|1[0-2])\s*[.,]\s*(\d{4})\b/,
];
/** Rescue-side date reading: complete dotted dates, 20xx year (receipt era). */
export const DATE_RESCUE_REGEXES = [
  /\b(0?[1-9]|[12][0-9]|3[01])\s*\.\s*(0?[1-9]|1[0-2])\s*\.\s*(20\d{2})\b/,
  /\b(0?[1-9]|[12][0-9]|3[01])\s*[.,]\s*(0?[1-9]|1[0-2])\s*[.,]\s*(20\d{2})\b/,
  /\b(0?[1-9]|[12][0-9]|3[01])\s+(0?[1-9]|1[0-2])\s+(20\d{2})\b/,
];
/** Fused date-candidate arm: one dot-fused group + 20xx year … */
export const FUSED_DATE_RE = /\b\d{1,3}\s*\.\s*20\d{2}\b/;
/** … anchored by a time on the same line (the HOFER-EFT appendix shape). */
export const TIME_ANCHOR_RE = /\b[0-2]?\d:[0-5]\d\b/;
/** Date/time metadata line ("25.08. 2024 ob 13:17:09"). */
export const DATE_TIME_PATTERN = /\b\d{1,2}\.\s*\d{1,2}\.\s*\d{2,4}\b\s*ob\s*\d{1,2}:\d{2}(:\d{2})?/i;

/**
 * Amount with optional trailing currency. The numeric shape encodes the
 * locale policy (decimal comma, space/dot thousands grouping); the
 * currency set is domain vocabulary.
 */
export const AMOUNT_WITH_CURRENCY_RE = /(\d{1,3}(?:[ .,]\d{3})*(?:[.,]\d{1,2}))\s*(€|EUR|USD|\$)?/gi;
/** Bare money amount (strip readings, discount lines). */
export const MONEY_AMOUNT_RE = /\d{1,3}[.,]\d{1,2}/g;
/** Discount-line amount: exactly two decimals (the "-5,74" class). */
export const DISCOUNT_AMOUNT_RE = /(\d{1,3}[.,]\d{2})/g;
/**
 * OCR wobble tolerance (EUROSPIN real case: the same photo read "4,29"
 * and "4, 29" across two app runs): the comma sometimes drifts apart from
 * the cents with a space. Rejoin before matching — comma REQUIRED, so
 * "8 71"/"2 09" space-only splits stay out (repairTrailingIntAmount owns
 * those at line end).
 */
export const COMMA_DRIFT_RE = /(\d),\s{1,3}(\d{2})\b/g;
/** Structural currency tag: "(EUR): 4,29" remnant whose keyword garbled away. */
export const CURRENCY_TAG_RE = /\(\s*(?:EUR|FUR|ER)\s*\)\s*:?\s*[|:]?\s*\d/i;
