import { createWorker } from "tesseract.js";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.js";
import { parseReceipt } from "./parseReceipt";

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

export function preprocessWithOpenCV(imageSrc, options = {}) {
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
      contrastStretch = true, // v1.7: linear a=1.6 b=-80 after crop. Measured on EUROSPIN
      // (ocr-eurospin2): contrast-stretched OCR read 3/3 item amounts (1,55/1,29/1,45),
      // unstretched read 0-2/3. Thermal print contrast is naturally low after crops.
    } = options;
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = async () => {
      console.log("🖼️ Image loaded:", img.width, "x", img.height);
      const container = document.createElement("div");
      container.style.display = "flex";
      container.style.flexWrap = "wrap";
      container.style.gap = "10px";
      container.style.margin = "20px 0";
      container.style.border = "1px solid #ccc";
      container.style.padding = "10px";
      container.style.background = "#fafafa";
      document.body.appendChild(container);
      function showIntermediate(mat, label) {
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
        return new Promise((res) => setTimeout(res, ms));
      }

      function cropToReceipt(mat) {
        // Isolate the paper from cluttered backgrounds (EUROSPIN real case:
        // black mesh mat + keyboard). Otsu bright mask selects the paper,
        // morphological closing bridges fold shadows that split it, then the
        // largest bright region is bounded and cut with a small margin.
        // Sanity guards leave the image untouched when no paper-sized region
        // is found (no crop-below-threshold surprises).
        const binary = new cv.Mat();
        cv.threshold(mat, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
        const closed = new cv.Mat();
        cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);
        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        const imgArea = mat.rows * mat.cols;
        let maxContour = null;
        let maxArea = 0;
        for (let i = 0; i < contours.size(); i++) {
          const contour = contours.get(i);
          const area = cv.contourArea(contour);
          if (area > maxArea) {
            maxArea = area;
            if (maxContour) maxContour.delete();
            maxContour = contour;
          } else {
            contour.delete();
          }
        }
        let result = null;
        if (maxContour) {
          const rect = cv.boundingRect(maxContour);
          if (
            rect.width >= 0.25 * mat.cols &&
            rect.height >= 0.25 * mat.rows &&
            rect.width * rect.height >= 0.15 * imgArea
          ) {
            const mx = Math.round(mat.cols * 0.02);
            const my = Math.round(mat.rows * 0.02);
            const x = Math.max(0, rect.x - mx);
            const y = Math.max(0, rect.y - my);
            const w = Math.min(mat.cols - x, rect.width + 2 * mx);
            const h = Math.min(mat.rows - y, rect.height + 2 * my);
            const roi = mat.roi({ x, y, width: w, height: h });
            result = roi.clone();
            roi.delete();
            console.log("✂️ Receipt region:", JSON.stringify({ x, y, w, h }));
          } else {
            console.log("↩️ Receipt region too small, leaving frame untouched");
          }
        }
        contours.delete();
        hierarchy.delete();
        closed.delete();
        binary.delete();
        kernel.delete();
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
          const receiptRegion = cropToReceipt(gray);
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
        // Step 2: Deskew
        if (deskew) {
          console.log("🧭 Step 2: Deskewing started");
          const binary = new cv.Mat();
          cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
          const contours = new cv.MatVector();
          const hierarchy = new cv.Mat();
          cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
          let maxArea = 0;
          let maxContour = null;
          for (let i = 0; i < contours.size(); i++) {
            const contour = contours.get(i);
            const area = cv.contourArea(contour);
            if (area > maxArea) {
              maxArea = area;
              maxContour = contour;
            }
          }
          if (maxContour && maxContour.rows >= 5) {
            const rotatedRect = cv.minAreaRect(maxContour);
            let angle = rotatedRect.angle;
            if (rotatedRect.size.width < rotatedRect.size.height) {
            } else {
              angle += 90;
            }
            if (angle < -45) angle += 180;
            if (angle > 45) angle -= 180;
            if (Math.abs(angle) > 1.0) {
              const center = new cv.Point(gray.cols / 2, gray.rows / 2);
              const M = cv.getRotationMatrix2D(center, angle, 1.0);
              const rotated = new cv.Mat();
              cv.warpAffine(
                gray,
                rotated,
                M,
                new cv.Size(gray.cols, gray.rows),
                cv.INTER_LINEAR,
                cv.BORDER_CONSTANT,
                new cv.Scalar(255, 255, 255, 255)
              );
              showIntermediate(rotated, `Deskewed (angle: ${angle.toFixed(2)}°)`);
              gray.delete();
              gray = rotated;
              M.delete();
              await delay(300);
            } else {
              console.log("✅ Angle too small, skipping rotation");
            }
          }
          binary.delete();
          hierarchy.delete();
          contours.delete();
        }
        // Step 3: Perspective Correction
        if (perspectiveCorrection) {
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
              showIntermediate(warped, "Perspective Corrected");
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

// --- No arbitrary merging - just a pass-through for now (adjust if needed) ---
export function mergeItemLines(rawText) {
  return rawText || "";
}

// --- Position-aware text extraction from a single PDF page ---
export async function extractTextLinesFromPDFPage(page) {
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
  if (progressBar && statusText) {
    progressBar.style.width = `${(progressFraction * 100).toFixed(1)}%`;
    statusText.textContent = status ? `OCR Status: ${status}` : "Waiting to start OCR...";
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

// --- OCR + preprocessing for direct image files ---
export async function processImage(imageSrc, onProgress = () => {}) {
  const preprocessedDataURL = await preprocessWithOpenCV(imageSrc);
  const upscaled = await upscaleDataURL(preprocessedDataURL);
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

  updateOCRProgressUI("OCR complete", 1);
  setTimeout(() => updateOCRProgressUI("", 0), 2000);
  return cleaned;
}
