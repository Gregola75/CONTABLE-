/* WanderContable — service worker: permite abrir la app sin conexión
   (los datos ya viven en el dispositivo; esto cachea la propia app).

   Estrategia:
   - Páginas y archivos propios: CACHÉ PRIMERO (arranque instantáneo) con
     actualización en segundo plano; al publicar una versión nueva (cambia
     CACHE) el service worker se reinstala con todos los archivos frescos.
   - Recursos externos (OCR, fuentes, pdf.js): caché primero, porque están
     versionados en su URL y no cambian. */

const CACHE = 'contable-v47';
// Los recursos externos (lector OCR ~15 MB, fuentes, pdf.js) van en una caché
// aparte que NO se borra al actualizar la app: se descargan una sola vez.
const CACHE_EXTERNOS = 'contable-externos-v1';
const ARCHIVOS = [
  './',
  './index.html',
  './css/styles.css',
  './js/seguridad.js',
  './js/db.js',
  './js/nube.js',
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
  e.waitUntil(
    caches.open(CACHE)
      // 'reload' salta la caché HTTP del navegador: siempre baja la versión publicada
      .then(c => c.addAll(ARCHIVOS.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(claves =>
      Promise.all(claves.filter(k => k !== CACHE && k !== CACHE_EXTERNOS).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const esPropio = url.origin === self.location.origin;

  if (esPropio) {
    // Caché primero (la app arranca al instante, sin esperar a internet) y
    // actualización en segundo plano: la versión nueva queda lista para la
    // siguiente apertura. Además, cada versión nueva de sw.js reinstala todo.
    e.respondWith(
      caches.match(e.request).then(enCache => {
        const red = fetch(new Request(e.request, { cache: 'no-cache' }))
          .then(resp => {
            if (resp.ok) {
              const clon = resp.clone();
              caches.open(CACHE).then(c => c.put(e.request, clon));
            }
            return resp;
          })
          .catch(() => null);
        if (enCache) { e.waitUntil(red); return enCache; }
        return red.then(resp => resp || caches.match('./index.html'));
      })
    );
    return;
  }

  // Externos (Tesseract, fuentes, pdf.js): caché primero, red y guardar si no está
  e.respondWith(
    caches.match(e.request).then(res => {
      if (res) return res;
      return fetch(e.request).then(resp => {
        if (resp.ok && (url.href.includes('jsdelivr') || url.href.includes('tesseract') ||
            url.href.includes('fonts.googleapis') || url.href.includes('fonts.gstatic') ||
            url.href.includes('gstatic.com/firebasejs'))) {
          const clon = resp.clone();
          caches.open(CACHE_EXTERNOS).then(c => c.put(e.request, clon));
        }
        return resp;
      });
    })
  );
});
