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

  const [capturedImage, setCapturedImage] = useState(null); // preview camera capture
  const [uploadedPreview, setUploadedPreview] = useState(null); // preview uploaded image
  const [pdfPreviews, setPdfPreviews] = useState([]); // preview PDF pages as images

  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // Check for camera availability on mount
  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((devices) => {
      const hasVideoInput = devices.some((d) => d.kind === "videoinput");
      setCameraAvailable(hasVideoInput);
    });
  }, []);

  // Handle camera stream
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

  // Capture image from camera and OCR
  const handleCapture = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL("image/jpeg");
    console.log("Captured image dataUrl:", dataUrl);
    setCapturedImage(dataUrl);

    setLoading(true);
    setText("Processing captured image...");
    setParsed(null);
    setUploadedPreview(null);
    setPdfPreviews([]);

    const result = await processImage(dataUrl);
    console.log("OCR result from captured image:", result);
    setText(result);
    setParsed(parseReceipt(result));
    setLoading(false);
  };

  // Handle file uploads (images and PDFs)
  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    console.log("File uploaded:", file.name, file.type);

    setLoading(true);
    setText("Processing file...");
    setParsed(null);
    setCapturedImage(null);
    setPdfPreviews([]);
    setUploadedPreview(null);

    if (file.type.startsWith("image/")) {
      // Show preview for images
      const imgUrl = URL.createObjectURL(file);
      setUploadedPreview(imgUrl);
      console.log("Image preview URL:", imgUrl);

      const result = await processImage(file);
      console.log("OCR result from uploaded image:", result);
      setText(result);
      setParsed(parseReceipt(result));
    } else if (file.type === "application/pdf") {
      // Process PDF pages & previews
      const { text: pdfText, previews } = await processPDF(file);
      console.log("OCR result from PDF:", pdfText);
      setText(pdfText);
      setParsed(parseReceipt(pdfText));
      setPdfPreviews(previews); // array of page image URLs to preview
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
      </div>

      {/* Camera preview and capture */}
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

      {/* Uploaded image preview */}
      {uploadedPreview && (
        <img
          src={uploadedPreview}
          alt="Uploaded file preview"
          style={{ width: "200px", marginTop: 10, border: "1px solid #ccc" }}
        />
      )}

      {/* PDF page previews */}
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
