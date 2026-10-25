import { createWorker } from "tesseract.js";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.js";
import { parseReceipt, isNonItemLine, namesScore, namesSimilar, payableRescue, discountAmounts, findDateCandidate, validDateFromReading } from "./parseReceipt";
// v2.1: canvas-free decode + preprocess. The pixels Tesseract sees are produced
// deterministically (WebCodecs / libheif decode → OpenCV Mats). The ONLY canvas
// touch is the final PNG encoding step, which keeps image sizes small enough for
// Tesseract to ingest (a raw 8000×6000 BMP is 144 MB and chokes the worker).
import { decodeToRGBA, rgbaToMat } from "./pixels";
import {
  ARM_GAP, CARD_MARKER_RE, COLUMN_TRIM, CONTRAST, CROP, CURRENCY_DEFAULT,
  DATE_RESCUE_ATTEMPTS, DESKEW_DEADBAND_DEG, DISCOUNT_ARM_RE, DISCOUNT_GATE_RE,
  DISCOUNT_PRESENT_RE,
  ITEM_BAND_ATTEMPTS, KERNEL_TAPS, KEYWORD_TOTAL_RE, LUMA, MEASURE_TOL,
  MIN_CORRECTION_NAME_LETTERS,
  MIN_STRIP_NAME_LETTERS, MISSING_ITEM_ATTEMPTS, MONEY_AMOUNT_RE, PAY_ZONE_ATTEMPTS,
  PAY_ZONE_MARKERS, PERSPECTIVE_EPSILON_FRAC, PIPELINE_DEFAULTS, PRESCALE,
  PROGRESSIVE_MAX_STEP, STAGE_PARAMS, STRIP_COLUMN_MARGIN_PX, STRIP_DARK_THRESHOLD,
  STRIP_DEFAULT_BAND, STRIP_DEFAULT_FACTOR, STRIP_DEFAULT_KERNEL, STRIP_INK_THRESHOLD,
  STRIP_PIXEL_BUDGET, TESSERACT_LANG, TESSERACT_OEM, TESSERACT_UPSCALE, TESS_PARAMS,
  TEXT_ANGLE,
} from "./ocrConfig.js";

GlobalWorkerOptions.workerSrc = pdfWorker;

// --- tesseract.js v7 worker: created once, reused for every page/image ---
// Params are delivered through setParameters (the v4 recognize-options path never
// applied them). Removed vs. v1 config: tessedit_ocr_engine_mode (now the createWorker
// argument), tessedit_char_whitelist (LSTM + whitelist misfires; strips diacritics),
// textord_heavy_nr (legacy-engine only, was always dead code at oem 1).
// Added: user_defined_dpi (fixes "Invalid resolution 0 dpi" defaulting to 70),
// preserve_interword_spaces (keeps SPAR-style multi-column spacing alive).
// All values live in ocrConfig.js (TESS_PARAMS / TESSERACT_LANG / TESSERACT_OEM).

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker(TESSERACT_LANG, TESSERACT_OEM, {
      logger: (m) => {
        if (m.status && typeof m.progress === "number") {
          updateOCRProgressUI(m.status, m.progress);
        }
      },
    }).then((w) => w.setParameters(TESS_PARAMS).then(() => w));
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
function upscaleDataURL(dataURL, factor = TESSERACT_UPSCALE.factor) {
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
    // Stage switches + their measured provenance: PIPELINE_DEFAULTS in
    // ocrConfig.js (evidence runs override any of these via window.__OCR_OPTS).
    const {
      grayscale = PIPELINE_DEFAULTS.grayscale,
      deskew = PIPELINE_DEFAULTS.deskew,
      perspectiveCorrection = PIPELINE_DEFAULTS.perspectiveCorrection,
      unsharpMask = PIPELINE_DEFAULTS.unsharpMask,
      smoothing = PIPELINE_DEFAULTS.smoothing,
      thresholding = PIPELINE_DEFAULTS.thresholding,
      adaptiveThresholding = PIPELINE_DEFAULTS.adaptiveThresholding,
      morph = PIPELINE_DEFAULTS.morph,
      denoise = PIPELINE_DEFAULTS.denoise,
      clahe = PIPELINE_DEFAULTS.clahe,
      invert = PIPELINE_DEFAULTS.invert,
      autoCrop = PIPELINE_DEFAULTS.autoCrop,
      autoCropMode = PIPELINE_DEFAULTS.autoCropMode,
      textAngleSign = PIPELINE_DEFAULTS.textAngleSign,
      contrastStretch = PIPELINE_DEFAULTS.contrastStretch,
    } = options;
    // v2.1: decode through WebCodecs / libheif — deterministic, no canvas.
    // The old path used new Image() + canvas.drawImage + cv.imread(canvas);
    // that canvas readback is what Brave's fingerprinting protection perturbs.
    const img = {};
    (async () => {
      const decoded = options.decoded || (await decodeToRGBA(imageSrc));
      img.width = decoded.width;
      img.height = decoded.height;
      console.log("🖼️ Image decoded:", img.width, "x", img.height, "via", decoded.via);
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
        cv.Canny(mat, edges, TEXT_ANGLE.cannyLow, TEXT_ANGLE.cannyHigh);
        const lines = new cv.Mat();
        cv.HoughLinesP(
          edges, lines,
          TEXT_ANGLE.houghRho, Math.PI / TEXT_ANGLE.houghThetaDeg,
          TEXT_ANGLE.houghThreshold, TEXT_ANGLE.houghMinLineLength, TEXT_ANGLE.houghMaxLineGap
        );
        let n = 0, lenSum = 0, angSum = 0;
        for (let i = 0; i < lines.rows; i++) {
          const x1 = lines.data32S[i * 4], y1 = lines.data32S[i * 4 + 1];
          const x2 = lines.data32S[i * 4 + 2], y2 = lines.data32S[i * 4 + 3];
          const len = Math.hypot(x2 - x1, y2 - y1);
          const ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
          if (Math.abs(ang) < TEXT_ANGLE.windowDeg && len >= TEXT_ANGLE.minLineLength) {
            n++;
            lenSum += len;
            angSum += ang * len;
          }
        }
        edges.delete();
        lines.delete();
        if (n < TEXT_ANGLE.minLines) return null; // too few confident baselines — don't rotate
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
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(CROP.closeKernelPx, CROP.closeKernelPx));
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
          cv.threshold(mat, binary, CROP.brightThreshold, 255, cv.THRESH_BINARY);
          const cols = new cv.Mat(), rows = new cv.Mat();
          cv.reduce(binary, cols, 0, cv.REDUCE_AVG, cv.CV_32F);
          cv.reduce(binary, rows, 1, cv.REDUCE_AVG, cv.CV_32F);
          const smooth = Math.max(CROP.smoothFloorPx, Math.round(Math.min(W, H) * CROP.smoothFrac) | 1);
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
            x: findBand(cols.data32F, W, CROP.bandFracX),
            y: findBand(rows.data32F, H, CROP.bandFracY),
          };
          cols.delete(); rows.delete(); binary.delete();
          if (band.x && band.y) {
            const bandArea = (band.x[1] - band.x[0] + 1) * (band.y[1] - band.y[0] + 1);
            if (bandArea >= CROP.fullFrameFrac * W * H) {
              // full-frame band = bright-background (scan-style) case:
              // ink-edge stage selects by the dark pixels instead
              const ink = new cv.Mat();
              cv.threshold(mat, ink, CROP.inkThreshold, 255, cv.THRESH_BINARY_INV);
              const ring = Math.round(Math.max(W, H) * CROP.ringFrac);
              const black = new cv.Scalar(0, 0, 0, 0); // erase scan-border lines
              cv.rectangle(ink, new cv.Point(0, 0), new cv.Point(W - 1, ring - 1), black, -1);
              cv.rectangle(ink, new cv.Point(0, H - ring), new cv.Point(W - 1, H - 1), black, -1);
              cv.rectangle(ink, new cv.Point(0, 0), new cv.Point(ring - 1, H - 1), black, -1);
              cv.rectangle(ink, new cv.Point(W - ring, 0), new cv.Point(W - 1, H - 1), black, -1);
              const icols = new cv.Mat(), irows = new cv.Mat();
              cv.reduce(ink, icols, 0, cv.REDUCE_AVG, cv.CV_32F);
              cv.reduce(ink, irows, 1, cv.REDUCE_AVG, cv.CV_32F);
              const ib = {
                x: findBand(icols.data32F, W, CROP.inkBandFrac),
                y: findBand(irows.data32F, H, CROP.inkBandFrac),
              };
              ink.delete(); icols.delete(); irows.delete();
              if (ib.x && ib.y) {
                const bw = ib.x[1] - ib.x[0] + 1, bh = ib.y[1] - ib.y[0] + 1;
                if (bw >= CROP.sanityFrac * W && bh >= CROP.sanityFrac * H) {
                  const mx = Math.round(W * CROP.inkMarginFrac), my = Math.round(H * CROP.inkMarginFrac);
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
              const mx = Math.round(W * CROP.profileMarginFrac), my = Math.round(H * CROP.profileMarginFrac);
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
            const boxOk = rect.width >= CROP.contourBoxWFrac * mat.cols && rect.height >= CROP.contourBoxHFrac * mat.rows && rect.width * rect.height >= CROP.contourAreaFrac * imgArea;
            if (boxOk) {
              const mx = Math.round(mat.cols * CROP.profileMarginFrac);
              const my = Math.round(mat.rows * CROP.profileMarginFrac);
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
      // Pixels -> Mat directly. The old path drew the image onto a canvas and
      // read it back with cv.imread(); that readback is exactly what Brave's
      // fingerprinting protection perturbs, profile by profile.
      let src, gray, sharpened, smoothed, thresh, kernel;
      try {
        src = rgbaToMat(decoded.data, decoded.width, decoded.height);
        // Preserve the historical pre-scale: photos narrower than 1000px used to
        // be drawn 2× onto the canvas before imread. Same intent, now a Mat
        // resize. The kernel must stay BILINEAR: the old canvas draw used
        // Chromium's default smoothing (bilinear); INTER_CUBIC here resampled
        // differently and measurably changed OCR on the two sub-1000px corpus
        // photos (eurospin-cropped 5→2 items, spar-2024-12-14 10→8).
        if (decoded.width < PRESCALE.minWidthPx) {
          const up = new cv.Mat();
          cv.resize(src, up, new cv.Size(decoded.width * PRESCALE.factor, decoded.height * PRESCALE.factor), 0, 0, cv.INTER_LINEAR);
          src.delete();
          src = up;
        }
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
          cv.convertScaleAbs(gray, stretched, CONTRAST.alpha, CONTRAST.beta);
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
          if (T !== null && Math.abs(T) > DESKEW_DEADBAND_DEG) {
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
            cv.approxPolyDP(maxContour, approx, PERSPECTIVE_EPSILON_FRAC * perimeter, true);
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
          cv.GaussianBlur(gray, blurredUM, new cv.Size(STAGE_PARAMS.unsharp.blurKsize, STAGE_PARAMS.unsharp.blurKsize), STAGE_PARAMS.unsharp.blurSigma);
          sharpened = new cv.Mat();
          cv.addWeighted(gray, STAGE_PARAMS.unsharp.alpha, blurredUM, STAGE_PARAMS.unsharp.beta, 0, sharpened);
          showIntermediate(sharpened, "Unsharp Masked");
          gray.delete();
          gray = sharpened;
          blurredUM.delete();
          await delay(300);
        }
        // Optional smoothing
        if (smoothing) {
          smoothed = new cv.Mat();
          cv.bilateralFilter(gray, smoothed, STAGE_PARAMS.smoothing.d, STAGE_PARAMS.smoothing.sigmaColor, STAGE_PARAMS.smoothing.sigmaSpace);
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
          let blockSize = Math.floor(Math.min(rows, cols) * STAGE_PARAMS.adaptive.blockFrac);
          if (blockSize % 2 === 0) {
            blockSize += 1;
          }
          blockSize = Math.max(blockSize, 3);
          const meanScalar = cv.mean(gray);
          const meanIntensity = meanScalar[0];
          const C = meanIntensity > STAGE_PARAMS.adaptive.meanSplit ? STAGE_PARAMS.adaptive.cBright : STAGE_PARAMS.adaptive.cDark;
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
          cv.medianBlur(gray, denoised, STAGE_PARAMS.denoise.ksize);
          showIntermediate(denoised, "Denoised (Median Blur)");
          gray.delete();
          gray = denoised;
          await delay(300);
        }
        // CLAHE enhancement
        if (clahe) {
          const claheInstance = new cv.CLAHE(STAGE_PARAMS.clahe.clip, new cv.Size(STAGE_PARAMS.clahe.tile, STAGE_PARAMS.clahe.tile));
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
          const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(STAGE_PARAMS.morph.ksize, STAGE_PARAMS.morph.ksize));
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

        // v2.1 final encoding: one canvas touch, at the very end, for PNG only.
        // Decode + preprocess are canvas-free; the PNG step keeps Tesseract's
        // input small (uncompressed 8000×6000 BMP = 144 MB and crashes the worker).
        const finalCanvas = document.createElement("canvas");
        finalCanvas.width = gray.cols;
        finalCanvas.height = gray.rows;
        cv.imshow(finalCanvas, gray);
        const dataURL = finalCanvas.toDataURL("image/png");

        // 2× upscale for Tesseract — same as the old upscaleDataURL path,
        // now on a canvas created from the processed Mat.
        const up = new cv.Mat();
        cv.resize(gray, up, new cv.Size(gray.cols * TESSERACT_UPSCALE.factor, gray.rows * TESSERACT_UPSCALE.factor), 0, 0, cv.INTER_CUBIC);
        const tesseractCanvas = document.createElement("canvas");
        tesseractCanvas.width = up.cols;
        tesseractCanvas.height = up.rows;
        cv.imshow(tesseractCanvas, up);
        const tesseractURL = tesseractCanvas.toDataURL("image/png");
        up.delete();

        // Capture the output geometry BEFORE the mats are freed — reading
        // .cols/.rows on a deleted Mat throws a BindingError (this cost a
        // full debugging round: the error surfaced two lines below, with
        // every preceding stage looking healthy).
        const outWidth = gray.cols, outHeight = gray.rows;
        gray.delete();
        src.delete();
        resolve({ tesseractURL, dataURL, width: outWidth, height: outHeight });
      } catch (err) {
        console.error("❌ Error during preprocessing:", err.name || "Error", err.message || "", err.stack?.slice(0, 300) || "");
        if (src) src.delete();
        if (kernel) kernel.delete();
        if (gray) gray.delete();
        reject(err);
      }
    })();
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
function topStripDataURL(preprocessedDataURL, band = STRIP_DEFAULT_BAND, factor = STRIP_DEFAULT_FACTOR, mode = STRIP_DEFAULT_KERNEL) {
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
            if (v < STRIP_DARK_THRESHOLD) dark++;
            n++;
          }
          colMeans.push(sum / n);
          darkCounts.push(dark);
        }
        const span = brightColumnTrim(colMeans, darkCounts);
        // only narrow when the projection found a plausible paper column
        const margin = STRIP_COLUMN_MARGIN_PX;
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
function rawStripDataURL(imageSrc, band = STRIP_DEFAULT_BAND, factor = STRIP_DEFAULT_FACTOR, mode = STRIP_DEFAULT_KERNEL) {
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
        const g = LUMA.r * d[i] + LUMA.g * d[i + 1] + LUMA.b * d[i + 2];
        const v = Math.max(0, Math.min(255, Math.round(CONTRAST.alpha * g + CONTRAST.beta)));
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
          if (v < STRIP_INK_THRESHOLD) darkCounts[x]++;
        }
      }
      for (let x = 0; x < img.width; x++) colMeans[x] /= h;
      const span = brightColumnTrim(colMeans, darkCounts);
      let left = 0;
      let right = img.width - 1;
      if (span) {
        left = Math.max(0, span[0] - STRIP_COLUMN_MARGIN_PX);
        right = Math.min(img.width - 1, span[1] + STRIP_COLUMN_MARGIN_PX);
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
  const factor = clampStripFactor(src.width, src.height, totalFactor);
  let out = src;
  let remaining = factor;
  while (remaining > 1.0001) {
    const step = Math.min(remaining, PROGRESSIVE_MAX_STEP);
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
/**
 * Strip pixel budget. Live evidence (2026-10-24, s25-hofer sweep): a 3x upscale
 * of a 3000x4000 phone photo's top band is ~16.5 MP of table texture, and
 * Tesseract PSM 6 ground 164 s on it (the scan that should take seconds). The
 * validated small-photo strips sit far under these bounds (hofer ~2.3 MP,
 * eurospin ~1.2 MP), so the budget only ever bites on phone-photo receipts —
 * where it is the difference between a 26 s scan and a 190 s one.
 */
function clampStripFactor(sw, sh, factor) {
  let f = factor;
  if (sw * f > STRIP_PIXEL_BUDGET.maxWidthPx) f = STRIP_PIXEL_BUDGET.maxWidthPx / sw;
  if (sw * sh * f * f > STRIP_PIXEL_BUDGET.maxArea) f = Math.sqrt(STRIP_PIXEL_BUDGET.maxArea / (sw * sh));
  return Math.max(STRIP_PIXEL_BUDGET.minFactor, f);
}

function bicubicUpscaleGrayCanvas(srcCanvas, factor, mode = STRIP_DEFAULT_KERNEL) {
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
  factor = clampStripFactor(sw, sh, factor);
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
  const taps = isLanczos ? KERNEL_TAPS.lanczos3 : KERNEL_TAPS.catrom;
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
 *
 * v2.0.29 wide-gap chain (EUROSPIN-cropped live measurement): a receipt's
 * PRICE column is a SEPARATE ink run from its NAME column — the measured
 * item band had runs at x[0..866] (names), x[1007..1216] (prices) and
 * x[1283..1325] (paper edge), i.e. a 141px whitespace gap on a 1326px-wide
 * crop. The longest-run pick kept the names and discarded every price, so no
 * strip could measure a missing row's amount (the hunt then found nothing in
 * 8 band variants while the same pixels read "EKSI FROLLINI 1KG 1,55 A" in
 * the Node bench at full width). Runs are now chained while their separation
 * stays within a quarter of the width, and the widest chain's OUTERMOST
 * bounds are kept: the price column is part of the receipt, not a
 * neighbouring object. Distant objects (a second receipt, a margin stamp)
 * still form their own chain and lose to the widest one.
 */
function brightColumnTrim(colMeans, darkCounts, minWidthFraction = COLUMN_TRIM.minWidthFraction, maxGapPx = COLUMN_TRIM.maxGapPx) {
  const n = colMeans.length;
  const smooth = new Array(n).fill(0);
  for (let x = 0; x < n; x++) {
    let s = 0;
    for (let k = Math.max(0, x - COLUMN_TRIM.smoothWindowPx); k <= Math.min(n - 1, x + COLUMN_TRIM.smoothWindowPx); k++) {
      s += darkCounts ? darkCounts[k] : 0;
    }
    smooth[x] = s;
  }
  const runs = [];
  let curStart = -1;
  let lastInk = -1;
  for (let x = 0; x <= n; x++) {
    const isP = x < n && smooth[x] >= COLUMN_TRIM.minInk;
    if (isP) {
      if (curStart < 0) curStart = x;
      lastInk = x;
    } else if (curStart >= 0) {
      if (x - lastInk <= maxGapPx && x < n) continue;
      runs.push([curStart, lastInk]);
      curStart = -1;
      lastInk = -1;
    }
  }
  if (!runs.length) return null;
  const wideGap = Math.max(maxGapPx, Math.round(n * COLUMN_TRIM.wideGapFrac));
  const chains = [];
  for (const [a, b] of runs) {
    const last = chains[chains.length - 1];
    if (last && a - last[1] <= wideGap) {
      last[0] = Math.min(last[0], a);
      last[1] = Math.max(last[1], b);
    } else {
      chains.push([a, b]);
    }
  }
  let best = null;
  for (const c of chains) {
    if (!best || c[1] - c[0] > best[1] - best[0]) best = c;
  }
  if (!best || best[1] - best[0] + 1 < n * minWidthFraction) return null;
  return [Math.max(0, best[0] - COLUMN_TRIM.slackLeftPx), Math.min(n - 1, best[1] + COLUMN_TRIM.slackRightPx)];
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
  const pre = await preprocessWithOpenCV(imageSrc, preOpts);
  const preprocessedDataURL = pre.dataURL;
  if (window.__OCR_DEBUG === true) {
    await pushStageDataURL("after OpenCV preprocessing", pre.dataURL);
    await pushStageDataURL("upscaled 2× — exact pixels fed to Tesseract", pre.tesseractURL);
  }
  const worker = await getWorker();
  const result = await worker.recognize(pre.tesseractURL);
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
      freshWorker = await createWorker(TESSERACT_LANG, TESSERACT_OEM, {});
      await freshWorker.setParameters(TESS_PARAMS);
      const secondResult = await freshWorker.recognize(pre.tesseractURL);
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
    if (!DISCOUNT_ARM_RE.test(cleaned)) {
      const sumCheck = finalChecks.find((c) => !c.ok && /items sum ([\d.]+) ≠ total ([\d.]+)/.test(c.text));
      if (sumCheck && finalParse.total) {
        const t = parseFloat((finalParse.total.match(/([\d.,]+)/) || [])[1]?.replace(",", "."));
        const sum = parseFloat(sumCheck.text.match(/items sum ([\d.]+)/)[1]);
        if (!isNaN(t) && !isNaN(sum) && t - sum > ARM_GAP) {
          missing = +(t - sum).toFixed(2);
        } else if (!isNaN(t) && !isNaN(sum)) {
          // v2.0.19 (real case, user capture of the HOFER EFT tail on deployed
          // v2.0.18): the picked total came from an EFT/card line the garbled
          // EFT appendix produced ("WIEN VISA Mm 4.13" for 4,73) while the
          // clean TOTAL-KEYWORD line read higher ("Vmesna vsota 4,73") and the
          // item rows read exact but fewer (0.85 + 2.09 = 2.94). The naive gap
          // t − sum (1.19) would send the strip re-OCR hunting a row that
          // does not exist. The printed keyword total supplies the target:
          // missing = V − sum, still MEASUREMENT-gated — the strip must
          // re-OCR a row reading exactly V − sum ±0.02. Strict guards:
          // keyword line WITHOUT any card/EFT marker, only the same tier
          // keywords the total picker honors, V > t + 0.02 AND V > sum —
          // SPAR's loyalty trap ("Tocke zvestobe-vsota 5.00", 5.00 < total
          // 51.61) and EUROSPIN's equal "za plačilo 4,29" both fail V > sum;
          // INTERSPORT's garbled "ZA PLACILO 59,99" fails V > sum (items 79.99).
          let vKey = null;
          for (const ln of cleaned.split("\n")) {
            if (!KEYWORD_TOTAL_RE.test(ln)) continue;
            if (CARD_MARKER_RE.test(ln)) continue;
            const amts = [...ln.matchAll(MONEY_AMOUNT_RE)].map((mm) => parseFloat(mm[0].replace(",", ".")));
            const last = amts[amts.length - 1];
            if (last != null && (vKey == null || last > vKey)) vKey = last;
          }
          if (vKey != null && vKey > t + MEASURE_TOL && vKey > sum) {
            missing = +(vKey - sum).toFixed(2);
            console.log("🔁 Total-keyword line reads", vKey, "> picked total", t, "— strip target = V − items =", missing);
          }
        }
      }
    }
  }
  // v2.0.28: the missing-item hunt and the price-correction hunt are two
  // stories for the SAME failing sum check — a row the OCR dropped entirely
  // (missing item) vs a row the OCR mispriced (correction). They used to be
  // mutually exclusive (`if (missing != null) … else …`), which stranded the
  // misread-price story whenever the gap came out positive: s25-hofer's
  // "Skleda za mešanje 8,49" was read "3,49", the 5,00 gap armed the
  // missing-item hunt, but this photo's items sit at ~45% of the paper so the
  // top-25% strips read table texture — while the item-band re-OCR that DOES
  // cover the row (40-75% band) measured "8,49" in the Node bench. Now: hunt
  // the missing row first (the more specific story); when it measures
  // nothing, fall through to the correction cascade. Both stay
  // measurement-gated — the correction path's name-match, arithmetic-
  // improvement and all-or-nothing guards are untouched.
  let missingHuntResolved = false;
  if (missing != null) {
    missingBucket = missing;
    const alreadyParsed = finalParse.items.some(
      (it) => Math.abs((parseFloat(it.price) ?? 0) - missing) <= MEASURE_TOL
    );
    if (!alreadyParsed) {
      let strip = null;
      try {
        const currency = (finalParse.total || "").split(" ")[1] || CURRENCY_DEFAULT;
        // cascade: strip band × page-seg. Attempt order and provenance:
        // MISSING_ITEM_ATTEMPTS in ocrConfig.js (full-frame strips garbled
        // "prv 7S"; the price needed PSM 4; the 0.4-0.75 item-band variants
        // hunt tall-header receipts whose rows sit at ~45% of the paper).
        outer: for (const [stripKind, band, psm, factor] of MISSING_ITEM_ATTEMPTS) {
          // strip from the PRE-perspective image when available: creased rows
          // garble under the warp (live evidence), while the unwrapped crop
          // is what the Node benchmarks read correctly. "raw" attempts bypass
          // resampling entirely (canvas gray+stretch math == sharp params).
          const base = prePerspectiveDataURL || (stripKind === "raw" ? imageSrc : preprocessedDataURL);
          strip = stripKind === "raw" ? await rawStripDataURL(base, band, factor) : await topStripDataURL(base, band, factor);
          await worker.setParameters({ ...TESS_PARAMS, tessedit_pageseg_mode: psm });
          const stripResult = await worker.recognize(strip);
          await worker.setParameters(TESS_PARAMS);
          const stripText = cleanAndMergeText(stripResult.data.text);
          const stripLines = stripText.split("\n").filter(Boolean);
          console.log("🔁 Strip re-OCR (missing item ≈", missing.toFixed(2), ", strip", stripKind, band.join("-"), "psm", psm, "):", stripLines);
          stripEvidence.push({ stripKind, band, factor, psm, lines: stripLines, image: strip });
          for (const line of stripLines) {
            const amounts = [...line.matchAll(MONEY_AMOUNT_RE)].map((m) =>
              parseFloat(m[0].replace(",", "."))
            );
            const hit = amounts.find((a) => Math.abs(a - missing) <= MEASURE_TOL);
            if (hit == null) continue;
            // v2.0.29: item-band strips also carry totals/tender machinery
            // ("otovina EUR 13,00", "Skupaj 4,29"). extraItems bypass every
            // parser guard on injection, so a machinery line whose amount
            // happens to equal the gap would become a phantom item that
            // CLOSES the sum check. Apply the parser's own exclusion test
            // (same patterns, pipe-tolerant) before accepting a hit.
            if (isNonItemLine(line)) continue;
            const tokens = line.trim().split(/\s+/);
            let end = 0;
            while (end < tokens.length && !/\d/.test(tokens[end])) end++;
            let name = tokens.slice(0, end).join(" ");
            name = name.replace(/^[^a-zA-ZčšžČŠŽ]+\s*/, "").trim();
            const letterCount = (name.match(/[a-zA-ZčšžČŠŽ]/g) || []).length;
            if (letterCount < MIN_STRIP_NAME_LETTERS) continue;
            extraItems.push({
              name,
              price: `${hit.toFixed(2)} ${currency}`,
              quantity: undefined,
              via: "strip-retry",
              band,
            });
            rescueWinner = { stripKind, band, factor, psm, line };
            break outer; // one rescued row per bucket
          }
        }
      } catch (err) {
        console.warn("🔁 Strip re-OCR failed, skipping rescue:", err);
      }
      // a measured row ends the story; an empty hunt hands the same failing
      // sum check to the item-band correction cascade below
      if (rescueWinner) missingHuntResolved = true;
    } else {
      // an item already carries the gap amount — nothing to hunt for
      missingHuntResolved = true;
    }
  }
  if (!missingHuntResolved) {
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
    const discountMarker = DISCOUNT_GATE_RE.test(cleaned);
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
      // where catrom @2x PSM6 lost it. Table: ITEM_BAND_ATTEMPTS in
      // ocrConfig.js.
      for (const [stripKind, band, factor, psm, kernel] of ITEM_BAND_ATTEMPTS) {
        try {
          const base = prePerspectiveDataURL || (stripKind === "raw" ? imageSrc : preprocessedDataURL);
          const strip = stripKind === "raw"
            ? await rawStripDataURL(base, band, factor, kernel)
            : await topStripDataURL(base, band, factor, kernel);
          await worker.setParameters({ ...TESS_PARAMS, tessedit_pageseg_mode: psm });
          const stripResult = await worker.recognize(strip);
          await worker.setParameters(TESS_PARAMS);
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
            const amounts = [...line.matchAll(MONEY_AMOUNT_RE)].map((m) =>
              parseFloat(m[0].replace(",", "."))
            );
            if (!amounts.length) continue;
            const price = amounts[amounts.length - 1];
            const tokens = line.trim().split(/\s+/);
            let end = 0;
            while (end < tokens.length && !/\d/.test(tokens[end])) end++;
            let name = tokens.slice(0, end).join(" ");
            name = name.replace(/^[^a-zA-ZčšžČŠŽ]+\s*/, "").trim();
            if ((name.match(/[a-zA-ZčšžČŠŽ]/g) || []).length < MIN_CORRECTION_NAME_LETTERS) {
              // v2.0.28: HOFER rows lead with the EAN code ("736115 Skleda za
              // mešanje 8,49 B"), so the "up to the first digit token" rule
              // yields an empty name and the correction is dropped before it
              // can ever match its item. Retry with everything before the
              // trailing price (+VAT letter) — the same shape the parser
              // itself keeps as the item name ("736115 Skleda za me$anje").
              const m2 = line.match(/^(.*?)\s+\d{1,3}[.,]\d{2}\s*[A-Ea-e]?\s*$/);
              if (m2) name = m2[1].replace(/^[^a-zA-ZčšžČŠŽ]+\s*/, "").trim();
            }
            if ((name.match(/[a-zA-ZčšžČŠŽ]/g) || []).length < MIN_CORRECTION_NAME_LETTERS) continue;
            // best-matching item only (no brand-prefix first-match pairing)
            let target = null;
            let bestScore = 0;
            for (const it of finalParse.items) {
              const s = namesScore(name, it.name);
              if (s > bestScore + 1e-9) { bestScore = s; target = it; }
            }
            if (!target || !namesSimilar(name, target.name)) continue; // no solid match -> drop, could be anything
            const oldPrice = parseFloat(String(target.price ?? "").replace(",", "."));
            if (!isNaN(oldPrice) && Math.abs(oldPrice - price) <= MEASURE_TOL) continue;
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
  // failure stories, never both on one receipt. v2.0.19: ALSO armed after a
  // SUCCESSFUL top-strip rescue (rescueWinner set): the leftover sum mismatch
  // is then by definition a misread-total-zone story, and the decision must
  // be evaluated on the CORRECTED parse — exactly the parse app.js will
  // build (parseReceipt(cleaned, extraItems, corrections)) so the decision
  // here and in runParsing provably agree. payableRescue's own gates still
  // apply, so every other failure story aborts unchanged.
  let payRescue = null;
  // v2.0.20: strip-reading diagnostics for the pay arm — non-null ONLY when
  // the arm fired (a target was derivable) and NO band measured it. Rides
  // into the sync manifest so a future capture's failed band readings are
  // evidence, not silence (the HOFER 4,73->4,13 dotted-bold class).
  let payDebug = null;
  if (missing == null || rescueWinner != null) {
    let payParse = finalParse;
    let payChecks = finalChecks;
    if (rescueWinner != null) {
      try {
        payParse = parseReceipt(cleaned, extraItems, corrections);
        payChecks = payParse.checks || [];
      } catch (errPayPost) {
        console.warn("🔁 Pay-zone corrected re-parse failed:", errPayPost);
        payParse = finalParse;
        payChecks = finalChecks;
      }
    }
    const sumMismatchPay = payChecks.find(
      (c) => !c.ok && /items sum ([\d.]+) ≠ total ([\d.]+)/.test(c.text)
    );
    const discountPresent15 = DISCOUNT_PRESENT_RE.test(cleaned);
    const bucketHintPay15 = payChecks.some((c) => /missing item ≈/.test(c.text));
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
      if (D15 != null && D15 > 0 && !isNaN(T15) && Math.abs(D15 - T15) > MEASURE_TOL) {
        console.log("🔁 Pay-zone rescue armed: items", I15, p15.length === 1 ? "− POPUST" + pLabel15 : "(no discount)", "=", D15, "≠ read total", T15);
        // v2.0.20 diagnostics: every executed band's readings are evidence —
        // on a rescue they are abandoned (payRescue carries the same info),
        // on a miss they ride to the manifest.
        payDebug = { target: D15, armedFrom: p15.length === 1 ? `items ${I15} − POPUST ${pLabel15}` : `items sum ${I15} (no discount)`, attempts: [] };
        let measured15 = null;
        let payWinner15 = null;
        // v2.0.20: appended diversity — kernel sweep lesson (scripts/
        // ocr-eurospin-kernel-sweep.mjs: catrom vs lanczos3 flip the same
        // row's digits), ×3 zoom, PSM 7 single-line mode. Everything AFTER
        // the five proven attempts, so every previously-winning band still
        // comes first: receipts that already resolve take the identical
        // early-exit path. Table: PAY_ZONE_ATTEMPTS in ocrConfig.js.
        outer15: for (const [stripKind, band, factor, psm, payKernel15] of PAY_ZONE_ATTEMPTS) {
          try {
            const base15 = prePerspectiveDataURL || (stripKind === "raw" ? imageSrc : preprocessedDataURL);
            const strip15 = stripKind === "raw"
              ? await rawStripDataURL(base15, band, factor, payKernel15)
              : await topStripDataURL(base15, band, factor, payKernel15);
            await worker.setParameters({ ...TESS_PARAMS, tessedit_pageseg_mode: psm });
            const res15 = await worker.recognize(strip15);
            await worker.setParameters(TESS_PARAMS);
            const lines15 = cleanAndMergeText(res15.data.text).split("\n").filter(Boolean);
            console.log("🔁 Pay-zone re-OCR (", stripKind, band.join("-"), factor + "x", payKernel15, "psm", psm, "):", lines15);
            const hit15 = lines15.some(
              (line) =>
                PAY_ZONE_MARKERS.test(line) &&
                [...line.matchAll(MONEY_AMOUNT_RE)].length &&
                Math.abs(parseFloat([...line.matchAll(MONEY_AMOUNT_RE)].pop()[0].replace(",", ".")) - D15) <= MEASURE_TOL
            );
            payDebug.attempts.push({ stripKind, band, factor, psm, kernel: payKernel15, lines: lines15, hit: hit15 });
            stripEvidence.push({ stripKind, band, factor, psm, kernel: payKernel15, lines: lines15, image: strip15 });
            for (const line of lines15) {
              if (!PAY_ZONE_MARKERS.test(line)) continue;
              const amts15 = [...line.matchAll(MONEY_AMOUNT_RE)].map((mm) => parseFloat(mm[0].replace(",", ".")));
              const last15 = amts15[amts15.length - 1];
              if (last15 != null && Math.abs(last15 - D15) <= MEASURE_TOL) {
                measured15 = last15;
                payWinner15 = { stripKind, band, factor, psm, kernel: payKernel15, line };
                break outer15;
              }
            }
          } catch (errPay) {
            console.warn("🔁 Pay-zone re-OCR attempt failed:", errPay);
          }
        }
        if (measured15 != null) {
          payDebug = null; // resolved — nothing to diagnose
          const res15 = payableRescue(payParse, cleaned, measured15);
          if (res15) {
            Object.assign(finalParse, res15);
            payRescue = {
              amount: measured15,
              winner: payWinner15,
              attempts: stripEvidence.map((a) => {
                const won15 = payWinner15 && a.stripKind === payWinner15.stripKind && a.band[0] === payWinner15.band[0] &&
                  a.band[1] === payWinner15.band[1] && a.factor === payWinner15.factor && a.psm === payWinner15.psm &&
                  a.kernel === payWinner15.kernel;
                return {
                  stripKind: a.stripKind, band: a.band, factor: a.factor, psm: a.psm, kernel: a.kernel, lines: a.lines,
                  won: won15 || null, // v2.0.25: winner marked at source — the panel
                  // never re-infers identity across objects
                  image: won15 ? a.image : null,
                };
              }),
            };
          }
        }
      }
    }
  }

  // v2.0.22 date rescue — measurement, not decomposition (policy: the printed
  // date physically exists on the paper; an ambiguous garble like
  // "103.2025" is a three-way coin flip ONLY for arithmetic, never for the
  // pixels). Arms ONLY when the parse extracted NO date AND a fused
  // date-candidate line survives (tight form: group.20xx + HH:MM — the
  // HOFER-EFT appendix). Accepts a COMPLETE calendar-valid reading from any
  // strip attempt; otherwise the date stays null ("—") exactly as before,
  // so every previously-resolving receipt is untouched.
  let dateRescue = null;
  if (finalParse.date == null) {
    const candidate22 = findDateCandidate(cleaned);
    if (candidate22) {
      console.log("🗓 Date candidate (fused, no parseable date):", JSON.stringify(candidate22), "— strip re-OCR armed");
      const attempts22 = [];
      let dISO22 = null;
      let dWin22 = null;
      outer22: for (const [stripKind22, band22, factor22, psm22, kernel22] of DATE_RESCUE_ATTEMPTS) {
        try {
          const base22 = prePerspectiveDataURL || (stripKind22 === "raw" ? imageSrc : preprocessedDataURL);
          const strip22 = stripKind22 === "raw"
            ? await rawStripDataURL(base22, band22, factor22, kernel22)
            : await topStripDataURL(base22, band22, factor22, kernel22);
          await worker.setParameters({ ...TESS_PARAMS, tessedit_pageseg_mode: psm22 });
          const res22 = await worker.recognize(strip22);
          await worker.setParameters(TESS_PARAMS);
          const lines22 = cleanAndMergeText(res22.data.text).split("\n").filter(Boolean);
          const iso22 = validDateFromReading(lines22);
          console.log("🗓 Date re-OCR (", stripKind22, band22.join("-"), factor22 + "x", kernel22, "psm", psm22, "):", lines22, "->", iso22);
          attempts22.push({ stripKind: stripKind22, band: band22, factor: factor22, psm: psm22, kernel: kernel22, lines: lines22, hit: Boolean(iso22) });
          if (iso22) {
            dISO22 = iso22;
            dWin22 = { stripKind: stripKind22, band: band22, factor: factor22, psm: psm22, kernel: kernel22, line: lines22.find((l) => l === candidate22 || validDateFromReading([l])) || "" };
            break outer22;
          }
        } catch (errDate) {
          console.warn("🗓 Date re-OCR attempt failed:", errDate);
        }
      }
      if (dISO22) {
        console.log("🗓 Date rescue: measured", dISO22, "on strip band", dWin22.band.join("-"), dWin22.kernel, "— parsed OCR text carried no date");
        dateRescue = {
          date: dISO22,
          winner: dWin22,
          attempts: attempts22, // text evidence only; images dropped
        };
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
    payDebug,
    dateRescue,
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
