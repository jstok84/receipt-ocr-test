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

// --- OpenCV.js preprocessing (requires OpenCV.js loaded globally as cv) ---
// This version visualizes intermediate steps by creating labeled canvases appended to the page.

export function preprocessWithOpenCV(imageSrc) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {

      // Create a container element to hold all intermediate canvases
      const container = document.createElement("div");
      container.style.display = "flex";
      container.style.flexWrap = "wrap";
      container.style.gap = "10px";
      container.style.margin = "20px 0";
      // Optional styling to visually separate container
      container.style.border = "1px solid #ccc";
      container.style.padding = "10px";
      container.style.background = "#fafafa";

      // Append container to body or to any preferred element
      document.body.appendChild(container);

      // Helper function to create labeled canvas and show mat image
      function showIntermediate(mat, label) {
        const wrapper = document.createElement("div");
        wrapper.style.textAlign = "center";
        wrapper.style.fontFamily = "sans-serif";
        wrapper.style.fontSize = "12px";
        wrapper.style.maxWidth = "240px"; // limit max width per canvas container

        // Label above canvas
        const labelEl = document.createElement("div");
        labelEl.textContent = label;
        labelEl.style.marginBottom = "6px";
        labelEl.style.fontWeight = "bold";

        // Canvas element that will hold the image
        const canvasEl = document.createElement("canvas");
        canvasEl.style.width = "240px";           // scale canvases visually for display
        canvasEl.style.height = "auto";
        canvasEl.style.border = "1px solid #eee";
        canvasEl.style.boxShadow = "0 0 6px rgba(0,0,0,0.12)";

        wrapper.appendChild(labelEl);
        wrapper.appendChild(canvasEl);
        container.appendChild(wrapper);

        cv.imshow(canvasEl, mat);    // Draw mat on this canvas
      }

      // Original canvas to read input image into cv.Mat
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);

      let src = cv.imread(canvas);
      try {
        // Convert to grayscale
        let gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        showIntermediate(gray, "Grayscale");

        // Gaussian blur the grayscale image - sigma 1.0, kernel size auto
        let blurred = new cv.Mat();
        cv.GaussianBlur(gray, blurred, new cv.Size(0, 0), 1.0);
        showIntermediate(blurred, "Gaussian Blur");

        // Unsharp masking sharpening:
        // sharpened = original * (1 + strength) - blurred * strength
        const strength = 1.5;  // adjust sharpening strength here
        let sharpened = new cv.Mat();
        cv.addWeighted(gray, 1.0 + strength, blurred, -strength, 0, sharpened);
        showIntermediate(sharpened, "Unsharp Masking");

        // Clean up mats no longer needed
        gray.delete();
        blurred.delete();

        // Optional: mild Gaussian blur to reduce noise after sharpening
        let smoothed = new cv.Mat();
        cv.GaussianBlur(sharpened, smoothed, new cv.Size(3, 3), 0);
        showIntermediate(smoothed, "Smoothing Blur");
        sharpened.delete();

        // Threshold using Otsu's method to binarize the image
        let thresh = new cv.Mat();
        cv.threshold(smoothed, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        showIntermediate(thresh, "Threshold Otsu");
        smoothed.delete();

        // Calculate mean brightness; invert if background too bright (mean>127)
        const mean = cv.mean(thresh)[0];
        if (mean > 127) {
          let inverted = new cv.Mat();
          cv.bitwise_not(thresh, inverted);
          showIntermediate(inverted, "Inverted");
          thresh.delete();
          thresh = inverted;
        }

        // Show final processed image on our original canvas
        cv.imshow(canvas, thresh);

        // Cleanup mats
        thresh.delete();
        src.delete();

        // Resolve the final preprocessed image as a PNG data URL (for OCR input)
        resolve(canvas.toDataURL("image/png"));
      } catch (err) {
        src.delete();
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