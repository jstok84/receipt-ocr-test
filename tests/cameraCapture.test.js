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
  mapGuideToSensor,
  lumaGrid,
  motionScore,
  frameLamp,
  estimateDpi,
  hasTorch,
  cameraErrorText,
  LAMP_THRESHOLDS,
} from "../src/cameraCapture.js";

test("constraints: degradation-safe shape — everything ideal, user-facing camera", () => {
  const v = CAMERA_VIDEO_CONSTRAINTS.video;
  assert.deepEqual(CAMERA_VIDEO_CONSTRAINTS.audio, false);
  assert.deepEqual(v.facingMode, { ideal: "environment" });
  assert.equal(v.width.ideal, 1920);
  assert.deepEqual(v.focusMode, { ideal: "continuous" });
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
