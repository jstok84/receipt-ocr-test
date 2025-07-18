import React, { useState } from "react";
import Tesseract from "tesseract.js";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.js";

GlobalWorkerOptions.workerSrc = pdfWorker;

export default function App() {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null);
  const [loading, setLoading] = useState(false);

  const tesseractConfig = {
    tessedit_pageseg_mode: 6, // Single uniform block of text
    tessedit_ocr_engine_mode: 1, // LSTM OCR engine only
    tessedit_char_whitelist:
      "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,-/:$€",
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const isPDF = file.type === "application/pdf";
    setLoading(true);
    setText("Processing file...");
    setParsed(null);

    try {
      if (isPDF) {
        await processPDF(file);
      } else {
        await processImage(file);
      }
    } catch (error) {
      console.error("OCR error:", error);
      setText("Error during OCR!");
      setParsed(null);
    } finally {
      setLoading(false);
    }
  };

  const processImage = async (file) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const result = await Tesseract.recognize(reader.result, "eng+slv", {
        logger: (m) => console.log(m),
        ...tesseractConfig,
      });
      setText(result.data.text);
      const parsedData = parseReceipt(result.data.text);
      setParsed(parsedData);
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
        const result = await Tesseract.recognize(dataUrl, "eng+slv", {
          logger: (m) => console.log(`Page ${i}:`, m),
          ...tesseractConfig,
        });
        fullText += `\n\n--- Page ${i} ---\n${result.data.text}`;
      }

      setText(fullText);
      const parsedData = parseReceipt(fullText);
      setParsed(parsedData);
    };

    reader.readAsArrayBuffer(file);
  };

  // Basic receipt parsing with debug logs
  function parseReceipt(text) {
    console.log("Parsing OCR text:", text);

    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    console.log("Lines:", lines);

    // Find total line (English + Slovenian keywords)
    const totalLine = lines.find((l) =>
      /total|skupaj|znesek|skupna vrednost|skupaj z ddv/i.test(l)
    );
    console.log("Total line found:", totalLine);

    const totalMatch = totalLine?.match(/(\d+[.,]\d{2})/);
    const total = totalMatch ? totalMatch[1] : null;

    // Find date line (simple date regex dd.mm.yyyy or dd/mm/yyyy)
    const dateRegex = /(\d{1,2}[./]\d{1,2}[./]\d{2,4})/;
    const dateLine = lines.find((l) => dateRegex.test(l));
    console.log("Date line found:", dateLine);

    const dateMatch = dateLine?.match(dateRegex);
    const date = dateMatch ? dateMatch[1] : null;

    // Extract items - lines ending with a price
    const items = [];
    for (const line of lines) {
      const itemMatch = line.match(/(.+?)\s+(\d+[.,]\d{2})$/);
      if (itemMatch) {
        items.push({ name: itemMatch[1].trim(), price: itemMatch[2] });
      }
    }

    console.log("Parsed items:", items);

    return { date, total, items };
  }

  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>🧾 Receipt OCR (Image + PDF)</h1>
      <input type="file" accept="image/*,.pdf" onChange={handleFileUpload} />
      <p>{loading ? "Processing OCR..." : null}</p>

      <textarea
        style={{ width: "100%", height: "200px", marginTop: "1rem" }}
        value={text}
        readOnly
      />

      {parsed && (
        <div style={{ marginTop: "2rem" }}>
          <h2>Parsed Data</h2>
          <p>
            <strong>Date:</strong> {parsed.date || "Not found"}
          </p>
          <p>
            <strong>Total:</strong> {parsed.total || "Not found"}
          </p>
          <h3>Items:</h3>
          {parsed.items.length ? (
            <ul>
              {parsed.items.map((item, i) => (
                <li key={i}>
                  {item.name} — {item.price}
                </li>
              ))}
            </ul>
          ) : (
            <p>No items detected</p>
          )}
        </div>
      )}
    </div>
  );
}