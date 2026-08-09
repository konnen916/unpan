/**
 * Tests for the parts of unpan that are just arithmetic.
 *
 * None of this needs a browser. The Web Audio wiring is thin and obvious; the
 * matrix, the correlation figure and the WAV encoder are where being wrong is
 * silent, so they live in their own module and get tested here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyWidth,
  correlation,
  encodeWav,
  headroomGain,
  normaliseGain,
  peak,
  widthGains,
} from "../audio.js";

const buf = (...values) => Float32Array.from(values);

test("width 1 leaves the channels alone", () => {
  const { a, b } = widthGains(1);
  assert.equal(a, 1);
  assert.equal(b, 0);
});

test("width 0 is an equal blend of both channels", () => {
  const { a, b } = widthGains(0);
  assert.equal(a, 0.5);
  assert.equal(b, 0.5);
});

test("the gains always sum to one, which is what keeps the level steady", () => {
  for (let w = 0; w <= 1; w += 0.05) {
    const { a, b } = widthGains(w);
    assert.ok(Math.abs(a + b - 1) < 1e-12, `w=${w} summed to ${a + b}`);
  }
});

test("width 1 is the identity", () => {
  const l = buf(0.5, -0.25, 0.9);
  const r = buf(-0.1, 0.75, 0.0);
  const [outL, outR] = applyWidth(l, r, 1);
  assert.deepEqual(Array.from(outL), Array.from(l));
  assert.deepEqual(Array.from(outR), Array.from(r));
});

test("width 0 makes both channels the same, and equal to the average", () => {
  const l = buf(1.0, -0.5, 0.2);
  const r = buf(0.0, 0.5, 0.6);
  const [outL, outR] = applyWidth(l, r, 0);
  assert.deepEqual(Array.from(outL), Array.from(outR));
  assert.ok(Math.abs(outL[0] - 0.5) < 1e-7);
  assert.ok(Math.abs(outL[1] - 0.0) < 1e-7);
  assert.ok(Math.abs(outL[2] - 0.4) < 1e-7);
});

test("collapsing width can never clip, whatever goes in", () => {
  /**
   * The whole reason width is restricted to 0..1. Each output is a convex
   * combination of the two inputs, so it cannot exceed the peak that was
   * already there. This is a property rather than a check, which is why it is
   * hammered with random input rather than a couple of examples.
   */
  for (let trial = 0; trial < 500; trial++) {
    const n = 64;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      l[i] = Math.random() * 2 - 1;
      r[i] = Math.random() * 2 - 1;
    }
    const ceiling = Math.max(peak(l), peak(r));
    const w = Math.random();
    const [outL, outR] = applyWidth(l, r, w);
    const got = Math.max(peak(outL), peak(outR));
    assert.ok(
      got <= ceiling + 1e-6,
      `w=${w} produced ${got} from a ceiling of ${ceiling}`,
    );
  }
});

test("identical channels correlate at one", () => {
  const l = buf(0.1, -0.4, 0.8, -0.2);
  assert.ok(Math.abs(correlation(l, l) - 1) < 1e-6);
});

test("an inverted channel correlates at minus one", () => {
  const l = buf(0.1, -0.4, 0.8, -0.2);
  const r = l.map((v) => -v);
  assert.ok(Math.abs(correlation(l, r) + 1) < 1e-6);
});

test("a hard panned recording correlates at zero", () => {
  /**
   * The case that started this. Everything in one channel, nothing in the
   * other, which is how records were mixed before engineers trusted stereo.
   */
  const l = buf(0.9, -0.7, 0.3, -0.5);
  const r = buf(0, 0, 0, 0);
  assert.equal(correlation(l, r), 0);
});

test("silence correlates at zero rather than dividing by zero", () => {
  const silence = new Float32Array(16);
  assert.equal(correlation(silence, silence), 0);
});

test("correlation rises towards one as width is collapsed", () => {
  const l = buf(0.9, -0.7, 0.3, -0.5, 0.2);
  const r = buf(0.1, 0.2, -0.8, 0.4, -0.3);
  const before = correlation(l, r);
  const [wideL, wideR] = applyWidth(l, r, 0.5);
  const [monoL, monoR] = applyWidth(l, r, 0);
  assert.ok(correlation(wideL, wideR) > before);
  assert.ok(Math.abs(correlation(monoL, monoR) - 1) < 1e-6);
});

test("peak finds the largest magnitude, not the largest value", () => {
  // Compared with a tolerance because Float32Array holds 0.9 as
  // 0.8999999761581421, and pretending otherwise makes a passing test lucky.
  assert.ok(Math.abs(peak(buf(0.2, -0.9, 0.5)) - 0.9) < 1e-7);
  assert.equal(peak(new Float32Array(4)), 0);
});

test("normalising computes the gain that lands on the target", () => {
  const gain = normaliseGain(0.5, -1);
  const target = Math.pow(10, -1 / 20);
  assert.ok(Math.abs(0.5 * gain - target) < 1e-9);
});

test("normalising silence does not divide by zero", () => {
  assert.equal(normaliseGain(0, -1), 1);
});

test("a wav file starts with a valid riff header", () => {
  const bytes = new Uint8Array(encodeWav([buf(0, 0.5, -0.5)], 44100, { bitDepth: 24 }));
  const ascii = (from, length) =>
    String.fromCharCode(...bytes.slice(from, from + length));
  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(ascii(12, 4), "fmt ");
});

test("the wav header records the sample rate and channel count it was given", () => {
  const view = new DataView(
    encodeWav([buf(0, 0), buf(0, 0)], 48000, { bitDepth: 24 }),
  );
  assert.equal(view.getUint16(22, true), 2, "channel count");
  assert.equal(view.getUint32(24, true), 48000, "sample rate");
  assert.equal(view.getUint16(34, true), 24, "bit depth");
});

test("24 bit samples survive the round trip to within one step", () => {
  const values = [0, 0.5, -0.5, 0.999, -0.999, 0.1234567];
  const view = new DataView(
    encodeWav([Float32Array.from(values)], 44100, { bitDepth: 24, dither: false }),
  );
  const step = 1 / 8388608;
  for (let i = 0; i < values.length; i++) {
    const at = 44 + i * 3;
    let sample = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
    if (sample & 0x800000) sample |= ~0xffffff; // sign extend
    const back = sample / 8388608;
    assert.ok(
      Math.abs(back - values[i]) <= step,
      `${values[i]} came back as ${back}`,
    );
  }
});

test("float output uses format 3, because format 1 would mean integers", () => {
  const view = new DataView(encodeWav([buf(0, 0)], 44100, { bitDepth: 32 }));
  assert.equal(view.getUint16(20, true), 3, "IEEE float format code");
  assert.equal(view.getUint16(34, true), 32);
});

test("samples beyond full scale are clamped rather than wrapping", () => {
  /**
   * Wrapping is the difference between a click and a bang. An integer that
   * overflows flips sign, which is the loudest thing a file can contain.
   */
  const view = new DataView(
    encodeWav([buf(2.0, -2.0)], 44100, { bitDepth: 24, dither: false }),
  );
  const read = (i) => {
    const at = 44 + i * 3;
    let s = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
    if (s & 0x800000) s |= ~0xffffff;
    return s;
  };
  assert.equal(read(0), 8388607);
  assert.equal(read(1), -8388608);
});

test("dither changes the output, because that is the entire point", () => {
  const quiet = Float32Array.from({ length: 256 }, () => 0.5 / 8388608);
  const a = new Uint8Array(encodeWav([quiet], 44100, { bitDepth: 24, dither: true }));
  const b = new Uint8Array(encodeWav([quiet], 44100, { bitDepth: 24, dither: true }));
  assert.notDeepEqual(Array.from(a), Array.from(b), "dither produced identical files");
});

test("interleaving puts left and right in the right order", () => {
  const view = new DataView(
    encodeWav([buf(0.5, 0.5), buf(-0.5, -0.5)], 44100, { bitDepth: 32 }),
  );
  assert.ok(view.getFloat32(44, true) > 0, "first sample should be the left channel");
  assert.ok(view.getFloat32(48, true) < 0, "second sample should be the right channel");
});

test("a file that decodes within full scale needs no attenuation", () => {
  assert.equal(headroomGain(0.9), 1);
  assert.equal(headroomGain(1.0), 1);
});

test("a file that decodes above full scale is attenuated to fit", () => {
  /**
   * The bug that made this necessary. Lossy codecs reconstruct waveforms that
   * exceed the original peak, and resampling rings past it at transients, so
   * decoded audio routinely sits above 1.0. The output stage clamps, which is
   * audible as clipping, and no amount of care in the width matrix prevents it
   * because the matrix faithfully passes on what it was given.
   */
  assert.ok(Math.abs(headroomGain(1.19) - 1 / 1.19) < 1e-12);
  assert.ok(Math.abs(1.19 * headroomGain(1.19) - 1) < 1e-12);
});

test("headroom only ever attenuates, never boosts", () => {
  for (const p of [0, 0.01, 0.5, 0.99, 1, 1.5, 4]) {
    assert.ok(headroomGain(p) <= 1, `peak ${p} produced a gain above 1`);
  }
});

test("headroom on silence does not divide by zero", () => {
  assert.equal(headroomGain(0), 1);
});

test("width collapse cannot rescue a file that arrives over full scale", () => {
  /**
   * Worth pinning, because it is exactly the wrong assumption I made. The
   * matrix guarantees the output does not exceed the input peak. It says
   * nothing about that peak being within full scale.
   */
  const l = Float32Array.from([1.19, -1.19, 0.5]);
  const r = Float32Array.from([1.19, -1.19, 0.5]);
  const [outL] = applyWidth(l, r, 0);
  assert.ok(peak(outL) > 1, "still over full scale, as it must be");
  assert.ok(peak(outL) * headroomGain(peak(outL)) <= 1 + 1e-12);
});
