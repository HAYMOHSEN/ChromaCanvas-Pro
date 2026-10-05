// ChromaCanvas Pro — UI building blocks: toasts, menus, dialogs, layers panel, pickers.

import { icon } from './icons.js';
import { BLEND_MODES } from './state.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// ---------- toasts ----------
export class Toasts {
  constructor(container) { this.container = container; }
  show(message, type = 'info', { duration = 3200, action = null } = {}) {
    const icons = { info: 'info', success: 'circle-check', error: 'circle-alert', warning: 'circle-alert' };
    const t = el('div', { class: `toast ${type}`, role: 'status', html: icon(icons[type] || 'info') });
    t.append(el('span', { text: message }));
    if (action) {
      const b = el('button', { class: 'btn small primary', text: action.label });
      b.addEventListener('click', () => { action.onClick(); remove(); });
      t.append(b);
    }
    this.container.append(t);
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      t.classList.add('out');
      setTimeout(() => t.remove(), 260);
    };
    if (duration > 0) setTimeout(remove, duration);
    return remove;
  }
}

// ---------- menus ----------
export class MenuBar {
  /**
   * @param {HTMLElement} container
   * @param {Array<{label:string, items:Array}>} menus
   * item: { label, key, action, icon, enabled?():boolean, checked?():boolean, type?: 'sep'|'title', danger?:boolean }
   */
  constructor(container, menus) {
    this.container = container;
    this.menus = menus;
    this.openIndex = -1;
    this.popup = null;
    this.buttons = menus.map((m, i) => {
      const b = el('button', { class: 'menu-btn', text: m.label, role: 'menuitem', 'aria-haspopup': 'true', 'aria-expanded': 'false' });
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); this.toggle(i); });
      b.addEventListener('pointerenter', () => { if (this.openIndex >= 0 && this.openIndex !== i) this.open(i); });
      container.append(b);
      return b;
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.openIndex < 0) return;
      if (this.popup?.contains(e.target) || this.container.contains(e.target)) return;
      this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (this.openIndex < 0) return;
      if (e.key === 'Escape') { this.close(); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { this.open((this.openIndex + 1) % this.menus.length); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { this.open((this.openIndex - 1 + this.menus.length) % this.menus.length); e.preventDefault(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = $$('.menu-item:not(:disabled)', this.popup);
        if (!items.length) return;
        const cur = items.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown' ? (cur + 1) % items.length : (cur - 1 + items.length) % items.length;
        items[next].focus();
        e.preventDefault();
      }
    });
    window.addEventListener('blur', () => this.close());
    window.addEventListener('resize', () => this.close());
  }

  get isOpen() { return this.openIndex >= 0; }

  toggle(i) { if (this.openIndex === i) this.close(); else this.open(i); }

  open(i) {
    this.close();
    this.openIndex = i;
    const btn = this.buttons[i];
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    const popup = el('div', { class: 'menu-popup', role: 'menu' });
    for (const item of this.menus[i].items) {
      if (item.type === 'sep') { popup.append(el('div', { class: 'menu-sep' })); continue; }
      if (item.type === 'title') { popup.append(el('div', { class: 'menu-title', text: item.label })); continue; }
      const enabled = item.enabled ? !!item.enabled() : true;
      const checked = item.checked ? !!item.checked() : null;
      const b = el('button', { class: `menu-item${item.danger ? ' danger' : ''}`, role: 'menuitem', type: 'button' });
      if (!enabled) b.disabled = true;
      b.append(el('span', { class: 'mi-check', html: checked === true ? icon('check') : '' }));
      if (item.icon) b.insertAdjacentHTML('beforeend', icon(item.icon));
      b.append(el('span', { class: 'mi-label', text: item.label }));
      if (item.key) b.append(el('span', { class: 'mi-key', text: item.key }));
      b.addEventListener('click', () => { this.close(); item.action?.(); });
      popup.append(b);
    }
    document.body.append(popup);
    const r = btn.getBoundingClientRect();
    const pw = popup.offsetWidth;
    popup.style.left = `${Math.max(4, Math.min(window.innerWidth - pw - 4, r.left))}px`;
    popup.style.top = `${r.bottom + 2}px`;
    const maxH = window.innerHeight - r.bottom - 12;
    popup.style.maxHeight = `${maxH}px`;
    popup.style.overflowY = 'auto';
    this.popup = popup;
  }

  close() {
    if (this.openIndex < 0) return;
    this.buttons[this.openIndex].classList.remove('open');
    this.buttons[this.openIndex].setAttribute('aria-expanded', 'false');
    this.openIndex = -1;
    this.popup?.remove();
    this.popup = null;
  }
}

// ---------- dialogs ----------
export function wireDialogs() {
  $$('dialog.dialog').forEach((dlg) => {
    $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => dlg.close('cancel')));
    // close when clicking the backdrop
    dlg.addEventListener('pointerdown', (e) => {
      if (e.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close('cancel');
    });
  });
}

export function openDialog(dlg) {
  if (dlg.open) return;
  dlg.returnValue = '';
  dlg.showModal();
  const first = dlg.querySelector('input:not([type=hidden]):not([type=radio]):not([type=color]), select, button.primary');
  first?.focus?.();
}

/** Returns a promise resolving to 'ok' | 'alt' | 'cancel'. */
export function confirmDialog({ title, message, ok = 'OK', cancel = 'Cancel', alt = null, danger = false }) {
  const dlg = $('#dlg-confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-msg').textContent = message;
  const okBtn = $('#confirm-ok');
  const altBtn = $('#confirm-alt');
  okBtn.textContent = ok;
  okBtn.classList.toggle('danger', danger);
  okBtn.classList.toggle('primary', !danger);
  $('#confirm-cancel').textContent = cancel;
  altBtn.classList.toggle('hidden', !alt);
  if (alt) altBtn.textContent = alt;
  return new Promise((resolve) => {
    const onAlt = () => { dlg.close('alt'); };
    altBtn.addEventListener('click', onAlt, { once: true });
    dlg.addEventListener('close', () => {
      altBtn.removeEventListener('click', onAlt);
      resolve(dlg.returnValue === 'ok' ? 'ok' : dlg.returnValue === 'alt' ? 'alt' : 'cancel');
    }, { once: true });
    openDialog(dlg);
    okBtn.focus();
  });
}

// ---------- pickers / selects ----------
export function fillBlendSelect(select) {
  select.innerHTML = '';
  for (const [value, label] of BLEND_MODES) select.append(el('option', { value, text: label }));
}

export const FONTS = ['Segoe UI', 'Arial', 'Bahnschrift', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas', 'Courier New', 'Georgia', 'Impact', 'Segoe Print', 'Segoe Script', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];

export function fillFontSelect(select) {
  select.innerHTML = '';
  for (const f of FONTS) {
    const o = el('option', { value: f, text: f });
    o.style.fontFamily = `"${f}"`;
    select.append(o);
  }
}

export const CANVAS_PRESETS = [
  { label: 'Full HD — 1920 × 1080', w: 1920, h: 1080 },
  { label: '4K UHD — 3840 × 2160', w: 3840, h: 2160 },
  { label: 'Square — 2048 × 2048', w: 2048, h: 2048 },
  { label: 'Instagram post — 1080 × 1080', w: 1080, h: 1080 },
  { label: 'Instagram story — 1080 × 1920', w: 1080, h: 1920 },
  { label: 'A4 300 dpi — 2480 × 3508', w: 2480, h: 3508 },
  { label: 'A4 landscape 300 dpi — 3508 × 2480', w: 3508, h: 2480 },
  { label: 'US Letter 300 dpi — 2550 × 3300', w: 2550, h: 3300 },
  { label: 'HD — 1280 × 720', w: 1280, h: 720 },
  { label: 'Small — 800 × 600', w: 800, h: 600 },
  { label: 'Custom', w: 0, h: 0 },
];

export function fillPresetSelect(select) {
  select.innerHTML = '';
  CANVAS_PRESETS.forEach((p, i) => select.append(el('option', { value: String(i), text: p.label })));
}

export function buildSwatches(container, colors, onPick) {
  container.innerHTML = '';
  for (const c of colors) {
    const b = el('button', { class: 'swatch', title: c, 'aria-label': `Colour ${c}`, type: 'button' });
    b.style.background = c;
    b.dataset.color = c;
    b.addEventListener('click', (e) => onPick(c, e.shiftKey));
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); onPick(c, true); });
    container.append(b);
  }
}

export function buildRecent(container, colors, onPick, max = 10) {
  container.innerHTML = '';
  for (let i = 0; i < max; i++) {
    const c = colors[i];
    if (!c) { container.append(el('span', { class: 'swatch empty' })); continue; }
    const b = el('button', { class: 'swatch', title: c, type: 'button' });
    b.style.background = c;
    b.dataset.color = c;
    b.addEventListener('click', (e) => onPick(c, e.shiftKey));
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); onPick(c, true); });
    container.append(b);
  }
}

export function buildBrushGrid(container, brushes, current, onPick) {
  container.innerHTML = '';
  for (const [id, b] of Object.entries(brushes)) {
    const t = el('button', { class: `brush-tile${id === current ? ' active' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(id === current), title: b.name, html: icon(b.icon) });
    t.dataset.brush = id;
    t.append(el('span', { text: b.name }));
    t.addEventListener('click', () => onPick(id));
    container.append(t);
  }
}

export function buildShortcuts(container, sections) {
  container.innerHTML = '';
  for (const s of sections) {
    container.append(el('h4', { text: s.title }));
    for (const [label, keys] of s.items) {
      const row = el('div', { class: 'shortcut' });
      row.append(el('span', { text: label }));
      const k = el('span', { class: 'keys' });
      for (const key of keys.split(' ')) k.append(el('kbd', { text: key }));
      row.append(k);
      container.append(row);
    }
  }
}

// ---------- layers panel ----------
export class LayersPanel {
  constructor(app, els) {
    this.app = app;
    this.list = els.list;
    this.blend = els.blend;
    this.opacity = els.opacity;
    this.opacityVal = els.opacityVal;
    this.doc = null;
    this._unbind = [];
    this._thumbTimers = new Map();
    this._drag = null;

    this.blend.addEventListener('change', () => {
      const l = this.doc?.active; if (!l) return;
      this.app.ops.setLayerProps(l, { blend: this.blend.value }, 'Blend mode');
    });
    let opacityBefore = null;
    this.opacity.addEventListener('input', () => {
      const l = this.doc?.active; if (!l) return;
      if (opacityBefore === null) opacityBefore = l.opacity;
      this.doc.setLayerProps(l, { opacity: this.opacity.valueAsNumber / 100 });
      this.opacityVal.textContent = `${this.opacity.value}%`;
    });
    this.opacity.addEventListener('change', () => {
      const l = this.doc?.active; if (!l) return;
      const before = opacityBefore ?? l.opacity;
      opacityBefore = null;
      const after = this.opacity.valueAsNumber / 100;
      if (before === after) return;
      const doc = this.doc;
      this.app.history.push({
        label: 'Layer opacity', bytes: 0,
        undo: () => doc.setLayerProps(l, { opacity: before }),
        redo: () => doc.setLayerProps(l, { opacity: after }),
      });
    });
  }

  bind(doc) {
    this._unbind.forEach((fn) => fn());
    this.doc = doc;
    this._unbind = [
      doc.on('structure', (p) => {
        const keys = p?.props ? Object.keys(p.props) : null;
        if (keys && keys.every((k) => k === 'opacity' || k === 'blend')) {
          // cheap in-place update while the opacity slider is being dragged
          if (p.layer === doc.active) {
            this.blend.value = p.layer.blend;
            this.opacity.value = Math.round(p.layer.opacity * 100);
            this.opacityVal.textContent = `${Math.round(p.layer.opacity * 100)}%`;
          }
          return;
        }
        this.render();
      }),
      doc.on('active', () => this.render()),
      doc.on('resize', () => this.render()),
      doc.on('pixels', ({ layer }) => this.scheduleThumb(layer)),
    ];
    this.render();
  }

  render() {
    const doc = this.doc;
    if (!doc) return;
    this.list.innerHTML = '';
    const n = doc.layers.length;
    for (let i = n - 1; i >= 0; i--) {
      const layer = doc.layers[i];
      const li = el('li', { class: `layer-item${i === doc.activeIndex ? ' active' : ''}${layer.visible ? '' : ' hidden-layer'}`, role: 'option', 'aria-selected': String(i === doc.activeIndex), draggable: 'true' });
      li.dataset.id = layer.id;
      const eye = el('button', { class: `icon-btn xs${layer.visible ? ' on' : ''}`, title: layer.visible ? 'Hide layer' : 'Show layer', type: 'button', html: icon(layer.visible ? 'eye' : 'eye-off') });
      eye.addEventListener('click', (e) => { e.stopPropagation(); this.app.ops.toggleVisible(layer); });
      const thumb = el('canvas', { class: 'layer-thumb', width: '44', height: '30' });
      const name = el('span', { class: 'layer-name', text: layer.name, title: 'Double-click to rename' });
      const lock = el('button', { class: `icon-btn xs${layer.locked ? ' on' : ''}`, title: layer.locked ? 'Unlock layer' : 'Lock layer', type: 'button', html: icon(layer.locked ? 'lock' : 'lock-open') });
      lock.addEventListener('click', (e) => { e.stopPropagation(); this.app.ops.toggleLocked(layer); });
      li.append(eye, thumb, name, lock);
      li.addEventListener('click', () => doc.setActive(layer));
      li.addEventListener('dblclick', (e) => { e.preventDefault(); this.startRename(layer); });
      // drag & drop reorder
      li.addEventListener('dragstart', (e) => { this._drag = layer; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', layer.id); });
      li.addEventListener('dragend', () => { this._drag = null; li.classList.remove('dragging'); this._clearDropMarks(); });
      li.addEventListener('dragover', (e) => {
        if (!this._drag || this._drag === layer) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = li.getBoundingClientRect();
        const above = e.clientY < r.top + r.height / 2;
        this._clearDropMarks();
        li.classList.add(above ? 'drop-above' : 'drop-below');
      });
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        const src = this._drag; this._drag = null; this._clearDropMarks();
        if (!src || src === layer) return;
        const r = li.getBoundingClientRect();
        const above = e.clientY < r.top + r.height / 2;
        const from = doc.indexOf(src);
        let to = doc.indexOf(layer) + (above ? 1 : 0);
        if (from < to) to -= 1;
        this.app.ops.moveLayer(from, to);
      });
      this.list.append(li);
      this.drawThumb(layer, thumb);
    }
    const active = doc.active;
    if (active) {
      this.blend.value = active.blend;
      this.opacity.value = Math.round(active.opacity * 100);
      this.opacityVal.textContent = `${Math.round(active.opacity * 100)}%`;
    }
    this.app.updateLayerButtons?.();
  }

  _clearDropMarks() { $$('.layer-item', this.list).forEach((n) => n.classList.remove('drop-above', 'drop-below')); }

  startRename(layer) {
    const li = this.list.querySelector(`[data-id="${layer.id}"]`);
    if (!li) return;
    const nameEl = li.querySelector('.layer-name');
    const input = el('input', { class: 'layer-name-input', type: 'text', value: layer.name, maxlength: '40' });
    nameEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (commit && v && v !== layer.name) this.app.ops.setLayerProps(layer, { name: v }, 'Rename layer');
      else this.render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  scheduleThumb(layer) {
    if (this._thumbTimers.has(layer.id)) return;
    this._thumbTimers.set(layer.id, setTimeout(() => {
      this._thumbTimers.delete(layer.id);
      const li = this.list.querySelector(`[data-id="${layer.id}"]`);
      if (li) this.drawThumb(layer, li.querySelector('.layer-thumb'));
    }, 180));
  }

  drawThumb(layer, canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const s = Math.min(canvas.width / layer.width, canvas.height / layer.height);
    const w = layer.width * s, h = layer.height * s;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(layer.canvas, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }
}
