import React, { useState, useEffect, useRef } from "react";
import { processImage, processPDF, cleanAndMergeText, mergeItemLines } from "./ocrUtils";
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
  const [useFlatMode, setUseFlatMode] = useState(false);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then(devices => {
      setCameraAvailable(devices.some(d => d.kind === "videoinput"));
    });
  }, []);

  useEffect(() => {
    if (!useCamera) return;
    const constraints = { video: { facingMode: "environment", focusMode: "continuous" } };
    navigator.mediaDevices.getUserMedia(constraints)
      .then(stream => videoRef.current && (videoRef.current.srcObject = stream))
      .catch(err => {
        console.warn("Camera error:", err);
        setUseCamera(false);
      });
    return () => {
      videoRef.current?.srcObject?.getTracks()?.forEach(t => t.stop());
    };
  }, [useCamera]);

  const runParsing = rawText => {
    let prepared = rawText;
    if (!useFlatMode) {
      const cleaned = cleanAndMergeText(rawText);
      prepared = mergeItemLines(cleaned);
    } else {
      prepared = rawText.replace(/\n/g, " ");
    }
    setParsed(parseReceipt(prepared));
  };

  function dataURLtoFile(dataurl, filename) {
    const [header, base64] = dataurl.split(",");
    const mime = header.match(/:(.*?);/)[1];
    const bstr = atob(base64);
    let n = bstr.length;
    const u8 = new Uint8Array(n);
    while (n--) u8[n] = bstr.charCodeAt(n);
    return new File([u8], filename, { type: mime });
  }

  const handleCapture = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const stream = video.srcObject;

    setLoading(true);
    setProgress(0);
    setText("Processing captured image...");
    setParsed(null);
    setUploadedPreview(null);
    setPdfPreviews([]);

    try {
      const [track] = stream.getVideoTracks();
      let blob;

      // ✅ Try using ImageCapture API
      if ("ImageCapture" in window) {
        try {
          const imageCapture = new ImageCapture(track);
          blob = await imageCapture.takePhoto(); // high-quality still image
          console.log("📸 Captured photo using ImageCapture API");
        } catch (err) {
          console.warn("⚠️ ImageCapture failed, falling back to canvas:", err);
        }
      }

      // 🔁 Fallback to canvas capture if ImageCapture failed or not supported
      if (!blob) {
        // Let camera autofocus for a moment (simple UX improvement)
        await new Promise(res => setTimeout(res, 2000));

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const dataUrl = canvas.toDataURL("image/jpeg");
        setCapturedImage(dataUrl);

        const result = await processImage(dataUrl, (p) => setProgress(p));
        setText(result);
        runParsing(result);
        setLoading(false);
        return;
      }

      // 📷 Convert blob (from ImageCapture) to DataURL for processing
      const reader = new FileReader();
      reader.onloadend = async () => {
        const dataUrl = reader.result;
        setCapturedImage(dataUrl);

        const result = await processImage(dataUrl, (p) => setProgress(p));
        setText(result);
        runParsing(result);
        setLoading(false);
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      console.error("❌ Error during capture:", err);
      setText("Capture failed");
      setLoading(false);
    }
  };


  const handleFileUpload = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    const isPDF = file.type === "application/pdf";
    let preview = null;
    if (isImage) preview = URL.createObjectURL(file);
    setCapturedImage(null);
    setText(isImage ? "Processing image file..." : isPDF ? "Processing PDF..." : "");
    setUploadedPreview(isImage ? preview : null);
    setPdfPreviews([]);
    setParsed(null);
    setLoading(true);
    setProgress(0);

    if (isImage) {
      await processGenericFile(file, preview);
    } else if (isPDF) {
      const { text: pdfText, previews } = await processPDF(file, p => setProgress(p));
      setText(pdfText);
      runParsing(pdfText);
      setPdfPreviews(previews);
      setLoading(false);
    } else {
      setText("Unsupported file type");
      setLoading(false);
    }
  };

  const processGenericFile = async (file, previewDataUrl = null) => {
    setParsed(null);
    setText("Processing OCR...");
    setLoading(true);
    setProgress(0);
    if (previewDataUrl) setUploadedPreview(previewDataUrl);
    try {
      const result = await processImage(file, p => setProgress(p));
      setText(result);
      runParsing(result);
    } catch (err) {
      console.error(err);
      setText("Error processing image");
    }
    setLoading(false);
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.header}>🧾 Receipt OCR Scanner</h1>
      <div style={styles.controls}>
        <input type="file" accept="image/*,.pdf" onChange={handleFileUpload} style={styles.input} />
        {cameraAvailable && <button onClick={() => setUseCamera(!useCamera)} style={styles.button}>
          {useCamera ? "Stop Camera" : "Use Camera"}
        </button>}
        <button onClick={() => setUseFlatMode(!useFlatMode)} style={styles.button}>
          {useFlatMode ? "Switch to Line Mode" : "Switch to Flat Mode"}
        </button>
      </div>
      <p style={{ marginTop: 5, fontStyle: "italic", color: "#444" }}>
        Mode: <strong>{useFlatMode ? "Flat (no line breaks)" : "Line-based OCR"}</strong>
      </p>

      {useCamera && <>
        <video ref={videoRef} autoPlay playsInline style={styles.videoPreview} />
        <canvas ref={canvasRef} style={{ display: "none" }} />
        <button onClick={handleCapture} style={styles.button}>Capture & OCR</button>
        {capturedImage && <img src={capturedImage} alt="Captured preview" style={{ width: 200, marginTop: 10, border: "1px solid #ccc" }} />}
      </>}

      {uploadedPreview && <img src={uploadedPreview} alt="Uploaded or captured preview" style={{ width: 200, marginTop: 10, border: "1px solid #ccc" }} />}

      {pdfPreviews.length > 0 && <div style={{ marginTop: 20 }}>
        <h3>PDF Page Previews</h3>
        <div style={{ display: "flex", gap: 10, overflowX: "auto" }}>
          {pdfPreviews.map((src, i) => <img key={i} src={src} alt={`Page ${i+1}`} style={{ height: 150, border: "1px solid #ccc" }} />)}
        </div>
      </div>}

      {loading && <>
        <p>🔄 Processing OCR... {Math.round(progress * 100)}%</p>
        <progress value={progress} max={1} style={{ width: "100%" }} />
      </>}

      <textarea readOnly value={text} placeholder="OCR result will appear here..." style={styles.textarea} />

      {parsed && <div style={styles.parsedSection}>
        <h2>Parsed Data</h2>
        <p><strong>Date:</strong> {parsed.date || "Not found"}</p>
        <p><strong>Total:</strong> {parsed.total || "Not found"}</p>
        <h3>Items:</h3>
        {parsed.items.length ? <ul>
          {parsed.items.map((item, i) => <li key={i}>{item.name} — {item.price}</li>)}
        </ul> : <p>No items detected</p>}
      </div>}
    </div>
  );
}
