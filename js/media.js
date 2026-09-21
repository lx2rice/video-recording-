// Capture: screen+audio where the browser allows it, microphone everywhere
// else, plus importing a file the OS recorder already produced (this is the
// iOS path — Safari has no getDisplayMedia).

export const canCaptureScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
export const canCaptureMic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

const VIDEO_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
];

const AUDIO_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
];

function pickMime(candidates) {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export class Recorder {
  constructor() {
    this.recorder = null;
    this.chunks = [];
    this.streams = [];
    this.audioContext = null;
    this.analyser = null;
    this.startedAt = 0;
    this.kind = null;
    this.onLevel = null;
    this.onTick = null;
    this._raf = 0;
    this._timer = 0;
  }

  get active() {
    return !!this.recorder && this.recorder.state !== 'inactive';
  }

  async startScreen({ withMic = true } = {}) {
    if (!canCaptureScreen) throw new Error('Screen capture is not available in this browser.');
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: true,
    });
    this.streams.push(display);

    let mic = null;
    if (withMic && canCaptureMic) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.streams.push(mic);
      } catch {
        mic = null; // permission denied — carry on with whatever the tab gave us
      }
    }

    const audioTracks = [...display.getAudioTracks(), ...(mic ? mic.getAudioTracks() : [])];
    const stream = new MediaStream([...display.getVideoTracks()]);
    let mixed = null;
    if (audioTracks.length === 1) {
      stream.addTrack(audioTracks[0]);
    } else if (audioTracks.length > 1) {
      mixed = this._mix(display, mic);
      mixed.getAudioTracks().forEach((t) => stream.addTrack(t));
    }

    // The user can stop sharing from the browser's own banner.
    display.getVideoTracks()[0].addEventListener('ended', () => {
      if (this.active) this.recorder.stop();
    });

    const hasAudio = stream.getAudioTracks().length > 0;
    this._begin(stream, pickMime(VIDEO_TYPES), 'screen');
    return { hasSystemAudio: display.getAudioTracks().length > 0, hasMic: !!mic, hasAudio };
  }

  async startMic() {
    if (!canCaptureMic) throw new Error('Microphone capture is not available in this browser.');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
    this.streams.push(stream);
    this._begin(stream, pickMime(AUDIO_TYPES), 'mic');
    return { hasAudio: true };
  }

  _mix(display, mic) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ctx.createMediaStreamDestination();
    for (const source of [display, mic]) {
      if (!source || source.getAudioTracks().length === 0) continue;
      const node = ctx.createMediaStreamSource(new MediaStream(source.getAudioTracks()));
      const gain = ctx.createGain();
      gain.gain.value = source === mic ? 0.8 : 1;
      node.connect(gain).connect(dest);
    }
    this.mixContext = ctx;
    return dest.stream;
  }

  _begin(stream, mimeType, kind) {
    this.chunks = [];
    this.kind = kind;
    this.mimeType = mimeType || '';
    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.recorder.start(1000);
    this.startedAt = Date.now();
    this._watchLevels(stream);
    this._timer = setInterval(() => {
      if (this.onTick) this.onTick(Date.now() - this.startedAt);
    }, 200);
  }

  _watchLevels(stream) {
    if (stream.getAudioTracks().length === 0) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      this.audioContext = ctx;
      const loop = () => {
        if (!this.active) return;
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
        if (this.onLevel) this.onLevel(peak);
        this._raf = requestAnimationFrame(loop);
      };
      loop();
    } catch (err) {
      console.warn('level meter unavailable', err);
    }
  }

  pause() {
    if (this.recorder && this.recorder.state === 'recording') this.recorder.pause();
  }

  resume() {
    if (this.recorder && this.recorder.state === 'paused') this.recorder.resume();
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.recorder) return reject(new Error('Not recording.'));
      const durationMs = Date.now() - this.startedAt;
      this.recorder.onstop = () => {
        const type = this.mimeType || (this.kind === 'mic' ? 'audio/webm' : 'video/webm');
        const blob = new Blob(this.chunks, { type: type.split(';')[0] });
        this._teardown();
        resolve({ blob, durationMs, kind: this.kind, mime: blob.type });
      };
      this.recorder.onerror = (e) => { this._teardown(); reject(e.error || e); };
      if (this.recorder.state === 'inactive') this.recorder.onstop();
      else this.recorder.stop();
    });
  }

  cancel() {
    try { if (this.active) this.recorder.stop(); } catch { /* already gone */ }
    this._teardown();
  }

  _teardown() {
    clearInterval(this._timer);
    cancelAnimationFrame(this._raf);
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this.streams = [];
    [this.audioContext, this.mixContext].forEach((ctx) => {
      if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
    });
    this.audioContext = null;
    this.mixContext = null;
    this.recorder = null;
  }
}

// --- still frames -----------------------------------------------------------

function loadVideo(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    const cleanup = () => URL.revokeObjectURL(url);
    video.onloadedmetadata = () => resolve({ video, cleanup });
    video.onerror = () => { cleanup(); reject(new Error('Could not read that video file.')); };
  });
}

function seek(video, time) {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = Math.max(0, time);
    // Some browsers never fire `seeked` on a zero-length seek.
    setTimeout(done, 1500);
  });
}

function draw(video, maxWidth) {
  const ratio = video.videoHeight ? video.videoHeight / video.videoWidth : 0.5625;
  const width = Math.min(maxWidth, video.videoWidth || maxWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width);
  canvas.height = Math.round(width * ratio);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** A single small frame used as the library thumbnail. */
export async function posterFor(blob) {
  if (!blob.type.startsWith('video/')) return null;
  try {
    const { video, cleanup } = await loadVideo(blob);
    await seek(video, Math.min(1, (video.duration || 2) / 2));
    const canvas = draw(video, 480);
    cleanup();
    return await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.7));
  } catch {
    return null;
  }
}

/** Evenly spaced JPEG keyframes (base64, no data-URL prefix) for vision models. */
export async function keyframes(blob, count = 6, maxWidth = 768) {
  if (!blob.type.startsWith('video/')) return [];
  const { video, cleanup } = await loadVideo(blob);
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const frames = [];
  try {
    for (let i = 0; i < count; i += 1) {
      const at = duration ? (duration * (i + 0.5)) / count : i;
      await seek(video, at);
      const canvas = draw(video, maxWidth);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
      frames.push({ at, base64: dataUrl.split(',')[1], mediaType: 'image/jpeg' });
    }
  } finally {
    cleanup();
  }
  return frames;
}

export function probeDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const el = document.createElement(blob.type.startsWith('audio/') ? 'audio' : 'video');
    el.preload = 'metadata';
    el.src = url;
    const finish = (value) => { URL.revokeObjectURL(url); resolve(value); };
    el.onloadedmetadata = () => {
      // Chrome reports Infinity for some streamed webm files until it seeks.
      if (el.duration === Infinity) {
        el.currentTime = 1e101;
        el.ontimeupdate = () => { el.ontimeupdate = null; finish((el.duration || 0) * 1000); };
      } else {
        finish((el.duration || 0) * 1000);
      }
    };
    el.onerror = () => finish(0);
    setTimeout(() => finish(0), 4000);
  });
}
