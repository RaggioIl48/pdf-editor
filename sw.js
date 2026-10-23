// Guarda la app en el iPhone para que funcione sin conexión.
// Al cambiar cualquier archivo de la app, sube VERSION para que los teléfonos descarguen la nueva.
const VERSION = 'v2';
const CACHE = 'pdf-editor-' + VERSION;
const CORE = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'vendor/pdf.min.js',
  'vendor/pdf.worker.min.js',
  'vendor/pdf-lib.min.js',
  'vendor/standard_fonts/FoxitDingbats.pfb',
  'vendor/standard_fonts/FoxitFixed.pfb',
  'vendor/standard_fonts/FoxitFixedBold.pfb',
  'vendor/standard_fonts/FoxitFixedBoldItalic.pfb',
  'vendor/standard_fonts/FoxitFixedItalic.pfb',
  'vendor/standard_fonts/FoxitSerif.pfb',
  'vendor/standard_fonts/FoxitSerifBold.pfb',
  'vendor/standard_fonts/FoxitSerifBoldItalic.pfb',
  'vendor/standard_fonts/FoxitSerifItalic.pfb',
  'vendor/standard_fonts/FoxitSymbol.pfb',
  'vendor/standard_fonts/LiberationSans-Bold.ttf',
  'vendor/standard_fonts/LiberationSans-BoldItalic.ttf',
  'vendor/standard_fonts/LiberationSans-Italic.ttf',
  'vendor/standard_fonts/LiberationSans-Regular.ttf',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pdf-editor-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Primero la copia guardada; lo que no esté (p. ej. cmaps de idiomas asiáticos) se descarga una vez y se guarda.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
