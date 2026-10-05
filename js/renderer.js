// ChromaCanvas Pro — viewport renderer: composites layers, handles zoom / pan,
// HiDPI backing stores, the transparency checkerboard and overlay drawing.

import { Emitter, createCanvas } from './state.js';

export const MIN_ZOOM = 0.03;
export const MAX_ZOOM = 32;

export class Renderer extends Emitter {
  constructor(viewCanvas, overlayCanvas, workspace) {
    super();
    this.view = viewCanvas;
    this.overlay = overlayCanvas;
    this.workspace = workspace;
    this.vctx = viewCanvas.getContext('2d', { alpha: true });
    this.octx = overlayCanvas.getContext('2d');
    this.doc = null;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = 1;
    this.cssH = 1;

    this.composite = createCanvas(1, 1);
    this.cctx = this.composite.getContext('2d');
    this.preview = createCanvas(1, 1);
    this.pctx = this.preview.getContext('2d');

    this.strokePreview = null;   // { layer, buffer, alpha, op, rect }
    this.overlayPainters = [];   // fn(ctx, renderer) in CSS-pixel screen space
    this.cursor = { visible: false, x: 0, y: 0, radius: 0, shape: 'ring' };
    this.showGrid = false;
    this.gridSize = 50;
    this.symmetry = 'none';

    this._dirtyComposite = true;
    this._dirtyView = true;
    this._dirtyOverlay = true;
    this._raf = 0;
    this._checker = null;
    this._checkerKey = '';

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(workspace);
    matchMedia(`(resolution: ${this.dpr}dppx)`).addEventListener?.('change', () => this.resize());
    this.resize();
  }

  // ---------- document binding ----------
  setDocument(doc) {
    if (this._unbind) this._unbind.forEach((fn) => fn());
    this.doc = doc;
    this._ensureBuffers();
    this._unbind = [
      doc.on('pixels', () => this.invalidate()),
      doc.on('structure', () => this.invalidate()),
      doc.on('resize', () => { this._ensureBuffers(); this.invalidate(); }),
    ];
    this.invalidate();
  }

  _ensureBuffers() {
    const { width, height } = this.doc;
    if (this.composite.width !== width || this.composite.height !== height) {
      this.composite.width = width; this.composite.height = height;
      this.preview.width = width; this.preview.height = height;
    }
  }

  // ---------- sizing ----------
  resize() {
    const rect = this.workspace.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const sizeChanged = w !== this.cssW || h !== this.cssH || dpr !== this.dpr;
    if (!sizeChanged) return;
    // Keep the document centred where it was when the window changes size.
    const oldW = this.cssW, oldH = this.cssH;
    this.cssW = w; this.cssH = h; this.dpr = dpr;
    for (const c of [this.view, this.overlay]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    if (oldW > 1 && oldH > 1 && this.doc) {
      this.panX += (w - oldW) / 2;
      this.panY += (h - oldH) / 2;
      this.clampPan();
    }
    this._checker = null;
    this.invalidateView();
    this.invalidateOverlay();
  }

  // ---------- invalidation ----------
  invalidate() { this._dirtyComposite = true; this._dirtyView = true; this.requestRender(); }
  invalidateView() { this._dirtyView = true; this.requestRender(); }
  invalidateOverlay() { this._dirtyOverlay = true; this.requestRender(); }
  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  render() {
    if (!this.doc) return;
    if (this._dirtyComposite) { this._buildComposite(); this._dirtyComposite = false; this._dirtyView = true; }
    if (this._dirtyView) { this._drawView(); this._dirtyView = false; this._dirtyOverlay = true; }
    if (this._dirtyOverlay) { this._drawOverlay(); this._dirtyOverlay = false; }
  }

  // ---------- compositing ----------
  _buildComposite() {
    const { doc, cctx } = this;
    cctx.save();
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.globalAlpha = 1;
    cctx.globalCompositeOperation = 'source-over';
    cctx.clearRect(0, 0, doc.width, doc.height);
    const sp = this.strokePreview;
    for (const layer of doc.layers) {
      if (!layer.visible) continue;
      cctx.globalAlpha = layer.opacity;
      cctx.globalCompositeOperation = layer.blend;
      if (sp && sp.layer === layer && sp.rect) {
        const p = this.pctx;
        p.save();
        p.globalCompositeOperation = 'source-over';
        p.globalAlpha = 1;
        p.clearRect(0, 0, doc.width, doc.height);
        p.drawImage(layer.canvas, 0, 0);
        p.globalAlpha = sp.alpha;
        p.globalCompositeOperation = sp.op;
        const r = sp.rect;
        p.drawImage(sp.buffer, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
        p.restore();
        cctx.drawImage(this.preview, 0, 0);
      } else {
        cctx.drawImage(layer.canvas, 0, 0);
      }
    }
    cctx.restore();
  }

  _checkerPattern() {
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    const key = `${this.dpr}|${dark}`;
    if (this._checker && this._checkerKey === key) return this._checker;
    const size = 8 * this.dpr;
    const c = createCanvas(size * 2, size * 2);
    const ctx = c.getContext('2d');
    ctx.fillStyle = dark ? '#2a2a30' : '#e9e9ee';
    ctx.fillRect(0, 0, size * 2, size * 2);
    ctx.fillStyle = dark ? '#3a3a42' : '#cdcdd6';
    ctx.fillRect(0, 0, size, size);
    ctx.fillRect(size, size, size, size);
    this._checker = this.vctx.createPattern(c, 'repeat');
    this._checkerKey = key;
    return this._checker;
  }

  _drawView() {
    const { vctx: ctx, doc, dpr, zoom } = this;
    const W = this.view.width, H = this.view.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // document rectangle in device pixels
    const sx = this.panX * dpr, sy = this.panY * dpr;
    const sw = doc.width * zoom * dpr, sh = doc.height * zoom * dpr;

    // drop shadow behind the canvas
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 36 * dpr;
    ctx.shadowOffsetY = 6 * dpr;
    ctx.fillStyle = '#000';
    ctx.fillRect(sx, sy, sw, sh);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // checkerboard (anchored to the document origin)
    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = this._checkerPattern();
    ctx.fillRect(0, 0, sw, sh);
    ctx.restore();

    // the artwork
    ctx.imageSmoothingEnabled = zoom < 3;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.composite, 0, 0, doc.width, doc.height, sx, sy, sw, sh);
    ctx.restore();
    this.emit('view');
  }

  _drawOverlay() {
    const { octx: ctx, dpr, zoom, doc } = this;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    const sx = this.panX, sy = this.panY, sw = doc.width * zoom, sh = doc.height * zoom;

    // grid
    if (this.showGrid && this.gridSize * zoom >= 6) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, sy, sw, sh);
      ctx.clip();
      ctx.strokeStyle = 'rgba(96,165,250,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const step = this.gridSize * zoom;
      for (let x = sx; x <= sx + sw + 0.5; x += step) { const px = Math.round(x) + 0.5; ctx.moveTo(px, sy); ctx.lineTo(px, sy + sh); }
      for (let y = sy; y <= sy + sh + 0.5; y += step) { const py = Math.round(y) + 0.5; ctx.moveTo(sx, py); ctx.lineTo(sx + sw, py); }
      ctx.stroke();
      ctx.restore();
    }

    // symmetry axes
    if (this.symmetry !== 'none') {
      ctx.save();
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = 'rgba(167,139,250,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (this.symmetry === 'h' || this.symmetry === 'both') { const x = Math.round(sx + sw / 2) + 0.5; ctx.moveTo(x, sy); ctx.lineTo(x, sy + sh); }
      if (this.symmetry === 'v' || this.symmetry === 'both') { const y = Math.round(sy + sh / 2) + 0.5; ctx.moveTo(sx, y); ctx.lineTo(sx + sw, y); }
      ctx.stroke();
      ctx.restore();
    }

    // tool overlays (shape previews etc.)
    for (const fn of this.overlayPainters) {
      ctx.save();
      try { fn(ctx, this); } catch (err) { console.error('overlay painter', err); }
      ctx.restore();
    }

    // brush cursor
    const c = this.cursor;
    if (c.visible) {
      ctx.save();
      ctx.lineWidth = 1;
      if (c.shape === 'ring' && c.radius >= 2.5) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.radius - 1, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
      } else {
        // small crosshair for tiny brushes
        const x = Math.round(c.x) + 0.5, y = Math.round(c.y) + 0.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.beginPath(); ctx.moveTo(x - 8, y); ctx.lineTo(x - 3, y); ctx.moveTo(x + 3, y); ctx.lineTo(x + 8, y); ctx.moveTo(x, y - 8); ctx.lineTo(x, y - 3); ctx.moveTo(x, y + 3); ctx.lineTo(x, y + 8); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.beginPath(); ctx.moveTo(x - 7, y); ctx.lineTo(x - 3, y); ctx.moveTo(x + 3, y); ctx.lineTo(x + 7, y); ctx.moveTo(x, y - 7); ctx.lineTo(x, y - 3); ctx.moveTo(x, y + 3); ctx.lineTo(x, y + 7); ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  // ---------- coordinates ----------
  /** Client (viewport) coordinates → document pixel coordinates. */
  toDoc(clientX, clientY) {
    const rect = this.workspace.getBoundingClientRect();
    const sx = clientX - rect.left, sy = clientY - rect.top;
    return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom, sx, sy };
  }
  /** Document coordinates → CSS pixel coordinates inside the workspace. */
  toScreen(x, y) {
    return { x: x * this.zoom + this.panX, y: y * this.zoom + this.panY };
  }

  // ---------- zoom / pan ----------
  setZoom(z, anchorX = this.cssW / 2, anchorY = this.cssH / 2) {
    const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    if (nz === this.zoom) return;
    const k = nz / this.zoom;
    this.panX = anchorX - (anchorX - this.panX) * k;
    this.panY = anchorY - (anchorY - this.panY) * k;
    this.zoom = nz;
    this.clampPan();
    this.invalidateView();
    this.emit('zoom', nz);
  }
  zoomBy(factor, anchorX, anchorY) { this.setZoom(this.zoom * factor, anchorX, anchorY); }
  zoomStep(dir) {
    const steps = [0.03, 0.05, 0.08, 0.125, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
    let z = this.zoom;
    if (dir > 0) z = steps.find((s) => s > z * 1.001) ?? MAX_ZOOM;
    else z = [...steps].reverse().find((s) => s < z * 0.999) ?? MIN_ZOOM;
    this.setZoom(z);
  }
  panBy(dx, dy) {
    this.panX += dx; this.panY += dy;
    this.clampPan();
    this.invalidateView();
  }
  clampPan() {
    if (!this.doc) return;
    const margin = 48;
    const sw = this.doc.width * this.zoom, sh = this.doc.height * this.zoom;
    this.panX = Math.min(this.cssW - margin, Math.max(margin - sw, this.panX));
    this.panY = Math.min(this.cssH - margin, Math.max(margin - sh, this.panY));
  }
  fit(padding = 40) {
    if (!this.doc) return;
    const z = Math.min((this.cssW - padding * 2) / this.doc.width, (this.cssH - padding * 2) / this.doc.height);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    this.center();
    this.emit('zoom', this.zoom);
  }
  center() {
    this.panX = Math.round((this.cssW - this.doc.width * this.zoom) / 2);
    this.panY = Math.round((this.cssH - this.doc.height * this.zoom) / 2);
    this.invalidateView();
  }
  zoomTo(z) {
    this.setZoom(z);
  }

  /** Sample the composite at a document pixel; returns [r,g,b,a] or null. */
  samplePixel(x, y) {
    const px = Math.floor(x), py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.doc.width || py >= this.doc.height) return null;
    if (this._dirtyComposite) { this._buildComposite(); this._dirtyComposite = false; }
    return Array.from(this.cctx.getImageData(px, py, 1, 1).data);
  }

  /** Composite ImageData (used by the fill tool). */
  compositeImageData() {
    if (this._dirtyComposite) { this._buildComposite(); this._dirtyComposite = false; }
    return this.cctx.getImageData(0, 0, this.doc.width, this.doc.height);
  }
}
