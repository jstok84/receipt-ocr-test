import React, { useState, useEffect, useRef } from "react";
import { processImage, processPDF } from "./ocrUtils";
import { parseReceipt } from "./parseReceipt";
import styles from "./styles";

export default function App() {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [useCamera, setUseCamera] = useState(false);
  const [cameraAvailable, setCameraAvailable] = useState(false);

  const [capturedImage, setCapturedImage] = useState(null);
  const [uploadedPreview, setUploadedPreview] = useState(null);
  const [pdfPreviews, setPdfPreviews] = useState([]);

  const [useFlatMode, setUseFlatMode] = useState(false); // 🆕 NEW toggle state

  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((devices) => {
      const hasVideoInput = devices.some((d) => d.kind === "videoinput");
      setCameraAvailable(hasVideoInput);
    });
  }, []);

  useEffect(() => {
    if (!useCamera) return;

    const constraints = {
      video: { facingMode: { ideal: "environment" }, focusMode: "continuous" },
    };

    navigator.mediaDevices
      .getUserMedia(constraints)
      .then((stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      })
      .catch((err) => {
        console.warn("Camera error:", err);
        setUseCamera(false);
      });

    return () => {
      videoRef.current?.srcObject?.getTracks().forEach((track) => track.stop());
    };
  }, [useCamera]);

  // 🔁 Shared function for applying parseReceipt with mode
  const runParsing = (rawText) => {
    const preparedText = useFlatMode ? rawText.replace(/\n/g, " ") : rawText;
    setParsed(parseReceipt(preparedText));
  };

  const handleCapture = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL("image/jpeg");
    setCapturedImage(dataUrl);

    setLoading(true);
    setProgress(0);
    setText("Processing captured image...");
    setParsed(null);
    setUploadedPreview(null);
    setPdfPreviews([]);

    const result = await processImage(dataUrl, (p) => setProgress(p));
    setText(result);
    runParsing(result); // 🔁 uses flat mode toggle
    setLoading(false);
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setLoading(true);
    setProgress(0);
    setText("Processing file...");
    setParsed(null);
    setCapturedImage(null);
    setPdfPreviews([]);
    setUploadedPreview(null);

    if (file.type.startsWith("image/")) {
      const imgUrl = URL.createObjectURL(file);
      setUploadedPreview(imgUrl);

      const result = await processImage(file, (p) => setProgress(p));
      setText(result);
      runParsing(result);
    } else if (file.type === "application/pdf") {
      const { text: pdfText, previews } = await processPDF(file, (p) => setProgress(p));
      setText(pdfText);
      runParsing(pdfText);
      setPdfPreviews(previews);
    } else {
      setText("Unsupported file type");
    }

    setLoading(false);
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.header}>🧾 Receipt OCR Scanner</h1>

      <div style={styles.controls}>
        <input
          type="file"
          accept="image/*,.pdf"
          onChange={handleFileUpload}
          style={styles.input}
        />
        {cameraAvailable && (
          <button onClick={() => setUseCamera(!useCamera)} style={styles.button}>
            {useCamera ? "Stop Camera" : "Use Camera"}
          </button>
        )}
        {/* 🆕 Toggle Mode Button */}
        <button onClick={() => setUseFlatMode(!useFlatMode)} style={styles.button}>
          {useFlatMode ? "Switch to Line Mode" : "Switch to Flat Mode"}
        </button>
      </div>

      <p style={{ marginTop: 5, fontStyle: "italic", color: "#444" }}>
        Mode: <strong>{useFlatMode ? "Flat (no line breaks)" : "Line-based OCR"}</strong>
      </p>

      {/* Camera preview, uploaded preview, PDF previews — unchanged */}
      {useCamera && (
        <>
          <video ref={videoRef} autoPlay playsInline style={styles.videoPreview} />
          <canvas ref={canvasRef} style={{ display: "none" }} />
          <button onClick={handleCapture} style={styles.button}>
            Capture & OCR
          </button>
          {capturedImage && (
            <img
              src={capturedImage}
              alt="Captured preview"
              style={{ width: "200px", marginTop: 10, border: "1px solid #ccc" }}
            />
          )}
        </>
      )}

      {uploadedPreview && (
        <img
          src={uploadedPreview}
          alt="Uploaded file preview"
          style={{ width: "200px", marginTop: 10, border: "1px solid #ccc" }}
        />
      )}

      {pdfPreviews.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <h3>PDF Page Previews</h3>
          <div style={{ display: "flex", gap: 10, overflowX: "auto" }}>
            {pdfPreviews.map((src, idx) => (
              <img
                key={idx}
                src={src}
                alt={`PDF page ${idx + 1}`}
                style={{ height: "150px", border: "1px solid #ccc" }}
              />
            ))}
          </div>
        </div>
      )}

      {loading && (
        <>
          <p>🔄 Processing OCR... {Math.round(progress * 100)}%</p>
          <progress value={progress} max={1} style={{ width: "100%" }} />
        </>
      )}

      <textarea
        value={text}
        readOnly
        placeholder="OCR result will appear here..."
        style={styles.textarea}
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
