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
