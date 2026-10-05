// ChromaCanvas Pro — persistence: autosave (IndexedDB), project files (.ccp),
// image import and export, settings (localStorage).

import { Document, Layer, MAX_DIM } from './state.js';

export const PROJECT_EXT = '.ccp';
export const PROJECT_MIME = 'application/json';
const DB_NAME = 'chromacanvas-pro';
const DB_VERSION = 1;
const STORE = 'session';
const SETTINGS_KEY = 'chromacanvas.settings.v1';

// ---------- settings ----------
export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
export function saveSettings(obj) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj)); } catch { /* quota or private mode */ }
}

// ---------- IndexedDB ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function idbGet(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))), type, quality);
  });
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = src;
  });
}

export async function blobToImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(blob);
  try { return await loadImage(url); } finally { URL.revokeObjectURL(url); }
}

/**
 * Serialises a document into a structured-clone-friendly session record (layers as PNG blobs).
 * `cache` (Map layerId → {version, blob}) lets unchanged layers skip re-encoding.
 */
export async function serializeDocument(doc, cache = null) {
  const layers = [];
  for (const l of doc.layers) {
    let blob;
    const hit = cache?.get(l.id);
    if (hit && hit.version === l.version && hit.width === l.width && hit.height === l.height) blob = hit.blob;
    else {
      blob = await canvasToBlob(l.canvas, 'image/png');
      cache?.set(l.id, { version: l.version, width: l.width, height: l.height, blob });
    }
    layers.push({ name: l.name, visible: l.visible, locked: l.locked, opacity: l.opacity, blend: l.blend, blob });
  }
  if (cache) for (const id of [...cache.keys()]) if (!doc.layers.some((l) => l.id === id)) cache.delete(id);
  return {
    id: 'current',
    app: 'ChromaCanvas Pro', version: 1, savedAt: Date.now(),
    width: doc.width, height: doc.height, name: doc.name,
    activeIndex: doc.activeIndex, layers,
    fileHandle: doc.fileHandle ?? null,
  };
}

/** Rebuilds a Document from a session / project record. */
export async function deserializeDocument(rec) {
  const w = Math.max(1, Math.min(MAX_DIM, rec.width | 0));
  const h = Math.max(1, Math.min(MAX_DIM, rec.height | 0));
  const doc = new Document(w, h, 'transparent');
  doc.layers = [];
  for (const lr of rec.layers) {
    const layer = new Layer(w, h, lr.name || 'Layer');
    layer.visible = lr.visible !== false;
    layer.locked = !!lr.locked;
    layer.opacity = typeof lr.opacity === 'number' ? lr.opacity : 1;
    layer.blend = lr.blend || 'source-over';
    let img = null;
    if (lr.blob instanceof Blob) img = await blobToImage(lr.blob);
    else if (typeof lr.data === 'string') img = await loadImage(lr.data);
    if (img) layer.ctx.drawImage(img, 0, 0);
    doc.layers.push(layer);
  }
  if (!doc.layers.length) doc.layers.push(doc.newLayer());
  doc._layerCounter = doc.layers.length;
  doc.activeIndex = Math.max(0, Math.min(doc.layers.length - 1, rec.activeIndex | 0));
  doc.name = rec.name || 'Untitled';
  doc.fileHandle = rec.fileHandle ?? null;
  doc.modified = false;
  return doc;
}

/** Autosave: debounced writer + restore. */
export class Autosave {
  constructor(onStatus) {
    this.onStatus = onStatus || (() => {});
    this.timer = 0;
    this.pending = false;
    this.busy = false;
    this.cache = new Map();
    this.dbPromise = openDB().catch((err) => { console.warn('IndexedDB unavailable', err); return null; });
  }

  schedule(doc, delay = 900) {
    this.pending = true;
    this.onStatus('unsaved');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(doc), delay);
  }

  async flush(doc) {
    clearTimeout(this.timer);
    if (!this.pending || this.busy) return;
    this.busy = true;
    this.pending = false;
    this.onStatus('saving');
    try {
      const db = await this.dbPromise;
      if (!db) throw new Error('no db');
      const rec = await serializeDocument(doc, this.cache);
      await idbPut(db, rec);
      this.onStatus('saved');
    } catch (err) {
      console.warn('autosave failed', err);
      this.pending = true;
      this.onStatus('error');
    } finally {
      this.busy = false;
      if (this.pending) this.schedule(doc, 4000);
    }
  }

  async restore() {
    try {
      const db = await this.dbPromise;
      if (!db) return null;
      const rec = await idbGet(db, 'current');
      if (!rec || !rec.layers?.length) return null;
      return await deserializeDocument(rec);
    } catch (err) {
      console.warn('restore failed', err);
      return null;
    }
  }

  async clear() {
    try { const db = await this.dbPromise; if (db) await idbDelete(db, 'current'); } catch { /* ignore */ }
  }
}

// ---------- project files ----------
export async function documentToProjectJSON(doc) {
  const layers = [];
  for (const l of doc.layers) {
    layers.push({
      name: l.name, visible: l.visible, locked: l.locked, opacity: l.opacity, blend: l.blend,
      data: l.canvas.toDataURL('image/png'),
    });
  }
  return JSON.stringify({
    app: 'ChromaCanvas Pro', format: 'ccp', version: 1, created: new Date().toISOString(),
    width: doc.width, height: doc.height, activeIndex: doc.activeIndex, layers,
  });
}

export async function projectFromJSON(text) {
  const rec = JSON.parse(text);
  if (!rec || rec.format !== 'ccp' || !Array.isArray(rec.layers)) throw new Error('Not a ChromaCanvas project file');
  return deserializeDocument(rec);
}

// ---------- File System Access helpers (with download fallback) ----------
export const hasFSAccess = typeof window.showSaveFilePicker === 'function';

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Saves a blob. Returns the FileSystemFileHandle when the picker was used, true for a download,
 * or null when the user cancelled.
 */
export async function saveBlob(blob, { suggestedName, types, handle = null }) {
  if (hasFSAccess) {
    try {
      let h = handle;
      if (h) {
        const perm = await h.queryPermission?.({ mode: 'readwrite' });
        if (perm !== 'granted') {
          const req = await h.requestPermission?.({ mode: 'readwrite' });
          if (req !== 'granted') h = null;
        }
      }
      if (!h) h = await window.showSaveFilePicker({ suggestedName, types, excludeAcceptAllOption: false });
      const writable = await h.createWritable();
      await writable.write(blob);
      await writable.close();
      return h;
    } catch (err) {
      if (err?.name === 'AbortError') return null;
      console.warn('save picker failed, falling back to download', err);
    }
  }
  downloadBlob(blob, suggestedName);
  return true;
}

export async function pickFiles({ multiple = true, accept } = {}) {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const handles = await window.showOpenFilePicker({ multiple, types: accept, excludeAcceptAllOption: false });
      const files = [];
      for (const h of handles) { const f = await h.getFile(); f.handle = h; files.push(f); }
      return files;
    } catch (err) {
      if (err?.name === 'AbortError') return [];
      console.warn('open picker failed, falling back', err);
    }
  }
  return new Promise((resolve) => {
    const input = document.getElementById('file-input');
    input.value = '';
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files || []));
    input.click();
  });
}

export const IMAGE_TYPES = [{ description: 'Images', accept: { 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'], 'image/gif': ['.gif'], 'image/bmp': ['.bmp'], 'image/svg+xml': ['.svg'] } }];
export const PROJECT_TYPES = [{ description: 'ChromaCanvas project', accept: { [PROJECT_MIME]: [PROJECT_EXT] } }];
export const OPEN_TYPES = [
  { description: 'ChromaCanvas project or image', accept: { [PROJECT_MIME]: [PROJECT_EXT], 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'], 'image/gif': ['.gif'], 'image/bmp': ['.bmp'], 'image/svg+xml': ['.svg'] } },
];

export function isProjectFile(file) {
  return /\.ccp$/i.test(file.name || '') || file.type === PROJECT_MIME && /\.ccp$/i.test(file.name || '');
}
export function isImageFile(file) {
  return /^image\//.test(file.type || '') || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name || '');
}

export function timestampName(prefix, ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${ext}`;
}
