// ChromaCanvas Pro — colour utilities and the HSV colour picker widget.

import { Emitter } from './state.js';

export function hexToRgb(hex) {
  let h = (hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return { r: 0, g: 0, b: 0 };
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

export function normalizeHex(input) {
  let h = (input || '').trim();
  if (!h.startsWith('#')) h = '#' + h;
  if (/^#[0-9a-f]{3}$/i.test(h)) h = '#' + h.slice(1).split('').map((c) => c + c).join('');
  if (!/^#[0-9a-f]{6}$/i.test(h)) return null;
  return h.toUpperCase();
}

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb(h, s, v) {
  const c = v * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export function hexToRgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Relative luminance 0..1 (used to pick a readable handle outline). */
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export const DEFAULT_SWATCHES = [
  '#000000', '#3F3F46', '#71717A', '#A1A1AA', '#D4D4D8', '#FFFFFF', '#7F1D1D', '#991B1B', '#DC2626', '#F87171',
  '#9A3412', '#EA580C', '#FB923C', '#FDBA74', '#A16207', '#EAB308', '#FACC15', '#FEF08A', '#365314', '#16A34A',
  '#4ADE80', '#86EFAC', '#115E59', '#0D9488', '#2DD4BF', '#0C4A6E', '#0284C7', '#38BDF8', '#1E3A8A', '#2563EB',
  '#60A5FA', '#93C5FD', '#4C1D95', '#7C3AED', '#A78BFA', '#C4B5FD', '#831843', '#DB2777', '#F472B6', '#FBCFE8',
  '#78350F', '#B45309', '#D97706', '#FBBF24', '#F5E6CF', '#E7C9A5', '#C68E5D', '#8D5B3A', '#5A3A24', '#2D1B10',
];

/**
 * HSV picker: saturation/value square + hue bar + hex field.
 * Emits 'input' (while dragging) and 'change' (final) with the hex value.
 */
export class ColorPicker extends Emitter {
  constructor(els) {
    super();
    this.sv = els.sv;             // canvas
    this.svHandle = els.svHandle;
    this.hue = els.hue;           // canvas
    this.hueHandle = els.hueHandle;
    this.hexInput = els.hexInput;
    this.preview = els.preview;
    this.h = 213; this.s = 0.62; this.v = 0.98;
    this._drawHue();
    this._bind();
    this.setHex('#60A5FA', true);
  }

  get hex() {
    const { r, g, b } = hsvToRgb(this.h, this.s, this.v);
    return rgbToHex(r, g, b);
  }

  setHex(hex, silent = false) {
    const n = normalizeHex(hex);
    if (!n) return false;
    const { r, g, b } = hexToRgb(n);
    const hsv = rgbToHsv(r, g, b);
    // keep the current hue for greys so the square does not jump
    if (hsv.s > 0.0001 && hsv.v > 0.0001) this.h = hsv.h;
    this.s = hsv.s; this.v = hsv.v;
    this._refresh();
    if (!silent) this.emit('change', this.hex);
    return true;
  }

  _bind() {
    const drag = (canvas, onMove) => {
      let active = false;
      canvas.addEventListener('pointerdown', (e) => {
        active = true;
        canvas.setPointerCapture(e.pointerId);
        onMove(e);
        e.preventDefault();
      });
      canvas.addEventListener('pointermove', (e) => { if (active) onMove(e); });
      const stop = (e) => {
        if (!active) return;
        active = false;
        try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        this.emit('change', this.hex);
      };
      canvas.addEventListener('pointerup', stop);
      canvas.addEventListener('pointercancel', stop);
    };
    drag(this.sv, (e) => {
      const r = this.sv.getBoundingClientRect();
      this.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      this.v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      this._refresh();
      this.emit('input', this.hex);
    });
    drag(this.hue, (e) => {
      const r = this.hue.getBoundingClientRect();
      this.h = Math.min(359.99, Math.max(0, ((e.clientX - r.left) / r.width) * 360));
      this._refresh();
      this.emit('input', this.hex);
    });
    this.hexInput.addEventListener('change', () => {
      if (!this.setHex(this.hexInput.value)) this.hexInput.value = this.hex;
    });
    this.hexInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { this.hexInput.blur(); } e.stopPropagation(); });
    this.hexInput.addEventListener('focus', () => this.hexInput.select());
  }

  _drawHue() {
    const ctx = this.hue.getContext('2d');
    const w = this.hue.width, h = this.hue.height;
    const g = ctx.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 6; i++) {
      const { r, gg, b } = (() => { const c = hsvToRgb(i * 60, 1, 1); return { r: c.r, gg: c.g, b: c.b }; })();
      g.addColorStop(i / 6, `rgb(${r | 0},${gg | 0},${b | 0})`);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  _drawSV() {
    const ctx = this.sv.getContext('2d');
    const w = this.sv.width, h = this.sv.height;
    const { r, g, b } = hsvToRgb(this.h, 1, 1);
    ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    ctx.fillRect(0, 0, w, h);
    const white = ctx.createLinearGradient(0, 0, w, 0);
    white.addColorStop(0, 'rgba(255,255,255,1)');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = white;
    ctx.fillRect(0, 0, w, h);
    const black = ctx.createLinearGradient(0, 0, 0, h);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = black;
    ctx.fillRect(0, 0, w, h);
  }

  _refresh() {
    this._drawSV();
    const hex = this.hex;
    this.svHandle.style.left = `${this.s * 100}%`;
    this.svHandle.style.top = `${(1 - this.v) * 100}%`;
    this.svHandle.style.background = hex;
    this.hueHandle.style.left = `${(this.h / 360) * 100}%`;
    const hc = hsvToRgb(this.h, 1, 1);
    this.hueHandle.style.background = `rgb(${hc.r | 0},${hc.g | 0},${hc.b | 0})`;
    if (document.activeElement !== this.hexInput) this.hexInput.value = hex;
    if (this.preview) this.preview.style.background = hex;
  }
}
