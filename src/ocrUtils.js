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

// Create a single reusable Tesseract.js worker instance
const worker = Tesseract.createWorker({
  logger: (m) => {
    // Global logger (can be overridden in calls)
    console.log(m);
  },
});

let workerInitialized = false;

// Initialize worker once
async function initWorker() {
  if (!workerInitialized) {
    await worker.load();
    await worker.loadLanguage("eng+slv");
    await worker.initialize("eng+slv");
    await worker.setParameters(tesseractConfig);
    workerInitialized = true;
  }
}

// Terminate worker at end of batch processing
async function terminateWorker() {
  if (workerInitialized) {
    await worker.terminate();
    workerInitialized = false;
  }
}

// OCR helper using the reusable worker with progress callbacks
async function recognizeImage(imageDataURL, onProgress = () => {}) {
  await initWorker();

  const { data } = await worker.recognize(imageDataURL, {
    logger: (m) => {
      if (m.status && typeof m.progress === "number") {
        onProgress(m);
      }
    },
  });

  return data.text;
}


// --- OpenCV.js preprocessing with deskew, unsharp masking, adaptive thresholding, visualization ---
// Requires OpenCV.js globally loaded as 'cv'
export function preprocessWithOpenCV(imageSrc) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";

    img.onload = async () => {
      // Container div for step visualization
      const container = document.createElement("div");
      container.style.display = "flex";
      container.style.flexWrap = "wrap";
      container.style.gap = "10px";
      container.style.margin = "20px 0";
      container.style.border = "1px solid #ccc";
      container.style.padding = "10px";
      container.style.background = "#fafafa";
      document.body.appendChild(container);

      // Helper: show cv.Mat on labeled canvas inside container
      function showIntermediate(mat, label) {
        const wrapper = document.createElement("div");
        wrapper.style.textAlign = "center";
        wrapper.style.fontFamily = "sans-serif";
        wrapper.style.fontSize = "12px";
        wrapper.style.maxWidth = "240px";
        wrapper.style.marginBottom = "10px";

        const labelEl = document.createElement("div");
        labelEl.textContent = label;
        labelEl.style.fontWeight = "bold";
        labelEl.style.marginBottom = "6px";

        const canvasEl = document.createElement("canvas");
        canvasEl.style.width = "240px";
        canvasEl.style.height = "auto";
        canvasEl.style.border = "1px solid #eee";
        canvasEl.style.boxShadow = "0 0 6px rgba(0,0,0,0.12)";

        wrapper.appendChild(labelEl);
        wrapper.appendChild(canvasEl);
        container.appendChild(wrapper);

        cv.imshow(canvasEl, mat);
      }

      // Async delay to allow browser repaint for visualization
      function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      // Load image into cv.Mat via canvas
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      let src = cv.imread(canvas);

      try {
        // --- Deskew Helpers ---
        function getSkewAngle(mat) {
          let gray = new cv.Mat();
          if (mat.channels() === 4) {
            cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
          } else {
            mat.copyTo(gray);
          }

          // Optional: mild blur before threshold for stable binarization
          let blurred = new cv.Mat();
          cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0.5);

          let binary = new cv.Mat();
          cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

          blurred.delete();

          let nonZero = new cv.Mat();
          cv.findNonZero(binary, nonZero);

          gray.delete();
          binary.delete();

          if (nonZero.rows === 0) {
            nonZero.delete();
            return 0; // no text found
          }

          let points = new cv.Mat();
          nonZero.copyTo(points);
          nonZero.delete();

          let rect = cv.minAreaRect(points);
          points.delete();

          let angle = rect.angle;
          if (angle < -45) angle += 90;

          return angle;
        }

        function rotateImage(mat, angle) {
          let center = new cv.Point(mat.cols / 2, mat.rows / 2);
          let M = cv.getRotationMatrix2D(center, angle, 1);
          let rotated = new cv.Mat();
          cv.warpAffine(
            mat,
            rotated,
            M,
            new cv.Size(mat.cols, mat.rows),
            cv.INTER_LINEAR,
            cv.BORDER_REPLICATE
          );
          M.delete();
          return rotated;
        }

        // Step 0: Deskew image
        const angle = getSkewAngle(src);
        let deskewed = angle !== 0 ? rotateImage(src, -angle) : src;
        if (angle !== 0) src.delete();
        showIntermediate(deskewed, `Deskewed (Angle ${angle.toFixed(2)}°)`);
        await delay(300);

        // Step 1: Grayscale conversion
        let gray = new cv.Mat();
        cv.cvtColor(deskewed, gray, cv.COLOR_RGBA2GRAY);
        if (deskewed !== src) deskewed.delete();
        showIntermediate(gray, "Grayscale");
        await delay(300);

        // Step 2: Gaussian blur (mask for unsharp masking)
        let blurred = new cv.Mat();
        cv.GaussianBlur(gray, blurred, new cv.Size(0, 0), 1.0);
        showIntermediate(blurred, "Gaussian Blur");
        await delay(300);

        // Step 3: Unsharp masking sharpening
        const strength = 1.5;
        let sharpened = new cv.Mat();
        cv.addWeighted(gray, 1.0 + strength, blurred, -strength, 0, sharpened);
        showIntermediate(sharpened, "Unsharp Masking");
        await delay(300);

        gray.delete();
        blurred.delete();

        // Step 4: Mild Gaussian smoothing for noise reduction
        let smoothed = new cv.Mat();
        cv.GaussianBlur(sharpened, smoothed, new cv.Size(3, 3), 0.3);
        showIntermediate(smoothed, "Smoothing Blur");
        await delay(300);

        sharpened.delete();

        // Step 5: Adaptive thresholding for better binarization under uneven lighting
        let thresh = new cv.Mat();
        cv.adaptiveThreshold(
          smoothed,
          thresh,
          255,
          cv.ADAPTIVE_THRESH_GAUSSIAN_C,
          cv.THRESH_BINARY,
          11,  // blockSize, odd number
          2    // constant subtracted from mean
        );
        showIntermediate(thresh, "Adaptive Threshold");
        await delay(300);

        smoothed.delete();

        // Step 6: Invert image if background is bright
        const meanBrightness = cv.mean(thresh)[0];
        if (meanBrightness > 127) {
          let inverted = new cv.Mat();
          cv.bitwise_not(thresh, inverted);
          showIntermediate(inverted, "Inverted");
          await delay(300);
          thresh.delete();
          thresh = inverted;
        }

        // Final: Show processed image on canvas and resolve as PNG data URL
        cv.imshow(canvas, thresh);
        thresh.delete();

        resolve(canvas.toDataURL("image/png"));
      } catch (error) {
        src.delete();
        reject(error);
      }
    };

    img.onerror = reject;
    img.src = typeof imageSrc === "string" ? imageSrc : URL.createObjectURL(imageSrc);
  });
}

// --- Clean text by removing invisible chars and normalizing whitespace, preserve lines ---
export function cleanAndMergeText(rawText) {
  if (!rawText) return "";

  // Replace invisible characters, normalize spaces and trim lines
  return rawText
    .replace(/\u00A0/g, " ") // non-breaking space to space
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero width chars removed
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join("\n");
}

// --- Placeholder for merging lines if needed ---
export function mergeItemLines(rawText) {
  return rawText || "";
}

// --- Position-aware text extraction from a PDF page ---
// Cluster text items by Y position to reconstruct lines cleanly
export async function extractTextLinesFromPDFPage(page) {
  const textContent = await page.getTextContent();
  const items = textContent.items;

  const linesMap = new Map();
  const yThreshold = 2; // Vertical grouping threshold (PDF units)

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
    const y = item.transform[5]; // y coordinate
    const key = findOrAddLineKey(y);
    linesMap.get(key).push(item);
  });

  // Sort keys descending for top-to-bottom lines
  const sortedYs = Array.from(linesMap.keys()).sort((a, b) => b - a);

  const finalLines = [];

  for (const y of sortedYs) {
    const lineItems = linesMap.get(y);
    // Sort left to right by x coordinate
    const sortedItems = lineItems.sort((a, b) => a.transform[4] - b.transform[4]);

    const lineText = sortedItems.map(item => item.str).join(" ").trim();

    if (lineText) finalLines.push(lineText);
  }

  return finalLines.join("\n");
}

// --- Update UI progress bar and status text ---
function updateOCRProgressUI(status, progressFraction) {
  const progressBar = document.getElementById("ocr-progress-bar");
  const statusText = document.getElementById("ocr-status-text");
  if (progressBar && statusText) {
    progressBar.style.width = `${(progressFraction * 100).toFixed(1)}%`;
    statusText.textContent = status ? `OCR Status: ${status}` : "Waiting to start OCR...";
  }
}

// --- Process PDF file: extract text or OCR pages as fallback ---
export async function processPDF(file, onProgress = () => {}) {
  const reader = new FileReader();

  return new Promise((resolve, reject) => {
    reader.onload = async () => {
      try {
        const pdf = await getDocument({ data: reader.result }).promise;

        await initWorker(); // Init Tesseract worker once

        let fullText = "";
        const previews = [];

        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);

          // Attempt position-aware text extraction first
          const extractedText = await extractTextLinesFromPDFPage(page);

          if (extractedText && extractedText.length > 20) {
            fullText += `\n\n--- Page ${i} ---\n${extractedText}`;
          } else {
            // Render page as image and OCR
            const viewport = page.getViewport({ scale: 3 });
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d");

            canvas.width = viewport.width;
            canvas.height = viewport.height;

            await page.render({ canvasContext: context, viewport }).promise;

            const image = canvas.toDataURL("image/png");
            previews.push(image);

            const preprocessed = await preprocessWithOpenCV(image);

            const rawText = await recognizeImage(preprocessed, (m) => {
              if (m.status && typeof m.progress === "number") {
                const statusMsg = `Page ${i}/${pdf.numPages} - ${m.status}`;
                updateOCRProgressUI(statusMsg, m.progress);
                console.log(`OCR Status: ${statusMsg}, Progress: ${(m.progress * 100).toFixed(1)}%`);
              }
              onProgress(m);
            });

            const cleanedOCRText = cleanAndMergeText(rawText);
            fullText += `\n\n--- Page ${i} (OCR) ---\n${cleanedOCRText}`;
          }

          updateOCRProgressUI(`Processing page ${i} of ${pdf.numPages}`, i / pdf.numPages);
          onProgress({ status: "page", page: i, totalPages: pdf.numPages, progress: i / pdf.numPages });
        }

        await terminateWorker(); // Terminate after all pages done

        updateOCRProgressUI("OCR complete", 1);
        setTimeout(() => updateOCRProgressUI("", 0), 2000);

        resolve({ text: fullText.trim(), previews });
      } catch (err) {
        await terminateWorker();
        reject(err);
      }
    };

    reader.readAsArrayBuffer(file);
  });
}

// --- OCR processing for direct images ---
export async function processImage(imageSrc, onProgress = () => {}) {
  const preprocessedDataURL = await preprocessWithOpenCV(imageSrc);

  const rawText = await recognizeImage(preprocessedDataURL, (m) => {
    if (m.status && typeof m.progress === "number") {
      console.log(`OCR Status: ${m.status}, Progress: ${(m.progress * 100).toFixed(1)}%`);
      updateOCRProgressUI(m.status, m.progress);
    }
    onProgress(m);
  });

  const cleaned = cleanAndMergeText(rawText);

  updateOCRProgressUI("OCR complete", 1);
  setTimeout(() => updateOCRProgressUI("", 0), 2000);

  return cleaned;
}
