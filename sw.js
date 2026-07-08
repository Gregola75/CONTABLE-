/* CONTABLE — service worker: permite abrir la app sin conexión
   (los datos ya viven en el dispositivo; esto cachea la propia app). */

const CACHE = 'contable-v10';
const ARCHIVOS = [
  './',
  './index.html',
  './css/styles.css',
  './js/seguridad.js',
  './js/db.js',
  './js/ocr.js',
  './js/report.js',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png'
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
        // Cachear también el motor de OCR (Tesseract) y las fuentes tras la primera descarga
        if (resp.ok && (e.request.url.includes('jsdelivr') || e.request.url.includes('tesseract') ||
            e.request.url.includes('fonts.googleapis') || e.request.url.includes('fonts.gstatic'))) {
          const clon = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clon));
        }
        return resp;
      });
    })
  );
});
