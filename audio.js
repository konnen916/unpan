/**
 * The arithmetic behind unpan. No browser APIs in here on purpose, so it can be
 * tested under Node and reasoned about without a tab open.
 *
 * Everything the tool does to audio is one 2x2 matrix. Mid/side says:
 *
 *     mid  = (L + R) / 2
 *     side = (L - R) / 2
 *     L'   = mid + w * side
 *     R'   = mid - w * side
 *
 * which expands to L' = a*L + b*R and R' = b*L + a*R with a = (1+w)/2 and
 * b = (1-w)/2. At w = 1 nothing changes. At w = 0 both channels become the
 * average, which is mono.
 */

/** Mid/side collapse expressed as the two coefficients of a 2x2 matrix. */
export function widthGains(width) {
  const w = Math.min(1, Math.max(0, width));
  return { a: (1 + w) / 2, b: (1 - w) / 2 };
}

/**
 * Collapse stereo width.
 *
 * Width is clamped to 0..1 rather than allowing values above 1, and that is
 * what makes clipping impossible rather than something to check for. With
 * a + b = 1 and both non negative, each output sample is a convex combination
 * of the two inputs, so it can never exceed the larger of them. Widening would
 * break that, which is why it is not offered.
 */
export function applyWidth(left, right, width) {
  const { a, b } = widthGains(width);
  const n = Math.min(left.length, right.length);
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    outL[i] = a * left[i] + b * right[i];
    outR[i] = b * left[i] + a * right[i];
  }
  return [outL, outR];
}

/**
 * Correlation between the channels, from -1 to +1.
 *
 * +1 means the channels are identical and the recording is already mono. 0
 * means they share nothing, which is what a hard panned record reads: one
 * instrument entirely left, another entirely right. -1 means one channel is
 * the other inverted, and summing them would cancel to silence.
 *
 * This is the number that explains the problem to somebody who has never
 * thought about it, which is why it is on screen rather than buried.
 */
export function correlation(left, right) {
  const n = Math.min(left.length, right.length);
  let sumLR = 0;
  let sumLL = 0;
  let sumRR = 0;
  for (let i = 0; i < n; i++) {
    sumLR += left[i] * right[i];
    sumLL += left[i] * left[i];
    sumRR += right[i] * right[i];
  }
  const denominator = Math.sqrt(sumLL * sumRR);
  // Silence, or one channel empty. Undefined rather than zero strictly
  // speaking, but reporting 0 is the honest reading: nothing is shared.
  if (denominator === 0) return 0;
  return Math.min(1, Math.max(-1, sumLR / denominator));
}

/** Largest magnitude in a channel. */
export function peak(channel) {
  let highest = 0;
  for (let i = 0; i < channel.length; i++) {
    const magnitude = Math.abs(channel[i]);
    if (magnitude > highest) highest = magnitude;
  }
  return highest;
}

/** The gain that moves a given peak to a target in dBFS. */
export function normaliseGain(currentPeak, targetDb = -1) {
  if (currentPeak === 0) return 1;
  return Math.pow(10, targetDb / 20) / currentPeak;
}

/**
 * Triangular probability density dither, one LSB peak to peak.
 *
 * Rounding float samples to integers without it turns the rounding error into
 * a signal correlated with the audio, which is audible on quiet passages as a
 * gritty distortion rather than as noise. Two uniform values summed give a
 * triangular distribution, which decorrelates the error properly.
 *
 * At 24 bits this is below anything anyone will ever hear. It is here because
 * it is correct, not because you will notice.
 */
function tpdf() {
  return Math.random() + Math.random() - 1;
}

/**
 * Write channels out as a WAV file.
 *
 * WAV rather than MP3 on purpose. Whatever came in has already been through
 * whatever encoder made it, and re-encoding would lose more. There is no
 * setting that adds quality that was never in the file, so the only honest
 * export is one that loses nothing further.
 *
 * bitDepth 32 writes IEEE floats, which is exactly what the browser decoded
 * and quantises nothing at all. bitDepth 24 writes integers with dither.
 */
export function encodeWav(channels, sampleRate, options = {}) {
  const bitDepth = options.bitDepth ?? 24;
  const dither = options.dither ?? true;
  if (bitDepth !== 24 && bitDepth !== 32) {
    throw new Error(`unsupported bit depth ${bitDepth}, use 24 or 32`);
  }

  const channelCount = channels.length;
  const frames = channels[0].length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channelCount * bytesPerSample;
  const dataBytes = frames * blockAlign;

  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  // 1 is integer PCM, 3 is IEEE float. Writing floats under format 1 is a
  // classic way to produce a file that plays as loud static.
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  const full = 8388608; // 2^23
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const sample = channels[channel][frame];
      if (bitDepth === 32) {
        view.setFloat32(offset, sample, true);
        offset += 4;
        continue;
      }
      let value = Math.round(sample * full + (dither ? tpdf() : 0));
      // Clamped, never wrapped. An integer that overflows flips sign, and a
      // sign flip at full scale is the loudest thing a file can hold.
      if (value > full - 1) value = full - 1;
      if (value < -full) value = -full;
      view.setUint8(offset, value & 0xff);
      view.setUint8(offset + 1, (value >> 8) & 0xff);
      view.setUint8(offset + 2, (value >> 16) & 0xff);
      offset += 3;
    }
  }
  return buffer;
}
