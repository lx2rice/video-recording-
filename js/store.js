// IndexedDB persistence. Recordings can be hundreds of megabytes, so media
// blobs live in their own store and are only read when a session is opened.

const DB_NAME = 'clipmind';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('media')) {
        db.createObjectStore('media', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    fn(transaction);
  }));
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export async function listSessions() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = db.transaction('sessions', 'readonly').objectStore('sessions');
    const out = [];
    const cursorReq = store.index('createdAt').openCursor(null, 'prev');
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve(out);
      out.push(cursor.value);
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

export async function getSession(id) {
  const db = await openDb();
  return req(db.transaction('sessions', 'readonly').objectStore('sessions').get(id));
}

export async function putSession(session) {
  await tx('sessions', 'readwrite', (t) => t.objectStore('sessions').put(session));
  return session;
}

export async function deleteSession(id) {
  await tx(['sessions', 'media'], 'readwrite', (t) => {
    t.objectStore('sessions').delete(id);
    t.objectStore('media').delete(id);
  });
}

export async function putMedia(id, blob, poster) {
  await tx('media', 'readwrite', (t) => t.objectStore('media').put({ id, blob, poster }));
}

export async function getMedia(id) {
  const db = await openDb();
  return req(db.transaction('media', 'readonly').objectStore('media').get(id));
}

export async function usageBytes() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

export async function clearAll() {
  await tx(['sessions', 'media'], 'readwrite', (t) => {
    t.objectStore('sessions').clear();
    t.objectStore('media').clear();
  });
}

// --- settings (small, synchronous, survives reinstall of the DB) -------------

const SETTINGS_KEY = 'clipmind.settings.v1';

export const defaultSettings = {
  provider: 'anthropic',            // 'anthropic' | 'openai' | 'proxy'
  anthropicKey: '',
  anthropicModel: 'claude-opus-5',
  effort: 'high',                   // low | medium | high | xhigh | max
  useFallbacks: true,               // server-side fallback on a policy decline
  openaiKey: '',
  openaiModel: 'gpt-4o-mini',
  proxyUrl: '',
  transcriber: 'openai',            // 'openai' | 'webspeech' | 'manual'
  whisperModel: 'whisper-1',
  language: '',
  includeFrames: false,
  frameCount: 6,
  autoTranscribe: true,
  micWithScreen: true,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return { ...defaultSettings, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn('settings not saved', err);
  }
  return settings;
}
