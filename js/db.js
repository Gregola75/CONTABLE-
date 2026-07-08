/* CONTABLE — almacenamiento local con IndexedDB.
   Guarda facturas y cierres con sus imágenes (Blob) en el dispositivo. */

const DB = (() => {
  const NOMBRE = 'contable-db';
  const VERSION = 1;
  let db = null;

  function abrir() {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);
      const req = indexedDB.open(NOMBRE, VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('registros')) {
          const store = d.createObjectStore('registros', { keyPath: 'id', autoIncrement: true });
          store.createIndex('tipo', 'tipo');
          store.createIndex('fecha', 'fecha');
          store.createIndex('proveedor', 'proveedor');
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(modo, fn) {
    return abrir().then(d => new Promise((resolve, reject) => {
      const t = d.transaction('registros', modo);
      const store = t.objectStore('registros');
      const res = fn(store);
      t.oncomplete = () => resolve(res.__valor !== undefined ? res.__valor : res);
      t.onerror = () => reject(t.error);
    }));
  }

  /* Registro:
     { id, tipo: 'factura'|'cierre', fecha: 'YYYY-MM-DD',
       proveedor, nif, categoria, total, efectivo, tarjeta, notas,
       imagen: Blob|null, ocrTexto, creado: ISOString } */

  async function guardar(registro) {
    const d = await abrir();
    return new Promise((resolve, reject) => {
      const t = d.transaction('registros', 'readwrite');
      const req = t.objectStore('registros').put(registro);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function borrar(id) {
    const d = await abrir();
    return new Promise((resolve, reject) => {
      const t = d.transaction('registros', 'readwrite');
      const req = t.objectStore('registros').delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function obtener(id) {
    const d = await abrir();
    return new Promise((resolve, reject) => {
      const req = d.transaction('registros').objectStore('registros').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function todos() {
    const d = await abrir();
    return new Promise((resolve, reject) => {
      const req = d.transaction('registros').objectStore('registros').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  /* Búsqueda con filtros: { tipo, desde, hasta, proveedor } */
  async function buscar(filtros = {}) {
    const lista = await todos();
    return lista.filter(r => {
      if (filtros.tipo && filtros.tipo !== 'todos' && r.tipo !== filtros.tipo) return false;
      if (filtros.desde && r.fecha < filtros.desde) return false;
      if (filtros.hasta && r.fecha > filtros.hasta) return false;
      if (filtros.proveedor) {
        const p = (r.proveedor || '').toLowerCase();
        if (!p.includes(filtros.proveedor.toLowerCase())) return false;
      }
      return true;
    }).sort((a, b) => b.fecha.localeCompare(a.fecha) || (b.id - a.id));
  }

  async function proveedores() {
    const lista = await todos();
    const set = new Set();
    lista.forEach(r => { if (r.tipo === 'factura' && r.proveedor) set.add(r.proveedor.trim()); });
    return [...set].sort((a, b) => a.localeCompare(b, 'es'));
  }

  /* ---- Copia de seguridad ---- */

  function blobADataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  function dataURLABlob(dataURL) {
    const [cab, datos] = dataURL.split(',');
    const mime = cab.match(/data:(.*?);/)[1];
    const bin = atob(datos);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  async function exportarTodo() {
    const lista = await todos();
    const salida = [];
    for (const r of lista) {
      const copia = { ...r };
      if (copia.imagen instanceof Blob) {
        copia.imagen = await blobADataURL(copia.imagen);
      }
      salida.push(copia);
    }
    return { app: 'CONTABLE', version: 1, exportado: new Date().toISOString(), registros: salida };
  }

  async function importarTodo(datos) {
    if (!datos || datos.app !== 'CONTABLE' || !Array.isArray(datos.registros)) {
      throw new Error('El archivo no es una copia de seguridad válida de CONTABLE.');
    }
    let n = 0;
    for (const r of datos.registros) {
      const copia = { ...r };
      delete copia.id; // evitar choques de ids: se reasignan
      if (typeof copia.imagen === 'string' && copia.imagen.startsWith('data:')) {
        copia.imagen = dataURLABlob(copia.imagen);
      }
      await guardar(copia);
      n++;
    }
    return n;
  }

  return { guardar, borrar, obtener, todos, buscar, proveedores, exportarTodo, importarTodo };
})();
