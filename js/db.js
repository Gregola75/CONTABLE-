/* CONTABLE — almacenamiento local con IndexedDB.
   Guarda facturas, cierres (con sus imágenes en Blob) y la lista
   de proveedores del negocio, todo en el propio dispositivo. */

const DB = (() => {
  const NOMBRE = 'contable-db';
  const VERSION = 2;
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
        if (!d.objectStoreNames.contains('proveedores')) {
          const store = d.createObjectStore('proveedores', { keyPath: 'id', autoIncrement: true });
          store.createIndex('nombre', 'nombre');
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  function pedir(almacen, modo, fn) {
    return abrir().then(d => new Promise((resolve, reject) => {
      const req = fn(d.transaction(almacen, modo).objectStore(almacen));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  /* ==================== REGISTROS (facturas y cierres) ====================
     { id, tipo: 'factura'|'cierre', fecha: 'YYYY-MM-DD',
       proveedor, nif, categoria, total, efectivo, tarjeta, notas,
       imagen: Blob|null, ocrTexto, creado: ISOString } */

  const guardar = (registro) => pedir('registros', 'readwrite', s => s.put(registro));
  const borrar = (id) => pedir('registros', 'readwrite', s => s.delete(id));
  const obtener = (id) => pedir('registros', 'readonly', s => s.get(id)).then(r => r || null);
  const todos = () => pedir('registros', 'readonly', s => s.getAll()).then(r => r || []);

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

  /* ==================== PROVEEDORES ====================
     { id, nombre, nif, categoria, creado } */

  const provGuardar = (p) => pedir('proveedores', 'readwrite', s => s.put(p));
  const provBorrar = (id) => pedir('proveedores', 'readwrite', s => s.delete(id));
  const provTodos = () => pedir('proveedores', 'readonly', s => s.getAll())
    .then(r => (r || []).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')));

  /* Nombres para el autocompletado: proveedores dados de alta + los que
     aparecen en facturas ya guardadas. */
  async function proveedores() {
    const [alta, lista] = await Promise.all([provTodos(), todos()]);
    const set = new Set(alta.map(p => p.nombre.trim()));
    lista.forEach(r => { if (r.tipo === 'factura' && r.proveedor) set.add(r.proveedor.trim()); });
    return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, 'es'));
  }

  /* ==================== Copia de seguridad ==================== */

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
    const provs = await provTodos();
    return {
      app: 'CONTABLE', version: 2, exportado: new Date().toISOString(),
      registros: salida, proveedores: provs
    };
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
    if (Array.isArray(datos.proveedores)) {
      const actuales = await provTodos();
      const nombres = new Set(actuales.map(p => p.nombre.trim().toLowerCase()));
      for (const p of datos.proveedores) {
        const copia = { ...p };
        delete copia.id;
        if (copia.nombre && !nombres.has(copia.nombre.trim().toLowerCase())) {
          await provGuardar(copia);
          nombres.add(copia.nombre.trim().toLowerCase());
          n++;
        }
      }
    }
    return n;
  }

  return {
    guardar, borrar, obtener, todos, buscar, proveedores,
    provGuardar, provBorrar, provTodos,
    exportarTodo, importarTodo
  };
})();
