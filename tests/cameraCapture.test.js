/**
 * Guided-capture helper (cameraCapture.js) — pure logic, no DOM needed.
 * The thresholds/mapping are the contract the app ships behind, so the pins
 * here are binding: any threshold change must also re-verify the live
 * capture device behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAMERA_VIDEO_CONSTRAINTS,
  GUIDE,
  LADDER,
  CAPTURE_STILL_MAX_DIM,
  SHARPNESS,
  mapGuideToSensor,
  lumaGrid,
  motionScore,
  sharpnessScore,
  pickSharpestIndex,
  frameLamp,
  estimateDpi,
  hasTorch,
  cameraErrorText,
  pickCaptureStrategy,
  normalizeTap,
  tapFocusConstraint,
  LAMP_THRESHOLDS,
} from "../src/cameraCapture.js";

test("constraints: degradation-safe shape — everything ideal, user-facing camera, high-res ask", () => {
  const v = CAMERA_VIDEO_CONSTRAINTS.video;
  assert.deepEqual(CAMERA_VIDEO_CONSTRAINTS.audio, false);
  assert.deepEqual(v.facingMode, { ideal: "environment" });
  // v2.0.36 blur fix: ask high (4K) first; the app ladders down to the 1920
  // ask when the granted track is under 1920. ideal-only — a naked width is
  // Chromium-interpreted as an EXACT 1920x1080/1080x1920 sequence.
  assert.equal(v.width.ideal, 3840);
  assert.equal(v.height.ideal, 2160);
  // focusMode is a plain String per MDN (NOT a ConstrainDOMString) — the
  // `{ ideal: ... }` object form was silently ignored, so the camera never
  // engaged continuous AF. v2.0.45 fixes the shape; capture also forces an
  // explicit "single-shot" lock before takePhoto() (which does not autofocus).
  assert.equal(v.focusMode, "continuous");
  // ladder contract: fallback is the classic 1080p ask, threshold 1920
  assert.equal(LADDER.minWidth, 1920);
  assert.deepEqual(LADDER.fallbackWidth, { ideal: 1920 });
});

test("guide fractions cover the frame center, never the edges", () => {
  assert.ok(GUIDE.xF0 > 0 && GUIDE.xF1 < 1);
  assert.ok(GUIDE.yF0 > 0 && GUIDE.yF1 < 1);
  assert.ok(GUIDE.xF1 > GUIDE.xF0 && GUIDE.yF1 > GUIDE.yF0);
});

test("mapGuideToSensor: portrait 1080×1920 frame — stable crops", () => {
  const r = mapGuideToSensor(GUIDE, 1080, 1920);
  assert.equal(r.x, 86);      // round(0.08 × 1080)
  assert.equal(r.y, 96);      // round(0.05 × 1920)
  assert.equal(r.w, 907);     // round(0.84 × 1080)
  assert.equal(r.h, 1728);    // 0.90 × 1920
});

test("mapGuideToSensor: 640×480 frame — crops clamp inside the frame", () => {
  const r = mapGuideToSensor(GUIDE, 640, 480);
  assert.equal(r.x, 51);      // round(0.08 × 640) = 51.2
  assert.equal(r.y, 24);      // 0.05 × 480
  assert.equal(r.w, 538);     // round(0.84 × 640) = 537.6
  assert.equal(r.h, 432);     // 0.90 × 480
  assert.ok(r.x + r.w <= 640 && r.y + r.h <= 480);
  assert.ok(r.w >= 2 && r.h >= 2);
});

test("lumaGrid: all-white frame → mean 255, everything counts as glare", () => {
  const data = new Uint8Array(4 * 4 * 4); // 16 px, RGBA
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
  }
  const m = lumaGrid(data, 4, 4);
  assert.ok(Math.abs(m.mean - 255) < 1e-6);
  assert.equal(m.glareFrac, 1);
});

test("lumaGrid: all-black frame → mean 0, no glare; BT.601 honored on mid-gray", () => {
  const black = new Uint8Array(3 * 2 * 4);
  assert.equal(lumaGrid(black, 3, 2).mean, 0);
  // pure green pixel: BT.601 puts green at 0.587 of 255
  const green = new Uint8Array([0, 255, 0, 255, 0, 255, 0, 255]);
  assert.ok(Math.abs(lumaGrid(green, 1, 2).mean - 255 * 0.587) < 1e-6);
});

test("motionScore: null before the first frame; moves with real movement", () => {
  const a = new Float32Array([100, 100, 100, 100]);
  assert.equal(motionScore(null, a), null);
  const b = new Float32Array([110, 90, 100, 110]);
  assert.ok(Math.abs(motionScore(a, b) - 7.5) < 1e-6); // (10+10+0+10)/4
  assert.equal(motionScore(a, a), 0);
});

test("frameLamp: each decision branch carries its honest message", () => {
  const T = LAMP_THRESHOLDS;
  assert.match(frameLamp({ mean: 40, glareFrac: 0, motion: 1, stable: 99 }).msg, /Too dark/);
  assert.match(frameLamp({ mean: 220, glareFrac: 0.5, motion: 1, stable: 99 }).msg, /Glare/);
  assert.match(frameLamp({ mean: 220, glareFrac: 0, motion: null, stable: 0 }).msg, /Hold still/);
  assert.match(
    frameLamp({ mean: 220, glareFrac: 0, motion: T.motionQuiet - 1, stable: T.quietSamples - 1 }).msg,
    /Hold still/
  );
  assert.equal(frameLamp({ mean: 220, glareFrac: 0, motion: T.motionQuiet - 1, stable: T.quietSamples }).level, "ok");
  assert.match(frameLamp({ mean: 220, glareFrac: 0, motion: T.motionQuiet - 1, stable: T.quietSamples }).msg, /Ready/);
});

test("frameLamp: the lamp is advisory — Capture never gets a 'bad' block", () => {
  // the lamp returns ok | warn only; the app renders Capture unconditionally
  for (const l of [
    frameLamp({ mean: 5, glareFrac: 0, motion: 0, stable: 99 }),
    frameLamp({ mean: 255, glareFrac: 1, motion: 0, stable: 99 }),
    frameLamp({ mean: 255, glareFrac: 0, motion: 255, stable: 0 }),
  ]) {
    assert.ok(l.level === "ok" || l.level === "warn");
  }
});

test("estimateDpi: 1080-wide guide region across an 80 mm receipt ≈ 343 dpi", () => {
  const d = estimateDpi(1080, 80);
  assert.equal(d.pxPerMm, 14);      // 13.5 rounds to 14
  assert.equal(d.dpi, 343);         // 13.5 × 25.4 = 342.9
});

test("cameraErrorText: each error names the user's action, never a browser", () => {
  const cases = [
    [{ name: "NotAllowedError" }, /permission/],
    [{ name: "NotFoundError" }, /No usable camera/],
    [{ name: "NotReadableError" }, /busy in another app or tab/],
    [{ name: "OverconstrainedError" }, /rejected the requested mode/],
    [{ name: "SecurityError" }, /secure page/],
    [{ name: "SomeWeirdError" }, /could not start/],
    [{}, /could not start/],
  ];
  for (const [err, re] of cases) assert.match(cameraErrorText(err), re);
});

test("hasTorch: capability-driven, defensive on missing/odd shapes", () => {
  assert.equal(hasTorch(undefined), false);
  assert.equal(hasTorch(null), false);
  assert.equal(hasTorch({ width: { min: 1 } }), false);
  assert.equal(hasTorch({ torch: false }), false);
  assert.equal(hasTorch({ torch: true }), true);
});

test("pickCaptureStrategy: still where ImageCapture exists, video-frame everywhere else", () => {
  assert.equal(pickCaptureStrategy({ hasImageCapture: true }), "still");
  assert.equal(pickCaptureStrategy({ hasImageCapture: false }), "video-frame");
});

test("CAPTURE_STILL_MAX_DIM: a sane long-edge cap (>= 3000, and not absurd)", () => {
  assert.ok(CAPTURE_STILL_MAX_DIM >= 3000, "cap must keep the still well above the 300 dpi sweet spot");
  assert.ok(CAPTURE_STILL_MAX_DIM <= 6000, "cap must bound decode/OCR memory");
});

test("normalizeTap: client coords → 0–1 frame fractions, clamped", () => {
  const rect = { left: 100, top: 50, width: 400, height: 800 };
  assert.deepEqual(normalizeTap(300, 450, rect), { x: 0.5, y: 0.5 }); // center
  assert.deepEqual(normalizeTap(100, 50, rect), { x: 0, y: 0 });      // top-left
  assert.deepEqual(normalizeTap(500, 850, rect), { x: 1, y: 1 });     // bottom-right
  // outside the box clamps into range (never NaN / out-of-range)
  const clamped = normalizeTap(-50, 2000, rect);
  assert.equal(clamped.x, 0);
  assert.equal(clamped.y, 1);
  // degenerate rect → null (caller no-ops)
  assert.equal(normalizeTap(10, 10, { left: 0, top: 0, width: 0, height: 0 }), null);
  assert.equal(normalizeTap(10, 10, null), null);
});

test("tapFocusConstraint: single-shot at the tapped point, advanced (never throws)", () => {
  const c = tapFocusConstraint({ x: 0.25, y: 0.75 });
  assert.ok(Array.isArray(c.advanced) && c.advanced.length === 1);
  assert.equal(c.advanced[0].focusMode, "single-shot");
  assert.deepEqual(c.advanced[0].pointsOfInterest, [{ x: 0.25, y: 0.75 }]);
});

test("sharpnessScore: sharp stripes score higher than their blurred version", () => {
  const w = 16, h = 16;
  const sharp = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // 4-px vertical stripes — a realistic stroke width. (A 1-px checkerboard is a
    // degenerate case for a central-difference gradient: its ±2 neighbours match,
    // so the gradient is zero even though the pattern is maximally "sharp".)
    const v = Math.floor(x / 4) % 2 ? 255 : 0;
    const o = (y * w + x) * 4;
    sharp[o] = sharp[o + 1] = sharp[o + 2] = v; sharp[o + 3] = 255;
  }
  // 3x3 box blur of the same pattern
  const blurred = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < h && xx >= 0 && xx < w) { s += sharp[(yy * w + xx) * 4]; n++; }
    }
    const o = (y * w + x) * 4;
    blurred[o] = blurred[o + 1] = blurred[o + 2] = Math.round(s / n); blurred[o + 3] = 255;
  }
  assert.ok(sharpnessScore(sharp, w, h) > sharpnessScore(blurred, w, h), "sharp must outscore blurred");
  // flat frame → zero
  assert.equal(sharpnessScore(new Uint8Array(w * h * 4), w, h), 0);
  // degenerate input never throws
  assert.equal(sharpnessScore(null, 0, 0), 0);
});

test("pickSharpestIndex: max wins, first on ties, -1 on empty", () => {
  assert.equal(pickSharpestIndex([10, 50, 30]), 1);
  assert.equal(pickSharpestIndex([50, 50, 10]), 0);
  assert.equal(pickSharpestIndex([]), -1);
  assert.equal(pickSharpestIndex(null), -1);
});

test("SHARPNESS config: sane multi-frame bounds", () => {
  assert.ok(SHARPNESS.frames >= 2 && SHARPNESS.frames <= 6);
  assert.ok(SHARPNESS.sampleW >= 200 && SHARPNESS.sampleW <= 640);
  assert.ok(SHARPNESS.relativeSharp > 0 && SHARPNESS.relativeSharp <= 1);
});
