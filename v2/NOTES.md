# v2 — session state ledger

Last updated: 2026-10-21. Purpose: fresh sessions resume from here, not from chat memory.

## What this is

Client-side Slovenian receipt OCR (tesseract.js v7 + OpenCV.js stages + parser).
`v2/` is a self-contained standalone package: own deps, tests, build (Parcel → `v2/dist`).
Root (`../src`) is v1: untouched, remains the only GitHub Pages deploy. Parsers have
diverged deliberately — do not "sync" without the canonical-swap decision (see Debts).

## Current state (all verified by tests)

- Parser `src/parseReceipt.js` version v1.6.6 state: keyword-tier totals
  (za plačilo > skupaj > znesek, LAST wins per tier), payment markers
  (`masterca`, `maest/rco`, `karticao`, `visa`, `eft`, `hofer cena` — NOT `gotovina`/`cash`:
  tender-side, can exceed payable), structural currency-tag rule
  (`(EUR):/(FUR):/(ER): + amount` → weight-2 candidate), arithmetic cross-checks
  (`checks[]`: items-sum vs total, tender−change vs total — flags only, app renders
  ✓ / `[?]` lines; SPAR coupon case respected), nonItem rules:
  `ovin` (gotovina garbles), `denar`, `vračilo`, `cash`, `EUR`-token, VAT-code
  anchors (`kd, 0%`), `(EUR):` fragments, popust/doplačil/discount, digit-storm
  separators, 3-letter name garble guard, 3-digit int repair (181→1.81).
- Pipeline `src/ocrUtils.js`: grayscale → **bright-mask receipt isolation**
  (Otsu + close 15×15 + largest-bright-region bbox + 2% margin + sanity guards,
  replaced broken fixed-240 dark-mask autoCrop) → **contrast stretch**
  (convertScaleAbs 1.6, −80) → deskew → perspective → 2× upscale → tesseract
  (`slv+eng`, PSM 6, DPI 300, preserve_interword_spaces).
- Tests: `npm test` in v2 → 31/31. Fixtures in `tests/fixtures/`:
  `spar-scan-real.txt`, `spar-scan-v2.txt`, `spar-scan-v3.txt`, `hofer-scan-real.txt`,
  `eurospin-scan-real.txt` (Node OCR of tight crop), `eurospin-browser-garble.txt`
  (uncropped browser run), `generic-si.txt` + others.

## Corpus status

| Receipt | Result |
|---|---|
| SPAR photo | 26/26 items, total ✓, date ✓ |
| HOFER photo | 2/3 items (Krüger 1,79 clipped by original photo frame — unrecoverable), total ✓ |
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
