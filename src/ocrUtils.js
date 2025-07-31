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

// --- OpenCV.js preprocessing ---
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

// --- Text cleanup and line merging for PDF/OCR text ---

function cleanAndMergeText(rawText) {
  if (!rawText) return "";

  let text = rawText
    .replace(/\u00A0/g, " ") // non-breaking spaces → space
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width spaces removed
    .replace(/\t/g, " ") // tabs → space
    .replace(/[ ]{2,}/g, " "); // collapse multiple spaces

  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);

  const mergedLines = [];
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i];
    const next = lines[i + 1];

    if (next) {
      const isCurrentLettersOnly = /^[a-zA-ZšžčćđŠŽČĆĐ\s\-]+$/.test(current);
      const isNextStartsWithNumberOrCurrency = /^[€$]?[\d]/.test(next);

      if (isCurrentLettersOnly && isNextStartsWithNumberOrCurrency) {
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

// --- Extract text (raw) from a PDF page ---
async function extractTextFromPDFPage(page) {
  const textContent = await page.getTextContent();
  const strings = textContent.items.map((item) => item.str).filter(Boolean);
  return strings.join("\n").trim();
}

// --- Main processPDF function: extract and OCR fallback with text cleaning ---
export async function processPDF(file, onProgress = () => {}) {
  const reader = new FileReader();

  return new Promise((resolve) => {
    reader.onload = async () => {
      console.log("PDF loaded, parsing...");
      const pdf = await getDocument({ data: reader.result }).promise;

      let fullText = "";
      let previews = [];

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        console.log(`Processing page ${i}...`);

        const extractedText = await extractTextFromPDFPage(page);

        if (extractedText && extractedText.length > 20) {
          console.log(`Page ${i}: Text extracted without OCR`);
          const cleanedText = cleanAndMergeText(extractedText);
          fullText += `\n\n--- Page ${i} (Extracted Text) ---\n${cleanedText}`;
        } else {
          const viewport = page.getViewport({ scale: 3 });
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d");

          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvasContext: context, viewport }).promise;

          const image = canvas.toDataURL("image/png");
          previews.push(image);
          console.log(`Rendered page ${i} to image`);

          const preprocessed = await preprocessWithOpenCV(image);
          console.log(`Page ${i} preprocessed`);

          const result = await Tesseract.recognize(preprocessed, "eng+slv", {
            logger: (m) => {
              console.log(`Tesseract PDF Page ${i}:`, m);
              onProgress(m);
            },
            ...tesseractConfig,
          });

          const cleanedOCRText = cleanAndMergeText(result.data.text);
          fullText += `\n\n--- Page ${i} (OCR) ---\n${cleanedOCRText}`;
          console.log(`OCR complete for page ${i}`);
        }
      }

      resolve({ text: fullText, previews });
    };

    reader.readAsArrayBuffer(file);
  });
}

// --- OCR for images directly ---
export async function processImage(imageSrc, onProgress = () => {}) {
  console.log("Starting image preprocessing");
  const preprocessedDataURL = await preprocessWithOpenCV(imageSrc);
  console.log("Image preprocessed, starting OCR");

  const result = await Tesseract.recognize(preprocessedDataURL, "eng+slv", {
    logger: (m) => {
      console.log("Tesseract OCR:", m);
      onProgress(m);
    },
    ...tesseractConfig,
  });

  console.log("OCR complete");
  return cleanAndMergeText(result.data.text);
}
