// ChromaCanvas Pro — document model: layers, events, helpers.

export class Emitter {
  constructor() { this._listeners = new Map(); }
  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) { this._listeners.get(type)?.delete(fn); }
  emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error(`[emitter:${type}]`, err); }
    }
  }
}

export const BLEND_MODES = [
  ['source-over', 'Normal'],
  ['multiply', 'Multiply'],
  ['screen', 'Screen'],
  ['overlay', 'Overlay'],
  ['darken', 'Darken'],
  ['lighten', 'Lighten'],
  ['color-dodge', 'Color dodge'],
  ['color-burn', 'Color burn'],
  ['hard-light', 'Hard light'],
  ['soft-light', 'Soft light'],
  ['difference', 'Difference'],
  ['exclusion', 'Exclusion'],
  ['hue', 'Hue'],
  ['saturation', 'Saturation'],
  ['color', 'Color'],
  ['luminosity', 'Luminosity'],
];

export const MAX_DIM = 8192;

export function createCanvas(width, height) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

export function copyCanvas(src) {
  const c = createCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

let layerSeq = 1;

export class Layer {
  constructor(width, height, name = 'Layer') {
    this.id = `L${layerSeq++}-${Math.random().toString(36).slice(2, 8)}`;
    this.name = name;
    this.visible = true;
    this.locked = false;
    this.opacity = 1;
    this.blend = 'source-over';
    this.version = 0;            // bumped whenever pixels change (lets autosave skip unchanged layers)
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
  }
  get width() { return this.canvas.width; }
  get height() { return this.canvas.height; }

  /** Replace the backing canvas (used by resize / rotate operations). */
  setCanvas(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.version++;
  }

  fill(color) {
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.ctx.restore();
  }

  clear() { this.ctx.clearRect(0, 0, this.width, this.height); }

  clone(name) {
    const l = new Layer(this.width, this.height, name ?? `${this.name} copy`);
    l.visible = this.visible;
    l.locked = false;
    l.opacity = this.opacity;
    l.blend = this.blend;
    l.ctx.drawImage(this.canvas, 0, 0);
    return l;
  }

  /** True when the layer has no visible pixels (cheap sampled check). */
  isEmpty() {
    const { width, height } = this;
    const data = this.ctx.getImageData(0, 0, width, height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
    return true;
  }
}

/**
 * A document is an ordered stack of layers (index 0 = bottom) plus an active layer.
 * Events: 'structure' (layers added/removed/reordered/property changed),
 *         'pixels'    ({ layer, rect }) pixel content changed,
 *         'resize'    ({ width, height }) canvas dimensions changed,
 *         'active'    (layer) active layer changed,
 *         'change'    fired after any of the above (used for autosave).
 */
export class Document extends Emitter {
  constructor(width, height, background = 'white') {
    super();
    this.width = Math.round(width);
    this.height = Math.round(height);
    this.layers = [];
    this.activeIndex = 0;
    this.name = 'Untitled';
    this.fileHandle = null;      // FileSystemFileHandle when saved via the picker
    this.modified = false;
    this._layerCounter = 0;

    if (background !== 'transparent') {
      const bg = this.newLayer('Background');
      bg.fill(background === 'white' ? '#ffffff' : background);
      this.layers.push(bg);
    } else {
      this.layers.push(this.newLayer());
    }
    this.activeIndex = this.layers.length - 1;
  }

  /** Create a layer sized to the document (not yet inserted). */
  newLayer(name) {
    this._layerCounter += 1;
    return new Layer(this.width, this.height, name ?? `Layer ${this._layerCounter}`);
  }

  get active() { return this.layers[this.activeIndex] ?? this.layers[this.layers.length - 1]; }

  indexOf(layer) { return this.layers.indexOf(layer); }

  setActive(layerOrIndex) {
    const idx = typeof layerOrIndex === 'number' ? layerOrIndex : this.layers.indexOf(layerOrIndex);
    if (idx < 0 || idx >= this.layers.length) return;
    if (this.activeIndex === idx) return;
    this.activeIndex = idx;
    this.emit('active', this.active);
  }

  insertLayer(layer, index = this.activeIndex + 1) {
    index = Math.max(0, Math.min(this.layers.length, index));
    this.layers.splice(index, 0, layer);
    this.activeIndex = index;
    this._touch('structure');
    this.emit('active', this.active);
    return index;
  }

  removeLayer(layer) {
    const idx = this.layers.indexOf(layer);
    if (idx < 0) return -1;
    this.layers.splice(idx, 1);
    this.activeIndex = Math.max(0, Math.min(this.activeIndex, this.layers.length - 1));
    this._touch('structure');
    this.emit('active', this.active);
    return idx;
  }

  moveLayer(from, to) {
    if (from === to || from < 0 || to < 0 || from >= this.layers.length || to >= this.layers.length) return false;
    const [l] = this.layers.splice(from, 1);
    this.layers.splice(to, 0, l);
    this.activeIndex = to;
    this._touch('structure');
    this.emit('active', this.active);
    return true;
  }

  setLayerProps(layer, props) {
    Object.assign(layer, props);
    this._touch('structure', { layer, props });
  }

  /** Notify that pixels of a layer changed within rect (doc coordinates). */
  pixelsChanged(layer, rect) {
    layer.version++;
    this._touch('pixels', { layer, rect: rect ?? { x: 0, y: 0, w: this.width, h: this.height } });
  }

  /** Replace dimensions + layer canvases atomically (resize, rotate, canvas-size). */
  applyGeometry(width, height, canvases) {
    this.width = width;
    this.height = height;
    this.layers.forEach((layer, i) => layer.setCanvas(canvases[i]));
    this._touch('resize', { width, height });
  }

  /** Flattened copy of all visible layers as a canvas. */
  flatten(visibleOnly = true) {
    const out = createCanvas(this.width, this.height);
    const ctx = out.getContext('2d');
    for (const layer of this.layers) {
      if (visibleOnly && !layer.visible) continue;
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.blend;
      ctx.drawImage(layer.canvas, 0, 0);
    }
    return out;
  }

  _touch(type, payload) {
    this.modified = true;
    this.emit(type, payload);
    this.emit('change', { type, payload });
  }
}

/** Clamp a rect to the document bounds; returns null when empty. */
export function clampRect(rect, width, height) {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionRect(a, b) {
  if (!a) return { ...b };
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: x2 - x, h: y2 - y };
}
