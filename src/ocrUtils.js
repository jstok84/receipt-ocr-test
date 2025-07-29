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

// Preprocess image with OpenCV.js
function preprocessWithOpenCV(imageSrc) {
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

      // Invert if background is light
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

// OCR for images
export async function processImage(imageSrc) {
  console.log("Starting image preprocessing");
  const preprocessedDataURL = await preprocessWithOpenCV(imageSrc);
  console.log("Image preprocessed, starting OCR");

  const result = await Tesseract.recognize(preprocessedDataURL, "eng+slv", {
    logger: (m) => console.log("Tesseract OCR:", m),
    ...tesseractConfig,
  });

  console.log("OCR complete");
  return result.data.text;
}

// OCR for PDFs + page image previews
export async function processPDF(file) {
  const reader = new FileReader();

  return new Promise((resolve) => {
    reader.onload = async () => {
      console.log("PDF loaded, parsing...");
      const pdf = await getDocument({ data: reader.result }).promise;
      let fullText = "";
      let previews = [];

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
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
          logger: (m) => console.log(`Tesseract PDF Page ${i}:`, m),
          ...tesseractConfig,
        });

        fullText += `\n\n--- Page ${i} ---\n${result.data.text}`;
        console.log(`OCR complete for page ${i}`);
      }

      resolve({ text: fullText, previews });
    };

    reader.readAsArrayBuffer(file);
  });
}
