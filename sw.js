/* WanderContable — service worker: permite abrir la app sin conexión
   (los datos ya viven en el dispositivo; esto cachea la propia app).

   Estrategia:
   - Páginas y archivos propios: RED PRIMERO (siempre la última versión
     publicada si hay conexión) con la copia en caché como respaldo offline.
   - Recursos externos (OCR, fuentes, pdf.js): caché primero, porque están
     versionados en su URL y no cambian. */

const CACHE = 'contable-v32';
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
      Promise.all(claves.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const esPropio = url.origin === self.location.origin;

  if (esPropio) {
    // Red primero: los cambios publicados se ven a la primera recarga
    e.respondWith(
      fetch(new Request(e.request, { cache: 'no-cache' }))
        .then(resp => {
          if (resp.ok) {
            const clon = resp.clone();
            caches.open(CACHE).then(c => c.put(e.request, clon));
          }
          return resp;
        })
        .catch(() => caches.match(e.request).then(res => res || caches.match('./index.html')))
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
          caches.open(CACHE).then(c => c.put(e.request, clon));
        }
        return resp;
      });
    })
  );
});
