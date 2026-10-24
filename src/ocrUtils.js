import { createWorker } from "tesseract.js";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.js";
import { parseReceipt, namesScore, namesSimilar, payableRescue, discountAmounts } from "./parseReceipt";

GlobalWorkerOptions.workerSrc = pdfWorker;

// --- tesseract.js v7 worker: created once, reused for every page/image ---
// Params are delivered through setParameters (the v4 recognize-options path never
// applied them). Removed vs. v1 config: tessedit_ocr_engine_mode (now the createWorker
// argument), tessedit_char_whitelist (LSTM + whitelist misfires; strips diacritics),
// textord_heavy_nr (legacy-engine only, was always dead code at oem 1).
// Added: user_defined_dpi (fixes "Invalid resolution 0 dpi" defaulting to 70),
// preserve_interword_spaces (keeps SPAR-style multi-column spacing alive).
const tessParams = {
  tessedit_pageseg_mode: "6",
  preserve_interword_spaces: "1",
  user_defined_dpi: "300",
};

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker("slv+eng", 1, {
      logger: (m) => {
        if (m.status && typeof m.progress === "number") {
          updateOCRProgressUI(m.status, m.progress);
        }
      },
    }).then((w) => w.setParameters(tessParams).then(() => w));
  }
  return workerPromise;
}

/**
 * Upscale the preprocessed image before OCR. Empirical result on the real SPAR
 * photo (scripts/ocr-benchmark.mjs): 2x upscale lifted item recognition from
 * 20/26 to 23/26 and produced clean decimal prices on every item column,
 * including cases the 1:1 pipeline read wrong ("1198" = 1.19 became 1.19).
 * Matches tesseract docs: "image should be sufficiently high resolution; the
 * same image often gets much better results if you upscale before recognize".
 */
function upscaleDataURL(dataURL, factor = 2) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * factor);
      canvas.height = Math.round(img.height * factor);
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = dataURL;
  });
}

function preprocessWithOpenCV(imageSrc, options = {}) {
  return new Promise((resolve, reject) => {
    if (typeof cv === "undefined" || !cv.imread) {
      reject(new Error("OpenCV.js (cv) is not loaded or initialized."));
      return;
    }
    const {
      grayscale = true,
      deskew = true,
      perspectiveCorrection = true,
      unsharpMask = false, // measured harmful on receipt digits (benchmark2 D)
      smoothing = false,
      thresholding = false,
      adaptiveThresholding = false, // measured harmful: digital noise amplification
      morph = false,
      denoise = false,
      clahe = false, // measured CATASTROPHIC on thermal receipts: 24/26 -> 4/26 items, corrupts digits ("1.19" -> "149")
      invert = false, // measured: small accuracy loss (benchmark2 B)
      autoCrop = true, // v1.6.2: bright-mask receipt-region crop, run EARLY (before deskew). The old
      // late-stage cropToContent was measured harmful (fixed 240 BINARY_INV dark-mask ->
      // selected the BACKGROUND on cluttered photos and cropped into the receipt), so it
      // was disabled; the new crop isolates the paper before geometry stages run.
      autoCropMode = "axis", // v2.0.9: "axis" (default, bbox cut) or "rotated" — tight
      // TEXT-ALIGNED selection (white background fill outside the paper's
      // text-aligned quad, zero pixel rotation — see cropToReceipt). The old
      // "rotatedFlip" sign channel is retired: the selection rotates nothing,
      // so there is no sign left to flip; both names behave identically now
      // (kept accepted for old __OCR_OPTS evidence scripts).
      // v2.0.5: the rotation angle comes from text-line direction (textAngleOf),
      // NOT minAreaRect — that one reported junk ~10° on a ~0° tilted receipt.
      // v2.0.5: rotation sign for the text-angle correction. NUMERICALLY
      // settled (EUROSPIN live A/B, Hough length-weighted text angle):
      // original −3.44°; after getRotationMatrix2D(+3.45°) ("pos") the final
      // text angle measured −3.1..−4.9° — "pos" rotated text AWAY from
      // horizontal (this build's +θ turns content the visually-opposite way
      // vs the docs' wording); after "+neg" (−3.45°) the deskewed stage
      // measured +1.06° ≈ flat. So the correct flattening angle is −T.
      // "neg" default; "pos" still selectable via window.__OCR_OPTS for A/Bs.
      textAngleSign = "neg",
      contrastStretch = true, // v1.7: linear a=1.6 b=-80 after crop. Measured on EUROSPIN
      // (ocr-eurospin2): contrast-stretched OCR read 3/3 item amounts (1,55/1,29/1,45),
      // unstretched read 0-2/3. Thermal print contrast is naturally low after crops.
    } = options;
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = async () => {
      console.log("🖼️ Image loaded:", img.width, "x", img.height);
      // v1.7.7: intermediate stage previews + pacing sleeps are DEV-ONLY
      // (same switch as the parser: window.__OCR_DEBUG). Previously every
      // scan appended a fresh container to document.body that was never
      // removed (DOM + pixel-memory leak per scan) and paid ~5 × 300ms of
      // pure sleep on every receipt, healthy ones included.
      // v2.0.2: two debug views behind the same capture data:
      //   - panel mode (window.__OCR_PANEL, set by app.js): stages are
      //     recorded as downscaled PNG sources into window.__OCR_STAGES for
      //     the evidence panel — no body DOM, NO pacing sleeps (they made
      //     evidence mode measurably slower for zero benefit)
      //   - standalone debug view (legacy body container + 300ms pacing),
      //     preserved unchanged for the console/debug use it was built for
      const debugStages = typeof window !== "undefined" && window.__OCR_DEBUG === true;
      const panelView = debugStages && window.__OCR_PANEL === true;
      const bodyView = debugStages && !panelView;
      const stagesBuf = debugStages ? (window.__OCR_STAGES = []) : null;
      const container = bodyView ? document.createElement("div") : null;
      if (container) {
        container.style.display = "flex";
        container.style.flexWrap = "wrap";
        container.style.gap = "10px";
        container.style.margin = "20px 0";
        container.style.border = "1px solid #ccc";
        container.style.padding = "10px";
        container.style.background = "#fafafa";
        document.body.appendChild(container);
      }
      // Downscaled PNG for the stage record: full-res OpenCV mats can be
      // 9000×12000 after the 2× upscale — their PNG strings would eat tens of
      // MB of tab memory per scan. ≤480 px keeps every scan's set of stages
      // small enough to keep across the session.
      function recordStage(mat, label) {
        if (!stagesBuf) return;
        const big = document.createElement("canvas");
        big.width = mat.cols;
        big.height = mat.rows;
        cv.imshow(big, mat);
        const w = Math.min(480, big.width);
        const h = Math.max(1, Math.round(big.height * (w / big.width)));
        const small = document.createElement("canvas");
        small.width = w;
        small.height = h;
        small.getContext("2d").drawImage(big, 0, 0, w, h);
        stagesBuf.push({ label, dataURL: small.toDataURL("image/png") });
      }
      function showIntermediate(mat, label) {
        if (panelView) {
          recordStage(mat, label);
          return;
        }
        if (!container) return;
        const wrapper = document.createElement("div");
        wrapper.style.textAlign = "center";
        wrapper.style.fontFamily = "sans-serif";
        wrapper.style.fontSize = "12px";
        wrapper.style.maxWidth = "480px";
        wrapper.style.marginBottom = "10px";
        const labelEl = document.createElement("div");
        labelEl.textContent = label;
        labelEl.style.fontWeight = "bold";
        labelEl.style.marginBottom = "6px";
        const canvasEl = document.createElement("canvas");
        canvasEl.width = mat.cols;
        canvasEl.height = mat.rows;
        canvasEl.style.width = "480px";
        canvasEl.style.height = "auto";
        canvasEl.style.border = "1px solid #eee";
        canvasEl.style.boxShadow = "0 0 6px rgba(0,0,0,0.12)";
        wrapper.appendChild(labelEl);
        wrapper.appendChild(canvasEl);
        container.appendChild(wrapper);
        cv.imshow(canvasEl, mat);
      }
      function delay(ms) {
        if (!bodyView) return Promise.resolve();
        return new Promise((res) => setTimeout(res, ms));
      }

      // v2.0.4: text-line angle estimator. Both previous rotation sources
      // (deskew's minAreaRect on the biggest Otsu blob and the rotated crop's
      // same measurement) BREAK on near-upright paper: OpenCV 4.5+ returns an
      // arbitrary box angle (live INTERSPORT evidence: raw ~10° on a ~0-1°
      // tilted receipt, so the "correction" rotated a straight receipt 10°
      // the wrong way and the deskew then measured <1° on the messed-up blob
      // and skipped). The receipt's TEXT direction is the ground truth:
      // Canny + Hough lines, near-horizontal window, length-weighted mean.
      // Tight quartiles measured on the real photo: original +0.9°, σIQR 1.5°.
      function textAngleOf(mat) {
        const edges = new cv.Mat();
        cv.Canny(mat, edges, 60, 150);
        const lines = new cv.Mat();
        cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 60, 60, 12);
        let n = 0, lenSum = 0, angSum = 0;
        for (let i = 0; i < lines.rows; i++) {
          const x1 = lines.data32S[i * 4], y1 = lines.data32S[i * 4 + 1];
          const x2 = lines.data32S[i * 4 + 2], y2 = lines.data32S[i * 4 + 3];
          const len = Math.hypot(x2 - x1, y2 - y1);
          const ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
          if (Math.abs(ang) < 20 && len >= 40) {
            n++;
            lenSum += len;
            angSum += ang * len;
          }
        }
        edges.delete();
        lines.delete();
        if (n < 12) return null; // too few confident baselines — don't rotate
        return angSum / lenSum;
      }
      // rotate content about a center, enlarging the canvas so corners
      // survive, and fix the translation into the new frame
      // (getRotationMatrix2D returns CV_64FC1 — data32F alias corrupts)
      function rotatedMat(mat, angle, center, fillWhite = true) {
        const M = cv.getRotationMatrix2D(center, angle, 1.0);
        const cosv = Math.abs(M.data64F[0]), sinv = Math.abs(M.data64F[1]);
        const nW = Math.round(mat.cols * cosv + mat.rows * sinv);
        const nH = Math.round(mat.cols * sinv + mat.rows * cosv);
        M.data64F[2] += nW / 2 - center.x;
        M.data64F[5] += nH / 2 - center.y;
        const out = new cv.Mat();
        cv.warpAffine(
          mat, out, M, new cv.Size(nW, nH),
          cv.INTER_LINEAR, cv.BORDER_CONSTANT,
          fillWhite ? new cv.Scalar(255, 255, 255, 255) : new cv.Scalar(0, 0, 0, 255)
        );
        M.delete();
        return out;
      }

      function maskOf(m) {
        // Otsu bright mask + closing: the paper is the bright region
        // (thermal paper vs dark background); closing bridges fold shadows
        // that would otherwise split it into several blobs.
        const binary = new cv.Mat();
        cv.threshold(m, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
        const closed = new cv.Mat();
        cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);
        binary.delete();
        kernel.delete();
        return closed;
      }

      function cropToReceipt(mat, mode = "axis") {
        // v2.0.11 PROJECTION-PROFILE CUT — selection only, NO rotation, NO
        // contours (user's crop, validated live: the paper is the brightest
        // surface, so at an absolute 160-threshold each COLUMN/ROW through
        // the paper scores a high bright-fraction while desk/keyboard rows
        // score ~0 despite glare speckle). History: contour-bbox selected
        // paper+glare and kept 94% of the INTERSPORT frame; minAreaRect
        // rotate-cuts sheared the text (entered the rotation-loop); the
        // text-aligned selection-crop executed but its locator (Otsu blob)
        // covered the paper everywhere it existed. On EU the cut reproduces
        // the user's manual crop boundaries (live probe: x[234..901],
        // y[386..~1490] vs measured paper edges y 390..~1480 via strip
        // brightness), on INTERSPORT it is a ~no-op (full-frame paper ✓).
        // Fail-safes: no qualifying band → fall back to the old contour
        // bbox; profiles are smoothed (moving average, ~4% frame) so fold
        // shadows inside the paper never split the band.
        // v2.0.11 INK-EDGE second rule (user proposal: "find the edge of
        // ink which is black and crop 10% around"): scan-style captures on
        // a WHITE background (the SPAR scan probe: background gray 221-254
        // vs paper 236 — every column clears the paper cutoffs 3×) keep
        // 100% of the frame under the bright rule because background ≈
        // paper brightness. When the paper band covers ≥98% of the frame,
        // select by the ink instead: dark-pixel (<128) profile bands with
        // a 2% dark-fraction cutoff, outermost 1% ring ZEROED first (scan
        // page borders are black LINES, not receipt ink — SPAR probe:
        // cols 0-10 mean gray 14 dragged the band to x=0 while cols 10-400
        // are pure white), then cut with a 10% margin (user spec; sanity
        // floor 25%×25%). GATED to the full-frame-bright case: on
        // dark-background photos the ink mask also sees the background
        // (HOFER probe: the ink band would cut away the TOP 57% of the
        // receipt) — there the paper band trims and ink never runs.
        let result = null;
        try {
          const W = mat.cols, H = mat.rows;
          const binary = new cv.Mat();
          cv.threshold(mat, binary, 160, 255, cv.THRESH_BINARY);
          const cols = new cv.Mat(), rows = new cv.Mat();
          cv.reduce(binary, cols, 0, cv.REDUCE_AVG, cv.CV_32F);
          cv.reduce(binary, rows, 1, cv.REDUCE_AVG, cv.CV_32F);
          const smooth = Math.max(11, Math.round(Math.min(W, H) * 0.04) | 1);
          const findBand = (data, len, frac) => {
            let a0 = -1, a1 = -1;
            for (let i = 0; i < len; i++) {
              let sum = 0, cnt = 0;
              for (let q = Math.max(0, i - smooth); q <= Math.min(len - 1, i + smooth); q++) { sum += data[q]; cnt++; }
              if (sum / cnt / 255 >= frac) { if (a0 < 0) a0 = i; a1 = i; }
            }
            return a0 < 0 ? null : [a0, a1];
          };
          // rows admit a slightly lower fraction than columns (shadowed
          // paper edges thread the bottom rows: probe 0.63-0.85 bright).
          const band = {
            x: findBand(cols.data32F, W, 0.3),
            y: findBand(rows.data32F, H, 0.2),
          };
          cols.delete(); rows.delete(); binary.delete();
          if (band.x && band.y) {
            const bandArea = (band.x[1] - band.x[0] + 1) * (band.y[1] - band.y[0] + 1);
            if (bandArea >= 0.98 * W * H) {
              // full-frame band = bright-background (scan-style) case:
              // ink-edge stage selects by the dark pixels instead
              const ink = new cv.Mat();
              cv.threshold(mat, ink, 128, 255, cv.THRESH_BINARY_INV);
              const ring = Math.round(Math.max(W, H) * 0.01);
              const black = new cv.Scalar(0, 0, 0, 0); // erase scan-border lines
              cv.rectangle(ink, new cv.Point(0, 0), new cv.Point(W - 1, ring - 1), black, -1);
              cv.rectangle(ink, new cv.Point(0, H - ring), new cv.Point(W - 1, H - 1), black, -1);
              cv.rectangle(ink, new cv.Point(0, 0), new cv.Point(ring - 1, H - 1), black, -1);
              cv.rectangle(ink, new cv.Point(W - ring, 0), new cv.Point(W - 1, H - 1), black, -1);
              const icols = new cv.Mat(), irows = new cv.Mat();
              cv.reduce(ink, icols, 0, cv.REDUCE_AVG, cv.CV_32F);
              cv.reduce(ink, irows, 1, cv.REDUCE_AVG, cv.CV_32F);
              const ib = {
                x: findBand(icols.data32F, W, 0.02),
                y: findBand(irows.data32F, H, 0.02),
              };
              ink.delete(); icols.delete(); irows.delete();
              if (ib.x && ib.y) {
                const bw = ib.x[1] - ib.x[0] + 1, bh = ib.y[1] - ib.y[0] + 1;
                if (bw >= 0.25 * W && bh >= 0.25 * H) {
                  const mx = Math.round(W * 0.10), my = Math.round(H * 0.10);
                  const x = Math.max(0, ib.x[0] - mx);
                  const y = Math.max(0, ib.y[0] - my);
                  const w = Math.min(W - x, bw + 2 * mx);
                  const h = Math.min(H - y, bh + 2 * my);
                  const roi = mat.roi({ x, y, width: w, height: h });
                  result = roi.clone();
                  roi.delete();
                  console.log("✂️ Receipt region (ink-edge cut, no rotation):",
                    JSON.stringify({ x: +(x / W).toFixed(3), y: +(y / H).toFixed(3), w, h }));
                }
              }
            } else {
              const mx = Math.round(W * 0.02), my = Math.round(H * 0.02);
              const x = Math.max(0, band.x[0] - mx);
              const y = Math.max(0, band.y[0] - my);
              const w = Math.min(W - x, band.x[1] - band.x[0] + 1 + 2 * mx);
              const h = Math.min(H - y, band.y[1] - band.y[0] + 1 + 2 * my);
              const roi = mat.roi({ x, y, width: w, height: h });
              result = roi.clone();
              roi.delete();
              console.log("✂️ Receipt region (profile cut, no rotation):",
                JSON.stringify({ x: +(x / W).toFixed(3), y: +(y / H).toFixed(3), w, h }));
            }
          }
        } catch (e) {
          console.log("↩️ profile cut failed, falling back to contour bbox:", e && e.message);
        }
        if (!result) {
          // fallback: previous default (largest-bright-blob bbox + margin).
          let closed = maskOf(mat);
          const contours = new cv.MatVector();
          const hierarchy = new cv.Mat();
          cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
          let maxContour = null;
          let maxArea = 0;
          for (let i = 0; i < contours.size(); i++) {
            const contour = contours.get(i);
            const area = cv.contourArea(contour);
            if (area > maxArea) {
              maxArea = area;
              maxContour = contour;
            }
          }
          if (maxContour) {
            const rect = cv.boundingRect(maxContour);
            const imgArea = mat.rows * mat.cols;
            const boxOk = rect.width >= 0.25 * mat.cols && rect.height >= 0.25 * mat.rows && rect.width * rect.height >= 0.15 * imgArea;
            if (boxOk) {
              const mx = Math.round(mat.cols * 0.02);
              const my = Math.round(mat.rows * 0.02);
              const x = Math.max(0, rect.x - mx);
              const y = Math.max(0, rect.y - my);
              const w = Math.min(mat.cols - x, rect.width + 2 * mx);
              const h = Math.min(mat.rows - y, rect.height + 2 * my);
              const roi = mat.roi({ x, y, width: w, height: h });
              result = roi.clone();
              roi.delete();
              console.log("✂️ Receipt region (contour fallback):", JSON.stringify({ x, y, w, h }));
            } else {
              console.log("↩️ Receipt region too small, leaving frame untouched");
            }
          }
          contours.delete();
          hierarchy.delete();
          closed.delete();
        }
        return result;
      }
      const canvas = document.createElement("canvas");
      let scaleFactor = 1;
      if (img.width < 1000) {
        scaleFactor = 2.0;
      }
      canvas.width = img.width * scaleFactor;
      canvas.height = img.height * scaleFactor;
      const ctx = canvas.getContext("2d");
      ctx.scale(scaleFactor, scaleFactor);
      ctx.drawImage(img, 0, 0);
      let src, gray, sharpened, smoothed, thresh, kernel;
      try {
        src = cv.imread(canvas);
        console.log("📥 Step 0: Image read into OpenCV");
        // Step 1: Grayscale
        if (grayscale) {
          gray = new cv.Mat();
          cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
          showIntermediate(gray, "Grayscale");
          await delay(300);
        } else {
          gray = src.clone();
        }
        // Step 1.5: isolate the paper region EARLY so deskew and perspective
        // stages see the receipt instead of the camera background (EUROSPIN:
        // mesh mat + keyboard). Cropping late was measured; early is the fix.
        if (autoCrop) {
          const receiptRegion = cropToReceipt(gray, autoCropMode);
          if (receiptRegion) {
            gray.delete();
            gray = receiptRegion;
            showIntermediate(gray, "Receipt region isolated");
            await delay(300);
          }
        }
        // Step 1.6: linear contrast stretch (measured: EUROSPIN 3/3 item
        // amounts vs 0-2/3 unstretched - sharp.linear(1.6, -80) equivalent).
        if (contrastStretch) {
          const stretched = new cv.Mat();
          cv.convertScaleAbs(gray, stretched, 1.6, -80);
          showIntermediate(stretched, "Contrast Stretched");
          gray.delete();
          gray = stretched;
          await delay(300);
        }
        // Step 2: Deskew — v2.0.5: the angle source is TEXT-LINE direction
        // (Canny + Hough, length-weighted mean, ≥12 confident baselines),
        // not minAreaRect on the biggest bright blob. Live evidence
        // (INTERSPORT phone): the blob box reported ~10° on a receipt whose
        // text tilt is +0.9° (IQR ±1.5°) — the "correction" rotated a
        // straight receipt 10°, the wrong way, and the same blob then
        // measured <1° so nothing undid it. Text baselines are the ground
        // truth for what OCR needs. Canvas is ENLARGED during the rotation
        // (rotatedMat) — the old same-size warp clipped corners of tilted
        // receipts. Sign: A/B via window.__OCR_OPTS.textAngleSign.
        if (deskew) {
          console.log("🧭 Step 2: Deskewing started (text-line angle)");
          const T = textAngleOf(gray);
          if (T !== null) console.log("🧭 text-line angle:", +T.toFixed(2) + "° (n lines ok)");
          else console.log("🧭 text-line angle: not enough confident baselines, skipping");
          if (T !== null && Math.abs(T) > 1.0) {
            const angle = (textAngleSign === "neg" ? -1 : 1) * T;
            const center = new cv.Point(gray.cols / 2, gray.rows / 2);
            const rotated = rotatedMat(gray, angle, center, true);
            showIntermediate(rotated, `Deskewed (text angle: ${T >= 0 ? "+" : ""}${T.toFixed(2)}°)`);
            gray.delete();
            gray = rotated;
            await delay(300);
          } else {
            console.log("✅ Text angle below deadband (|T| ≤ 1°), skipping rotation");
          }
        }
        // Step 3: Perspective Correction
        if (perspectiveCorrection) {
          // Stage capture (v1.7.2): the creased top row garbles UNDER the
          // perspective warp (HOFER strip experiments: warped strip reads
          // "prv 7S"/"rei B" at every PSM; unwrapped Node bench reads the
          // price). The adaptive strip rescue needs the pre-warp image.
          if (panelView) recordStage(gray, "gray, before perspective warp");
          if (typeof options.onStageDataURLs === "function") {
            const stageCanvas = document.createElement("canvas");
            stageCanvas.width = gray.cols;
            stageCanvas.height = gray.rows;
            cv.imshow(stageCanvas, gray);
            options.onStageDataURLs({ stage: "prePerspective", dataURL: stageCanvas.toDataURL("image/png") });
            stageCanvas.width = 0;
            stageCanvas.height = 0;
          }
          console.log("🔄 Step 3: Perspective correction started");
          const binaryForPerspective = new cv.Mat();
          cv.threshold(gray, binaryForPerspective, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
          const contours = new cv.MatVector();
          const hierarchy = new cv.Mat();
          cv.findContours(binaryForPerspective, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
          let maxContour = null;
          let maxArea = 0;
          for (let i = 0; i < contours.size(); i++) {
            const contour = contours.get(i);
            const area = cv.contourArea(contour);
            if (area > maxArea) {
              maxArea = area;
              maxContour = contour;
            }
          }
          if (maxContour) {
            const approx = new cv.Mat();
            const perimeter = cv.arcLength(maxContour, true);
            cv.approxPolyDP(maxContour, approx, 0.02 * perimeter, true);
            if (approx.rows === 4) {
              const srcPts = [];
              for (let i = 0; i < 4; i++) {
                srcPts.push({ x: approx.intPtr(i, 0)[0], y: approx.intPtr(i, 0)[1] });
              }
              function sortPoints(pts) {
                pts.sort((a, b) => a.y - b.y);
                const top = pts.slice(0, 2).sort((a, b) => a.x - b.x);
                const bottom = pts.slice(2, 4).sort((a, b) => a.x - b.x);
                return [top[0], top[1], bottom[1], bottom[0]];
              }
              const orderedSrcPts = sortPoints(srcPts);
              const widthTop = Math.hypot(orderedSrcPts[1].x - orderedSrcPts[0].x, orderedSrcPts[1].y - orderedSrcPts[0].y);
              const widthBottom = Math.hypot(orderedSrcPts[2].x - orderedSrcPts[3].x, orderedSrcPts[2].y - orderedSrcPts[3].y);
              const maxWidth = Math.max(widthTop, widthBottom);
              const heightLeft = Math.hypot(orderedSrcPts[3].x - orderedSrcPts[0].x, orderedSrcPts[3].y - orderedSrcPts[0].y);
              const heightRight = Math.hypot(orderedSrcPts[2].x - orderedSrcPts[1].x, orderedSrcPts[2].y - orderedSrcPts[1].y);
              const maxHeight = Math.max(heightLeft, heightRight);
              // v2.0.6: today's geometry coupling — on INTERSPORT the warp
              // firing under the corrected (no deskew) frame was the BEST
              // read ever (total exact 55.99 vs misread 59.99 shipped), on
              // EUROSPIN the same firing garbles the totals zone (4,29 lost).
              // A data-driven gate needs full-res quad measurements per
              // capture — the panel stage images are ≤480px and cannot
              // reproduce the full-res approxPolyDP decision (live probe
              // evidence). So: measure and surface the quad geometry, no
              // behavior change yet.
              const quadSummary = {
                w: Math.round(maxWidth),
                h: Math.round(maxHeight),
                aspect: +(maxHeight / maxWidth).toFixed(2),
                areaFrac: +(((widthTop + widthBottom) / 2 * (heightLeft + heightRight) / 2) / (gray.cols * gray.rows)).toFixed(2),
                hSkew: +(Math.abs(heightLeft - heightRight) / Math.max(heightLeft, heightRight)).toFixed(2),
              };
              console.log("📐 Perspective quad:", JSON.stringify(quadSummary));
              const dstPts = [
                { x: 0, y: 0 },
                { x: maxWidth - 1, y: 0 },
                { x: maxWidth - 1, y: maxHeight - 1 },
                { x: 0, y: maxHeight - 1 },
              ];
              const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
                orderedSrcPts[0].x, orderedSrcPts[0].y,
                orderedSrcPts[1].x, orderedSrcPts[1].y,
                orderedSrcPts[2].x, orderedSrcPts[2].y,
                orderedSrcPts[3].x, orderedSrcPts[3].y
              ]);
              const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
                dstPts[0].x, dstPts[0].y,
                dstPts[1].x, dstPts[1].y,
                dstPts[2].x, dstPts[2].y,
                dstPts[3].x, dstPts[3].y
              ]);
              const M = cv.getPerspectiveTransform(srcTri, dstTri);
              const warped = new cv.Mat();
              cv.warpPerspective(gray, warped, M, new cv.Size(maxWidth, maxHeight));
              showIntermediate(warped, "Perspective Corrected (quad " + Math.round(maxWidth) + "×" + Math.round(maxHeight) + ", " + Math.round(quadSummary.areaFrac * 100) + "% of frame)");
              gray.delete();
              gray = warped;
              srcTri.delete();
              dstTri.delete();
              M.delete();
            }
            approx.delete();
          }
          binaryForPerspective.delete();
          contours.delete();
          hierarchy.delete();
        }
        // Unsharp Mask step retained
        if (unsharpMask) {
          const blurredUM = new cv.Mat();
          cv.GaussianBlur(gray, blurredUM, new cv.Size(5, 5), 1.5);
          sharpened = new cv.Mat();
          cv.addWeighted(gray, 1.5, blurredUM, -0.5, 0, sharpened);
          showIntermediate(sharpened, "Unsharp Masked");
          gray.delete();
          gray = sharpened;
          blurredUM.delete();
          await delay(300);
        }
        // Optional smoothing
        if (smoothing) {
          smoothed = new cv.Mat();
          cv.bilateralFilter(gray, smoothed, 9, 75, 75);
          showIntermediate(smoothed, "Smoothed (Bilateral Filter)");
          gray.delete();
          gray = smoothed;
          await delay(300);
        }
        // Thresholding
        if (thresholding) {
          thresh = new cv.Mat();
          cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
          showIntermediate(thresh, "Thresholded (Otsu)");
          gray.delete();
          gray = thresh;
          await delay(300);
        }
        // Adaptive thresholding tuned
        if (adaptiveThresholding) {
          const adaptive = new cv.Mat();
          const rows = gray.rows;
          const cols = gray.cols;
          let blockSize = Math.floor(Math.min(rows, cols) * 0.05);
          if (blockSize % 2 === 0) {
            blockSize += 1;
          }
          blockSize = Math.max(blockSize, 3);
          const meanScalar = cv.mean(gray);
          const meanIntensity = meanScalar[0];
          const C = meanIntensity > 127 ? 10 : 5;
          cv.adaptiveThreshold(
            gray,
            adaptive,
            255,
            cv.ADAPTIVE_THRESH_MEAN_C,
            cv.THRESH_BINARY,
            blockSize,
            C
          );
          showIntermediate(adaptive, "Adaptive Threshold");
          gray.delete();
          gray = adaptive;
          await delay(300);
        }
        // Denoising (median blur)
        if (denoise) {
          const denoised = new cv.Mat();
          cv.medianBlur(gray, denoised, 3);
          showIntermediate(denoised, "Denoised (Median Blur)");
          gray.delete();
          gray = denoised;
          await delay(300);
        }
        // CLAHE enhancement
        if (clahe) {
          const claheInstance = new cv.CLAHE(2.0, new cv.Size(8, 8));
          const equalized = new cv.Mat();
          claheInstance.apply(gray, equalized);
          showIntermediate(equalized, "CLAHE Enhanced");
          gray.delete();
          gray = equalized;
          claheInstance.delete();
          await delay(300);
        }
        // Invert if needed
        if (invert) {
          const inverted = new cv.Mat();
          cv.bitwise_not(gray, inverted);
          showIntermediate(inverted, "Inverted");
          gray.delete();
          gray = inverted;
          await delay(300);
        }
        if (morph) {
          const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
          const closed = new cv.Mat();
          cv.morphologyEx(gray, closed, cv.MORPH_CLOSE, kernel);
          showIntermediate(closed, "Morphological Closing");
          gray.delete();
          gray = closed;
          kernel.delete();
          await delay(300);
        }

        // (old late-stage autoCrop block removed — its cropToContent dark-mask
        // cropped into the receipt on cluttered photos; bright-mask crop runs
        // early now, before deskew)

        // Final canvas output
        const finalCanvas = document.createElement("canvas");
        finalCanvas.width = gray.cols;
        finalCanvas.height = gray.rows;
        const ctxFinal = finalCanvas.getContext("2d");
        ctxFinal.clearRect(0, 0, finalCanvas.width, finalCanvas.height);
        cv.imshow(finalCanvas, gray);
        gray.delete();
        src.delete();
        resolve(finalCanvas.toDataURL("image/png"));
      } catch (err) {
        console.error("❌ Error during preprocessing:", err);
        if (src) src.delete();
        if (kernel) kernel.delete();
        if (gray) gray.delete();
        reject(err);
      }
    };
    img.onerror = (e) => reject(new Error("Failed to load image: " + e.message));
    img.src = typeof imageSrc === "string" ? imageSrc : URL.createObjectURL(imageSrc);
  });
}


// --- Clean text by removing invisible chars and normalizing whitespace, preserve lines ---
export function cleanAndMergeText(rawText) {
  if (!rawText) return "";
  return rawText
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join("\n");
}

// --- Position-aware text extraction from a single PDF page ---
async function extractTextLinesFromPDFPage(page) {
  const textContent = await page.getTextContent();
  const items = textContent.items;
  const linesMap = new Map();
  const yThreshold = 2;
  function findOrAddLineKey(y) {
    for (let key of linesMap.keys()) {
      if (Math.abs(key - y) <= yThreshold) {
        return key;
      }
    }
    linesMap.set(y, []);
    return y;
  }
  items.forEach((item) => {
    const y = item.transform[5];
    const key = findOrAddLineKey(y);
    linesMap.get(key).push(item);
  });
  const sortedYs = Array.from(linesMap.keys()).sort((a, b) => b - a);
  const finalLines = [];
  for (const y of sortedYs) {
    const lineItems = linesMap.get(y);
    const sortedItems = lineItems.sort((a, b) => a.transform[4] - b.transform[4]);
    const lineText = sortedItems.map((item) => item.str).join(" ").trim();
    if (lineText) finalLines.push(lineText);
  }
  return finalLines.join("\n");
}

// --- Extract text from a PDF file, process pages via position-aware extraction ---
function updateOCRProgressUI(status, progressFraction) {
  const progressBar = document.getElementById("ocr-progress-bar");
  const statusText = document.getElementById("ocr-status-text");
  const container = document.getElementById("ocr-progress-container");
  if (progressBar && statusText && container) {
    if (status) {
      container.style.display = "";
      progressBar.style.width = `${(progressFraction * 100).toFixed(1)}%`;
      statusText.textContent = `OCR Status: ${status}`;
    } else {
      // idle: hide the chip (was permanently visible with stale text)
      container.style.display = "none";
      progressBar.style.width = "0%";
      statusText.textContent = "";
    }
  }
}

export async function processPDF(file, onProgress = () => {}) {
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = async () => {
      try {
        const pdf = await getDocument({ data: reader.result }).promise;
        let fullText = "";
        const previews = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const extractedText = await extractTextLinesFromPDFPage(page);
          if (extractedText && extractedText.length > 20) {
            fullText += `\n\n--- Page ${i} ---\n${extractedText}`;
          } else {
            const viewport = page.getViewport({ scale: 3 });
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d");
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await page.render({ canvasContext: context, viewport }).promise;
            const image = canvas.toDataURL("image/png");
            previews.push(image);
            const preprocessed = await preprocessWithOpenCV(image);
            const worker = await getWorker();
            const ocrResult = await worker.recognize(await upscaleDataURL(preprocessed));
            const cleanedOCRText = cleanAndMergeText(ocrResult.data.text);
            fullText += `\n\n--- Page ${i} (OCR) ---\n${cleanedOCRText}`;
          }
          updateOCRProgressUI(`Processing page ${i} of ${pdf.numPages}`, i / pdf.numPages);
          onProgress({ status: "page", page: i, totalPages: pdf.numPages, progress: i / pdf.numPages });
        }
        updateOCRProgressUI("OCR complete", 1);
        setTimeout(() => updateOCRProgressUI("", 0), 2000);
        resolve({ text: fullText.trim(), previews });
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

// --- OCR quality score for the adaptive second pass ---
// Higher is better: a found total dominates everything (5), then item count,
// then date presence. Ties stay with pass 1, so a healthy receipt is never
// swapped for an equal-scoring second opinion.
function scoreParse(parse) {
  if (!parse) return -1;
  return (parse.total ? 5 : 0) + parse.items.length + (parse.date ? 1 : 0);
}

/**
 * Adaptive top-strip capture (v1.7.2 HOFER rescue): the topmost item rows sit
 * on the paper's fold/edge where 2x OCR misreads prices ("1,79 B" -> "rr 8").
 * Node evidence (scripts/ocr-hofer-strip.mjs, deterministic across runs):
 * re-OCRing the top 25% of the receipt column at 3x reads the price straight
 * off the pixels ("Kruger sum.tablete 1,79 8"). 4x variants LOST the line, so
 * 3x is the empirically-validated factor.
 *
 * cropToReceipt may legally leave the FULL frame (sanity guard: whole-photo
 * bright region). Strips of full frames re-introduce the black-table margins
 * that wreck PSM-6 line detection (first live test: 8 junk lines, no price),
 * so the strip is narrowed to the receipt column via column-brightness
 * projection — dark background columns trimmed, receipts stay centered.
 */
function topStripDataURL(preprocessedDataURL, band = [0, 0.25], factor = 3, mode = "catrom") {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {
      const y0 = Math.max(0, Math.round(img.height * band[0]));
      const stripH = Math.max(1, Math.round(img.height * (band[1] - band[0])));
      const stripCanvas = document.createElement("canvas");
      stripCanvas.width = img.width;
      stripCanvas.height = stripH;
      const sctx = stripCanvas.getContext("2d");
      sctx.drawImage(img, 0, y0, img.width, stripH, 0, 0, img.width, stripH);
      let x0 = 0;
      let x1 = img.width;
      try {
        const data = sctx.getImageData(0, 0, img.width, stripH).data;
        const colMeans = [];
        const darkCounts = [];
        for (let x = 0; x < img.width; x++) {
          let sum = 0;
          let n = 0;
          let dark = 0;
          for (let y = 0; y < stripH; y += 4) {
            const i = (y * img.width + x) * 4;
            const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
            sum += v;
            if (v < 105) dark++;
            n++;
          }
          colMeans.push(sum / n);
          darkCounts.push(dark);
        }
        const span = brightColumnTrim(colMeans, darkCounts);
        // only narrow when the projection found a plausible paper column
        const margin = 15;
        if (span) {
          x0 = Math.max(0, span[0] - margin);
          x1 = Math.min(img.width, span[1] + margin);
        }
      } catch {
        // tainted canvas etc.: fall back to untrimmed strip
      }
      const w = x1 - x0;
      const c1 = document.createElement("canvas");
      c1.width = w;
      c1.height = stripH;
      c1.getContext("2d").drawImage(stripCanvas, x0, 0, w, stripH, 0, 0, w, stripH);
      const canvas = bicubicUpscaleGrayCanvas(c1, factor, mode);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = preprocessedDataURL;
  });
}

/**
 * Decisive strip variant (v1.7.2 research): canvas-drawn gray + linear stretch
 * (1.6,-80) + NEAREST-neighbor 3x + column trim. Chrome's "high"-quality
 * drawImage resampling is the last difference vs the Node bench that read the
 * price ("1,79 8") — sharp used lanczos3 on the same pixels. Nearest at an
 * integer factor is the canvas-side substitute for a sharp resampler.
 */
function rawStripDataURL(imageSrc, band = [0, 0.25], factor = 3, mode = "catrom") {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = async () => {
      const y0 = Math.max(0, Math.round(img.height * band[0]));
      const h = Math.max(1, Math.round(img.height * (band[1] - band[0])));
      const cGray = document.createElement("canvas");
      cGray.width = img.width;
      cGray.height = h;
      const ctx1 = cGray.getContext("2d");
      ctx1.drawImage(img, 0, y0, img.width, h, 0, 0, img.width, h);
      let data;
      try {
        data = ctx1.getImageData(0, 0, img.width, h);
      } catch (err) {
        // pixel reads blocked (fingerprinting protection): raw-strip transform
        // is impossible — fall back to the plain grayscale canvas drawn by the
        // GPU (drawImage only, no pixel reads) and let the caller's other
        // attempts carry the rescue
        console.warn("🖼️ Canvas pixel read blocked — raw strip falls back to direct draw:", err && err.name);
        const plain = upscaleCanvasProgressive(cGray, factor);
        resolve(plain.toDataURL("image/png"));
        return;
      }
      const d = data.data;
      for (let i = 0; i < d.length; i += 4) {
        const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const v = Math.max(0, Math.min(255, Math.round(1.6 * g - 80)));
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx1.putImageData(data, 0, 0);
      // column trim inside canvas data (bright+ink column projection; the
      // stretched pixels saturate, so "ink" = stretched value under 75)
      const colMeans = new Array(img.width).fill(0);
      const darkCounts = new Array(img.width).fill(0);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < img.width; x++) {
          const v = d[(y * img.width + x) * 4];
          colMeans[x] += v;
          if (v < 75) darkCounts[x]++;
        }
      }
      for (let x = 0; x < img.width; x++) colMeans[x] /= h;
      const span = brightColumnTrim(colMeans, darkCounts);
      let left = 0;
      let right = img.width - 1;
      if (span) {
        left = Math.max(0, span[0] - 15);
        right = Math.min(img.width - 1, span[1] + 15);
      }
      const w = right - left;
      const c1src = document.createElement("canvas");
      c1src.width = img.width;
      c1src.height = h;
      c1src.getContext("2d").putImageData(data, 0, 0);
      const c1 = document.createElement("canvas");
      c1.width = w;
      c1.height = h;
      c1.getContext("2d").drawImage(c1src, left, 0, w, h, 0, 0, w, h);
      const c2 = bicubicUpscaleGrayCanvas(c1, factor, mode);
      resolve(c2.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = typeof imageSrc === "string" ? imageSrc : URL.createObjectURL(imageSrc);
  });
}

/**
 * Progressive upscale in ≤2x steps: Chrome's drawImage degrades past ~2x
 * (kernel isolation scripts/ocr-hofer-kernel.mjs: nearest reads "br B" where
 * lanczos/mitchell/cubic read "1,79 8" on identical pixels). Two successive
 * steps (1.5x + 2x) keep every draw inside the smooth-resampling regime and
 * approximate the sharp bench result (lanczos3).
 */
function upscaleCanvasProgressive(src, totalFactor) {
  let out = src;
  let remaining = totalFactor;
  while (remaining > 1.0001) {
    const step = Math.min(remaining, 2);
    const c = document.createElement("canvas");
    c.width = Math.round(out.width * step);
    c.height = Math.round(out.height * step);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(out, 0, 0, out.width, out.height, 0, 0, c.width, c.height);
    out = c;
    remaining /= step;
  }
  return out;
}

/**
 * Catmull-Rom gray upscale (v1.7.2) with a canvas-read fallback (v1.7.4):
 * fingerprinting protection (Brave/Firefox strict) makes getImageData THROW —
 * pica died on exactly this at import. Fallback: progressive drawImage
 * upscale (no pixel reads), which never crashed anything.
 */
function bicubicUpscaleGrayCanvas(srcCanvas, factor, mode = "catrom") {
  let sd;
  try {
    const sctx = srcCanvas.getContext("2d");
    sd = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height).data;
  } catch (err) {
    console.warn("🖼️ Canvas pixel read blocked (fingerprinting protection) — falling back to drawImage upscale:", err && err.name);
    return upscaleCanvasProgressive(srcCanvas, factor);
  }
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  const dw = Math.round(sw * factor);
  const dh = Math.round(sh * factor);
  const out = new ImageData(dw, dh);
  const od = out.data;
  // separable weights, dst centers map onto src half-pixel positions
  // ((d+0.5)/factor - 0.5). "catrom" (default, browser-validated): 4-tap
  // Catmull-Rom. "lanczos3": 6-tap windowed sinc, sum-normalized — added as
  // a cascade DIVERSITY axis, not a replacement: kernel sweep
  // (scripts/ocr-eurospin-kernel-sweep.mjs) shows the two flip outcomes per
  // band window (catrom reads 1,55 @35-75%, lanczos3 reads it @40-75% where
  // catrom loses the row), so neither justifies a primary-pipeline swap.
  const isLanczos = mode === "lanczos3";
  const taps = isLanczos ? 6 : 4;
  const weightFor = (t) => {
    const s = Math.abs(t);
    if (isLanczos) {
      if (s >= 3) return 0;
      if (s < 1e-8) return 1;
      const sinc = (x) => Math.sin(Math.PI * x) / (Math.PI * x);
      return sinc(s) * sinc(s / 3);
    }
    let w = 0;
    if (s <= 1) w = 1.5 * s * s * s - 2.5 * s * s + 1;
    else if (s < 2) w = -0.5 * s * s * s + 2.5 * s * s - 4 * s + 2;
    return w;
  };
  const half = taps / 2 - 1;
  const xWeights = new Array(dw);
  const xBases = new Array(dw);
  for (let dx = 0; dx < dw; dx++) {
    const sx = (dx + 0.5) / factor - 0.5;
    const base = Math.floor(sx) - half;
    xBases[dx] = base;
    const w = [];
    for (let k = 0; k < taps; k++) w.push(weightFor(sx - (base + k)));
    if (isLanczos) {
      const sum = w.reduce((a, b) => a + b, 0) || 1;
      for (let k = 0; k < taps; k++) w[k] /= sum;
    }
    xWeights[dx] = w;
  }
  for (let dy = 0; dy < dh; dy++) {
    const sy = (dy + 0.5) / factor - 0.5;
    const yBase = Math.floor(sy) - half;
    const yW = [];
    for (let k = 0; k < taps; k++) yW.push(weightFor(sy - (yBase + k)));
    if (isLanczos) {
      const sum = yW.reduce((a, b) => a + b, 0) || 1;
      for (let k = 0; k < taps; k++) yW[k] /= sum;
    }
    const yClamp = [];
    for (let k = 0; k < taps; k++) yClamp.push(Math.max(0, Math.min(sh - 1, yBase + k)));
    for (let dx = 0; dx < dw; dx++) {
      const bx = xBases[dx];
      const w = xWeights[dx];
      let acc = 0;
      for (let j = 0; j < taps; j++) {
        const srcRow = yClamp[j];
        let colAcc = 0;
        for (let k = 0; k < taps; k++) {
          let sx0 = bx + k;
          if (sx0 < 0) sx0 = 0;
          else if (sx0 >= sw) sx0 = sw - 1;
          colAcc += sd[(srcRow * sw + sx0) * 4] * w[k];
        }
        acc += colAcc * yW[j];
      }
      const v = Math.max(0, Math.min(255, Math.round(acc)));
      const o = (dy * dw + dx) * 4;
      od[o] = od[o + 1] = od[o + 2] = v;
      od[o + 3] = 255;
    }
  }
  const dst = document.createElement("canvas");
  dst.width = dw;
  dst.height = dh;
  dst.getContext("2d").putImageData(out, 0, 0);
  return dst;
}

/**
 * Ink-column trim (v1.7.2 final): the receipt column is located by TEXT INK,
 * not brightness — live-photo probe shows the whole top strip is bright-ish
 * (means 165-220 everywhere incl. background), while receipt text columns
 * carry dark pixels (smoothed counts >=5 over a ±20px window). Columns with
 * sparse/faint ink (the folded price!) survive because the ±20px window and a
 * 50px gap-merge span them; bounds get ±30/60 slack like the bench crop.
 */
function brightColumnTrim(colMeans, darkCounts, minWidthFraction = 0.15, maxGapPx = 50) {
  const n = colMeans.length;
  const smooth = new Array(n).fill(0);
  for (let x = 0; x < n; x++) {
    let s = 0;
    for (let k = Math.max(0, x - 20); k <= Math.min(n - 1, x + 20); k++) {
      s += darkCounts ? darkCounts[k] : 0;
    }
    smooth[x] = s;
  }
  let bestStart = -1;
  let bestEnd = -1;
  let curStart = -1;
  let lastInk = -1;
  for (let x = 0; x <= n; x++) {
    const isP = x < n && smooth[x] >= 6;
    if (isP) {
      if (curStart < 0) curStart = x;
      lastInk = x;
    } else if (curStart >= 0) {
      if (x - lastInk <= maxGapPx && x < n) continue;
      if (lastInk - curStart + 1 > bestEnd - bestStart + 1) { bestStart = curStart; bestEnd = lastInk; }
      curStart = -1;
      lastInk = -1;
    }
  }
  if (bestStart < 0 || bestEnd - bestStart + 1 < n * minWidthFraction) return null;
  return [Math.max(0, bestStart - 30), Math.min(n - 1, bestEnd + 60)];
}

// --- OCR + preprocessing for direct image files ---
// Returns { text, extraItems }: item rows recovered by the adaptive strip
// re-OCR ride along separately so app.js can hand both to parseReceipt
// (checks[] then run over the complete item set with provenance markers).
/**
 * v2.0.2: evidence-panel stage capture for the OCR input chain (processImage).
 * Panel mode (window.__OCR_DEBUG === true, window.__OCR_PANEL === true) records
 * a downscaled PNG of each stage into window.__OCR_STAGES so the app's evidence
 * panel can show the actual workflow pictures: what came in, what the OpenCV
 * preprocessing produced, and the exact pixels Tesseract read. Awaited in order
 * so the buffer keeps document order even though the decode is async.
 */
function pushStageDataURL(label, srcURL) {
  if (typeof window === "undefined" || window.__OCR_DEBUG !== true || !srcURL) {
    return Promise.resolve();
  }
  if (!window.__OCR_STAGES) window.__OCR_STAGES = [];
  const buf = window.__OCR_STAGES;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // Stage via a native-size canvas first, then downscale. Drawing the
      // decoded Image element straight to the ≤480 thumbnail produced a soft
      // result on its first draw when scale < 0.5 (Chrome first-draw decode path
      // measured live: lapVar 1852/3897 vs 8411 via the canvas route on the same
      // PNG; warm repeats all give 8411). recordStage has always used the
      // canvas→canvas route and was never affected.
      const big = document.createElement("canvas");
      big.width = img.naturalWidth;
      big.height = img.naturalHeight;
      big.getContext("2d").drawImage(img, 0, 0);
      const w = Math.min(480, big.width);
      const h = Math.max(1, Math.round(big.height * (w / big.width)));
      const small = document.createElement("canvas");
      small.width = w;
      small.height = h;
      small.getContext("2d").drawImage(big, 0, 0, w, h);
      buf.push({ label, dataURL: small.toDataURL("image/png") });
      resolve();
    };
    img.onerror = () => resolve(); // never fail the scan for evidence capture
    img.src = srcURL;
  });
}

export async function processImage(imageSrc, onProgress = () => {}) {
  // reset this scan's stage buffer BEFORE anything appends to it
  if (typeof window !== "undefined" && window.__OCR_DEBUG === true) {
    window.__OCR_STAGES = [];
    // imageSrc may be a File/Blob (bulk upload path), not a value that an
    // <img> can decode directly — an object URL covers both.
    const inputSrc = typeof imageSrc === "string"
      ? imageSrc
      : URL.createObjectURL(imageSrc);
    await pushStageDataURL("input photo (raw)", inputSrc);
  }
  let prePerspectiveDataURL = null;
  // v2.0.3: evidence-run hook — window.__OCR_OPTS (e.g. { autoCropMode:
  // "rotated", deskew: false }) overrides preprocessing options for A/B
  // comparisons; unset means production options, untouched path.
  const preOpts = {
    onStageDataURLs: ({ stage, dataURL }) => {
      if (stage === "prePerspective" && !prePerspectiveDataURL) prePerspectiveDataURL = dataURL;
    },
  };
  if (typeof window !== "undefined" && window.__OCR_OPTS) {
    Object.assign(preOpts, window.__OCR_OPTS);
    console.log("🧪 evidence-run preprocessing override:", window.__OCR_OPTS);
  }
  const preprocessedDataURL = await preprocessWithOpenCV(imageSrc, preOpts);
  if (window.__OCR_DEBUG === true) {
    await pushStageDataURL("after OpenCV preprocessing", preprocessedDataURL);
  }
  const upscaled = await upscaleDataURL(preprocessedDataURL);
  if (window.__OCR_DEBUG === true) {
    await pushStageDataURL("upscaled 2× — exact pixels fed to Tesseract", upscaled);
  }
  const worker = await getWorker();
  const result = await worker.recognize(upscaled);
  let cleaned = cleanAndMergeText(result.data.text);

  // v1.7.1 adaptive second pass: if the first OCR parse has no total or no
  // items, re-run once with a FRESH worker and keep the better parse.
  // Basis (dev-bench experiment, 20 Oct 2026): 15/15 identical runs across
  // three fresh sessions in the controlled harness, but real-user sessions
  // showed word-level drift between app restarts — occasionally enough to
  // drop the total line. The re-run only triggers on receipts that already
  // parse broken, so healthy ones pay zero extra cost.
  const firstParse = parseReceipt(cleaned);
  if (!firstParse.total || !firstParse.items.length) {
    let freshWorker = null;
    try {
      freshWorker = await createWorker("slv+eng", 1, {});
      await freshWorker.setParameters(tessParams);
      const secondResult = await freshWorker.recognize(upscaled);
      const secondCleaned = cleanAndMergeText(secondResult.data.text);
      const secondParse = parseReceipt(secondCleaned);
      if (scoreParse(secondParse) > scoreParse(firstParse)) {
        console.log("🔁 Second pass (fresh worker) produced a better parse — using it");
        cleaned = secondCleaned;
      } else {
        console.log("🔁 Second pass ran, first parse kept (equal or better)");
      }
    } catch (err) {
      console.warn("🔁 Second pass failed, keeping first pass:", err);
    } finally {
      if (freshWorker) freshWorker.terminate();
    }
  }

  // v1.7.2 adaptive top-strip rescue: when the parse PROVABLY misses an item
  // (VAT-recap bucket check), re-OCR the strip where the first item rows sit.
  // Only accepts a strip line whose MEASURED price equals the missing amount
  // (±0.02) — arithmetic from the recap is never turned into an item.
  // v1.7.5: every attempt's text is recorded (returned to app.js) so the UI
  // can show the strip's own OCR reading as evidence that the recovered
  // price was MEASURED, not derived from arithmetic.
  const extraItems = [];
  const corrections = [];
  const stripEvidence = [];
  let rescueWinner = null;
  let missingBucket = null;
  const finalParse = parseReceipt(cleaned);
  const finalChecks = finalParse.checks || [];
  const bucketText = finalChecks.find(
    (c) => !c.ok && /missing item ≈ ([\d.]+)/.test(c.text)
  );
  let missing = null;
  if (bucketText) {
    missing = parseFloat(bucketText.text.match(/missing item ≈ ([\d.]+)/)[1]);
  } else {
    // v2.0.12: arm the strip rescue from the SUM-MISMATCH gap itself when the
    // VAT-recap rows are too garbled to derive a bucket (HOFER-B real case,
    // ink-crop geometry: total 4,73 recovered but recap rows read "BRON CS B
    // 22,0% Neto aro 0,82" — no bucket check possible, and the prior gate
    // therefore never attempted the strip re-OCR that the deployed build's
    // geometry had armed). Missing = total − Σitems; the ACCEPTANCE criterion
    // is unchanged and remains measurement-only: the strip must OCR-read an
    // amount equal to the gap ±0.02 with a lettered name, arithmetic never
    // becomes an item. Guard (v1.6.9 no-fire philosophy, proven on SPAR's
    // 5,74 coupon gap): never arm when the raw text contains a discount or
    // coupon marker — the mismatch is then explained without a missing item.
    if (!/popust|kupon|discount|dopla[cč]il/i.test(cleaned)) {
      const sumCheck = finalChecks.find((c) => !c.ok && /items sum ([\d.]+) ≠ total ([\d.]+)/.test(c.text));
      if (sumCheck && finalParse.total) {
        const t = parseFloat((finalParse.total.match(/([\d.,]+)/) || [])[1]?.replace(",", "."));
        const sum = parseFloat(sumCheck.text.match(/items sum ([\d.]+)/)[1]);
        if (!isNaN(t) && !isNaN(sum) && t - sum > 0.004) missing = +(t - sum).toFixed(2);
      }
    }
  }
  if (missing != null) {
    missingBucket = missing;
    const alreadyParsed = finalParse.items.some(
      (it) => Math.abs((parseFloat(it.price) ?? 0) - missing) <= 0.02
    );
    if (!alreadyParsed) {
      let strip = null;
      try {
        const currency = (finalParse.total || "").split(" ")[1] || "€";
        // cascade: strip band × page-seg. Live-evidence history: full-frame
        // strips garbled ("prv 7S"); ink-trim alone helped names but the price
        // needed PSM 4 — decisive cross-check: Node tesseract on the EXACT
        // browser strip PNG read "preo B" at PSM 6 but "1,798" (= 1,79 with the
        // VAT letter B misread as 8) at PSM 4. PSM 6 wasted determinism on the
        // same pixels, so the segmentation, not the image, was the bottleneck.
        outer: for (const [stripKind, band, psm] of [
          ["raw", [0, 0.25], "6"], ["prep", [0, 0.25], "6"], ["prep", [0, 0.18], "6"],
          ["raw", [0, 0.25], "4"], ["prep", [0, 0.25], "4"],
        ]) {
          // strip from the PRE-perspective image when available: creased rows
          // garble under the warp (live evidence), while the unwrapped crop
          // is what the Node benchmarks read correctly. "raw" attempts bypass
          // resampling entirely (canvas gray+stretch math == sharp params).
          const base = stripKind === "raw" ? imageSrc : (prePerspectiveDataURL || preprocessedDataURL);
          strip = stripKind === "raw" ? await rawStripDataURL(base, band) : await topStripDataURL(base, band);
          await worker.setParameters({ ...tessParams, tessedit_pageseg_mode: psm });
          const stripResult = await worker.recognize(strip);
          await worker.setParameters(tessParams);
          const stripText = cleanAndMergeText(stripResult.data.text);
          const stripLines = stripText.split("\n").filter(Boolean);
          console.log("🔁 Strip re-OCR (missing item ≈", missing.toFixed(2), ", strip", stripKind, band.join("-"), "psm", psm, "):", stripLines);
          stripEvidence.push({ stripKind, band, factor: 3, psm, lines: stripLines, image: strip });
          for (const line of stripLines) {
            const amounts = [...line.matchAll(/\d{1,3}[.,]\d{1,2}/g)].map((m) =>
              parseFloat(m[0].replace(",", "."))
            );
            const hit = amounts.find((a) => Math.abs(a - missing) <= 0.02);
            if (hit == null) continue;
            const tokens = line.trim().split(/\s+/);
            let end = 0;
            while (end < tokens.length && !/\d/.test(tokens[end])) end++;
            let name = tokens.slice(0, end).join(" ");
            name = name.replace(/^[^a-zA-ZčšžČŠŽ]+\s*/, "").trim();
            const letterCount = (name.match(/[a-zA-ZčšžČŠŽ]/g) || []).length;
            if (letterCount < 3) continue;
            extraItems.push({
              name,
              price: `${hit.toFixed(2)} ${currency}`,
              quantity: undefined,
              via: "strip-retry",
            });
            rescueWinner = { stripKind, band, factor: 3, psm, line };
            break outer; // one rescued row per bucket
          }
        }
      } catch (err) {
        console.warn("🔁 Strip re-OCR failed, skipping rescue:", err);
      }
    }
  } else {
    // v1.7.6 item-band rescue (EUROSPIN real case): the items-sum check
    // [?] fires and ≥2 items parsed — the damaged region may be the ITEM
    // BLOCK ITSELF, not the top rows: eurospin's tall header pushed its items
    // to ~45-62% of the paper, so a top strip reads nothing. A mid-band
    // re-OCR (40-75% of the image) re-read the block and MEASURED the true
    // price ("EKSI FROLLINI 1KG 1,55 A" where the main 2x pass read 1,95 —
    // bench: scripts/ocr-eurospin-strip.mjs, 42-72% at 2x PSM 6). Winners are
    // handed to the parser as correction CANDIDATES: parseReceipt only
    // replaces a price when the candidate's name fuzzy-matches an existing
    // item AND the measured price differs — otherwise the candidate is
    // dropped, so strip garble can never invent money.
    const sumMismatch = finalChecks.find(
      (c) => !c.ok && /items sum .* ≠ total/.test(c.text)
    );
    // Discount gate (SPAR regression, live 2026-10-20): a coupon/discount row
    // legitimately explains the sum gap ("KUPON POPUST 10.00% od 57.35
    // -5.74" — items sum exactly the gross 57.35). Band-rescue corrections
    // there are poison (the improvement guard even "clawed" toward the
    // discounted total using a misread popust column). Same gate exists in
    // parseReceipt; this copy saves the 5 OCR passes.
    const discountMarker = /pop[ou]st|doplac/i.test(cleaned);
    if (sumMismatch && !discountMarker && finalParse.items.length >= 2) {
      // Collect candidates from EVERY attempt (an early attempt can garble
      // the mispriced row while a later variant reads it right); the parser's
      // improvement guard filters them, so over-collection is safe. Each
      // candidate remembers which attempt measured it for winner selection.
      // Attempt list carries KERNEL diversity too: the kernel sweep
      // (scripts/ocr-eurospin-kernel-sweep.mjs) measured catrom and
      // lanczos3 flipping FROLLINI's price per band window — no primary
      // kernel, so extra attempts buy coverage at 1 pass each, broken
      // parses only. The 5th attempt (lanczos3) reads the row cleanly
      // where catrom @2x PSM6 lost it.
      for (const [stripKind, band, factor, psm, kernel] of [
        ["prep", [0.4, 0.75], 2, "6", "catrom"], ["prep", [0.4, 0.75], 2, "4", "catrom"],
        ["raw", [0.4, 0.75], 2, "6", "catrom"], ["prep", [0.32, 0.75], 3, "6", "catrom"],
        ["prep", [0.4, 0.75], 2, "6", "lanczos3"],
      ]) {
        try {
          const base = stripKind === "raw" ? imageSrc : (prePerspectiveDataURL || preprocessedDataURL);
          const strip = stripKind === "raw"
            ? await rawStripDataURL(base, band, factor, kernel)
            : await topStripDataURL(base, band, factor, kernel);
          await worker.setParameters({ ...tessParams, tessedit_pageseg_mode: psm });
          const stripResult = await worker.recognize(strip);
          await worker.setParameters(tessParams);
          const stripText = cleanAndMergeText(stripResult.data.text);
          const stripLines = stripText.split("\n").filter(Boolean);
          console.log("🔁 Item-band re-OCR (sum mismatch, strip", stripKind, band.join("-"), factor + "x", kernel, "psm", psm, "):", stripLines);
          stripEvidence.push({ stripKind, band, factor, psm, kernel, lines: stripLines, image: strip });
          // candidates remember the EVIDENCE index, not a counter: a failed
          // attempt (rawStripDataURL rejection etc.) never lands in
          // stripEvidence, and a counter would smear later candidates onto
          // the wrong attempt's evidence/winner line
          const evidIdx = stripEvidence.length - 1;
          for (const line of stripLines) {
            const amounts = [...line.matchAll(/\d{1,3}[.,]\d{1,2}/g)].map((m) =>
              parseFloat(m[0].replace(",", "."))
            );
            if (!amounts.length) continue;
            const price = amounts[amounts.length - 1];
            const tokens = line.trim().split(/\s+/);
            let end = 0;
            while (end < tokens.length && !/\d/.test(tokens[end])) end++;
            let name = tokens.slice(0, end).join(" ");
            name = name.replace(/^[^a-zA-ZčšžČŠŽ]+\s*/, "").trim();
            if ((name.match(/[a-zA-ZčšžČŠŽ]/g) || []).length < 4) continue;
            // best-matching item only (no brand-prefix first-match pairing)
            let target = null;
            let bestScore = 0;
            for (const it of finalParse.items) {
              const s = namesScore(name, it.name);
              if (s > bestScore + 1e-9) { bestScore = s; target = it; }
            }
            if (!target || !namesSimilar(name, target.name)) continue; // no solid match -> drop, could be anything
            const oldPrice = parseFloat(String(target.price ?? "").replace(",", "."));
            if (!isNaN(oldPrice) && Math.abs(oldPrice - price) <= 0.02) continue;
            if (corrections.some((c) => c.attempt === evidIdx && namesSimilar(c.name, name))) continue;
            corrections.push({ name, price, attempt: evidIdx });
          }
          // v1.7.7 EARLY STOP: the sum check is the only truth anchor, so
          // once candidates-so-far re-commit an exact total, later attempts
          // can only produce no-ops — any candidate SHIFTING the sum off
          // total would be rejected by the parser, so the final parse is
          // identical to full collection while saving up to 4 OCR passes.
          // Residue (documented, not a regression): a SECOND garbled price
          // in a then-sum-exact state stays unrepaired — indistinguishable
          // from correct without another anchor.
          if (corrections.length) {
            const reParse = parseReceipt(cleaned, [], corrections);
            const sumOk = reParse.checks.some((c) => c.ok && /items sum/.test(c.text));
            if (sumOk) {
              console.log("🔁 Sum already exact after attempt", evidIdx + 1, "— stopping band cascade early");
              break;
            }
          }
        } catch (err) {
          console.warn("🔁 Item-band re-OCR attempt failed:", err);
        }
      }
      // Verify with the parser: only candidates that IMPROVE the items-sum
      // become the returned correction set; the winning attempt is the one
      // that measured an applied correction.
      if (corrections.length) {
        try {
          const reParse = parseReceipt(cleaned, [], corrections);
          const appliedCands = reParse.checks
            .filter((c) => c.text.includes("price corrected by band re-OCR"))
            .map((c) => (c.text.match(/OCR measured "(.+?)"\)? —/) || [])[1])
            .filter(Boolean);
          const kept = corrections.filter((c) => appliedCands.includes(c.name));
          if (kept.length) {
            const winAttempt = stripEvidence[kept[0].attempt];
            const winPriceTexts = [kept[0].price.toFixed(2), String(kept[0].price).replace(".", ",")];
            corrections.length = 0;
            corrections.push(...kept.map(({ attempt, ...rest }) => rest));
            rescueWinner = winAttempt
              ? {
                  stripKind: winAttempt.stripKind,
                  band: winAttempt.band,
                  factor: winAttempt.factor,
                  psm: winAttempt.psm,
                  kernel: winAttempt.kernel,
                  line: winAttempt.lines.find((l) => winPriceTexts.some((p) => l.includes(p))) ?? winAttempt.lines[0],
                }
              : null;
          } else {
            corrections.length = 0;
          }
        } catch (err) {
          console.warn("🔁 Correction verification re-parse failed:", err);
          corrections.length = 0;
        }
      }
    }
  }

  // v2.0.15 PAY-ZONE payable rescue (INTERSPORT re-photo real case), generalized
  // in v2.0.18 (HOFER total-drift real case: printed 4,73 read 4,13 while ALL
  // item rows read exact — every existing arm requires a POSITIVE missing-item
  // gap, so the flag could never resolve). Arithmetic derives the target
  // payable via the SHARED discountAmounts helper: one distinct discount
  // amount P → items − P; NO discount markers at all → the items sum itself
  // (the only story matching "all rows read, no discount, total misread").
  // Ambiguity (SPAR coupon) aborts without OCR passes. Each band attempt must
  // MEASURE the target (±0.02) in a pay-vocabulary line before it wins — same
  // measurement-first policy as the item rescues (v1.7.2). Decision logic
  // lives in parseReceipt.payableRescue (Node-tested); this block only
  // supplies the measurement. Armed only when the missing-item rescue is not
  // (missing == null) and no VAT-recap bucket check exists — different
  // failure stories, never both on one receipt.
  let payRescue = null;
  if (missing == null) {
    const sumMismatchPay = finalChecks.find(
      (c) => !c.ok && /items sum ([\d.]+) ≠ total ([\d.]+)/.test(c.text)
    );
    const discountPresent15 = /pop[ou]st|kupon|dopla[cč]il/i.test(cleaned);
    const bucketHintPay15 = finalChecks.some((c) => /missing item ≈/.test(c.text));
    if (sumMismatchPay && !bucketHintPay15) {
      const I15 = parseFloat(sumMismatchPay.text.match(/items sum ([\d.]+)/)[1]);
      const T15 = parseFloat(sumMismatchPay.text.match(/≠ total ([\d.]+)/)[1]);
      // shared helper = the SAME target the decision accepts; ambiguity aborts.
      const p15 = discountAmounts(cleaned, I15);
      let D15 = null;
      let pLabel15 = null;
      if (p15.length === 1) {
        D15 = +(I15 - p15[0]).toFixed(2);
        pLabel15 = String(p15[0]);
      } else if (p15.length === 0 && !discountPresent15) {
        D15 = +I15.toFixed(2);
      }
      if (D15 != null && D15 > 0 && !isNaN(T15) && Math.abs(D15 - T15) > 0.02) {
        console.log("🔁 Pay-zone rescue armed: items", I15, p15.length === 1 ? "− POPUST" + pLabel15 : "(no discount)", "=", D15, "≠ read total", T15);
        let measured15 = null;
        let payWinner15 = null;
        outer15: for (const [stripKind, band, factor, psm] of [
          ["prep", [0.55, 1.0], 2, "6"],
          ["prep", [0.4, 0.75], 2, "6"],
          ["raw", [0.55, 1.0], 2, "6"],
          ["prep", [0.55, 1.0], 2, "4"],
          ["prep", [0.75, 1.0], 2, "6"],
        ]) {
          try {
            const base15 = stripKind === "raw" ? imageSrc : (prePerspectiveDataURL || preprocessedDataURL);
            const strip15 = stripKind === "raw"
              ? await rawStripDataURL(base15, band, factor)
              : await topStripDataURL(base15, band, factor);
            await worker.setParameters({ ...tessParams, tessedit_pageseg_mode: psm });
            const res15 = await worker.recognize(strip15);
            await worker.setParameters(tessParams);
            const lines15 = cleanAndMergeText(res15.data.text).split("\n").filter(Boolean);
            console.log("🔁 Pay-zone re-OCR (", stripKind, band.join("-"), "psm", psm, "):", lines15);
            stripEvidence.push({ stripKind, band, factor, psm, kernel: "catrom", lines: lines15, image: strip15 });
            for (const line of lines15) {
              if (!/pla[čc]ano|placano|za pla|zapla|master|osnova|davek|ddv|skupaj|vsota|znesek/i.test(line)) continue;
              const amts15 = [...line.matchAll(/\d{1,3}[.,]\d{1,2}/g)].map((mm) => parseFloat(mm[0].replace(",", ".")));
              const last15 = amts15[amts15.length - 1];
              if (last15 != null && Math.abs(last15 - D15) <= 0.02) {
                measured15 = last15;
                payWinner15 = { stripKind, band, factor, psm, line };
                break outer15;
              }
            }
          } catch (errPay) {
            console.warn("🔁 Pay-zone re-OCR attempt failed:", errPay);
          }
        }
        if (measured15 != null) {
          const res15 = payableRescue(finalParse, cleaned, measured15);
          if (res15) {
            Object.assign(finalParse, res15);
            payRescue = {
              amount: measured15,
              winner: payWinner15,
              attempts: stripEvidence.map((a) => ({
                stripKind: a.stripKind, band: a.band, factor: a.factor, psm: a.psm, kernel: a.kernel, lines: a.lines,
                image: payWinner15 && a.stripKind === payWinner15.stripKind && a.band[0] === payWinner15.band[0] &&
                       a.band[1] === payWinner15.band[1] && a.factor === payWinner15.factor && a.psm === payWinner15.psm
                  ? a.image : null,
              })),
            };
          }
        }
      }
    }
  }

  updateOCRProgressUI("OCR complete", 1);
  setTimeout(() => updateOCRProgressUI("", 0), 2000);
  // The winning attempt's strip image rides along for the evidence panel;
  // failed attempts keep their TEXT but their images are dropped for memory.
  const rescued = (extraItems.length > 0 || corrections.length > 0) && rescueWinner;
  return {
    text: cleaned,
    extraItems,
    corrections,
    payRescue,
    rescue: rescued
      ? {
          missing: missingBucket,
          winner: rescueWinner,
          attempts: stripEvidence.map((a) => ({
            stripKind: a.stripKind, band: a.band, factor: a.factor, psm: a.psm, kernel: a.kernel, lines: a.lines,
            image: a.stripKind === rescueWinner.stripKind && a.band[0] === rescueWinner.band[0] &&
                   a.band[1] === rescueWinner.band[1] && a.factor === rescueWinner.factor &&
                   a.psm === rescueWinner.psm && a.kernel === rescueWinner.kernel
              ? a.image : null,
          })),
        }
      : null,
  };
}
