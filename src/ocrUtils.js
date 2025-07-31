import Tesseract from "tesseract.js";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.js";

GlobalWorkerOptions.workerSrc = pdfWorker;

const tesseractConfig = {
  tessedit_pageseg_mode: 6,    // Default PSM with OCR engine mode 1
  tessedit_ocr_engine_mode: 1,
  tessedit_char_whitelist:
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,-/:$€",
};

// OpenCV.js preprocessing — requires OpenCV.js to be loaded globally as cv
export function preprocessWithOpenCV(imageSrc) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);

      let src = cv.imread(canvas);
      let gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

      let blur = new cv.Mat();
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

      let thresh = new cv.Mat();
      cv.threshold(blur, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

      const mean = cv.mean(thresh)[0];
      if (mean > 127) cv.bitwise_not(thresh, thresh);

      cv.imshow(canvas, thresh);

      src.delete();
      gray.delete();
      blur.delete();
      thresh.delete();

      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = typeof imageSrc === "string" ? imageSrc : URL.createObjectURL(imageSrc);
  });
}

export function cleanAndMergeText(rawText) {
  if (!rawText) return "";

  let text = rawText
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ");

  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);

  const mergedLines = [];
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i];
    const next = lines[i + 1];

    if (next) {
      const isCurrentTextLine = /^[\w\s\-\/.,+]+$/i.test(current);
      const isNextStartsWithNumberOrCurrency = /^[€$]?[\d]/.test(next);

      if (isCurrentTextLine && isNextStartsWithNumberOrCurrency) {
        mergedLines.push(current + " " + next);
        i++;
        continue;
      }
      if (current.endsWith(":") && next.length > 0) {
        mergedLines.push(current + " " + next);
        i++;
        continue;
      }
    }
    mergedLines.push(current);
  }
  return mergedLines.join("\n");
}

export function mergeItemLines(rawText) {
  const lines = rawText.split("\n").map(l => l.trim()).filter(Boolean);
  const merged = [];
  let buffer = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextLine = lines[i + 1] || "";

    const currentAmounts = [...line.matchAll(/\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2})/g)];
    const nextAmounts = [...nextLine.matchAll(/\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{1,2})/g)];

    if (!buffer) {
      buffer = line;
      continue;
    }

    const hasNextAmounts = nextAmounts.length > 0;
    const smallQuantity = currentAmounts.length === 1 && parseFloat(currentAmounts[0][0].replace(',', '.')) < 10;

    if (hasNextAmounts && (smallQuantity || currentAmounts.length < nextAmounts.length)) {
      buffer += " " + nextLine;
      i++;
      while (i + 1 < lines.length && /^[\d.,% €]+$/.test(lines[i + 1].trim())) {
        buffer += " " + lines[i + 1].trim();
        i++;
      }
      continue;
    } else {
      merged.push(buffer);
      buffer = line;
    }
  }
  if (buffer) merged.push(buffer);
  return merged.join("\n");
}

async function extractTextFromPDFPage(page) {
  const textContent = await page.getTextContent();
  const strings = textContent.items.map(item => item.str).filter(Boolean);
  return strings.join("\n").trim();
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

          const extractedText = await extractTextFromPDFPage(page);

          if (extractedText && extractedText.length > 20) {
            const cleanedText = cleanAndMergeText(extractedText);
            const fullyMergedText = mergeItemLines(cleanedText);

            fullText += `\n\n--- Page ${i} (Extracted Text) ---\n${fullyMergedText}`;
          } else {
            // fallback OCR rendering if no text present or too short (optional)
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
              logger: onProgress,
              ...tesseractConfig,
            });

            const cleanedOCRText = cleanAndMergeText(ocrResult.data.text);
            const fullyMergedOCRText = mergeItemLines(cleanedOCRText);

            fullText += `\n\n--- Page ${i} (OCR) ---\n${fullyMergedOCRText}`;
          }
        }

        resolve({ text: fullText.trim(), previews });
      } catch (err) {
        reject(err);
      }
    };

    reader.readAsArrayBuffer(file);
  });
}

export async function processImage(imageSrc, onProgress = () => {}) {
  const preprocessedDataURL = await preprocessWithOpenCV(imageSrc);

  const result = await Tesseract.recognize(preprocessedDataURL, "eng+slv", {
    logger: onProgress,
    ...tesseractConfig,
  });

  const cleaned = cleanAndMergeText(result.data.text);
  const fullyMerged = mergeItemLines(cleaned);

  return fullyMerged;
}
