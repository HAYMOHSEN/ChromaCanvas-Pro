# ChromaCanvas Pro

A fast, offline digital painting studio for Windows, built as a Progressive Web App and published to the Microsoft Store (GitHub Pages + PWABuilder).

**Live app:** https://haymohsen.github.io/ChromaCanvasPro/  
**Privacy policy:** https://haymohsen.github.io/ChromaCanvasPro/privacy.html

## Features

- 7 pressure-sensitive brushes (Pencil, Ink Pen, Marker, Oil Paint, Watercolor, Airbrush, Chalk) + Eraser, each with size, opacity, flow, hardness, spacing and stabilizer settings
- Layers with visibility, lock, opacity, 16 blend modes, drag-and-drop reorder, duplicate, merge down, flatten
- Shapes (line, rectangle, ellipse), flood fill, text, eyedropper, move and hand tools
- Symmetry painting (mirror left/right, top/bottom, 4-way)
- Unlimited undo/redo (memory-capped), zoom 3 %–3200 %, pan, grid overlay
- Open PNG/JPEG/WebP/GIF/BMP/SVG, import images as layers, paste from clipboard, drag & drop
- Save editable projects (`.ccp`), export PNG / JPEG / WebP at any scale
- Autosave to the device — the last canvas is restored on the next launch
- Light and dark theme, Windows 11 Fluent design, keyboard shortcuts
- 100 % offline, no accounts, no tracking

## Project structure

```
index.html            app shell
styles.css            all styles (dark + light theme)
manifest.webmanifest  PWA manifest (name, icons, shortcuts, file handlers)
sw.js                 service worker (offline cache) — bump VERSION on every release
privacy.html          privacy policy page (linked from the Store listing)
js/main.js            app bootstrap, menus, keyboard, files, dialogs
js/state.js           document & layer model
js/history.js         undo / redo
js/renderer.js        viewport compositing, zoom / pan
js/brush.js           brush presets and stroke engine
js/tools.js           pointer input, tools, text tool
js/ops.js             layer / image operations
js/storage.js         autosave (IndexedDB), project files, export
js/ui.js              toasts, menus, dialogs, layers panel, pickers
js/color.js           colour utilities and HSV picker
js/icons.js           bundled Lucide icons (ISC licence)
icons/                app icons (PNG + SVG)
screenshots/          Store screenshots (also used by the manifest)
```

## Releasing an update

1. Edit the files.
2. Bump `VERSION` in `sw.js` (e.g. `1.0.1`) and `APP_VERSION` in `js/main.js`.
3. Commit and push to GitHub. GitHub Pages republishes within a minute.
4. Installed copies pick the update up on their next start and show a **Restart** toast. The Store package does not need to be re-uploaded unless the manifest, icons or app name change.

## Licence

© 2026 Hani Muhsen. All rights reserved. Icons from [Lucide](https://lucide.dev) (ISC Licence).
