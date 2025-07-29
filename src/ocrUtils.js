import Tesseract from "tesseract.js";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.js";

GlobalWorkerOptions.workerSrc = pdfWorker;

const tesseractConfig = {
  tessedit_pageseg_mode: 6,
  tessedit_ocr_engine_mode: 1,
  tessedit_char_whitelist: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,-/:$€",
};

// ⬇️ Modified: now accepts debug flag to optionally display canvas
function preprocessWithOpenCV(imageSrc, debug = false) {
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

      // Optional: invert if background is light
      const mean = cv.mean(thresh)[0];
      if (mean > 127) cv.bitwise_not(thresh, thresh);

      cv.imshow(canvas, thresh);

      if (debug) {
        // Style and append the canvas for visual debugging
        canvas.style.border = "3px solid #4CAF50";
        canvas.style.marginTop = "10px";
        canvas.style.maxWidth = "100%";
        // Append the canvas to a dedicated debug container or body
        let debugContainer = document.getElementById("debug-preprocess-container");
        if (!debugContainer) {
          debugContainer = document.createElement("div");
          debugContainer.id = "debug-preprocess-container";
          debugContainer.style.marginTop = "20px";
          debugContainer.style.padding = "10px";
          debugContainer.style.border = "2px dashed #4CAF50";
          debugContainer.style.backgroundColor = "#f9fff9";
          document.body.appendChild(debugContainer);
        }
        debugContainer.appendChild(canvas.cloneNode(true));
      }

      // Cleanup mats
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

export async function processImage(imageSrc, debug = false) {
  const preprocessedDataURL = await preprocessWithOpenCV(imageSrc, debug);

  const result = await Tesseract.recognize(preprocessedDataURL, "eng+slv", {
    logger: (m) => console.log("Image OCR:", m),
    ...tesseractConfig,
  });

  return result.data.text;
}

export async function processPDF(file, debug = false) {
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

        const preprocessed = await preprocessWithOpenCV(image, debug);

        const result = await Tesseract.recognize(preprocessed, "eng+slv", {
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
