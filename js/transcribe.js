// Transcription. Two automatic routes: an upload to OpenAI's speech-to-text
// endpoint (accurate, timestamped, costs money) and the browser's own live
// recogniser (free, no timestamps, not on every browser). Pasting a transcript
// by hand is the third route — useful when the site you are watching already
// publishes one.

import { prepareForTranscription } from './audio.js';

const OPENAI_AUDIO_URL = 'https://api.openai.com/v1/audio/transcriptions';

function endpoint(settings) {
  return settings.proxyUrl
    ? `${settings.proxyUrl.replace(/\/$/, '')}/openai/v1/audio/transcriptions`
    : OPENAI_AUDIO_URL;
}

async function postChunk(chunk, settings, signal) {
  const model = settings.whisperModel || 'whisper-1';
  const verbose = model.startsWith('whisper');   // only whisper-1 returns segments
  const form = new FormData();
  form.append('file', chunk.blob, chunk.name);
  form.append('model', model);
  form.append('response_format', verbose ? 'verbose_json' : 'json');
  if (verbose) form.append('timestamp_granularities[]', 'segment');
  if (settings.language) form.append('language', settings.language);
  if (chunk.prompt) form.append('prompt', chunk.prompt);

  const headers = {};
  if (!settings.proxyUrl) headers.Authorization = `Bearer ${settings.openaiKey}`;

  const res = await fetch(endpoint(settings), { method: 'POST', headers, body: form, signal });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Transcription failed (${res.status}): ${trimError(detail)}`);
  }
  return res.json();
}

function trimError(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed.error?.message || parsed.message || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/** Upload-based transcription with timestamps, chunked for long recordings. */
export async function transcribeWithOpenAI(blob, settings, { onProgress = () => {}, signal } = {}) {
  if (!settings.proxyUrl && !settings.openaiKey) {
    throw new Error('Add an OpenAI API key in Settings to transcribe audio, or switch the transcriber to "Paste it myself".');
  }
  const chunks = await prepareForTranscription(blob, onProgress);
  const segments = [];
  const texts = [];
  let carry = '';

  for (let i = 0; i < chunks.length; i += 1) {
    onProgress(`Transcribing part ${i + 1} of ${chunks.length}…`);
    const result = await postChunk({ ...chunks[i], prompt: carry }, settings, signal);
    const text = (result.text || '').trim();
    texts.push(text);
    carry = text.slice(-400);   // context so names stay consistent across cuts
    for (const seg of result.segments || []) {
      segments.push({
        start: (seg.start || 0) + chunks[i].offset,
        end: (seg.end || 0) + chunks[i].offset,
        text: (seg.text || '').trim(),
      });
    }
  }

  return {
    text: texts.join('\n\n').trim(),
    segments,
    provider: `openai:${settings.whisperModel || 'whisper-1'}`,
    createdAt: Date.now(),
  };
}

// --- live, on-device recognition -------------------------------------------

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canRecogniseLive = !!SpeechRecognition;

/**
 * Runs alongside a recording and accumulates finalised phrases. Timestamps are
 * taken from the wall clock, which is close enough to seek by.
 */
export class LiveTranscriber {
  constructor({ language = '', onUpdate = () => {} } = {}) {
    if (!SpeechRecognition) throw new Error('Live transcription is not supported in this browser.');
    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    if (language) this.recognition.lang = language;
    this.segments = [];
    this.interim = '';
    this.onUpdate = onUpdate;
    this.startedAt = 0;
    this.stopped = false;

    this.recognition.onresult = (event) => {
      this.interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = (result[0] && result[0].transcript ? result[0].transcript : '').trim();
        if (!text) continue;
        if (result.isFinal) {
          const start = (Date.now() - this.startedAt) / 1000;
          this.segments.push({ start: Math.max(0, start - text.length / 15), end: start, text });
        } else {
          this.interim += `${text} `;
        }
      }
      this.onUpdate(this.text(), this.interim.trim());
    };
    // Mobile browsers stop the recogniser every few seconds; restart until told not to.
    this.recognition.onend = () => { if (!this.stopped) { try { this.recognition.start(); } catch { /* racing restart */ } } };
    this.recognition.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.stop();
    };
  }

  start() {
    this.startedAt = Date.now();
    this.stopped = false;
    this.recognition.start();
  }

  stop() {
    this.stopped = true;
    try { this.recognition.stop(); } catch { /* already stopped */ }
  }

  text() {
    return this.segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
  }

  result() {
    return {
      text: this.text(),
      segments: this.segments.slice(),
      provider: 'browser-speech',
      createdAt: Date.now(),
    };
  }
}

/** Split a pasted transcript, keeping `[00:12]` / `00:12:30` style timestamps. */
export function parsePasted(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const segments = [];
  const stamp = /^\[?(\d{1,2}:)?(\d{1,2}):(\d{2})]?\s*[-–—:]?\s*/;
  for (const line of lines) {
    const match = line.match(stamp);
    if (match) {
      const h = match[1] ? parseInt(match[1], 10) : 0;
      const m = parseInt(match[2], 10);
      const s = parseInt(match[3], 10);
      segments.push({ start: h * 3600 + m * 60 + s, end: 0, text: line.replace(stamp, '').trim() });
    } else {
      segments.push({ start: 0, end: 0, text: line });
    }
  }
  return {
    text: text.trim(),
    segments: segments.some((s) => s.start > 0) ? segments : [],
    provider: 'pasted',
    createdAt: Date.now(),
  };
}
