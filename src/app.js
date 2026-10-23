import React, { useState, useEffect, useRef } from "react";
import { processImage, processPDF, cleanAndMergeText } from "./ocrUtils";
import { parseReceipt } from "./parseReceipt";
import { loadSyncCfg, saveSyncCfg, clearSyncCfg, uploadScan, presignS3 } from "./sync";

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

  // debug/evidence layer + test sync channel state
  const [showEvidence, setShowEvidence] = useState(false);
  const [pipelineMs, setPipelineMs] = useState(null);
  const [syncCfg, setSyncCfg] = useState(() => loadSyncCfg());
  const [syncStatus, setSyncStatus] = useState(null); // null | uploading | {ok, photoKey} | error string
  const [syncSetup, setSyncSetup] = useState(() => location.hash === "#sync");

  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then(devices => {
      setCameraAvailable(devices.some(d => d.kind === "videoinput"));
    });
  }, []);

  useEffect(() => {
    const onHash = () => setSyncSetup(location.hash === "#sync");
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
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
    const result = parseReceipt(prepared, extraItems, corrections);
    setParsed(result);
    // evidence for the strip-recovered item (null clears it)
    setStripRescue(rescue);
    return result;
  };

  // Test sync: photo + manifest straight from the device to the user's
  // B2 bucket (bucket-scoped key, keyed in localStorage) — dormant until
  // configured via the #sync setup panel.
  const maybeSync = async (blob, name, ocr, parsedNow, ms) => {
    const cfg = syncCfg || loadSyncCfg();
    if (!cfg || !blob) return;
    setSyncStatus("uploading");
    try {
      const info = await uploadScan(cfg, {
        blob,
        ts: Date.now(),
        device: cfg.device || "",
        name,
        text: ocr.text,
        parsed: parsedNow,
        rescue: ocr.rescue,
        corrections: ocr.corrections,
        ms,
        ua: navigator.userAgent,
      });
      setSyncStatus({ ok: true, jsonKey: info.jsonKey });
    } catch (err) {
      console.warn("Sync failed:", err);
      setSyncStatus("sync failed: " + (err?.message || err));
    }
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

        const t0 = performance.now();
        const result = await processImage(dataUrl);
        setText(result.text);
        const parsedNow = runParsing(result.text, result.extraItems, result.rescue, result.corrections, true);
        setPipelineMs(Math.round(performance.now() - t0));
        setLoading(false);
        // canvas-frame blob for the sync channel
        maybeSync(await fetch(dataUrl).then(r => r.blob()), "camera-capture.jpg", result, parsedNow, Math.round(performance.now() - t0));
        return;
      }

      // Convert blob (from ImageCapture) to DataURL for processing
      const reader = new FileReader();
      reader.onloadend = async () => {
        const dataUrl = reader.result;
        setCapturedImage(dataUrl);

        const t0 = performance.now();
        const result = await processImage(dataUrl);
        setText(result.text);
        const parsedNow = runParsing(result.text, result.extraItems, result.rescue, result.corrections, true);
        const ms = Math.round(performance.now() - t0);
        setPipelineMs(ms);
        setLoading(false);
        maybeSync(blob, "camera-capture.jpg", result, parsedNow, ms);
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
        const t0 = performance.now();
        const result = await processImage(file);
        setText(result.text);
        const parsedNow = runParsing(result.text, result.extraItems, result.rescue, result.corrections, true);
        const ms = Math.round(performance.now() - t0);
        setPipelineMs(ms);
        maybeSync(file, file.name, result, parsedNow, ms);
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
        <div className="header-actions">
          <button
            className="btn ghost mini"
            onClick={() => setShowEvidence(!showEvidence)}
            title="raw OCR text, cascade attempts, pipeline timing"
          >
            evidence
          </button>
          <button
            className="btn ghost mini"
            onClick={() => setSyncSetup(!syncSetup)}
            title="test sync channel setup (device-to-bucket)"
          >
            sync
          </button>
          <button
            className="btn ghost mini"
            onClick={() => setUseFlatMode(!useFlatMode)}
          >
            {useFlatMode ? "Switch to line mode" : "Switch to flat mode"}
          </button>
        </div>
      </header>
      <p className="app-status">
        Mode: {useFlatMode ? "flat (no line breaks)" : "line-based"} · everything is
        processed locally in your browser{syncCfg ? " · sync on" : ""}
        {syncStatus ? ` · ${typeof syncStatus === "string" ? syncStatus : syncStatus.ok ? "synced ✓" : ""}` : ""}
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
                title="re-measured by strip re-OCR — details in the verification note below">
                {item.price}
              </span>
            </li>) : <p className="no-items">No items detected</p>}
          </ul>

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

      {showEvidence && <section className="panel evidence">
        <div className="panel-head">
          <h2>Debug evidence</h2>
          <span className="evidence-meta">
            {pipelineMs != null
              ? `pipeline ${pipelineMs} ms`
              : "no pipeline timing yet"}
            {" "}· {stripRescue?.attempts?.length || 0} cascade attempt(s)
          </span>
        </div>
        <div className="evidence-body">
          <p className="evidence-note">
            Raw OCR text (post-cleanup, pre-parse). Cascade attempt lines appear
            below whenever a strip-repair cascade ran.
          </p>
          <pre className="evidence-raw">{text || "(nothing scanned yet)"}</pre>
          {stripRescue?.attempts.map((a, i) => <div className="attempt" key={i}>
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
      </section>}

      {syncSetup && <SyncSetupPanel
        syncCfg={syncCfg}
        onSave={cfg => { saveSyncCfg(cfg); setSyncCfg(loadSyncCfg()); }}
        onClear={() => { clearSyncCfg(); setSyncCfg(null); }}
      />}
    </div>
  );
}

function SyncSetupPanel({ syncCfg, onSave, onClear }) {
  const Empty = {
    region: "eu-central-003",
    bucket: "receipt-test",
    keyID: "",
    secretKey: "",
    prefix: "receipts/S25/",
    device: "S25",
  };
  const [form, setForm] = useState(() => ({
    ...Empty,
    ...(syncCfg ? { ...syncCfg, secretKey: "" } : {}),
  }));
  const [diagRunning, setDiagRunning] = useState(false);
  const [diagLines, setDiagLines] = useState([]);

  // Diagnostics run from THE PAGE, i.e. the same browser/network as the
  // failing scan — external probes cannot see this network hop. Each line's
  // shape identifies a different layer:
  //   "…HTTP 403"  → connection + CORS layer both fine (B2 answered)
  //   "…THREW…"    → browser never got a response: DNS/network/preTLS
  const runDiagnostics = async () => {
    setDiagRunning(true);
    const lines = [];
    const region = (form.region || "").trim();
    const bucket = (form.bucket || "").trim();
    const host = region ? `s3.${region}.backblazeb2.com` : "(no region)";
    lines.push(`endpoint: https://${host}/${bucket}/`);
    // 1: unsigned simple GET to the bucket root (no preflight) — ambiguous in
    // throw terms too: unreachable host AND refused-without-ACAO look identical.
    try {
      const r = await fetch(`https://${host}/${bucket}/`);
      lines.push(`1 GET bucket root: HTTP ${r.status} (403 expected — connection + CORS layer OK)`);
    } catch (e) {
      lines.push(`1 GET bucket root: THREW (${e?.message}) — ambiguous: unreachable OR un-CORSed error response`);
    }
    // 2: junk-signature PUT — exercises the preflight path only. Its THREW is
    // ambiguous: B2 may refuse unsigned/errors without CORS headers, which the
    // browser surfaces as the same "Failed to fetch" as a dead network.
    try {
      const r = await fetch(`https://${host}/${bucket}/diagProbe.jpg`, {
        method: "PUT",
        body: new Blob(["diag"], { type: "image/jpeg" }),
        headers: { "Content-Type": "image/jpeg" },
      });
      lines.push(`2 PUT (fake signature): HTTP ${r.status} (401/403 expected)`);
    } catch (e) {
      lines.push(`2 PUT (fake signature): THREW (${e?.message}) — ambiguous: network OR un-CORSed error response`);
    }
    // 3: REAL presigned PUT — the unambiguous one, identical to the scan path.
    try {
      const saved = loadSyncCfg();
      const probeCfg = {
        region,
        bucket,
        keyID: (form.keyID || "").trim() || (saved?.keyID || ""),
        secretKey: (form.secretKey || "").trim() || (saved?.secretKey || ""),
        prefix: (form.prefix || "").trim() || (saved?.prefix || "receipts/"),
      };
      if (!probeCfg.keyID || !probeCfg.secretKey) {
        lines.push("(paste device keyID+secret, or Save a config first — the real-path probe needs a key)");
      } else {
        const key = `${probeCfg.prefix}diag-probe-${Date.now()}.jpg`;
        const url = await presignS3(probeCfg, { method: "PUT", key, contentType: "image/jpeg", expires: 600 });
        const r = await fetch(url, {
          method: "PUT",
          body: new Blob(["diag-upload-probe"], { type: "image/jpeg" }),
          headers: { "Content-Type": "image/jpeg" },
        });
        lines.push(r.ok
          ? `3 REAL presigned PUT: HTTP 200 — SYNC PATH WORKS (diag file stored as ${key})`
          : `3 REAL presigned PUT: HTTP ${r.status} — ${(await r.text()).slice(0, 140)}`);
      }
    } catch (e) {
      lines.push(`3 REAL presigned PUT: THREW (${e?.message}) — if 1+2 also threw: carrier/network blocks the endpoint; if only 3 throws: post-status CORS or key problem`);
    }
    setDiagLines(lines);
    setDiagRunning(false);
  };

  const field = (k, label, type = "text") => <label className="row">
    <span className="field-label">{label}</span>
    <input type={type} value={form[k]} onChange={e => setForm({ ...form, [k]: e.target.value })} />
  </label>;
  return <section className="panel setup">
    <div className="panel-head"><h2>Test sync setup (device → your B2 bucket)</h2></div>
    <div className="evidence-body">
      <p className="evidence-note">
        Paste the device application key (writeFiles, prefix-scoped). It is
        stored only in this browser's localStorage — never in any bundle.
        Secret shown as zero characters to others; keep it out of screenshots.
      </p>
      {field("region", "B2 region (e.g. eu-central-003 — fixed at signup)")}
      {field("bucket", "Bucket name")}
      {field("keyID", "Application key ID")}
      {field("secretKey", "Application key secret", "password")}
      {field("prefix", "File prefix")}
      {field("device", "Device label (single short token)")}
      <div className="actions">
        <button className="btn primary" onClick={() => {
          if (!form.region || !form.bucket || !form.keyID || !form.secretKey) return;
          onSave({
            ...form,
            region: form.region.trim(),
            bucket: form.bucket.trim(),
            keyID: form.keyID.trim(),
            secretKey: form.secretKey.trim(),
            prefix: form.prefix.trim().replace(/\/?$/, "/"),
            device: form.device.trim(),
          });
          setForm(f => ({ ...f, secretKey: "" }));
        }}>Save sync config</button>
        <button className="btn ghost" onClick={() => { clearSyncCfg(); setSyncCfg(null); }}>
          Clear and disable
        </button>
        <button className="btn ghost" disabled={diagRunning} onClick={runDiagnostics}>
          {diagRunning ? "Testing…" : "Test connection"}
        </button>
      </div>
      {diagLines.length > 0 && <div className="evidence-note"><pre className="evidence-raw">{diagLines.join("\n")}</pre></div>}
      {syncCfg && <p className="evidence-note">
        Active: prefix <code>{syncCfg.prefix}</code>, device{" "}
        <code>{syncCfg.device}</code>, key <code>…{syncCfg.keyID.slice(-6)}</code>
      </p>}
    </div>
  </section>;
}
