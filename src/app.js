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
    tessedit_pageseg_mode: 3, // Fully automatic page segmentation (better general OCR)
    tessedit_ocr_engine_mode: 1, // LSTM OCR engine only
    tessedit_char_whitelist:
      "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,-/:$€ ",
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
      const cleanedText = cleanOCRText(result.data.text);
      setText(cleanedText);
      setParsed(parseReceipt(cleanedText));
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

        fullText += `\n\n--- Page ${i} ---\n` + cleanOCRText(result.data.text);
      }

      setText(fullText);
      setParsed(parseReceipt(fullText));
    };

    reader.readAsArrayBuffer(file);
  };

  // Clean typical OCR errors in text - robust fix for comma/period mistakes and similar
  function cleanOCRText(text) {
    let cleaned = text;

    // Remove spaces inside numbers (e.g., "1 234,56" → "1234,56")
    cleaned = cleaned.replace(/(\d)\s+(\d)/g, "$1$2");

    // Fix common OCR misreads: letter 'O'/'o' mistaken for zero and vice versa
    cleaned = cleaned.replace(/(?<=\D)[oO](?=\d)/g, "0");
    cleaned = cleaned.replace(/(?<=\d)[oO](?=\D)/g, "0");

    // Unify decimal separators: if a number has both '.' and ',', assume last separator is decimal
    cleaned = cleaned.replace(
      /(\d{1,3})([.,])(\d{3})([.,])(\d{2})/g,
      (_, g1, sep1, g3, sep2, g5) => {
        // Remove thousand separator, unify decimal separator to '.'
        return `${g1}${g3}.${g5}`;
      }
    );

    // Fix lone commas used as decimal separator by replacing with dot
    cleaned = cleaned.replace(/(\d+),(\d{2})(\D|$)/g, "$1.$2$3");

    return cleaned;
  }

  function parseReceipt(text) {
    console.log("Parsing OCR text:", text);

    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    console.log("Lines:", lines);

    // Find total line with common keywords (English + Slovenian)
    const totalLine = lines.find((l) =>
      /total|skupaj|znesek|skupna vrednost|skupaj z ddv/i.test(l)
    );
    console.log("Total line found:", totalLine);

    // Match numbers with optional thousands separator (space, dot, comma) and decimal separator as dot
    const totalMatch = totalLine?.match(/(\d{1,3}(?:[ ,.]\d{3})*\.\d{2})/);
    const total = totalMatch ? totalMatch[1].replace(/[ ,]/g, "") : null;

    // Date regex supports dd.mm.yyyy, dd/mm/yyyy, yyyy-mm-dd, etc.
    const dateRegex =
      /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/;
    const dateLine = lines.find((l) => dateRegex.test(l));
    console.log("Date line found:", dateLine);

    const dateMatch = dateLine?.match(dateRegex);
    const date = dateMatch ? dateMatch[1] : null;

    const items = [];
    for (const line of lines) {
      const itemMatch = line.match(/(.+?)\s+(\d{1,3}(?:[ ,.]\d{3})*\.\d{2})$/);
      if (itemMatch) {
        items.push({
          name: itemMatch[1].trim(),
          price: itemMatch[2].replace(/[ ,]/g, ""),
        });
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
