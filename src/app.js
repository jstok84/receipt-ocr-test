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
    tessedit_pageseg_mode: 6, // Single uniform block of text (better for receipts)
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

  // Mild grayscale conversion, no thresholding or upscaling
  const preprocessCanvas = (canvas) => {
    const ctx = canvas.getContext("2d");
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const avg = (imgData.data[i] + imgData.data[i + 1] + imgData.data[i + 2]) / 3;
      imgData.data[i] = avg;
      imgData.data[i + 1] = avg;
      imgData.data[i + 2] = avg;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas;
  };

  const processImage = async (file) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const img = new Image();
      img.src = reader.result;
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
        const fixedText = fixOCRText(result.data.text);
        setText(fixedText);
        const parsedData = parseReceipt(fixedText);
        setParsed(parsedData);
      };
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

        fullText += `\n\n--- Page ${i} ---\n` + fixOCRText(result.data.text);
      }

      setText(fullText);
      const parsedData = parseReceipt(fullText);
      setParsed(parsedData);
    };

    reader.readAsArrayBuffer(file);
  };

  // Fix typical comma/period confusion for decimals but keep it light
  function fixOCRText(text) {
    let fixed = text;

    // Remove spaces inside numbers, e.g. "12 345,67" → "12345,67"
    fixed = fixed.replace(/(\d)\s+(\d)/g, "$1$2");

    // Fix commas used as thousand separators to dots or remove if needed
    // Example: "1,234.56" => "1234.56", "1.234,56" => "1234.56"
    fixed = fixed.replace(/(\d)[.,](\d{3})[.,](\d{2})/g, (m, p1, p2, p3) => {
      return `${p1}${p2}.${p3}`; // unify decimal point as dot
    });

    return fixed;
  }

  function parseReceipt(text) {
    console.log("Parsing OCR text:", text);

    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    console.log("Lines:", lines);

    const totalLine = lines.find((l) =>
      /total|skupaj|znesek|skupna vrednost|skupaj z ddv/i.test(l)
    );
    console.log("Total line found:", totalLine);

    const totalMatch = totalLine?.match(/(\d{1,3}(?:[ ,.]?\d{3})*[.,]\d{2})/);
    const total = totalMatch ? totalMatch[1].replace(/\s/g, "") : null;

    const dateRegex =
      /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/;
    const dateLine = lines.find((l) => dateRegex.test(l));
    console.log("Date line found:", dateLine);

    const dateMatch = dateLine?.match(dateRegex);
    const date = dateMatch ? dateMatch[1] : null;

    const items = [];
    for (const line of lines) {
      const itemMatch = line.match(/(.+?)\s+(\d{1,3}(?:[ ,.]?\d{3})*[.,]\d{2})$/);
      if (itemMatch) {
        items.push({
          name: itemMatch[1].trim(),
          price: itemMatch[2].replace(/\s/g, ""),
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
