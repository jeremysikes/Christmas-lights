/* LightPlan UI: persist.
 * Autosave and restore for the current project, kept in this browser only.
 *
 *   project JSON  localStorage "lightplan:v1:project", written at most every ~400 ms (debounced)
 *   photos        IndexedDB database "lightplan", object store "images", key = image.storageKey,
 *                 value = the image data URL string. If IndexedDB is missing, blocked or fails, the data URL
 *                 goes to localStorage "lightplan:v1:img:<storageKey>" instead.
 *   small prefs   localStorage "lightplan:v1:pref:<name>" (JSON), e.g. install-checklist ticks
 *
 * The built-in sample photo (storageKey "sample") is never stored: it is regenerated from sample.js.
 *
 * Storage inside the claude.ai artifact frame can be missing, throw on access, or be wiped at any time, so
 * every storage call is wrapped in try/catch and every public function either returns a plain value or a
 * Promise that resolves (never rejects). IndexedDB.open can also hang in sandboxed frames, so it has a
 * timeout after which the localStorage fallback is used.
 *
 * Deviations from SPEC (additive): besides load() and clear() this module exports saveProject (debounced),
 * saveProjectNow, flush, saveImage, loadImage, deleteImage, pruneImages, savePref, loadPref, setErrorHandler
 * and the key constants.
 */
LP.define('ui.persist', [], function () {
  'use strict';

  const PROJECT_KEY = 'lightplan:v1:project';
  const IMAGE_PREFIX = 'lightplan:v1:img:';
  const PREF_PREFIX = 'lightplan:v1:pref:';
  const ALL_PREFIX = 'lightplan:v1:';
  const DB_NAME = 'lightplan';
  const DB_STORE = 'images';
  const DB_VERSION = 1;
  const SAMPLE_KEY = 'sample';
  const SAVE_DELAY_MS = 400;
  const IDB_TIMEOUT_MS = 2500;

  let errorHandler = null;
  let lastErrorAt = -Infinity;
  /** Report a storage failure to the app (rate-limited so a full disk does not spam toasts). */
  function reportError(message) {
    const t = typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
    if (t - lastErrorAt < 30000) return;
    lastErrorAt = t;
    if (typeof errorHandler === 'function') {
      try { errorHandler(message); } catch (e) { /* the handler itself failed; nothing else to do */ }
    }
  }
  function setErrorHandler(fn) { errorHandler = typeof fn === 'function' ? fn : null; }

  // ---------------------------------------------------------------- localStorage (every access guarded)
  function storage() {
    try {
      return typeof localStorage !== 'undefined' && localStorage ? localStorage : null;
    } catch (e) {
      return null; // accessing localStorage itself throws when storage is blocked
    }
  }
  function lsGet(key) {
    const s = storage();
    if (!s) return null;
    try { return s.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, value) {
    const s = storage();
    if (!s) return false;
    try { s.setItem(key, value); return true; } catch (e) { return false; }
  }
  function lsRemove(key) {
    const s = storage();
    if (!s) return;
    try { s.removeItem(key); } catch (e) { /* ignore */ }
  }
  function lsKeys(prefix) {
    const s = storage();
    const out = [];
    if (!s) return out;
    try {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (typeof k === 'string' && k.indexOf(prefix) === 0) out.push(k);
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  // ---------------------------------------------------------------- IndexedDB (promise wrapper, never rejects)
  let dbPromise = null;
  /** Resolves the open database, or null when IndexedDB is unavailable, blocked, failing or too slow. */
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (db) => { if (!settled) { settled = true; resolve(db); } };
      let idb = null;
      try { idb = typeof indexedDB !== 'undefined' ? indexedDB : null; } catch (e) { idb = null; }
      if (!idb) { finish(null); return; }
      const timer = setTimeout(() => finish(null), IDB_TIMEOUT_MS);
      try {
        const req = idb.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          try {
            const db = req.result;
            if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
          } catch (e) { /* the open will fail and we fall back */ }
        };
        req.onsuccess = () => {
          clearTimeout(timer);
          let db = null;
          try { db = req.result; } catch (e) { db = null; }
          if (settled && db) { try { db.close(); } catch (e) { /* ignore */ } return; }
          if (db) db.onversionchange = () => { try { db.close(); } catch (e) { /* ignore */ } dbPromise = null; };
          finish(db);
        };
        req.onerror = () => { clearTimeout(timer); finish(null); };
        req.onblocked = () => { clearTimeout(timer); finish(null); };
      } catch (e) {
        clearTimeout(timer);
        finish(null);
      }
    });
    return dbPromise;
  }

  /**
   * Run one request in a transaction. `make(store)` returns an IDBRequest. Resolves {ok, value}; ok is false
   * when there is no database or anything fails.
   */
  function idbRun(mode, make) {
    return openDb().then((db) => new Promise((resolve) => {
      if (!db) { resolve({ ok: false, value: undefined }); return; }
      try {
        const tx = db.transaction(DB_STORE, mode);
        const req = make(tx.objectStore(DB_STORE));
        let value;
        req.onsuccess = () => { value = req.result; };
        req.onerror = () => { /* reported through tx.onerror / onabort */ };
        tx.oncomplete = () => resolve({ ok: true, value });
        tx.onerror = () => resolve({ ok: false, value: undefined });
        tx.onabort = () => resolve({ ok: false, value: undefined });
      } catch (e) {
        resolve({ ok: false, value: undefined });
      }
    })).catch(() => ({ ok: false, value: undefined }));
  }

  // ---------------------------------------------------------------- project
  let pendingProject = null;
  let saveTimer = null;

  /** Write the project JSON right away. Returns true when it was stored. */
  function saveProjectNow(project) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    pendingProject = null;
    let json;
    try { json = JSON.stringify(project); } catch (e) { return false; }
    if (typeof json !== 'string') return false;
    const ok = lsSet(PROJECT_KEY, json);
    if (!ok && storage()) reportError('Autosave failed because browser storage is full or blocked. Save the project to a file to keep it.');
    return ok;
  }
  /** Debounced autosave: the last project passed within ~400 ms is written. */
  function saveProject(project) {
    pendingProject = project;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const p = pendingProject;
      pendingProject = null;
      if (p) saveProjectNow(p);
    }, SAVE_DELAY_MS);
  }
  /** Write a pending autosave now (call on pagehide / visibilitychange). */
  function flush() {
    if (pendingProject) saveProjectNow(pendingProject);
  }

  // ---------------------------------------------------------------- images
  /** Store a photo's data URL. Resolves true when stored (IndexedDB or the localStorage fallback). */
  function saveImage(key, dataUrl) {
    if (typeof key !== 'string' || !key || key === SAMPLE_KEY || typeof dataUrl !== 'string' || !dataUrl) {
      return Promise.resolve(false);
    }
    return idbRun('readwrite', (store) => store.put(dataUrl, key)).then((r) => {
      if (r.ok) { lsRemove(IMAGE_PREFIX + key); return true; }
      const ok = lsSet(IMAGE_PREFIX + key, dataUrl);
      if (!ok && storage()) reportError('The photo could not be saved in this browser (storage is full or blocked). Save the project to a file to keep it.');
      return ok;
    }).catch(() => false);
  }
  /** Resolves the stored data URL for a photo, or null. */
  function loadImage(key) {
    if (typeof key !== 'string' || !key || key === SAMPLE_KEY) return Promise.resolve(null);
    return idbRun('readonly', (store) => store.get(key)).then((r) => {
      if (r.ok && typeof r.value === 'string' && r.value) return r.value;
      const v = lsGet(IMAGE_PREFIX + key);
      return typeof v === 'string' && v ? v : null;
    }).catch(() => null);
  }
  function deleteImage(key) {
    if (typeof key !== 'string' || !key) return Promise.resolve(false);
    lsRemove(IMAGE_PREFIX + key);
    return idbRun('readwrite', (store) => store.delete(key)).then((r) => r.ok).catch(() => false);
  }
  /** Delete every stored photo whose key is not in keepKeys (an array of storage keys). */
  function pruneImages(keepKeys) {
    const keep = new Set(Array.isArray(keepKeys) ? keepKeys : []);
    for (const k of lsKeys(IMAGE_PREFIX)) {
      if (!keep.has(k.slice(IMAGE_PREFIX.length))) lsRemove(k);
    }
    return idbRun('readonly', (store) => store.getAllKeys()).then((r) => {
      if (!r.ok || !Array.isArray(r.value)) return false;
      const drop = r.value.filter((k) => !keep.has(k));
      return Promise.all(drop.map((k) => idbRun('readwrite', (store) => store.delete(k)))).then(() => true);
    }).catch(() => false);
  }

  // ---------------------------------------------------------------- small preferences
  function savePref(name, value) {
    let json;
    try { json = JSON.stringify(value); } catch (e) { return false; }
    return lsSet(PREF_PREFIX + name, json);
  }
  function loadPref(name, fallback) {
    const raw = lsGet(PREF_PREFIX + name);
    if (raw == null) return fallback === undefined ? null : fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback === undefined ? null : fallback; }
  }

  // ---------------------------------------------------------------- load / clear
  /**
   * Resolves {project, images: {storageKey: dataUrl}} for the autosaved project, or null when nothing usable
   * is stored. The project is returned as parsed (the app migrates and normalizes it). Never rejects.
   */
  function load() {
    return new Promise((resolve) => {
      let project = null;
      try {
        const raw = lsGet(PROJECT_KEY);
        if (raw) project = JSON.parse(raw);
      } catch (e) {
        project = null;
      }
      if (!project || typeof project !== 'object' || Array.isArray(project)) { resolve(null); return; }
      const keys = [];
      try {
        for (const im of Array.isArray(project.images) ? project.images : []) {
          const k = im && typeof im.storageKey === 'string' ? im.storageKey : null;
          if (k && k !== SAMPLE_KEY && keys.indexOf(k) < 0) keys.push(k);
        }
      } catch (e) { /* damaged image list: restore the project without photos */ }
      Promise.all(keys.map((k) => loadImage(k).then((v) => [k, v])))
        .then((pairs) => {
          const images = {};
          for (const [k, v] of pairs) if (v) images[k] = v;
          resolve({ project, images });
        })
        .catch(() => resolve({ project, images: {} }));
    });
  }

  /** Remove the autosaved project, every stored photo and all prefs. Resolves when done; never rejects. */
  function clear() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    pendingProject = null;
    for (const k of lsKeys(ALL_PREFIX)) lsRemove(k);
    return idbRun('readwrite', (store) => store.clear()).then(() => true).catch(() => false);
  }

  return {
    PROJECT_KEY, IMAGE_PREFIX, PREF_PREFIX, DB_NAME, DB_STORE, SAMPLE_KEY, SAVE_DELAY_MS,
    load, clear, saveProject, saveProjectNow, flush,
    saveImage, loadImage, deleteImage, pruneImages, savePref, loadPref, setErrorHandler,
  };
});
