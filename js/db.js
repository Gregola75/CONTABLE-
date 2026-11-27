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

  /* Lo que ya estaba guardado (trae su id) conserva SIEMPRE su sid, aunque quien
     lo guarda no lo pase. Si al corregir una factura se le diera un sid nuevo, la
     nube la tomaría por otra distinta: quedarían la antigua y la corregida, y ese
     gasto se contaría dos veces. */
  async function ponerSid(almacen, obj) {
    if (obj.sid) return;
    if (obj.id != null) {
      const antes = await pedir(almacen, 'readonly', s => s.get(obj.id));
      if (antes && antes.sid) { obj.sid = antes.sid; return; }
    }
    obj.sid = nuevoSid();
  }

  /* Un mismo sid, un solo registro en el móvil. Qué id local tiene cada sid: se
     lee una vez de cada almacén y se mantiene al día con cada guardado y borrado. */
  const idsPorSid = {};
  function mapaSids(almacen) {
    if (!idsPorSid[almacen]) {
      idsPorSid[almacen] = pedir(almacen, 'readonly', s => s.getAll()).then(lista => {
        const m = new Map();
        // Los «gemelos» que ya hubiera (el mismo sid guardado más de una vez): sid → sus ids
        m.gemelos = new Map();
        (lista || []).forEach(x => {
          if (!x.sid) return;
          if (!m.has(x.sid)) { m.set(x.sid, x.id); return; }
          if (!m.gemelos.has(x.sid)) m.gemelos.set(x.sid, [m.get(x.sid)]);
          m.gemelos.get(x.sid).push(x.id);
        });
        return m;
      });
      idsPorSid[almacen].catch(() => { delete idsPorSid[almacen]; });
    }
    return idsPorSid[almacen];
  }

  /* El guardado de los cuatro almacenes. Devuelve el id local.
     Si llega algo SIN id pero con un sid que ya está en el móvil (la nube bajando
     mientras se restaura una copia, por ejemplo) no se añade otro registro: se
     actualiza el que hay si lo que llega es más nuevo, y si no, se deja como está.
     Dos registros con el mismo sid se contarían dos veces, y al borrar uno la nube
     borraría los dos. */
  async function poner(almacen, evento, obj, opts = {}) {
    await ponerSid(almacen, obj);
    if (!opts.remoto && !opts.conservarMod) obj.mod = new Date().toISOString();
    const mapa = await mapaSids(almacen);
    if (obj.id == null && mapa.has(obj.sid)) {
      let idYa = null;
      try { idYa = await mapa.get(obj.sid); } catch (e) { /* aquel guardado falló: este sigue como nuevo */ }
      const ya = idYa != null ? await pedir(almacen, 'readonly', s => s.get(idYa)) : null;
      if (ya && ya.sid === obj.sid) {
        opts.anadido = false;
        if (String(ya.mod || '') >= String(obj.mod || '')) return idYa;   // lo del móvil es igual o más nuevo
        obj.id = idYa;
      }
    }
    const escritura = pedir(almacen, 'readwrite', s => s.put(obj));
    const nuevo = obj.id == null;
    opts.anadido = nuevo;
    if (nuevo) mapa.set(obj.sid, escritura);   // quien llegue con este sid mientras tanto, espera a este
    let id;
    try { id = await escritura; }
    catch (e) { if (nuevo && mapa.get(obj.sid) === escritura) mapa.delete(obj.sid); throw e; }
    if (nuevo || !mapa.has(obj.sid)) mapa.set(obj.sid, id);
    if (!opts.remoto) avisar(evento, { ...obj, id });
    return id;
  }

  /* El borrado de los cuatro almacenes. */
  async function quitar(almacen, evento, id, opts = {}) {
    const antes = await pedir(almacen, 'readonly', s => s.get(id));
    const mapa = await mapaSids(almacen);          // antes de borrar: todavía lo cuenta
    await pedir(almacen, 'readwrite', s => s.delete(id));
    if (!antes) return;
    // ¿Queda en el móvil otro registro con el mismo sid (un «gemelo»)? Entonces en la
    // nube son el mismo apunte: avisar de este borrado lo borraría allí y, de vuelta,
    // borraría también el que queda. Se quita solo de este móvil.
    let quedaGemelo = false;
    if (antes.sid) {
      const ids = (mapa.gemelos.get(antes.sid) || []).filter(x => x !== id);
      quedaGemelo = ids.length > 0;
      if (quedaGemelo) {
        mapa.set(antes.sid, ids[0]);
        if (ids.length > 1) mapa.gemelos.set(antes.sid, ids); else mapa.gemelos.delete(antes.sid);
      } else if (mapa.get(antes.sid) === id) {
        mapa.delete(antes.sid);
      }
    }
    if (!opts.remoto && !quedaGemelo) avisar(evento, antes);
  }

  let alCambioFn = null;
  const alCambio = (fn) => { alCambioFn = fn; };
  function avisar(evento, dato) {
    if (alCambioFn) {
      try { alCambioFn(evento, dato); } catch (e) { console.error(e); }
    }
  }

  /* Una petición a un almacén. Las LECTURAS contestan en cuanto llega el dato.
     Las ESCRITURAS no se dan por buenas hasta que la transacción queda escrita de
     verdad: con el móvil sin sitio, el navegador acepta el dato y después cancela
     la transacción, y la app decía «Guardado» sin haber guardado nada. */
  function pedir(almacen, modo, fn) {
    return abrir().then(d => new Promise((resolve, reject) => {
      const tx = d.transaction(almacen, modo);
      const req = fn(tx.objectStore(almacen));
      if (modo !== 'readwrite') {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        return;
      }
      const fallo = (e) => {
        const err = tx.error || req.error || (e && e.target && e.target.error);
        const sinSitio = err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''));
        reject(sinSitio ? new Error('No queda sitio en el móvil: no se ha guardado. Libera espacio y vuelve a intentarlo.')
          : (err || new Error('No se pudo guardar en el dispositivo.')));
      };
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = fallo;
      tx.onerror = fallo;
    }));
  }

  /* ==================== REGISTROS (facturas y cierres) ====================
     { id, tipo: 'factura'|'cierre', fecha: 'YYYY-MM-DD',
       proveedor, nif, categoria, total, efectivo, tarjeta, notas,
       imagen: Blob|null, ocrTexto, creado: ISOString } */

  const guardar = (registro, opts = {}) => poner('registros', 'registro', registro, opts);
  const borrar = (id, opts = {}) => quitar('registros', 'borrar-registro', id, opts);
  /* Pone la miniatura a un registro SOLO si sigue siendo el mismo que se leyó (no
     se borró ni se corrigió mientras se hacía la miniatura). Va todo en una sola
     transacción: entre mirar y escribir no puede colarse nada. No cambia 'mod' ni
     se sube a la nube. */
  function ponerMiniatura(id, sid, mod, miniatura) {
    return abrir().then(d => new Promise((resolve, reject) => {
      const tx = d.transaction('registros', 'readwrite');
      const store = tx.objectStore('registros');
      let puesta = false;
      const lectura = store.get(id);
      lectura.onsuccess = () => {
        const r = lectura.result;
        if (r && r.sid === sid && (r.mod || '') === (mod || '') && r.imagen instanceof Blob && !(r.miniatura instanceof Blob)) {
          store.put({ ...r, miniatura });
          puesta = true;
        }
      };
      tx.oncomplete = () => resolve(puesta);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('No se pudo guardar la miniatura.'));
    }));
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
    }).sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')) || (b.id - a.id));
  }

  /* ==================== PROVEEDORES ====================
     { id, nombre, nif, categoria, creado } */

  const provGuardar = (p, opts = {}) => poner('proveedores', 'proveedor', p, opts);
  const provBorrar = (id, opts = {}) => quitar('proveedores', 'borrar-proveedor', id, opts);
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

  const perGuardar = (t, opts = {}) => poner('personal', 'personal', t, opts);
  const perBorrar = (id, opts = {}) => quitar('personal', 'borrar-personal', id, opts);
  const perTodos = () => pedir('personal', 'readonly', s => s.getAll())
    .then(r => (r || []).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')));

  const pagoGuardar = (p, opts = {}) => poner('pagos', 'pago', p, opts);
  const pagoBorrar = (id, opts = {}) => quitar('pagos', 'borrar-pago', id, opts);
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
      delete copia.miniatura;   // se vuelve a crear al restaurar; la copia va más ligera
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
    // Lo restaurado conserva su fecha de modificación ORIGINAL. Si se le pusiera la
    // de hoy, al conectar la nube pisaría datos más nuevos que hubiera allí (por
    // ejemplo, al estrenar móvil: restaurar la copia de hace un mes machacaría el mes
    // entero en la nube). Una copia antigua sin fecha se trata como muy vieja: que gane
    // la nube.
    const conMod = (obj) => ({ ...obj, mod: obj.mod || obj.creado || '1970-01-01T00:00:00.000Z' });
    const opciones = { conservarMod: true };
    // No duplicar lo que ya está (mismo sid): restaurar una copia es seguro
    // aunque parte de los datos ya existan o ya estén sincronizados
    const sidsExistentes = new Set((await todos()).map(r => r.sid).filter(Boolean));
    for (const r of datos.registros) {
      const copia = { ...r };
      delete copia.id; // evitar choques de ids: se reasignan
      delete copia.miniatura;
      if (copia.sid && sidsExistentes.has(copia.sid)) continue;
      if (typeof copia.imagen === 'string' && copia.imagen.startsWith('data:')) {
        copia.imagen = dataURLABlob(copia.imagen);
      }
      await guardar(conMod(copia), opciones);
      if (opciones.anadido) n++;
    }
    if (Array.isArray(datos.proveedores)) {
      const actuales = await provTodos();
      const nombres = new Set(actuales.map(p => p.nombre.trim().toLowerCase()));
      const sidsProv = new Set(actuales.map(p => p.sid).filter(Boolean));
      for (const p of datos.proveedores) {
        const copia = { ...p };
        delete copia.id;
        // El mismo proveedor (mismo sid) no se repite aunque ahora tenga otro nombre
        if (copia.sid && sidsProv.has(copia.sid)) continue;
        if (copia.nombre && !nombres.has(copia.nombre.trim().toLowerCase())) {
          await provGuardar(conMod(copia), opciones);
          if (opciones.anadido) n++;
          nombres.add(copia.nombre.trim().toLowerCase());
          if (copia.sid) sidsProv.add(copia.sid);
        }
      }
    }
    if (Array.isArray(datos.personal)) {
      const sids = new Set((await perTodos()).map(t => t.sid).filter(Boolean));
      for (const t of datos.personal) {
        const copia = { ...t };
        delete copia.id;
        if (copia.sid && sids.has(copia.sid)) continue;
        await perGuardar(conMod(copia), opciones);
        if (opciones.anadido) n++;
      }
    }
    if (Array.isArray(datos.pagos)) {
      const sids = new Set((await pagoTodos()).map(p => p.sid).filter(Boolean));
      for (const p of datos.pagos) {
        const copia = { ...p };
        delete copia.id;
        if (copia.sid && sids.has(copia.sid)) continue;
        await pagoGuardar(conMod(copia), opciones);
        if (opciones.anadido) n++;
      }
    }
    return n;
  }

  return {
    guardar, borrar, obtener, todos, buscar, proveedores, ponerMiniatura,
    provGuardar, provBorrar, provTodos,
    perGuardar, perBorrar, perTodos,
    pagoGuardar, pagoBorrar, pagoTodos,
    exportarTodo, importarTodo, alCambio
  };
})();
