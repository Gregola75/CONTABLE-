/* CONTABLE — almacenamiento local con IndexedDB.
   Guarda facturas, cierres (con sus imágenes en Blob) y la lista
   de proveedores del negocio, todo en el propio dispositivo. */

const DB = (() => {
  const NOMBRE = 'contable-db';
  const VERSION = 4;
  let db = null;

  function abrir() {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);
      const req = indexedDB.open(NOMBRE, VERSION);

      // Si otra pestaña vieja de la app mantiene la base de datos abierta,
      // la actualización de versión se queda bloqueada para siempre y nada
      // se guarda. Avisamos en claro en vez de colgarnos en silencio.
      const timeout = setTimeout(() => {
        reject(new Error('La base de datos está bloqueada por otra pestaña de la app. Cierra las demás pestañas (o reinicia el navegador) y vuelve a intentarlo.'));
      }, 8000);
      req.onblocked = () => {
        clearTimeout(timeout);
        reject(new Error('Hay otra pestaña de la app abierta con una versión antigua. Ciérrala (o reinicia el navegador) y vuelve a intentarlo.'));
      };

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
        // v4: control de personal (trabajadores y entregas de dinero)
        if (!d.objectStoreNames.contains('personal')) {
          d.createObjectStore('personal', { keyPath: 'id', autoIncrement: true });
        }
        if (!d.objectStoreNames.contains('pagos')) {
          const store = d.createObjectStore('pagos', { keyPath: 'id', autoIncrement: true });
          store.createIndex('trabajador', 'trabajadorSid');
        }
      };
      req.onsuccess = () => {
        clearTimeout(timeout);
        db = req.result;
        // Si en el futuro otra pestaña necesita subir de versión, soltar la
        // conexión para no bloquearla (esta pestaña reabrirá al siguiente uso)
        db.onversionchange = () => { try { db.close(); } catch (e) { /* nada */ } db = null; };
        resolve(db);
      };
      req.onerror = () => { clearTimeout(timeout); reject(req.error); };
    });
  }

  /* ---------- Sincronización: identidad estable y avisos de cambio ----------
     Cada registro/proveedor lleva:
     - sid: identificador único que no cambia entre dispositivos
     - mod: fecha-hora de la última modificación (para resolver conflictos)
     Cuando algo cambia en local se avisa (js/nube.js escucha para subirlo).
     Los cambios que VIENEN de la nube se aplican con { remoto: true } para
     no volver a subirlos en bucle. */

  const nuevoSid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

  let alCambioFn = null;
  const alCambio = (fn) => { alCambioFn = fn; };
  function avisar(evento, dato) {
    if (alCambioFn) {
      try { alCambioFn(evento, dato); } catch (e) { console.error(e); }
    }
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

  async function guardar(registro, opts = {}) {
    if (!registro.sid) registro.sid = nuevoSid();
    if (!opts.remoto) registro.mod = new Date().toISOString();
    const id = await pedir('registros', 'readwrite', s => s.put(registro));
    if (!opts.remoto) avisar('registro', { ...registro, id });
    return id;
  }
  async function borrar(id, opts = {}) {
    const r = await obtener(id);
    await pedir('registros', 'readwrite', s => s.delete(id));
    if (!opts.remoto && r) avisar('borrar-registro', r);
  }
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

  async function provGuardar(p, opts = {}) {
    if (!p.sid) p.sid = nuevoSid();
    if (!opts.remoto) p.mod = new Date().toISOString();
    const id = await pedir('proveedores', 'readwrite', s => s.put(p));
    if (!opts.remoto) avisar('proveedor', { ...p, id });
    return id;
  }
  async function provBorrar(id, opts = {}) {
    const p = await pedir('proveedores', 'readonly', s => s.get(id));
    await pedir('proveedores', 'readwrite', s => s.delete(id));
    if (!opts.remoto && p) avisar('borrar-proveedor', p);
  }
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

  /* ==================== PERSONAL (control privado de sueldos) ====================
     Trabajador: { id, sid, mod, nombre, sueldoMensual, tramos: [{objetivo, porcentaje}],
                   dias: ['YYYY-MM-DD', …] (días trabajados), notas, creado }
     Entrega:    { id, sid, mod, trabajadorSid, fecha, importe, notas, creado } */

  async function perGuardar(t, opts = {}) {
    if (!t.sid) t.sid = nuevoSid();
    if (!opts.remoto) t.mod = new Date().toISOString();
    const id = await pedir('personal', 'readwrite', s => s.put(t));
    if (!opts.remoto) avisar('personal', { ...t, id });
    return id;
  }
  async function perBorrar(id, opts = {}) {
    const t = await pedir('personal', 'readonly', s => s.get(id));
    await pedir('personal', 'readwrite', s => s.delete(id));
    if (!opts.remoto && t) avisar('borrar-personal', t);
  }
  const perTodos = () => pedir('personal', 'readonly', s => s.getAll())
    .then(r => (r || []).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')));

  async function pagoGuardar(p, opts = {}) {
    if (!p.sid) p.sid = nuevoSid();
    if (!opts.remoto) p.mod = new Date().toISOString();
    const id = await pedir('pagos', 'readwrite', s => s.put(p));
    if (!opts.remoto) avisar('pago', { ...p, id });
    return id;
  }
  async function pagoBorrar(id, opts = {}) {
    const p = await pedir('pagos', 'readonly', s => s.get(id));
    await pedir('pagos', 'readwrite', s => s.delete(id));
    if (!opts.remoto && p) avisar('borrar-pago', p);
  }
  const pagoTodos = () => pedir('pagos', 'readonly', s => s.getAll()).then(r => r || []);

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
      app: 'CONTABLE', version: 3, exportado: new Date().toISOString(),
      registros: salida, proveedores: provs,
      personal: await perTodos(), pagos: await pagoTodos()
    };
  }

  async function importarTodo(datos) {
    if (!datos || datos.app !== 'CONTABLE' || !Array.isArray(datos.registros)) {
      throw new Error('El archivo no es una copia de seguridad válida de CONTABLE.');
    }
    let n = 0;
    // No duplicar lo que ya está (mismo sid): restaurar una copia es seguro
    // aunque parte de los datos ya existan o ya estén sincronizados
    const sidsExistentes = new Set((await todos()).map(r => r.sid).filter(Boolean));
    for (const r of datos.registros) {
      const copia = { ...r };
      delete copia.id; // evitar choques de ids: se reasignan
      if (copia.sid && sidsExistentes.has(copia.sid)) continue;
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
    if (Array.isArray(datos.personal)) {
      const sids = new Set((await perTodos()).map(t => t.sid).filter(Boolean));
      for (const t of datos.personal) {
        const copia = { ...t };
        delete copia.id;
        if (copia.sid && sids.has(copia.sid)) continue;
        await perGuardar(copia);
        n++;
      }
    }
    if (Array.isArray(datos.pagos)) {
      const sids = new Set((await pagoTodos()).map(p => p.sid).filter(Boolean));
      for (const p of datos.pagos) {
        const copia = { ...p };
        delete copia.id;
        if (copia.sid && sids.has(copia.sid)) continue;
        await pagoGuardar(copia);
        n++;
      }
    }
    return n;
  }

  return {
    guardar, borrar, obtener, todos, buscar, proveedores,
    provGuardar, provBorrar, provTodos,
    perGuardar, perBorrar, perTodos,
    pagoGuardar, pagoBorrar, pagoTodos,
    exportarTodo, importarTodo, alCambio
  };
})();
