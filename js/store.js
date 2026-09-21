// Persistence. IndexedDB when the page has it — which needs a real origin, so
// a page opened straight off the filesystem usually doesn't — and an in-memory
// stand-in when it doesn't, so the app still runs for one sitting.

const DB_NAME = 'clipmind';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!self.indexedDB) { reject(new Error('IndexedDB is unavailable on this page.')); return; }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('media')) {
        db.createObjectStore('media', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB is blocked.'));
    // Private mode in some browsers never settles the open request.
    setTimeout(() => reject(new Error('IndexedDB did not open in time.')), 5000);
  });
  return dbPromise;
}

function tx(db, storeNames, mode, fn) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    fn(transaction);
  });
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const idb = {
  durable: true,
  async list() {
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
  },
  async get(id) {
    const db = await openDb();
    return req(db.transaction('sessions', 'readonly').objectStore('sessions').get(id));
  },
  async put(session) {
    const db = await openDb();
    await tx(db, 'sessions', 'readwrite', (t) => t.objectStore('sessions').put(session));
  },
  async remove(id) {
    const db = await openDb();
    await tx(db, ['sessions', 'media'], 'readwrite', (t) => {
      t.objectStore('sessions').delete(id);
      t.objectStore('media').delete(id);
    });
  },
  async putMedia(record) {
    const db = await openDb();
    await tx(db, 'media', 'readwrite', (t) => t.objectStore('media').put(record));
  },
  async getMedia(id) {
    const db = await openDb();
    return req(db.transaction('media', 'readonly').objectStore('media').get(id));
  },
  async clear() {
    const db = await openDb();
    await tx(db, ['sessions', 'media'], 'readwrite', (t) => {
      t.objectStore('sessions').clear();
      t.objectStore('media').clear();
    });
  },
};

const sessionMap = new Map();
const mediaMap = new Map();

const memory = {
  durable: false,
  async list() {
    return [...sessionMap.values()].sort((a, b) => b.createdAt - a.createdAt);
  },
  async get(id) { return sessionMap.get(id) || null; },
  async put(session) { sessionMap.set(session.id, session); },
  async remove(id) { sessionMap.delete(id); mediaMap.delete(id); },
  async putMedia(record) { mediaMap.set(record.id, record); },
  async getMedia(id) { return mediaMap.get(id) || null; },
  async clear() { sessionMap.clear(); mediaMap.clear(); },
};

let backendPromise = null;

function backend() {
  if (!backendPromise) {
    backendPromise = openDb().then(() => idb, (err) => {
      console.warn('Falling back to in-memory storage:', err && err.message);
      return memory;
    });
  }
  return backendPromise;
}

/** 'durable' once the database is open, 'memory' when it could not be. */
export async function storageMode() {
  return (await backend()).durable ? 'durable' : 'memory';
}

export function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export async function listSessions() {
  return (await backend()).list();
}

export async function getSession(id) {
  return (await backend()).get(id);
}

export async function putSession(session) {
  await (await backend()).put(session);
  return session;
}

export async function deleteSession(id) {
  await (await backend()).remove(id);
}

export async function putMedia(id, blob, poster) {
  await (await backend()).putMedia({ id, blob, poster });
}

export async function getMedia(id) {
  return (await backend()).getMedia(id);
}

export async function clearAll() {
  await (await backend()).clear();
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

// --- settings ---------------------------------------------------------------

const SETTINGS_KEY = 'clipmind.settings.v1';
let settingsFallback = null;

export const defaultSettings = {
  provider: 'anthropic',            // 'anthropic' | 'openai'
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
    return { ...defaultSettings, ...(settingsFallback || {}) };
  }
}

export function saveSettings(settings) {
  settingsFallback = settings;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn('settings not saved', err);
  }
  return settings;
}
