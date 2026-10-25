/**
 * Camera-guided capture (A+): pure helper logic for the guided viewfinder.
 *
 * Capture strategy (v2.0.37, supersedes the v2.0.35 "video-frame only" call):
 * the video-frame crop is capped at the delivered stream size — measured on an
 * S25, the camera captures were 692×1728 and 1814×3456 (1.2–6.3 MP) and OCR
 * then failed on them, while the same receipt shot as a 12 MP file parsed
 * cleanly. So where the browser exposes ImageCapture we takePhoto() a full-sensor
 * still and crop the guide region from the STILL; everywhere else we keep the
 * universally-supported video-frame crop. This is a capability difference in
 * INPUT QUALITY (like camera availability itself), not a parsing behaviour gap —
 * the same captured pixels still parse identically in every browser.
 *
 * Tap-to-focus (v2.0.37): tapping the preview applies a single-shot focus at the
 * tapped point (pointsOfInterest). Chromium/Android honours it; elsewhere the
 * `advanced` constraint simply no-ops (it never throws).
 *
 * Privacy posture (binding):
 *  - getUserMedia is requested ONLY from a user click, never probed at mount;
 *  - mediaDevices.enumerateDevices() is NEVER called anywhere in the app —
 *    no device list is built, opening just directly requests the stream;
 *  - frame pixels stay on the page: the meter reads a downscaled guide sample
 *    on-device to grade the capture (luma / glare / motion), the captured
 *    region only becomes the user's own receipt photo in the queue. This is
 *    receipt-processing canvas work, the single allowed class.
 *
 * Everything here is pure so `node --test` can pin it without a DOM.
 */

import { LUMA } from "./ocrConfig.js";

/**
 * Constraints for the guided capture. Deliberately `ideal` everywhere — an
 * unsupported value must never fail getUserMedia (OverconstrainedError), it
 * must degrade to the device's nearest mode. The classic trap is a bare
 * `video: true` which hands you 640×480 on many devices; a bare `width` naked
 * value is Chromium-interpreted as a 1920×1080/1080×1920 EXACT sequence —
 * never use naked values, `{ideal}` only.
 *
 * v2.0.36 (blur report): ask HIGH first (a 4K-capable phone sensor should not
 * be stuck reading 1080p off a moving paper strip — more sensor pixels mean
 * less per-pixel motion blur for the same hand speed), and the app re-opens
 * once at the plain-1920 ask if the delivered track is still under 1920
 * (LADDER in app.js). The ACTUAL granted size is read back and displayed —
 * never silently under-report.
 *
 * focusMode continuous is Chrome-Android-only; `ideal` keeps it a no-op
 * elsewhere. The app ALSO re-applies it via applyConstraints after the stream
 * is live: some Android stacks honor the setting only post-open.
 */
export const CAMERA_VIDEO_CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 3840 },
    height: { ideal: 2160 },
    focusMode: { ideal: "continuous" },
  },
};

/** Width below which the ladder opens a second stream asking explicitly for
 * 1920 (some Android camera HALs resolve a 4K ask to a low preview mode but
 * honor the classic 1080p ask). */
export const LADDER = { minWidth: 1920, fallbackWidth: { ideal: 1920 } };

/**
 * The guide rectangle as FRACTIONS of the live video's delivered frame.
 * Single source of truth: the meter samples exactly this region and the
 * capture crops exactly this region, so a capture is precisely what the
 * border showed. Fractions (not px) because the preview is CSS-scaled.
 */
export const GUIDE = {
  xF0: 0.08,
  xF1: 0.92,
  yF0: 0.05,
  yF1: 0.95,
};

/**
 * Map the guide fractions to sensor pixels of the delivered frame.
 * Exact (not letterboxed) because the preview element is forced to the
 * delivered frame's aspect ratio (aspectRatio set from videoWidth/Height),
 * so CSS-px fractions of the element are the same fractions of the frame.
 */
export function mapGuideToSensor(g, vw, vh) {
  const x = clampInt(Math.round(g.xF0 * vw), 0, vw - 2);
  const y = clampInt(Math.round(g.yF0 * vh), 0, vh - 2);
  const w = clampInt(Math.round((g.xF1 - g.xF0) * vw), 2, vw - x);
  const h = clampInt(Math.round((g.yF1 - g.yF0) * vh), 2, vh - y);
  return { x, y, w, h };
}

function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(Math.round(v), hi));
}

/** Downscale-sample resolution for the meter (64 × 128 luma grid). */
export const METER_SAMPLE = { w: 64, h: 128 };

/** Luma >= this counts as blown highlight (glare candidate), 0–255 scale. */
export const GLARE_LUMA = 255;

/**
 * Grid luma (BT.601, same coefficients the strip machinery uses) + the two
 * per-frame aggregates the lamp needs. data is RGBA, w*h pixels.
 */
export function lumaGrid(data, w, h) {
  const n = w * h;
  const grid = new Float32Array(n);
  let sum = 0;
  let glare = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const y = LUMA.r * data[o] + LUMA.g * data[o + 1] + LUMA.b * data[o + 2];
    grid[i] = y;
    sum += y;
    if (y >= GLARE_LUMA) glare++;
  }
  return { grid, mean: sum / n, glareFrac: glare / n };
}

/**
 * Mean absolute frame difference (0–255 scale) — a MOTION proxy: autofocus
 * wobble and hand-shake move the whole frame; a settled, slowly-locked ship
 * reads small. null when there is no previous grid (first sample).
 */
export function motionScore(prevGrid, grid) {
  if (!prevGrid || prevGrid.length !== grid.length) return null;
  let sum = 0;
  for (let i = 0; i < grid.length; i++) sum += Math.abs(grid[i] - prevGrid[i]);
  return sum / grid.length;
}

/**
 * Sharpness score — Tenengrad (mean squared gradient magnitude, central diff).
 * Higher = crisper. MEASURED 2026-10-25 on real captures: a crisp receipt scored
 * ~260, a soft one ~90 — while Laplacian variance ranked them BACKWARDS (soft
 * 125 > crisp 93) because sensor noise inflates lapVar. So Tenengrad is the
 * metric to use. Still COMPARE frames of the same scene / same receipt region;
 * an absolute floor is a heuristic, not a guarantee.
 */
export function sharpnessScore(data, w, h) {
  if (!data || w < 3 || h < 3) return 0;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    gray[i] = LUMA.r * data[o] + LUMA.g * data[o + 1] + LUMA.b * data[o + 2];
  }
  let sum = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      sum += gx * gx + gy * gy;
      n++;
    }
  }
  return n ? sum / n : 0;
}

/** Index of the highest score; ties keep the first. -1 on empty/invalid. Pure. */
export function pickSharpestIndex(scores) {
  if (!scores || !scores.length) return -1;
  let best = -Infinity, bi = -1;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] > best) { best = scores[i]; bi = i; }
  }
  return bi;
}

/**
 * Sharpness tunables. The live badge is RELATIVE (current frame vs the best in
 * the recent window) because absolute Laplacian variance depends on scene
 * content — a fixed threshold would call a plain wall "blurry" and a busy
 * keyboard "sharp". `frames`/`gapMs` bound the multi-frame capture so the
 * autofocus gets a chance to hunt between stills.
 */
export const SHARPNESS = {
  /** sample the guide region at this width for the live meter (larger than the luma grid — sharpness needs pixels) */
  sampleW: 320,
  /** a frame counts as "sharp" when within this fraction of the recent best */
  relativeSharp: 0.8,
  /** absolute Tenengrad floor for a crisp receipt CENTRE (calibrated 2026-10-25:
   *  crisp receipt ≈ 1200, soft ≈ 350 at 320 px). A heuristic, not a guarantee. */
  floor: 500,
  /** number of stills the multi-frame capture takes (the sharpest wins) */
  frames: 3,
  /** gap between stills, ms — lets the autofocus hunt between them */
  gapMs: 180,
};

/**
 * Lamp decision thresholds. Initial values, to be calibrated on the real
 * capture device (the harness drives a synthetic pattern, not a phone) —
 * re-measure with the user's S25 before closing this class.
 */
export const LAMP_THRESHOLDS = {
  /** mean guide luma below this reads "too dark" */
  darkMeanLuma: 95,
  /** blown-highlight fraction above this reads "glare" */
  glareFrac: 0.3,
  /** frame-diff below this (0–255) counts as quiet */
  motionQuiet: 4,
  /** consecutive quiet samples needed before the lamp turns green (~600 ms at the 150 ms meter cadence) */
  quietSamples: 4,
};

/**
 * One lamp decision from the measured aggregates. The lamp is advisory —
 * it never blocks Capture (the user always shoots); it only speaks.
 */
export function frameLamp({ mean, glareFrac, motion, stable }) {
  const T = LAMP_THRESHOLDS;
  if (mean < T.darkMeanLuma) {
    return { level: "warn", msg: "Too dark — add light" + ((arguments[1] && arguments[1].torch) ? " or use the torch" : "") };
  }
  if (glareFrac > T.glareFrac) {
    return { level: "warn", msg: "Glare on the paper — tilt slightly" };
  }
  if (motion == null || motion >= T.motionQuiet || stable < T.quietSamples) {
    return { level: "warn", msg: "Hold still…" };
  }
  return { level: "ok", msg: "Ready" };
}

/**
 * OCR-grade estimate for the capture region, ASSUMING an 80 mm-wide
 * thermal receipt (marked ≈ in the UI — an estimate, not a measurement).
 */
export function estimateDpi(captureWidthPx, receiptWidthMm = 80) {
  const pxPerMm = captureWidthPx / receiptWidthMm;
  return {
    pxPerMm: Math.round(pxPerMm),
    dpi: Math.round(pxPerMm * 25.4),
  };
}

/** Torch predicate (Chrome-Android exposes torch in getCapabilities). */
export function hasTorch(capabilities) {
  return !!(capabilities && typeof capabilities === "object" && capabilities.torch === true);
}

/**
 * Long-edge cap for a takePhoto() still before it becomes the queued File.
 * A still can be 12–50 MP; capping the long edge to ~4000 px keeps the crop in
 * the same regime as the 12 MP file photos that already parse well (4000 px
 * across an 80 mm receipt ≈ 1270 dpi — far above the ~300 dpi sweet spot) while
 * bounding decode/OCR memory. The pipeline downscales the receipt crop itself.
 */
export const CAPTURE_STILL_MAX_DIM = 4000;

/**
 * Which capture path to take. Pure so it is testable without a DOM:
 *  - "still"       → ImageCapture.takePhoto() available (Chromium/Android Chrome)
 *  - "video-frame" → universal fallback (Firefox, Safari, anything else)
 */
export function pickCaptureStrategy({ hasImageCapture }) {
  return hasImageCapture ? "still" : "video-frame";
}

/**
 * Normalize a pointer/tap position to 0–1 frame coordinates for
 * pointsOfInterest. Returns null on a degenerate rect (zero size) so the caller
 * can no-op instead of sending NaN to applyConstraints.
 */
export function normalizeTap(clientX, clientY, rect) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  return {
    x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
  };
}

/**
 * Advanced constraint for tap-to-focus at a normalized point. `single-shot`
 * locks focus at the tapped region; `advanced` constraints never throw on
 * unsupported devices — they are silently ignored, so this degrades to a no-op.
 */
export function tapFocusConstraint(pt) {
  return { advanced: [{ focusMode: "single-shot", pointsOfInterest: [{ x: pt.x, y: pt.y }] }] };
}

/**
 * Human-honest camera failure text. Names the action the user can take
 * instead — the file path always remains the primary/working path.
 */
export function cameraErrorText(err) {
  const name = err && err.name;
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Camera permission was denied or dismissed — allow the camera for this page, or use Choose file.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No usable camera found — use Choose file instead.";
    case "NotReadableError":
    case "TrackStartError":
      return "The camera seems busy in another app or tab — close it there, or use Choose file.";
    case "OverconstrainedError":
      return "The camera rejected the requested mode — use Choose file instead.";
    case "SecurityError":
      return "The camera needs a secure page (HTTPS or localhost) — use Choose file meanwhile.";
    default:
      return "The camera could not start " + (name ? "(" + name + ")" : "") + " — use Choose file instead.";
  }
}
