import { createWorker } from "tesseract.js";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.js";
import { parseReceipt, namesSimilar } from "./parseReceipt";

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
          // Stage capture (v1.7.2): the creased top row garbles UNDER the
          // perspective warp (HOFER strip experiments: warped strip reads
          // "prv 7S"/"rei B" at every PSM; unwrapped Node bench reads the
          // price). The adaptive strip rescue needs the pre-warp image.
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
export async function processImage(imageSrc, onProgress = () => {}) {
  let prePerspectiveDataURL = null;
  const preprocessedDataURL = await preprocessWithOpenCV(imageSrc, {
    onStageDataURLs: ({ stage, dataURL }) => {
      if (stage === "prePerspective" && !prePerspectiveDataURL) prePerspectiveDataURL = dataURL;
    },
  });
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
  if (bucketText) {
    const missing = parseFloat(bucketText.text.match(/missing item ≈ ([\d.]+)/)[1]);
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
    if (sumMismatch && finalParse.items.length >= 2) {
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
      let attemptIdx = 0;
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
            const target = finalParse.items.find((it) => namesSimilar(name, it.name));
            if (!target) continue; // no name match -> not a correction, could be anything
            const oldPrice = parseFloat(String(target.price ?? "").replace(",", "."));
            if (!isNaN(oldPrice) && Math.abs(oldPrice - price) <= 0.02) continue;
            if (corrections.some((c) => c.attempt === attemptIdx && namesSimilar(c.name, name))) continue;
            corrections.push({ name, price, attempt: attemptIdx });
          }
        } catch (err) {
          console.warn("🔁 Item-band re-OCR attempt failed:", err);
        }
        attemptIdx++;
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

  updateOCRProgressUI("OCR complete", 1);
  setTimeout(() => updateOCRProgressUI("", 0), 2000);
  // The winning attempt's strip image rides along for the evidence panel;
  // failed attempts keep their TEXT but their images are dropped for memory.
  const rescued = (extraItems.length > 0 || corrections.length > 0) && rescueWinner;
  return {
    text: cleaned,
    extraItems,
    corrections,
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
