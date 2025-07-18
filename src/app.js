import React, { useState, useEffect, useRef } from "react";
import Tesseract from "tesseract.js";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.js";

GlobalWorkerOptions.workerSrc = pdfWorker;

export default function App() {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null);
  const [loading, setLoading] = useState(false);
  const [useCamera, setUseCamera] = useState(false);
  const [cameraAvailable, setCameraAvailable] = useState(false);
  const [capturedImage, setCapturedImage] = useState(null);
  const videoRef = useRef(null);

  const tesseractConfig = {
    tessedit_pageseg_mode: 6,
    tessedit_ocr_engine_mode: 1,
    tessedit_char_whitelist:
      "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,-/:$€",
  };

  useEffect(() => {
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        const hasCamera = devices.some((d) => d.kind === "videoinput");
        setCameraAvailable(hasCamera);
      });
  }, []);

  useEffect(() => {
    if (useCamera && cameraAvailable) {
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: { ideal: "environment" } } })
        .then((stream) => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
          }
        })
        .catch((err) => {
          console.warn("Fallback to default camera", err);
          return navigator.mediaDevices.getUserMedia({ video: true });
        })
        .then((fallbackStream) => {
          if (videoRef.current && fallbackStream) {
            videoRef.current.srcObject = fallbackStream;
          }
        });
    } else if (videoRef.current?.srcObject) {
      videoRef.current.srcObject.getTracks().forEach((track) => track.stop());
    }
  }, [useCamera, cameraAvailable]);

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    setLoading(true);
    setText("Processing file...");
    setParsed(null);

    try {
      if (file.type === "application/pdf") {
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
        const viewport = page.getViewport({ scale: 3 });
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

  const captureAndProcess = async () => {
    if (!videoRef.current) return;
    const canvas = document.createElement("canvas");
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(videoRef.current, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    setCapturedImage(dataUrl);

    setText("Processing captured image...");
    setLoading(true);
    setParsed(null);

    try {
      const result = await Tesseract.recognize(dataUrl, "eng+slv", {
        logger: (m) => console.log(m),
        ...tesseractConfig,
      });
      setText(result.data.text);
      const parsedData = parseReceipt(result.data.text);
      setParsed(parsedData);
    } catch (error) {
      console.error("OCR error:", error);
      setText("Error during OCR!");
    } finally {
      setLoading(false);
    }
  };

  const parseReceipt = (text) => {
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
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.header}>📷 OCR Receipt Scanner</h1>

      <div style={styles.controls}>
        <input
          type="file"
          accept="image/*,.pdf"
          onChange={handleFileUpload}
          style={styles.input}
        />

        {cameraAvailable && (
          <button
            onClick={() => setUseCamera(!useCamera)}
            style={styles.button}
          >
            {useCamera ? "Stop Camera" : "Use Camera"}
          </button>
        )}
      </div>

      {useCamera && (
        <>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            style={styles.videoPreview}
          />
          <button onClick={captureAndProcess} style={styles.captureButton}>
            📸 Capture & Process
          </button>
        </>
      )}

      {capturedImage && (
        <div style={{ marginTop: "1rem" }}>
          <h4>Captured Image</h4>
          <img
            src={capturedImage}
            alt="Captured preview"
            style={{ width: "100%", borderRadius: "8px" }}
          />
        </div>
      )}

      <p>{loading ? "Processing OCR..." : null}</p>

      <textarea
        style={styles.textarea}
        value={text}
        readOnly
        placeholder="OCR result will appear here..."
      />

      {parsed && (
        <div style={styles.parsedSection}>
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

const styles = {
  container: {
    padding: "1rem",
    fontFamily: "sans-serif",
    maxWidth: 600,
    margin: "auto",
  },
  header: {
    fontSize: "1.5rem",
    textAlign: "center",
    marginBottom: "1rem",
  },
  controls: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    marginBottom: "1rem",
  },
  input: {
    fontSize: "1rem",
  },
  button: {
    padding: "0.75rem",
    fontSize: "1rem",
    backgroundColor: "#007bff",
    color: "white",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
  },
  captureButton: {
    padding: "0.75rem",
    fontSize: "1rem",
    backgroundColor: "#28a745",
    color: "white",
    border: "none",
    borderRadius: "6px",
    marginTop: "0.5rem",
    cursor: "pointer",
  },
  videoPreview: {
    width: "100%",
    maxHeight: "300px",
    borderRadius: "8px",
    objectFit: "cover",
    marginTop: "1rem",
  },
  textarea: {
    width: "100%",
    height: "180px",
    marginTop: "1rem",
    fontSize: "1rem",
  },
  parsedSection: {
    marginTop: "2rem",
  },
};
