import React, { useState } from "react";
import Tesseract from "tesseract.js";
import pdfWorker from "./pdf-worker.js"; // local worker wrapper
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = pdfWorker;

export default function App() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const isPDF = file.type === "application/pdf";
    setLoading(true);
    setText("Processing file...");

    try {
      if (isPDF) {
        await processPDF(file);
      } else {
        await processImage(file);
      }
    } catch (error) {
      console.error("OCR error:", error);
      setText("Error during OCR!");
    } finally {
      setLoading(false);
    }
  };

  const processImage = async (file) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const result = await Tesseract.recognize(reader.result, "eng", {
        logger: (m) => console.log(m),
      });
      setText(result.data.text);
    };
    reader.readAsDataURL(file);
  };

  const processPDF = async (file) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const pdf = await getDocument({ data: reader.result }).promise;
      let fullText = "";

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        await page.render({ canvasContext: context, viewport }).promise;

        const dataUrl = canvas.toDataURL("image/png");
        const result = await Tesseract.recognize(dataUrl, "eng", {
          logger: (m) => console.log(`Page ${i}:`, m),
        });
        fullText += `\n\n--- Page ${i} ---\n${result.data.text}`;
      }

      setText(fullText);
    };

    reader.readAsArrayBuffer(file);
  };

  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>🧾 Receipt OCR (Image + PDF)</h1>
      <input type="file" accept="image/*,.pdf" onChange={handleFileUpload} />
      <p>{loading ? "Processing OCR..." : text}</p>
    </div>
  );
}
