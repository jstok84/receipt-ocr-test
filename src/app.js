import React, { useState, useRef, useEffect } from "react";
import Tesseract from "tesseract.js";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.js";

GlobalWorkerOptions.workerSrc = pdfWorker;

export default function App() {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null);
  const [loading, setLoading] = useState(false);
  const [useCamera, setUseCamera] = useState(false);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const tesseractConfig = {
    tessedit_pageseg_mode: 6,
    tessedit_ocr_engine_mode: 1,
    tessedit_char_whitelist:
      "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,-/:$€",
  };

  useEffect(() => {
    if (useCamera) {
      navigator.mediaDevices
        .getUserMedia({ video: true })
        .then((stream) => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
          }
        })
        .catch((err) => {
          console.error("Camera access denied:", err);
        });
    } else {
      if (videoRef.current?.srcObject) {
        videoRef.current.srcObject.getTracks().forEach((track) => track.stop());
      }
    }
  }, [useCamera]);

  const captureFromCamera = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const context = canvas.getContext("2d");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataURL = canvas.toDataURL("image/png");
    processImageDataURL(dataURL);
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

  const processImageDataURL = async (dataURL) => {
    setLoading(true);
    setText("Processing image...");
    setParsed(null);

    const result = await Tesseract.recognize(dataURL, "eng+slv", {
      logger: (m) => console.log(m),
      ...tesseractConfig,
    });

    const rawText = result.data.text;
    setText(rawText);
    const parsedData = parseReceipt(rawText);
    setParsed(parsedData);
    setLoading(false);
  };

  const processImage = async (file) => {
    const reader = new FileReader();
    reader.onload = () => processImageDataURL(reader.result);
    reader.readAsDataURL(file);
  };

  const processPDF = async (file) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const pdf = await getDocument({ data: reader.result }).promise;
      let fullText = "";

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 3 }); // better OCR resolution
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
      setLoading(false);
    };

    reader.readAsArrayBuffer(file);
  };

  function parseReceipt(text) {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

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

    const totalLine = lines.find((l) =>
      totalKeywords.some((kw) => l.toLowerCase().includes(kw))
    );

    const totalMatch = totalLine?.match(
      /(\d{1,3}(?:[ ,.]?\d{3})*(?:[.,]\d{2})?)\s*(EUR|USD|\$|€)?/i
    );
    let total = totalMatch ? totalMatch[1].replace(/\s/g, "") : null;
    if (totalMatch && totalMatch[2]) total += " " + totalMatch[2].toUpperCase();

    const dateRegex =
      /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/;
    const dateLine = lines.find((l) => dateRegex.test(l));
    const dateMatch = dateLine?.match(dateRegex);
    const date = dateMatch ? dateMatch[1] : null;

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

    return { date, total, items };
  }

  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>🧾 Receipt OCR (Image, PDF & Camera)</h1>

      <div style={{ marginBottom: "1rem" }}>
        <label>
          <input
            type="checkbox"
            checked={useCamera}
            onChange={() => setUseCamera(!useCamera)}
          />{" "}
          Use Camera
        </label>
      </div>

      {useCamera ? (
        <>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            style={{ width: "100%", maxHeight: "300px", border: "1px solid #ccc" }}
          />
          <button onClick={captureFromCamera} disabled={loading} style={{ marginTop: "1rem" }}>
            {loading ? "Processing..." : "Capture & Process"}
          </button>
          <canvas ref={canvasRef} style={{ display: "none" }} />
        </>
      ) : (
        <input type="file" accept="image/*,.pdf" onChange={handleFileUpload} />
      )}

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
