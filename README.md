# receipt-ocr-test

Client-side Slovenian receipt OCR — runs entirely in the browser, nothing uploaded.

- **App (canonical)**: this root — `src/`, built with Parcel, deployed to GitHub Pages via `.github/workflows/deploy.yml` (CI builds into `docs/` with public URL `/receipt-ocr-test/`).
- **Engine**: tesseract.js v7 (`slv+eng`) with a repair pipeline: band/strip re-OCR cascades, arithmetic verification of candidates, all-or-nothing corrections, and provenance — re-measured prices are visibly marked.
- **Tests**: `npm test` (133 parser tests over real-receipt OCR fixtures in `tests/fixtures/`).
- **Develop**: `npm install && npm start` (Parcel dev server); `npm run build` for a production build in `dist/`.
- **`NOTES.md`**: engineering ledger — milestones, decisions, debts.

Receipt photos in `samples/` are local-only (git-ignored).
