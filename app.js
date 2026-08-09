/**
 * Browser wiring. Deliberately thin: every decision about the audio itself
 * lives in audio.js, which is tested without a browser.
 *
 * Playback runs through a Web Audio graph so width changes are heard the
 * instant you drag the slider. Export does not use that graph at all. It runs
 * the same pure functions over the decoded buffer, which is less code and
 * shares the path the tests cover.
 */

import { applyWidth, correlation, encodeWav, headroomGain, normaliseGain, peak, widthGains } from "./audio.js";

const $ = (id) => document.getElementById(id);

const state = {
  ctx: null,
  buffer: null,
  name: "audio",
  source: null,
  playing: false,
  startedAt: 0,
  offset: 0,
  width: 1,
  bypassed: false,
  decodedPeak: 0,
  headroom: 1,
  trim: 0,
};

let nodes = null;

// ------------------------------------------------------------------ loading

function fail(message) {
  $("loaderr").textContent = message;
  $("loaderr").hidden = false;
}

/**
 * Sample rate straight out of a WAV header, or null for anything else.
 *
 * decodeAudioData resamples to whatever rate the audio device runs at, so a
 * 44100 file on a 48000 device comes back resampled and the export would carry
 * that with it. For WAV the rate is four bytes into a fixed header, so the
 * context can be built to match and nothing is resampled at all.
 *
 * For compressed formats there is no cheap way to know, so the page says which
 * rate it actually decoded at rather than implying the original survived.
 */
function nativeRate(bytes) {
  const view = new DataView(bytes);
  if (view.byteLength < 44) return null;
  const tag = (at) =>
    String.fromCharCode(view.getUint8(at), view.getUint8(at + 1),
                        view.getUint8(at + 2), view.getUint8(at + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  const rate = view.getUint32(24, true);
  return rate >= 8000 && rate <= 384000 ? rate : null;
}

async function load(file) {
  $("loaderr").hidden = true;
  try {
    const bytes = await file.arrayBuffer();
    const native = nativeRate(bytes.slice(0, 64));
    if (native && (!state.ctx || state.ctx.sampleRate !== native)) {
      if (state.ctx) await state.ctx.close();
      state.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: native });
      nodes = null;
    }
    state.ctx = state.ctx || new (window.AudioContext || window.webkitAudioContext)();
    state.buffer = await state.ctx.decodeAudioData(bytes);
  } catch (err) {
    fail(`Could not decode that file. Your browser has to be able to play it. (${err.message})`);
    return;
  }

  state.name = file.name.replace(/\.[^.]+$/, "");
  stop();

  const b = state.buffer;
  const resampled = nativeRate(await file.slice(0, 64).arrayBuffer()) === null;
  $("meta").textContent =
    `${file.name}, ${fmt(b.duration)}, ${b.sampleRate} Hz, ` +
    `${b.numberOfChannels === 1 ? "mono" : `${b.numberOfChannels} channels`}` +
    (resampled
      ? `. Your browser decoded it at ${b.sampleRate} Hz, which is this device's rate. If the file was recorded at something else it has been resampled, and the export will match what you hear.`
      : ".");

  state.decodedPeak = Math.max(peak(b.getChannelData(0)),
                               b.numberOfChannels > 1 ? peak(b.getChannelData(1)) : 0);
  state.headroom = headroomGain(state.decodedPeak);
  reportHeadroom();

  if (b.numberOfChannels < 2) {
    fail("That file is already mono, so there is nothing to collapse.");
    return;
  }

  buildGraph();
  $("work").hidden = false;
  updateStatic();
  requestAnimationFrame(meter);
}

/**
 * Decoded audio very often sits above full scale, and the output stage clamps
 * anything that does, which is audible as clipping. That is not something the
 * width matrix can prevent: it guarantees the output does not exceed the input
 * peak, which is no help when the input peak is 1.19.
 *
 * So it is attenuated to fit, and said out loud, because silently changing the
 * level of somebody's audio is worse than the clipping was.
 */
function reportHeadroom() {
  const dB = 20 * Math.log10(state.decodedPeak || 1);
  const over = state.decodedPeak > 1;
  $("peakvalue").textContent = `${dB > 0 ? "+" : ""}${dB.toFixed(2)} dBFS`;
  $("headroom").hidden = !over;
  if (over) {
    $("headroom").textContent =
      `This file decodes at +${dB.toFixed(2)} dBFS, above full scale. Lossy ` +
      `codecs overshoot and resampling rings past the peak, and your output ` +
      `would clamp it. Turned down by ${dB.toFixed(2)} dB so it does not.`;
  }
}

// -------------------------------------------------------------------- graph

/**
 * source -> splitter -> four gains -> merger -> analysers -> output
 *
 * The four gains are the 2x2 matrix. Changing width sets their values, which
 * is click free because gain is a k-rate parameter rather than a rebuild.
 */
function buildGraph() {
  const ctx = state.ctx;
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);

  const gains = {
    ll: ctx.createGain(), rl: ctx.createGain(),
    lr: ctx.createGain(), rr: ctx.createGain(),
  };

  splitter.connect(gains.ll, 0); gains.ll.connect(merger, 0, 0);
  splitter.connect(gains.rl, 1); gains.rl.connect(merger, 0, 0);
  splitter.connect(gains.lr, 0); gains.lr.connect(merger, 0, 1);
  splitter.connect(gains.rr, 1); gains.rr.connect(merger, 0, 1);

  // A second split purely so both channels can be metered independently.
  const tap = ctx.createChannelSplitter(2);
  const left = ctx.createAnalyser();
  const right = ctx.createAnalyser();
  left.fftSize = right.fftSize = 2048;
  const output = ctx.createGain();
  output.gain.value = state.headroom * Math.pow(10, state.trim / 20);
  merger.connect(output);
  output.connect(tap);
  tap.connect(left, 0);
  tap.connect(right, 1);
  output.connect(ctx.destination);

  nodes = { splitter, merger, output, gains, left, right,
            bufL: new Float32Array(left.fftSize), bufR: new Float32Array(right.fftSize) };
  setWidth(state.width, true);
  setTrim(state.trim);
}

function setWidth(width, immediate = false) {
  state.width = width;
  const { a, b } = widthGains(state.bypassed ? 1 : width);
  const at = state.ctx ? state.ctx.currentTime : 0;
  // Set outright when the graph is new. A gain node starts at 1, and ramping
  // towards the target leaves all four at 1 for the first few tens of
  // milliseconds, which is L + R rather than an average: a full sum, and it
  // clips on anything loud. Ramping is only wanted when dragging.
  for (const [node, target] of [[nodes.gains.ll, a], [nodes.gains.rr, a],
                                [nodes.gains.rl, b], [nodes.gains.lr, b]]) {
    if (immediate) {
      node.gain.cancelScheduledValues(at);
      node.gain.value = target;
    } else {
      node.gain.setTargetAtTime(target, at, 0.01);
    }
  }
  $("widthvalue").textContent = `${Math.round(width * 100)}%`;
}

function setTrim(db) {
  state.trim = db;
  const gain = Math.pow(10, db / 20);
  if (nodes) {
    nodes.output.gain.setTargetAtTime(state.headroom * gain, state.ctx.currentTime, 0.01);
  }
  $("trimvalue").textContent = `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

// ---------------------------------------------------------------- transport

function play() {
  const ctx = state.ctx;
  if (ctx.state === "suspended") ctx.resume();
  const source = ctx.createBufferSource();
  source.buffer = state.buffer;
  source.connect(nodes.splitter);
  source.onended = () => { if (state.source === source) stop(); };
  source.start(0, state.offset % state.buffer.duration);
  state.source = source;
  state.startedAt = ctx.currentTime;
  state.playing = true;
  $("play").textContent = "Pause";
}

function pause() {
  if (!state.source) return;
  state.offset += state.ctx.currentTime - state.startedAt;
  state.source.onended = null;
  state.source.stop();
  state.source = null;
  state.playing = false;
  $("play").textContent = "Play";
}

function stop() {
  if (state.source) {
    state.source.onended = null;
    state.source.stop();
    state.source = null;
  }
  state.offset = 0;
  state.playing = false;
  $("play").textContent = "Play";
}

function position() {
  if (!state.buffer) return 0;
  const at = state.playing ? state.offset + (state.ctx.currentTime - state.startedAt) : state.offset;
  return Math.min(at, state.buffer.duration);
}

// ----------------------------------------------------------------- metering

function updateStatic() {
  const b = state.buffer;
  const value = correlation(b.getChannelData(0), b.getChannelData(1));
  describe(value);
}

/**
 * The line that explains the whole tool. A hard panned record sits near zero,
 * and the needle walks towards +1 as you drag width down.
 */
function describe(value) {
  $("corrvalue").textContent = value.toFixed(2);
  $("corrneedle").style.left = `calc(${((value + 1) / 2) * 100}% - 1.5px)`;
  let says;
  if (value < -0.3) {
    says = "The channels are largely out of phase. Collapsing to full mono would cancel much of this.";
  } else if (value < 0.25) {
    says = "Barely anything is shared between the channels. This is the hard panned mix the tool is for.";
  } else if (value < 0.9) {
    says = "A normal stereo image.";
  } else {
    says = "Effectively mono already.";
  }
  $("corrsays").textContent = says;
}

function meter() {
  if (nodes && state.playing) {
    nodes.left.getFloatTimeDomainData(nodes.bufL);
    nodes.right.getFloatTimeDomainData(nodes.bufR);
    const l = peak(nodes.bufL);
    const r = peak(nodes.bufR);
    $("meterL").style.width = `${Math.min(1, l) * 100}%`;
    $("meterR").style.width = `${Math.min(1, r) * 100}%`;
    $("peaks").textContent = `L ${l.toFixed(2)}  R ${r.toFixed(2)}`;
    describe(correlation(nodes.bufL, nodes.bufR));
  }
  if (state.buffer) {
    const at = position();
    $("progress").style.width = `${(at / state.buffer.duration) * 100}%`;
    $("time").textContent = `${fmt(at)} / ${fmt(state.buffer.duration)}`;
  }
  requestAnimationFrame(meter);
}

const fmt = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

// ------------------------------------------------------------------- export

function save() {
  const b = state.buffer;
  let [left, right] = applyWidth(b.getChannelData(0), b.getChannelData(1), state.width);

  // The same attenuation the player uses, so the file matches what you heard.
  const outGain = state.headroom * Math.pow(10, state.trim / 20);
  if (outGain !== 1) {
    left = left.map((v) => v * outGain);
    right = right.map((v) => v * outGain);
  }

  if ($("normalise").checked) {
    const gain = normaliseGain(Math.max(peak(left), peak(right)), -1);
    left = left.map((v) => v * gain);
    right = right.map((v) => v * gain);
  }

  const bitDepth = Number(document.querySelector('input[name="depth"]:checked').value);
  const wav = encodeWav([left, right], b.sampleRate, { bitDepth });
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.name} (width ${Math.round(state.width * 100)}).wav`;
  link.click();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------------- events

$("pick").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => e.target.files[0] && load(e.target.files[0]));

const drop = $("drop");
for (const type of ["dragenter", "dragover"]) {
  drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add("over"); });
}
for (const type of ["dragleave", "drop"]) {
  drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove("over"); });
}
drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && load(e.dataTransfer.files[0]));

$("width").addEventListener("input", (e) => setWidth(Number(e.target.value)));
$("trim").addEventListener("input", (e) => setTrim(Number(e.target.value)));
$("play").addEventListener("click", () => (state.playing ? pause() : play()));
$("save").addEventListener("click", save);

// Held rather than toggled, so comparing is a gesture and you cannot leave it
// bypassed by accident and wonder why nothing is happening.
const bypass = $("bypass");
const setBypass = (on) => {
  state.bypassed = on;
  bypass.classList.toggle("held", on);
  setWidth(state.width);
};
for (const type of ["mousedown", "touchstart"]) {
  bypass.addEventListener(type, (e) => { e.preventDefault(); setBypass(true); });
}
for (const type of ["mouseup", "mouseleave", "touchend"]) {
  bypass.addEventListener(type, () => setBypass(false));
}

$("seek").addEventListener("click", (e) => {
  if (!state.buffer) return;
  const box = e.currentTarget.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
  const wasPlaying = state.playing;
  if (wasPlaying) pause();
  state.offset = fraction * state.buffer.duration;
  if (wasPlaying) play();
});
