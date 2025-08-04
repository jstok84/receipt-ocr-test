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
      adaptiveThresholding = true,  // New option to toggle adaptive thresholding
      denoise = true,               // New option to toggle denoising
      clahe = true,                 // New option to toggle CLAHE contrast enhancement
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
              // portrait - keep as is
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
              await delay(300);

              gray.delete();
              gray = warped;

              srcTri.delete();
              dstTri.delete();
              M.delete();
            } else {
              console.log("⚠️ Perspective correction skipped: polygon approx != 4 points");
            }
            approx.delete();
          } else {
            console.log("⚠️ Perspective correction skipped: no max contour found");
          }

          binaryForPerspective.delete();
          hierarchy.delete();
          contours.delete();
        }

        // New Step: CLAHE Contrast Enhancement
        if (clahe) {
          console.log("✨ Step 4: CLAHE contrast enhancement");
          const claheObj = new cv.CLAHE(2.0, new cv.Size(8, 8));
          const claheResult = new cv.Mat();
          claheObj.apply(gray, claheResult);
          showIntermediate(claheResult, "CLAHE Contrast");
          await delay(300);
          gray.delete();
          gray = claheResult;
          claheObj.delete();
        }

        // Step 5: Denoising
        if (denoise) {
          console.log("🧼 Step 5: Denoising with Bilateral Filter");
          const denoised = new cv.Mat();
          cv.bilateralFilter(gray, denoised, 9, 75, 75, cv.BORDER_DEFAULT); 
          showIntermediate(denoised, "Denoised (Bilateral Filter)");
          await delay(300);
          gray.delete();
          gray = denoised;
        }

        // Step 6: Unsharp Mask
        if (unsharpMask) {
          console.log("🔧 Step 6: Unsharp masking");
          blurred = new cv.Mat();
          cv.GaussianBlur(gray, blurred, new cv.Size(0, 0), 1.0);
          showIntermediate(blurred, "Gaussian Blur");
          await delay(300);

          sharpened = new cv.Mat();
          cv.addWeighted(gray, 2.5, blurred, -1.5, 0, sharpened);
          showIntermediate(sharpened, "Unsharp Masking");
          await delay(300);

          gray.delete();
          blurred.delete();
        } else {
          sharpened = gray.clone();
        }

        // Step 7: Optional smoothing
        if (smoothing) {
          console.log("🫧 Step 7: Smoothing blur");
          smoothed = new cv.Mat();
          cv.GaussianBlur(sharpened, smoothed, new cv.Size(3, 3), 0);
          showIntermediate(smoothed, "Smoothing Blur");
          await delay(300);
          sharpened.delete();
        } else {
          smoothed = sharpened.clone();
        }

        // Step 8: Thresholding
        if (adaptiveThresholding) {
          console.log("📊 Step 8: Adaptive Thresholding");
          thresh = new cv.Mat();
          cv.adaptiveThreshold(
            smoothed,
            thresh,
            255,
            cv.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv.THRESH_BINARY,
            15,  // blockSize — tune as needed, must be odd, >=3
            3   // C value — tune as needed
          );
          showIntermediate(thresh, "Adaptive Threshold");
          await delay(300);
          smoothed.delete();
        } else if (thresholding) {
          console.log("📊 Step 8: Thresholding (Otsu)");
          thresh = new cv.Mat();
          cv.threshold(smoothed, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
          showIntermediate(thresh, "Threshold Otsu");
          await delay(300);
          smoothed.delete();
        } else {
          thresh = smoothed.clone();
        }

        // Step 9: Invert if necessary
        if (invert) {
          const meanVal = cv.mean(thresh)[0];
          console.log("🌓 Step 9: Mean intensity =", meanVal.toFixed(2));
          if (meanVal > 127) {
            const inverted = new cv.Mat();
            cv.bitwise_not(thresh, inverted);
            showIntermediate(inverted, "Inverted");
            await delay(300);
            thresh.delete();
            thresh = inverted;
            console.log("↩️ Image inverted (white background)");
          } else {
            console.log("✅ Inversion skipped (background already dark)");
          }
        }

        // Final result
        cv.imshow(canvas, thresh);
        const result = canvas.toDataURL("image/png");

        // Cleanup
        thresh.delete();
        src.delete();

        resolve(result);
      } catch (err) {
        console.error("❌ Error during preprocessing:", err);
        if (src) src.delete();
        if (gray) gray.delete();
        if (blurred) blurred.delete();
        if (sharpened) sharpened.delete();
        if (smoothed) smoothed.delete();
        if (thresh) thresh.delete();
        reject(err);
      }
    };

    img.onerror = reject;
    img.src = typeof imageSrc === "string" ? imageSrc : URL.createObjectURL(imageSrc);
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