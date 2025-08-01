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

    img.onload = () => {
      // ✅ Create UI
      const controlPanel = document.createElement("div");
      controlPanel.style.position = "fixed";
      controlPanel.style.top = "10px";
      controlPanel.style.right = "10px";
      controlPanel.style.background = "#fff";
      controlPanel.style.border = "1px solid #ccc";
      controlPanel.style.padding = "10px";
      controlPanel.style.boxShadow = "0 0 10px rgba(0,0,0,0.1)";
      controlPanel.style.zIndex = "9999";
      controlPanel.style.fontFamily = "sans-serif";
      controlPanel.style.fontSize = "14px";

      controlPanel.innerHTML = `
        <label><input type="checkbox" id="deskew" checked> Deskew</label><br>
        <label><input type="checkbox" id="unsharp" checked> Unsharp Mask</label><br>
        <label><input type="checkbox" id="smooth" checked> Smoothing</label><br>
        <label><input type="checkbox" id="threshold" checked> Threshold</label><br>
        <label><input type="checkbox" id="invert" checked> Invert if Bright</label><br>
        <button id="processBtn" style="margin-top: 10px;">Process Image</button>
      `;

      document.body.appendChild(controlPanel);

      const deskewCheckbox = document.getElementById("deskew");
      const unsharpCheckbox = document.getElementById("unsharp");
      const smoothCheckbox = document.getElementById("smooth");
      const thresholdCheckbox = document.getElementById("threshold");
      const invertCheckbox = document.getElementById("invert");
      const processBtn = document.getElementById("processBtn");

      // ✅ Show preview container
      const container = document.createElement("div");
      container.style.display = "flex";
      container.style.flexWrap = "wrap";
      container.style.gap = "10px";
      container.style.margin = "80px 0 20px";
      container.style.border = "1px solid #ccc";
      container.style.padding = "10px";
      container.style.background = "#fafafa";
      document.body.appendChild(container);

      function showIntermediate(mat, label) {
        const wrapper = document.createElement("div");
        wrapper.style.textAlign = "center";
        wrapper.style.fontSize = "12px";
        wrapper.style.maxWidth = "480px";

        const labelEl = document.createElement("div");
        labelEl.textContent = label;
        labelEl.style.fontWeight = "bold";
        labelEl.style.marginBottom = "6px";

        const canvasEl = document.createElement("canvas");
        canvasEl.width = mat.cols;
        canvasEl.height = mat.rows;
        canvasEl.style.width = "480px";
        canvasEl.style.border = "1px solid #eee";
        canvasEl.style.boxShadow = "0 0 6px rgba(0,0,0,0.12)";

        wrapper.appendChild(labelEl);
        wrapper.appendChild(canvasEl);
        container.appendChild(wrapper);

        cv.imshow(canvasEl, mat);
      }

      function delay(ms) {
        return new Promise(res => setTimeout(res, ms));
      }

      processBtn.onclick = async () => {
        container.innerHTML = ""; // Clear previous results

        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);

        let src, gray, blurred, sharpened, smoothed, thresh;

        try {
          console.log("📥 Reading image to cv.Mat");
          src = cv.imread(canvas);

          console.log("🎨 Converting to grayscale");
          gray = new cv.Mat();
          cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
          showIntermediate(gray, "Grayscale");
          await delay(300);

          if (deskewCheckbox.checked) {
            console.log("📐 Deskewing...");
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
                // angle stays
              } else {
                angle += 90;
              }
              if (angle < -45) angle += 180;
              if (Math.abs(angle) > 1) {
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
                showIntermediate(rotated, `Deskewed (${angle.toFixed(2)}°)`);
                await delay(300);
                gray.delete();
                gray = rotated;
                M.delete();
              }
            }

            binary.delete();
            hierarchy.delete();
            contours.delete();
          }

          if (unsharpCheckbox.checked) {
            console.log("🔪 Unsharp mask...");
            blurred = new cv.Mat();
            cv.GaussianBlur(gray, blurred, new cv.Size(0, 0), 1.0);
            sharpened = new cv.Mat();
            cv.addWeighted(gray, 2.5, blurred, -1.5, 0, sharpened);
            showIntermediate(sharpened, "Unsharp Masking");
            await delay(300);
            gray.delete();
            blurred.delete();
            gray = sharpened;
          }

          if (smoothCheckbox.checked) {
            console.log("💧 Smoothing...");
            smoothed = new cv.Mat();
            cv.GaussianBlur(gray, smoothed, new cv.Size(3, 3), 0);
            showIntermediate(smoothed, "Smoothing Blur");
            await delay(300);
            gray.delete();
            gray = smoothed;
          }

          if (thresholdCheckbox.checked) {
            console.log("⚡ Thresholding...");
            thresh = new cv.Mat();
            cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
            showIntermediate(thresh, "Threshold Otsu");
            await delay(300);
            gray.delete();
            gray = thresh;
          }

          if (invertCheckbox.checked) {
            const meanVal = cv.mean(gray)[0];
            if (meanVal > 127) {
              console.log("🔄 Inverting image...");
              const inverted = new cv.Mat();
              cv.bitwise_not(gray, inverted);
              showIntermediate(inverted, "Inverted");
              await delay(300);
              gray.delete();
              gray = inverted;
            }
          }

          console.log("✅ Final result ready.");
          cv.imshow(canvas, gray);
          const result = canvas.toDataURL("image/png");

          gray.delete();
          src.delete();

          resolve(result);
        } catch (err) {
          console.error("❌ Preprocessing error:", err);
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
    };

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