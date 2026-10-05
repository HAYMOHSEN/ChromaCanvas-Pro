// ChromaCanvas Pro — brush engine.
// Strokes are painted as a series of "dabs" (stamps) into a stroke buffer, which is then
// composited onto the layer once with the brush opacity. This gives proper Opacity (cap per
// stroke) vs Flow (build-up per dab) behaviour, pen-pressure dynamics, textures and symmetry.

import { createCanvas, unionRect } from './state.js';
import { hexToRgb } from './color.js';

/** Built-in brush presets. `size`…`pressureFlow` are user-adjustable; the rest is intrinsic. */
export const BRUSHES = {
  pencil: {
    name: 'Pencil', icon: 'pencil',
    size: 4, opacity: 1, flow: 0.8, hardness: 0.85, spacing: 0.12, smoothing: 0.3,
    pressureSize: true, pressureFlow: true, minSize: 0.25, minFlow: 0.3,
    texture: 'grain', textureAmount: 0.5, rotateRandom: true,
  },
  pen: {
    name: 'Ink Pen', icon: 'pen-line',
    size: 6, opacity: 1, flow: 1, hardness: 0.97, spacing: 0.08, smoothing: 0.55,
    pressureSize: true, pressureFlow: false, minSize: 0.08, minFlow: 1,
  },
  marker: {
    name: 'Marker', icon: 'highlighter',
    size: 24, opacity: 0.6, flow: 1, hardness: 1, spacing: 0.06, smoothing: 0.35,
    pressureSize: false, pressureFlow: false, minSize: 1, minFlow: 1,
  },
  oil: {
    name: 'Oil Paint', icon: 'paintbrush-vertical',
    size: 30, opacity: 1, flow: 0.55, hardness: 0.92, spacing: 0.2, smoothing: 0.3,
    pressureSize: true, pressureFlow: false, minSize: 0.7, minFlow: 1,
    texture: 'bristle', textureAmount: 0.85, rotateToStroke: true,
  },
  watercolor: {
    name: 'Watercolor', icon: 'droplets',
    size: 60, opacity: 0.9, flow: 0.22, hardness: 0.5, spacing: 0.14, smoothing: 0.3,
    pressureSize: true, pressureFlow: true, minSize: 0.5, minFlow: 0.4,
    blend: 'multiply', texture: 'grain', textureAmount: 0.3, rotateRandom: true,
  },
  airbrush: {
    name: 'Airbrush', icon: 'spray-can',
    size: 80, opacity: 1, flow: 0.1, hardness: 0, spacing: 0.06, smoothing: 0.2,
    pressureSize: true, pressureFlow: true, minSize: 0.7, minFlow: 0.15,
  },
  chalk: {
    name: 'Chalk', icon: 'brush',
    size: 28, opacity: 1, flow: 0.65, hardness: 1, spacing: 0.22, smoothing: 0.2,
    pressureSize: true, pressureFlow: true, minSize: 0.7, minFlow: 0.5,
    texture: 'speckle', textureAmount: 0.9, rotateRandom: true,
  },
};

export const ERASER = {
  name: 'Eraser', icon: 'eraser',
  size: 30, opacity: 1, flow: 1, hardness: 0.9, spacing: 0.1, smoothing: 0.25,
  pressureSize: true, pressureFlow: false, minSize: 0.5, minFlow: 1,
  blend: 'destination-out',
};

export const ADJUSTABLE = ['size', 'opacity', 'flow', 'hardness', 'spacing', 'smoothing', 'pressureSize', 'pressureFlow'];

// ---------- stamp cache ----------
const stampCache = new Map();

function noiseStamp(ctx, S, texture, amount) {
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  if (texture === 'grain') {
    for (let i = 3; i < d.length; i += 4) {
      const n = Math.random();
      d[i] = d[i] * (1 - amount * n * n);
    }
  } else if (texture === 'speckle') {
    // chalk / charcoal: coarse 2×2 speckles that leave visible gaps
    const cell = Math.max(1, Math.round(S / 48));
    for (let y = 0; y < S; y += cell) {
      for (let x = 0; x < S; x += cell) {
        const keep = Math.random() < 0.55 ? 1 : 1 - amount * (0.6 + Math.random() * 0.4);
        for (let yy = y; yy < Math.min(S, y + cell); yy++) {
          for (let xx = x; xx < Math.min(S, x + cell); xx++) d[(yy * S + xx) * 4 + 3] *= keep;
        }
      }
    }
  } else if (texture === 'bristle') {
    // streaks along the x axis: bands of 1–3 rows share a random intensity, lightly varied per pixel
    const rows = new Float32Array(S);
    let y = 0;
    while (y < S) {
      const band = 1 + Math.floor(Math.random() * Math.max(1, S / 40));
      const v = Math.random();
      for (let k = 0; k < band && y < S; k++, y++) rows[y] = v;
    }
    for (let yy = 0; yy < S; yy++) {
      const r = rows[yy];
      for (let x = 0; x < S; x++) {
        const i = (yy * S + x) * 4 + 3;
        const n = r * 0.85 + Math.random() * 0.15;
        d[i] = d[i] * (1 - amount * n);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Returns a cached stamp canvas for the given colour / hardness / texture.
 * The stamp is drawn at full alpha; flow is applied through globalAlpha per dab.
 */
export function getStamp(hex, hardness, texture, textureAmount, S) {
  const key = `${hex}|${hardness.toFixed(2)}|${texture || ''}|${textureAmount || 0}|${S}`;
  let c = stampCache.get(key);
  if (c) return c;
  c = createCanvas(S, S);
  const ctx = c.getContext('2d');
  const r = S / 2;
  const { r: cr, g: cg, b: cb } = hexToRgb(hex);
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  const inner = Math.min(0.985, Math.max(0, hardness));
  grad.addColorStop(0, `rgba(${cr},${cg},${cb},1)`);
  if (hardness >= 0.999) {
    grad.addColorStop(0.985, `rgba(${cr},${cg},${cb},1)`);
    grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
  } else {
    grad.addColorStop(inner, `rgba(${cr},${cg},${cb},1)`);
    // soft falloff curve
    const steps = 6;
    for (let i = 1; i < steps; i++) {
      const t = inner + (1 - inner) * (i / steps);
      const a = Math.pow(1 - i / steps, 1.6);
      grad.addColorStop(t, `rgba(${cr},${cg},${cb},${a.toFixed(3)})`);
    }
    grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, S, S);
  if (texture) noiseStamp(ctx, S, texture, textureAmount);
  if (stampCache.size > 64) stampCache.delete(stampCache.keys().next().value);
  stampCache.set(key, c);
  return c;
}

function stampSizeFor(size) {
  if (size <= 24) return 64;
  if (size <= 120) return 128;
  return 256;
}

// ---------- stroke ----------
export class Stroke {
  /**
   * @param {object} o
   * @param {HTMLCanvasElement} o.buffer   stroke buffer (document size)
   * @param {object} o.brush               preset merged with user settings
   * @param {string} o.color               hex colour
   * @param {string} o.symmetry            'none' | 'h' | 'v' | 'both'
   * @param {number} o.width  o.height     document size
   */
  constructor(o) {
    this.buffer = o.buffer;
    this.bctx = o.buffer.getContext('2d');
    this.brush = o.brush;
    this.color = o.color;
    this.symmetry = o.symmetry || 'none';
    this.W = o.width;
    this.H = o.height;
    this.rect = null;
    this.carry = 0;
    this.last = null;      // last smoothed point
    this.rawLast = null;
    this.angle = 0;
    this.dabCount = 0;
    const S = stampSizeFor(this.brush.size);
    this.stamp = getStamp(this.color, this.brush.hardness, this.brush.texture, this.brush.textureAmount, S);
    this.bctx.save();
    this.bctx.setTransform(1, 0, 0, 1, 0, 0);
    this.bctx.globalCompositeOperation = 'source-over';
    this.bctx.imageSmoothingEnabled = true;
    this.bctx.imageSmoothingQuality = 'medium';
  }

  get alpha() { return this.brush.opacity; }
  get op() { return this.brush.blend || 'source-over'; }

  _size(p) {
    const b = this.brush;
    return b.pressureSize ? b.size * (b.minSize + (1 - b.minSize) * p) : b.size;
  }
  _flow(p) {
    const b = this.brush;
    return b.pressureFlow ? b.flow * (b.minFlow + (1 - b.minFlow) * p) : b.flow;
  }

  begin(x, y, p) {
    this.last = { x, y, p };
    this.rawLast = { x, y, p };
    this.carry = 0;
    this._dab(x, y, p);
  }

  move(x, y, p) {
    if (!this.last) { this.begin(x, y, p); return; }
    const k = this.brush.smoothing;
    const sx = this.last.x + (x - this.last.x) * (1 - k);
    const sy = this.last.y + (y - this.last.y) * (1 - k);
    this._segment(sx, sy, p);
    this.rawLast = { x, y, p };
  }

  /** Finish: catch up to the raw pointer position so the stroke ends where the pen lifted. */
  end() {
    if (this.rawLast && this.last) {
      const dx = this.rawLast.x - this.last.x, dy = this.rawLast.y - this.last.y;
      if (Math.hypot(dx, dy) > 0.5) this._segment(this.rawLast.x, this.rawLast.y, this.rawLast.p);
    }
    this.bctx.restore();
    return this.rect;
  }

  cancel() {
    this.bctx.restore();
    this.clearBuffer();
  }

  clearBuffer() {
    if (!this.rect) return;
    const r = this.rect;
    this.bctx.save();
    this.bctx.setTransform(1, 0, 0, 1, 0, 0);
    this.bctx.clearRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    this.bctx.restore();
  }

  _segment(x2, y2, p2) {
    const { x: x1, y: y1, p: p1 } = this.last;
    const dx = x2 - x1, dy = y2 - y1;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.01) { this.last = { x: x2, y: y2, p: p2 }; return; }
    this.angle = Math.atan2(dy, dx);
    let t = 0;
    let travelled = this.carry;
    // step distance adapts to the size at the current pressure
    while (true) {
      const pNow = p1 + (p2 - p1) * t;
      const step = Math.max(0.35, this.brush.spacing * this._size(pNow));
      const need = step - travelled;
      if (need > dist * (1 - t)) { travelled += dist * (1 - t); break; }
      t += need / dist;
      travelled = 0;
      const px = x1 + dx * t, py = y1 + dy * t, pp = p1 + (p2 - p1) * t;
      this._dab(px, py, pp);
    }
    this.carry = travelled;
    this.last = { x: x2, y: y2, p: p2 };
  }

  _dab(x, y, p) {
    const d = Math.max(0.5, this._size(p));
    const flow = Math.min(1, Math.max(0.004, this._flow(p)));
    const b = this.brush;
    let rot = 0;
    if (b.rotateToStroke) rot = this.angle;
    else if (b.rotateRandom) rot = Math.random() * Math.PI * 2;
    this._stampAt(x, y, d, flow, rot);
    if (this.symmetry === 'h' || this.symmetry === 'both') this._stampAt(this.W - x, y, d, flow, Math.PI - rot);
    if (this.symmetry === 'v' || this.symmetry === 'both') this._stampAt(x, this.H - y, d, flow, -rot);
    if (this.symmetry === 'both') this._stampAt(this.W - x, this.H - y, d, flow, rot + Math.PI);
    this.dabCount++;
  }

  _stampAt(x, y, d, flow, rot) {
    const ctx = this.bctx;
    ctx.globalAlpha = flow;
    if (rot) {
      ctx.setTransform(1, 0, 0, 1, x, y);
      ctx.rotate(rot);
      ctx.drawImage(this.stamp, -d / 2, -d / 2, d, d);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      ctx.drawImage(this.stamp, x - d / 2, y - d / 2, d, d);
    }
    const pad = d / 2 + 2;
    this.rect = unionRect(this.rect, { x: x - pad, y: y - pad, w: pad * 2, h: pad * 2 });
  }
}

/** Composite a finished stroke buffer onto a layer within `rect` (already clamped). */
export function compositeStroke(layer, buffer, rect, alpha, op) {
  const ctx = layer.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = op;
  ctx.drawImage(buffer, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}
