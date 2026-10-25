import React, { useState, useEffect, useRef } from "react";
import { processImage, processPDF, cleanAndMergeText } from "./ocrUtils";
import { parseReceipt, payableRescue } from "./parseReceipt";
import { scanVerdict } from "./scanVerdict";
import { detectFileKind, toProcessableSource } from "./imageInput";
import { loadSyncCfg, saveSyncCfg, clearSyncCfg, uploadScan, presignS3 } from "./sync";
import { APP_VERSION } from "./version.js";
import {
  CAMERA_VIDEO_CONSTRAINTS,
  GUIDE,
  METER_SAMPLE,
  LAMP_THRESHOLDS,
  LADDER,
  CAPTURE_STILL_MAX_DIM,
  SHARPNESS,
  cameraErrorText,
  mapGuideToSensor,
  lumaGrid,
  motionScore,
  sharpnessScore,
  pickSharpestIndex,
  frameLamp,
  estimateDpi,
  hasTorch,
  pickCaptureStrategy,
  normalizeTap,
  tapFocusConstraint,
} from "./cameraCapture.js";

// Version marker (user request 2026-10-24): the header shows the exact app
// version so scan disputes can never again be about "which bundle is
// deployed". Also exposed for console probes and written into sync manifests.
if (typeof window !== "undefined") window.__APP_VERSION = APP_VERSION;

// Cap for passing a takePhoto() still through WITHOUT re-encoding (v2.0.41):
// below this, the camera's own JPEG goes straight to the queue (crispest — no
// double JPEG); above it we crop/re-encode only to bound memory.
const CAPTURE_MAX_BYTES = 12e6;

/**
 * Crop the guide region from a takePhoto() still (a full-sensor Blob) and
 * return a JPEG Blob whose long edge is capped at CAPTURE_STILL_MAX_DIM.
 * The guide fractions are applied to the STILL's own dimensions — the still
 * shows the same scene as the preview, just at far more pixels — so the shot
 * matches what the border framed while keeping 12 MP+ resolution instead of
 * the video stream's 1–6 MP. createImageBitmap applies EXIF orientation.
 */
async function cropStillToGuide(stillBlob) {
  const bmp = await createImageBitmap(stillBlob);
  try {
    const sw = bmp.width, sh = bmp.height;
    const gx = GUIDE.xF0 * sw, gy = GUIDE.yF0 * sh;
    const gw = (GUIDE.xF1 - GUIDE.xF0) * sw, gh = (GUIDE.yF1 - GUIDE.yF0) * sh;
    const scale = Math.min(1, CAPTURE_STILL_MAX_DIM / Math.max(gw, gh));
    const cw = Math.max(1, Math.round(gw * scale));
    const ch = Math.max(1, Math.round(gh * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    canvas.getContext("2d").drawImage(bmp, gx, gy, gw, gh, 0, 0, cw, ch);
    return await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.95));
  } finally {
    bmp.close?.();
  }
}

/**
 * Sharpness of a still's centre region (where the receipt sits), measured on a
 * small downscaled canvas so we never hold several full-res decodes at once.
 * Used only to RANK frames of the same capture (relative), never across photos.
 */
async function stillSharpness(stillBlob) {
  const bmp = await createImageBitmap(stillBlob);
  try {
    const sw = bmp.width, sh = bmp.height;
    const cw = Math.max(2, Math.round(sw * 0.6));
    const ch = Math.max(2, Math.round(sh * 0.6));
    const cx = Math.round((sw - cw) / 2), cy = Math.round((sh - ch) / 2);
    const w = Math.min(SHARPNESS.sampleW, cw);
    const h = Math.max(1, Math.round(ch * (w / cw)));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, cx, cy, cw, ch, 0, 0, w, h);
    return sharpnessScore(ctx.getImageData(0, 0, w, h).data, w, h);
  } finally {
    bmp.close?.();
  }
}

export default function App() {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null);
  const [loading, setLoading] = useState(false);

  // Guided camera capture (feat/camera-guided-capture). The stream is opened
  // ONLY by a click on "Use camera" — no mount probing, and no
  // enumerateDevices() call anywhere (the old dead camera block's
  // always-running device probe is deleted, not migrated).
  // cameraState: off | opening | live | error
  const [cameraState, setCameraState] = useState("off");
  const [cameraErr, setCameraErr] = useState(null);
  const [cameraLamp, setCameraLamp] = useState(null); // {level: ok|warn, msg}
  const [cameraInfo, setCameraInfo] = useState(null); // {w,h,dpi:{pxPerMm,dpi}}
  const [cameraSharp, setCameraSharp] = useState(null); // {score, sharp} — live focus meter
  const [torchOn, setTorchOn] = useState(false);
  // Tap-to-focus feedback: normalized 0–1 point of the last tap (renders a
  // brief ring, then clears) — purely visual; the focus itself is the
  // applyConstraints call in tapToFocus().
  const [focusPt, setFocusPt] = useState(null);

  const [uploadedPreview, setUploadedPreview] = useState(null);
  const [pdfPreviews, setPdfPreviews] = useState([]);
  const [useFlatMode, setUseFlatMode] = useState(false);
  const [stripRescue, setStripRescue] = useState(null);
  // v2.0.23: the pay arm derived a target but no strip attempt measured it.
  // Browser-agnostic — no browser detection — just "the arm fired and the
  // strips fell short", so the user is never left with silent under-reporting.
  const [payArmFail, setPayArmFail] = useState(null);
  // v2.0.24: successful pay-zone re-OCR evidence (amount + winner + per-attempt
  // strip readings). Until now this rescue only surfaced as a check text —
  // no panel — so a browser whose capture is rescued via measurement (e.g.
  // Brave on the HOFER class) LOOKED like it ran no rescue flow while Edge's
  // item rescue showed a full one. Same machinery, equal display.
  const [payRescueEvidence, setPayRescueEvidence] = useState(null);
  const [copied, setCopied] = useState(false);
  const [dragHover, setDragHover] = useState(false);

  // Per-scan job list: one row per processed file — name, live status and
  // per-file sync result. Replaces the single shared loading row that gave
  // zero feedback on a multi-pick (second file appeared to "not even OCR").
  const [jobs, setJobs] = useState([]);
  const jobSeq = useRef(0);
  // Per-scan history (session-only). Clicking a queue row replays that scan's
  // snapshot into the SAME state a live scan leaves behind, so every panel
  // shows the selected scan without any duplicate rendering logic. Deliberately
  // no persistence, no export and no controls yet — the user wants to see
  // whether this shape is the right one before it grows.
  const [viewJobId, setViewJobId] = useState(null);
  // Values produced by the most recent runParsing call (its decision log and
  // the stage captures), so a snapshot can carry exactly what the panels got.
  const lastRunMeta = useRef({ parserLog: [], stages: [] });
  const newJob = name => {
    const id = ++jobSeq.current;
    setJobs(q => [...q, { id, name, status: "running", sync: null, at: Date.now() }]);
    return id;
  };
  const jobDone = (id, status, note = "") =>
    setJobs(q => q.map(j => (j.id === id ? { ...j, status, note } : j)));
  const jobSync = (id, patch) =>
    setJobs(q => q.map(j => (j.id === id ? { ...j, sync: { ...(j.sync || {}), ...patch } } : j)));

  /** Attach a finished scan's data to its queue row. */
  const jobSnapshot = (id, snap) =>
    setJobs(q => q.map(j => (j.id === id ? { ...j, snap } : j)));

  /**
   * Replay a stored scan into the live panels. This intentionally performs the
   * same setState calls a real scan ends with, so every existing panel (parsed,
   * checks, strip evidence, pay evidence, decision trail, stage images) shows
   * the selected scan with zero extra rendering code.
   */
  const showJob = id => {
    const j = jobs.find(x => x.id === id);
    if (!j || !j.snap) return;
    setViewJobId(id);
    setText(j.snap.text ?? "");
    setParsed(j.snap.parsed ?? null);
    setStripRescue(j.snap.stripRescue ?? null);
    setPayArmFail(j.snap.payArmFail ?? null);
    setPayRescueEvidence(j.snap.payRescueEvidence ?? null);
    setParserLog(j.snap.parserLog || []);
    setStages(j.snap.stages || []);
    setPipelineMs(j.snap.ms ?? null);
    setUploadedPreview(j.snap.preview ?? null);
    setPdfPreviews([]);
  };
  const runningJobs = jobs.filter(j => j.status === "running");
  const runningIndex = jobs.findIndex(j => j.status === "running");
  const activeJob = runningJobs[0] || null;

  // debug/evidence layer + test sync channel state
  // v2.0.2: evidence toggle persists (user reads it on every scan) and GATES
  // the window.__OCR_DEBUG switch: with evidence on, ocrUtils records every
  // workflow stage image into window.__OCR_STAGES and parseReceipt appends its
  // per-line decisions to window.__OCR_LOG — both harvested into state per scan.
  const [showEvidence, setShowEvidence] = useState(() => localStorage.getItem("ocr.evidence") !== "0");
  const [parserLog, setParserLog] = useState([]);
  const [stages, setStages] = useState([]);
  useEffect(() => {
    window.__OCR_DEBUG = showEvidence;
    window.__OCR_PANEL = true;
    localStorage.setItem("ocr.evidence", showEvidence ? "1" : "0");
    if (showEvidence) {
      // no scan has run in this session yet with evidence on — leave buffers;
      // otherwise show anything recorded by an already-finished scan
      setParserLog(window.__OCR_LOG || []);
      setStages(window.__OCR_STAGES || []);
    }
  }, [showEvidence]);
  const [pipelineMs, setPipelineMs] = useState(null);
  const [syncCfg, setSyncCfg] = useState(() => loadSyncCfg());
  const [syncStatus, setSyncStatus] = useState(null); // null | uploading | {ok, photoKey} | error string
  const [syncSetup, setSyncSetup] = useState(() => location.hash === "#sync");

  const videoRef = useRef(null);
  // Fullscreen overlay stage: the video element is JS-fit inside it (a CSS
  // percentage max-* against an auto-sized wrapper resolves differently
  // across engines — the guide overlay's fraction math must be EXACT in all
  // of them, so the fit is computed, not hoped for).
  const stageRef = useRef(null);
  // Camera metering state carried across rAF samples without re-rendering:
  // previous sample's luma grid (motion), consecutive-quiet counter, and the
  // timestamp of the last metered sample (150 ms cadence gate).
  const cameraStreamRef = useRef(null);
  const prevGridRef = useRef(null);
  const stableRef = useRef(0);
  const meterAtRef = useRef(0);
  // Sharpness meter: last-sample timestamp + a decaying recent-best so the
  // "sharp" badge is relative to the scene (absolute lapVar is content-dependent).
  const sharpAtRef = useRef(0);
  const sharpMaxRef = useRef(0);

  useEffect(() => {
    const onHash = () => setSyncSetup(location.hash === "#sync");
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // alreadyCleaned: processImage returns text that already went through the
  // single clean pass (idempotent); the PDF path still cleans pdf-embedded text.
  // v2.0.15 payAmount: the MEASURED pay-zone re-OCR reading from processImage
  // (result.payRescue?.amount). processImage's own finalParse is discarded
  // here — app.js re-parses independently — so the rescue decision must be
  // re-applied on this side too, with the measurement carried over.
  const runParsing = (rawText, extraItems = [], rescue = null, corrections = [], alreadyCleaned = false, payAmount = null, dateOverride = null, payDebug = null) => {
    let prepared = rawText;
    if (!useFlatMode) {
      if (!alreadyCleaned) prepared = cleanAndMergeText(rawText);
    } else {
      prepared = rawText.replace(/\n/g, " ");
    }
    let result = parseReceipt(prepared, extraItems, corrections);
    // v2.0.15 pay-zone payable rescue: fires only when the measured reading
    // matches items − POPUST ±0.02 (decision logic in parseReceipt).
    const payFixed = payableRescue(result, prepared, payAmount);
    if (payFixed) result = payFixed;
    // v2.0.22/v2.0.25 date rescue: only a measured strip re-OCR reading
    // (complete, calendar-valid) can fill the date, and ONLY when the parse
    // itself extracted none — never a decomposition of an ambiguous garble.
    // v2.0.25: the measured date carries ITS OWN provenance check line,
    // exactly like the pay-zone rescue's check and the item rescue's [?] —
    // a value that came from re-measurement must never display as if it
    // simply parsed. Appended into the final checks (ok:true — verified
    // evidence, not a failing state).
    let dateRescued = false;
    if (result.date == null && dateOverride) {
      result = { ...result, date: dateOverride };
      dateRescued = true;
    }
    if (dateRescued) {
      result = { ...result, checks: [...(result.checks || []), {
        ok: true,
        text: `date ${dateOverride} verified: MEASURED by strip re-OCR — the printed line was garbled, nothing invented`,
      }] };
    }
    // v2.0.23: surface "arm fired, no band measured" to the user (null clears it)
    setPayArmFail(payDebug || null);
    // v2.0.24: PAY-RESCUE decisions become part of the decision trail — until
    // now the log was captured INSIDE parseReceipt (before any rescue), so
    // "Extracted date: null / Final total: 4.13" printed while the displayed
    // result ran on measured evidence. The appended lines close that gap;
    // wording names the source, never a browser.
    const rescueNotes = [];
    // v2.0.25: the log above is the PRE-rescue parse — an explicit separator
    // so stale-looking numbers ("date: null", "total 4.13") are never read as
    // the final state.
    if (payFixed || dateRescued) {
      rescueNotes.push("— the lines above are the pre-rescue parse; rescue decisions applied afterwards follow —");
    }
    if (payFixed) {
      rescueNotes.push(
        `💰 Rescue decision (applied after the log above): pay-zone re-OCR MEASURED ${Number(payAmount).toFixed(2)} € — total corrected to ${result.total}`
      );
    }
    if (dateOverride && result.date === dateOverride) {
      rescueNotes.push(
        `🗓 Rescue decision (applied after the log above): date MEASURED ${dateOverride} by strip re-OCR (the logged parse date was null)`
      );
    }
    setParsed(result);
    // v2.0.2: the app-level parse is the last parseReceipt call of the scan,
    // so window.__OCR_LOG now holds exactly this scan's decision trail
    if (window.__OCR_DEBUG) {
      setParserLog([...(window.__OCR_LOG || []), ...rescueNotes]);
      setStages([...(window.__OCR_STAGES || [])]);
    }
    // evidence for the strip-recovered item (null clears it)
    setStripRescue(rescue);
    // v2.0.24: stale pay-zone evidence cleared at parse start; the processImage
    // call sites re-set it as soon as their result arrives
    setPayRescueEvidence(null);
    // Capture what the panels just received, for the per-scan history snapshot
    // (includes the rescue notes appended above, so a replayed scan shows the
    // same decision trail the live one did).
    lastRunMeta.current = {
      parserLog: window.__OCR_DEBUG ? [...(window.__OCR_LOG || []), ...rescueNotes] : [],
      stages: window.__OCR_DEBUG ? [...(window.__OCR_STAGES || [])] : [],
    };
    return result;
  };

  // Test sync: photo + manifest straight from the device to the user's
  // B2 bucket (bucket-scoped key, keyed in localStorage) — dormant until
  // configured via the #sync setup panel.
  const maybeSync = async (blob, name, ocr, parsedNow, ms, jobId = null) => {
    const cfg = syncCfg || loadSyncCfg();
    if (!cfg || !blob) return;
    if (jobId != null) jobSync(jobId, { state: "uploading" });
    setSyncStatus("uploading");
    try {
      const info = await uploadScan(cfg, {
        blob,
        ts: Date.now(),
        device: cfg.device || "",
        name,
        text: ocr.text,
        parsed: parsedNow,
        version: APP_VERSION,
        rescue: ocr.rescue,
        payRescue: ocr.payRescue
          ? {
              amount: ocr.payRescue.amount,
              winner: ocr.payRescue.winner
                ? { ...ocr.payRescue.winner, image: null }
                : null,
              attempts: ocr.payRescue.attempts,
            }
          : undefined,
        payDebug: ocr.payDebug ?? undefined,
        dateRescue: ocr.dateRescue
          ? { date: ocr.dateRescue.date, winner: ocr.dateRescue.winner, attempts: ocr.dateRescue.attempts }
          : undefined,
        corrections: ocr.corrections,
        ms,
      });
      setSyncStatus({ ok: true, jsonKey: info.jsonKey });
      if (jobId != null) jobSync(jobId, { state: "ok", key: info.photoKey });
    } catch (err) {
      console.warn("Sync failed:", err);
      setSyncStatus("sync failed: " + (err?.message || err));
      if (jobId != null) jobSync(jobId, { state: "failed", msg: String(err?.message || err) });
    }
  };

  // ----- guided camera capture ----------------------------------------------
  // Everything here runs only after an explicit "Use camera" click. The
  // captured region becomes a regular File in the SAME handleFiles queue path
  // as Choose file — no second pipeline, so queue rows, snapshots, evidence
  // rescues and sync behave identically for a camera shot.

  /** Stop tracks + reset meter state. Safe to call redundantly. */
  const stopCamera = () => {
    cameraStreamRef.current?.getTracks().forEach(t => t.stop());
    cameraStreamRef.current = null;
    prevGridRef.current = null;
    stableRef.current = 0;
    setCameraState("off");
    setCameraLamp(null);
    setCameraInfo(null);
    setTorchOn(false);
  };

  /** One getUserMedia attempt; returns the stream + the track's ACTUAL width
   *  (getSettings, available immediately — no waiting on video metadata). */
  const openStreamWith = async constraints => {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const s = stream.getVideoTracks?.()[0]?.getSettings?.() || {};
    return { stream, w: s.width || 0 };
  };

  const openCamera = async () => {
    if (cameraState === "live" || cameraState === "opening") return;
    stopCamera(); // clear any prior error/lamp state
    setCameraState("opening");
    try {
      // Resolution ladder (v2.0.36, after the blurry-capture report): ask
      // high first; if the granted track still came back under 1920 wide,
      // re-open ONCE at the classic 1080p ask — some Android HALs resolve a
      // 4K ask into a low preview mode but honor the plain 1920 one. Two
      // attempts, bounded, no infinite retry.
      let { stream, w } = await openStreamWith(CAMERA_VIDEO_CONSTRAINTS);
      if (w && w < LADDER.minWidth) {
        stream.getTracks().forEach(t => t.stop());
        ({ stream } = await openStreamWith({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: LADDER.fallbackWidth,
            focusMode: { ideal: "continuous" },
          },
        }));
      }
      cameraStreamRef.current = stream;
      setCameraState("live");
    } catch (err) {
      // Log the error NAME only — an error never carries frame data, but the
      // log should stay content-free regardless.
      console.warn("Camera open failed:", err?.name || err);
      setCameraErr(cameraErrorText(err));
      setCameraState("error");
    }
  };

  // Attach the live stream and record the ACTUALLY granted frame size (the
  // browser may deliver less than requested — shown in the panel, never
  // guessed). Also: re-apply continuous focus via applyConstraints now that
  // the stream is OPEN — some Android stacks only honor focusMode post-open
  // — and surface focusMode/frameRate from the track's real settings.
  useEffect(() => {
    if (cameraState !== "live") return;
    const v = videoRef.current;
    if (!v || !cameraStreamRef.current) return;
    v.srcObject = cameraStreamRef.current;
    v.play?.().catch(() => {});
    setCameraInfo(null);

    const track = cameraStreamRef.current.getVideoTracks?.()[0];
    // Post-open continuous-focus ask: capability-gated (throws/no-ops where
    // unsupported); `advanced` constraints never kill the stream.
    track?.applyConstraints?.({ advanced: [{ focusMode: "continuous" }] })
      .catch(() => {});

    const fit = () => {
      const stage = stageRef.current;
      if (!stage || !v.videoWidth) return;
      const aw = stage.clientWidth - 24, ah = stage.clientHeight - 24;
      if (aw <= 0 || ah <= 0) return;
      const s = Math.min(aw / v.videoWidth, ah / v.videoHeight);
      v.style.width = Math.round(v.videoWidth * s) + "px";
      v.style.height = Math.round(v.videoHeight * s) + "px";
    };
    const onMeta = () => {
      if (!v.videoWidth) return;
      fit();
      // px/mm is estimated over the GUIDE-REGION width — that is what the
      // OCR will actually see (marked ≈ in the UI: assumes an 80 mm receipt).
      const guideW = Math.round((GUIDE.xF1 - GUIDE.xF0) * v.videoWidth);
      const s = track?.getSettings?.() || {};
      setCameraInfo({
        w: v.videoWidth,
        h: v.videoHeight,
        dpi: estimateDpi(guideW),
        focusMode: s.focusMode || null,
        frameRate: s.frameRate ? Math.round(s.frameRate) : null,
      });
    };
    addEventListener("resize", fit);
    v.addEventListener("loadedmetadata", onMeta);
    if (v.videoWidth) onMeta();
    return () => {
      removeEventListener("resize", fit);
      v.removeEventListener("loadedmetadata", onMeta);
    };
  }, [cameraState]);

  // The quality lamp: sample the GUIDE region downscaled (METER_SAMPLE) every
  // ~150 ms and grade luma / glare / motion. Advisory only — Capture is never
  // blocked. Follows the same pixel-read class as the OCR pipeline itself:
  // receipt capture, pixels never leave the page.
  useEffect(() => {
    if (cameraState !== "live") return;
    let raf = 0;
    let stopped = false;
    const canvas = document.createElement("canvas");
    canvas.width = METER_SAMPLE.w;
    canvas.height = METER_SAMPLE.h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    // Larger sample for the sharpness meter — lapVar needs pixels, not a 64px grid.
    const sharpCanvas = document.createElement("canvas");
    const sharpCtx = sharpCanvas.getContext("2d", { willReadFrequently: true });
    sharpMaxRef.current = 0;
    const tick = ts => {
      if (stopped) return;
      raf = requestAnimationFrame(tick);
      const v = videoRef.current;
      if (!v || !v.videoWidth) return;
      if (ts - meterAtRef.current < 150) return;
      meterAtRef.current = ts;
      const vw = v.videoWidth, vh = v.videoHeight;
      const r = mapGuideToSensor(GUIDE, vw, vh);
      ctx.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, METER_SAMPLE.w, METER_SAMPLE.h);
      const { grid, mean, glareFrac } = lumaGrid(
        ctx.getImageData(0, 0, METER_SAMPLE.w, METER_SAMPLE.h).data,
        METER_SAMPLE.w,
        METER_SAMPLE.h
      );
      const motion = motionScore(prevGridRef.current, grid);
      const stable =
        motion != null && motion < LAMP_THRESHOLDS.motionQuiet ? stableRef.current + 1 : 0;
      stableRef.current = stable;
      prevGridRef.current = grid;
      setCameraLamp(frameLamp({ mean, glareFrac, motion, stable }));
      // Sharpness meter (~300 ms, larger sample). RELATIVE badge — "sharp" when the
      // current frame is near the recent best (absolute lapVar is content-dependent).
      if (ts - sharpAtRef.current > 300) {
        sharpAtRef.current = ts;
        const sw = Math.min(SHARPNESS.sampleW, r.w);
        const sh = Math.max(1, Math.round(r.h * (sw / r.w)));
        sharpCanvas.width = sw;
        sharpCanvas.height = sh;
        sharpCtx.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, sw, sh);
        const score = sharpnessScore(sharpCtx.getImageData(0, 0, sw, sh).data, sw, sh);
        const best = Math.max(score, sharpMaxRef.current * 0.98);
        sharpMaxRef.current = best;
        setCameraSharp({ score: Math.round(score), sharp: score >= best * SHARPNESS.relativeSharp });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [cameraState]);

  // Fullscreen overlay behavior: Escape closes; body scroll is locked while
  // the capture interface owns the viewport (restored on close/unmount).
  useEffect(() => {
    if (cameraState === "off") return;
    const onKey = e => { if (e.key === "Escape") stopCamera(); };
    addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [cameraState]);

  // Tracks MUST die when the app unmounts (the panel-closing path calls
  // stopCamera; this covers route/teardown cases).
  useEffect(() => () => {
    cameraStreamRef.current?.getTracks().forEach(t => t.stop());
  }, []);

  /**
   * Capture into the queue. Two paths, best first:
   *  ① ImageCapture.takePhoto() — a full-sensor still, passed through as the
   *     camera's OWN JPEG (no canvas re-encode). Re-encoding softened the shot
   *     (measured: the phone's native still is crisper than a canvas re-encode;
   *     the Oct-24 file upload, never re-encoded, is visibly cleaner). Only
   *     cropped/re-encoded when the file is very large.
   *  ② video-frame crop — the universal fallback (Firefox/Safari/synthetic
   *     devices) where ImageCapture is missing or takePhoto() rejects.
   * One honest wait: toBlob is the single async step; no artificial "autofocus
   * settle" timer — the lamp already reported steadiness and the user decides.
   */
  const captureToQueue = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || cameraState !== "live") return;
    const track = cameraStreamRef.current?.getVideoTracks?.()[0];
    const strategy = pickCaptureStrategy({
      hasImageCapture: typeof window !== "undefined" && typeof window.ImageCapture === "function",
    });

    let blob = null;
    if (strategy === "still" && track) {
      try {
        const cap = new window.ImageCapture(track);
        // Multi-frame (KYC-style best-frame): autofocus hunts, so take a few
        // stills and keep the sharpest centre region — this beats the AF
        // locking onto a high-contrast background behind the receipt.
        const shots = [];
        for (let i = 0; i < SHARPNESS.frames; i++) {
          shots.push(await cap.takePhoto());
          if (i < SHARPNESS.frames - 1) await new Promise(r => setTimeout(r, SHARPNESS.gapMs));
        }
        const scores = [];
        for (const s of shots) scores.push(await stillSharpness(s));
        const best = shots[Math.max(0, pickSharpestIndex(scores))];
        // Native JPEG straight through — no canvas re-encode (that was the
        // softener). Crop/re-encode only if the file is too big to keep whole.
        blob = best.size <= CAPTURE_MAX_BYTES ? best : await cropStillToGuide(best);
      } catch (err) {
        // takePhoto can reject on some stacks (synthetic device, mid-record) —
        // fall back to the video frame rather than fail the shot.
        console.warn("takePhoto failed, using video frame:", err?.name || err);
        blob = null;
      }
    }
    if (!blob) {
      const r = mapGuideToSensor(GUIDE, v.videoWidth, v.videoHeight);
      const canvas = document.createElement("canvas");
      canvas.width = r.w;
      canvas.height = r.h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.95));
    }
    if (!blob) return; // empty frame — the lamp/queue shows the state anyway
    // Straight-to-queue (A+): the moment the shot is taken the fullscreen
    // capture interface yields the viewport back — retake = hit Use camera
    // again; the queue row + evidence trail shows the result.
    stopCamera();
    const name = `camera-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
    await handleFiles(new File([blob], name, { type: "image/jpeg" }), newJob(name));
  };

  /**
   * Tap-to-focus: a tap on the preview focuses at that point (single-shot,
   * pointsOfInterest). Chromium/Android honours it; elsewhere the `advanced`
   * constraint no-ops (never throws). A brief ring marks where the user tapped.
   */
  const tapToFocus = async e => {
    const v = videoRef.current;
    if (!v || cameraState !== "live") return;
    const pt = normalizeTap(e.clientX, e.clientY, v.getBoundingClientRect());
    if (!pt) return;
    const camView = v.closest(".cam-view");
    const cr = camView ? camView.getBoundingClientRect() : { left: 0, top: 0 };
    setFocusPt({ nx: pt.x, ny: pt.y, px: e.clientX - cr.left, py: e.clientY - cr.top });
    setTimeout(() => setFocusPt(null), 900);
    const track = cameraStreamRef.current?.getVideoTracks?.()[0];
    if (!track?.applyConstraints) return;
    // 1) Single-shot at the tapped point — honoured by some Chromium/Android HALs.
    try { await track.applyConstraints(tapFocusConstraint(pt)); }
    catch (err) { console.warn("Tap-to-focus point failed:", err?.name || err); }
    // 2) Many Android HALs do NOT implement pointsOfInterest, so step 1 is a
    //    silent no-op. Force a real AF cycle by dropping to manual and back to
    //    continuous — this makes the camera re-run autofocus (at frame centre).
    //    Best-effort: only when the track advertises both modes.
    try {
      const modes = (track.getCapabilities?.() || {}).focusMode || [];
      if (modes.includes("manual") && modes.includes("continuous")) {
        await track.applyConstraints({ advanced: [{ focusMode: "manual" }] });
        await new Promise(r => setTimeout(r, 80));
        await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
      }
    } catch { /* capability flip mid-session — ignore */ }
    const s = track.getSettings?.() || {};
    setCameraInfo(prev => (prev ? { ...prev, focusMode: s.focusMode || prev.focusMode } : prev));
  };

  const toggleTorch = async () => {
    const track = cameraStreamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    const on = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: on }] });
      setTorchOn(on);
    } catch (err) {
      // Capability flipped mid-session (lamp pulled, tab changed) — surface in
      // console only; the button visibility itself is capability-driven.
      console.warn("Torch failed:", err?.name || err);
    }
  };

  const handleFiles = async (file, jobId = null) => {
    if (!file) return;
    // Classify from the file's own bytes. Chromium reports an EMPTY file.type
    // for .heic, so the old `file.type.startsWith("image/")` gate rejected every
    // iPhone photo as "unsupported file type"; it also mislabelled a HEIF/AVIF
    // renamed to .jpg. Bytes are the only reliable signal.
    const kind = await detectFileKind(file);
    const isImage = kind === "image";
    const isPDF = kind === "pdf";
    setText(isImage ? "Processing image file..." : isPDF ? "Processing PDF..." : "");
    setUploadedPreview(null);
    setPdfPreviews([]);
    setParsed(null);
    setLoading(true);

    try {
      if (isImage) {
        // HEIC/HEIF are decoded to a PNG data URL here. JPEG/PNG/WebP/AVIF pass
        // through untouched — the same File object as before this change.
        const prepared = await toProcessableSource(file);
        setUploadedPreview(prepared.previewURL);
        const t0 = performance.now();
        const result = await processImage(prepared.src);
        setText(result.text);
        const parsedNow = runParsing(result.text, result.extraItems, result.rescue, result.corrections, true, result.payRescue?.amount ?? null, result.dateRescue?.date ?? null, result.payDebug ?? null);
        setPayRescueEvidence(result.payRescue ?? null);
        const ms = Math.round(performance.now() - t0);
        setPipelineMs(ms);
        jobDone(jobId, "done", `${ms} ms · ${parsedNow.items.length} items · ${parsedNow.checks.filter(c => !c.ok).length} failing checks`);
        // Store this scan on its row so the row can be clicked later.
        jobSnapshot(jobId, {
          at: Date.now(),
          ms,
          text: result.text,
          parsed: parsedNow,
          stripRescue: result.rescue ?? null,
          payArmFail: result.payDebug ?? null,
          payRescueEvidence: result.payRescue ?? null,
          parserLog: lastRunMeta.current.parserLog,
          stages: lastRunMeta.current.stages,
          preview: prepared.previewURL,
        });
        setViewJobId(jobId);
        maybeSync(file, file.name, result, parsedNow, ms, jobId);
      } else if (isPDF) {
        // no OpenCV photo pipeline on the PDF path — clear stale stage images
        // from the previous photo scan so the panel never mixes scans
        if (window.__OCR_DEBUG === true) window.__OCR_STAGES = [];
        const { text: pdfText, previews } = await processPDF(file);
        setText(pdfText);
        const pdfParsed = runParsing(pdfText);
        setPdfPreviews(previews);
        jobDone(jobId, "done", "PDF text below");
        jobSnapshot(jobId, {
          at: Date.now(),
          ms: null,
          text: pdfText,
          parsed: pdfParsed,
          stripRescue: null,
          payArmFail: null,
          payRescueEvidence: null,
          parserLog: lastRunMeta.current.parserLog,
          stages: [],
          preview: null,
        });
        setViewJobId(jobId);
      } else {
        setText("Unsupported file type");
        jobDone(jobId, "error", "unsupported file type");
      }
    } catch (err) {
      console.error(err);
      setText("Error processing image");
      jobDone(jobId, "error", "processing threw — see console");
    }
    setLoading(false);
  };

  const handleFileUpload = async e => {
    // Bulk selection: process every picked file sequentially — earlier builds
    // took only files[0] and silently dropped the rest of a multi-selection.
    for (const f of e.target.files) {
      await handleFiles(f, newJob(f.name));
    }
    e.target.value = ""; // allow re-selecting the same file
  };

  const handleDrop = e => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) return (async () => { for (const f of files) await handleFiles(f, newJob(f.name)); })();
  };

  const handleDragOver = e => e.preventDefault();

  const copyText = () => {
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const preview = uploadedPreview;

  return (
    <div className="container">
      <header className="app-header">
        <h1>Receipt OCR</h1>
        <div className="header-actions">
          <button
            className="btn ghost mini"
            onClick={() => setShowEvidence(!showEvidence)}
            title="workflow stages, parser decisions, raw OCR, checks — recorded while scanning"
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
        <span className="app-version" title="app version marker — compare this against the expected release version">{APP_VERSION}</span>
        {" · Mode: "}
        {useFlatMode ? "flat (no line breaks)" : "line-based"} · everything is
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
          <input type="file" accept="image/*,.pdf,.heic,.heif" multiple onChange={handleFileUpload} />
        </label>
        <button
          className="btn ghost"
          type="button"
          onClick={openCamera}
          title="Guided capture: frame the receipt inside the border — the shot is cropped to the border and scanned"
        >
          Use camera
        </button>
      </section>

      {/* Fullscreen capture interface: NOTHING but the capture. Fixed dialog
          over the whole app (the page stays beneath, untouched), stage video,
          guide border + advisory lamp, bottom action bar. Escape closes. */}
      {cameraState !== "off" && <div className="cam-overlay" role="dialog" aria-modal="true" aria-label="Guided camera capture">
        {/* Top bar: every action EXCEPT capture (user request 2026-10-25). */}
        <div className="cam-topbar">
          <button className="btn ghost" onClick={stopCamera} type="button">Close</button>
          {(() => {
            const track = cameraState === "live" ? cameraStreamRef.current?.getVideoTracks?.()[0] : null;
            return hasTorch(track?.getCapabilities?.()) && (
              <button className="btn ghost" onClick={toggleTorch} type="button">
                {torchOn ? "Torch off" : "Torch on"}
              </button>
            );
          })()}
        </div>

        <div className="cam-stage" ref={stageRef}>
          {cameraState === "opening" && <p className="cam-msg">Opening the camera …</p>}
          {cameraState === "error" && <p className="cam-msg error" role="alert">{cameraErr}</p>}
          {cameraState === "live" && (
            <div className="cam-view">
              <video ref={videoRef} autoPlay playsInline muted onClick={tapToFocus} />
              {focusPt && (
                <span
                  className="focus-ring"
                  style={{ left: focusPt.px + "px", top: focusPt.py + "px" }}
                  aria-hidden="true"
                />
              )}
              <div
                className={`guide lamp-${cameraLamp?.level || "init"}`}
                style={{
                  left: GUIDE.xF0 * 100 + "%",
                  right: (1 - GUIDE.xF1) * 100 + "%",
                  top: GUIDE.yF0 * 100 + "%",
                  bottom: (1 - GUIDE.yF1) * 100 + "%",
                }}
                aria-hidden="true"
              />
            </div>
          )}
        </div>

        {cameraState === "live" && cameraLamp && (
          <p className={`lamp-msg ${cameraLamp.level}`}>{cameraLamp.msg}</p>
        )}
        {cameraState === "live" && cameraSharp && (
          <p className={`sharp-msg ${cameraSharp.sharp ? "ok" : "warn"}`}>
            {cameraSharp.sharp ? "Focus: sharp ✓" : "Focus: hold steady / move closer"}
          </p>
        )}
        {cameraInfo && <p className="cam-info">
          capture ≈{cameraInfo.dpi.pxPerMm} px/mm (≈{cameraInfo.dpi.dpi} dpi, assuming an
          80&nbsp;mm-wide receipt) · stream {cameraInfo.w}×{cameraInfo.h} px
          {cameraInfo.frameRate ? ` · ${cameraInfo.frameRate} fps` : ""}
          {cameraInfo.focusMode ? ` · focus ${cameraInfo.focusMode}` : ""}
          {cameraInfo.dpi.dpi < 300 ? " — below the ~300 dpi OCR sweet spot; the rescues will still try" : ""}
        </p>}

        {/* Bottom bar: the primary action, alone (user request 2026-10-25). */}
        <div className="cam-bottombar">
          <button className="btn primary capture" onClick={captureToQueue} disabled={cameraState !== "live"} type="button">
            Capture &amp; scan
          </button>
        </div>
      </div>}

      {loading && <div className="loading-row" role="status">
        <span className="dot" />
        Processing {activeJob
          ? <strong>{jobs.reduce((acc, j, i) => acc + (i < runningIndex ? 1 : 0), 0)}{jobs.length ? `/${jobs.length}` : ""} · {activeJob.name}</strong>
          : "…"}
      </div>}

      {jobs.length > 0 && <div className="queue" aria-label="scan queue">
        {jobs.map(j => <div
          className={`queue-row ${j.status}${j.snap ? " clickable" : ""}${viewJobId === j.id ? " selected" : ""}`}
          key={j.id}
          onClick={() => showJob(j.id)}
          role={j.snap ? "button" : undefined}
          tabIndex={j.snap ? 0 : undefined}
          aria-pressed={j.snap ? viewJobId === j.id : undefined}
          title={j.snap ? "Show this scan's parsed data and decision trail" : undefined}
          onKeyDown={e => {
            if (j.snap && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); showJob(j.id); }
          }}>
          <span className={`mark ${j.status === "running" ? "pulse" : ""}`}>
            {j.status === "done" ? "✓" : j.status === "error" ? "!" : "·"}
          </span>
          <span className="qname">{j.name}</span>
          {j.status !== "running" && j.note && <span className="qnote">{j.note}</span>}
          {j.sync?.state === "uploading" && <span className="qsync">sync…</span>}
          {j.sync?.state === "ok" && <span className="qsync ok">synced ✓</span>}
          {j.sync?.state === "failed" && <span className="qsync bad" title={j.sync.msg}>sync failed</span>}
          <span className="qtime">
            {new Date(j.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        </div>)}
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

      {payRescueEvidence && <details className="panel evidence">
        <summary>
          Pay-zone re-OCR evidence — measured{" "}
          {Number(payRescueEvidence.amount).toFixed(2)} €
          {payRescueEvidence.winner?.band
            ? ` from band ${Math.round(payRescueEvidence.winner.band[0] * 100)}–${Math.round(payRescueEvidence.winner.band[1] * 100)}%`
            : ""}
        </summary>
        <div className="evidence-body">
          <p>
            The total was <strong>measured by OCR</strong> from the pay-zone strip
            below, not derived from the items. This is the same rescue machinery as
            the strip evidence above — shown here so it is never silently invisible.
          </p>
          {payRescueEvidence.attempts?.map((a, i) => {
            const w = payRescueEvidence.winner;
            const won = Boolean(a.won) || Boolean(
              w && a.stripKind === w.stripKind && a.psm === w.psm && (a.kernel || w.kernel) === w.kernel &&
              a.band[0] === w.band[0] && a.band[1] === w.band[1]
            );
            return <div className="attempt" key={i}>
              <div className="attempt-label">
                attempt {i + 1}: strip={a.stripKind}
                {" "}band={Math.round(a.band[0] * 100)}–{Math.round(a.band[1] * 100)}%
                {" "}{a.factor}× {a.kernel === "lanczos3" ? "lanczos3" : "catrom"}
                {" "}PSM={a.psm}
                {won && " ← WINNER (this band's reading was measured)"}
              </div>
              {a.image && <img src={a.image} alt={`pay-zone strip attempt ${i + 1}`} />}
              <pre>{a.lines.join("\n")}</pre>
            </div>;
          })}
        </div>
      </details>}

      {showEvidence && <section className="panel evidence">
        <div className="panel-head">
          <h2>Debug evidence</h2>
          <span className="evidence-meta">
            {pipelineMs != null
              ? `pipeline ${pipelineMs} ms`
              : "no pipeline timing yet"}
            {" "}· {(stripRescue?.attempts?.length || 0) + (payArmFail?.attempts?.length || 0) + (payRescueEvidence?.attempts?.length || 0)} cascade attempt(s)
          </span>
        </div>
        <div className="evidence-body">
          {(() => {
            const v = scanVerdict(text, parsed);
            return <p className={`evidence-verdict ${v.kind}`}>
              <strong>
                {v.kind === "receipt" ? "Receipt parsed" :
                 v.kind === "garbage" ? "No receipt content" :
                 v.kind === "empty" ? "Nothing scanned" :
                 "Partial read"}
              </strong>
              {" "}{v.detail}
              <span className="ev-stats">
                {" "}[{v.stats.lines} OCR lines · {v.stats.amountLines} amount lines · {v.stats.keywordLines} merchant keywords]
              </span>
            </p>;
          })()}
          {stripRescue && <p className="evidence-note">
            Strip-repair cascade ran — recovered item evidence below.
          </p>}
          {payArmFail && <div className="evidence-note">
            <p>
              <strong>Rescue armed but not measured:</strong> the pay zone derived a target
              {" "}{Number(payArmFail.target).toFixed(2)} € ({payArmFail.armedFrom}) from the parsed text, and{" "}
              {payArmFail.attempts.length} strip re-OCR attempt{payArmFail.attempts.length === 1 ? "" : "s"} ran,
              but no band read a matching amount. This can happen when browser privacy
              protections (pixel-read shielding, adblock) degrade re-OCR measurement — the
              app never bypasses them. Re-photographing or re-scanning this receipt may
              resolve it; every band's readings are included in the sync evidence.
            </p>
            {payArmFail.attempts.map((a, i) => <div className="attempt" key={i}>
              <div className="attempt-label">
                pay attempt {i + 1}: strip={a.stripKind}
                {" "}band={Math.round(a.band[0] * 100)}–{Math.round(a.band[1] * 100)}%
                {" "}{a.factor}× {a.kernel === "lanczos3" ? "lanczos3" : "catrom"}
                {" "}PSM={a.psm}
                {a.hit ? " HIT" : ""}
              </div>
              <pre>{a.lines.join("\n")}</pre>
            </div>)}
          </div>}
          <details open>
            <summary>Raw OCR text ({text ? text.split("\n").filter(l => l.trim()).length : 0} lines)</summary>
            <pre className="evidence-raw">{text || "(nothing scanned yet)"}</pre>
          </details>
          {parserLog.length > 0 && <details open>
            <summary>Parser decisions ({parserLog.length} lines)</summary>
            <pre className="evidence-raw">{parserLog.join("\n")}</pre>
          </details>}
          {stages.length > 0 && <details open>
            <summary>Workflow stages ({stages.length} images)</summary>
            <div className="evidence-stages">
              {stages.map((s, i) => <figure key={i}>
                <figcaption>{i + 1}. {s.label}</figcaption>
                <img src={s.dataURL} alt={s.label} />
              </figure>)}
            </div>
          </details>}
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
    // 0: which bundle is actually running — the hashed filename identifies the
    // build. A phone serving a stale cached bundle caches the old HTML too, so
    // the hash stays old across deploys until the user busts it. I can compare
    // this hash against what Pages currently serves.
    const bundleSrc = document.querySelector('script[src*="receipt"]')?.src || "(inline)";
    lines.push(`0 bundle: ${bundleSrc.slice(-40)}`);
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
        keyID: (form.keyID || "").trim() || String(saved?.keyID || "").trim(),
        secretKey: (form.secretKey || "").trim() || String(saved?.secretKey || "").trim(),
        prefix: (form.prefix || "").trim() || String(saved?.prefix || "receipts/").trim(),
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
