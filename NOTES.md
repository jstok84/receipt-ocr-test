# v2 — session state ledger

Last updated: 2026-10-20. Purpose: fresh sessions resume from here, not from chat memory.

## What this is

Client-side Slovenian receipt OCR (tesseract.js v7 + OpenCV.js stages + parser).
`v2/` is a self-contained standalone package: own deps, tests, build (Parcel → `v2/dist`).
Root (`../src`) is v1: untouched, remains the only GitHub Pages deploy. Parsers have
diverged deliberately — do not "sync" without the canonical-swap decision (see Debts).

## Current state (all verified by tests)

- Parser `src/parseReceipt.js` version v1.6.9 state: keyword-tier totals
  (za plačilo > skupaj > znesek, LAST wins per tier), payment markers
  (`masterca`, `maest/rco`, `karticao`, `visa`, `eft`, `hofer cena` — NOT `gotovina`/`cash`:
  tender-side, can exceed payable), structural currency-tag rule
  (`(EUR):/(FUR):/(ER): + amount` → weight-2 candidate), comma-drift rejoin
  (`(\d), +(\d{2})` → `4, 29` parses; comma REQUIRED — space-only splits stay out),
  arithmetic cross-checks
  (`checks[]`: items-sum vs total, tender−change vs total — flags only, app renders
  ✓ / `[?]` lines; SPAR coupon case respected), nonItem rules:
  `ovin` (gotovina garbles), `denar`, `vračilo`, `cash`, `EUR`-token, VAT-code
  anchors (`kd, 0%`), `(EUR):` fragments, popust/doplačil/discount, digit-storm
  separators, 3-letter name garble guard, 3-digit int repair (181→1.81),
  v1.6.8 additions (HOFER EFT browser run): standalone trailing 3-digit int
  repair (`šumeče tablete 085 A` → 0,85 — only lines with NO other decimal
  amount), `\bneto\b` nonItem (DDV recap rows), trailing-4+-digit-run nonItem
  (EFT echo, e.g. "ACH HEE i BER 5.0 41501" phantom 5,00 item).
  v1.6.9 addition (HOFER EFT run): VAT-recap "missing bucket" check — when
  items don't sum to total, recap rows (`<code%> neto <neto>`) derive gross =
  neto×(1+rate/100) — deliberately NOT from the (garbled) DDV digit — and an
  exact ±0.02 match with the items-vs-total gap adds an informative flag
  ("VAT 22,0% recap implies missing item ≈ 1,79 (neto 1,47) — row not
  captured"). No-fire guard proven: SPAR coupon gap 5,74 and two-row loss
  2,64 gain no hint.
- Pipeline `src/ocrUtils.js`: grayscale → **bright-mask receipt isolation**
  (Otsu + close 15×15 + largest-bright-region bbox + 2% margin + sanity guards,
  replaced broken fixed-240 dark-mask autoCrop) → **contrast stretch**
  (convertScaleAbs 1.6, −80) → deskew → perspective → 2× upscale → tesseract
  (`slv+eng`, PSM 6, DPI 300, preserve_interword_spaces). Plus **adaptive
  second pass** (v1.7.1): if the first parse has no total or no items, re-run
  OCR once with a fresh worker, keep the better parse (see experiment section).
   Plus **top-strip rescue** (v1.7.2): when the VAT-recap missing-bucket flag
   fires, re-OCR the top 25% strip - the fold/edge region the first item rows
   sit on - and accept a candidate item ONLY if its OCR-measured price matches
   the missing amount +/-0.02; `parseReceipt(text, extraItems)` takes the
   recovered row, re-runs all checks over the full item set, and adds a
   provenance `[?]` note. Evidence story: see "HOFER strip-rescue experiment".
- Tests: `npm test` in v2 → 42/42. Fixtures in `tests/fixtures/`:
  `spar-scan-real.txt`, `spar-scan-v2.txt`, `spar-scan-v3.txt`, `hofer-scan-real.txt`,
  `eurospin-scan-real.txt` (Node OCR of tight crop), `eurospin-browser-garble.txt`
  (uncropped browser run), `generic-si.txt` + others.

## Corpus status

| Receipt | Result |
|---|---|
| SPAR photo | 26/26 items, total ✓, date ✓ |
| HOFER photo | 3/3 items (v1.7.2 strip rescue: Krüger 1,79 measured by top-strip re-OCR), total 4,73 ✓, date ✓; EFT browser run (v1.6.8): šumeče 0,85 + `Neto`/trailing-digit echo rows filtered |
| Triglav PDF | text layer, full parse |
| EUROSPIN photo | 3/3 items, total 4,29 ✓, date ✗ (crease garbles "18."), 1 cosmetic junk item (*** separator row) |
  - Known OCR noise (`[?]`): EUROSPIN FROLLINI price read `1,95` vs likely real `1,55` (pixel 5→9).

## Reverted/known-negative — do not re-add without new evidence

- gotovina/cash as total or payment candidates (tender amounts, not payable)
- items-sum fallback total (produced confident wrong `62.67` on a garbled run)
- cash-minus-change arithmetic (change line misread 8,71→8,11 → wrong 4,89)
- CLAHE, adaptive threshold, unsharp, invert as always-on stages
- uppercase token-soup separator exclusion (ate real SPAR items)
- PSM 4 (tie on SPAR), `tessdata_best` langPath (no gain)

## Harness / environment notes

- git at `C:\Program Files\Git\bin\git.exe`, node at `C:\Program Files\nodejs\node.exe`
  — not on fresh-shell PATH; prefix `$env:Path = "C:\Program Files\nodejs;$env:Path"`.
- Node-only tesseract.js v7 core patch in place: `v2/node_modules/tesseract.js/src/
  worker-script/node/getCore.js` (backup `getCore.js.orig`) — relaxedsimd abort
  workaround; browser path unaffected.
- User's photos may be HEIF-in-.jpg-cloak (iPhone); browser decode relies on
  Windows codec luck — cheap hardening candidate: reject non-JPEG/PNG in input.
- OCR A/B benchmark harnesses: `scripts/ocr-benchmark*.mjs`, `ocr-hofer*.mjs`,
  `ocr-eurospin*.mjs` (Node + sharp; plot: full text → `samples/ocr-*.txt`).
- `samples/` is git-ignored: photos, traineddata cache, OCR dumps. Never commit
  personal receipts without explicit user decision.

## Browser OCR variance experiment (2026-10-20, `src/dev-bench.html`, untracked)

Question: is the reported app-side run-to-run wobble real engine nondeterminism?
Method: untracked bench page (git-ignored `src/dev-bench*`) runs the EXACT app
pipeline (preprocess → upscale → worker OCR → cleanAndMergeText) 5× per page load
on `samples/scan-eurospin.jpg`, diffs pairwise, and persists run 1 in localStorage
so the next page load (fresh worker) diffs cross-session. A second parcel instance
with two entries (`npx parcel src/index.html src/dev-bench.html --port 1235`) was
used; the sample photo came from a port-1236 static CORS server because parcel dev
SPA-fallbacks unknown asset paths. Results: **15/15 runs byte-identical across
3 fresh sessions** (same `4, 29`, same junk lines); the controlled environment is
fully deterministic, warm and cold.
User's observed drift therefore lives across their app sessions (different
browser instance/session state — unverified). Practical consequences:

1. Same-tab double-pass is useless (pass 2 = pass 1). The useful hedge is a
   **fresh-worker** re-run, kept only when the first parse is broken — shipped
   as v1.7.1 in `processImage` (triggers on no-total/no-items; verified: healthy
   EUROSPIN receipt stays single-pass ~5s, blank image triggers second pass,
   first kept on tie). Fresh-worker user-side value is plausible but unverified.
2. Parser already carries the drift defense: `4, 29` vs `4,29` is the same
   structural `(EUR):` candidate — comma-drift rejoin handles it.
3. Verified reconstruction (old parser pulled via `git show 613c3da`): v1.6.6
   parsed the clean line `Poz ID (EUR): | 4,29` → 4.29 fine. With the stray
   space (`4, 29`) it did NOT return null — it fell through and reported
   **13.00** (source: keyword, from the `otovina EUR 13,00` tender line) with
   checks flagging `items sum 4.69 ≠ 13.00`. So the only regression trigger
   was one space of engine wobble, and the old failure mode was a
   confidently-wrong total, not "not found". v1.6.7 rejoin fixes both reads.


## HOFER strip-rescue experiment (2026-10-20, leading to v1.7.2)

Question: the "Krüger šum.tablete 1,79 B" row was never outright invisible —
at the pipeline's 2x the price garbles ("rr 8" / "ro B") because the row sits
on the paper fold at the top edge. Chain of experiments (all on the real photo
`samples/hofer-scan.jpg`, Node = sharp+tesseract, browser = app pipeline):

1. Node strip bench (`scripts/ocr-hofer-strip.mjs`): top 25% of the receipt
   crop at 3x lanczos + PSM 6 reads the price MEASURED: "Kruger sum.tablete
   1,79 8". Deterministic across runs. 4x LOST the line (too zoomed for PSM 6).
2. First browser rescue attempt: not a copy-paste of 1 — full-frame strip
   (cropToReceipt sanity guard kept the whole 1280px frame) garbled again.
   Right idea wrong geometry. Added column trim.
3. Naive bright-column trim failed live: first/last-bright-column scan kept
   the full width (bright speckle at photo corners). Largest contiguous
   bright run failed too (run 426..1279 still included bright non-paper
   margin — price garbled again, "preo B").
4. In-page probe of the RAW photo top-240-rows: the whole strip is bright-ish
   (means 165-220 everywhere, NOT a dark-mat photo); the paper is identified
   by TEXT INK only (dark pixels x 490-1000). Ink-run (462..866) cut the faint
   folded price column off. Final selector: smoothed ink projection
   (+/-20px window, gap-merge 50px, must span >=15% width), margins -30/+60:
   live trim = 332..1073, matching the bench's manual 370..1050.
5. Even with the correct geometry the price still garbled in-browser
   ("preo B" / "rea B" at every PSM 6/7 attempt). Suspects eliminated:
   - perspective warp: not the cause (pre-perspective strip garbles too)
   - Chrome drawImage resampling: CONFIRMED fake lead after all — kernel
     isolation bench (`scripts/ocr-hofer-kernel.mjs`) on identical pixels:
     nearest "br B" vs lanczos3/mitchell/cubic "1,79 8", and Chrome's 3x
     drawImage behaves nearest-like; a pure-JS Catmull-Rom upscale was added,
     still garbled.
6. Decisive cross-check: downloaded the browser strip PNG (raw 0.25) and ran
   Node tesseract on THE SAME BYTES: PSM 6 "preo B" (identical to browser —
   deterministic parity confirmed), PSM 4 "1,798" (= 1,79 + VAT letter B
   misread as 8). The segmentation, not the image, was the bottleneck.
7. Final cascade in `topStripDataURL`/`rawStripDataURL` + rescue loop in
   `processImage`: attempts [raw/prep strip 0.25 PSM 6, prep 0.18 PSM 6,
   raw/prep 0.25 PSM 4]. PSM 4 attempt measures 1,79 -> item appended with
   `via: "strip-retry"` -> checks re-run: items sum = total (4.73) ✓ plus a
   provenance note ("recovered by top-strip re-OCR ... verify against photo").
   v1.7.5: the app ALSO renders a collapsed "Strip re-OCR evidence" panel -
   every cascade attempt's text + the winning strip image + the recovered
   line - so the user can see the price was MEASURED by OCR, not derived;
   recovered rows carry a mark in the items list.

Cost: rescue path only (~4 recognitions, seconds) runs when the missing-bucket
check already fired; healthy receipts pay nothing. The JS Catmull-Rom
upscale is kept (cheap, in-place) — unproven to be load-bearing; PSM 4 is.

pica postscript (v1.7.3 → reverted, v1.7.4): user suggested `pica` (true
lanczos3 in WASM). Wired in, tests green, live rescue unchanged (PSM 4 still
the rescuer; PSM 6 garbled even under pica lanczos3). REVERTED: pica probes
canvas pixels at startup (feature detection via `getImageData`) and crashed
with the user's browser fingerprinting protection ("cannot use getImageData
on canvas" + React error overlay). Standing constraint: NO startup canvas
pixel reads. v1.7.4 hardening: the strip resampler/trim/mask paths now fall
back to drawImage variants when pixel reads throw (guards on all three
`getImageData` call sites: bicubic upscale → drawImage upscale, raw-strip
transform → plain drawImage strip, column trim → untrimmed strip). Resampler
PSM-6 nuance stays unverified-noted above (crop 332..1073 vs bench 370..1050).

Lessons: (a) never trust "the row is unrecoverable" without testing a strip
re-OCR; (b) tesseract PSM choice dominates on garbled narrow strips — vary it
before touching preprocessing; (c) cross-check browser determinism by
shipping the exact browser pixels to Node (download the canvas PNG, Node
recognize) — catches config/segmentation differences that pixels can't.
## EUROSPIN band-rescue + garble-row rule (2026-10-20, v1.7.6)

User's live run (samples/scan-eurospin.jpg, 1200x1600) exposed two failures
at once; both fixed this version, both evidence-driven.

1. **Phantom 3.30 item from the dot-matrix separator row.** The barcode-ish
   row above the items printed a decimal-lookalike fragment ("s Me VO: 550
   AZ RR ENRRRA EE HE TEE E66 330 3.3 KRE" where "3.3" became a 3.30 item and
   broke the items-sum check). Fix: garble-row nonItem rule - count 1-3
   letter-only tokens STRICTLY BETWEEN the first and last digit-bearing
   tokens of a line; >= 3 = nonItem (junk middle = {AZ,RR,EE,HE,TEE}).
   Whole-line variants DO NOT WORK: SPAR multi-column scans carry edge-bleed
   tokens ("A CEBULA ... 0.95 B Lj -", "SB SIR ... 1.69 B i )") and a
   whole-line cap-soup rule was already reverted once for eating them
   (eurospin.test.js pins both). Verified live + fixture
   eurospin-browser-junk-header.txt.
2. **FROLLINI 1,95 misread is NOT permanent.** Node strip bench
   (scripts/ocr-eurospin-strip.mjs) over the items REGION found the item
   block sits ~45-62% down the paper (tall header - a TOP strip reads
   nothing). Band 42-72% at 2x + PSM 6 MEASURES the true price
   ("EKSI FROLLINI 1KG 1,55 A"); 3x lost the row. So: strips became BANDS
   (	opStripDataURL/awStripDataURL(dataURL, band=[from,to], factor)
   - HOFER top-cascade unchanged in behavior: [0,0.25] etc.) and a second
   rescue trigger fires on the items-sum [?] check with >= 2 items: a
   4-attempt band cascade (prep 0.40-0.75 2x PSM6/PSM4, raw 0.40-0.75 2x
   PSM6, prep 0.32-0.75 3x PSM6) collects correction CANDIDATES
   {name, price, attempt}.
3. **Corrections apply only on strict arithmetic improvement**
   (parseReceipt(text, extraItems, corrections), namesSimilar = letters-only
   containment or LCS >= 0.65). Live-evidence lesson from the first E2E: an
   attempt garbled COKOLADNI's 1,45 as "1.49" while FROLLINI's row lost its
   price ("zvo") - "differs" alone would have made the receipt WORSE. The
   parser accepts a correction only when it moves |items-sum - total| closer
   (1.55: 4.69 \u2192 4.29 exact; 1.49 rejected). ocrUtils verifies candidates by
   re-parsing and only passes applied ones to the app (candidate-name regex
   must allow the closing paren: OCR measured \"(.+?)\"\)? -).
   Same-price / no-name-match / worsening candidates are dropped, never
   fabricated.
4. E2E verified (browser): eurospin upload ends with junk row gone, FROLLINI
   1.55 via "strip-corrected" (marked \ud83d\udd01 band re-OCR), check
   "\u2713 items sum = total (4.29)" + [?] provenance note + evidence panel;
   HOFER upload unchanged (missing 1.79 via top strip, 4.73 ok). Tests 52/52.

## Kernel question: custom lanczos as primary? (2026-10-20, after v1.7.6)

User asked whether a custom Lanczos resampler could replace the Catmull-Rom
one as the primary OCR preprocessing. Checked against evidence, twice:

- Legality: a pure-JS lanczos carries no fingerprinting-protection risk
  (only on-demand pixel reads, same as the existing guarded ones) - the pica
  rejection was specifically pica's IMPORT-TIME getImageData probe.
- Custom JS lanczos3 + browser-exact catrom weights were ported to Node and
  run on IDENTICAL eurospin band pixels (scripts/ocr-eurospin-kernel.mjs,
  then -kernel-sweep.mjs over 4 band windows, PSM 6, 2x): NO kernel wins
  consistently. lanczos3 reads FROLLINI 1,55 clean at 40-75% where catrom
  loses the row; catrom reads it at 35-75% where lanczos3 does not; sharp's
  lanczos3 itself flips 1,55 (at 42-72%) into 1,854 (at 40-75%). The price
  digits are fragile on this dot-matrix paper and the kernel+band+PSM combo
  decides each cell - no primary kernel is justified by data (and a primary
  swap would churn the 52 green fixtures for it).
- Adopted instead: ONE extra band-cascade attempt (prep 0.40-0.75 2x PSM6
  LANCZOS, attempt 5 of 5). bicubicUpscaleGrayCanvas grew a mode param
  ("catrom" default = numerically identical to v1.7.5 behavior for the
  HOFER path; "lanczos3" = 6-tap normalized windowed sinc). Cost: 1 extra
  OCR pass, only on already-broken (sum-mismatch) parses. Verified live:
  eurospin recovers (FROLLINI 1.55, sum 4.29 ok, evidence panel shows all
  5 attempts), HOFER rescue unchanged (1.79 via top strip, 4.73 ok).

## SPAR coupon regression + hardening (2026-10-20, v1.7.6 fix)

The v1.7.6 band-rescue fired on a SPAR coupon receipt (user live run,
fixture spar-coupon-browser.txt): items sum EXACTLY the gross 57.35, total
51.61 via "KUPON POPUST 10.00% od 57.35 -5.74" - legit gap - yet it applied
4 corrupting corrections: strip row "SPAR AJVAR POLPEK. ... 1.19" was
fuzzy-matched to the WRONG item ("SPAR TRAJNO MLEKO", letters-only LCS 10/15
= 0.667 >= old 0.65 threshold because of the shared SPAR prefix), a PSM-4
garble overwrote VAF.KAR. 1,69 as 1.09 ("1.69. 0.00 1.09"), BAZILIKA 1.49 ->
1.43, and the 0.16 POPUST COLUMN (line "SPAR AJVAR POLPEK. 3606 1 135 0.16
1198", trailing dot lost) replaced AJVAR's correct 1.19. Each step
individually "improved" |sum - total| because the real gap is a discount -
sequential improvement alone cannot distinguish repair from corruption.

Fixes (all parser-level, pinned in tests/spar-coupon.test.js):
1. **Discount gate**: corrections ignored entirely when the text carries a
   coupon/discount marker (/pop[ou]st|doplac/i). Mirrored in the ocrUtils
   cascade trigger (saves the 5 strip passes). SPAR: mismatches stay honest
   [?] flags, exactly as pre-v1.7.6.
2. **Distinctive-token matching** (namesScore, exported): match = shared
   >=5-letter token (returns 1.0), else full-string LCS ratio;
   namesSimilar >= 0.75 (was 0.65). Brand-prefix pairs now score below the
   line; the eurospin twins still pass (FROLLINI token = 1.0, CORULADNI/
   CONULADNI LCS = 0.75 exact, TARALLI 0.87). Diacritics normalize first
   (c/s/z) - the CORULADNI case silently failed without it (lettersOf kept
   "c" from c-onuladni vs plain "c").
3. **Best-match, not first-match**: the wrong-item pairing came from
   findIndex picking the FIRST item over the threshold; now the best-scoring
   item wins (candidate "SPAR AJVAR POLPEK." resolves to AJVAR itself).
4. **All-or-nothing commit**: corrections are provisional; they survive only
   if the final sum reaches the total (+-0.02); otherwise every change is
   reverted and no provenance note is written.

Verified live after the fix: SPAR upload -> 26 items, ZERO corrected rows,
no band cascade, honest 57.35 vs 51.61 flag; eurospin still recovers
FROLLINI 1.55 (sum 4.29 ok, provenance note, evidence panel); HOFER rescue
unchanged (1.79 top-strip, 4.73). Tests 59/59 (7 new).

## MILESTONE (2026-10-20, tag 1.7.6-release)

State at this milestone, verified end-to-end in the browser:

- Real-photo recovery generalizes beyond the first receipt: HOFER fold rows
  recovered by TOP strips (missing-bucket trigger), EUROSPIN price misreads
  recovered by ITEM-BAND strips (sum-mismatch trigger), both MEASURED, both
  provenance-noted, evidence panel shows every frozen attempt.
- Corruption paths hardened against real regressions the same day: phantom
  items from garble rows (short-letter TOKEN STORM rule), brand-prefix
  wrong-item pairing (distinctive-token + diacritic-normalized matching +
  best match), sequential "improvement" corruption (all-or-nothing commit),
  LEGITIMATE discount gaps (popust gate).
- 59/59 Node tests over real OCR fixtures; kernel question answered with
  data (catrom vs lanczos3 flip per band window; lanczos adopted as cascade
  diversity axis only, primary untouched).
- Out of scope / parked: push to GitHub (user's manual decision), v2->root
  canonical swap (root v1 still serves GitHub Pages), perspective-correction
  off-by-default flip (warp not implicated in the live garbles).

Working code at commit 7f00f35 (v2 line). Tagged 1.7.6-release.

## Cleanup pass (2026-10-21, v1.7.7 comments)

Post-milestone audit (research confirmed: OCR recognize() passes dominate wall
time; JS stages are minor). Behavior-preserving, 59/59 tests green, all three
photos re-verified end-to-end:

1. **Dev stage previews gated** (window.__OCR_DEBUG, same switch as the
   parser): the unconditional per-scan intermediate-canvas container (leaked
   every scan: DOM + pixel memory unbounded) and the ~5 x 300ms sleeps
   (~1.5 s wall time per scan, healthy receipts included) now only run in
   debug mode. Verified: flag on -> previews return; default -> zero canvases
   on the page, no sleeps.
2. **Band cascade EARLY STOP**: after each attempt, candidates-so-far are
   re-parsed; once the committed set makes the sum check pass exactly, the
   cascade stops (identical final parse - sum being the truth anchor, any
   further price-shifting candidate would be rejected; documented residue:
   a SECOND garbled price in a then-sum-exact state stays unrepaired, same
   as full collection). Live eurospin run: 3 attempts instead of 5 (2 OCR
   passes saved), recovery + provenance note untouched.
3. **Evidence-index bug fix**: candidates remembered a failure-blind attempt
   counter; one failed strip re-OCR smeared later candidates onto the WRONG
   attempt's evidence/winner line. Candidates now store the actual
   stripEvidence index taken after each successful push.
4. **runParsing double-clean removed**: processImage already returns
   cleanAndMergeText output (idempotent), so image paths skip the re-clean;
   PDF path keeps one clean (pdf-embedded text is raw).
5. **Dead code / export surface**: deleted app.js dataURLtoFile (zero
   callers) and ocrUtils mergeItemLines (identity pass-through); unexported
   preprocessWithOpenCV + extractTextLinesFromPDFPage (internal only).
6. **Test script**: explicit file list -> 
ode --test tests/*.test.js
   (root cause of an almost-missed suite: adding a test file no longer needs
   a package.json edit; Node 24 supports globs on Windows).

One shipping error en route: dropping the export also dropped "async" from
extractTextLinesFromPDFPage, tripping Parcel ("await in non-async") !==
caught by the E2E reload immediately, fixed same commit block.

## UI restyle (2026-10-21): deliberate, non-generic design language

Rebuilt the visual layer ( Goal: modern + cohesive, explicitly NOT the
generic gradient/glow/emoji "AI look" - quiet utility design where the
receipt data is the only loud element:

- src/styles.css (new): token-driven design system - warm paper neutrals
  (#f6f5f2/#fff), hairline borders, ink monochrome accent, 5/8px radius,
  system font stack + true monospace with tabular numerals for money.
  No gradients, no shadows-glow, no emoji decoration.
- Items render as receipt rows (dotted leaders, price right-aligned mono);
  ia markers became uppercase text badges (strip/band re-OCR) instead of
  the repeated (- onem), because the info is data, not decoration; checks
  keep the literal [+?]/check glyphs and get semantic colors only.
- Upload = dashed dropzone with drag-and-drop; camera, PDF previews, strip
  evidence panels restyled; empty progress states quieted; Copy button on
  OCR text; file input re-selectable (value reset) + hidden-file label.
- The stale v1 progress block (always-visible green bar ABOVE the app,
  "Waiting to start OCR..." at idle) is now a fixed-bottom status chip,
  hidden when idle - updateOCRProgressUI toggles display.
- index.html: title "Receipt OCR", viewport meta, mojibake comments
  removed; src/styles.js deleted (replaced by styles.css); app.js render
  layer rewritten to classNames, logic untouched.

Verified: 59/59 tests; live eurospin run renders all component classes
(badge rows, warn/ok checks, Date/Total meta, evidence with 3 attempts);
progress chip hidden after completion; zero debug canvases.

## MILESTONE (2026-10-21, tag ui-v1-release)

The v2 shell reached its intended design language, approved by the user:

- Token-driven styles.css: warm paper neutrals, hairline borders, ink
  monochrome accent, system type + mono tabular numerals for money.
  Explicitly NOT the generic gradient/glow/emoji "AI look".
- Provenance system finalized after three iterations (badge -> footnote
  asterisk -> color-voice), grounded in researched professional patterns
  (TurboTax Forms Mode color code, CCH Axcess override/estimate text,
  Dundas BI value-anchored hover, GitLens mark+hover, vLex corrected-cell
  styling, Siegel case study proving boxes/highlights fail): re-measured
  prices voice amber with a dotted underline; the story lives once in the
  checks list. User verdict: "this is correct now".
- Dev stage previews + sleeps behind window.__OCR_DEBUG (leak + 5x300ms
  per scan removed); stale v1 green progress bar replaced by an
  idle-hidden status chip; drag-and-drop dropzone; Copy button;
  re-selectable file input.
- Status chip narrowed 340->240px, clear of panel borders (user remark,
  verified live mid-scan).
- Engine layer at the same point: band cascade early-stop (3/5 attempts on
  the live eurospin run), evidence-index fix, redundant clean pass
  removed, glob test script, 59/59 tests green.

Commits: cleanup 641dde5, restyle e785112, footnote 3411adc(a), color-voice
7621fb8. Out of scope / parked: GitHub push (user's manual decision),
v2->root canonical swap (root v1 serves GitHub Pages), dark mode (not
requested).

## Debts (waiting on the user)

1. ~~Local git commit~~ — DONE 2026-10-21: initial v2 commit on `main`, local-only
   identity `jstok84 <jstok84@users.noreply.github.com>` (repo-local git config; no push).
2. **Push**: user-side only (no credentials, no PAT by choice — web editor push).
3. **v2 → root canonical swap** decision (root v1 stays on GitHub Pages meanwhile).

## Candidate next steps (no commitment)

- arithmetics validator: `znesek = cena − popust` etc. (catches SPAR-class digit slips;
  also item-sum = total consistency)
- in-app receipt-region… shipped; next pipeline candidates: perspective-correction
  off-by-default on creased receipts (needs one more live-run evidence), HEIF input hardening
- interactive crop UI (aligns with the human-review workflow — user says when)
## RESTRUCTURE (2026-10-21, after ui-v1-release)
- v2 promoted to repo root: src/, tests/ (59 tests), scripts/, NOTES.md, package.json (name receipt-ocr-test, 2.0.0) are now canonical.
- v1 archived intact to old/ (src, tests, package.json tesseract ^4, README); not maintained.
- deploy.yml: node 18->22; build cmd unchanged and already matched root layout (src/index.html -> docs, public-url /receipt-ocr-test/).
- CI unverified until next push (user-side). Local verification after move: npm install + 59/59 tests; production build green (5.83s, receipt-ocr-test.beeec167.js 1.58 MB); dev server from root + live HOFER scan identical (Kruger 1.79 rescue, sum 4.73, checks intact).
## TEST CHANNEL — B2 sync + debug evidence (2026-10-23)
- Feature set for the -testing phase- discussion (published site on Pages is the test bed; verified live: full HOFER scan identical).
- src/sync.js: S3 SigV4 presigned URL signer (PUT/GET) for browser-direct B2 uploads. NO Secret in bundle/repo: device application key entered once via #sync setup panel, lives in device localStorage only; agent holds a separate read-only key (listFiles/readFiles/shareFiles). R2 rejected as primary: requires a card on the free tier (user checked; Backblaze B2 chosen: 10 GB free, no card, no inactivity pause; egress free to 3x storage).
- Signer locked by tests/sync.test.js to the AWS SigV4 presigned-GET reference vector (hash 3bfa2928...ad04, signature aeeed9bb...d404). Honest log: I first wrote the expected signature from memory with a wrong tail; recomputing the canonical hash confirmed the construction was correct and the expected value was wrong; Real bug found while wiring: canonicalUri lacked the leading slash; wrong canonical hash for EVERY presigned path. Caught by the vector test before any real upload; fixed.
- App: runParsing returns parse; maybeSync() after each successful scan (image paths only; PDFs skipped) uploads photo + manifest JSON (ocr text, parse, rescue inc. attempts text/images, timings, UA; sha1-prefix filename). Sync setup panel behind header sync button / #sync hash; evidence button toggles debug panel (raw text + pipeline ms + cascade attempts).
- Verified: 63/63 tests (59 parser + 4 signer), build green, live HOFER scan: same results + evidence meta 'pipeline 5260 ms, 4 attempts'; setup panel renders with secret-masked inputs; no config persisted when toggled off.
## TEST CHANNEL — CORS saga + PUT fix (2026-10-23, continued)
- Phone symptom chain, in the order evidence arrived: status line "sync failed: Failed to fetch" → Test connection all-THREW → live XML error page in phone address bar proved the phone REACHES s3.eu-central-003 (XML page = address-bar navigation, no CORS involved) → phone bundle hash (line 0 diag) matched Pages deploy (stale-cache theory dead).
- Verified from shell probes: B2 CORS preflight OPTIONS → 200+ACAO for both origins after user applied rule revision 5 (my first rule JSON used invalid op names s3_get_object/s3_put_object; Backblaze's sample showed s3_get/s3_put). BUT: non-2xx PUT responses carry NO ACAO → browser reports plain "Failed to fetch" for a mere 401/403. Never trust Failed-to-fetch as a network diagnosis; it can be pure auth.
- Root cause (two defects in presignS3, both mine, both verified against the live endpoint with the read-only agent key as a capability probe): (a) path-style URL never carried the bucket — PUT went to /receipts/S25/… and B2 read bucket "receipts"; (b) content-type was signed into the PUT — legal SigV4 per the AWS vector yet SignatureDoesNotMatch at B2. Variant matrix: sign x-amz-content-sha256 (D) and sign real body sha (E) also SDNM; host-only PUT validates → AccessDenied for the read-only key. GET fine host-only.
- Method lesson: the signer "locked to the AWS vector" was necessary but insufficient — B2's S3 layer deviates from AWS in PUT query-auth. Empirical conformance probing against the REAL service is the actual gate; the vector test now encodes the B2 rule (64/64).
- Diagnostics panel now: line 0 prints loaded bundle hash (stale-build detector), line 3 real presigned PUT with saved-config fallback (secret never re-typed). Errors name the fetch failure honestly ("may be a refused-without-CORS response").
- Still open: phone-side end-to-end confirmation (push 943b8ca, rescan); then manifest comparison loop; then capture quality-gates (scores ride the manifest).
## PHONE CASE #1 + #2 (2026-10-23, after sync fix landed)
- Confirmed end-to-end: two phone jobs landed in bucket (rule-held diag probe too). Sync WORKS.
- Case 1 photo is a computer MOUSE, not a receipt — garbage OCR → null parse is correct behavior; date line never OCR'd elsewhere either. No parser change warranted.
- Case 2 (HOFER, 90° rotated): OCR read OK but (a) bulk selection dropped all but files[0] (found in code: no multiple attr, files[0] only) — fixed to sequential multi-file; (b) footer "HVALA ZA VAS NAKUP!" fused with barcode digits became a bogus 10,26 item that broke the sum check — line-anchored /^hvala\b/i guard; (c) date 22.10.26 17:56 never survived OCR (rotated read dropped that whole region) — null date stands, no overfitted rule; (d) "HOFER CENA" total tier was already correct via candidate ranking.
- Locked with tests/fixtures/hofer-phone-real.txt + tests/phoneFixtures.test.js (phone OCR verbatim): 67/67.
## PHONE CASE #3 + #4 (2026-10-23, batch two)
- Bucket now holds 4 scan pairs (mouse, HOFER, mouse again, INTERSPORT). Multi-pick works; sync works repeatedly.
- Case 4 (INTERSPORT, over tablecloth+lighting): OCR degraded (bleed lines "[m]", "ap > €" everywhere); parser manufactured a bogus 16.09 item from the fused date line "…1363170) 16.09 2029 Zav" (existing date guard requires the second dot separator; this fused line lacks it) and misread JAKNA znesek 548 → 5.48; rescue correctly abstained (discount-marker present in line? actually "pOPUST 24,00" IS on the receipt but the check text has no "missing item ≈" so only the item-band gate could fire; it did nothing visible — attempts 0). Total 59.99 found correctly. NOT fixed yet — candidate work: date-guard tolerance for blurred separators + item-line SKU-prefix anchoring for INTERSPORT-class receipts; needs more real captures before touching rules.
- Case 3 = mouse again (user re-selected the desk photo; verdict now tells them).
- UX fixes from this batch (commit f0dfb12): per-file job queue rows (name/note/live sync), active-file progress naming, evidence panel leads with scanVerdict (receipt/partial/garbage/empty + stats line) and collapses raw text; camera canvas-fallback dataUrl ReferenceError fixed while in the area.
- Verdict unit-locked on the real noise text and HOFER phone OCR: 72/72 tests.
## USER PUSHBACK ROUND (2026-10-23)
- "HOFER was not rotated 90°" — USER CORRECT at the pipeline level, my framing was wrong. EXIF on the jpg: Make samsung Galaxy S25, Orientation tag = 6 (sensor stores landscape pixels, displays upright). The browser Image()/drawImage decode HONORS EXIF, so OCR read upright pixels (coherent text proves it); my offline byte-level view ignored EXIF. No bug; record the honest sequence.
- "INTERSPORT sum was 55,99" — USER CORRECT. Payable printed 55,99, OCR read 59,99; PLAČANO 55,99 and DDV recap 45,89+10,10=55,99 agree; 79,99−24,00 popust = 55,99. Parser had no payable-vs-paid conflict path for card receipts (tender/check only fired with cash change) — added one: 'payable X ≠ paid Y [?]' failing check, tier picking unchanged; ambiguity surfaced, never silently resolved (locked on the merged INTERSPORT fixture, 75/75).
- Blinked date guard: '16.09 2029' (dot blurred to space) had escaped the date exclusion and manufactured a 16.09 item; separator before 20YY may now be a space. Regressions: none.

## PHONE CASE #5 (2026-10-24): same INTERSPORT receipt, RE-PHOTOGRAPHED
- Bucket pair `…e6df3018d80af5bc` (photo + manifest JSON, phone Chrome 155).
  The user read it as "treated differently" — TWO stacked causes, both proven:
- CORRECTION (user pushback, same day): "not true — deployed was NOT stale."
  USER IS RIGHT, my CAUSE 1 was wrong. git log + the manifest's own evidence
  prove it: origin/main was already at 760309a (v2.0.13 + panel fix) when this
  photo was scanned, and the deployed manifest shows the MERGED JAKNA item
  with quantity:1 — v2.0.13 behavior; a pre-13 parser cannot produce that
  merge. My error was asserting the deployed version from a stale working
  note ("deployed = 7e9342a") instead of re-checking origin first. The ONLY
  difference was the photo itself (CAUSE 2 below), plus the then-missing
  v2.0.14 guards (75ff9c7), which the user pushed afterwards (deploy CI green).
- CAUSE 2 (photo): genuinely harder capture — backlit keyboard ground, fold
  crease through the print, rotated. OCR misreads: BOTH printed 55,99 totals
  (DDV "Skupaj" + PLAČANO MASTERCARD) read 99,99 — glyph 5↔9; every total zone
  wrong the same way = unrecoverable by parsing (honest failing check stands);
  "(30.0%) - ŠPORTNE ZVEZDE  -24,00" lost its minus → positive 24,90 phantom
  item; "ZA PLAČILO" header fused with its ruled line → "ZAPLACILO eee _ 56,99"
  second phantom; SKU tail 548 OCR'd as "š48" (5→š) so the v2.0.13 strip missed.
- FIXES (v2.0.14 parser guards, src/parseReceipt.js):
  (a) nonItem: line starting with parenthesised percent "(30.0%)" = program-
      discount row, never merchandise (closing paren unrequired);
  (b) nonItem: /zapla[čc]ilo/ and /\bpla[čc]ilo\b/ — payment-vocabulary
      section headers, never products (total candidates scan does NOT use
      nonItem patterns, so "za plačilo" tier discovery is untouched — verified
      against the old fixture: total still resolves);
  (c) qty×price donor name-trailing strip accepts š/s/§ SKU-tail variants of
      the printed 5 ("š48"/"$48"/"548").
- Locked: tests/fixtures/intersport-new-real.txt (verbatim OCR of THIS capture
  from the local live run) + tests/intersportNewPhoto.test.js — 1 item
  ("JAKNA M.POH BRIMFIELD" 79.99 ×1), no discount/header phantoms, date
  2026-09-16, total stays 99.99 with exactly 1 failing sum check. 84/84 tests.
- LIVE no-regression sweep (all seven real captures, post-change): SPAR 26/
  51.61 identical; HOFER-B 3/4.73 + Krüger rescue intact; INTERSPORT old 1/
  55.99 unchanged; EUROSPIN scan+phone both 3/4.29 unchanged; hofer-phone 3/
  12.14 zero failing checks unchanged; intersport-new 1 item/79.99, total
  99.99, one failing check = the pinned behavior.
- LOCAL live parse of the new photo (local HEAD): total candidates 3 (99.99 /
  79.39 / 85.99) → 99.99 final; total zones on THIS photo are misread on the
  PHONE run too (its manifest: DDV "99,99", PLAČANO "99,99"). A candidate for
  the future (not implemented): the mid-receipt "SKUPAJ 79,89 − POPUST
  24,00 = 55,99" chain could DERIVE the payable — but per standing policy
  arithmetic never silently becomes a total; only surfaced via checks if ever.

## PERSPECTIVE/CROP INVESTIGATION (2026-10-24, user-driven, ~8 live OCR runs)
USER OBSERVATIONS FROM EVIDENCE PANEL: (1) "perspective applied incorrectly — wrong direction and too much"; (2) "cropped OCR looked better — can you crop receipts automatically". Findings, all evidence-backed:
- The perspective warp (Step 3) NEVER fired on any of the 3 live real-photo scans (no "Perspective Corrected" stage in HOFER/EUROSPIN/INTERSPORT pre-experiment). It needs an exact 4-corner approxPolyDP of the Otsu largest contour. What DOES visibly rotate in the stage pictures is the DESKEW step (EUROSPIN 3.27°, INTERSPORT 9.89°, HOFER skipped <1°). The user's "wrong direction and too much" percept comes from a deskew-vs-nothing frame rotation, not the perspective warp itself.
- Outcome-level A/B matrix (window.__OCR_OPTS evidence-run hook added to processImage; NO default change):
  INTERSPORT phone: axis+deskew (prod) = total 59.99 [OCR-misread true payable] / 2 items / 2 failing checks. axis + no deskew + no warp = 95.99 / 1 item — WORSE, so deskew is outcome-corrective on the axis path. ROTATED tight crop (+deskew auto-skips <1°) = total 55.99 CORRECT / 6 items incl. junk machinery rows ("SKUPAJ 79.99", "ZA SLACILO 55.99" leak as items — the known column-format gap) / 1 failing check. rotatedFlip (sign inverted) = text GARBLED, 95.99 — sign decided for "rotated" (+angle), one decisive reading.
  EUROSPIN desk: axis (prod) = total 4.29 ✓ + items + sum ✓ + tender ✓ — full parse. rotated + warp FIRED FOR THE FIRST TIME (4-corner quad matched) = total LOST + garble (the crease + warp harm, v1.7.2 note). rotated + NO WARP = items read PERFECTLY (1,55/1,29/1,45 exact — the user's "cropped OCR was better" confirmed on items) but the totals zone OCR-wobbled away ("(EUR): | 4,29" → "=n), 50" garble; no total, no checks) and the double-read address line ("Partizanska cesta86,62") leaked as a junk item.
  HOFER phone: rotated + no warp = total 12.14 ✓ kept, but Brioš price misread 3.30 (true 3.36) and "POHVALA ZA yas" leaked (embedded word — \bhvala\b needs a word boundary, POHVALA embeds it). Axis baseline earlier live evidence (17.40≠12.14 via "S HVALA Z", since fixed).
- Mechanistic read: on INTERSPORT the Otsu bright blob's minAreaRect IS the paper — the tight crop realigns the receipt to text-horizontal in one cut (also killing the deskew question); on EUROSPIN the blob still drags mat, so the rotated crop inherits mat and the totals-zone garble shifts; axis+deskew there is the established good geometry.
- DECISION: autoCropMode stays "axis" (behavior-preserving; rotated is not dominant). Code ships: cropToReceipt(mat, mode) with "rotated"/"rotatedFlip" variants (minAreaRect portrait-normalized rotate-crop, same sanity guards as axis), window.__OCR_OPTS pre-opts override hook (unset = production path), data64F fix (getRotationMatrix2D returns CV_64FC1 — the data32F alias corrupts bytes, live TypeError evidence). Deskew sign suspected but INERT post-rotated-crop (residual <1°, skips). Perspective warp left untouched: never fires in the wild; when it fires it garbles (EU evidence, consistent with the v1.7.2 strip note).
- FOLLOW-UPS queued: (a) totals-zone brittleness — "(EUR):" structural tag survives only some OCR wobbles, needs zone-of-interest totals read; (b) POHVALA-class embedded footer garble guard; (c) INTERSPORT qty×price format (unchanged); (d) revisit autoCropMode default with more PHONE scans (the app's real target) — if rotated keeps winning, flip with EU/HOFER mitigations and a warp gate.
- Verification method: window.__OCR_OPTS set via page evaluate BEFORE dispatch (persists until reload), scan → queue row → items/checks + stage captions from live DOM; files served by a tiny node http server on 127.0.0.1:3301 (ACAO:*) from Temp\opencode\serve copies (hofer-phone.jpg, eurospin.jpg, intersport-phone.jpg).
- Evidence panel: user wants comprehensiveness back — raw OCR text restored visible by default (verdict stays first above it).
- Lacunae logged for the INTERSPORT class (more captures needed): JAKNA znesek '548'→5.48 misread; item line format '1 000 x 79,99 79.89' (qty×price columns) unsupported.

## ROTATION ROOT CAUSE FIX (2026-10-24, text-angle source; v2.0.5/v2.0.6, ~10 live runs)
SELF-CORRECTION of the previous section's reading. The user's complaint ("wrong direction and too much") was CORRECT ALL THE WAY DOWN and my "deskew is outcome-corrective on the axis path" was drift-confounded. Numeric evidence (Hough text-line measurement: Canny → HoughLinesP → near-horizontal segments, length-weighted mean):
- The INTERSPORT receipt's text tilt is +0.9° (median, IQR ±1.5° — essentially upright). minAreaRect on the Otsu blob reported junk ~10°: the DESKEW rotated a straight receipt 10° (wrong direction per the build's convention), then measured <1° on the mangled blob and skipped. The rotated-crop variant (yesterday's 55.99 "success") rotated the SAME −10.2° — the crop introduced the tilt (the deskew then skipped it identically). Tesseract read the −10° text anyway (some tolerance), so the OCR outcome didn't scream, but the geometry was junk in both rotation sources. Blob-box angles are NEVER usable as rotation sources on near-upright paper in this OpenCV 4.5+ build.
- FIX (v2.0.5): rotation angle now = TEXT-LINE direction (textAngleOf: Canny 60/150 → HoughLinesP(1, π/180, 60, 60, 12), |ang|<20°, len≥40, n≥12 else null, length-weighted mean). Applied in (a) deskew Step 2 (deadband |T|>1.0, canvas ENLARGED via rotatedMat so corners survive — the old same-size warp clipped corners), (b) cropToReceipt "rotated" mode (rotates the whole frame so text is horizontal, then cuts the same axis bbox on the rotated mask; below the 1° deadband or unmeasurable → plain axis crop; "rotatedFlip" remains the sign-A/B channel).
- SIGN (numerically settled, EUROSPIN A/B): getRotationMatrix2D(+T) ("pos") rotated text AWAY from horizontal — final text angle measured −3.1..−4.9° from an original −3.44°; "+neg" (apply −T) measured +1.06° ≈ flat. This build's +θ turns content opposite to the docs' wording. Default textAngleSign = "neg" ("pos" remains selectable via __OCR_OPTS).
- OUTCOME results under the new default (n run on each photo):
  INTERSPORT phone: deskew correctly SKIPS (T≈0.5-0.9 < deadband) — and the perspective warp now FIRES (the old blob-deskew's wrong rotation had been suppressing the quad match): total reads EXACT 55.99 (shipped-ever best; old prod misread 59.99). Items still 1 (known qty×price gap + one leak). autoCropMode=rotated ≡ default at ≤1° tilt (axis fallback by design), verified identical.
  HOFER phone: BEST PARSE OF THIS PHOTO IN PROJECT HISTORY — all 3 items exact (Brioš 3.36 — every previous live/bench run misread 3.30; Skleda 8.49; Cola 0.29), total 12.14 ✓, zero failing checks, no POHVALA leak. Deskew measured +1.46° → applied −1.46°.
  EUROSPIN desk: deskew measured +3.45° (≈ the old blob 3.27°) → applied −3.45° — but the straightened frame then MATCHES the 4-corner quad and the warp fires, garbling the totals zone (verdict has NO total: "0 failing checks" is only because there is nothing to check — a masked regression vs the shipped 4.29-full-parse). CRITICAL ADJACENT evidence: with the warp force-disabled (perspectiveCorrection:false) the totals zone READS — raw text contains "(EUR); k 4,29" — but the parser picked a garbled discount line "4,00" instead. So the totals loss is warp-mechanical, NOT an OCR disappearance, and the totals-TAG brittleness follow-up (previous section (a)) is now THE binding constraint for EU.
- WARP GATE (v2.0.6, data plumbing only — behavior unchanged): quad geometry is now measured at FULL RES inside the pipeline when the warp fires (console "📐 Perspective quad" log + stage caption "Perspective Corrected (quad W×H, N% of frame)"). First true numbers: INTERSPORT quad 1433×3491 (aspect 2.44, 38% of frame). Live probe on the ≤480px panel images CANNOT reproduce the full-res approxPolyDP decision (quadFired:false vs actual fired stage) — that instrument limit is why the gate ships as plumbing, not a rule. Follow-up: collect quad numbers on more captures (the third datapoint: EU downscaled-probe aspect 1.60/42% is UNVALIDATED), then gate warp firing on quad shape if the classes separate cleanly.
- DECISION: textAngleOf + neg sign + text-aligned rotated crop SHIPPED AS DEFAULTS (evidence: 2 decisive wins — INTERSPORT total exact, HOFER full clean parse — vs EU's warp-coupled totals loss, which is carried as the documented cost; its remedy belongs to the totals-tag follow-up, since even warp-off EU misrouted the read 4,29 → parser took "4,00"). The comment block in ocrUtils (v2.0.5/v2.0.6) carries the full reasoning inline.
- Stage captions updated: "Deskewed (text angle: +3.45°)" (always reports the MEASURED tilt), "Perspective Corrected (quad W×H, N% of frame)". Old claims CORRECTED here: earlier "rotated tight crop realigns the receipt for free" — false mechanism; it rotated the text 10° off; INTERSPORT's 55.99 came from crop tightness (mat/keyboard removal), not realignment.
## USER'S CROP = GROUND TRUTH → PROJECTION-PROFILE CUT (2026-10-24, v2.0.10, loop exited)
The user provided a manual crop of the EUROSPIN photo (Downloads\\scan-eurospincropped.jpg) and the compare ended the crop debate. Three root facts, all live-measured:
- THE ORIGINAL PHOTO: EUROSPIN receipt = nearly upright vertical strip in the center (~45-50% width), mat left/right + keyboard band on top, paper occupies ~y 390..~1480 of 1600 (verified: rows ≤380 = 0% bright in the paper columns, row 400 = 88%; bottom rows 626→0.63, row 1500 = 0.09). INTERSPORT full-frame paper: only corner slivers of background — NOTHING to isolate (this photo was never the crop problem; the user saw "not cropped at all" and was right in both directions: nothing needed cropping, and the code's bbox cut kept ~101% of the frame on it anyway).
- WHY EVERY PRIOR CROP FAILED: cropToReceipt located the paper as the largest Otsu-bright CONTOUR — on both phone photos that contour included mesh/glare or covered the frame (EU largest contour 52% of frame, bbox 94%; INTERSPORT blob 48.6% frame with NO closing at all), so the bbox could never be tight; all minAreaRect/rotation work on top of that locator was noise. THE USER'S CROP RULE: cut to the paper's edges, leave every pixel unrotated (their crop keeps the ~3° tilt exactly as captured). Matching rule: the paper is THE brightest surface → pixel COLUMN/ROW PROFILES of an absolute ≥160 bright mask, smoothed (~4% frame), cut the band where smoothed bright-fraction ≥0.3 (columns) / ≥0.2 (rows). Reproduced the user's crop boundaries on EU live (x[234..901]/1200, y[386..1463]/1600 probe + strip-brightness cross-check of both edges); on INTERSPORT ≈ modest full-frame trim (no junk to remove); fail-safe = old contour-bbox fallback (no band → no crop).
- OUTCOMES under the new default crop (one run each, default path otherwise unchanged):
  EUROSPIN: 3 real items, all amounts EXACT (1.55/1.29/1.45) with clean names, totals zone SURVIVED ("(EUR)" machinery engaged) — total printed 4.20 (one digit of 4,29 wobbled at the crease) and the sum-check correctly flags it [verify] — no junk items, no tender leak. Strictly better than this morning's axis+neg (totals gone) and = shipped baseline quality.
  INTERSPORT: total 55.99 EXACT (4th independent geometry that now reads the true payable), deskew fires +1.19°, items 0/1 (qty×price format gap owns this untouched).
  HOFER: FULL CLEAN PARSE — all 3 items exact (Brioš 3.36, Skleda 8.49, Cola 0.29), total 12.14, and now a GREEN "items sum = total" check. Best result of the project on this photo.
- LOOP EXIT (user-observed, recorded verbatim): I kept adjusting rotation inside the crop step (crop's own rotate → deadband fallback → tight-rotate → text-aligned selection) and verified each variant against cross-frame Hough readings that were not measuring the same content — sign "solutions" kept contradicting themselves because the deskew input frame differed per geometry and the mat/glare loaded the profiles differently. The exit was DESIGN-LEVEL, not Tuning: SELECTION and ROTATION are separate problems. Crop = selection only (profile cut, no rotation). Rotation = ONLY the deskew, driven by the trustable text angle with its 1° deadband. There is no crop-side angle left to fight about. The "rotated"/"rotatedFlip" autoCropMode options now behave identically (selection is the whole story) — accepted for legacy __OCR_OPTS scripts, documented retired.
- FOLLOW-UPS (updated): (f) totals-zone parser: EU today shows the tag surviving and ONE DIGIT wobbling (4.29→4.20) — candidate: accept the amounts-zone value when the sum-check proves it (items sum 4.29 IS the total — the check literally computed the contradiction). (a)-(c),(e),(g) unchanged; (g) autoCropMode-default revisit is now MOOT: there is one crop rule.
## INTERSPORT items closed: qty×price format (2026-10-24, v2.0.13) + SPAR preprocessing A/B + lanczos-family taxonomy (user's three claims)

- (1) "INTERSPORT has no items — regression!": honest history established first (git + phone-artifact
  JSONs, `phone1/receipts_S25_*.json`): the OLD deployed build's 2 "items" were BOTH wrong —
  phantom `"CO. RN aa 9- 1363170)" 16.09` (fused date) and `"JAKNA … 548" 5.48` (real item, price
  misread). Today's 0 = no junk, but the REAL item was also missing → omission, not a pure defense.
  THE FORMAT FACT: INTERSPORT prints the item name row and, UNDER it, a Količina × Cena Znesek row.
  The name row's price column garbles to a bare figure ("548" fixture-era / "$48" current geometry)
  while the MEASURED unit price 79,99 only survives on the ×-row ("1 000 x 79,99 79.89 E" /
  "1,000 x 79.99 (999"). FIX (v2.0.13, `parseReceipt.js`): precompute ×-rows (start-anchored
  `digits[x×]amount` with comma/space thousands-grouped qty, optional second amount, tail tolerated);
  each ×-row claims its PREDECESSOR as name donor — donor must pass the item-loop guards
  (dateTime/exclude/nonItem), have a lettered name, and carry NO decimal amount of its own (its
  price is suspect; a cleanly priced row is never hijacked). Name = donor minus leading/trailing
  figure tokens (SKU/junk edge/price garble); price+quantity from the ×-row ("1,000"/"1 000" → 1).
  Fixture pins extended (qty×price merged item, SKU stripped, phantom 5.48 forbidden).
  LIVE MATRIX after (all five captures re-run, standing rule): INTERSPORT **2 wrong/0 → 1 REAL item
  ("JAKNA M POH BRIMFIELD" 79.99 ×1, measured) + total 55.99 exact + honest popust-sum flag**;
  HOFER-A 3/12.14/green ✓; HOFER-B 3/3 (Krüger strip) /4.73/green ✓; EUROSPIN 3/4.20+flag ✓;
  SPAR 26/51.61+popust flag ✓ (no false rescue). Tests 79/79 (78+1 new).
- (2) "SPAR looks worse after opencv preprocessing — look into it": measured, both halves.
  TEXT A/B (live, same file): contrast stretch OFF (via `__OCR_OPTS {contrastStretch:false}`) read
  **26 items / total 51.61 / 61 OCR lines** vs stretch ON (default) **26 / 51.61 / 62 lines** —
  identical outcomes; the stretch neither helps nor hurts SPAR's numbers (it is scan-class:
  background 221-254 vs paper 236). VISUAL A/B (stage images side by side): preprocessed stage is
  CRISPER — text darker, background whiter; the visible difference is the dot-matrix separator rows
  ("****…") rendering heavier/messier and the print-through note getting stronger contrast. That is
  a cosmetic judgment, not a data change. Guard history preserved: every measured-harmful knob
  (adaptiveThresholding, CLAHE, denoise, unsharp, invert, thresholding) is OFF by default; the only
  ON enhancement is the contrast stretch that measured +2 items/3 on EUROSPIN (`ocr-eurospin2`) —
  so it CANNOT be globally removed without an evidence-based gate. No change made; if the heavier
  separator rows bother you, say so and a scan-class-specific stretch gate can be explored WITH the
  EUROSPIN-class counter-evidence respected.
  FULL-OMISSION A/B (user's follow-up: "you didn't actually omit the opencv preprocessing — run it
  live"): same SPAR file, `__OCR_OPTS {contrastStretch:false, autoCrop:false, deskew:false,
  perspectiveCorrection:false}` (stages confirmed: Grayscale → preprocess → 2× only, no crop/deskew/
  warp stages) vs default run, same session: **26 items / 51.61 / 62 OCR lines BOTH ways, same
  popust flag** — zero OCR difference. Visual side-by-side of the EXACT pixels fed to Tesseract:
  the WITH-preprocessing stage is clearly crisper (dark text, white ground); the raw-scan stage is
  visibly blurry/soft with doubled letter edges. Verdict: the preprocessing is not the cause of any
  "worse" reading on SPAR — it is idle-to-helpful there and materially improves the OCR input image;
  no default changes justified.

EVIDENCE-PANEL STAGE-SOFTENING ROOT-CAUSED AND FIXED (2026-10-24, v2.0.14):
  User's eye: stage 5 "Perspective Corrected" looks best; stage 6 "after OpenCV
  preprocessing" looks worse. Stage-metric instrument (page-side cv.Laplacian
  mean-of-squares on the same items-region of the ≤480px stage thumbnails, SPAR
  default run): Grayscale 6356 → crop 7639 → stretch 10885 → pre-warp 10885
  (identical pixels; deskew is a no-op on SPAR — absdiff 0.00) → warp 8411
  (real resample softening from the ≤962-wide warp cap, −20%) → st.6 1852 →
  st.7 1927. The 5→6 drop (5.6×) is IMPOSSIBLE from the code: st.5 and st.6
  source the same warped mat (optional post-warp stages all default-off), and
  finalCanvas = cv.imshow(canvas, gray) at the same native size.
  MECHANISM (instrumented live, three probes): pushStageDataURL sources were
  patched and byte-compared — the string used for st.6 IS byte-identical to the
  finalCanvas PNG (equalsFinalCanvasPNG: true), and an idle-time re-derivation
  of that same PNG through the identical decode→drawImage path reproduces the
  crisp 8411 thumb. The soft result only happens on the FIRST draw of a freshly
  decoded Image element when the downscale factor is < 0.5 (480/962 = 0.499):
  first draws gave 1852/2508/3897 (raising imageSmoothingQuality does not
  rescue), warm repeats give 8411 deterministically; drawing from a native-size
  canvas (recordStage's route) is crisp on the very first draw at the same
  factor/route. So the pipeline never softens anything — st.6/st.7 thumbnails
  were degraded purely by the Chrome first-draw decode path in the evidence
  capture. st.7's source is the 2× upscale (1924×4658), scale 0.25, same trap.
  Ground truth for OCR is unaffected: Tesseract eats the crisp upscale of the
  crisp warp output; OCR deltas were never real (26/51.61 identical throughout).
  FIX (v2.0.14, src/ocrUtils.js pushStageDataURL): stage the decoded Image on a
  native-size canvas first, then downscale — same route as recordStage, immune
  to the first-draw quirk. Validation: SPAR st.6 thumb now lapVar 8411 and
  pixel-identical to st.5 (absdiff 0.00), st.7 7910; OCR outcome unchanged
  (26 items / 51.61 / 62 lines / 9 keywords). No-regression sweep live: HOFER-B
  3 items / 4.73 with Krüger strip rescue intact; INTERSPORT 1 item / 55.99
  (qty×price v2.0.13 intact); EUROSPIN 3 items / 4.29 vs 4.20 as before. Node
  tests 79/79. The change only touches the debug/evidence capture path; no OCR
  pixels change.
- (3) "it wasn't just hofer rescued with 'lanczos' family corrections" — CORRECT, taxonomy from the
  ledger: the strip/band re-OCR machinery (resampling cascade: catrom default + lanczos3 as the
  5th band-cascade attempt) has THREE documented receivers:
  · HOFER-B Krüger 1,79 — top-strip rescue (v1.7.2; the strip design predates the
    lanczos3 attempt, which the cascade later shared);
  · EUROSPIN FROLLINI 1,55 — band re-OCR (v1.7.6), the case that PROVED no single kernel wins
    (lanczos3 reads 1,55 at 40-75% band where catrom loses the row; catrom wins at 35-75%; sharp's
    own lanczos3 flips 1,55→1,854 — hence the 5-attempt cascade, not a kernel swap);
  · SPAR coupon — NEGATIVE receiver: the band rescue fired on SPAR's legit 57.35→51.61 coupon gap
    and corrupt-4-items story (wrong-item fuzzy match, PSM-4 overwrites, popust-column swap) → the
    v1.7.6 fix gates it: no band rescue when /popust|doplac/ markers present. SPAR today stays
    honest-flag-only BY DESIGN, not by accident.
  The user's point stands: this is corpus-wide machinery, not a HOFER one-off.

User challenged "hofer is in regression" → I initially mis-attributed it (invented "new second capture" story). Corrected by following the git: `Downloads\hoferracun1.jpg` IS the HOFER EFT capture — in the corpus since v1.6.8/v1.7.2 as `tests/fixtures/hofer-scan-real.txt` + `hofer-eft-scan.txt` (`fab8ef0`, `25cb7bd`), physically DIFFERENT from HOFER-A (`hofer-phone.jpg`, the 3000×4000 full-frame shot — re-verified identical after every change today). Facts, all measured:
- THE FILE: 1280×961 **AVIF container with .jpg extension** (magic `00 00 00 20 66 74 79 70 61 76 69 66`; the four B2 phone captures are true EXIF JPEGs). Receipt TAIL: top cut off, mirrored print-through text from the roll behind, washed top line (Krüger 1,79). Full-frame OCR garbles its price EVERYWHERE (fixture header: "unrecoverable"; live reads "oi 8"/"8" both geometries); the top-strip re-OCR at 3× is the designed recoverer (v1.7.2).
- DEPLOYED SITE = morning commit `7e9342a` bundle (`183f67d5`): landmark-verified (profile cut in, ink-edge absent, evidence panel, HVALA/otovina, vmesna-vsota anchors absent). Its live HOFER-B outcome: 3/3 items (Krüger via strip rescue) + total 4,73 + green sum + provenance flag.
- THE REGRESSION, root-caused in three layers: (1) CLASSIFICATION: "Vmesna vsota 4,73" (interim-sum, HE TH total of the 3 visible items) was classified as an ITEM because `isSlovenian` failed — all 8 anchors garbled on this capture ("ra-Id", "Zresek", "pla?ila", DDV gone) → English tiers ran → 0 total candidates. CURRENT TOTAL FIX: `vsota`/`vmesna`/`izdel` added to the anchor list + `/vsota/` and `/v(?:m|n)esna/` non-item patterns (fixtures already pin Vmesna-vsota-as-NOT-an-item — hofer.test.js line 39). (2) RESCUE ARming: the deployed build's strip rescue armed via the v1.6.9 VAT-recap bucket hint — readable on the deployed geometry, but GARBLED under the current ink-crop geometry ("BRON CS B 22,0% Neto aro 0,82"), so the rescue never armed and Krüger stayed lost: "VMESNA fix alone recovered the total (4,73 exact) but not the hidden item. RESCUE GATE FIX (v2.0.12): arm the strip rescue from the plain sum≠total gap (missing = total − Σrefs) when no bucket hint exists, skipping when the raw text carries discount/coupon markers (SPAR 5,74 stays hinted, no rescue) and keeping the measurement-only acceptance (strip must OCR-read the missing amount ±0.02 — arithmetic never becomes an item). (3) Geometry consequences documented: ink crop on bright-background photos changes OCR text (29 vs 26 lines; recap clean→garbled); the crop itself is CORRECT selection (trims the 26% bare-wall margin) and the machinery must work on ANY geometry — hence the gate fix instead of reverting the crop.
- FINAL LIVE MATRIX (each photo re-run after the fixes): HOFER-B 3/3 items (Krüger 1.79 measured, šumeče 0.85, Barcaffe 2.09) + total 4.73 + green sum + provenance [?] note; HOFER-A 3 items/12.14/green (unchanged); EUROSPIN 3 exact/4.20 + sum flag (unchanged); INTERSPORT 55.99 exact (unchanged; transient "no content" mid-run reading was first-pass, final verdict normal); SPAR 26 items/51.61 + popust flag (unchanged; no false rescue on the 5,74 coupon gap). Tests 78/78, build green.
- RULES ADDED (user demand, `AGENTS.md`): NO REGRESSION / NO OMISSION (a change may not make any previously-parsing receipt parse worse, edge-cases included); ALWAYS TEST ON LIVE DATA (fixture passes never count as validation — every change reruns the real photos through the live pipeline before shipping).
- UNRESOLVED EXPECTATIONS FROM THE FIXTURES (pre-existing, still open): (f) EU's 4,29 printed-vs-4.20 one-digit wobble; INTERSPORT qty×price items; SPAR popust hint remains a [?] invite. Also `hofer.test.js` header still calls the Krüger row "unrecoverable" — v1.7.2 strip re-OCR measurably recovers it; wording only.
- INK-EDGE RULE (2026-10-24, v2.0.11, user proposal, committed live-verified):
 user asked "if more than 160 why not find the edge of ink which is black and crop 10% around?" → SECOND rule inside the crop, gated: the bright/paper band (160, 0.3/0.2) runs FIRST and when it keeps ≥98% of the frame (scan-style photos, SPAR's class) an ink stage selects by dark pixels instead — <128 mask, outermost 1% ring zeroed, 2% dark-fraction profile cutoff, 10% margin (user spec), 25%×25% sanity floor. Gating is EVIDENCE-MANDATORY: ink profiles on dark-background photos see the background (HOFER probe: ink band would cut the TOP 57% of the receipt away; EUROSPIN/INTERSPORT paper bands keep 0.386/0.477 → ink never fires there, behavior provably unchanged). SPAR probes refined the rule: the phantom x=0 band edge was a ~10px BLACK SCAN BORDER (cols 0-10 mean gray 14; cols 10-400 pure white 253-254) — the ring-clear removes it (band x becomes [503..1125] from [0..1130]). SPAR LIVE RUN: crop applies (stage-2 480×1165 ≈ 56.6% of frame), 26 items parsed, ALL item amounts exact vs the receipt text (cofy spot-check of all 26 lines), total 51.61 exact (57.35 − 5.74 kupon popust), and the sum-check flags 57.35≠51.61 — correct surface for the parser's known popust follow-up, same class as INTERSPORT's. Deskew skipped (scan is straight, deadband), warp fired (quad 962×2329, 99% of frame) and the parse came out clean — first capture where warp fired on a scan-shaped quad. Tests 78/78, build green.

## EVIDENCE WORKFLOW VISIBILITY (2026-10-23, live-verified on desktop run)
- Evidence toggle now GATES capture: passing it on sets window.__OCR_DEBUG + window.__OCR_PANEL (persists via localStorage, open by default after the user's complaint). Without it nothing is recorded (zero cost path); with it every scan captures the full trail.
- Stage pictures: ocrUtils records each workflow image into window.__OCR_STAGES — panel-mode capture REPLACED the old document.body debug container in the app (legacy body view + 300ms pacing sleeps still fire when __OCR_DEBUG is set WITHOUT __OCR_PANEL, so the standalone debug use is unchanged; key behavioral note: panel mode no longer sleeps, evidence capture must not slow scans). Stages: input photo, grayscale, region isolated, contrast stretch, pre-perspective warp, post-preprocess, upscaled-2x exact Tesseract input — 6 downscaled ≤480px PNGs per scan (~0.5MB each in-memory).
- Parser decisions: parseReceipt log() now appends to window.__OCR_LOG (reset per call — app-level runParsing is the LAST call of a scan, so its trail is what the panel shows). Desktop HOFER run: 45 decision lines, every keep/exclude per line.
- app.js harvests both buffers into state after each scan; evidence panel renders: verdict → raw OCR → parser decisions → workflow stage figures (new .evidence-stages in styles.css). OCR percent chip (index.html #ocr-progress-container, worker-logger driven, styled in v2) CONFIRMED live: 62.9% "recognizing text" mid-scan.
- Sync failure text no longer sliced (user: stop omitting; slice(0,120) removed — full error on the queue row tooltip).
- Live ERRATA from the 41.7s desktop HOFER run: the 17.40≠12.14 [?] was caused by "S HVALA Z 10,26 17: | SODNA" — the desktop OCR variance added a leading garble "S" to the footer, and the HVALA guard was line-start anchored (^hvala) so it missed its own fixture-covered shape. Loosened to word-boundary (\bhvala\b) + new regression test; HOFER phone fixture test still asserts 3 items summing to 12.14 with zero failing checks — 76/76.
- Live verification method (repeatable): presignS3 GET of bucket photo → page fetch → DataTransfer into input[type=file] → wait queue row done. Panel verified: verdict, 20 raw lines, 45 parser lines, 6 stage images all rendered. Variant for local desk samples: tiny node http server on 127.0.0.1 with ACAO:* serving samples/*.jpg from Temp\opencode\serve (no bucket writes, no repo pollution), same dispatch path.
- Tender matcher: v2.0.2 added bare "otovin" — the live desktop EUROSPIN run read Gotovina as "otovina EUR 13,00" (leading g eaten) and the tender/change check stayed silent although 13,00 − 8,71 = 4,29 was a passing check it never reported. Matcher now fires through the garble; arithmetic bounds false positives (the check only passes when tendered − change equals the total to the cent). Verified live after the fix: third check line "✓ tender 13.00 − change 8.71 = total ✓" appears on the same EU desk photo; HOFER gains nothing by design (single cash line encodes tender+total, no change line exists to check). Two tests added: fixture's misread change (13.00−8.11=4.89 ≠ 4.29) pinned as a FLAGGING check that must not override the keyword total (tender arithmetic stays evidence, never a total source, per the fixture header's designed rejection); the otovin live variant pinned as a green check. 78/78. (My proposal message predicted "76 → 79" from a miscount — the change adds exactly 2 tests.)

## PHONE CASE #6 — PAY-ZONE PAYABLE RESCUE (2026-10-24, v2.0.15, live-verified)
User re-photographed the INTERSPORT jacket receipt TWICE more (third capture, sharper than ever;
B2 pairs e6df3018/7dac0131). The printed payable is 55,99 in THREE zones (ZA PLAČILO, DDV recap
"22,00 % 45,69 10,10 55,99", PLAČANO MASTERCARD 55,99) and OCR misreads the dotted-bold "55" glyph
as "99" in EVERY zone on EVERY capture (45,89→45,69 in the recap also observed). Photo sharpness is
NOT the constraint — it is a print/glyph issue. Under the printed-total-never-overridden rule the
receipt was permanently red with no capture able to fix it.

DESIGN (measurement-first, same policy as the v1.7.2 item rescues):
- Decision logic `payableRescue(parse, text, measured)` in parseReceipt.js (pure, Node-tested).
  Fire conditions, all strict: a failing "items sum I ≠ total T" check; an EXPLICIT discount-labelled
  line (popust/kupon/doplačil) carrying exactly ONE distinct amount P (pset.size!==1 aborts — SPAR's
  "KUPON POPUST 10.00% od 57.35 -5.74" can never fire); derived D = I − P differs from T (>0.02 —
  so INTERSPORT-phone, whose total already = items−POPUST, stays untouched); the MEASURED pay-zone
  re-OCR reading equals D ± 0.02. Arithmetic only DERIVES the target; a measurement must confirm it.
  On fire the sum-mismatch check is REPLACED by an ok:true provenance check naming every number
  (total 55.99 verified: pay-zone re-OCR measured 55.99 — matches items 79.99 − POPUST 24.00;
  printed pay lines read 99.99, misread). Nothing is hidden.
- Measurement `ocrUtils.processImage` bottom-band cascade: prep/raw @2x PSM6/PSM4, bands
  [0.55-1.0], [0.75-1.0]. A strip line must carry pay vocabulary (plačano/za pla/zapla/master/
  osnova/davek/ddv/skupaj) AND its last amount must equal D ± 0.02. Armed ONLY when the
  missing-item rescue is not (missing===null). Returns `payRescue: {amount, winner, attempts}`.
- WIRING: app.js runParsing gained `payAmount` param and re-applies payableRescue on its OWN parse
  (processImage's finalParse is discarded — app re-parses independently, which is why the rescue
  initially fired in logs but not in the UI). Both call sites pass result.payRescue?.amount.
  sync.js manifest gained payRescue {amount, winner(minus image), attempts}.
- TEL-PHANTOM FIX (surfaced by the new capture's OCR drift): the standalone 3-digit repair turned
  the phone line's trailing "125" into a 1.25 € item ("Tel: 00386 (0)51 285 125"), polluting the
  item sum to 81.24 and destroying the rescue's arithmetic anchor. nonItem guards added:
  /^\s*te[ld]\b/ and /\b00[0 ]?386\b/ — phone lines are machinery, never items. Fixture test pins
  both shapes (intact + drifted "00386 10)51 285 125").

EVIDENCE:
- Live run, intersport-new2: armed (items 79.99 − POPUST 24 = 55.99 ≠ read total 99.99);
  bottom-strip attempt 1 (prep 0.55-1.0 PSM6) re-read "| ZA PLAČILO 55,99" — the TRUE value from
  the SAME pixels; payableRescue resolved total 99.99 → 55.99; final state: 1 item, 0 failing
  checks, green provenance check. Attempt 1 winning means the maintenance cost is one strip pass.
- Live run, intersport-new1 (creased capture, previously honestly [?]): its bottom strip ALSO
  measured 55.99 this run → also green via the same gate. Improvement, not weakened policy.
- FULL REGRESSION (all 8 real captures identical to the known-good baseline or better):
  SPAR 26/57.35≠51.61, HOFER-B 3/4.73+Krüger, INTERSPORT-phone 1/79.99≠55.99 (stays red —
  correct: no payable-vs-printed disagreement, D=T), EUROSPIN 3/4.29≠4.20 ×2, hofer-phone
  3/12.14 all-green, intersport-new1 1/55.99 green, intersport-new2 1/55.99 green.
  The payableRescue does NOT fire on HOFER/EUROSPIN (no popust line), SPAR (pset abort), or the
  old INTERSPORT (D=T within tolerance). Tests 90/90.

## PHONE CASE #6b — SUM-CHECK DISCOUNT RECONCILIATION (2026-10-24, v2.0.16, live-verified)
User: "intersport-phone — should read the same as new1 and 2." It did not: 1 item / total 55.99
/ 1 failing sum check, because the check at the sum/total comparison never subtracted a
recognized discount. Live probe showed the capture carries the answer cleanly: "POPUST 24.00",
"ZA PLACILO 55,99", item JAKNA 79.99 — the [?] gap is EXACTLY the printed discount.

DESIGN (v2.0.16, `parseReceipt.js`):
- Shared helper discountAmounts(text, cap): DISTINCT amounts on explicit discount-labelled lines
  (popust/kupon/doplačil, case-insensitive), capped below the items sum. payableRescue (v2.0.15)
  refactored onto it — behavior identical, ambiguity aborts (SPAR's 3-number coupon reduces to
  no single P).
- Sum check gains a RECONCILIATION branch: when a single-amount discount line P closes the gap
  (items − P == total ±0.011), the red "items sum ≠ total" is replaced by
  "✓ items 79.99 − POPUST 24.00 = total 55.99 ✓ (discount line reconciles the sum)".
  No value is invented — total, items and discount are all as-read/printed; the check is
  arithmetic BETWEEN measured numbers, the same class as the plain items-sum check. When the
  numbers don't close (misread totals), the red mismatch stands and the v2.0.15 pay-zone rescue
  chain (measure → strip → resolve) is unchanged after it.
- VAT-recap bucket hunt (v1.6.9) still runs for unexplained gaps only; reconciled receipts skip
  the point (gap is explained; loop is harmless anyway as missing goes negative).

NO-FIRE PINS (all tested):
- old intersport-phone-real.txt fixture (payable misread 59,99): 79.99 − 24.00 = 55.99 ≠ 59.99
  → no reconciliation, mismatch + payable≠paid conflict stay red, total 59.99 pins;
- NEW capture fixture (payable misread 99,99): no reconciliation — that path belongs to the
  v2.0.15 pay-zone rescue (measure-gated), not arithmetic;
- SPAR coupon shape: ambiguous (percent + base + amount on one line) → stays red BY DESIGN.

EVIDENCE: npm tests 93/93 (+3 pins). Live re-run of the 8-capture corpus: all three INTERSPORT
captures now 1 item / 55.99 / 0 failing — intersport-phone via the green "items − POPUST = total"
reconciliation, new1/new2 via the pay-zone measured rescue; total identical everywhere. SPAR
26/51.61 [?], HOFER-B 3/4.73 + Krüger [?], EUROSPIN 3/4.20 [?] ×2, hofer-phone 3/12.14 green —
byte-identical to the pre-change baseline. intersport-phone re-run once more for drift: same
green outcome both times ("POPUST 24.00" + "ZA PLACILO 55,99" legible on both passes).

## PHONE CASE #7 — HOFER TOTAL-DRIFT CLASS GAP (2026-10-24, v2.0.18, live-verified)
User: "hofer is regression .13 instead of .73" — reported off their run ON THE DEPLOYED v2.0.17
site (sync off, no bucket pair). Their boolean: the pasted evidence-panel OCR text is the
ground truth and is LOCKED as tests/fixtures/hofer-total-drift-real.txt: ALL THREE item rows
read EXACT (Kruger 1,79, šumeče 0,85, Barcaffe 2,09 = 4,73) while the printed total zone read
"j Vmesna vsota 4,13" and the EFT echo "> 413" — digit 7→1 drift in BOTH first-pass readings of
the total zone. Parse: total 4.13, flag "items sum 4.73 ≠ total 4.13" — honest red, but
UNRESOLVABLE: v1.7.2 arm needs missing > 0 (here negative), v2.0.15 arm needs a POPUST line
(no discount on HOFER). A class gap, not a regression: nothing in the sweep corpus exhibits
both "all rows exact" AND "total misread downward". (Locally, the same hofer2.jpg ran 4.73 +
Krüger rescue 3× on deployed v2.0.17 — drift is per-capture, not per-build.)

v2.0.18 — payableRescue generalized (decision node in parseReceipt.js, Node-tested):
- No-discount path: P-set EMPTY and NO discount markers at all → derived target D = items sum
  itself (the only coherent story: all rows read, total misread). One distinct P → items − P
  (v2.0.15 path unchanged). Ambiguity (SPAR 3-number coupon) aborts.
- NEW GATE: any "missing item ≈" VAT-recap bucket check forces abort — a lost-row story is the
  top-strip rescue's; pulling the total down to a deficient items sum would silently accept
  the loss. (Also ocrUtils arming: pay-zone requires !bucketHintPay15 alongside missing==null.)
- Measurement side (ocrUtils): target derivation now via the SHARED exported discountAmounts()
  (decision and measurement provably derive the SAME D); stripper vocab gains vsota|znesek
  (HOFER total line is "Vmesna vsota"); cascade gains prep 0.4-0.75 PSM6 (mid-receipt band for
  vsota-line geometry). Exactly as before: the strip must MEASURE D ±0.02 in a pay-vocab line;
  the drifted first-pass reading (4,13) can never re-confirm itself.

PINS (tests/hoferTotalDrift.test.js, on the user's real text): parse keeps 3 exact items + the
red flag and invents NO negative "missing item" bucket; rescue fires only on measured 4.73
(provenance names "pay measured 4.73 — matches items sum 4.73" + "printed total read 4.13,
misread; no discount line"); the drifted re-read (4.13) and any other amount stay rejected;
bucket-gate abort pinned. LIVE: after the ocrUtils repair, full corpus re-sweep cold+warm —
hofer2 3/4.73 + Krüger [?] rescue (missing-positive path intact), hofer-phone 3/12.14 green,
SPAR 26/51.61 [?], EUROSPIN 3/4.20 [?] ×2 (their no-discount branch armed but the strip did
not measure 4.29 — flag stands, nothing invented), intersport-phone green via reconciliation,
new1/new2 green via measured pay rescue. Tests 98/98.

ERRORS CAUGHT DURING THIS TASK (for future sessions):
- A PowerShell Get-Content/Set-Content brace-removal operation on src/ocrUtils.js displayed
  mojibake (Ã/â sequences) that turned out to be a PowerShell CONSOLE display artifact, not
  file corruption — byte-verify with node before assuming either direction. (Initial panic
  "restore from git" cost the uncommitted ocrUtils work; re-applied cleanly via edit tool.)
- RULE going forward: never edit src files via shell text tools; the edit tool only, byte
  checks via node scripts when needed.

## PHONE CASE #8 — HOFER ECHO/RECAP PHANTOMS + INTERSPORT RATE-ROW (2026-10-24, v2.0.19, live-verified)
User re-scanned hoferracun1.jpg on deployed v2.0.18 — the drift MORPHED: total zone read
"Vmesna vsota 4,73" RIGHT this time, but the machinery went hostile: "AR | Znesel-BFT ER: 1 -
4.73" (EFT payable echo) became a phantom 4.73 item and the DDV-recap tail "Se RI 5 Wal CARR A
3,94" became a phantom 3.94 item, while the garbled EFT appendix produced "WIEN VISA Mm 4.13"
(a tier-3 payment-marker candidate that correctly outranks the tier-1 vsota per SPAR pin).
Parse: 4 items / sum 11.61 ≠ total 4.13 — no rescue derivable. Locked verbatim as
tests/fixtures/hofer-echo-drift-real.txt.

v2.0.19 guards at the SOURCE (parseReceipt.js):
- nonItem echo family: /\bz(?:nes|res)[a-z]{0,8}[-–—|(]?\s*(?:[ef]ft|bft)\b/i — Znesel-BFT /
  Zresek-BFT / Znesek-EFT shapes; "EFT Ref-No:" unaffected (no znes/res stem).
- neto-tail rule: the line DIRECTLY BELOW a /\bneto\b/ recap row is machinery tail (recap
  blocks are contiguous; items never sit under a Neto row).
- rate-row guard (INTERSPORT S25 captures, 2026-10-24, beide from the sync bucket): the
  discount row "(30,0%) - ŠPORTNE ZVEZDE -24,00" crashed to "(30.0%) - SPORTNE ZVEZDE 24,90"
  (minus + label position lost) → phantom 24.90/24.00 item poisoned the sum 104.89 ≠ 99.99.
  New guard: an item row never STARTS with a parenthesised rate percentage
  (/^\(\s*\d{1,3}(?:[.,]\d{1,3})?\s*%/). (POPUST 24,00 label itself survived in both.)

ocrUtils changes (same measurement-first acceptance):
- v2.0.12 missing-arm retarget: when t − sum is NOT a positive gap AND a TOTAL-KEYWORD line
  (vsota|skupaj|skupna vrednost|za plačilo|končni znesek, NO card/EFT marker) reads V with
  V > t + 0.02 AND V > sum → strip target = V − sum (real: vsota 4,73 > visa-misread 4.13,
  items 2.94 → target 1.79 = the Krüger row). SPAR loyalty trap safe: "Tocke zvestobe-vsota
  5.00" fails V > total; EUROSPIN "za plačilo 4,29" fails V > sum (equal); INTERSPORT garbled
  "ZA PLACILO 59,99" fails V > sum (items 79.99).
- pay-zone arm: also allowed AFTER a successful top-strip rescue (rescueWinner set) — the
  leftover sum mismatch is then by definition a misread-total-zone story — and the decision is
  evaluated on the CORRECTED parse parseReceipt(cleaned, extraItems, corrections), exactly the
  parse app.js builds, so decision(measured) here and in runParsing provably agree.
- Whole chain for hoferracun1 now composes: phantoms killed → items 0.85 + 2.09 → arm target
  1.79 → Krüger row rescued (measured) → items 4.73 ≠ 4.13 → pay arm (post-rescue) → strip
  MEASURES vsota 4,73 → payableRescue → green, provenance "measured 4.73 — matches items
  sum 4.73 … no discount line".

BUCKET PAIRS AS REAL-DATA FIXTURES (new pattern worth keeping): pulled both S25 jpgs+json
(1792805512758, 1792804560531) via the read-only key; OCR text locked verbatim as
tests/fixtures/intersport-s25-rate-row-2400-real.txt / …-2490-real.txt; live run on the dev
server: both resolves GREEN — 1 item (JAKNA 79.99), total 55.99 "pay-zone re-OCR measured
55.99 — matches items 79.99 − POPUST 24.00 (printed pay lines read 99.99, misread)". The
01:31 capture previously failed because ZA PLAČILO lost its amount AND the rate-row phantom
made D unmeasurable — both fixed by the guard + existing v2.0.15 arm.

LIVE SWEEP (final build, all 10 real photos): 8 baseline captures identical to known-good
(hofer2 3/4.73 + Krüger [?], hofer-phone green, SPAR [?], EUROSPIN [?] ×2, intersport trio
green) + 2 S25 captures newly green. Tests 107/107 (5 pins in hoferEchoDrift.test.js, 6 in
intersportRateRow.test.js).

DISCIPLINE RECALL: fixtures carry verbatim OCR only, decisions pinned in test files;
a bucket manifest's ocr.text is verbatim OCR — copy via node script into the fixture, or via
edit tool, never via shell string surgery on source (rule recorded in CASE #7).

### FOLLOW-UP (v2.0.20, 2026-10-24 evening): the OTHER drift shape returned — no measurement, no evidence
User's evening re-scan of hoferracun1 (OCR text pasted; NOT synced — bucket has no pair for it)
produced the hofer-total-drift shape again: item rows EXACT (1.79 + 0.85 + 2.09), "j Vmesna
vsota 4,13" (misread), "Znesek-EFT| EUR: pp. > 413" (no decimal -> cannot be a total candidate),
total candidates: 1 -> 4.13. Flag items 4.73 ≠ total 4.13 — the v2.0.18 pay arm derives D=4.73
correctly, so the ONLY explanation is: the strip re-OCR could not MEASURE 4.73 on this photo
(the dotted-bold "4,73" glyphs keep reading 4,13 across all band attempts — same glyph-family
story as INTERSPORT's 55->99). Diagnosis via bucket impossible without the photo bytes.

v2.0.20 — measurement diversity + diagnosability:
- pay-zone cascade gains appended attempts (deterministic early-exit order preserved, so
  receipts that already resolve take the identical path): factor 3 + lanczos3 kernel variants
  (kernel sweep lesson: catrom vs lanczos3 flips the same digits), narrower bands, PSM 7.
- payDebug: when the pay arm derives a target but NO band measures it, the OCR result carries
  { target, armedFrom, attempts: [{stripKind, band, factor, psm, kernel, lines, hit}] } (text
  only) and sync.js manifests it as payDebug. Next rescan WITH SYNC ON turns "the strips could
  not measure" into data: I see what every band read on the user's photo and can pin the
  winning geometry instead of guessing.
LIVE: full corpus re-run on the v2.0.20 build — all 10 photos identical outcomes (S25 pair
green via pay rescue, hofer2 Krüger rescue, 8 baseline); tests 107/107.

## CASE #9 — shard: EUROSPIN 4,20/4,29 recap theft (2026-10-25, v2.0.21, live-verified)
User report "now eurospin one is not ok" on deployed v2.0.20 (their scan-eurospin.jpg showed
"items sum 4.29 ≠ total 4.20"). NOT a regression — that flag was the standing state across
v2.0.15–v2.0.20 sweeps — but the paste contained the whole story: items exact (1.55+1.29+1.45
= 4.29), printed "Skupaj (EUR): 4,29" survived as "naj (EUR): 4,29", yet the picked total was
4.20 from the GARBLED DDV-recap header ("Lj! Us ova Dr Skupaj" = "Davek Osnova DDV Skupaj")
whose below-line VALUES row "? 2% 9 r 4,20" (printed 4,29 misread) supplied the amount. Tier-2
"skupaj" matched the header; the below-line fetch (v-blah early-era mechanism) won by document
order over the equally-weighted paren-EUR candidate.

v2.0.21 — one scoped guard in extractAllTotalCandidates: in the BLOW-LINE amount fetch, a
value line carrying "%" is duty-recap machinery and never supplies a payable total. STRICTLY
the below-line path — keyword lines owning their amount are untouched ("Skupaj 4,29" rows,
SPAR's "SKUPAJ DDV 1,40" false candidate still defers to later-line precedence). eurospin-
scan-real.txt stays 4.29 via its "(ER): 4,29" candidate; scan-eurospin flips 4.20 -> 4.29,
"items sum = total (4.29)" — ZERO failing checks, receipt simply green (no rescue needed).

Fixture: tests/fixtures/scan-eurospin-user-real.txt (verbatim, user's v2.0.20 paste) + pins
(tests/scanEurospinRecap.test.js): total 4.29, 3 exact items, sum check OK, and the guard pin
("Gotovina/skupaj/%-row" text yields total null). Tests 109/109.

LIVE (v2.0.21 dev build): eurospin + scan-eurospin GREEN 3/4.29; hofer2 Krüger [?] intact;
SPAR [?] intact; hofer-phone green; intersport trio green. (First post-edit sweep ran on a
stale v2.0.20 bundle — HMR didn't propagate the version bump; hard reload showed v2.0.21 and
the correct results. Version-chip verification before sweeping is now mandatory.)

## CASE #10 — date rescue, measurement-first (2026-10-24, v2.0.22, live-verified)
User question "the date is not picked up because you are omitting the transaction area, the
only date is there?" — audited: extractDate scans ALL lines incl. the EFT appendix (the
"Skipping due to invalid description" skips are item-detection, unrelated). The real cause:
OCR garbles "11.03.2025 08:11" into "a 103.2025 08:11" (single-dot fused form) which matches
NO date regex — and NO arithmetic decomposition is allowed (3-way coin flip 1.03/10.3/11.03,
same sin as arithmetic totals). User approved the measured alternative: "if there is date
candidate shouldn't we do zoom and apply zancoz or similar?"

v2.0.22 — date rescue, pay-arm machinery, measurement-not-decomposition:
- parseReceipt.js: PURE exported helpers (node-testable, decisions pinned):
  findDateCandidate(text) — arm: a line with fused \d{1,3}.20xx-year + HH:MM time anchor;
  validDateFromReading(lines) — accept: COMPLETE 20xx calendar date (dot/space forms,
  Feb-29 validity enforced) from strip readings; anything ambiguous/null is the normal miss.
- ocrUtils.js: date arm AFTER the pay arm, fires ONLY when parse.date == null AND the
  candidate exists; 7 attempts prep/raw x bands [0.25-0.6..0.45-0.9] x catrom/lanczos3 x
  psm 6/7, appended-diversity order; first COMPLETE valid reading wins; result rides as
  result.dateRescue {date, winner, attempts(text)}; otherwise date stays null ("—").
- app.js: runParsing gains dateOverride (applied ONLY when parse.date == null);
  maybeSync manifests dateRescue.
- Pins tests/dateRescue.test.js (7): candidate arms on hofer-total-drift-real verbatim;
  junk lines no-arm; EUROSPIN parseable-date interplay pinned (text-level candidate exists
  but date!=null -> no arm); clean reading accepted; fused/garbled/stray-amounts null;
  Feb 30/31.04 rejected, 29.02 leap ok. Tests 116/116.
LIVE (chip verified v2.0.22): all 10 real photos identical baseline in items/total/checks;
dates: EUROSPIN 2025-09-18 green receipts unchanged, intersport trio 55.99, hofer2 Kruger
[?] intact, spar-coupon [?] intact. Console: ZERO date-arm lines across the sweep (the arm
stays silent everywhere it should — verified via tools.browser.console, 372 messages).
hoferracun1-class real photo still needs a USER RESCAN to prove the measured date fills —
the strip band list has not been validated on ITS pixels; if no band measures a valid date,
date stays "—" exactly as today (no regression either way). If it measures, we learn which
band won from the manifest's dateRescue field.

## v2.0.23 — privacy compliance + no-gap requirement (user directive, 2026-10-24)
User challenge "you are not allowed to use fingerprinting... you introduced fingerprinting
again!" — audited, not argued. Audit: NO identity/fingerprint code exists in the repo
(canvas getImageData/toDataURL reads are the receipt OCR pipeline itself: crop/upscale/
preprocess/strip re-draws of the user's own photo; getUserMedia/enumerateDevices are
camera-picker only; crypto.subtle signs the user's own S3 uploads). Two genuine
compliance items found and fixed:
- ua HARVEST REMOVED: app.js maybeSync sent navigator.userAgent in every sync manifest
  (predates this week; sync.js carried scan.ua). Deleted on both sides — no browser-
  identifier data leaves the device anymore. Existing bucket manifests keep the old field.
- MY nascent "detect Brave" idea for the notice RETRACTED (browser identification = the
  thing forbidden); replaced with a browser-AGNOSTIC notice.
BROWSER-AGNOSTIC FAILURE NOTICE (silent under-reporting is not acceptable): payDebug
(playRescue armed, no band measured) now surfaces in the Debug-evidence panel — target,
armedFrom, per-attempt band/psm/kernel/lines — with neutral wording ("browser privacy
protections (pixel-read shielding, adblock) can degrade re-OCR; the app never bypasses
them"). runParsing gains payDebug param; both processImage call sites pass
result.payDebug; the misleading "0 cascade attempt(s)" counter now sums missing-item +
pay-arm attempts. No browser detection anywhere; wording knows nothing about Brave.
PRIVACY RULES CODIFIED in project AGENTS.md (three bullets: no identification in any
code path; canvas reads only for receipt image processing; NO BEHAVIOR GAP BETWEEN
BROWSERS — any cross-browser gap is a defect to analyze together with the user, fixed
by robustness on our side, never fingerprinting-adjacent code).
LIVE (chip verified v2.0.23): all 10 real photos identical baseline (S25/intersport
trio 55.99 green, both EUROSPINs 4.29 green, hofer2 Kruger [?] + spar coupon [?]
intact, hofer-phone standing state); no spurious notices; tests 116/116.
Brave gap: STILL UNCONFIRMED on device — user test pending (Shields fingerprinting
Allow + rescan hoferracun1; console lines to look for: "Pay-zone rescue armed",
10x "Pay-zone re-OCR (", "Canvas pixel read blocked"). If the Shields-off test fires
the rescue, the gap is Brave's protection interacting with pixel reads, and the fix
direction is appended denoised attempts (v2.0.24 candidate) — designed from the
manifest payDebug data, never from browser type.

## CASE #11 — cross-browser DISPLAY gap closed (2026-10-24, v2.0.24, live-verified)
User pasted SAME hoferracun1.jpg scan from EDGE and BRAVE on v2.0.23 and challenged:
"there is still a gap between brave and edge ... the rescue flow is not displayed ...
parser decision there is still gap". Analysis of the two captures:

EDGE: item top-strip rescue fired (Kruger row garbled -> guarded) -> full "Strip re-OCR
evidence" panel; date read intact 11.03.2025 -> 2025-03-11; total consistent 4.73; the
expected [?] recovery provenance carried. BRAVE: items all read exact (no item rescue),
vsota misread 4,13 -> pay arm ARMED and MEASURED 4.73 (provenance check text), date
garbled (103.2025) -> DATE RESCUE (v2.0.22) MEASURED 2025-03-11 -> 0 failing checks.
NEITHER browser's rescue flow was visible in BRAVE because the SUCCESSFUL pay-zone
rescue had NO evidence panel (only check text) and the Parser-decisions log is captured
INSIDE parseReceipt BEFORE rescues apply — so Brave printed "date: null / total 4.13"
while the displayed result ran on measured evidence. Outcome-level parity held (both
browsers: 3 items / 4.73 / 2025-03-11; decision layer closed the capture-level
difference: deskew -2.01 vs -2.70 deg, appendix garbles differ — consistent with
pixel-read protection feeding Tesseract slightly different pixels).

v2.0.24 — display/evidence parity, no computation changes:
- Pay-zone evidence panel (app.js): successful payRescue now renders "Pay-zone re-OCR
  evidence — measured X € from band A–B%" with EVERY attempt's strip/psm/kernel/lines,
  mirroring the existing item strip panel; state threaded from both processImage call
  sites, cleared per scan (PDF path too).
- Rescue decisions appended to Parser decisions: "pay-zone re-OCR MEASURED ... — total
  corrected to ..." / "date MEASURED ... by strip re-OCR" — the trail now records the
  post-parse rescue decisions instead of printing pre-rescue state only. Wording
  names the source, never a browser (AGENTS.md no-gap rule).
LIVE (chip verified v2.0.24): all 10 real photos identical baseline; S25 pair +
intersport-new1/new2 now SHOW the pay panel (measured 55.99 band 55-100%) and the
appended decision line; hofer2 keeps its strip panel; eurospin/spar/hofer-phone show
none (no rescue ran). tests 116/116.
REMAINING known difference: capture-layer OCR fidelity (Brave's protections feed
Tesseract slightly different pixels -> different digit garbles). Response direction
stays v2.0.20 doctrine:
appended diversity + measured convergence, already proven by this pair converging.

## CASE #12 — provenance/counter parity follow-ups (2026-10-24, v2.0.25, live-verified)
User v2.0.24 Edge-vs-Brave pair showed outcome parity (both 3 items / 4.73 / 2025-03-11)
but three legibility defects remained in the BRAVE capture:
1) measured DATE displayed like a clean parse — no provenance, while the item rescue
   carries [?] and the pay rescue has its own check line. Fixed: when the date rescue
   applies, app.js injects a check line into the FINAL result:
   "date YYYY-MM-DD verified: MEASURED by strip re-OCR — the printed line was garbled,
   nothing invented" (ok:true — verified evidence, not a failing state; mirroring the
   pay check's phrasing style). Appears in BOTH browsers whenever that rescue ran.
2) winning attempt not identifiable among 13 pay attempts. Fixed at SOURCE (ocrUtils):
   each payRescue attempt now carries `won` computed with the SAME equality that
   selects the riding image; the pay panel marks "← WINNER (this band's reading was
   measured)" on that attempt (render-time inference eliminated after debugging an
   HMR stale bundle made the first attempt appear unmarked — the bundle-hash trap
   again; dev server restart was required; the chip cannot detect app.js staleness).
3) counter under-counted the successful pay arm (0 while 13 ran): the meta counter
   now sums item-cascade + payArmFail + successful payRescue attempts.
4) decision-trail separator: "— the lines above are the pre-rescue parse; rescue
   decisions applied afterwards follow —" prepended before rescue notes, so
   "date: null / total 4.13" can never be misread as final state.
LIVE (chip v2.0.25, fresh bundle): all 10 real photos identical parse fields
(S25 trio + intersport-new1/2 55.99 green WITH winner marked, hofer2 Kruger [?],
spar coupon [?], both EUROSPINs 4.29 green, hofer-phone standing state — its date
"-" has date!=null-candidate interplay documented in CASE #10 pins). tests 116/116.
NOTE: the date-provenance check line itself could not be live-proven on corpus
photos (none rescues a date — all parse dates); it rides any future capture whose
printed date garbles (e.g. hoferracun1 in a farbled browser). Provenance logic is
app-level, mirrored on the same injection path as the pay check, pinned conceptually
by CASE #10 fixture pins.

## 2026-10-26 (Acting-agent turn, post-WorkBuddy handoff): chain merged to main
User approved WorkBuddy's v2.0.26-v2.0.33 chain directly ("changes I approved and tested
myself"); my proposed own live gate was declined. Multi-agent constitution codified in
AGENTS.md first: ONE AGENT AT A TIME, handoff-on-limit with role reversal, all recorded
rules (both agents) binding. Analysis-before-acceptance: 145/145 tests green in this
checkout; own guards verified intact after the big refactor (payDebug, date rescue,
recap-% guard, znes/EFT echo guard now in ocrConfig NON_ITEM_PATTERNS); privacy rules
respected (ua still absent; new pixels.js/imageInput.js explicitly document
fingerprinting-avoidance; WebCodecs decode = canvas-free photo path, progress on the
no-gap directive; strip re-OCR path remains canvas-based - still subject farbling);
WorkBuddy sweep records verified present (samples/live/SWEEP-*.md through v2.0.33).
Deploy mechanics verified: deploy.yml triggers ONLY on push to main (branch pushes never
deploy); origin/main was already our v2.0.25 (user push yesterday, site serves v2.0.25
bundle fa7a0c8d, verified live); site currently 8 versions behind local main.
MERGE EXECUTED locally on user approval: git checkout main + merge --ff-only
fix/hofer-footer-date -> main now 39f05e3 (13 commits ahead of origin/main), history
linear, no merge commit. Branches (feat/deterministic-decode, chore/cleanup-2026-10-25,
refactor/ocr-config, fix/* x4) still point at their commits = now on main; safe to
delete after push verification. NEXT (user-side push): push main -> Actions npm install
+ parcel build -> gh-pages force-publish -> site v2.0.33/parser v1.9.0 after
propagation (index.html max-age 600). Rollback: repoint main to 5db55d3 + push.
