// Speech-to-text endpoints cap uploads (25 MB on OpenAI) and refuse most video
// containers, so before transcribing we pull the audio out, downmix it to
// 16 kHz mono WAV — the rate Whisper works at anyway — and cut it into pieces
// that fit under the cap.

export const TARGET_RATE = 16000;
export const MAX_CHUNK_BYTES = 20 * 1024 * 1024;   // headroom under the 25 MB cap
export const MAX_CHUNK_SECONDS = 600;              // ~19 MB at 16 kHz mono 16-bit

function audioContext() {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('This browser cannot decode audio.');
  return Ctx;
}

/** Decode any container the browser understands into mono Float32 at 16 kHz. */
export async function decodeToMono(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('This browser cannot decode audio.');
  const bytes = await blob.arrayBuffer();
  const ctx = new Ctx();
  let decoded;
  try {
    decoded = await new Promise((resolve, reject) => {
      // Safari still only supports the callback form reliably.
      const maybe = ctx.decodeAudioData(bytes, resolve, reject);
      if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
    });
  } finally {
    ctx.close().catch(() => {});
  }

  const mono = downmix(decoded);
  if (decoded.sampleRate === TARGET_RATE) return { samples: mono, sampleRate: TARGET_RATE };
  return { samples: await resample(mono, decoded.sampleRate, TARGET_RATE), sampleRate: TARGET_RATE };
}

function downmix(buffer) {
  const { numberOfChannels, length } = buffer;
  if (numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(length);
  for (let c = 0; c < numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) out[i] += data[i] / numberOfChannels;
  }
  return out;
}

async function resample(samples, fromRate, toRate) {
  const Offline = audioContext();
  const frames = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const offline = new Offline(1, frames, toRate);
  const source = offline.createBufferSource();
  const buffer = offline.createBuffer(1, samples.length, fromRate);
  buffer.copyToChannel(samples, 0);
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

/** 16-bit PCM WAV — the most widely accepted upload format. */
export function encodeWav(samples, sampleRate = TARGET_RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Split into upload-sized pieces, cutting at the quietest point near each
 * boundary so a chunk rarely ends mid-word.
 */
export function splitChunks(samples, sampleRate = TARGET_RATE) {
  const maxSamples = Math.min(
    MAX_CHUNK_SECONDS * sampleRate,
    Math.floor((MAX_CHUNK_BYTES - 44) / 2),
  );
  if (samples.length <= maxSamples) {
    return [{ samples, offset: 0 }];
  }
  const chunks = [];
  let start = 0;
  while (start < samples.length) {
    let end = Math.min(start + maxSamples, samples.length);
    if (end < samples.length) end = quietestNear(samples, end, Math.floor(sampleRate * 2));
    chunks.push({ samples: samples.subarray(start, end), offset: start / sampleRate });
    start = end;
  }
  return chunks;
}

function quietestNear(samples, target, radius) {
  const from = Math.max(0, target - radius);
  const to = Math.min(samples.length - 1, target + radius);
  const window = 400;
  let best = target;
  let bestEnergy = Infinity;
  for (let i = from; i < to; i += window) {
    let energy = 0;
    for (let j = i; j < Math.min(i + window, to); j += 1) energy += Math.abs(samples[j]);
    if (energy < bestEnergy) { bestEnergy = energy; best = i; }
  }
  return best;
}

/**
 * Turn a recording or imported file into upload-ready audio pieces. Falls back
 * to the original blob when decoding fails but the file is already small and
 * audio-only (e.g. an m4a from a phone).
 */
export async function prepareForTranscription(blob, onProgress = () => {}) {
  const smallAudio = blob.type.startsWith('audio/') && blob.size <= MAX_CHUNK_BYTES;
  try {
    onProgress('Extracting audio…');
    const { samples, sampleRate } = await decodeToMono(blob);
    const pieces = splitChunks(samples, sampleRate);
    return pieces.map((piece, index) => ({
      blob: encodeWav(piece.samples, sampleRate),
      offset: piece.offset,
      name: `part-${index + 1}.wav`,
    }));
  } catch (err) {
    if (smallAudio) {
      return [{ blob, offset: 0, name: `audio.${(blob.type.split('/')[1] || 'webm').split(';')[0]}` }];
    }
    throw new Error(`Could not extract audio from this file (${err.message}).`);
  }
}
