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

  // Preprocess canvas: grayscale + simple threshold
  const preprocessCanvas = (canvas) => {
    const ctx = canvas.getContext("2d");
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      // grayscale
      const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
      // threshold
      const threshold = 128;
      const val = avg > threshold ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = val;
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
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
      // Create canvas from image to preprocess it
      const img = new Image();
      img.onload = async () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);

        preprocessCanvas(canvas);

        const dataUrl = canvas.toDataURL("image/png");

        const result = await Tesseract.recognize(dataUrl, "eng+slv", {
          logger: (m) => console.log(m),
          ...tesseractConfig,
        });

        setText(result.data.text);
        const parsedData = parseReceipt(result.data.text);
        setParsed(parsedData);
      };
      img.src = reader.result;
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

        preprocessCanvas(canvas);

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

  // Basic receipt parsing with expanded keywords and improved regex
  function parseReceipt(text) {
    console.log("Parsing OCR text:", text);

    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    console.log("Lines:", lines);

    // Expanded total keywords in English and Slovenian
    const totalKeywords = [
      "total",
      "skupaj",
      "znesek",
      "skupna vrednost",
      "skupaj z ddv",
      "znesek za plačilo",
      "končni znesek",
      "skupaj znesek",
      "amount",
      "total amount",
      "sum",
      "grand total",
      "end sum",
      "total price",
      "za plačilo",
    ];

    // Find total line by keywords (case insensitive)
    const totalLine = lines.find((l) =>
      totalKeywords.some((kw) => l.toLowerCase().includes(kw))
    );

    console.log("Total line found:", totalLine);

    // Match number with optional thousands separators, optional decimals, optional currency (EUR, USD, $, €)
    const totalMatch = totalLine?.match(
      /(\d{1,3}(?:[ ,.]?\d{3})*(?:[.,]\d{2})?)\s*(EUR|USD|\$|€)?/i
    );

    let total = totalMatch ? totalMatch[1].replace(/\s/g, "") : null;
    if (totalMatch && totalMatch[2]) total += " " + totalMatch[2].toUpperCase();

    // Date regex supporting dd.mm.yyyy, dd/mm/yyyy, yyyy-mm-dd, dd-mm-yyyy
    const dateRegex =
      /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/;
    const dateLine = lines.find((l) => dateRegex.test(l));
    console.log("Date line found:", dateLine);

    const dateMatch = dateLine?.match(dateRegex);
    const date = dateMatch ? dateMatch[1] : null;

    // Extract items - lines ending with a price with optional currency
    const items = [];
    for (const line of lines) {
      const itemMatch = line.match(
        /(.+?)\s+(\d{1,3}(?:[ ,.]?\d{3})*(?:[.,]\d{2})?)\s*(EUR|USD|\$|€)?$/i
      );
      if (itemMatch) {
        let price = itemMatch[2].replace(/\s/g, "");
        if (itemMatch[3]) price += " " + itemMatch[3].toUpperCase();

        items.push({ name: itemMatch[1].trim(), price });
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
