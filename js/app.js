// App controller: wires the views together, owns the recording lifecycle and
// drives transcription and the model calls.

import * as store from './store.js';
import { Recorder, canCaptureScreen, canCaptureMic, posterFor, keyframes, probeDuration } from './media.js';
import { transcribeWithOpenAI, LiveTranscriber, canRecogniseLive, parsePasted } from './transcribe.js';
import { streamChat, checkCredentials, describeModel, activeProvider, missingCredentials, ANTHROPIC_MODELS, OPENAI_MODELS } from './ai.js';
import { ACTIONS, actionById, buildPrompt, systemPrompt, SUGGEST_PROMPT, parseSuggestions } from './prompts.js';
import { renderMarkdown } from './md.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  view: 'record',
  settings: store.loadSettings(),
  sessions: [],
  current: null,          // the open session object
  mediaUrl: null,
  recorder: new Recorder(),
  live: null,
  pendingAction: null,
  suggestions: [],
  busy: false,
};

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// ── helpers ────────────────────────────────────────────────────────────────

function fmtDuration(ms) {
  const total = Math.round((ms || 0) / 1000);
  const m = Math.floor(total / 60);
  const h = Math.floor(m / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m % 60)}:${pad(total % 60)}` : `${m}:${pad(total % 60)}`;
}

function fmtBytes(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? `Today ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

let toastTimer = 0;
function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 6500 : 3200);
}

function setStatus(text, kind = '') {
  const el = $('#transcript-status');
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = kind === 'error' ? '' : '<span class="spinner"></span>';
  el.append(document.createTextNode(text));
}

// ── routing ────────────────────────────────────────────────────────────────

const TITLES = { record: 'Record', library: 'Library', session: 'Session', settings: 'Settings' };

function go(view) {
  state.view = view;
  $$('.view').forEach((el) => { el.hidden = el.dataset.view !== view; });
  $$('.tab').forEach((el) => el.classList.toggle('active', el.dataset.goto === view));
  $('#view-title').textContent = TITLES[view] || 'ClipMind';
  window.scrollTo(0, 0);
  if (view === 'library') renderLibrary();
  if (view === 'settings') renderStorageNote();
}

// ── record view ────────────────────────────────────────────────────────────

function initRecordView() {
  const screenBtn = $('.mode[data-mode="screen"]');
  if (!canCaptureScreen) {
    screenBtn.disabled = true;
    $('#mode-screen-note').textContent = isIOS
      ? 'Not possible in Safari — use Import below'
      : 'Not supported in this browser';
  }
  if (!canCaptureMic) $('.mode[data-mode="mic"]').disabled = true;
  if (isIOS) {
    $('#mode-import-note').textContent = 'Screen Recording from Control Centre, or any clip in Photos';
  }

  if (isIOS) $('#ios-guide').hidden = false;

  $('#record-tip').innerHTML = isIOS
    ? 'On iPhone: start <strong>Screen Recording</strong> from Control Centre, watch your video, stop, then come back and tap <strong>Import a recording</strong>.'
    : 'Recording the screen also captures a browser tab\'s sound if you tick "share tab audio" in the picker.';

  $$('.mode').forEach((btn) => btn.addEventListener('click', () => onMode(btn.dataset.mode)));
  $('#btn-stop').addEventListener('click', stopRecording);
  $('#btn-discard').addEventListener('click', discardRecording);
  $('#btn-pause').addEventListener('click', togglePause);
  $('#file-input').addEventListener('change', onImport);

  state.recorder.onTick = (ms) => { $('#timer').textContent = fmtDuration(ms); };
  state.recorder.onLevel = (level) => {
    const scale = 1 + Math.min(level * 1.6, 0.85);
    $('#pulse-fill').style.transform = `scale(${scale.toFixed(3)})`;
  };
}

async function onMode(mode) {
  if (mode === 'import') { $('#file-input').click(); return; }
  try {
    const info = mode === 'screen'
      ? await state.recorder.startScreen({ withMic: state.settings.micWithScreen })
      : await state.recorder.startMic();

    document.body.classList.add('is-recording');
    $('#modes').hidden = true;
    $('#recording-controls').hidden = false;
    $('#btn-pause').textContent = 'Pause';
    $('#timer').textContent = '0:00';

    if (mode === 'screen' && !info.hasAudio) {
      $('#stage-hint').textContent = 'Recording — but no audio track was shared, so there will be nothing to transcribe.';
    } else if (mode === 'screen' && !info.hasSystemAudio) {
      $('#stage-hint').textContent = 'Recording. Only the microphone is being captured — tick "share tab audio" next time for cleaner sound.';
    } else {
      $('#stage-hint').textContent = mode === 'mic'
        ? 'Listening. Keep the phone near the speaker and leave this screen open.'
        : 'Recording the screen and its sound.';
    }

    startLiveTranscript();
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then((lock) => { state.wakeLock = lock; }).catch(() => {});
    }
  } catch (err) {
    if (err && err.name === 'NotAllowedError') toast('Permission denied — nothing was recorded.', 'error');
    else toast(err.message || String(err), 'error');
  }
}

function startLiveTranscript() {
  if (state.settings.transcriber !== 'webspeech' || !canRecogniseLive) return;
  try {
    state.live = new LiveTranscriber({
      language: state.settings.language,
      onUpdate: (text, interim) => {
        $('#live-transcript').hidden = false;
        $('#live-text').textContent = `${text} ${interim}`.trim() || 'Listening…';
      },
    });
    state.live.start();
    $('#live-transcript').hidden = false;
    $('#live-text').textContent = 'Listening…';
  } catch (err) {
    console.warn(err);
  }
}

function togglePause() {
  const rec = state.recorder.recorder;
  if (!rec) return;
  if (rec.state === 'recording') { state.recorder.pause(); $('#btn-pause').textContent = 'Resume'; }
  else { state.recorder.resume(); $('#btn-pause').textContent = 'Pause'; }
}

function resetRecordView() {
  document.body.classList.remove('is-recording');
  $('#modes').hidden = false;
  $('#recording-controls').hidden = true;
  $('#live-transcript').hidden = true;
  $('#live-text').textContent = '';
  $('#timer').textContent = '0:00';
  $('#pulse-fill').style.transform = 'scale(1)';
  $('#stage-hint').textContent = 'Pick how you want to capture this one.';
  if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
}

function discardRecording() {
  state.recorder.cancel();
  if (state.live) { state.live.stop(); state.live = null; }
  resetRecordView();
  toast('Discarded.');
}

async function stopRecording() {
  $('#btn-stop').disabled = true;
  try {
    const { blob, durationMs, kind, mime } = await state.recorder.stop();
    const liveResult = state.live && state.live.segments.length ? state.live.result() : null;
    if (state.live) { state.live.stop(); state.live = null; }
    resetRecordView();

    if (!blob.size) { toast('That recording came out empty.', 'error'); return; }
    const session = await saveRecording({ blob, durationMs, kind, mime, transcript: liveResult });
    await openSession(session.id);
    if (!liveResult && state.settings.autoTranscribe && state.settings.transcriber === 'openai') {
      runTranscription();
    }
  } catch (err) {
    toast(err.message || String(err), 'error');
  } finally {
    $('#btn-stop').disabled = false;
  }
}

async function onImport(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  toast('Importing…');
  try {
    const durationMs = await probeDuration(file);
    const session = await saveRecording({
      blob: file,
      durationMs,
      kind: 'import',
      mime: file.type || 'video/mp4',
      title: file.name.replace(/\.[^.]+$/, ''),
    });
    await openSession(session.id);
    if (state.settings.autoTranscribe && state.settings.transcriber === 'openai') runTranscription();
  } catch (err) {
    toast(err.message || String(err), 'error');
  }
}

async function saveRecording({ blob, durationMs, kind, mime, title, transcript = null }) {
  const id = store.newId();
  const poster = await posterFor(blob);
  const session = {
    id,
    title: title || defaultTitle(kind),
    createdAt: Date.now(),
    durationMs,
    kind,
    mime: mime || blob.type,
    size: blob.size,
    transcript,
    notes: '',
    threads: [],
  };
  await store.putMedia(id, blob, poster);
  await store.putSession(session);
  state.sessions.unshift(session);
  return session;
}

function defaultTitle(kind) {
  const when = new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const label = kind === 'mic' ? 'Listened' : kind === 'import' ? 'Imported' : 'Screen';
  return `${label} · ${when}`;
}

// ── library ────────────────────────────────────────────────────────────────

async function renderLibrary() {
  state.sessions = await store.listSessions();
  const list = $('#library-list');
  list.innerHTML = '';
  $('#library-empty').hidden = state.sessions.length > 0;

  for (const session of state.sessions) {
    const card = document.createElement('button');
    card.className = 'card';
    card.innerHTML = `
      <div class="thumb"></div>
      <div>
        <h4></h4>
        <div class="sub">
          <span>${fmtDate(session.createdAt)}</span>
          <span>${fmtDuration(session.durationMs)}</span>
          <span>${fmtBytes(session.size)}</span>
        </div>
        <div class="sub" style="margin-top:6px"></div>
      </div>`;
    card.querySelector('h4').textContent = session.title;

    const badges = card.querySelectorAll('.sub')[1];
    const t = document.createElement('span');
    t.className = `badge ${session.transcript ? 'ok' : 'warn'}`;
    t.textContent = session.transcript ? 'Transcribed' : 'No transcript';
    badges.append(t);
    if (session.threads?.length) {
      const a = document.createElement('span');
      a.className = 'badge';
      a.textContent = `${session.threads.length} answer${session.threads.length > 1 ? 's' : ''}`;
      badges.append(a);
    }

    const thumb = card.querySelector('.thumb');
    thumb.textContent = session.kind === 'mic' ? '🎙️' : '🎬';
    store.getMedia(session.id).then((media) => {
      if (media && media.poster) {
        thumb.textContent = '';
        thumb.style.backgroundImage = `url(${URL.createObjectURL(media.poster)})`;
      }
    });

    card.addEventListener('click', () => openSession(session.id));
    list.append(card);
  }
}

// ── session view ───────────────────────────────────────────────────────────

async function openSession(id) {
  const session = await store.getSession(id);
  if (!session) { toast('That recording is gone.', 'error'); go('library'); return; }
  state.current = session;
  state.pendingAction = null;
  state.suggestions = [];
  go('session');
  $('#view-title').textContent = 'Session';
  $('#session-title').value = session.title;
  renderMeta();
  renderTranscript();
  renderActions();
  renderThreads();
  setStatus('');
  await mountPlayer(session);
}

async function mountPlayer(session) {
  const wrap = $('#player-wrap');
  wrap.innerHTML = '';
  if (state.mediaUrl) { URL.revokeObjectURL(state.mediaUrl); state.mediaUrl = null; }
  const media = await store.getMedia(session.id);
  if (!media) { wrap.innerHTML = '<p class="muted" style="padding:14px">Media missing.</p>'; return; }
  state.mediaUrl = URL.createObjectURL(media.blob);
  const el = document.createElement(session.mime.startsWith('audio/') ? 'audio' : 'video');
  el.src = state.mediaUrl;
  el.controls = true;
  el.playsInline = true;
  el.preload = 'metadata';
  el.id = 'player';
  wrap.append(el);
}

function renderMeta() {
  const s = state.current;
  const bits = [
    fmtDate(s.createdAt),
    fmtDuration(s.durationMs),
    fmtBytes(s.size),
    s.kind === 'mic' ? 'Audio only' : s.kind === 'import' ? 'Imported' : 'Screen capture',
  ];
  const row = $('#session-meta');
  row.innerHTML = '';
  row.append(document.createTextNode(bits.join(' · ')));
  const del = document.createElement('button');
  del.className = 'ghost small';
  del.textContent = 'Delete';
  del.style.marginLeft = 'auto';
  del.addEventListener('click', deleteCurrent);
  row.append(del);
}

async function deleteCurrent() {
  if (!confirm('Delete this recording, its transcript and every answer?')) return;
  await store.deleteSession(state.current.id);
  state.current = null;
  toast('Deleted.');
  go('library');
}

function renderTranscript() {
  const body = $('#transcript-body');
  const t = state.current.transcript;
  body.innerHTML = '';
  if (!t || !t.text) {
    body.className = 'transcript empty-state';
    body.textContent = state.settings.transcriber === 'manual'
      ? 'No transcript yet — tap Paste to add one.'
      : 'No transcript yet — tap Transcribe.';
    return;
  }
  body.className = 'transcript';
  if (t.segments && t.segments.length) {
    for (const seg of t.segments) {
      const line = document.createElement('div');
      line.className = 'tline';
      const jump = document.createElement('button');
      jump.textContent = fmtDuration(seg.start * 1000);
      jump.addEventListener('click', () => {
        const player = $('#player');
        if (player) { player.currentTime = seg.start; player.play().catch(() => {}); }
      });
      const text = document.createElement('span');
      text.textContent = seg.text;
      line.append(jump, text);
      body.append(line);
    }
  } else {
    const p = document.createElement('p');
    p.textContent = t.text;
    body.append(p);
  }
}

function renderActions() {
  const chips = $('#action-chips');
  chips.innerHTML = '';
  const all = [
    ...ACTIONS.map((a) => ({ ...a, kind: 'preset' })),
    ...state.suggestions.map((text) => ({ id: `suggest:${text}`, icon: '✨', label: text, kind: 'suggested' })),
  ];
  for (const action of all) {
    const chip = document.createElement('button');
    chip.className = `chip ${action.kind === 'suggested' ? 'suggested' : ''}`;
    chip.innerHTML = `<span>${action.icon}</span>`;
    chip.append(document.createTextNode(action.label));
    chip.title = action.hint || '';
    chip.addEventListener('click', () => chooseAction(action));
    chips.append(chip);
  }
  $('#model-note').textContent =
    `Answers come from ${activeProvider(state.settings) === 'openai' ? 'OpenAI' : 'Claude'} · ${describeModel(state.settings)}`;
  $('#chk-frames').checked = !!state.settings.includeFrames;
  $('#chk-frames').disabled = state.current.mime.startsWith('audio/');
}

function chooseAction(action) {
  if (action.kind === 'suggested') {
    runAction({ id: 'ask', label: action.label, prompt: action.label }, '');
    return;
  }
  const preset = actionById(action.id);
  $$('#action-chips .chip').forEach((c) => c.classList.remove('selected'));
  if (!preset.inputLabel) { runAction(preset, ''); return; }

  state.pendingAction = preset;
  const box = $('#action-input');
  box.hidden = false;
  $('#action-input-label').textContent = preset.inputLabel;
  const field = $('#action-input-field');
  field.placeholder = preset.inputPlaceholder || '';
  field.value = '';
  field.focus();
}

async function collectImages() {
  if (!$('#chk-frames').checked) return [];
  const media = await store.getMedia(state.current.id);
  if (!media || !media.blob.type.startsWith('video/')) return [];
  setStatus('Grabbing frames…');
  try {
    return await keyframes(media.blob, Number(state.settings.frameCount) || 6);
  } finally {
    setStatus('');
  }
}

async function runAction(action, input) {
  if (state.busy) { toast('One request at a time.'); return; }
  const problem = missingCredentials(state.settings);
  if (problem) { toast(problem, 'error'); go('settings'); return; }
  if (!state.current.transcript || !state.current.transcript.text) {
    if (!confirm('There is no transcript yet, so the model will only see the still frames (if enabled) and the title. Carry on?')) return;
  }

  $('#action-input').hidden = true;
  state.pendingAction = null;

  const prompt = buildPrompt(action, input);
  const images = await collectImages();
  const thread = {
    id: store.newId(),
    action: action.id,
    title: action.label,
    createdAt: Date.now(),
    model: describeModel(state.settings),
    provider: activeProvider(state.settings),
    frames: images.length,
    messages: [{ role: 'user', content: prompt, ts: Date.now() }],
  };
  state.current.threads.unshift(thread);
  renderThreads();
  await send(thread, images);
}

async function send(thread, images = []) {
  state.busy = true;
  const target = document.querySelector(`[data-thread="${thread.id}"] .streaming .body`);
  let acc = '';
  try {
    const text = await streamChat(state.settings, {
      system: systemPrompt(state.current, { hasFrames: images.length > 0 }),
      messages: thread.messages.map(({ role, content }) => ({ role, content })),
      images,
      onDelta: (chunk) => {
        acc += chunk;
        if (target) {
          target.innerHTML = renderMarkdown(acc);
          target.classList.add('cursor');
        }
      },
    });
    thread.messages.push({ role: 'assistant', content: text, ts: Date.now() });
    await store.putSession(state.current);
  } catch (err) {
    thread.messages.push({
      role: 'assistant',
      content: acc ? `${acc}\n\n---\n\n**Interrupted:** ${err.message}` : `**That didn't work.** ${err.message}`,
      ts: Date.now(),
      failed: true,
    });
    await store.putSession(state.current);
    toast(err.message || String(err), 'error');
  } finally {
    state.busy = false;
    renderThreads();
  }
}

function renderThreads() {
  const host = $('#threads');
  host.innerHTML = '';
  for (const thread of state.current.threads) {
    const el = document.createElement('div');
    el.className = 'thread';
    el.dataset.thread = thread.id;

    const head = document.createElement('div');
    head.className = 'thread-head';
    const label = document.createElement('div');
    label.innerHTML = '<strong></strong><div class="sub"></div>';
    label.querySelector('strong').textContent = thread.title;
    label.querySelector('.sub').textContent =
      `${thread.model}${thread.frames ? ` · ${thread.frames} frames` : ''} · ${fmtDate(thread.createdAt)}`;
    const tools = document.createElement('div');
    tools.className = 'panel-actions';
    const copy = document.createElement('button');
    copy.className = 'ghost small';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => copyText(lastAnswer(thread)));
    const share = document.createElement('button');
    share.className = 'ghost small';
    share.textContent = 'Share';
    share.hidden = !navigator.share;
    share.addEventListener('click', () => {
      navigator.share({ title: `${state.current.title} — ${thread.title}`, text: lastAnswer(thread) }).catch(() => {});
    });
    const drop = document.createElement('button');
    drop.className = 'ghost small';
    drop.textContent = '✕';
    drop.addEventListener('click', async () => {
      state.current.threads = state.current.threads.filter((t) => t.id !== thread.id);
      await store.putSession(state.current);
      renderThreads();
    });
    tools.append(copy, share, drop);
    head.append(label, tools);

    const body = document.createElement('div');
    body.className = 'thread-body';
    for (const msg of thread.messages) {
      const row = document.createElement('div');
      row.className = 'msg';
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = msg.role === 'user' ? 'You' : thread.provider === 'openai' ? 'ChatGPT' : 'Claude';
      const content = document.createElement('div');
      content.className = 'body';
      content.innerHTML = renderMarkdown(msg.content);
      row.append(who, content);
      body.append(row);
    }

    const awaiting = thread.messages[thread.messages.length - 1]?.role === 'user';
    if (awaiting) {
      const row = document.createElement('div');
      row.className = 'msg streaming';
      row.innerHTML = '<div class="who">Thinking…</div><div class="body cursor"></div>';
      body.append(row);
    }

    const foot = document.createElement('div');
    foot.className = 'thread-foot';
    const input = document.createElement('input');
    input.placeholder = 'Follow-up question…';
    const ask = document.createElement('button');
    ask.className = 'primary small';
    ask.textContent = 'Ask';
    const submit = async () => {
      const text = input.value.trim();
      if (!text || state.busy) return;
      input.value = '';
      thread.messages.push({ role: 'user', content: text, ts: Date.now() });
      renderThreads();
      await send(thread);
    };
    ask.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    foot.append(input, ask);

    el.append(head, body);
    if (!awaiting) el.append(foot);
    host.append(el);
  }
}

function lastAnswer(thread) {
  for (let i = thread.messages.length - 1; i >= 0; i -= 1) {
    if (thread.messages[i].role === 'assistant') return thread.messages[i].content;
  }
  return '';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.');
  } catch {
    toast('Could not copy — select the text instead.', 'error');
  }
}

// ── transcription ──────────────────────────────────────────────────────────

async function runTranscription() {
  const session = state.current;
  if (!session) return;
  if (state.settings.transcriber === 'manual') { pasteTranscript(); return; }
  if (state.settings.transcriber === 'webspeech') {
    toast('Live transcription only runs while recording. Switch the transcriber to Whisper to transcribe an existing file.', 'error');
    return;
  }
  const media = await store.getMedia(session.id);
  if (!media) { toast('Media missing.', 'error'); return; }

  $('#btn-transcribe').disabled = true;
  try {
    const transcript = await transcribeWithOpenAI(media.blob, state.settings, {
      onProgress: (msg) => setStatus(msg),
    });
    if (!transcript.text) throw new Error('Nothing recognisable in the audio.');
    session.transcript = transcript;
    await store.putSession(session);
    setStatus('');
    renderTranscript();
    toast('Transcript ready — pick what to do with it.');
  } catch (err) {
    setStatus(err.message, 'error');
    toast(err.message || String(err), 'error');
  } finally {
    $('#btn-transcribe').disabled = false;
  }
}

async function pasteTranscript() {
  const existing = state.current.transcript?.text || '';
  const text = prompt('Paste the transcript (timestamps like [01:23] are kept):', existing);
  if (text === null) return;
  state.current.transcript = text.trim() ? parsePasted(text) : null;
  await store.putSession(state.current);
  renderTranscript();
  toast(text.trim() ? 'Transcript saved.' : 'Transcript cleared.');
}

async function suggestActions() {
  if (!state.current.transcript?.text) { toast('Transcribe it first so I know what is in it.', 'error'); return; }
  const problem = missingCredentials(state.settings);
  if (problem) { toast(problem, 'error'); return; }
  $('#btn-suggest').disabled = true;
  setStatus('Reading the transcript…');
  try {
    const text = await streamChat(state.settings, {
      system: systemPrompt(state.current),
      messages: [{ role: 'user', content: SUGGEST_PROMPT }],
    });
    state.suggestions = parseSuggestions(text);
    renderActions();
    if (!state.suggestions.length) toast('No suggestions came back.');
  } catch (err) {
    toast(err.message || String(err), 'error');
  } finally {
    $('#btn-suggest').disabled = false;
    setStatus('');
  }
}

// ── settings ───────────────────────────────────────────────────────────────

const BINDINGS = [
  ['#set-provider', 'provider', 'value'],
  ['#set-anthropic-key', 'anthropicKey', 'value'],
  ['#set-anthropic-model', 'anthropicModel', 'value'],
  ['#set-effort', 'effort', 'value'],
  ['#set-fallbacks', 'useFallbacks', 'checked'],
  ['#set-openai-key', 'openaiKey', 'value'],
  ['#set-openai-model', 'openaiModel', 'value'],
  ['#set-transcriber', 'transcriber', 'value'],
  ['#set-openai-key2', 'openaiKey', 'value'],
  ['#set-whisper-model', 'whisperModel', 'value'],
  ['#set-language', 'language', 'value'],
  ['#set-auto-transcribe', 'autoTranscribe', 'checked'],
  ['#set-mic-with-screen', 'micWithScreen', 'checked'],
  ['#set-frame-count', 'frameCount', 'value'],
  ['#set-proxy', 'proxyUrl', 'value'],
];

function initSettings() {
  fillDatalist('#anthropic-models', ANTHROPIC_MODELS);
  fillDatalist('#openai-models', OPENAI_MODELS);

  for (const [sel, key, prop] of BINDINGS) {
    const el = $(sel);
    el[prop] = state.settings[key];
    el.addEventListener('change', () => {
      state.settings[key] = prop === 'checked' ? el.checked : el.value.trim();
      store.saveSettings(state.settings);
      syncSettingsUi();
      renderSetupPrompt();
      if (state.current) renderActions();
    });
  }

  $$('[data-paste]').forEach((btn) => btn.addEventListener('click', async () => {
    const field = $(btn.dataset.paste);
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) { toast('Clipboard is empty.'); return; }
      field.value = text;
      field.dispatchEvent(new Event('change'));
      toast('Pasted.');
    } catch {
      field.focus();
      toast('This browser will not read the clipboard — long-press the field and paste.', 'error');
    }
  }));

  $$('[data-check]').forEach((btn) => btn.addEventListener('click', async () => {
    const provider = btn.dataset.check;
    const result = $(`[data-result="${provider}"]`);
    const show = (text, kind) => {
      if (!result) { toast(text, kind === 'bad' ? 'error' : ''); return; }
      result.hidden = false;
      result.className = `check-result ${kind}`;
      result.textContent = text;
    };
    btn.disabled = true;
    show('Checking…', '');
    try {
      show(`✓ ${await checkCredentials(state.settings, provider)}`, 'ok');
      renderSetupPrompt();
    } catch (err) {
      show(`✕ ${err.message}`, 'bad');
    } finally {
      btn.disabled = false;
    }
  }));

  $('#btn-clear').addEventListener('click', async () => {
    if (!confirm('Delete every recording, transcript and answer on this device?')) return;
    await store.clearAll();
    state.sessions = [];
    state.current = null;
    toast('All local data deleted.');
    go('library');
  });

  syncSettingsUi();
}

function fillDatalist(sel, models) {
  const list = $(sel);
  list.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.label = m.label;
    list.append(opt);
  }
}

function syncSettingsUi() {
  const s = state.settings;
  $$('[data-provider]').forEach((el) => { el.hidden = el.dataset.provider !== s.provider; });
  $$('[data-transcriber]').forEach((el) => { el.hidden = el.dataset.transcriber !== s.transcriber; });
  // The OpenAI key has two homes; keep them in step.
  $('#set-openai-key').value = s.openaiKey;
  $('#set-openai-key2').value = s.openaiKey;

  const note = {
    openai: 'Audio is uploaded to OpenAI and transcribed there. Long recordings are split up automatically.',
    webspeech: canRecogniseLive
      ? 'Runs while you record, using the browser\'s own recogniser. Nothing is uploaded by this app, but the browser may use a cloud service.'
      : 'This browser has no speech recogniser — pick another option.',
    manual: 'You paste the words in yourself, e.g. a transcript the site already provides.',
  }[s.transcriber];
  $('#transcriber-note').textContent = note || '';
}

async function renderStorageNote() {
  const usage = await store.usageBytes();
  $('#storage-note').textContent = usage
    ? `Recordings live in this browser only — about ${fmtBytes(usage.usage)} used of roughly ${fmtBytes(usage.quota)} available.`
    : 'Recordings live in this browser only. Nothing is uploaded unless you transcribe or ask a question.';
}

// ── install & startup ──────────────────────────────────────────────────────

function initInstall() {
  let deferred = null;
  const btn = $('#btn-install');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  btn.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    btn.hidden = true;
  });
  if (isIOS && !isStandalone && !sessionStorage.getItem('clipmind.installHint')) {
    sessionStorage.setItem('clipmind.installHint', '1');
    setTimeout(() => toast('Tip: Share → Add to Home Screen to keep this a tap away.'), 1200);
  }
}

function initSessionView() {
  $('#btn-transcribe').addEventListener('click', runTranscription);
  $('#btn-paste-transcript').addEventListener('click', pasteTranscript);
  $('#btn-copy-transcript').addEventListener('click', () => copyText(state.current?.transcript?.text || ''));
  $('#btn-suggest').addEventListener('click', suggestActions);
  $('#btn-run-action').addEventListener('click', () => {
    if (state.pendingAction) runAction(state.pendingAction, $('#action-input-field').value);
  });
  $('#action-input-field').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && state.pendingAction) runAction(state.pendingAction, e.target.value);
  });
  $('#chk-frames').addEventListener('change', (e) => {
    state.settings.includeFrames = e.target.checked;
    store.saveSettings(state.settings);
  });
  $('#session-title').addEventListener('change', async (e) => {
    if (!state.current) return;
    state.current.title = e.target.value.trim() || state.current.title;
    e.target.value = state.current.title;
    await store.putSession(state.current);
  });
}

function renderSetupPrompt() {
  $('#setup-prompt').hidden = !missingCredentials(state.settings);
}

async function checkStorage() {
  const mode = await store.storageMode();
  if (mode === 'durable') return;
  const banner = $('#storage-warning');
  banner.hidden = false;
  banner.textContent = location.protocol === 'file:'
    ? 'Opened straight from a file, so this browser will not give the page a database — recordings last until you close the tab. Host the file (or use the Home Screen version) to keep them.'
    : 'This browser is not letting the page store data — private browsing usually does that. Recordings will be lost when the tab closes.';
}

function init() {
  $$('[data-goto]').forEach((el) => el.addEventListener('click', () => go(el.dataset.goto)));
  initRecordView();
  renderSetupPrompt();
  initSessionView();
  initSettings();
  initInstall();
  go('record');

  window.addEventListener('beforeunload', (e) => {
    if (state.recorder.active) { e.preventDefault(); e.returnValue = ''; }
  });

  // The single-file build has no sw.js beside it, and a page opened from disk
  // cannot register one at all.
  if (!window.__CLIPMIND_SINGLE_FILE__ && location.protocol.startsWith('http') && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('sw', err));
    });
  }

  checkStorage();
}

init();
