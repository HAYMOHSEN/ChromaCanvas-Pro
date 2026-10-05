// ChromaCanvas Pro — tools and pointer input (pen, mouse, touch).

import { createCanvas, copyCanvas, clampRect } from './state.js';
import { beginPixelChange, wholeLayerEntry } from './history.js';
import { Stroke, compositeStroke } from './brush.js';
import { hexToRgb, rgbToHex, hexToRgba } from './color.js';

export const TOOL_INFO = {
  brush: { name: 'Brush', cursor: 'none', key: 'B' },
  eraser: { name: 'Eraser', cursor: 'none', key: 'E' },
  fill: { name: 'Fill', cursor: 'crosshair', key: 'G' },
  eyedropper: { name: 'Eyedropper', cursor: 'crosshair', key: 'I' },
  line: { name: 'Line', cursor: 'crosshair', key: 'L' },
  rect: { name: 'Rectangle', cursor: 'crosshair', key: 'R' },
  ellipse: { name: 'Ellipse', cursor: 'crosshair', key: 'O' },
  text: { name: 'Text', cursor: 'text', key: 'T' },
  move: { name: 'Move', cursor: 'move', key: 'M' },
  hand: { name: 'Hand', cursor: 'grab', key: 'H' },
};

function pressureOf(e) {
  if (e.pointerType === 'pen') return Math.min(1, Math.max(0.02, e.pressure || 0.5));
  return 1;
}

export class ToolController {
  constructor(app, viewCanvas) {
    this.app = app;
    this.view = viewCanvas;
    this.tool = 'brush';
    this.action = null;          // current pointer action
    this.touches = new Map();    // pointerId -> {x,y}
    this.spaceHeld = false;
    this.buffer = createCanvas(1, 1);
    this.textEditor = null;      // { x, y } doc position while editing text
    this.hover = null;
    this._bind();
  }

  get doc() { return this.app.doc; }
  get renderer() { return this.app.renderer; }

  // ---------- tool selection ----------
  setTool(name) {
    if (!TOOL_INFO[name]) return;
    if (this.action) this._endAction(null, true);
    if (this.tool === 'text' && name !== 'text') this.app.textTool?.cancel();
    this.tool = name;
    this.app.onToolChanged(name);
    this.updateCursor();
  }

  updateCursor(hovering = true) {
    const ws = this.renderer.workspace;
    let cursor = TOOL_INFO[this.tool].cursor;
    if (this.spaceHeld || this.action?.type === 'pan') cursor = this.action?.type === 'pan' ? 'grabbing' : 'grab';
    ws.dataset.cursor = cursor;
    const r = this.renderer;
    const brushLike = (this.tool === 'brush' || this.tool === 'eraser') && !this.spaceHeld;
    if (brushLike && this.hover && hovering) {
      const b = this.app.getBrushSettings();
      r.cursor = { visible: true, x: this.hover.sx, y: this.hover.sy, radius: (b.size * r.zoom) / 2, shape: 'ring' };
    } else {
      r.cursor.visible = false;
    }
    r.invalidateOverlay();
  }

  ensureBuffer() {
    if (this.buffer.width !== this.doc.width || this.buffer.height !== this.doc.height) {
      this.buffer.width = this.doc.width;
      this.buffer.height = this.doc.height;
    }
  }

  // ---------- event binding ----------
  _bind() {
    const v = this.view;
    v.addEventListener('pointerdown', (e) => this._onDown(e));
    v.addEventListener('pointermove', (e) => this._onMove(e));
    v.addEventListener('pointerup', (e) => this._onUp(e));
    v.addEventListener('pointercancel', (e) => this._onUp(e, true));
    v.addEventListener('lostpointercapture', (e) => { if (this.action && this.action.pointerId === e.pointerId) this._endAction(e, false); });
    v.addEventListener('pointerleave', () => { this.hover = null; this.updateCursor(false); this.app.updatePointerStatus(null); });
    v.addEventListener('contextmenu', (e) => e.preventDefault());
    v.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    v.addEventListener('dblclick', (e) => e.preventDefault());
  }

  setSpaceHeld(held) {
    if (this.spaceHeld === held) return;
    this.spaceHeld = held;
    this.updateCursor();
  }

  // ---------- pointer handlers ----------
  _onDown(e) {
    const r = this.renderer;
    const pos = r.toDoc(e.clientX, e.clientY);
    this.hover = pos;

    if (e.pointerType === 'touch') {
      // palm rejection: ignore fingers while a pen or mouse action is in progress
      if (this.action && this.action.pointerType !== 'touch' && this.action.type !== 'gesture') return;
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        // second finger: cancel whatever the first finger started and begin a pinch/pan gesture
        if (this.action && this.action.type !== 'gesture') this._endAction(e, true);
        this._beginGesture();
        return;
      }
      if (this.touches.size > 2) return;
      if (!this.app.touchDraws) { if (!this.action) this._startAction(e, { type: 'pan', lastX: e.clientX, lastY: e.clientY }); return; }
    }

    if (this.action) return; // one action at a time
    this.view.focus?.();

    // middle button or Space → pan
    if (e.button === 1 || (this.spaceHeld && e.button === 0) || this.tool === 'hand' && e.button === 0) {
      this._startAction(e, { type: 'pan', lastX: e.clientX, lastY: e.clientY });
      return;
    }
    // right button or Alt+click → eyedropper (one shot)
    if (e.button === 2 || (e.altKey && e.button === 0)) {
      this._startAction(e, { type: 'pick', secondary: e.shiftKey });
      this._pick(pos, e.shiftKey, false);
      return;
    }
    if (e.button !== 0) return;

    const penEraser = e.pointerType === 'pen' && (e.buttons & 32) === 32;
    const tool = penEraser ? 'eraser' : this.tool;

    switch (tool) {
      case 'brush':
      case 'eraser':
        this._startStroke(e, pos, tool === 'eraser');
        break;
      case 'fill':
        this._startAction(e, { type: 'click' });
        this._fill(pos);
        break;
      case 'eyedropper':
        this._startAction(e, { type: 'pick', secondary: e.shiftKey });
        this._pick(pos, e.shiftKey, false);
        break;
      case 'line':
      case 'rect':
      case 'ellipse':
        this._startShape(e, pos, tool);
        break;
      case 'text':
        this._startAction(e, { type: 'click' });
        this.app.textTool.placeAt(pos);
        break;
      case 'move':
        this._startMove(e, pos);
        break;
      default:
        break;
    }
  }

  _onMove(e) {
    const r = this.renderer;
    const pos = r.toDoc(e.clientX, e.clientY);
    this.hover = pos;
    this.app.updatePointerStatus({ x: pos.x, y: pos.y, type: e.pointerType, pressure: e.pointerType === 'pen' ? e.pressure : null, buttons: e.buttons });

    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.action?.type === 'gesture') { this._updateGesture(); return; }
    }

    const a = this.action;
    if (!a || a.pointerId !== e.pointerId) {
      this.updateCursor();
      return;
    }
    switch (a.type) {
      case 'stroke': {
        const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        const list = events.length ? events : [e];
        for (const ev of list) {
          const p = r.toDoc(ev.clientX, ev.clientY);
          a.stroke.move(p.x, p.y, pressureOf(ev));
        }
        r.strokePreview.rect = a.stroke.rect;
        r.invalidate();
        if (this.tool === 'brush' || this.tool === 'eraser') {
          r.cursor = { visible: e.pointerType !== 'touch', x: pos.sx, y: pos.sy, radius: (a.stroke.brush.size * r.zoom) / 2, shape: 'ring' };
        }
        break;
      }
      case 'pan':
        r.panBy(e.clientX - a.lastX, e.clientY - a.lastY);
        a.lastX = e.clientX; a.lastY = e.clientY;
        break;
      case 'shape':
        a.cur = pos;
        a.shift = e.shiftKey;
        r.invalidateOverlay();
        break;
      case 'move': {
        const dx = Math.round(pos.x - a.start.x), dy = Math.round(pos.y - a.start.y);
        if (dx !== a.dx || dy !== a.dy) {
          a.dx = dx; a.dy = dy;
          const l = a.layer;
          l.ctx.save();
          l.ctx.setTransform(1, 0, 0, 1, 0, 0);
          l.ctx.globalCompositeOperation = 'source-over';
          l.ctx.globalAlpha = 1;
          l.ctx.clearRect(0, 0, l.width, l.height);
          l.ctx.drawImage(a.snapshot, dx, dy);
          l.ctx.restore();
          this.doc.pixelsChanged(l, null);
        }
        break;
      }
      case 'pick':
        this._pick(pos, a.secondary, false);
        break;
      default:
        break;
    }
  }

  _onUp(e, cancelled = false) {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.action?.type === 'gesture') {
        if (this.touches.size < 2) this.action = null;
        return;
      }
    }
    const a = this.action;
    if (!a || a.pointerId !== e.pointerId) return;
    this._endAction(e, cancelled);
  }

  _startAction(e, action) {
    action.pointerId = e.pointerId;
    action.pointerType = e.pointerType;
    this.action = action;
    try { this.view.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.updateCursor();
    e.preventDefault();
  }

  _endAction(e, cancelled) {
    const a = this.action;
    if (!a) return;
    this.action = null;
    if (e && e.pointerId !== undefined) { try { this.view.releasePointerCapture(e.pointerId); } catch { /* ignore */ } }
    switch (a.type) {
      case 'stroke': this._finishStroke(a, cancelled); break;
      case 'shape': this._finishShape(a, cancelled); break;
      case 'move': this._finishMove(a, cancelled); break;
      case 'pick': if (!cancelled) this.app.commitColor(a.secondary); break;
      default: break;
    }
    this.updateCursor();
  }

  // ---------- gesture (two-finger pan & zoom) ----------
  _beginGesture() {
    const [p1, p2] = [...this.touches.values()];
    const r = this.renderer;
    this.action = {
      type: 'gesture', pointerId: -1,
      dist: Math.hypot(p2.x - p1.x, p2.y - p1.y),
      cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2,
      zoom: r.zoom, panX: r.panX, panY: r.panY,
    };
  }
  _updateGesture() {
    const a = this.action;
    const pts = [...this.touches.values()];
    if (pts.length < 2) return;
    const [p1, p2] = pts;
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
    const r = this.renderer;
    const rect = r.workspace.getBoundingClientRect();
    const k = Math.min(32 / a.zoom, Math.max(0.03 / a.zoom, dist / Math.max(1, a.dist)));
    const nz = a.zoom * k;
    const ax = a.cx - rect.left, ay = a.cy - rect.top;
    r.zoom = nz;
    r.panX = ax - (ax - a.panX) * k + (cx - a.cx);
    r.panY = ay - (ay - a.panY) * k + (cy - a.cy);
    r.clampPan();
    r.invalidateView();
    r.emit('zoom', nz);
  }

  // ---------- wheel ----------
  _onWheel(e) {
    e.preventDefault();
    const r = this.renderer;
    const rect = r.workspace.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const delta = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY;
      const factor = Math.pow(1.0015, -delta);
      r.zoomBy(factor, e.clientX - rect.left, e.clientY - rect.top);
    } else {
      const k = e.deltaMode === 1 ? 20 : 1;
      let dx = -e.deltaX * k, dy = -e.deltaY * k;
      if (e.shiftKey && dx === 0) { dx = dy; dy = 0; }
      r.panBy(dx, dy);
    }
    this.updateCursor();
  }

  // ---------- strokes ----------
  _layerPaintable(layer) {
    if (!layer) return false;
    if (layer.locked) { this.app.toast('This layer is locked. Unlock it in the Layers panel to paint on it.', 'warning'); return false; }
    if (!layer.visible) { this.app.toast('This layer is hidden. Show it to paint on it.', 'warning'); return false; }
    return true;
  }

  _startStroke(e, pos, isEraser) {
    const layer = this.doc.active;
    if (!this._layerPaintable(layer)) return;
    this.ensureBuffer();
    const brush = this.app.getBrushSettings(isEraser ? 'eraser' : 'brush');
    const stroke = new Stroke({
      buffer: this.buffer, brush, color: isEraser ? '#000000' : this.app.colors.primary,
      symmetry: this.app.symmetry, width: this.doc.width, height: this.doc.height,
    });
    stroke.begin(pos.x, pos.y, pressureOf(e));
    this.renderer.strokePreview = { layer, buffer: this.buffer, alpha: stroke.alpha, op: stroke.op, rect: stroke.rect };
    this.renderer.invalidate();
    this._startAction(e, { type: 'stroke', stroke, layer, isEraser });
  }

  _finishStroke(a, cancelled) {
    const r = this.renderer;
    r.strokePreview = null;
    if (cancelled) { a.stroke.cancel(); r.invalidate(); return; }
    const rect = a.stroke.end();
    if (rect) {
      const clamped = clampRect(rect, this.doc.width, this.doc.height);
      if (clamped) {
        const change = beginPixelChange(this.doc, a.layer, clamped, a.isEraser ? 'Erase' : `${a.stroke.brush.name} stroke`);
        compositeStroke(a.layer, this.buffer, clamped, a.stroke.alpha, a.stroke.op);
        const entry = change.commit();
        if (entry) this.app.history.push(entry);
        this.doc.pixelsChanged(a.layer, clamped);
      }
      a.stroke.clearBuffer();
    }
    r.invalidate();
    if (!a.isEraser) this.app.noteColorUsed();
  }

  // ---------- shapes ----------
  _startShape(e, pos, kind) {
    const layer = this.doc.active;
    if (!this._layerPaintable(layer)) return;
    const painter = (ctx, r) => this._paintShapePreview(ctx, r);
    this.renderer.overlayPainters.push(painter);
    this._startAction(e, { type: 'shape', kind, layer, start: pos, cur: pos, shift: e.shiftKey, painter });
  }

  _shapeGeometry(a) {
    let x1 = a.start.x, y1 = a.start.y, x2 = a.cur.x, y2 = a.cur.y;
    if (a.shift) {
      if (a.kind === 'line') {
        const dx = x2 - x1, dy = y2 - y1;
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        x2 = x1 + Math.cos(ang) * len; y2 = y1 + Math.sin(ang) * len;
      } else {
        const s = Math.min(Math.abs(x2 - x1), Math.abs(y2 - y1));
        x2 = x1 + Math.sign(x2 - x1 || 1) * s;
        y2 = y1 + Math.sign(y2 - y1 || 1) * s;
      }
    }
    return { x1, y1, x2, y2 };
  }

  _drawShapePath(ctx, kind, g, scale) {
    ctx.beginPath();
    if (kind === 'line') {
      ctx.moveTo(g.x1 * scale, g.y1 * scale);
      ctx.lineTo(g.x2 * scale, g.y2 * scale);
    } else if (kind === 'rect') {
      const x = Math.min(g.x1, g.x2) * scale, y = Math.min(g.y1, g.y2) * scale;
      ctx.rect(x, y, Math.abs(g.x2 - g.x1) * scale, Math.abs(g.y2 - g.y1) * scale);
    } else {
      const cx = ((g.x1 + g.x2) / 2) * scale, cy = ((g.y1 + g.y2) / 2) * scale;
      ctx.ellipse(cx, cy, (Math.abs(g.x2 - g.x1) / 2) * scale, (Math.abs(g.y2 - g.y1) / 2) * scale, 0, 0, Math.PI * 2);
    }
  }

  _applyShapeStyle(ctx, kind, scale) {
    const o = this.app.shapeOpts;
    const c = this.app.colors;
    ctx.globalAlpha = o.opacity;
    ctx.lineWidth = Math.max(0.5, o.width * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const doFill = kind !== 'line' && (o.mode === 'fill' || o.mode === 'both');
    const doStroke = kind === 'line' || o.mode === 'stroke' || o.mode === 'both';
    if (doFill) { ctx.fillStyle = o.mode === 'both' ? c.secondary : c.primary; ctx.fill(); }
    if (doStroke) { ctx.strokeStyle = c.primary; ctx.stroke(); }
  }

  _paintShapePreview(ctx, r) {
    const a = this.action;
    if (!a || a.type !== 'shape') return;
    const g = this._shapeGeometry(a);
    ctx.translate(r.panX, r.panY);
    this._drawShapePath(ctx, a.kind, g, r.zoom);
    this._applyShapeStyle(ctx, a.kind, r.zoom);
  }

  _finishShape(a, cancelled) {
    const r = this.renderer;
    r.overlayPainters = r.overlayPainters.filter((p) => p !== a.painter);
    r.invalidateOverlay();
    if (cancelled) return;
    const g = this._shapeGeometry(a);
    const pad = this.app.shapeOpts.width + 2;
    const rect = clampRect({
      x: Math.min(g.x1, g.x2) - pad, y: Math.min(g.y1, g.y2) - pad,
      w: Math.abs(g.x2 - g.x1) + pad * 2, h: Math.abs(g.y2 - g.y1) + pad * 2,
    }, this.doc.width, this.doc.height);
    if (!rect) return;
    const label = { line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse' }[a.kind];
    const change = beginPixelChange(this.doc, a.layer, rect, label);
    const ctx = a.layer.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    this._drawShapePath(ctx, a.kind, g, 1);
    this._applyShapeStyle(ctx, a.kind, 1);
    ctx.restore();
    const entry = change.commit();
    if (entry) this.app.history.push(entry);
    this.doc.pixelsChanged(a.layer, rect);
    this.app.noteColorUsed();
  }

  // ---------- move ----------
  _startMove(e, pos) {
    const layer = this.doc.active;
    if (!layer || layer.locked) { this.app.toast('This layer is locked.', 'warning'); return; }
    this._startAction(e, { type: 'move', layer, start: pos, dx: 0, dy: 0, snapshot: copyCanvas(layer.canvas) });
  }

  _finishMove(a, cancelled) {
    const l = a.layer;
    if (cancelled || (a.dx === 0 && a.dy === 0)) {
      if (cancelled && (a.dx || a.dy)) {
        l.ctx.clearRect(0, 0, l.width, l.height);
        l.ctx.drawImage(a.snapshot, 0, 0);
        this.doc.pixelsChanged(l, null);
      }
      return;
    }
    this.app.history.push(wholeLayerEntry(this.doc, l, a.snapshot, 'Move layer'));
  }

  /** Nudge the active layer by (dx, dy) pixels (arrow keys with the Move tool). */
  nudge(dx, dy) {
    const l = this.doc.active;
    if (!l || l.locked) return;
    const before = copyCanvas(l.canvas);
    l.ctx.save();
    l.ctx.setTransform(1, 0, 0, 1, 0, 0);
    l.ctx.globalCompositeOperation = 'source-over';
    l.ctx.globalAlpha = 1;
    l.ctx.clearRect(0, 0, l.width, l.height);
    l.ctx.drawImage(before, dx, dy);
    l.ctx.restore();
    this.doc.pixelsChanged(l, null);
    this.app.history.push(wholeLayerEntry(this.doc, l, before, 'Nudge layer'));
  }

  // ---------- eyedropper ----------
  _pick(pos, secondary, final) {
    const px = this.renderer.samplePixel(pos.x, pos.y);
    if (!px) return;
    const [r, g, b, a] = px;
    if (a === 0) return;
    // un-premultiply against white for semi-transparent pixels so the picked colour matches what is seen
    const hex = rgbToHex(r, g, b);
    this.app.setColor(hex, secondary ? 'secondary' : 'primary', { fromPicker: true, final });
  }

  // ---------- fill ----------
  _fill(pos) {
    const layer = this.doc.active;
    if (!this._layerPaintable(layer)) return;
    const { width: W, height: H } = this.doc;
    const x = Math.floor(pos.x), y = Math.floor(pos.y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = this.app.fillOpts;
    const src = o.sampleAll ? this.renderer.compositeImageData() : layer.ctx.getImageData(0, 0, W, H);
    const result = floodFill(src, x, y, o.tolerance);
    if (!result) return;
    const { mask, rect } = result;
    // paint the mask with the primary colour onto a temp canvas, then composite with opacity
    const tmp = createCanvas(rect.w, rect.h);
    const tctx = tmp.getContext('2d');
    const img = tctx.createImageData(rect.w, rect.h);
    const { r, g, b } = hexToRgb(this.app.colors.primary);
    const d = img.data;
    for (let yy = 0; yy < rect.h; yy++) {
      for (let xx = 0; xx < rect.w; xx++) {
        if (mask[(rect.y + yy) * W + (rect.x + xx)]) {
          const i = (yy * rect.w + xx) * 4;
          d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
        }
      }
    }
    tctx.putImageData(img, 0, 0);
    const change = beginPixelChange(this.doc, layer, rect, 'Fill');
    const ctx = layer.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = o.opacity;
    ctx.drawImage(tmp, rect.x, rect.y);
    ctx.restore();
    const entry = change.commit();
    if (entry) this.app.history.push(entry);
    this.doc.pixelsChanged(layer, rect);
    this.app.noteColorUsed();
  }
}

/**
 * Scanline flood fill. Returns { mask: Uint8Array(W*H), rect } or null.
 * Tolerance 0..255 compares the maximum channel difference (RGBA).
 */
export function floodFill(imageData, sx, sy, tolerance) {
  const W = imageData.width, H = imageData.height, d = imageData.data;
  const idx = (sy * W + sx) * 4;
  const r0 = d[idx], g0 = d[idx + 1], b0 = d[idx + 2], a0 = d[idx + 3];
  const tol = Math.max(0, Math.min(255, tolerance | 0));
  const mask = new Uint8Array(W * H);
  const match = (i) => {
    const j = i * 4;
    return Math.abs(d[j] - r0) <= tol && Math.abs(d[j + 1] - g0) <= tol && Math.abs(d[j + 2] - b0) <= tol && Math.abs(d[j + 3] - a0) <= tol;
  };
  let minX = sx, maxX = sx, minY = sy, maxY = sy;
  const stack = [sy * W + sx];
  while (stack.length) {
    let i = stack.pop();
    if (mask[i] || !match(i)) continue;
    const y = (i / W) | 0;
    let x = i - y * W;
    // walk left
    let xl = x;
    while (xl > 0 && !mask[i - (x - xl) - 1] && match(i - (x - xl) - 1)) xl--;
    // walk right
    let xr = x;
    while (xr < W - 1 && !mask[i + (xr - x) + 1] && match(i + (xr - x) + 1)) xr++;
    const row = y * W;
    for (let xx = xl; xx <= xr; xx++) mask[row + xx] = 1;
    if (xl < minX) minX = xl;
    if (xr > maxX) maxX = xr;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    // queue the rows above and below
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= H) continue;
      const nrow = ny * W;
      let inSpan = false;
      for (let xx = xl; xx <= xr; xx++) {
        const ni = nrow + xx;
        const ok = !mask[ni] && match(ni);
        if (ok && !inSpan) { stack.push(ni); inSpan = true; }
        else if (!ok) inSpan = false;
      }
    }
  }
  return { mask, rect: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } };
}

/** Text tool: positions an editor over the canvas and renders the result onto the active layer. */
export class TextTool {
  constructor(app, els) {
    this.app = app;
    this.editor = els.editor;
    this.input = els.input;
    this.pos = null;
    els.commit.addEventListener('click', () => this.commit());
    els.cancel.addEventListener('click', () => this.cancel());
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); this.cancel(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.commit(); }
    });
    this.input.addEventListener('input', () => this._autosize());
    app.renderer.on('view', () => this.reposition());
  }

  get active() { return !!this.pos; }

  placeAt(pos) {
    if (this.pos && this.input.value.trim()) this.commit();
    this.pos = { x: pos.x, y: pos.y };
    this.input.value = '';
    this.editor.classList.remove('hidden');
    this.applyStyle();
    this.reposition();
    this._autosize();
    this.input.focus({ preventScroll: true });
    setTimeout(() => { if (this.pos && document.activeElement !== this.input) this.input.focus({ preventScroll: true }); }, 0);
  }

  applyStyle() {
    const o = this.app.textOpts;
    const z = this.app.renderer.zoom;
    this.input.style.fontFamily = `"${o.font}", sans-serif`;
    this.input.style.fontSize = `${Math.max(4, o.size * z)}px`;
    this.input.style.fontWeight = o.bold ? '700' : '400';
    this.input.style.fontStyle = o.italic ? 'italic' : 'normal';
    this.input.style.color = this.app.colors.primary;
    this._autosize();
  }

  reposition() {
    if (!this.pos) return;
    const s = this.app.renderer.toScreen(this.pos.x, this.pos.y);
    this.editor.style.left = `${Math.round(s.x) - 5}px`;
    this.editor.style.top = `${Math.round(s.y) - 3}px`;
    this.applyStyle();
  }

  _autosize() {
    const t = this.input;
    t.style.height = 'auto';
    t.style.width = 'auto';
    const lines = t.value.split('\n');
    t.rows = Math.max(1, lines.length);
    t.style.height = `${t.scrollHeight + 2}px`;
    t.style.width = `${Math.max(120, t.scrollWidth + 12)}px`;
  }

  commit() {
    if (!this.pos) return;
    const text = this.input.value.replace(/\s+$/, '');
    const pos = this.pos;
    this.pos = null;
    this.editor.classList.add('hidden');
    if (!text.trim()) return;
    const layer = this.app.doc.active;
    if (!layer || layer.locked || !layer.visible) { this.app.toast('The active layer is locked or hidden.', 'warning'); return; }
    const o = this.app.textOpts;
    const ctx = layer.ctx;
    const font = `${o.italic ? 'italic ' : ''}${o.bold ? '700 ' : '400 '}${o.size}px "${o.font}", sans-serif`;
    ctx.save();
    ctx.font = font;
    const lines = text.split('\n');
    const lineHeight = o.size * 1.2;
    let maxW = 0;
    for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
    ctx.restore();
    const rect = clampRect({ x: pos.x - 4, y: pos.y - 4, w: maxW + 8, h: lineHeight * lines.length + o.size * 0.4 + 8 }, this.app.doc.width, this.app.doc.height);
    if (!rect) return;
    const change = beginPixelChange(this.app.doc, layer, rect, 'Text');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.font = font;
    ctx.textBaseline = 'top';
    ctx.fillStyle = this.app.colors.primary;
    lines.forEach((line, i) => ctx.fillText(line, pos.x, pos.y + i * lineHeight));
    ctx.restore();
    const entry = change.commit();
    if (entry) this.app.history.push(entry);
    this.app.doc.pixelsChanged(layer, rect);
    this.app.noteColorUsed();
  }

  cancel() {
    this.pos = null;
    this.editor.classList.add('hidden');
    this.input.value = '';
  }
}

export { hexToRgba };
