/* WanderContable — service worker: permite abrir la app sin conexión
   (los datos ya viven en el dispositivo; esto cachea la propia app).

   Estrategia:
   - Páginas y archivos propios: CACHÉ PRIMERO (arranque instantáneo) con
     actualización en segundo plano; al publicar una versión nueva (cambia
     CACHE) el service worker se reinstala con todos los archivos frescos.
   - Recursos externos (OCR, fuentes, pdf.js): caché primero, porque están
     versionados en su URL y no cambian. */

const CACHE = 'contable-v86';
// Los recursos externos (lector OCR ~15 MB, fuentes, pdf.js) van en una caché
// aparte que NO se borra al actualizar la app: se descargan una sola vez.
const CACHE_EXTERNOS = 'contable-externos-v1';
// Los ajustes del aviso diario (lo que la página le deja dicho a este archivo)
const CACHE_AVISOS = 'contable-avisos-v1';

// Qué dice el aviso diario: lo calcula el propio móvil con sus datos
importScripts('./js/avisos-parte.js');
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
  './js/asesor.js',
  './js/avisos-parte.js',
  './js/avisos.js',
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
      Promise.all(claves.filter(k => k !== CACHE && k !== CACHE_EXTERNOS && k !== CACHE_AVISOS).map(k => caches.delete(k)))
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

/* ---------- El aviso diario ----------
   Un programa en GitHub manda cada día un "toque" vacío a este móvil (no sabe
   nada de las cuentas). Al recibirlo, se leen AQUÍ los cierres y el personal
   guardados en el teléfono y se escribe la notificación. Nada sale del móvil. */

/* Lee de la base de datos de la app lo que hace falta: los cierres y el personal.
   Si la base de datos aún no existe no se crea (eso es cosa de la app). */
function leerDatosAvisos() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('contable-db');
    req.onupgradeneeded = (e) => { e.target.transaction.abort(); };
    req.onerror = () => reject(req.error || new Error('sin base de datos'));
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction(['registros', 'personal'], 'readonly');
        const cierres = tx.objectStore('registros').index('tipo').getAll('cierre');
        const personal = tx.objectStore('personal').getAll();
        tx.oncomplete = () => { db.close(); resolve([cierres.result || [], personal.result || []]); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error || new Error('lectura cancelada')); };
      } catch (err) { db.close(); reject(err); }
    };
  });
}

async function leerAjustesAvisos() {
  try {
    const r = await (await caches.open(CACHE_AVISOS)).match('./__avisos-ajustes');
    return r ? await r.json() : {};
  } catch (e) { return {}; }
}

async function avisoDeHoy() {
  try {
    const [cierres, personal] = await leerDatosAvisos();
    return self.PARTE_AVISOS.calcular(cierres, personal, self.PARTE_AVISOS.hoy(), await leerAjustesAvisos());
  } catch (e) {
    // Si no se pueden leer los datos, el aviso sale igual: nunca en silencio
    return { titulo: '📣 Parte de hoy', cuerpo: 'Abre la app para ver cómo va todo.', avisos: [], hayAvisos: false };
  }
}

async function mostrarAviso() {
  const n = await avisoDeHoy();
  await self.registration.showNotification(n.titulo, {
    body: n.cuerpo,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: 'contable-parte',         // el de hoy sustituye al de ayer si sigue ahí
    renotify: n.hayAvisos,
    silent: !n.hayAvisos,          // sin nada pendiente, no suena
    data: { url: self.registration.scope }
  });
  return n;
}

self.addEventListener('push', (e) => { e.waitUntil(mostrarAviso()); });

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(lista => {
    const abierta = lista.find(c => c.url.startsWith(self.registration.scope));
    return abierta ? abierta.focus() : self.clients.openWindow(url);
  }));
});

// La página puede pedir el aviso de prueba ("Probar el aviso ahora") o solo el texto
self.addEventListener('message', (e) => {
  const tipo = e.data && e.data.tipo;
  if (tipo !== 'probar-aviso' && tipo !== 'calcular-aviso') return;
  const responder = (dato) => { if (e.ports && e.ports[0]) e.ports[0].postMessage(dato); };
  e.waitUntil((tipo === 'probar-aviso' ? mostrarAviso() : avisoDeHoy())
    .then(n => responder({ ok: true, aviso: n }))
    .catch(err => responder({ ok: false, error: String((err && err.message) || err) })));
});
