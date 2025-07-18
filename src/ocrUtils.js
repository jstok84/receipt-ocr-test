import Tesseract from "tesseract.js";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.js";

GlobalWorkerOptions.workerSrc = pdfWorker;

const tesseractConfig = {
  tessedit_pageseg_mode: 6,
  tessedit_ocr_engine_mode: 1,
  tessedit_char_whitelist: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,-/:$€",
};

export async function processImage(imageSrc) {
  const result = await Tesseract.recognize(imageSrc, "eng+slv", {
    logger: (m) => console.log("Image OCR:", m),
    ...tesseractConfig,
  });
  return result.data.text;
}

export async function processPDF(file) {
  const reader = new FileReader();

  return new Promise((resolve) => {
    reader.onload = async () => {
      const pdf = await getDocument({ data: reader.result }).promise;
      let fullText = "";

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 3 });
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: context, viewport }).promise;

        const image = canvas.toDataURL("image/png");
        const result = await Tesseract.recognize(image, "eng+slv", {
          logger: (m) => console.log(`PDF Page ${i}:`, m),
          ...tesseractConfig,
        });

        fullText += `\n\n--- Page ${i} ---\n${result.data.text}`;
      }

      resolve(fullText);
    };

    reader.readAsArrayBuffer(file);
  });
}
