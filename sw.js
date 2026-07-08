/* CONTABLE — service worker: permite abrir la app sin conexión
   (los datos ya viven en el dispositivo; esto cachea la propia app). */

const CACHE = 'contable-v3';
const ARCHIVOS = [
  './',
  './index.html',
  './css/styles.css',
  './js/db.js',
  './js/ocr.js',
  './js/report.js',
  './js/app.js',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(claves =>
      Promise.all(claves.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(res => {
      if (res) return res;
      return fetch(e.request).then(resp => {
        // Cachear también el motor de OCR (Tesseract) tras la primera descarga
        if (resp.ok && (e.request.url.includes('jsdelivr') || e.request.url.includes('tesseract'))) {
          const clon = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clon));
        }
        return resp;
      });
    })
  );
});
