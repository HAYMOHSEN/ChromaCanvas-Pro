// ChromaCanvas Pro — layer and image operations (all undoable).

import { Layer, createCanvas, copyCanvas, MAX_DIM } from './state.js';
import { wholeLayerEntry, geometryEntry } from './history.js';

export class Ops {
  constructor(app) { this.app = app; }
  get doc() { return this.app.doc; }
  get history() { return this.app.history; }

  // ---------- layer structure ----------
  addLayer(name) {
    const doc = this.doc;
    const layer = doc.newLayer(name);
    const index = doc.insertLayer(layer, doc.activeIndex + 1);
    this.history.push({
      label: 'New layer', bytes: 0,
      undo: () => doc.removeLayer(layer),
      redo: () => doc.insertLayer(layer, index),
    });
    return layer;
  }

  /** Insert an existing canvas (imported image) as a new layer, centred. */
  addImageLayer(image, name = 'Imported image') {
    const doc = this.doc;
    const layer = doc.newLayer(name);
    const scale = Math.min(1, doc.width / image.width, doc.height / image.height);
    const w = image.width * scale, h = image.height * scale;
    layer.ctx.drawImage(image, (doc.width - w) / 2, (doc.height - h) / 2, w, h);
    const index = doc.insertLayer(layer, doc.activeIndex + 1);
    this.history.push({
      label: 'Import image', bytes: doc.width * doc.height * 4,
      undo: () => doc.removeLayer(layer),
      redo: () => doc.insertLayer(layer, index),
    });
    return layer;
  }

  duplicateLayer() {
    const doc = this.doc;
    const src = doc.active;
    if (!src) return null;
    const copy = src.clone();
    const index = doc.insertLayer(copy, doc.indexOf(src) + 1);
    this.history.push({
      label: 'Duplicate layer', bytes: doc.width * doc.height * 4,
      undo: () => doc.removeLayer(copy),
      redo: () => doc.insertLayer(copy, index),
    });
    return copy;
  }

  deleteLayer(layer = this.doc.active) {
    const doc = this.doc;
    if (doc.layers.length <= 1) { this.app.toast('A document needs at least one layer.', 'warning'); return false; }
    const index = doc.indexOf(layer);
    doc.removeLayer(layer);
    this.history.push({
      label: 'Delete layer', bytes: doc.width * doc.height * 4,
      undo: () => doc.insertLayer(layer, index),
      redo: () => doc.removeLayer(layer),
    });
    return true;
  }

  moveLayer(from, to) {
    const doc = this.doc;
    if (!doc.moveLayer(from, to)) return false;
    this.history.push({
      label: 'Reorder layers', bytes: 0,
      undo: () => doc.moveLayer(to, from),
      redo: () => doc.moveLayer(from, to),
    });
    return true;
  }

  moveActive(delta) {
    const from = this.doc.activeIndex;
    return this.moveLayer(from, from + delta);
  }

  setLayerProps(layer, props, label = 'Layer properties') {
    const doc = this.doc;
    const before = {};
    for (const k of Object.keys(props)) before[k] = layer[k];
    doc.setLayerProps(layer, props);
    this.history.push({
      label, bytes: 0,
      undo: () => doc.setLayerProps(layer, before),
      redo: () => doc.setLayerProps(layer, props),
    });
  }

  toggleVisible(layer) { this.setLayerProps(layer, { visible: !layer.visible }, layer.visible ? 'Hide layer' : 'Show layer'); }
  toggleLocked(layer) { this.setLayerProps(layer, { locked: !layer.locked }, layer.locked ? 'Unlock layer' : 'Lock layer'); }

  mergeDown(layer = this.doc.active) {
    const doc = this.doc;
    const idx = doc.indexOf(layer);
    if (idx <= 0) { this.app.toast('There is no layer below to merge into.', 'warning'); return false; }
    const below = doc.layers[idx - 1];
    const beforeBelow = copyCanvas(below.canvas);
    const beforeProps = { opacity: below.opacity, blend: below.blend, visible: below.visible };
    // merge: draw upper onto lower with the upper layer's opacity/blend
    below.ctx.save();
    below.ctx.globalAlpha = layer.opacity;
    below.ctx.globalCompositeOperation = layer.blend;
    if (layer.visible) below.ctx.drawImage(layer.canvas, 0, 0);
    below.ctx.restore();
    const afterBelow = copyCanvas(below.canvas);
    doc.removeLayer(layer);
    doc.setActive(idx - 1);
    doc.pixelsChanged(below, null);
    const restore = (src) => { below.ctx.clearRect(0, 0, below.width, below.height); below.ctx.drawImage(src, 0, 0); };
    this.history.push({
      label: 'Merge down', bytes: doc.width * doc.height * 8,
      undo: () => { restore(beforeBelow); doc.setLayerProps(below, beforeProps); doc.insertLayer(layer, idx); doc.pixelsChanged(below, null); },
      redo: () => { restore(afterBelow); doc.removeLayer(layer); doc.setActive(idx - 1); doc.pixelsChanged(below, null); },
    });
    return true;
  }

  flatten() {
    const doc = this.doc;
    if (doc.layers.length <= 1) return false;
    const beforeLayers = [...doc.layers];
    const beforeActive = doc.activeIndex;
    const flat = new Layer(doc.width, doc.height, 'Background');
    flat.ctx.drawImage(doc.flatten(true), 0, 0);
    const apply = (layers, active) => {
      doc.layers = [...layers];
      doc.activeIndex = Math.min(active, layers.length - 1);
      doc._touch('structure');
      doc.emit('active', doc.active);
    };
    apply([flat], 0);
    this.history.push({
      label: 'Flatten image', bytes: doc.width * doc.height * 4 * (beforeLayers.length + 1),
      undo: () => apply(beforeLayers, beforeActive),
      redo: () => apply([flat], 0),
    });
    return true;
  }

  clearLayer(layer = this.doc.active) {
    if (!layer || layer.locked) { this.app.toast('This layer is locked.', 'warning'); return; }
    const before = copyCanvas(layer.canvas);
    layer.clear();
    this.doc.pixelsChanged(layer, null);
    this.history.push(wholeLayerEntry(this.doc, layer, before, 'Clear layer'));
  }

  // ---------- per-layer transforms ----------
  transformLayer(layer, kind) {
    if (!layer || layer.locked) { this.app.toast('This layer is locked.', 'warning'); return; }
    const before = copyCanvas(layer.canvas);
    const { width: w, height: h } = layer;
    const ctx = layer.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);
    switch (kind) {
      case 'flipH': ctx.translate(w, 0); ctx.scale(-1, 1); break;
      case 'flipV': ctx.translate(0, h); ctx.scale(1, -1); break;
      case 'rot90': ctx.translate(w / 2, h / 2); ctx.rotate(Math.PI / 2); ctx.translate(-w / 2, -h / 2); break;
      case 'rot270': ctx.translate(w / 2, h / 2); ctx.rotate(-Math.PI / 2); ctx.translate(-w / 2, -h / 2); break;
      case 'rot180': ctx.translate(w, h); ctx.rotate(Math.PI); break;
      default: break;
    }
    ctx.drawImage(before, 0, 0);
    ctx.restore();
    this.doc.pixelsChanged(layer, null);
    const labels = { flipH: 'Flip layer horizontal', flipV: 'Flip layer vertical', rot90: 'Rotate layer 90° CW', rot270: 'Rotate layer 90° CCW', rot180: 'Rotate layer 180°' };
    this.history.push(wholeLayerEntry(this.doc, layer, before, labels[kind] || 'Transform layer'));
  }

  // ---------- whole-image geometry ----------
  _snapshotGeometry() {
    const doc = this.doc;
    return { width: doc.width, height: doc.height, canvases: doc.layers.map((l) => l.canvas) };
  }

  _commitGeometry(before, newW, newH, draw, label) {
    const doc = this.doc;
    const canvases = doc.layers.map((layer) => {
      const c = createCanvas(newW, newH);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      draw(ctx, layer.canvas);
      return c;
    });
    const after = { width: newW, height: newH, canvases };
    doc.applyGeometry(newW, newH, canvases);
    this.history.push(geometryEntry(doc, before, after, label));
  }

  flipImage(horizontal) {
    const before = this._snapshotGeometry();
    const { width: w, height: h } = this.doc;
    this._commitGeometry(before, w, h, (ctx, src) => {
      if (horizontal) { ctx.translate(w, 0); ctx.scale(-1, 1); } else { ctx.translate(0, h); ctx.scale(1, -1); }
      ctx.drawImage(src, 0, 0);
    }, horizontal ? 'Flip image horizontal' : 'Flip image vertical');
  }

  rotateImage(deg) {
    const before = this._snapshotGeometry();
    const { width: w, height: h } = this.doc;
    const swap = deg === 90 || deg === 270;
    const nw = swap ? h : w, nh = swap ? w : h;
    this._commitGeometry(before, nw, nh, (ctx, src) => {
      ctx.translate(nw / 2, nh / 2);
      ctx.rotate((deg * Math.PI) / 180);
      ctx.drawImage(src, -w / 2, -h / 2);
    }, `Rotate image ${deg}°`);
  }

  resizeImage(newW, newH) {
    newW = Math.max(1, Math.min(MAX_DIM, Math.round(newW)));
    newH = Math.max(1, Math.min(MAX_DIM, Math.round(newH)));
    const before = this._snapshotGeometry();
    const { width: w, height: h } = this.doc;
    if (newW === w && newH === h) return;
    this._commitGeometry(before, newW, newH, (ctx, src) => {
      // two-step downscale for quality when shrinking a lot
      if (newW < w / 2 || newH < h / 2) {
        let cur = src, cw = w, ch = h;
        while (cw / 2 > newW && ch / 2 > newH) {
          const tmp = createCanvas(Math.ceil(cw / 2), Math.ceil(ch / 2));
          const tctx = tmp.getContext('2d');
          tctx.imageSmoothingQuality = 'high';
          tctx.drawImage(cur, 0, 0, tmp.width, tmp.height);
          cur = tmp; cw = tmp.width; ch = tmp.height;
        }
        ctx.drawImage(cur, 0, 0, newW, newH);
      } else {
        ctx.drawImage(src, 0, 0, newW, newH);
      }
    }, 'Resize image');
  }

  resizeCanvas(newW, newH, anchor = 'c') {
    newW = Math.max(1, Math.min(MAX_DIM, Math.round(newW)));
    newH = Math.max(1, Math.min(MAX_DIM, Math.round(newH)));
    const before = this._snapshotGeometry();
    const { width: w, height: h } = this.doc;
    if (newW === w && newH === h) return;
    const ax = anchor.includes('w') ? 0 : anchor.includes('e') ? 1 : 0.5;
    const ay = anchor.includes('n') ? 0 : anchor.includes('s') ? 1 : 0.5;
    const ox = Math.round((newW - w) * ax), oy = Math.round((newH - h) * ay);
    this._commitGeometry(before, newW, newH, (ctx, src) => {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(src, ox, oy);
    }, 'Canvas size');
  }
}
