// ChromaCanvas Pro — application bootstrap and wiring.

import { mountIcons, icon } from './icons.js';
import { Document, createCanvas, MAX_DIM } from './state.js';
import { History } from './history.js';
import { Renderer } from './renderer.js';
import { BRUSHES, ERASER, ADJUSTABLE } from './brush.js';
import { ToolController, TextTool, TOOL_INFO } from './tools.js';
import { Ops } from './ops.js';
import { ColorPicker, DEFAULT_SWATCHES, normalizeHex } from './color.js';
import {
  loadSettings, saveSettings, Autosave, canvasToBlob, blobToImage, documentToProjectJSON, projectFromJSON,
  saveBlob, pickFiles, IMAGE_TYPES, PROJECT_TYPES, OPEN_TYPES, PROJECT_EXT, PROJECT_MIME, isProjectFile, isImageFile, timestampName,
} from './storage.js';
import {
  $, $$, el, Toasts, MenuBar, wireDialogs, openDialog, confirmDialog, fillBlendSelect, fillFontSelect, fillPresetSelect,
  CANVAS_PRESETS, buildSwatches, buildRecent, buildBrushGrid, buildShortcuts, LayersPanel,
} from './ui.js';

export const APP_VERSION = '1.0.0';

const DEFAULTS = {
  theme: 'dark', touchDraws: true, showGrid: false, panel: 'visible',
  tool: 'brush', brushPreset: 'pencil', brushes: {}, eraser: {},
  shape: { mode: 'stroke', width: 6, opacity: 1 },
  fill: { tolerance: 32, sampleAll: true, opacity: 1 },
  text: { font: 'Segoe UI', size: 48, bold: false, italic: false },
  symmetry: 'none',
  colors: { primary: '#60A5FA', secondary: '#FFFFFF' },
  recent: [],
  seenTips: false,
};

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

class App {
  constructor() {
    mountIcons();
    wireDialogs();
    this.settings = { ...DEFAULTS, ...loadSettings() };
    for (const k of ['shape', 'fill', 'text', 'colors']) this.settings[k] = { ...DEFAULTS[k], ...(this.settings[k] || {}) };
    this.settings.brushes = this.settings.brushes || {};
    this.settings.eraser = this.settings.eraser || {};
    this._saveTimer = 0;

    this.toasts = new Toasts($('#toasts'));
    this.history = new History();
    this.doc = null;
    this.ops = new Ops(this);
    this.renderer = new Renderer($('#view'), $('#overlay'), $('#workspace'));
    this.tools = new ToolController(this, $('#view'));
    this.textTool = new TextTool(this, { editor: $('#text-editor'), input: $('#text-input'), commit: $('#text-commit'), cancel: $('#text-cancel') });
    this.autosave = new Autosave((s) => this._setSaveStatus(s));
    this.layersPanel = new LayersPanel(this, { list: $('#layer-list'), blend: $('#sel-blend'), opacity: $('#sl-layer-opacity'), opacityVal: $('#val-layer-opacity') });

    this.colors = { ...this.settings.colors };
    this.symmetry = this.settings.symmetry;
    this.touchDraws = this.settings.touchDraws;
    this.shapeOpts = { ...this.settings.shape };
    this.fillOpts = { ...this.settings.fill };
    this.textOpts = { ...this.settings.text };
    this.brushPreset = BRUSHES[this.settings.brushPreset] ? this.settings.brushPreset : 'pencil';

    this._buildStaticUI();
    this._wireToolOptions();
    this._wireColorUI();
    this._wireLayerButtons();
    this._wireMenubarButtons();
    this._wireStatusBar();
    this._wireDialogs();
    this._wireKeyboard();
    this._wireClipboardAndDrop();
    this._wireGlobalBehaviour();
    this.applyTheme(this.settings.theme);
    this.setPanelVisible(this.settings.panel !== 'hidden');
    this.renderer.showGrid = !!this.settings.showGrid;
    this.renderer.symmetry = this.symmetry;

    this.history.on('change', () => this._updateUndoButtons());
    this.renderer.on('zoom', (z) => { $('#zoom-value').value = `${Math.round(z * 100)}%`; this.tools.updateCursor(); });
  }

  // =====================================================================
  // start-up
  // =====================================================================
  async init() {
    const params = new URLSearchParams(location.search);
    if (location.search) { try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ } }
    let doc = null;
    try { doc = await this.autosave.restore(); } catch { doc = null; }
    if (doc) {
      doc.modified = true; // restored work is only held by autosave — ask before replacing it
      this.setDocument(doc, { announce: false });
      this._setSaveStatus('saved');
    } else {
      this.setDocument(new Document(1920, 1080, 'white'), { announce: false });
    }
    this.tools.setTool(TOOL_INFO[this.settings.tool] ? this.settings.tool : 'brush');
    this._registerServiceWorker();
    this._setupLaunchQueue();
    const showTips = () => {
      if (this.settings.seenTips) return;
      openDialog($('#dlg-tips'));
      this.settings.seenTips = true;
      this.persist();
    };
    if (params.get('action') === 'new') {
      await this.newDocument();
      if ($('#dlg-new').open) $('#dlg-new').addEventListener('close', showTips, { once: true });
      else showTips();
    } else {
      showTips();
    }
    window.addEventListener('pagehide', () => this.autosave.flush(this.doc));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.autosave.flush(this.doc); });
  }

  setDocument(doc, { announce = true } = {}) {
    this.textTool.cancel();
    if (this._docUnbind) this._docUnbind.forEach((fn) => fn());
    this.doc = doc;
    this.history.clear();
    this.renderer.strokePreview = null;
    this.renderer.setDocument(doc);
    this.tools.ensureBuffer();
    this.layersPanel.bind(doc);
    this._docUnbind = [
      doc.on('change', () => this.autosave.schedule(doc)),
      doc.on('resize', () => { this.tools.ensureBuffer(); this._updateSizeStatus(); this.renderer.fit(); }),
      doc.on('active', () => this.updateLayerButtons()),
    ];
    this._updateSizeStatus();
    this._updateTitle();
    this.renderer.fit();
    this.updateLayerButtons();
    this._updateUndoButtons();
    this.autosave.schedule(doc, 400);
    if (announce) this.toast(`${doc.width} × ${doc.height} px canvas ready`, 'success');
  }

  // =====================================================================
  // static UI
  // =====================================================================
  _buildStaticUI() {
    fillBlendSelect($('#sel-blend'));
    fillFontSelect($('#sel-font'));
    fillPresetSelect($('#new-preset'));
    buildSwatches($('#swatches'), DEFAULT_SWATCHES, (c, secondary) => this.setColor(c, secondary ? 'secondary' : 'primary'));
    this._renderRecent();
    buildBrushGrid($('#brush-grid'), BRUSHES, this.brushPreset, (id) => this.setBrushPreset(id));
    $('#about-version').textContent = APP_VERSION;
    buildShortcuts($('#shortcuts-body'), this._shortcutSections());

    this.menubar = new MenuBar($('#menus'), this._menuDefinition());
    $$('.tool-btn[data-tool]').forEach((b) => b.addEventListener('click', () => this.tools.setTool(b.dataset.tool)));
  }

  _menuDefinition() {
    const h = this.history;
    const hasBelow = () => this.doc && this.doc.activeIndex > 0;
    const multi = () => this.doc && this.doc.layers.length > 1;
    return [
      { label: 'File', items: [
        { label: 'New canvas…', key: `${MOD}+N`, icon: 'file-plus', action: () => this.newDocument() },
        { label: 'Open…', key: `${MOD}+O`, icon: 'folder-open', action: () => this.openFiles() },
        { label: 'Import image as layer…', icon: 'image-plus', action: () => this.importImages() },
        { type: 'sep' },
        { label: 'Save project', key: `${MOD}+S`, icon: 'save', action: () => this.saveProject(false) },
        { label: 'Save project as…', key: `${MOD}+Shift+S`, icon: 'save-all', action: () => this.saveProject(true) },
        { label: 'Export image…', key: `${MOD}+Shift+E`, icon: 'download', action: () => this.exportImage() },
      ] },
      { label: 'Edit', items: [
        { label: 'Undo', key: `${MOD}+Z`, icon: 'undo-2', enabled: () => h.canUndo, action: () => this.undo() },
        { label: 'Redo', key: `${MOD}+Y`, icon: 'redo-2', enabled: () => h.canRedo, action: () => this.redo() },
        { type: 'sep' },
        { label: 'Copy image to clipboard', key: `${MOD}+C`, icon: 'clipboard-copy', action: () => this.copyImage() },
        { label: 'Paste image as layer', key: `${MOD}+V`, icon: 'clipboard-paste', action: () => this.pasteFromClipboard() },
        { type: 'sep' },
        { label: 'Clear layer', key: 'Delete', icon: 'file-x', action: () => this.ops.clearLayer() },
      ] },
      { label: 'Image', items: [
        { label: 'Canvas size…', icon: 'crop', action: () => this.openCanvasSize() },
        { label: 'Resize image…', icon: 'scaling', action: () => this.openImageSize() },
        { type: 'sep' },
        { label: 'Flip horizontal', icon: 'flip-horizontal', action: () => this.ops.flipImage(true) },
        { label: 'Flip vertical', icon: 'flip-vertical', action: () => this.ops.flipImage(false) },
        { label: 'Rotate 90° clockwise', icon: 'rotate-cw', action: () => this.ops.rotateImage(90) },
        { label: 'Rotate 90° counter-clockwise', icon: 'rotate-ccw', action: () => this.ops.rotateImage(270) },
        { label: 'Rotate 180°', action: () => this.ops.rotateImage(180) },
        { type: 'sep' },
        { label: 'Flatten image', icon: 'combine', enabled: multi, action: () => this.ops.flatten() },
      ] },
      { label: 'Layer', items: [
        { label: 'New layer', key: `${MOD}+Shift+N`, icon: 'plus', action: () => this.ops.addLayer() },
        { label: 'Duplicate layer', key: `${MOD}+J`, icon: 'copy', action: () => this.ops.duplicateLayer() },
        { label: 'Delete layer', icon: 'trash-2', enabled: multi, danger: true, action: () => this.ops.deleteLayer() },
        { label: 'Rename layer…', key: 'F2', action: () => this.layersPanel.startRename(this.doc.active) },
        { type: 'sep' },
        { label: 'Merge down', key: `${MOD}+E`, icon: 'arrow-down-to-line', enabled: hasBelow, action: () => this.ops.mergeDown() },
        { label: 'Move layer up', enabled: () => this.doc && this.doc.activeIndex < this.doc.layers.length - 1, action: () => this.ops.moveActive(1) },
        { label: 'Move layer down', enabled: hasBelow, action: () => this.ops.moveActive(-1) },
        { type: 'sep' },
        { label: 'Flip layer horizontal', icon: 'flip-horizontal', action: () => this.ops.transformLayer(this.doc.active, 'flipH') },
        { label: 'Flip layer vertical', icon: 'flip-vertical', action: () => this.ops.transformLayer(this.doc.active, 'flipV') },
        { label: 'Rotate layer 90° clockwise', icon: 'rotate-cw', action: () => this.ops.transformLayer(this.doc.active, 'rot90') },
        { label: 'Rotate layer 90° counter-clockwise', icon: 'rotate-ccw', action: () => this.ops.transformLayer(this.doc.active, 'rot270') },
        { type: 'sep' },
        { label: 'Clear layer', key: 'Delete', icon: 'file-x', action: () => this.ops.clearLayer() },
      ] },
      { label: 'View', items: [
        { label: 'Zoom in', key: `${MOD}++`, icon: 'zoom-in', action: () => this.renderer.zoomStep(1) },
        { label: 'Zoom out', key: `${MOD}+-`, icon: 'zoom-out', action: () => this.renderer.zoomStep(-1) },
        { label: 'Fit to window', key: `${MOD}+0`, icon: 'maximize', action: () => this.renderer.fit() },
        { label: 'Actual size (100%)', key: `${MOD}+1`, icon: 'scan', action: () => this.renderer.setZoom(1) },
        { type: 'sep' },
        { label: 'Show grid', key: `${MOD}+'`, icon: 'grid-3x3', checked: () => this.renderer.showGrid, action: () => this.toggleGrid() },
        { label: 'Show panels', key: 'Tab', icon: 'panel-right', checked: () => this.panelVisible, action: () => this.setPanelVisible(!this.panelVisible) },
        { label: 'Touch draws (two fingers always pan & zoom)', checked: () => this.touchDraws, action: () => this.setTouchDraws(!this.touchDraws) },
        { type: 'sep' },
        { type: 'title', label: 'Theme' },
        { label: 'Dark', icon: 'moon', checked: () => this.settings.theme === 'dark', action: () => this.applyTheme('dark') },
        { label: 'Light', icon: 'sun', checked: () => this.settings.theme === 'light', action: () => this.applyTheme('light') },
        { label: 'Follow Windows setting', icon: 'monitor', checked: () => this.settings.theme === 'system', action: () => this.applyTheme('system') },
      ] },
      { label: 'Help', items: [
        { label: 'Quick start', icon: 'lightbulb', action: () => openDialog($('#dlg-tips')) },
        { label: 'Keyboard shortcuts', key: '?', icon: 'keyboard', action: () => openDialog($('#dlg-shortcuts')) },
        { type: 'sep' },
        { label: 'Privacy policy', icon: 'shield', action: () => window.open('privacy.html', '_blank', 'noopener') },
        { label: 'Contact support', icon: 'mail', action: () => { location.href = 'mailto:haymohsen@gmail.com?subject=ChromaCanvas%20Pro'; } },
        { label: 'About ChromaCanvas Pro', icon: 'info', action: () => openDialog($('#dlg-about')) },
      ] },
    ];
  }

  _shortcutSections() {
    return [
      { title: 'Tools', items: [
        ['Brush', 'B'], ['Eraser', 'E'], ['Fill', 'G'], ['Eyedropper', 'I'], ['Line', 'L'], ['Rectangle', 'R'], ['Ellipse', 'O'], ['Text', 'T'], ['Move layer', 'M'], ['Hand (pan)', 'H'],
        ['Pan while held', 'Space'], ['Pick color (any tool)', 'Alt+click'], ['Pick color (any tool)', 'Right-click'],
      ] },
      { title: 'Brush & color', items: [
        ['Smaller / larger brush', '[ ]'], ['Brush opacity 10%…100%', '1…9 0'], ['Swap primary / secondary', 'X'], ['Reset colors to black / white', 'D'],
        ['Set secondary color', 'Shift+click swatch'], ['Constrain shape', 'Shift+drag'],
      ] },
      { title: 'Edit', items: [
        ['Undo', `${MOD}+Z`], ['Redo', `${MOD}+Y`], ['Redo (alternative)', `${MOD}+Shift+Z`], ['Copy image', `${MOD}+C`], ['Paste image as layer', `${MOD}+V`], ['Clear layer', 'Delete'],
        ['Nudge layer (Move tool)', 'Arrows'], ['Nudge by 10 px', 'Shift+Arrows'],
      ] },
      { title: 'Layers', items: [
        ['New layer', `${MOD}+Shift+N`], ['New layer (alternative)', 'Insert'], ['Duplicate layer', `${MOD}+J`], ['Merge down', `${MOD}+E`], ['Rename layer', 'F2'],
      ] },
      { title: 'File', items: [
        ['New canvas', `${MOD}+N`], ['Open', `${MOD}+O`], ['Save project', `${MOD}+S`], ['Save project as', `${MOD}+Shift+S`], ['Export image', `${MOD}+Shift+E`],
      ] },
      { title: 'View', items: [
        ['Zoom in / out', `${MOD}+wheel`], ['Zoom in', `${MOD}++`], ['Zoom out', `${MOD}+-`], ['Fit to window', `${MOD}+0`], ['Actual size', `${MOD}+1`],
        ['Show / hide grid', `${MOD}+'`], ['Show / hide panels', 'Tab'], ['Keyboard shortcuts', '?'],
      ] },
    ];
  }

  // =====================================================================
  // tool options
  // =====================================================================
  getBrushSettings(kind = this.tools.tool === 'eraser' ? 'eraser' : 'brush') {
    if (kind === 'eraser') return { ...ERASER, ...this.settings.eraser };
    return { ...BRUSHES[this.brushPreset], ...(this.settings.brushes[this.brushPreset] || {}) };
  }

  _writeBrushSetting(key, value) {
    const kind = this.tools.tool === 'eraser' ? 'eraser' : 'brush';
    const target = kind === 'eraser' ? this.settings.eraser : (this.settings.brushes[this.brushPreset] ||= {});
    target[key] = value;
    this.persist();
    this.tools.updateCursor();
  }

  setBrushPreset(id) {
    if (!BRUSHES[id]) return;
    this.brushPreset = id;
    this.settings.brushPreset = id;
    $$('.brush-tile', $('#brush-grid')).forEach((t) => { const on = t.dataset.brush === id; t.classList.toggle('active', on); t.setAttribute('aria-checked', String(on)); });
    if (this.tools.tool !== 'brush') this.tools.setTool('brush');
    else this.onToolChanged('brush');
    this.persist();
  }

  onToolChanged(tool) {
    $$('.tool-btn[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    $$('.tool-opts').forEach((o) => o.classList.toggle('show', o.dataset.for.split(' ').includes(tool)));
    $('#tool-title').textContent = TOOL_INFO[tool].name;
    $('#tool-sub').textContent = tool === 'brush' ? BRUSHES[this.brushPreset].name : tool === 'eraser' ? '' : (TOOL_INFO[tool].key ? `Key ${TOOL_INFO[tool].key}` : '');
    this.settings.tool = tool;
    this.persist();
    this._syncBrushUI();
  }

  _syncBrushUI() {
    const tool = this.tools.tool;
    if (tool !== 'brush' && tool !== 'eraser') return;
    const b = this.getBrushSettings();
    const set = (id, v) => { const e = $(id); if (e) e.value = v; };
    set('#sl-size', b.size); set('#sl-opacity', Math.round(b.opacity * 100)); set('#sl-flow', Math.round(b.flow * 100));
    set('#sl-hardness', Math.round(b.hardness * 100)); set('#sl-spacing', Math.round(b.spacing * 100)); set('#sl-smoothing', Math.round(b.smoothing * 100));
    $('#chk-pressure-size').checked = !!b.pressureSize;
    $('#chk-pressure-flow').checked = !!b.pressureFlow;
    this._updateBrushLabels();
    $$('.seg-btn', $('#symmetry')).forEach((s) => s.classList.toggle('active', s.dataset.sym === this.symmetry));
  }

  _updateBrushLabels() {
    $('#val-size').textContent = `${$('#sl-size').value} px`;
    $('#val-opacity').textContent = `${$('#sl-opacity').value}%`;
    $('#val-flow').textContent = `${$('#sl-flow').value}%`;
    $('#val-hardness').textContent = `${$('#sl-hardness').value}%`;
    $('#val-spacing').textContent = `${$('#sl-spacing').value}%`;
    $('#val-smoothing').textContent = `${$('#sl-smoothing').value}%`;
  }

  _wireToolOptions() {
    const slider = (id, key, scale = 1) => {
      $(id).addEventListener('input', (e) => { this._writeBrushSetting(key, e.target.valueAsNumber / scale); this._updateBrushLabels(); });
    };
    slider('#sl-size', 'size'); slider('#sl-opacity', 'opacity', 100); slider('#sl-flow', 'flow', 100);
    slider('#sl-hardness', 'hardness', 100); slider('#sl-spacing', 'spacing', 100); slider('#sl-smoothing', 'smoothing', 100);
    $('#chk-pressure-size').addEventListener('change', (e) => this._writeBrushSetting('pressureSize', e.target.checked));
    $('#chk-pressure-flow').addEventListener('change', (e) => this._writeBrushSetting('pressureFlow', e.target.checked));
    $$('.seg-btn', $('#symmetry')).forEach((b) => b.addEventListener('click', () => this.setSymmetry(b.dataset.sym)));

    // shapes
    $$('.seg-btn', $('#shape-mode')).forEach((b) => b.addEventListener('click', () => {
      this.shapeOpts.mode = b.dataset.mode;
      $$('.seg-btn', $('#shape-mode')).forEach((x) => x.classList.toggle('active', x === b));
      this.settings.shape = { ...this.shapeOpts }; this.persist();
    }));
    $$('.seg-btn', $('#shape-mode')).forEach((x) => x.classList.toggle('active', x.dataset.mode === this.shapeOpts.mode));
    $('#sl-shape-width').value = this.shapeOpts.width; $('#val-shape-width').textContent = `${this.shapeOpts.width} px`;
    $('#sl-shape-opacity').value = Math.round(this.shapeOpts.opacity * 100); $('#val-shape-opacity').textContent = `${Math.round(this.shapeOpts.opacity * 100)}%`;
    $('#sl-shape-width').addEventListener('input', (e) => { this.shapeOpts.width = e.target.valueAsNumber; $('#val-shape-width').textContent = `${e.target.value} px`; this.settings.shape = { ...this.shapeOpts }; this.persist(); });
    $('#sl-shape-opacity').addEventListener('input', (e) => { this.shapeOpts.opacity = e.target.valueAsNumber / 100; $('#val-shape-opacity').textContent = `${e.target.value}%`; this.settings.shape = { ...this.shapeOpts }; this.persist(); });

    // fill
    $('#sl-tolerance').value = this.fillOpts.tolerance; $('#val-tolerance').textContent = this.fillOpts.tolerance;
    $('#sl-fill-opacity').value = Math.round(this.fillOpts.opacity * 100); $('#val-fill-opacity').textContent = `${Math.round(this.fillOpts.opacity * 100)}%`;
    $('#chk-fill-all').checked = !!this.fillOpts.sampleAll;
    $('#sl-tolerance').addEventListener('input', (e) => { this.fillOpts.tolerance = e.target.valueAsNumber; $('#val-tolerance').textContent = e.target.value; this.settings.fill = { ...this.fillOpts }; this.persist(); });
    $('#sl-fill-opacity').addEventListener('input', (e) => { this.fillOpts.opacity = e.target.valueAsNumber / 100; $('#val-fill-opacity').textContent = `${e.target.value}%`; this.settings.fill = { ...this.fillOpts }; this.persist(); });
    $('#chk-fill-all').addEventListener('change', (e) => { this.fillOpts.sampleAll = e.target.checked; this.settings.fill = { ...this.fillOpts }; this.persist(); });

    // text
    $('#sel-font').value = this.textOpts.font;
    if (!$('#sel-font').value) { this.textOpts.font = 'Segoe UI'; $('#sel-font').value = 'Segoe UI'; }
    $('#inp-text-size').value = this.textOpts.size;
    $('#btn-text-bold').setAttribute('aria-pressed', String(!!this.textOpts.bold));
    $('#btn-text-italic').setAttribute('aria-pressed', String(!!this.textOpts.italic));
    const textChanged = () => { this.settings.text = { ...this.textOpts }; this.persist(); this.textTool.applyStyle(); };
    $('#sel-font').addEventListener('change', (e) => { this.textOpts.font = e.target.value; textChanged(); });
    $('#inp-text-size').addEventListener('change', (e) => { this.textOpts.size = Math.max(4, Math.min(800, e.target.valueAsNumber || 48)); e.target.value = this.textOpts.size; textChanged(); });
    $('#btn-text-bold').addEventListener('click', (e) => { this.textOpts.bold = !this.textOpts.bold; e.currentTarget.setAttribute('aria-pressed', String(this.textOpts.bold)); textChanged(); });
    $('#btn-text-italic').addEventListener('click', (e) => { this.textOpts.italic = !this.textOpts.italic; e.currentTarget.setAttribute('aria-pressed', String(this.textOpts.italic)); textChanged(); });
  }

  setSymmetry(mode) {
    this.symmetry = mode;
    this.settings.symmetry = mode;
    this.renderer.symmetry = mode;
    this.renderer.invalidateOverlay();
    $$('.seg-btn', $('#symmetry')).forEach((s) => s.classList.toggle('active', s.dataset.sym === mode));
    this.persist();
  }

  adjustBrushSize(dir) {
    const b = this.getBrushSettings();
    const step = b.size < 10 ? 1 : b.size < 50 ? 2 : b.size < 150 ? 5 : 10;
    const size = Math.max(1, Math.min(300, b.size + dir * step));
    this._writeBrushSetting('size', size);
    this._syncBrushUI();
    this.toast(`Brush size ${size} px`, 'info', { duration: 900 });
  }

  setBrushOpacity(v) {
    this._writeBrushSetting('opacity', v);
    this._syncBrushUI();
  }

  // =====================================================================
  // colour
  // =====================================================================
  _wireColorUI() {
    this.picker = new ColorPicker({ sv: $('#sv-square'), svHandle: $('#sv-handle'), hue: $('#hue-bar'), hueHandle: $('#hue-handle'), hexInput: $('#inp-hex'), preview: $('#color-preview') });
    this.picker.on('input', (hex) => this.setColor(hex, 'primary', { source: 'picker' }));
    this.picker.on('change', (hex) => this.setColor(hex, 'primary', { source: 'picker' }));
    $('#chip-swap').addEventListener('click', () => this.swapColors());
    $('#chip-primary').addEventListener('click', () => $('#inp-hex').focus());
    $('#chip-secondary').addEventListener('click', () => this.swapColors());
    $('#btn-pick').addEventListener('click', () => this.tools.setTool('eyedropper'));
    this.setColor(this.colors.primary, 'primary');
    this.setColor(this.colors.secondary, 'secondary');
  }

  setColor(hex, which = 'primary', { source = null } = {}) {
    const n = normalizeHex(hex);
    if (!n) return;
    this.colors[which] = n;
    $(which === 'primary' ? '#chip-primary' : '#chip-secondary').style.background = n;
    if (which === 'primary') {
      if (source !== 'picker') this.picker.setHex(n, true);
      $('#color-sub').textContent = n;
      $$('.swatch[data-color]').forEach((s) => s.classList.toggle('active', s.dataset.color.toUpperCase() === n));
      if (this.textTool.active) this.textTool.applyStyle();
    }
    this.settings.colors = { ...this.colors };
    this.persist();
  }

  commitColor() { this.persist(); }

  swapColors() {
    const { primary, secondary } = this.colors;
    this.setColor(secondary, 'primary');
    this.setColor(primary, 'secondary');
  }

  noteColorUsed() {
    const c = this.colors.primary;
    const list = [c, ...(this.settings.recent || []).filter((x) => x !== c)].slice(0, 10);
    if (JSON.stringify(list) === JSON.stringify(this.settings.recent)) return;
    this.settings.recent = list;
    this._renderRecent();
    this.persist();
  }

  _renderRecent() {
    buildRecent($('#recent-colors'), this.settings.recent || [], (c, secondary) => this.setColor(c, secondary ? 'secondary' : 'primary'));
  }

  // =====================================================================
  // layers / undo buttons
  // =====================================================================
  _wireLayerButtons() {
    $('#btn-layer-add').addEventListener('click', () => this.ops.addLayer());
    $('#btn-layer-dup').addEventListener('click', () => this.ops.duplicateLayer());
    $('#btn-layer-del').addEventListener('click', () => this.ops.deleteLayer());
    $('#btn-layer-merge').addEventListener('click', () => this.ops.mergeDown());
    $('#btn-layer-up').addEventListener('click', () => this.ops.moveActive(1));
    $('#btn-layer-down').addEventListener('click', () => this.ops.moveActive(-1));
  }

  updateLayerButtons() {
    const d = this.doc; if (!d) return;
    $('#btn-layer-del').disabled = d.layers.length <= 1;
    $('#btn-layer-merge').disabled = d.activeIndex <= 0;
    $('#btn-layer-down').disabled = d.activeIndex <= 0;
    $('#btn-layer-up').disabled = d.activeIndex >= d.layers.length - 1;
  }

  _updateUndoButtons() {
    const h = this.history;
    $('#btn-undo').disabled = !h.canUndo;
    $('#btn-redo').disabled = !h.canRedo;
    $('#btn-undo').title = h.canUndo ? `Undo ${h.undoLabel} (${MOD}+Z)` : `Undo (${MOD}+Z)`;
    $('#btn-redo').title = h.canRedo ? `Redo ${h.redoLabel} (${MOD}+Y)` : `Redo (${MOD}+Y)`;
  }

  undo() { if (this.textTool.active) { this.textTool.cancel(); return; } this.history.undo(); }
  redo() { this.history.redo(); }

  // =====================================================================
  // menubar buttons, theme, panels, status bar
  // =====================================================================
  _wireMenubarButtons() {
    $('#btn-undo').addEventListener('click', () => this.undo());
    $('#btn-redo').addEventListener('click', () => this.redo());
    $('#btn-theme').addEventListener('click', () => this.applyTheme(this._effectiveTheme() === 'dark' ? 'light' : 'dark'));
    $('#btn-panels').addEventListener('click', () => this.setPanelVisible(!this.panelVisible));
    $('#btn-export').addEventListener('click', () => this.exportImage());
  }

  _effectiveTheme() {
    if (this.settings.theme === 'system') return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    return this.settings.theme;
  }

  applyTheme(theme) {
    this.settings.theme = theme;
    const eff = this._effectiveTheme();
    document.documentElement.setAttribute('data-theme', eff);
    $('#btn-theme').innerHTML = icon(eff === 'dark' ? 'sun' : 'moon');
    $('#btn-theme').title = eff === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    this.renderer._checker = null;
    this.renderer.invalidateView();
    if (!this._themeWatcher) {
      this._themeWatcher = matchMedia('(prefers-color-scheme: light)');
      this._themeWatcher.addEventListener('change', () => { if (this.settings.theme === 'system') this.applyTheme('system'); });
    }
    this.persist();
  }

  get panelVisible() { return $('#app').dataset.panel !== 'hidden'; }
  setPanelVisible(visible) {
    $('#app').dataset.panel = visible ? 'visible' : 'hidden';
    $('#btn-panels').innerHTML = icon(visible ? 'panel-right-close' : 'panel-right');
    this.settings.panel = visible ? 'visible' : 'hidden';
    this.persist();
  }

  toggleGrid() {
    this.renderer.showGrid = !this.renderer.showGrid;
    this.settings.showGrid = this.renderer.showGrid;
    this.renderer.invalidateOverlay();
    this.persist();
  }

  setTouchDraws(v) {
    this.touchDraws = v;
    this.settings.touchDraws = v;
    this.persist();
    this.toast(v ? 'Touch draws. Use two fingers to pan and zoom.' : 'Touch pans and zooms. Draw with a pen or mouse.', 'info');
  }

  _wireGlobalBehaviour() {
    // Ctrl+wheel anywhere must not zoom the whole page (the canvas handles its own zoom).
    document.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }, { passive: false });
    // Buttons and sliders give focus back after a mouse click so single-key shortcuts keep working.
    document.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b && !b.closest('dialog') && e.detail > 0) b.blur();
    });
    document.addEventListener('pointerup', (e) => {
      const t = e.target;
      if (t && t.tagName === 'INPUT' && t.type === 'range' && e.pointerType !== '' && !t.closest('dialog')) setTimeout(() => t.blur(), 0);
    });
    // Resizable layers panel
    const splitter = $('#layers-splitter');
    const panel = $('#panel-layers');
    const side = $('#sidepanel');
    if (this.settings.layersHeight) side.style.setProperty('--layers-h', `${this.settings.layersHeight}px`);
    splitter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      splitter.setPointerCapture(e.pointerId);
      splitter.classList.add('active');
      const startY = e.clientY, startH = panel.getBoundingClientRect().height;
      const total = side.getBoundingClientRect().height;
      const move = (ev) => {
        const h = Math.max(150, Math.min(total * 0.75, startH + (startY - ev.clientY)));
        side.style.setProperty('--layers-h', `${Math.round(h)}px`);
      };
      const up = () => {
        splitter.classList.remove('active');
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
        splitter.removeEventListener('pointercancel', up);
        this.settings.layersHeight = Math.round(panel.getBoundingClientRect().height);
        this.persist();
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up);
      splitter.addEventListener('pointercancel', up);
    });
    splitter.addEventListener('dblclick', () => { side.style.removeProperty('--layers-h'); delete this.settings.layersHeight; this.persist(); });
  }

  _updateTitle() {
    const name = this.doc?.name && this.doc.name !== 'Untitled' ? this.doc.name : 'Untitled';
    document.title = `${name} – ChromaCanvas Pro`;
  }

  _wireStatusBar() {
    $('#zoom-in').addEventListener('click', () => this.renderer.zoomStep(1));
    $('#zoom-out').addEventListener('click', () => this.renderer.zoomStep(-1));
    $('#zoom-fit').addEventListener('click', () => this.renderer.fit());
    const zi = $('#zoom-value');
    zi.addEventListener('change', () => {
      const v = parseFloat(zi.value.replace('%', ''));
      if (Number.isFinite(v) && v > 0) this.renderer.setZoom(v / 100);
      zi.value = `${Math.round(this.renderer.zoom * 100)}%`;
      zi.blur();
    });
    zi.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') zi.blur(); });
    zi.addEventListener('focus', () => zi.select());
  }

  updatePointerStatus(info) {
    this._ptrInfo = info;
    if (this._ptrRaf) return;
    this._ptrRaf = requestAnimationFrame(() => {
      this._ptrRaf = 0;
      const info = this._ptrInfo;
      if (!info) { $('#status-pos').textContent = '—'; return; }
      $('#status-pos').textContent = `${Math.floor(info.x)}, ${Math.floor(info.y)}`;
      const inputEl = $('#status-input');
      let label = 'Mouse', ic = 'mouse';
      if (info.type === 'pen') { label = info.pressure > 0 ? `Pen · ${Math.round(info.pressure * 100)}%` : 'Pen'; ic = 'pen'; }
      else if (info.type === 'touch') { label = 'Touch'; ic = 'hand'; }
      if (inputEl.dataset.kind !== ic) { inputEl.dataset.kind = ic; inputEl.innerHTML = `${icon(ic)}<span></span>`; }
      inputEl.querySelector('span').textContent = label;
    });
  }

  _updateSizeStatus() {
    $('#status-size').textContent = `${this.doc.width} × ${this.doc.height} px`;
  }

  _setSaveStatus(state) {
    const e = $('#status-save');
    const map = { saved: ['circle-check', 'Saved'], saving: ['refresh-cw', 'Saving…'], unsaved: ['ellipsis', 'Unsaved changes'], error: ['circle-alert', 'Autosave failed'] };
    const [ic, text] = map[state] || map.saved;
    e.innerHTML = `${icon(ic)}<span>${text}</span>`;
    e.classList.toggle('saving', state === 'saving');
    e.classList.toggle('unsaved', state === 'unsaved' || state === 'error');
  }

  toast(msg, type = 'info', opts) { return this.toasts.show(msg, type, opts); }

  persist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => saveSettings(this.settings), 250);
  }

  // =====================================================================
  // dialogs: new, canvas size, image size, export
  // =====================================================================
  _wireDialogs() {
    // New canvas
    const preset = $('#new-preset'), nw = $('#new-width'), nh = $('#new-height');
    preset.addEventListener('change', () => {
      const p = CANVAS_PRESETS[+preset.value];
      if (p && p.w) { nw.value = p.w; nh.value = p.h; }
      this._newWarning();
    });
    [nw, nh].forEach((i) => i.addEventListener('input', () => { preset.value = String(CANVAS_PRESETS.length - 1); this._newWarning(); }));
    $('#new-swap').addEventListener('click', () => { const t = nw.value; nw.value = nh.value; nh.value = t; this._newWarning(); });
    $('#new-bg-color').addEventListener('input', () => { $('input[name=bg][value=custom]').checked = true; });
    $('#form-new').addEventListener('submit', (e) => {
      e.preventDefault();
      const w = Math.max(1, Math.min(MAX_DIM, +nw.value || 1920));
      const h = Math.max(1, Math.min(MAX_DIM, +nh.value || 1080));
      const bgMode = $('input[name=bg]:checked').value;
      const bg = bgMode === 'white' ? 'white' : bgMode === 'transparent' ? 'transparent' : $('#new-bg-color').value;
      $('#dlg-new').close('ok');
      this.setDocument(new Document(w, h, bg));
    });

    // Canvas size
    let anchor = 'c';
    $$('#anchor-grid button').forEach((b) => b.addEventListener('click', () => { anchor = b.dataset.anchor; $$('#anchor-grid button').forEach((x) => x.classList.toggle('active', x === b)); }));
    $('#form-canvas-size').addEventListener('submit', (e) => {
      e.preventDefault();
      const w = +$('#cs-width').value, h = +$('#cs-height').value;
      $('#dlg-canvas-size').close('ok');
      if (w >= 1 && h >= 1) this.ops.resizeCanvas(w, h, anchor);
    });

    // Image size
    const iw = $('#is-width'), ih = $('#is-height'), lock = $('#is-lock');
    let ratio = 1;
    iw.addEventListener('input', () => { if (lock.checked && +iw.value > 0) ih.value = Math.max(1, Math.round(+iw.value / ratio)); });
    ih.addEventListener('input', () => { if (lock.checked && +ih.value > 0) iw.value = Math.max(1, Math.round(+ih.value * ratio)); });
    $$('#is-presets .seg-btn').forEach((b) => b.addEventListener('click', () => {
      const pct = +b.dataset.pct / 100;
      iw.value = Math.max(1, Math.round(this.doc.width * pct)); ih.value = Math.max(1, Math.round(this.doc.height * pct));
    }));
    this._openImageSize = () => { ratio = this.doc.width / this.doc.height; iw.value = this.doc.width; ih.value = this.doc.height; openDialog($('#dlg-image-size')); };
    $('#form-image-size').addEventListener('submit', (e) => {
      e.preventDefault();
      const w = +iw.value, h = +ih.value;
      $('#dlg-image-size').close('ok');
      if (w >= 1 && h >= 1) {
        if (w > 4096 || h > 4096) this.toast('Large images use a lot of memory — consider staying under 4096 px.', 'warning');
        this.ops.resizeImage(w, h);
      }
    });

    // Export
    const fmt = $('#ex-format'), q = $('#ex-quality'), sc = $('#ex-scale');
    const refresh = () => {
      $('#ex-quality-row').style.display = fmt.value === 'image/png' ? 'none' : '';
      $('#ex-quality-val').textContent = `${q.value}%`;
      $('#ex-scale-val').textContent = `${sc.value}%`;
      const s = +sc.value / 100;
      $('#ex-dims').textContent = `Output: ${Math.max(1, Math.round(this.doc.width * s))} × ${Math.max(1, Math.round(this.doc.height * s))} px`;
    };
    [fmt, q, sc].forEach((i) => i.addEventListener('input', refresh));
    this._openExport = () => { refresh(); openDialog($('#dlg-export')); };
    $('#form-export').addEventListener('submit', (e) => {
      e.preventDefault();
      $('#dlg-export').close('ok');
      this._doExport({ type: fmt.value, quality: +q.value / 100, scale: +sc.value / 100, layerOnly: $('#ex-layer-only').checked });
    });
  }

  _newWarning() {
    const w = +$('#new-width').value, h = +$('#new-height').value;
    const warn = $('#new-warning');
    if (w > 4096 || h > 4096) warn.textContent = 'Very large canvases use a lot of memory and make painting slower. For printing, A4 at 300 dpi (2480 × 3508) is plenty.';
    else if (w * h > 0) warn.textContent = `${(w * h / 1e6).toFixed(1)} megapixels`;
    else warn.textContent = '';
  }

  async newDocument() {
    if (!(await this._confirmReplace('Start a new canvas?'))) return;
    const dlg = $('#dlg-new');
    $('#new-preset').value = '0';
    $('#new-width').value = 1920; $('#new-height').value = 1080;
    this._newWarning();
    openDialog(dlg);
  }

  openCanvasSize() {
    $('#cs-width').value = this.doc.width; $('#cs-height').value = this.doc.height;
    openDialog($('#dlg-canvas-size'));
  }
  openImageSize() { this._openImageSize(); }
  exportImage() { this._openExport(); }

  async _confirmReplace(title) {
    if (!this.doc || !this.doc.modified) return true;
    const res = await confirmDialog({
      title,
      message: 'The current artwork will be replaced. It is kept in autosave only until you start something new — save it as a project if you want to keep the layers.',
      ok: 'Replace', alt: 'Save project first', danger: true,
    });
    if (res === 'alt') { const saved = await this.saveProject(true); return !!saved; }
    return res === 'ok';
  }

  // =====================================================================
  // files
  // =====================================================================
  async openFiles() {
    const files = await pickFiles({ multiple: true, accept: OPEN_TYPES });
    if (files.length) await this.handleFiles(files, 'open');
  }

  async importImages() {
    const files = await pickFiles({ multiple: true, accept: IMAGE_TYPES });
    if (files.length) await this.handleFiles(files, 'import');
  }

  /** mode: 'open' replaces the document (project or first image), 'import' adds images as layers. */
  async handleFiles(files, mode = 'import') {
    const list = Array.from(files);
    const project = list.find(isProjectFile);
    const images = list.filter((f) => !isProjectFile(f) && isImageFile(f));
    try {
      if (mode === 'open' && project) {
        if (!(await this._confirmReplace('Open this project?'))) return;
        const doc = await projectFromJSON(await project.text());
        doc.name = project.name.replace(/\.ccp$/i, '');
        doc.fileHandle = project.handle || null;
        this.setDocument(doc);
        this.toast(`Opened ${project.name}`, 'success');
        for (const f of images) await this._importImageFile(f);
        return;
      }
      if (mode === 'open' && images.length) {
        if (!(await this._confirmReplace('Open this image?'))) return;
        const first = images.shift();
        const img = await blobToImage(first);
        const w = Math.min(MAX_DIM, img.width), h = Math.min(MAX_DIM, img.height);
        const doc = new Document(w, h, 'transparent');
        doc.layers[0].name = first.name.replace(/\.[^.]+$/, '');
        doc.layers[0].ctx.drawImage(img, 0, 0, w, h);
        doc.name = first.name.replace(/\.[^.]+$/, '');
        doc.modified = false;
        this.setDocument(doc);
        for (const f of images) await this._importImageFile(f);
        return;
      }
      if (!images.length && project) { this.toast('Use File → Open to open a project file.', 'info'); return; }
      if (!images.length) { this.toast('No supported image files found. Use PNG, JPEG, WebP, GIF, BMP or SVG.', 'warning'); return; }
      for (const f of images) await this._importImageFile(f);
    } catch (err) {
      console.error(err);
      this.toast(`Could not open the file: ${err.message || err}`, 'error');
    }
  }

  async _importImageFile(file) {
    const img = await blobToImage(file);
    this.ops.addImageLayer(img, file.name.replace(/\.[^.]+$/, ''));
    this.toast(`Added "${file.name}" as a new layer`, 'success');
  }

  async saveProject(saveAs = false) {
    try {
      const json = await documentToProjectJSON(this.doc);
      const blob = new Blob([json], { type: PROJECT_MIME });
      const suggested = (this.doc.name && this.doc.name !== 'Untitled' ? this.doc.name : timestampName('ChromaCanvas', '')) + PROJECT_EXT;
      const res = await saveBlob(blob, { suggestedName: suggested, types: PROJECT_TYPES, handle: saveAs ? null : this.doc.fileHandle });
      if (!res) return false;
      if (typeof res === 'object') { this.doc.fileHandle = res; this.doc.name = res.name.replace(/\.ccp$/i, ''); this._updateTitle(); }
      this.doc.modified = false;
      this.autosave.schedule(this.doc, 200);
      this.toast(typeof res === 'object' ? `Saved ${res.name}` : 'Project downloaded', 'success');
      return true;
    } catch (err) {
      console.error(err);
      this.toast('Could not save the project.', 'error');
      return false;
    }
  }

  async _doExport({ type, quality, scale, layerOnly }) {
    try {
      const src = layerOnly ? this.doc.active.canvas : this.doc.flatten(true);
      const w = Math.max(1, Math.round(this.doc.width * scale)), h = Math.max(1, Math.round(this.doc.height * scale));
      const out = createCanvas(w, h);
      const ctx = out.getContext('2d');
      if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, w, h);
      const blob = await canvasToBlob(out, type, type === 'image/png' ? undefined : quality);
      const ext = type === 'image/png' ? '.png' : type === 'image/jpeg' ? '.jpg' : '.webp';
      const base = this.doc.name && this.doc.name !== 'Untitled' ? this.doc.name : 'ChromaCanvas';
      const res = await saveBlob(blob, { suggestedName: timestampName(base, ext), types: [{ description: 'Image', accept: { [type]: [ext] } }] });
      if (res) this.toast('Image exported', 'success');
    } catch (err) {
      console.error(err);
      this.toast('Export failed.', 'error');
    }
  }

  async copyImage() {
    try {
      const blob = await canvasToBlob(this.doc.flatten(true), 'image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      this.toast('Image copied to the clipboard', 'success');
    } catch (err) {
      console.warn(err);
      this.toast('Could not copy to the clipboard.', 'error');
    }
  }

  async pasteFromClipboard() {
    try {
      if (!navigator.clipboard?.read) throw new Error('unsupported');
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const t = item.types.find((x) => x.startsWith('image/'));
        if (t) { const blob = await item.getType(t); await this._importImageFile(new File([blob], 'Pasted image', { type: t })); return; }
      }
      this.toast('No image on the clipboard.', 'info');
    } catch {
      this.toast(`Press ${MOD}+V with an image on the clipboard to paste it as a layer.`, 'info');
    }
  }

  _wireClipboardAndDrop() {
    document.addEventListener('paste', (e) => {
      if (this._isTyping(e.target)) return;
      const items = Array.from(e.clipboardData?.items || []);
      const img = items.find((i) => i.type.startsWith('image/'));
      if (!img) return;
      e.preventDefault();
      const file = img.getAsFile();
      if (file) this._importImageFile(new File([file], 'Pasted image', { type: file.type })).catch((err) => this.toast(err.message, 'error'));
    });
    const ws = $('#workspace');
    const hint = $('#drop-hint');
    let depth = 0;
    document.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; hint.classList.remove('hidden'); } });
    document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (depth === 0) hint.classList.add('hidden'); });
    document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    document.addEventListener('drop', (e) => {
      depth = 0; hint.classList.add('hidden');
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      this.handleFiles(files, files.some(isProjectFile) ? 'open' : 'import');
    });
    ws.addEventListener('dragover', (e) => e.preventDefault());
  }

  _setupLaunchQueue() {
    if (!('launchQueue' in window)) return;
    try {
      window.launchQueue.setConsumer(async (params) => {
        if (!params.files?.length) return;
        const files = [];
        for (const h of params.files) { try { const f = await h.getFile(); f.handle = h; files.push(f); } catch { /* ignore */ } }
        if (files.length) this.handleFiles(files, 'open');
      });
    } catch (err) { console.warn('launchQueue', err); }
  }

  // =====================================================================
  // keyboard
  // =====================================================================
  _isTyping(target) {
    if (!target) return false;
    const tag = target.tagName;
    if (tag === 'TEXTAREA' || target.isContentEditable) return true;
    if (tag === 'INPUT') return !['range', 'checkbox', 'radio', 'color', 'button', 'file'].includes(target.type);
    return tag === 'SELECT';
  }

  _wireKeyboard() {
    document.addEventListener('keydown', (e) => this._onKeyDown(e));
    document.addEventListener('keyup', (e) => { if (e.code === 'Space') this.tools.setSpaceHeld(false); });
    window.addEventListener('blur', () => this.tools.setSpaceHeld(false));
  }

  _onKeyDown(e) {
    const anyDialogOpen = $$('dialog[open]').length > 0;
    if (anyDialogOpen) return;
    if (this.menubar.isOpen) return;
    const typing = this._isTyping(e.target);
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;
    const lower = key.toLowerCase();

    if (typing) {
      if (key === 'Escape') e.target.blur();
      return;
    }
    // let focused form controls keep their native keyboard behaviour
    const t = e.target;
    if (t && t.tagName === 'INPUT' && t.type === 'range' && key.startsWith('Arrow')) return;
    if (t && (t.tagName === 'BUTTON' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && (t.type === 'checkbox' || t.type === 'radio'))) && (key === ' ' || key === 'Enter' || key.startsWith('Arrow'))) return;

    if (key === 'Escape') {
      if (this.textTool.active) this.textTool.cancel();
      return;
    }

    if (ctrl) {
      const shift = e.shiftKey;
      const map = {
        z: () => (shift ? this.redo() : this.undo()),
        y: () => this.redo(),
        s: () => this.saveProject(shift),
        o: () => this.openFiles(),
        n: () => (shift ? this.ops.addLayer() : this.newDocument()),
        e: () => (shift ? this.exportImage() : this.ops.mergeDown()),
        j: () => this.ops.duplicateLayer(),
        c: () => this.copyImage(),
        '0': () => this.renderer.fit(),
        '1': () => this.renderer.setZoom(1),
        '=': () => this.renderer.zoomStep(1),
        '+': () => this.renderer.zoomStep(1),
        '-': () => this.renderer.zoomStep(-1),
        '_': () => this.renderer.zoomStep(-1),
        "'": () => this.toggleGrid(),
      };
      let fn = map[lower];
      if (e.code === 'NumpadAdd') fn = map['='];
      if (e.code === 'NumpadSubtract') fn = map['-'];
      if (e.altKey && lower === 'n') fn = () => this.newDocument();
      if (fn) { e.preventDefault(); fn(); }
      return;
    }

    // plain keys
    if (e.code === 'Space') { if (!e.repeat) this.tools.setSpaceHeld(true); e.preventDefault(); return; }
    if (key === 'Tab') { e.preventDefault(); this.setPanelVisible(!this.panelVisible); return; }
    if (key === 'Delete') { e.preventDefault(); this.ops.clearLayer(); return; }
    if (key === 'Insert') { e.preventDefault(); this.ops.addLayer(); return; }
    if (key === 'F2') { e.preventDefault(); this.layersPanel.startRename(this.doc.active); return; }
    if (key === '?') { e.preventDefault(); openDialog($('#dlg-shortcuts')); return; }
    if (key === '[') { e.preventDefault(); this.adjustBrushSize(-1); return; }
    if (key === ']') { e.preventDefault(); this.adjustBrushSize(1); return; }
    if (key.startsWith('Arrow') && this.tools.tool === 'move') {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key];
      this.tools.nudge(d[0], d[1]);
      return;
    }
    if (/^[0-9]$/.test(key) && (this.tools.tool === 'brush' || this.tools.tool === 'eraser')) {
      e.preventDefault();
      this.setBrushOpacity(key === '0' ? 1 : +key / 10);
      return;
    }
    if (e.altKey) return;
    const toolKeys = { b: 'brush', e: 'eraser', g: 'fill', i: 'eyedropper', l: 'line', r: 'rect', o: 'ellipse', t: 'text', m: 'move', h: 'hand' };
    if (toolKeys[lower] && !e.shiftKey) { e.preventDefault(); this.tools.setTool(toolKeys[lower]); return; }
    if (lower === 'x') { e.preventDefault(); this.swapColors(); return; }
    if (lower === 'd') { e.preventDefault(); this.setColor('#000000', 'primary'); this.setColor('#FFFFFF', 'secondary'); return; }
  }

  // =====================================================================
  // service worker
  // =====================================================================
  _registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!/^https?:$/.test(location.protocol)) return;
    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register('./sw.js');
        const promptUpdate = (worker) => {
          this.toast('A new version of ChromaCanvas Pro is ready.', 'info', {
            duration: 0,
            action: { label: 'Restart', onClick: () => { this._reloadOnControl = true; worker.postMessage({ type: 'SKIP_WAITING' }); } },
          });
        };
        if (reg.waiting && navigator.serviceWorker.controller) promptUpdate(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) promptUpdate(nw);
          });
        });
        navigator.serviceWorker.addEventListener('controllerchange', async () => {
          if (!this._reloadOnControl) return;
          this._reloadOnControl = false;
          await this.autosave.flush(this.doc);
          location.reload();
        });
      } catch (err) {
        console.warn('Service worker registration failed', err);
      }
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }
}

const app = new App();
window.chromaCanvas = app;
app.init().catch((err) => {
  console.error(err);
  app.toast('Something went wrong while starting the app. Please reload.', 'error', { duration: 0 });
});
