import { decodeToMono } from './audio.js';

// A dedicated worker keeps CPU inference off the interface thread. Pin the
// runtime version; multilingual quantized Whisper Tiny works without WebGPU.
const WORKER_SOURCE = `
self.onmessage = async ({data}) => {
  try {
    self.postMessage({type:'progress', text:'Loading the free speech engine… First use needs internet.'});
    const {pipeline, env} = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js');
    env.allowLocalModels = false;
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
    const pipe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
      quantized:true,
      progress_callback:p => {
        if (p.status === 'progress') self.postMessage({type:'progress', text:'Downloading speech model: ' + (p.file || '') + ' ' + Math.round(p.progress || 0) + '%'});
      }
    });
    self.postMessage({type:'progress', text:'Transcribing on this device… Keep ClipMind open. This may take several minutes.'});
    const options = {task:'transcribe', return_timestamps:true, chunk_length_s:30, stride_length_s:5,
      chunk_callback:() => self.postMessage({type:'progress',text:'Processing the next audio section… Keep ClipMind open.'})};
    if (data.language) options.language = data.language;
    const result = await pipe(data.samples, options);
    self.postMessage({type:'result', result});
  } catch (error) { self.postMessage({type:'error', message:error.message || String(error)}); }
};
`;

export async function transcribeLocally(blob, settings, {onProgress = () => {}, signal} = {}) {
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') throw new Error('Free transcription needs a browser with WebAssembly and workers. Try current Safari or Chrome.');
  if (blob.size > 100 * 1024 * 1024) throw new Error('For free phone transcription, trim this recording to under 100 MB and 10 minutes, then import the shorter clip.');
  signal?.throwIfAborted();
  onProgress('Reading the audio on this device…');
  let samples;
  try { ({samples} = await decodeToMono(blob)); }
  catch { throw new Error('This browser could not read the audio in this file. Try an MP4 screen recording with sound, or an M4A / WAV audio file. No audio was uploaded.'); }
  signal?.throwIfAborted();
  if (!samples.length) throw new Error('This recording contains no decodable audio.');
  if (samples.length > 16000 * 600) throw new Error('Free phone transcription currently supports clips up to 10 minutes. Trim this recording and import the shorter clip.');
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], {type:'text/javascript'}));
  return new Promise((resolve,reject) => {
    let worker, timer;
    const cleanup = () => { clearTimeout(timer); worker?.terminate(); URL.revokeObjectURL(url); signal?.removeEventListener('abort', abort); };
    const fail = error => { cleanup(); reject(error); };
    const abort = () => fail(new DOMException('Transcription cancelled. Your recording is saved.', 'AbortError'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, {once:true});
    try {
      worker = new Worker(url, {type:'module'});
      timer = setTimeout(() => fail(new Error('This device is taking too long. Try a shorter clip. Your recording is saved.')), 15*60*1000);
      worker.onerror = () => fail(new Error('The free engine could not start. Check your connection, keep this app open and try a shorter clip. No paid fallback was used.'));
      worker.onmessage = ({data}) => {
        if (data.type === 'progress') { onProgress(data.text); return; }
        if (data.type === 'error') { fail(new Error('Free transcription failed: ' + data.message + '. Try a shorter clip. No paid fallback was used.')); return; }
        if (data.type === 'result') {
          const text = (data.result.text || '').trim();
          const segments = (data.result.chunks || []).map(c => ({start:c.timestamp?.[0] || 0, end:c.timestamp?.[1] ?? samples.length/16000, text:(c.text || '').trim()}));
          cleanup(); resolve({text, segments, provider:'local:whisper-tiny', createdAt:Date.now()});
        }
      };
      worker.postMessage({samples, language:settings.language || ''});
    } catch (err) { fail(err); }
  });
}
