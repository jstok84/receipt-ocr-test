import React, { useState, useEffect, useRef } from "react";
import { processImage, processPDF, cleanAndMergeText } from "./ocrUtils";
import { parseReceipt } from "./parseReceipt";

export default function App() {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null);
  const [loading, setLoading] = useState(false);
  const [useCamera, setUseCamera] = useState(false);
  const [cameraAvailable, setCameraAvailable] = useState(false);

  const [capturedImage, setCapturedImage] = useState(null);
  const [uploadedPreview, setUploadedPreview] = useState(null);
  const [pdfPreviews, setPdfPreviews] = useState([]);
  const [useFlatMode, setUseFlatMode] = useState(false);
  const [stripRescue, setStripRescue] = useState(null);
  const [copied, setCopied] = useState(false);
  const [dragHover, setDragHover] = useState(false);

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

  // alreadyCleaned: processImage returns text that already went through the
  // single clean pass (idempotent); the PDF path still cleans pdf-embedded text.
  const runParsing = (rawText, extraItems = [], rescue = null, corrections = [], alreadyCleaned = false) => {
    let prepared = rawText;
    if (!useFlatMode) {
      if (!alreadyCleaned) prepared = cleanAndMergeText(rawText);
    } else {
      prepared = rawText.replace(/\n/g, " ");
    }
    setParsed(parseReceipt(prepared, extraItems, corrections));
    // evidence for the strip-recovered item (null clears it)
    setStripRescue(rescue);
  };

  const handleCapture = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const stream = video.srcObject;

    setLoading(true);
    setText("Processing captured image...");
    setParsed(null);
    setUploadedPreview(null);
    setPdfPreviews([]);

    try {
      const [track] = stream.getVideoTracks();
      let blob;

      // Try using ImageCapture API
      if ("ImageCapture" in window) {
        try {
          const imageCapture = new ImageCapture(track);
          blob = await imageCapture.takePhoto(); // high-quality still image
          console.log("Captured photo using ImageCapture API");
        } catch (err) {
          console.warn("ImageCapture failed, falling back to canvas:", err);
        }
      }

      // Fallback to canvas capture if ImageCapture failed or not supported
      if (!blob) {
        // Let camera autofocus for a moment (simple UX improvement)
        await new Promise(res => setTimeout(res, 2000));

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const dataUrl = canvas.toDataURL("image/jpeg");
        setCapturedImage(dataUrl);

        const result = await processImage(dataUrl);
        setText(result.text);
        runParsing(result.text, result.extraItems, result.rescue, result.corrections, true);
        setLoading(false);
        return;
      }

      // Convert blob (from ImageCapture) to DataURL for processing
      const reader = new FileReader();
      reader.onloadend = async () => {
        const dataUrl = reader.result;
        setCapturedImage(dataUrl);

        const result = await processImage(dataUrl);
        setText(result.text);
        runParsing(result.text, result.extraItems, result.rescue, result.corrections, true);
        setLoading(false);
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      console.error("Error during capture:", err);
      setText("Capture failed");
      setLoading(false);
    }
  };

  const handleFiles = async file => {
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    const isPDF = file.type === "application/pdf";
    const preview = isImage ? URL.createObjectURL(file) : null;
    setCapturedImage(null);
    setText(isImage ? "Processing image file..." : isPDF ? "Processing PDF..." : "");
    setUploadedPreview(isImage ? preview : null);
    setPdfPreviews([]);
    setParsed(null);
    setLoading(true);

    try {
      if (isImage) {
        const result = await processImage(file);
        setText(result.text);
        runParsing(result.text, result.extraItems, result.rescue, result.corrections, true);
      } else if (isPDF) {
        const { text: pdfText, previews } = await processPDF(file);
        setText(pdfText);
        runParsing(pdfText);
        setPdfPreviews(previews);
      } else {
        setText("Unsupported file type");
      }
    } catch (err) {
      console.error(err);
      setText("Error processing image");
    }
    setLoading(false);
  };

  const handleFileUpload = async e => {
    await handleFiles(e.target.files?.[0]);
    e.target.value = ""; // allow re-selecting the same file
  };

  const handleDrop = e => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFiles(f);
  };

  const handleDragOver = e => e.preventDefault();

  const copyText = () => {
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const preview = uploadedPreview || capturedImage;

  return (
    <div className="container">
      <header className="app-header">
        <h1>Receipt OCR</h1>
        <button
          className="btn ghost mini"
          onClick={() => setUseFlatMode(!useFlatMode)}
        >
          {useFlatMode ? "Switch to line mode" : "Switch to flat mode"}
        </button>
      </header>
      <p className="app-status">
        Mode: {useFlatMode ? "flat (no line breaks)" : "line-based"} · everything is
        processed locally in your browser
      </p>

      <section
        className={`upload${dragHover ? " drag" : ""}`}
        onDragOver={e => { e.preventDefault(); setDragHover(true); }}
        onDragLeave={() => setDragHover(false)}
        onDrop={handleDrop}
      >
        <h2>Drop a receipt photo or PDF here</h2>
        <p>Photograph or saved PDF — processing stays on this device</p>
        <label className="btn primary file-label">
          Choose file
          <input type="file" accept="image/*,.pdf" onChange={handleFileUpload} />
        </label>
      </section>

      {useCamera && <section className="camera panel">
        <video ref={videoRef} autoPlay playsInline />
        <canvas ref={canvasRef} hidden />
        <div className="actions" style={{ padding: "10px 16px" }}>
          <button className="btn primary" onClick={handleCapture}>Capture &amp; OCR</button>
          <button className="btn ghost" onClick={() => setUseCamera(false)}>Stop camera</button>
        </div>
      </section>}

      {loading && <div className="loading-row" role="status">
        <span className="dot" />
        Processing…
      </div>}

      {text && <section className="panel">
        <div className="panel-head">
          <h2>OCR text</h2>
          <button className="btn ghost mini" onClick={copyText}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <textarea className="ocr-text" readOnly value={text}
          placeholder="OCR result will appear here..." />
      </section>}

      {parsed && <section className="panel">
        <div className="panel-head">
          <h2>Parsed data</h2>
          {preview && <img className="preview-thumb" src={preview} alt="" />}
        </div>
        <div className="parsed">
          <dl className="meta">
            <div>
              <dt>Date</dt>
              <dd>{parsed.date || "—"}</dd>
            </div>
            <div className="dd-total">
              <dt>Total</dt>
              <dd>{parsed.total || "—"}</dd>
            </div>
          </dl>

          <ul className="items">
            {parsed.items.length ? parsed.items.map((item, i) => <li key={i}>
              <span>{item.name}</span>
              <span className="leader" />
              <span className={`price${item.via ? " corrected" : ""}`}
                title="price re-measured by strip re-OCR — verify against the photo">
                {item.price}
                {item.via && <span className="re-mark" aria-label="re-measured by strip re-OCR">✳</span>}
              </span>
            </li>) : <p className="no-items">No items detected</p>}
          </ul>

          {parsed.items.some(i => i.via) && <p className="items-note">
            ✳ re-measured by strip re-OCR — verify against the photo
          </p>}

          {parsed.checks?.length > 0 && <div className="checks">
            {parsed.checks.map((c, i) => <div key={i} className={`check ${c.ok ? "ok" : "warn"}`}>
              <span className="mark">{c.ok ? "✓" : "[?]"}</span>
              <span>{c.text}</span>
            </div>)}
          </div>}
        </div>
      </section>}

      {pdfPreviews.length > 0 && <section className="panel">
        <div className="panel-head"><h2>PDF pages (scanned, OCR fallback)</h2></div>
        <div className="pdf-previews">
          {pdfPreviews.map((src, i) => <img key={i} src={src} alt={`Page ${i + 1}`} />)}
        </div>
      </section>}

      {stripRescue && <details className="panel evidence">
        <summary>
          Strip re-OCR evidence — {stripRescue.missing != null
            ? `missing ≈ ${stripRescue.missing.toFixed(2)} €, recovered "${stripRescue.winner.line}"`
            : `OCR measured "${stripRescue.winner.line}"`}
        </summary>
        <div className="evidence-body">
          <p>
            The recovered price was <strong>measured by OCR</strong> from the strip
            below, not derived from the total.
          </p>
          {stripRescue.attempts.map((a, i) => <div className="attempt" key={i}>
            <div className="attempt-label">
              attempt {i + 1}: strip={a.stripKind}
              {" "}band={Math.round(a.band[0] * 100)}–{Math.round(a.band[1] * 100)}%
              {" "}{a.factor}× {a.kernel === "lanczos3" ? "lanczos3" : "catrom"}
              {" "}PSM={a.psm}
            </div>
            {a.image && <img src={a.image} alt={`strip attempt ${i + 1}`} />}
            <pre>{a.lines.join("\n")}</pre>
          </div>)}
        </div>
      </details>}
    </div>
  );
}
