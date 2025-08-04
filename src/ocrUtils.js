import Tesseract from "tesseract.js";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.js";

GlobalWorkerOptions.workerSrc = pdfWorker;

const tesseractConfig = {
  tessedit_pageseg_mode: 6,
  tessedit_ocr_engine_mode: 1,
  tessedit_char_whitelist:
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,-/:$€",
};

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
      unsharpMask = true,
      smoothing = false,
      thresholding = false,
      adaptiveThresholding = true,
      denoise = true,
      clahe = true,
      invert = true,
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

      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);

      let src, gray, blurred, sharpened, smoothed, thresh;

      try {
        src = cv.imread(canvas);
        console.log("📥 Step 0: Image read into OpenCV");

        // Step 1: Grayscale
        if (grayscale) {
          gray = new cv.Mat();
          cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
          showIntermediate(gray, "Grayscale");
          console.log("⚙️ Step 1: Grayscale complete");
          await delay(300);
        } else {
          gray = src.clone();
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
              // portrait - keep angle as is
            } else {
              angle += 90;
            }

            if (angle < -45) {
              angle += 180;
            }

            if (angle > 45) {
              angle -= 180;
            }

            console.log("🔄 Detected rotation angle:", angle.toFixed(2));

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
          } else {
            console.log("⚠️ No contour found for deskewing");
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
                orderedSrcPts[3].x, orderedSrcPts[3].y,
              ]);

              const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
                dstPts[0].x, dstPts[0].y,
                dstPts[1].x, dstPts[1].y,
                dstPts[2].x, dstPts[2].y,
                dstPts[3].x, dstPts[3].y,
              ]);

              const M = cv.getPerspectiveTransform(srcTri, dstTri);
              const warped = new cv.Mat();

              cv.warpPerspective(
                gray,
                warped,
                M,
                new cv.Size(maxWidth, maxHeight),
                cv.INTER_LINEAR,
                cv.BORDER_CONSTANT,
                new cv.Scalar(255, 255, 255, 255)
              );

              showIntermediate(warped, "Perspective Corrected");
              gray.delete();
              gray = warped;

              srcTri.delete();
              dstTri.delete();
              M.delete();

              await delay(300);
            } else {
              console.log("⚠️ Contour approximation did not find 4 points - skipping perspective correction");
            }

            approx.delete();
          } else {
            console.log("⚠️ No contour found for perspective correction");
          }

          binaryForPerspective.delete();
          hierarchy.delete();
          contours.delete();
        }

        // Step 4: CLAHE (Contrast Limited Adaptive Histogram Equalization)
        if (clahe) {
          console.log("✨ Step 4: Applying CLAHE");
          const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
          const claheDst = new cv.Mat();
          clahe.apply(gray, claheDst);
          showIntermediate(claheDst, "CLAHE Applied");
          gray.delete();
          gray = claheDst;
          clahe.delete();
          await delay(300);
        }

        // Step 5: Denoising
        if (denoise) {
          console.log("✨ Step 5: Applying bilateralFilter for denoising");
          const denoised = new cv.Mat();
          // Parameters: src, dst, diameter, sigmaColor, sigmaSpace
          cv.bilateralFilter(gray, denoised, 9, 75, 75, cv.BORDER_DEFAULT);
          showIntermediate(denoised, "Denoised with bilateralFilter");
          gray.delete();
          gray = denoised;
          await delay(300);
        }

        // Step 6: Unsharp Mask (Sharpening)
        if (unsharpMask) {
          console.log("✨ Step 6: Applying unsharp mask");

          const blurred = new cv.Mat();
          const sharpened = new cv.Mat();

          cv.GaussianBlur(gray, blurred, new cv.Size(0, 0), 3);
          // sharpened = 1.5*gray - 0.5*blurred
          cv.addWeighted(gray, 1.5, blurred, -0.5, 0, sharpened);

          showIntermediate(sharpened, "Unsharp Mask Applied");

          gray.delete();
          blurred.delete();
          gray = sharpened;
          await delay(300);
        }

        // Step 7: Thresholding (Global or Adaptive)
        if (thresholding || adaptiveThresholding) {
          thresh = new cv.Mat();

          if (adaptiveThresholding) {
            cv.adaptiveThreshold(
              gray,
              thresh,
              255,
              cv.ADAPTIVE_THRESH_GAUSSIAN_C,
              cv.THRESH_BINARY,
              15,
              15
            );
            showIntermediate(thresh, "Adaptive Thresholding");
            console.log("✨ Step 7: Adaptive Thresholding applied");
          } else {
            cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
            showIntermediate(thresh, "Global Thresholding");
            console.log("✨ Step 7: Global Thresholding applied");
          }

          gray.delete();
          gray = thresh;
          await delay(300);
        }

        // Step 8: Invert if needed
        if (invert) {
          const inverted = new cv.Mat();
          cv.bitwise_not(gray, inverted);
          showIntermediate(inverted, "Inverted Colors");
          gray.delete();
          gray = inverted;
          await delay(300);
        }

        // Final cleanup and return the preprocessed image
        showIntermediate(gray, "Final Preprocessed Image");

        // Convert back to canvas for OCR
        const outCanvas = document.createElement("canvas");
        outCanvas.width = gray.cols;
        outCanvas.height = gray.rows;
        cv.imshow(outCanvas, gray);

        // Cleanup mats
        src.delete();
        gray.delete();

        resolve(outCanvas);
      } catch (err) {
        reject(err);
      }
    };

    img.onerror = () => {
      reject(new Error("Failed to load image."));
    };

    img.src = imageSrc;
  });
}



// --- Clean text by removing invisible chars and normalizing whitespace, preserve lines ---
export function cleanAndMergeText(rawText) {
  if (!rawText) return "";

  // Replace invisible chars, normalize spaces and trim lines
  return rawText
    .replace(/\u00A0/g, " ") // non-breaking space to normal space
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width chars removed
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
// Clusters text items by their Y position to reconstruct lines
export async function extractTextLinesFromPDFPage(page) {
  const textContent = await page.getTextContent();
  const items = textContent.items;

  // Map of y position to array of text items belonging to that line
  // Use a flexible grouping to handle small y variations
  const linesMap = new Map();

  // Vertical grouping threshold in PDF units (tweak if needed)
  const yThreshold = 2;

  // Helper function to find existing key within threshold or add new
  function findOrAddLineKey(y) {
    for (let key of linesMap.keys()) {
      if (Math.abs(key - y) <= yThreshold) {
        return key;
      }
    }
    // No existing close key found, add new
    linesMap.set(y, []);
    return y;
  }

  items.forEach((item) => {
    // y coordinate is normally transform[5]
    const y = item.transform[5];
    const key = findOrAddLineKey(y);
    linesMap.get(key).push(item);
  });

  // Sort line Ys from top (largest y) to bottom (smallest y)
  const sortedYs = Array.from(linesMap.keys()).sort((a, b) => b - a);

  const finalLines = [];

  for (const y of sortedYs) {
    const lineItems = linesMap.get(y);
    // Sort items left to right by x = transform[4]
    const sortedItems = lineItems.sort((a, b) => a.transform[4] - b.transform[4]);

    // Join text item strings with a space (adjust glue logic if needed)
    const lineText = sortedItems.map((item) => item.str).join(" ").trim();

    if (lineText) finalLines.push(lineText);
  }

  return finalLines.join("\n");
}

// --- Extract text from a PDF file, process pages via position-aware extraction ---

// Helper to update UI progress bar and status text
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

          // Extract lines with position-aware method
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

            const ocrResult = await Tesseract.recognize(preprocessed, "eng+slv", {
              logger: (m) => {
                if (m.status && typeof m.progress === "number") {
                  const statusMsg = `Page ${i}/${pdf.numPages} - ${m.status}`;
                  console.log(`OCR Status: ${statusMsg}, Progress: ${(m.progress * 100).toFixed(1)}%`);
                  updateOCRProgressUI(statusMsg, m.progress);
                } else {
                  console.log(m);
                }
                onProgress(m);
              },
              ...tesseractConfig,
            });

            const cleanedOCRText = cleanAndMergeText(ocrResult.data.text);
            fullText += `\n\n--- Page ${i} (OCR) ---\n${cleanedOCRText}`;
          }

          // Update page-level progress in UI
          updateOCRProgressUI(`Processing page ${i} of ${pdf.numPages}`, i / pdf.numPages);

          onProgress({ status: "page", page: i, totalPages: pdf.numPages, progress: i / pdf.numPages });
        }

        // Final UI update on complete
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

// --- OCR + preprocessing for direct image files ---
export async function processImage(imageSrc, onProgress = () => {}) {
  const preprocessedDataURL = await preprocessWithOpenCV(imageSrc);

  const result = await Tesseract.recognize(preprocessedDataURL, "eng+slv", {
    logger: (m) => {
      if (m.status && typeof m.progress === "number") {
        console.log(`OCR Status: ${m.status}, Progress: ${(m.progress * 100).toFixed(1)}%`);
        updateOCRProgressUI(m.status, m.progress);
      } else {
        console.log(m);
      }
      onProgress(m);
    },
    ...tesseractConfig,
  });

  const cleaned = cleanAndMergeText(result.data.text);
  
  // Reset UI after OCR done
  updateOCRProgressUI("OCR complete", 1);
  setTimeout(() => updateOCRProgressUI("", 0), 2000); // clear after 2s

  return cleaned;
}