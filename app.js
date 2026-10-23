// PDF Editor — todo ocurre en el dispositivo: pdf.js dibuja las páginas y pdf-lib escribe el PDF final.
import * as pdfjsLib from './vendor/pdf.min.js';

const VENDOR = new URL('./vendor/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.js';

const PDFLib = window.PDFLib;
const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } = PDFLib;

const $ = (s) => document.querySelector(s);
const viewer = $('#viewer');
const pagesHost = $('#pages');

let uidCounter = 0;
const newId = (p) => p + Date.now().toString(36) + (uidCounter++).toString(36);

const COLORS = {
  pen: ['#1a1a1a', '#1f4fd1', '#d12a1f', '#1c8a3a'],
  text: ['#1a1a1a', '#1f4fd1', '#d12a1f', '#1c8a3a'],
  highlight: ['#ffe14d', '#7cf27c', '#7ad7ff', '#ff9ad1'],
  rect: ['#ffffff', '#000000'],
};
const prefs = {
  pen: { color: '#1a1a1a', size: 2.5 },
  text: { color: '#1a1a1a', size: 14 },
  highlight: { color: '#ffe14d', size: 14 },
  rect: { color: '#ffffff' },
};
const HL_OPACITY = 0.38;
const LINE_H = 1.2;

const state = {
  name: '',
  sources: new Map(), // id -> { id, name, bytes, doc, fields }
  pages: [],          // { id, src, index, base, rot, view, annots: [] }
  tool: 'pan',
  zoom: 1,
  selected: null,     // { pageId, annotId }
  undo: [],
  redo: [],
  pendingImage: null, // { src, iw, ih, kind }
};

/* ---------------- Utilidades ---------------- */

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function busy(msg) {
  $('#busy').hidden = !msg;
  if (msg) $('#busy-msg').textContent = msg;
}
function confirmDlg(msg, okLabel = 'Aceptar') {
  const d = $('#dlg-confirm');
  $('#confirm-msg').textContent = msg;
  $('#confirm-ok').textContent = okLabel;
  d.returnValue = '';
  d.showModal();
  return new Promise((res) => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }));
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
function rotVec(x, y, deg) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return [x * c - y * s, x * s + y * c];
}
function dataUrlToBytes(url) {
  const b = atob(url.split(',')[1]);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

// Misma matemática que PageViewport de pdf.js, para convertir coordenadas sin esperar a la página.
function makeViewport(view, scale, rotation) {
  const cx = (view[2] + view[0]) / 2, cy = (view[3] + view[1]) / 2;
  let A, B, C, D;
  switch (rotation) {
    case 90: A = 0; B = 1; C = 1; D = 0; break;
    case 180: A = -1; B = 0; C = 0; D = 1; break;
    case 270: A = 0; B = -1; C = -1; D = 0; break;
    default: A = 1; B = 0; C = 0; D = -1;
  }
  let ox, oy, width, height;
  if (A === 0) {
    ox = Math.abs(cy - view[1]) * scale; oy = Math.abs(cx - view[0]) * scale;
    width = (view[3] - view[1]) * scale; height = (view[2] - view[0]) * scale;
  } else {
    ox = Math.abs(cx - view[0]) * scale; oy = Math.abs(cy - view[1]) * scale;
    width = (view[2] - view[0]) * scale; height = (view[3] - view[1]) * scale;
  }
  const m = [A * scale, B * scale, C * scale, D * scale,
    ox - A * scale * cx - C * scale * cy, oy - B * scale * cx - D * scale * cy];
  return {
    width, height, transform: m,
    toPdf(px, py) {
      const d = m[0] * m[3] - m[1] * m[2];
      return [(px * m[3] - py * m[2] + m[2] * m[5] - m[4] * m[3]) / d,
        (-px * m[1] + py * m[0] + m[4] * m[1] - m[5] * m[0]) / d];
    },
  };
}
const pageRotation = (p) => (((p.base + p.rot) % 360) + 360) % 360;
function pageDisplaySize(p) {
  const w = p.view[2] - p.view[0], h = p.view[3] - p.view[1];
  return pageRotation(p) % 180 ? [h, w] : [w, h];
}

/* ---------------- Almacenamiento local (IndexedDB) ---------------- */

const store = {
  db: null,
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open('pdf-editor', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this.db;
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  },
  get(k) { return this.tx('readonly', (s) => s.get(k)).catch(() => null); },
  put(k, v) { return this.tx('readwrite', (s) => s.put(v, k)).catch(() => {}); },
  clear() { return this.tx('readwrite', (s) => s.clear()).catch(() => {}); },
};
const saveMeta = debounce(() => {
  if (!state.pages.length) return;
  store.put('meta', {
    name: state.name,
    pages: state.pages,
    sourceIds: [...state.sources.keys()],
    savedAt: Date.now(),
  });
}, 700);
function saveSource(src) { store.put('src:' + src.id, { id: src.id, name: src.name, bytes: src.bytes }); }

/* ---------------- Carga de documentos ---------------- */

async function openPdfjs(bytes) {
  const task = pdfjsLib.getDocument({
    data: bytes.slice(),
    cMapUrl: VENDOR + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: VENDOR + 'standard_fonts/',
    isEvalSupported: false,
  });
  task.onPassword = (cb, reason) => {
    const pw = prompt(reason === 2 ? 'Contraseña incorrecta. Inténtalo otra vez:' : 'Este PDF tiene contraseña:');
    if (pw === null) task.destroy(); else cb(pw);
  };
  return task.promise;
}

async function readFields(src) {
  src.fields = [];
  try {
    const lib = await PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false });
    for (const f of lib.getForm().getFields()) {
      const name = f.getName();
      if (f instanceof PDFLib.PDFTextField) {
        src.fields.push({ name, type: 'text', value: f.getText() || '', multiline: f.isMultiline() });
      } else if (f instanceof PDFLib.PDFCheckBox) {
        src.fields.push({ name, type: 'check', value: f.isChecked() });
      } else if (f instanceof PDFLib.PDFDropdown || f instanceof PDFLib.PDFOptionList) {
        src.fields.push({ name, type: 'choice', value: f.getSelected()[0] || '', options: f.getOptions() });
      } else if (f instanceof PDFLib.PDFRadioGroup) {
        src.fields.push({ name, type: 'radio', value: f.getSelected() || '', options: f.getOptions() });
      }
    }
  } catch { /* PDF sin formulario legible */ }
}

async function addSource(bytes, name, id = newId('s')) {
  const doc = await openPdfjs(bytes);
  const src = { id, name, bytes, doc, fields: [] };
  state.sources.set(id, src);
  await readFields(src);
  return src;
}

async function pagesFromSource(src) {
  const list = [];
  for (let i = 0; i < src.doc.numPages; i++) {
    const pg = await src.doc.getPage(i + 1);
    list.push({ id: newId('p'), src: src.id, index: i, base: pg.rotate || 0, rot: 0, view: pg.view.slice(), annots: [] });
  }
  return list;
}

async function readFile(file) {
  return new Uint8Array(await file.arrayBuffer());
}

async function closeDocument() {
  for (const s of state.sources.values()) s.doc.destroy();
  state.sources.clear();
  state.pages = [];
  state.undo = []; state.redo = [];
  state.selected = null;
  thumbCache.clear();
  await store.clear();
}

async function openFiles(files, { append = false } = {}) {
  files = [...files].filter(Boolean);
  if (!files.length) return;
  if (!append && hasWork() && !(await confirmDlg('Se cerrará el documento actual y sus cambios. ¿Continuar?', 'Abrir'))) return;
  busy('Abriendo…');
  try {
    if (!append) await closeDocument();
    else pushUndo();
    for (const f of files) {
      const src = await addSource(await readFile(f), f.name);
      saveSource(src);
      state.pages.push(...(await pagesFromSource(src)));
    }
    if (!append) {
      state.name = files.length > 1 ? 'Combinado' : files[0].name.replace(/\.pdf$/i, '');
      state.zoom = 1;
    }
    showEditor();
    layout();
    saveMeta();
    if (append) toast(`Añadido: ${files.map((f) => f.name).join(', ')}`);
  } catch (e) {
    console.error(e);
    toast('No se pudo abrir el PDF. ¿Está dañado o protegido?', 4000);
    if (!state.pages.length) showWelcome();
  } finally {
    busy(null);
  }
}

async function addBlankPage() {
  pushUndo();
  const last = state.pages[state.pages.length - 1];
  const size = last ? [last.view[2] - last.view[0], last.view[3] - last.view[1]] : [595.28, 841.89];
  const doc = await PDFDocument.create();
  doc.addPage(size);
  const src = await addSource(await doc.save(), 'En blanco');
  saveSource(src);
  state.pages.push(...(await pagesFromSource(src)));
  layout();
  saveMeta();
}

const hasWork = () => state.pages.length > 0 && (state.undo.length > 0 || state.pages.some((p) => p.annots.length));

async function resumeSession() {
  if (state.pages.length) { showEditor(); layout(); return; } // sigue en memoria
  const meta = await store.get('meta');
  if (!meta) return;
  busy('Recuperando…');
  try {
    for (const id of meta.sourceIds) {
      const rec = await store.get('src:' + id);
      if (rec) await addSource(rec.bytes, rec.name, rec.id);
    }
    state.pages = meta.pages.filter((p) => state.sources.has(p.src));
    state.name = meta.name;
    showEditor();
    layout();
  } catch (e) {
    console.error(e);
    toast('No se pudo recuperar la sesión anterior.');
  } finally {
    busy(null);
  }
}

/* ---------------- Pantallas ---------------- */

async function showWelcome() {
  document.body.classList.add('is-welcome');
  $('#welcome').hidden = false;
  for (const id of ['#viewer', '#toolbar', '#toolopts', '#zoom-ctl', '#selbar']) $(id).hidden = true;
  $('#doc-name').textContent = 'PDF Editor';
  $('#doc-meta').textContent = '';
  const meta = await store.get('meta');
  const r = $('#btn-resume');
  r.hidden = !meta;
  if (meta) r.textContent = `Continuar con «${meta.name}»`;
}
function showEditor() {
  document.body.classList.remove('is-welcome');
  $('#welcome').hidden = true;
  $('#viewer').hidden = false;
  $('#toolbar').hidden = false;
  $('#zoom-ctl').hidden = false;
  setTool('pan');
  updateHeader();
}
function updateHeader() {
  $('#doc-name').textContent = state.name || 'Documento';
  const n = state.pages.length;
  $('#doc-meta').textContent = `${n} página${n === 1 ? '' : 's'}`;
  $('#btn-undo').disabled = !state.undo.length;
  $('#btn-redo').disabled = !state.redo.length;
  $('#btn-form').hidden = ![...state.sources.values()].some((s) => s.fields.length);
}

/* ---------------- Deshacer ---------------- */

const snapshot = () => JSON.stringify(state.pages);
const structureKey = (pages) => pages.map((p) => p.id + ':' + p.rot).join('|');
function pushUndo() {
  state.undo.push(snapshot());
  if (state.undo.length > 60) state.undo.shift();
  state.redo = [];
  updateHeader();
}
function restore(from, to) {
  if (!from.length) return;
  to.push(snapshot());
  const before = structureKey(state.pages);
  state.pages = JSON.parse(from.pop());
  state.selected = null;
  if (structureKey(state.pages) === before) {
    for (const p of state.pages) { const v = views.get(p.id); if (v) { v.page = p; drawInk(v); } }
  } else {
    layout();
  }
  updateSelbar();
  updateHeader();
  saveMeta();
}

/* ---------------- Visor ---------------- */

const views = new Map(); // pageId -> vista
let observer = null;
const visible = new Set();
let renderedOrder = [];
const MAX_RENDERED = 10;

function layout() {
  observer?.disconnect();
  for (const v of views.values()) v.task?.cancel();
  views.clear();
  visible.clear();
  renderedOrder = [];
  pagesHost.textContent = '';
  const avail = Math.max(200, viewer.clientWidth - 32);
  observer = new IntersectionObserver(onIntersect, { root: viewer, rootMargin: '700px 0px' });

  state.pages.forEach((p, i) => {
    const rotation = pageRotation(p);
    const [dw] = pageDisplaySize(p);
    const scale = (avail / dw) * state.zoom;
    const vp = makeViewport(p.view, scale, rotation);
    const el = document.createElement('div');
    el.className = 'page';
    el.style.width = vp.width + 'px';
    el.style.height = vp.height + 'px';
    el.dataset.id = p.id;
    const pdfCanvas = document.createElement('canvas');
    const ink = document.createElement('canvas');
    ink.className = 'ink';
    const num = document.createElement('div');
    num.className = 'page-num';
    num.textContent = i + 1;
    el.append(pdfCanvas, ink, num);
    pagesHost.append(el);
    const v = { page: p, el, pdfCanvas, ink, vp, scale, rotation, rendered: false, rendering: false, task: null };
    views.set(p.id, v);
    bindPointer(v);
    observer.observe(el);
  });
  updateHeader();
}

function onIntersect(entries) {
  for (const e of entries) {
    const id = e.target.dataset.id;
    if (e.isIntersecting) { visible.add(id); renderPage(views.get(id)); } else visible.delete(id);
  }
  evictPages();
}

function evictPages() {
  while (renderedOrder.length > MAX_RENDERED) {
    const idx = renderedOrder.findIndex((id) => !visible.has(id));
    if (idx < 0) break;
    const [id] = renderedOrder.splice(idx, 1);
    const v = views.get(id);
    if (!v) continue;
    v.task?.cancel();
    v.pdfCanvas.width = v.pdfCanvas.height = 0;
    v.ink.width = v.ink.height = 0;
    v.rendered = false;
  }
}

function outputScaleFor(v) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const area = v.vp.width * v.vp.height * dpr * dpr;
  const maxArea = 5_000_000; // límite prudente para la memoria de canvas en iOS
  return area > maxArea ? dpr * Math.sqrt(maxArea / area) : dpr;
}

async function renderPage(v) {
  if (!v || v.rendered || v.rendering) return;
  v.rendering = true;
  try {
    const src = state.sources.get(v.page.src);
    const proxy = await src.doc.getPage(v.page.index + 1);
    if (views.get(v.page.id) !== v) return; // se reconstruyó el visor mientras tanto
    const k = outputScaleFor(v);
    const vp = proxy.getViewport({ scale: v.scale * k, rotation: v.rotation });
    const off = document.createElement('canvas');
    off.width = Math.floor(vp.width);
    off.height = Math.floor(vp.height);
    v.task = proxy.render({ canvasContext: off.getContext('2d'), viewport: vp });
    await v.task.promise;
    v.pdfCanvas.width = off.width;
    v.pdfCanvas.height = off.height;
    v.pdfCanvas.getContext('2d').drawImage(off, 0, 0);
    off.width = off.height = 0;
    v.ink.width = v.pdfCanvas.width;
    v.ink.height = v.pdfCanvas.height;
    v.rendered = true;
    renderedOrder = renderedOrder.filter((id) => id !== v.page.id);
    renderedOrder.push(v.page.id);
    drawInk(v);
    evictPages();
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.error(e);
  } finally {
    v.rendering = false;
    v.task = null;
  }
}

function rerenderSource(srcId) {
  for (const v of views.values()) {
    if (v.page.src !== srcId) continue;
    v.rendered = false;
    if (visible.has(v.page.id)) renderPage(v);
  }
  for (const k of [...thumbCache.keys()]) if (k.startsWith(srcId + '#')) thumbCache.delete(k);
}

/* ---------------- Dibujo de anotaciones ---------------- */

const imgCache = new Map();
function getImg(src, onReady) {
  let e = imgCache.get(src);
  if (!e) {
    e = { img: new Image(), ready: false, waiters: [] };
    e.img.onload = () => { e.ready = true; e.waiters.forEach((f) => f()); e.waiters = []; };
    e.img.src = src;
    imgCache.set(src, e);
  }
  if (!e.ready && onReady) e.waiters.push(onReady);
  return e.ready ? e.img : null;
}

const measureCtx = document.createElement('canvas').getContext('2d');
const FONT_STACK = 'Helvetica, Arial, sans-serif';
function measureText(a) {
  measureCtx.font = `${a.size}px ${FONT_STACK}`;
  return Math.max(4, ...a.text.split('\n').map((l) => measureCtx.measureText(l).width));
}

function drawAnnot(ctx, a, redraw) {
  ctx.save();
  if (a.type === 'path') {
    ctx.globalAlpha = a.opacity ?? 1;
    ctx.strokeStyle = a.color;
    ctx.lineWidth = a.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a.pts[0][0], a.pts[0][1]);
    if (a.pts.length === 1) ctx.lineTo(a.pts[0][0] + 0.01, a.pts[0][1]);
    for (let i = 1; i < a.pts.length; i++) ctx.lineTo(a.pts[i][0], a.pts[i][1]);
    ctx.stroke();
  } else if (a.type === 'rect') {
    ctx.fillStyle = a.color;
    ctx.fillRect(a.x, a.y, a.w, a.h);
    if (a.color.toLowerCase() === '#ffffff') { // borde tenue para ver la zona tapada mientras se edita
      ctx.strokeStyle = 'rgba(0,0,0,.12)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(a.x, a.y, a.w, a.h);
    }
  } else if (a.type === 'text') {
    ctx.translate(a.x, a.y);
    ctx.rotate((a.rot * Math.PI) / 180);
    ctx.scale(1, -1);
    ctx.fillStyle = a.color;
    ctx.font = `${a.size}px ${FONT_STACK}`;
    ctx.textBaseline = 'alphabetic';
    a.text.split('\n').forEach((l, i) => ctx.fillText(l, 0, i * a.size * LINE_H));
  } else if (a.type === 'image') {
    const img = getImg(a.src, redraw);
    if (img) {
      ctx.translate(a.x, a.y);
      ctx.rotate((a.rot * Math.PI) / 180);
      ctx.scale(1, -1);
      ctx.drawImage(img, 0, -a.h, a.w, a.h);
    }
  }
  ctx.restore();
}

function annotCorners(a) {
  if (a.type === 'path') {
    const xs = a.pts.map((q) => q[0]), ys = a.pts.map((q) => q[1]), r = a.width / 2;
    const x0 = Math.min(...xs) - r, x1 = Math.max(...xs) + r, y0 = Math.min(...ys) - r, y1 = Math.max(...ys) + r;
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }
  if (a.type === 'rect') return [[a.x, a.y], [a.x + a.w, a.y], [a.x + a.w, a.y + a.h], [a.x, a.y + a.h]];
  let lx0 = 0, lx1, ly0, ly1;
  if (a.type === 'text') {
    const n = a.text.split('\n').length;
    lx1 = a.w ?? measureText(a);
    ly0 = -(n - 1) * a.size * LINE_H - a.size * 0.25;
    ly1 = a.size * 0.8;
  } else { lx1 = a.w; ly0 = 0; ly1 = a.h; }
  return [[lx0, ly0], [lx1, ly0], [lx1, ly1], [lx0, ly1]].map(([x, y]) => {
    const [rx, ry] = rotVec(x, y, a.rot);
    return [a.x + rx, a.y + ry];
  });
}
function annotBox(a) {
  const c = annotCorners(a);
  const xs = c.map((q) => q[0]), ys = c.map((q) => q[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

let tempAnnot = null; // { pageId, annot }

function drawInk(v) {
  if (!v.rendered) return;
  const ctx = v.ink.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, v.ink.width, v.ink.height);
  const k = v.ink.width / v.vp.width;
  const m = v.vp.transform;
  ctx.setTransform(m[0] * k, m[1] * k, m[2] * k, m[3] * k, m[4] * k, m[5] * k);
  const redraw = () => drawInk(v);
  for (const a of v.page.annots) drawAnnot(ctx, a, redraw);
  if (tempAnnot && tempAnnot.pageId === v.page.id) drawAnnot(ctx, tempAnnot.annot, redraw);
  if (state.selected && state.selected.pageId === v.page.id && state.tool === 'select') {
    const a = v.page.annots.find((x) => x.id === state.selected.annotId);
    if (a) {
      const b = annotBox(a), pad = 4 / v.scale;
      ctx.setLineDash([5 / v.scale, 4 / v.scale]);
      ctx.lineWidth = 1.5 / v.scale;
      ctx.strokeStyle = '#c8402f';
      ctx.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2);
    }
  }
}
const redrawAll = () => views.forEach(drawInk);

/* ---------------- Interacción táctil ---------------- */

function toPdf(v, e) {
  const r = v.ink.getBoundingClientRect();
  const sx = v.vp.width / r.width, sy = v.vp.height / r.height;
  return v.vp.toPdf((e.clientX - r.left) * sx, (e.clientY - r.top) * sy);
}

function hitTest(v, pt) {
  const tol = 10 / v.scale;
  for (let i = v.page.annots.length - 1; i >= 0; i--) {
    const b = annotBox(v.page.annots[i]);
    if (pt[0] >= b.x0 - tol && pt[0] <= b.x1 + tol && pt[1] >= b.y0 - tol && pt[1] <= b.y1 + tol) return v.page.annots[i];
  }
  return null;
}

function moveAnnot(a, dx, dy) {
  if (a.type === 'path') a.pts = a.pts.map(([x, y]) => [x + dx, y + dy]);
  else { a.x += dx; a.y += dy; }
}

function bindPointer(v) {
  let g = null; // gesto en curso
  v.ink.addEventListener('pointerdown', (e) => {
    if (state.tool === 'pan' || g) return;
    try { v.ink.setPointerCapture(e.pointerId); } catch { /* puntero ya liberado */ }
    const pt = toPdf(v, e);
    g = { id: e.pointerId, start: pt, last: pt, sx: e.clientX, sy: e.clientY, moved: false, scrollTop: viewer.scrollTop, scrollLeft: viewer.scrollLeft };
    const t = state.tool;
    if (t === 'pen' || t === 'highlight') {
      const pr = prefs[t];
      g.kind = 'draw';
      tempAnnot = { pageId: v.page.id, annot: { id: newId('a'), type: 'path', pts: [pt], color: pr.color, width: pr.size, opacity: t === 'highlight' ? HL_OPACITY : 1 } };
      drawInk(v);
    } else if (t === 'rect') {
      g.kind = 'rect';
      tempAnnot = { pageId: v.page.id, annot: { id: newId('a'), type: 'rect', x: pt[0], y: pt[1], w: 0, h: 0, color: prefs.rect.color } };
    } else if (t === 'select') {
      const hit = hitTest(v, pt);
      if (hit) {
        g.kind = 'move';
        g.annot = hit;
        g.snap = snapshot();
        state.selected = { pageId: v.page.id, annotId: hit.id };
        redrawAll();
        updateSelbar();
      } else {
        g.kind = 'pan';
      }
    } else {
      g.kind = 'pan'; // texto / firma / imagen: tocar coloca, arrastrar desplaza
    }
  });

  v.ink.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 8) g.moved = true;
    if (g.kind === 'pan') {
      viewer.scrollTop = g.scrollTop - (e.clientY - g.sy);
      viewer.scrollLeft = g.scrollLeft - (e.clientX - g.sx);
      return;
    }
    const pt = toPdf(v, e);
    if (g.kind === 'draw') {
      const pts = tempAnnot.annot.pts;
      const lp = pts[pts.length - 1];
      if (Math.hypot(pt[0] - lp[0], pt[1] - lp[1]) * v.scale > 1.5) { pts.push(pt); drawInk(v); }
    } else if (g.kind === 'rect') {
      const a = tempAnnot.annot;
      a.x = Math.min(g.start[0], pt[0]); a.y = Math.min(g.start[1], pt[1]);
      a.w = Math.abs(pt[0] - g.start[0]); a.h = Math.abs(pt[1] - g.start[1]);
      drawInk(v);
    } else if (g.kind === 'move') {
      moveAnnot(g.annot, pt[0] - g.last[0], pt[1] - g.last[1]);
      g.last = pt;
      drawInk(v);
    }
  });

  const end = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const cancelled = e.type === 'pointercancel';
    const pt = g.last;
    if (g.kind === 'draw' || g.kind === 'rect') {
      const a = tempAnnot.annot;
      tempAnnot = null;
      const ok = !cancelled && (a.type === 'path' || (a.w * v.scale > 4 && a.h * v.scale > 4));
      if (ok) { pushUndo(); v.page.annots.push(a); saveMeta(); }
      drawInk(v);
    } else if (g.kind === 'move') {
      if (g.moved) {
        state.undo.push(g.snap);
        state.redo = [];
        updateHeader();
        saveMeta();
      }
    } else if (g.kind === 'pan' && !g.moved && !cancelled) {
      onTap(v, toPdf(v, e));
    }
    g = null;
  };
  v.ink.addEventListener('pointerup', end);
  v.ink.addEventListener('pointercancel', end);
}

function onTap(v, pt) {
  const t = state.tool;
  if (t === 'select') {
    state.selected = null;
    redrawAll();
    updateSelbar();
  } else if (t === 'text') {
    openTextDialog(null, v, pt);
  } else if ((t === 'sign' || t === 'image') && state.pendingImage) {
    placeImage(v, pt);
  } else if (t === 'sign') {
    openSignDialog();
  } else if (t === 'image') {
    $('#file-img').click();
  }
}

function placeImage(v, pt) {
  const pi = state.pendingImage;
  const [dw] = pageDisplaySize(v.page);
  const w = pi.kind === 'sign' ? Math.min(170, dw * 0.42) : Math.min(dw * 0.6, pi.iw);
  const h = (w * pi.ih) / pi.iw;
  const rot = pageRotation(v.page);
  const [cx, cy] = rotVec(w / 2, h / 2, rot);
  const a = { id: newId('a'), type: 'image', x: pt[0] - cx, y: pt[1] - cy, w, h, rot, src: pi.src };
  pushUndo();
  v.page.annots.push(a);
  state.pendingImage = null;
  selectAfterCreate(v, a);
}

function selectAfterCreate(v, a) {
  saveMeta();
  setTool('select');
  state.selected = { pageId: v.page.id, annotId: a.id };
  redrawAll();
  updateSelbar();
  toast('Arrastra para moverlo. Usa A+ / A− para cambiar el tamaño.');
}

/* ---------------- Selección ---------------- */

function selectedAnnot() {
  if (!state.selected) return null;
  const p = state.pages.find((x) => x.id === state.selected.pageId);
  const a = p?.annots.find((x) => x.id === state.selected.annotId);
  return a ? { p, a } : null;
}
function updateSelbar() {
  const s = state.tool === 'select' ? selectedAnnot() : null;
  $('#selbar').hidden = !s;
  if (s) $('#sel-edit').hidden = s.a.type !== 'text';
}
function scaleAnnot(a, f) {
  if (a.type === 'text') { a.size = Math.max(4, Math.min(120, a.size * f)); a.w = measureText(a); }
  else if (a.type === 'image') {
    const nw = a.w * f;
    if (nw < 8 || nw > 2000) return;
    const [ox, oy] = rotVec(a.w / 2, a.h / 2, a.rot);
    a.w = nw; a.h *= f;
    const [nx, ny] = rotVec(a.w / 2, a.h / 2, a.rot);
    a.x += ox - nx; a.y += oy - ny; // escala desde el centro
  } else if (a.type === 'rect') {
    const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
    a.w *= f; a.h *= f; a.x = cx - a.w / 2; a.y = cy - a.h / 2;
  } else if (a.type === 'path') a.width = Math.max(0.5, Math.min(60, a.width * f));
}
$('#selbar').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.sel;
  const s = selectedAnnot();
  if (!act || !s) return;
  if (act === 'edit') { openTextDialog(s.a, views.get(s.p.id)); return; }
  pushUndo();
  if (act === 'delete') { s.p.annots = s.p.annots.filter((x) => x !== s.a); state.selected = null; }
  else scaleAnnot(s.a, act === 'bigger' ? 1.15 : 1 / 1.15);
  redrawAll();
  updateSelbar();
  saveMeta();
});

/* ---------------- Herramientas ---------------- */

function setTool(t) {
  state.tool = t;
  document.querySelectorAll('#toolbar [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  document.body.classList.toggle('tool-active', t !== 'pan');
  if (t !== 'select') state.selected = null;
  if (t !== 'sign' && t !== 'image') state.pendingImage = null;
  renderToolOpts();
  updateSelbar();
  redrawAll();
}

function renderToolOpts() {
  const t = state.tool;
  const box = $('#toolopts');
  if (!COLORS[t]) { box.hidden = true; return; }
  box.hidden = false;
  const sw = $('#swatches');
  sw.textContent = '';
  for (const c of COLORS[t]) {
    const b = document.createElement('button');
    b.className = 'swatch' + (prefs[t].color === c ? ' on' : '');
    b.style.background = c;
    b.setAttribute('aria-label', 'Color ' + c);
    b.onclick = () => { prefs[t].color = c; renderToolOpts(); };
    sw.append(b);
  }
  const hasSize = t === 'pen' || t === 'highlight';
  $('#size-wrap').hidden = !hasSize;
  if (hasSize) {
    const s = $('#size');
    s.min = t === 'pen' ? 1 : 6; s.max = t === 'pen' ? 10 : 30; s.step = 0.5;
    s.value = prefs[t].size;
  }
}
$('#size').addEventListener('input', (e) => { if (prefs[state.tool]) prefs[state.tool].size = +e.target.value; });

$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.action === 'pages') return openPagesDialog();
  if (b.dataset.action === 'form') return openFormDialog();
  const t = b.dataset.tool;
  setTool(t);
  if (t === 'text') toast('Toca la página donde quieres escribir.');
  if (t === 'sign') openSignDialog();
  if (t === 'image') $('#file-img').click();
  if (t === 'rect') toast('Arrastra sobre la zona que quieres tapar.');
  if (t === 'select') toast('Toca algo que hayas añadido para moverlo o borrarlo.');
});

/* ---------------- Texto ---------------- */

let textCtx = null;
function openTextDialog(annot, v, pt) {
  textCtx = { annot, v, pt };
  const d = $('#dlg-text');
  $('#text-input').value = annot ? annot.text : '';
  const size = annot ? Math.round(annot.size) : prefs.text.size;
  $('#text-size').value = size;
  $('#text-size-out').textContent = size;
  d.returnValue = '';
  d.showModal();
  $('#text-input').focus(); // en iOS el teclado solo se abre si el foco ocurre dentro del toque
}
$('#text-size').addEventListener('input', (e) => { $('#text-size-out').textContent = e.target.value; });
$('#dlg-text').addEventListener('close', () => {
  const d = $('#dlg-text');
  const { annot, v, pt } = textCtx || {};
  textCtx = null;
  const text = $('#text-input').value.replace(/\s+$/, '');
  if (d.returnValue !== 'ok' || !text || !v) return;
  const size = +$('#text-size').value;
  prefs.text.size = size;
  pushUndo();
  if (annot) {
    annot.text = text; annot.size = size; annot.w = measureText(annot);
    redrawAll();
    saveMeta();
  } else {
    const rot = pageRotation(v.page);
    const [ax, ay] = rotVec(0, size * 0.8, rot);
    const a = { id: newId('a'), type: 'text', x: pt[0] - ax, y: pt[1] - ay, text, size, color: prefs.text.color, rot };
    a.w = measureText(a);
    v.page.annots.push(a);
    selectAfterCreate(v, a);
  }
});

/* ---------------- Firma ---------------- */

const SIG_KEY = 'pdf-editor.signatures';
function savedSigs() { try { return JSON.parse(localStorage.getItem(SIG_KEY)) || []; } catch { return []; } }
function setSavedSigs(list) { try { localStorage.setItem(SIG_KEY, JSON.stringify(list.slice(0, 4))); } catch { /* sin almacenamiento */ } }

const pad = $('#sig-pad');
let padStrokes = [];
function resizePad() {
  const r = pad.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  pad.width = Math.round(r.width * dpr);
  pad.height = Math.round(r.height * dpr);
  drawPad();
}
function drawPad() {
  const ctx = pad.getContext('2d');
  const dpr = pad.width / (pad.getBoundingClientRect().width || 1);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pad.width, pad.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = '#111a3a';
  ctx.lineWidth = 2.6;
  ctx.lineCap = ctx.lineJoin = 'round';
  for (const s of padStrokes) {
    ctx.beginPath();
    ctx.moveTo(s[0][0], s[0][1]);
    if (s.length === 1) ctx.lineTo(s[0][0] + 0.1, s[0][1]);
    for (const q of s) ctx.lineTo(q[0], q[1]);
    ctx.stroke();
  }
}
let padPtr = null;
pad.addEventListener('pointerdown', (e) => {
  try { pad.setPointerCapture(e.pointerId); } catch { /* puntero ya liberado */ }
  padPtr = e.pointerId;
  const r = pad.getBoundingClientRect();
  padStrokes.push([[e.clientX - r.left, e.clientY - r.top]]);
  drawPad();
});
pad.addEventListener('pointermove', (e) => {
  if (e.pointerId !== padPtr) return;
  const r = pad.getBoundingClientRect();
  padStrokes[padStrokes.length - 1].push([e.clientX - r.left, e.clientY - r.top]);
  drawPad();
});
pad.addEventListener('pointerup', () => { padPtr = null; });
pad.addEventListener('pointercancel', () => { padPtr = null; });
$('#sig-clear').addEventListener('click', () => { padStrokes = []; drawPad(); });

function trimmedPadPng() {
  const ctx = pad.getContext('2d');
  const { width, height } = pad;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const m = 6;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(width - 1, x1 + m); y1 = Math.min(height - 1, y1 + m);
  const c = document.createElement('canvas');
  c.width = x1 - x0 + 1; c.height = y1 - y0 + 1;
  c.getContext('2d').drawImage(pad, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  return { src: c.toDataURL('image/png'), iw: c.width, ih: c.height };
}

function renderSavedSigs() {
  const box = $('#saved-sigs');
  box.textContent = '';
  savedSigs().forEach((sig, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'saved-sig';
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'use';
    use.innerHTML = `<img alt="Firma guardada ${i + 1}">`;
    use.querySelector('img').src = sig.src;
    use.onclick = () => { usePendingImage({ ...sig, kind: 'sign' }); $('#dlg-sign').close('used'); };
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Borrar firma guardada');
    del.onclick = () => { setSavedSigs(savedSigs().filter((_, j) => j !== i)); renderSavedSigs(); };
    wrap.append(use, del);
    box.append(wrap);
  });
}

function openSignDialog() {
  padStrokes = [];
  renderSavedSigs();
  const d = $('#dlg-sign');
  d.returnValue = '';
  d.showModal();
  requestAnimationFrame(resizePad);
}
$('#dlg-sign').addEventListener('close', () => {
  const d = $('#dlg-sign');
  if (d.returnValue !== 'ok') { if (d.returnValue !== 'used' && !state.pendingImage) setTool('pan'); return; }
  const sig = trimmedPadPng();
  if (!sig) { toast('No has dibujado ninguna firma.'); setTool('pan'); return; }
  if ($('#sig-remember').checked) setSavedSigs([sig, ...savedSigs()]);
  usePendingImage({ ...sig, kind: 'sign' });
});

function usePendingImage(img) {
  state.pendingImage = img;
  toast('Toca la página donde quieres colocarla.');
}

/* ---------------- Imagen ---------------- */

$('#file-img').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) { if (!state.pendingImage) setTool('pan'); return; }
  try {
    const url = URL.createObjectURL(f);
    const img = await loadImage(url);
    URL.revokeObjectURL(url);
    const max = 1600, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const png = /png|gif|webp/i.test(f.type);
    const src = png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
    setTool('image');
    usePendingImage({ src, iw: c.width, ih: c.height, kind: 'image' });
  } catch {
    toast('No se pudo leer esa imagen.');
  }
});

/* ---------------- Páginas ---------------- */

const thumbCache = new Map(); // `${srcId}#${index}:${rotation}` -> canvas
async function thumbFor(p) {
  const rotation = pageRotation(p);
  const key = `${p.src}#${p.index}:${rotation}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const src = state.sources.get(p.src);
  const proxy = await src.doc.getPage(p.index + 1);
  const [dw] = pageDisplaySize(p);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = proxy.getViewport({ scale: (120 / dw) * dpr, rotation });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  c.style.width = vp.width / dpr + 'px';
  await proxy.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  thumbCache.set(key, c);
  return c;
}

const ICON = {
  rotate: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
};

let pagesDirty = false;
function renderThumbs() {
  const box = $('#thumbs');
  box.textContent = '';
  state.pages.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'thumb';
    const holder = document.createElement('div');
    holder.style.minHeight = '60px';
    holder.onclick = () => { $('#dlg-pages').close(); views.get(p.id)?.el.scrollIntoView({ block: 'start' }); };
    const num = document.createElement('div');
    num.className = 't-num';
    num.textContent = `Página ${i + 1}`;
    const acts = document.createElement('div');
    acts.className = 't-actions';
    const mk = (icon, label, fn, cls = '') => {
      const b = document.createElement('button');
      b.innerHTML = ICON[icon];
      b.setAttribute('aria-label', label);
      if (cls) b.className = cls;
      b.onclick = fn;
      acts.append(b);
      return b;
    };
    mk('up', 'Mover antes', () => movePage(i, -1)).disabled = i === 0;
    mk('rotate', 'Girar', () => pageOp(() => { p.rot = (p.rot + 90) % 360; }));
    mk('down', 'Mover después', () => movePage(i, 1)).disabled = i === state.pages.length - 1;
    mk('del', 'Eliminar página', () => {
      if (state.pages.length === 1) { toast('El documento necesita al menos una página.'); return; }
      pageOp(() => state.pages.splice(i, 1));
    }, 'danger');
    card.append(holder, num, acts);
    box.append(card);
    thumbFor(p).then((c) => holder.append(c)).catch(() => {});
  });
}
function pageOp(fn) {
  pushUndo();
  fn();
  pagesDirty = true;
  renderThumbs();
  updateHeader();
  saveMeta();
}
function movePage(i, d) {
  pageOp(() => { const [p] = state.pages.splice(i, 1); state.pages.splice(i + d, 0, p); });
}
function openPagesDialog() {
  pagesDirty = false;
  renderThumbs();
  $('#dlg-pages').showModal();
}
$('#pages-close').addEventListener('click', () => $('#dlg-pages').close());
$('#dlg-pages').addEventListener('close', () => { if (pagesDirty) layout(); });
$('#pages-add-pdf').addEventListener('click', () => { pickAppend = true; $('#file-pdf-multi').click(); });
$('#pages-add-blank').addEventListener('click', async () => { await addBlankPage(); pagesDirty = false; renderThumbs(); });

/* ---------------- Formulario ---------------- */

function openFormDialog() {
  const box = $('#form-fields');
  box.textContent = '';
  const srcs = [...state.sources.values()].filter((s) => s.fields.length);
  for (const s of srcs) {
    if (srcs.length > 1) {
      const h = document.createElement('div');
      h.className = 'form-src';
      h.textContent = s.name;
      box.append(h);
    }
    s.fields.forEach((f, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      const id = `f-${s.id}-${i}`;
      if (f.type === 'check') {
        wrap.innerHTML = `<label class="check"><input type="checkbox" id="${id}"> <span></span></label>`;
        wrap.querySelector('span').textContent = f.name;
        wrap.querySelector('input').checked = f.value;
      } else {
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = f.name;
        let input;
        if (f.type === 'text') {
          input = document.createElement(f.multiline ? 'textarea' : 'input');
          if (!f.multiline) input.type = 'text';
          input.value = f.value;
        } else {
          input = document.createElement('select');
          for (const o of ['', ...f.options]) {
            const op = document.createElement('option');
            op.value = o; op.textContent = o || '—';
            input.append(op);
          }
          input.value = f.value;
        }
        input.id = id;
        wrap.append(label, input);
      }
      box.append(wrap);
    });
  }
  $('#dlg-form').showModal();
}
$('#form-close').addEventListener('click', () => $('#dlg-form').close());
$('#form-apply').addEventListener('click', async () => {
  busy('Rellenando formulario…');
  let failed = 0;
  try {
    for (const s of state.sources.values()) {
      if (!s.fields.length) continue;
      let changed = false;
      s.fields.forEach((f, i) => {
        const el = document.getElementById(`f-${s.id}-${i}`);
        if (!el) return;
        const val = f.type === 'check' ? el.checked : el.value;
        if (val !== f.value) { f.next = val; changed = true; }
      });
      if (!changed) continue;
      const lib = await PDFDocument.load(s.bytes, { ignoreEncryption: true, updateMetadata: false });
      const form = lib.getForm();
      for (const f of s.fields) {
        if (!('next' in f)) continue;
        try {
          const fld = form.getField(f.name);
          if (f.type === 'text') fld.setText(f.next || undefined);
          else if (f.type === 'check') f.next ? fld.check() : fld.uncheck();
          else if (f.next) fld.select(f.next);
          else fld.clear?.();
        } catch { failed++; }
      }
      const bytes = await lib.save();
      s.fields.forEach((f) => { if ('next' in f) { f.value = f.next; delete f.next; } });
      s.doc.destroy();
      s.bytes = bytes;
      s.doc = await openPdfjs(bytes);
      saveSource(s);
      rerenderSource(s.id);
    }
    $('#dlg-form').close();
    toast(failed ? `Listo, pero ${failed} campo(s) no se pudieron rellenar.` : 'Formulario actualizado.');
  } catch (e) {
    console.error(e);
    toast('No se pudo rellenar. Evita emojis o caracteres especiales.', 4000);
    for (const s of state.sources.values()) s.fields.forEach((f) => delete f.next);
  } finally {
    busy(null);
  }
});

/* ---------------- Exportar ---------------- */

function winAnsiSafe(font, text) {
  let out = '';
  for (const ch of text) {
    try { font.encodeText(ch); out += ch; } catch { out += '?'; }
  }
  return out;
}

async function rasterPage(out, src, p) {
  // Solo para PDF cifrados que pdf-lib no puede copiar: la página se convierte en imagen.
  const proxy = await src.doc.getPage(p.index + 1);
  const w = p.view[2] - p.view[0], h = p.view[3] - p.view[1];
  const s = Math.min(2.5, 2200 / Math.max(w, h));
  const vp = proxy.getViewport({ scale: s, rotation: 0 });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await proxy.render({ canvasContext: ctx, viewport: vp }).promise;
  const jpg = await out.embedJpg(dataUrlToBytes(c.toDataURL('image/jpeg', 0.9)));
  c.width = c.height = 0;
  const pg = out.addPage([w, h]);
  pg.drawImage(jpg, { x: 0, y: 0, width: w, height: h });
  pg.setRotation(degrees(pageRotation(p)));
  return { pg, offX: -p.view[0], offY: -p.view[1] };
}

async function buildPdf() {
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const libs = new Map();
  let rastered = 0;
  for (const id of new Set(state.pages.map((p) => p.src))) {
    try {
      const lib = await PDFDocument.load(state.sources.get(id).bytes, { updateMetadata: false });
      try { const f = lib.getForm(); if (f.getFields().length) f.flatten(); } catch { /* sin formulario */ }
      libs.set(id, lib);
    } catch {
      libs.set(id, null);
    }
  }
  const copied = new Map();
  for (const [id, lib] of libs) {
    if (!lib) continue;
    const mine = state.pages.filter((p) => p.src === id);
    const cps = await out.copyPages(lib, mine.map((p) => p.index));
    mine.forEach((p, i) => copied.set(p.id, cps[i]));
  }
  const images = new Map();
  const embedImage = async (src) => {
    if (!images.has(src)) {
      const bytes = dataUrlToBytes(src);
      images.set(src, src.startsWith('data:image/png') ? await out.embedPng(bytes) : await out.embedJpg(bytes));
    }
    return images.get(src);
  };

  for (const p of state.pages) {
    let pg, offX = 0, offY = 0;
    if (copied.has(p.id)) {
      pg = out.addPage(copied.get(p.id));
      pg.setRotation(degrees((((pg.getRotation().angle + p.rot) % 360) + 360) % 360));
    } else {
      ({ pg, offX, offY } = await rasterPage(out, state.sources.get(p.src), p));
      rastered++;
    }
    if (p.annots.some((a) => a.type === 'path') && PDFLib.setLineJoin && PDFLib.LineJoinStyle) {
      pg.pushOperators(PDFLib.setLineJoin(PDFLib.LineJoinStyle.Round));
    }
    for (const a of p.annots) {
      if (a.type === 'path') {
        const color = hexToRgb(a.color), opacity = a.opacity ?? 1;
        if (a.pts.length === 1) {
          pg.drawCircle({ x: a.pts[0][0] + offX, y: a.pts[0][1] + offY, size: a.width / 2, color, opacity });
        } else {
          const d = a.pts.map((q, i) => `${i ? 'L' : 'M'}${(q[0] + offX).toFixed(2)} ${(-(q[1] + offY)).toFixed(2)}`).join(' ');
          pg.drawSvgPath(d, { x: 0, y: 0, borderColor: color, borderWidth: a.width, borderOpacity: opacity, borderLineCap: LineCapStyle.Round });
        }
      } else if (a.type === 'rect') {
        pg.drawRectangle({ x: a.x + offX, y: a.y + offY, width: a.w, height: a.h, color: hexToRgb(a.color) });
      } else if (a.type === 'text') {
        const lh = a.size * LINE_H;
        a.text.split('\n').forEach((line, i) => {
          if (!line) return;
          const [dx, dy] = rotVec(0, -i * lh, a.rot);
          pg.drawText(winAnsiSafe(font, line), {
            x: a.x + dx + offX, y: a.y + dy + offY, size: a.size, font, color: hexToRgb(a.color), rotate: degrees(a.rot),
          });
        });
      } else if (a.type === 'image') {
        pg.drawImage(await embedImage(a.src), { x: a.x + offX, y: a.y + offY, width: a.w, height: a.h, rotate: degrees(a.rot) });
      }
    }
  }
  return { bytes: await out.save(), rastered };
}

let exported = null;
$('#btn-save').addEventListener('click', async () => {
  busy('Creando PDF…');
  try {
    const { bytes, rastered } = await buildPdf();
    const name = (state.name || 'documento') + '-editado.pdf';
    if (exported?.url) URL.revokeObjectURL(exported.url);
    const file = new File([bytes], name, { type: 'application/pdf' });
    exported = { file, url: URL.createObjectURL(file) };
    const a = $('#export-download');
    a.href = exported.url;
    a.download = name;
    const kb = bytes.length / 1024;
    $('#export-info').textContent = `${name} · ${state.pages.length} pág. · ${kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.round(kb) + ' KB'}` +
      (rastered ? ` · ${rastered} página(s) protegidas se guardaron como imagen.` : '');
    $('#export-share').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    $('#dlg-export').showModal();
  } catch (e) {
    console.error(e);
    toast('No se pudo crear el PDF: ' + (e.message || e), 5000);
  } finally {
    busy(null);
  }
});
$('#export-share').addEventListener('click', async () => {
  try {
    await navigator.share({ files: [exported.file], title: exported.file.name });
  } catch (e) {
    if (e.name !== 'AbortError') toast('No se pudo compartir. Prueba con «Abrir / Descargar».');
  }
});
$('#export-close').addEventListener('click', () => $('#dlg-export').close());

/* ---------------- Botones generales ---------------- */

let pickAppend = false;
$('#btn-open').addEventListener('click', () => $('#file-pdf').click());
$('#btn-merge').addEventListener('click', () => { pickAppend = false; $('#file-pdf-multi').click(); });
$('#btn-resume').addEventListener('click', resumeSession);
$('#file-pdf').addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; openFiles(f); });
$('#file-pdf-multi').addEventListener('change', (e) => {
  const f = [...e.target.files]; e.target.value = '';
  const append = pickAppend; pickAppend = false;
  openFiles(f, { append }).then(() => { if (append && $('#dlg-pages').open) { pagesDirty = false; renderThumbs(); } });
});
$('#btn-home').addEventListener('click', () => { saveMeta(); showWelcome(); });
$('#btn-undo').addEventListener('click', () => restore(state.undo, state.redo));
$('#btn-redo').addEventListener('click', () => restore(state.redo, state.undo));

function setZoom(z) {
  z = Math.max(0.5, Math.min(4, z));
  if (z === state.zoom) return;
  const ry = viewer.scrollTop / Math.max(1, viewer.scrollHeight);
  state.zoom = z;
  layout();
  viewer.scrollTop = ry * viewer.scrollHeight;
}
$('#btn-zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.25));
$('#btn-zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.25));

let lastWidth = viewer.clientWidth;
window.addEventListener('resize', debounce(() => {
  if (!state.pages.length || viewer.hidden || viewer.clientWidth === lastWidth) return;
  lastWidth = viewer.clientWidth;
  layout();
}, 250));

if (navigator.standalone || matchMedia('(display-mode: standalone)').matches) $('#install-hint').hidden = true;

window.addEventListener('unhandledrejection', (e) => console.error(e.reason));

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

showWelcome();
