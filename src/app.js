import React, { useState, useEffect, useRef } from "react";
import { processImage, processPDF } from "./ocrUtils";
import { parseReceipt } from "./parseReceipt";
import styles from "./styles";

export default function App() {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null);
  const [loading, setLoading] = useState(false);
  const [useCamera, setUseCamera] = useState(false);
  const [cameraAvailable, setCameraAvailable] = useState(false);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    // Check if camera is available
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

  const handleCapture = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    setLoading(true);
    setText("Processing captured image...");
    setParsed(null);

    const dataUrl = canvas.toDataURL("image/jpeg");
    const result = await processImage(dataUrl);
    setText(result);
    setParsed(parseReceipt(result));
    setLoading(false);
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setLoading(true);
    setText("Processing file...");
    setParsed(null);

    const ext = file.type;
    const result = ext === "application/pdf"
      ? await processPDF(file)
      : await processImage(file);

    setText(result);
    setParsed(parseReceipt(result));
    setLoading(false);
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.header}>🧾 Receipt OCR Scanner</h1>

      <div style={styles.controls}>
        <input type="file" accept="image/*,.pdf" onChange={handleFileUpload} style={styles.input} />
        {cameraAvailable && (
          <button onClick={() => setUseCamera(!useCamera)} style={styles.button}>
            {useCamera ? "Stop Camera" : "Use Camera"}
          </button>
        )}
      </div>

      {useCamera && (
        <>
          <video ref={videoRef} autoPlay playsInline style={styles.videoPreview} />
          <canvas ref={canvasRef} style={{ display: "none" }} />
          <button onClick={handleCapture} style={styles.button}>
            Capture & OCR
          </button>
        </>
      )}

      {loading && <p>🔄 Processing OCR...</p>}

      <textarea
        value={text}
        readOnly
        placeholder="OCR result will appear here..."
        style={styles.textarea}
      />

      {parsed && (
        <div style={styles.parsedSection}>
          <h2>Parsed Data</h2>
          <p><strong>Date:</strong> {parsed.date || "Not found"}</p>
          <p><strong>Total:</strong> {parsed.total || "Not found"}</p>
          <h3>Items:</h3>
          {parsed.items.length ? (
            <ul>{parsed.items.map((item, i) => (
              <li key={i}>{item.name} — {item.price}</li>
            ))}</ul>
          ) : (
            <p>No items detected</p>
          )}
        </div>
      )}
    </div>
  );
}
