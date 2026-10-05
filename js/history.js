// ChromaCanvas Pro — undo / redo history.
// Entries are small objects with undo()/redo() closures plus a byte estimate so the
// total memory used by snapshots can be capped.

import { Emitter, copyCanvas, clampRect } from './state.js';

export class History extends Emitter {
  constructor({ maxSteps = 60, maxBytes = 256 * 1024 * 1024 } = {}) {
    super();
    this.maxSteps = maxSteps;
    this.maxBytes = maxBytes;
    this.undoStack = [];
    this.redoStack = [];
    this.bytes = 0;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack[this.undoStack.length - 1]?.label ?? ''; }
  get redoLabel() { return this.redoStack[this.redoStack.length - 1]?.label ?? ''; }

  push(entry) {
    entry.bytes = entry.bytes || 0;
    // A new action invalidates the redo branch.
    for (const e of this.redoStack) this.bytes -= e.bytes;
    this.redoStack.length = 0;
    this.undoStack.push(entry);
    this.bytes += entry.bytes;
    this._trim();
    this.emit('change');
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return false;
    try { e.undo(); } catch (err) { console.error('undo failed', err); }
    this.redoStack.push(e);
    this.emit('change');
    return true;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return false;
    try { e.redo(); } catch (err) { console.error('redo failed', err); }
    this.undoStack.push(e);
    this.emit('change');
    return true;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.bytes = 0;
    this.emit('change');
  }

  _trim() {
    while (this.undoStack.length > this.maxSteps || (this.bytes > this.maxBytes && this.undoStack.length > 1)) {
      const e = this.undoStack.shift();
      this.bytes -= e.bytes;
    }
  }
}

/**
 * Captures the pixels of `rect` on `layer` before a change. Call `.commit()` after the
 * change to get a history entry holding both states.
 */
export function beginPixelChange(doc, layer, rect, label) {
  const r = clampRect(rect ?? { x: 0, y: 0, w: layer.width, h: layer.height }, layer.width, layer.height);
  if (!r) return { commit: () => null, rect: null };
  const before = layer.ctx.getImageData(r.x, r.y, r.w, r.h);
  return {
    rect: r,
    commit() {
      const after = layer.ctx.getImageData(r.x, r.y, r.w, r.h);
      const apply = (img) => {
        layer.ctx.putImageData(img, r.x, r.y);
        doc.pixelsChanged(layer, r);
      };
      return {
        label,
        bytes: r.w * r.h * 8,
        undo: () => apply(before),
        redo: () => apply(after),
      };
    },
  };
}

/** History entry for a whole-layer pixel change using canvas copies (move, flip, rotate…). */
export function wholeLayerEntry(doc, layer, beforeCanvas, label) {
  const after = copyCanvas(layer.canvas);
  const apply = (src) => {
    layer.ctx.save();
    layer.ctx.globalCompositeOperation = 'source-over';
    layer.ctx.globalAlpha = 1;
    layer.ctx.clearRect(0, 0, layer.width, layer.height);
    layer.ctx.drawImage(src, 0, 0);
    layer.ctx.restore();
    doc.pixelsChanged(layer, null);
  };
  return {
    label,
    bytes: layer.width * layer.height * 8,
    undo: () => apply(beforeCanvas),
    redo: () => apply(after),
  };
}

/** History entry that swaps the whole document geometry (all layer canvases + size). */
export function geometryEntry(doc, before, after, label) {
  // before / after: { width, height, canvases: [canvas per layer in order] }
  const bytes = (before.width * before.height + after.width * after.height) * 4 * before.canvases.length;
  return {
    label,
    bytes,
    undo: () => doc.applyGeometry(before.width, before.height, before.canvases),
    redo: () => doc.applyGeometry(after.width, after.height, after.canvases),
  };
}
