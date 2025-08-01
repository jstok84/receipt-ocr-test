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

export function preprocessWithOpenCV(imageSrc) {
  return new Promise((resolve, reject) => {
    if (typeof cv === "undefined" || !cv.imread) {
      reject(new Error("OpenCV.js (cv) is not loaded or initialized."));
      return;
    }

    const img = new Image();
    img.crossOrigin = "Anonymous";

    img.onload = async () => {
      // Create container to show intermediate steps
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

      // Draw image on a canvas to create cv.Mat
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);

      let src, gray, blurred, sharpened, smoothed, thresh;

      try {
        src = cv.imread(canvas);

        // Step 1: Convert to Grayscale
        gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        showIntermediate(gray, "Grayscale");
        await delay(300);

        // Step 2: Threshold to binary (Otsu)
        const binary = new cv.Mat();
        cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

        // Step 3: Find contours
        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        // Visualize contours (optional)
        const contourPreview = cv.Mat.zeros(gray.rows, gray.cols, cv.CV_8UC3);
        for (let i = 0; i < contours.size(); ++i) {
          cv.drawContours(contourPreview, contours, i, new cv.Scalar(0, 255, 0), 1);
        }
        showIntermediate(contourPreview, "Contours Found");
        await delay(300);
        contourPreview.delete();

        // Step 4: Find largest contour by area
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

        // Step 5: Calculate rotation angle from largest contour
        let angle = 0;
        if (maxContour && maxContour.rows >= 5) {
          const rotatedRect = cv.minAreaRect(maxContour);
          angle = rotatedRect.angle;

          // IMPORTANT FIX:
          // minAreaRect.angle returns:
          //   angle in [-90, 0) degrees.
          //   The angle is the rotation to get the box upright:
          //   if width < height, angle is angle,
          //   else angle + 90.

          // Adjust angle for portrait or landscape:
          if (rotatedRect.size.width < rotatedRect.size.height) {
            // Portrait mode — angle as is
            // angle is negative or zero
          } else {
            // Landscape mode — add 90 to angle
            angle += 90;
          }

          console.log("Detected rotation angle for deskew:", angle);

          // Rotate only if angle is significant (> 1 degree)
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
              new cv.Scalar(255, 255, 255, 255) // white background
            );

            showIntermediate(rotated, `Deskewed (angle: ${angle.toFixed(2)}°)`);
            await delay(300);

            gray.delete();
            gray = rotated;
            M.delete();
          }
        }

        binary.delete();
        hierarchy.delete();
        contours.delete();

        // Step 6: Gaussian blur for unsharp masking
        blurred = new cv.Mat();
        cv.GaussianBlur(gray, blurred, new cv.Size(0, 0), 1.0);
        showIntermediate(blurred, "Gaussian Blur");
        await delay(300);

        // Step 7: Unsharp masking sharpening
        sharpened = new cv.Mat();
        cv.addWeighted(gray, 2.5, blurred, -1.5, 0, sharpened);
        showIntermediate(sharpened, "Unsharp Masking");
        await delay(300);

        gray.delete();
        blurred.delete();

        // Step 8: Optional smoothing blur
        smoothed = new cv.Mat();
        cv.GaussianBlur(sharpened, smoothed, new cv.Size(3, 3), 0);
        showIntermediate(smoothed, "Smoothing Blur");
        await delay(300);

        sharpened.delete();

        // Step 9: Thresholding (Otsu)
        thresh = new cv.Mat();
        cv.threshold(smoothed, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        showIntermediate(thresh, "Threshold Otsu");
        await delay(300);

        smoothed.delete();

        // Step 10: Invert if background is too bright
        const meanVal = cv.mean(thresh)[0];
        if (meanVal > 127) {
          const inverted = new cv.Mat();
          cv.bitwise_not(thresh, inverted);
          showIntermediate(inverted, "Inverted");
          await delay(300);
          thresh.delete();
          thresh = inverted;
        }

        // Step 11: Show final result on original canvas
        cv.imshow(canvas, thresh);
        const result = canvas.toDataURL("image/png");

        // Cleanup
        thresh.delete();
        src.delete();

        resolve(result);
      } catch (err) {
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