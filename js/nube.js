/* WanderContable — sincronización en la nube (Firebase, proyecto del propio usuario).
   Los datos viajan a la base de datos Firestore del proyecto "wandercontable",
   protegida por reglas que solo permiten el acceso a la cuenta de Google del dueño.

   Cómo funciona la sincronización:
   - Cada registro/proveedor local lleva un identificador estable `sid` y una
     marca de modificación `mod` (los pone db.js al guardar).
   - Al iniciar sesión se escuchan las colecciones remotas; con cada cambio se
     "reconcilia": lo remoto más nuevo se aplica en local, lo local que falta
     o es más nuevo se sube, y lo marcado como borrado se borra en ambos lados.
   - Los borrados dejan una "lápida" en la colección `borrados` para que un
     dispositivo que estuvo sin conexión no resucite registros eliminados.
   - Las fotos se comprimen (JPEG) para caber en el documento de Firestore
     y aprovechar el plan gratuito. */

const NUBE = (() => {
  const CONFIG = {
    apiKey: 'AIzaSyDLXW_4Orgi-oDw6m2H_zKd_0xR2JFy304',
    authDomain: 'wandercontable.firebaseapp.com',
    projectId: 'wandercontable',
    storageBucket: 'wandercontable.firebasestorage.app',
    messagingSenderId: '984496596222',
    appId: '1:984496596222:web:20bcbf351cc9684c3031af'
  };

  const disponible = typeof firebase !== 'undefined';
  let auth = null;
  let db = null;
  let usuario = null;
  let estado = 'apagado'; // apagado | desconectado | conectando | sincronizando | sincronizado | error
  let detalle = '';
  let avisarUI = () => {};

  let paradas = []; // funciones para dejar de escuchar al cerrar sesión
  const remotos = { registros: new Map(), proveedores: new Map(), borrados: new Map() };
  const listos = { registros: false, proveedores: false, borrados: false };
  let timerReconciliar = null;
  let reconciliando = false;
  let reconciliarOtraVez = false;

  /* ---------- Utilidades ---------- */

  function dataURLABlob(dataURL) {
    const [cab, datos] = dataURL.split(',');
    const mime = (cab.match(/data:(.*?);/) || [])[1] || 'image/jpeg';
    const bin = atob(datos);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  /* Comprime la foto para que quepa en un documento de Firestore (máx. 1 MB)
     manteniendo la letra del desglose legible con el zoom. */
  function comprimirImagen(blob) {
    if (!(blob instanceof Blob)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let calidad = 0.66;
        let maxLado = 1700;
        let salida = null;
        for (let i = 0; i < 4; i++) {
          const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * escala));
          canvas.height = Math.max(1, Math.round(img.height * escala));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          salida = canvas.toDataURL('image/jpeg', calidad);
          if (salida.length <= 850000) break;
          calidad = Math.max(0.4, calidad - 0.13);
          maxLado = Math.max(1000, maxLado - 250);
        }
        resolve(salida && salida.length <= 990000 ? salida : null); // si no cabe, se sube sin foto
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  /* Deja el objeto listo para Firestore: sin Blob, sin campos internos,
     sin `undefined` (Firestore los rechaza). */
  async function aRemoto(obj) {
    const copia = { ...obj };
    delete copia.id;
    delete copia._thumb;
    const imagen = copia.imagen;
    delete copia.imagen;
    const limpio = JSON.parse(JSON.stringify(copia));
    limpio.imagenB64 = await comprimirImagen(imagen);
    return limpio;
  }

  function desdeRemoto(data) {
    const copia = { ...data };
    copia.imagen = copia.imagenB64 ? dataURLABlob(copia.imagenB64) : null;
    delete copia.imagenB64;
    return copia;
  }

  function col(nombre) {
    return db.collection('users').doc(usuario.uid).collection(nombre);
  }

  function cambiarEstado(nuevo, det = '') {
    estado = nuevo;
    detalle = det;
    avisarUI();
  }

  function traducirError(e) {
    const msg = String((e && e.message) || e || '');
    if (/failed-precondition|not-found|NOT_FOUND/i.test(msg) && /database/i.test(msg)) {
      return 'Falta crear la base de datos en Firebase (Firestore Database → Crear base de datos).';
    }
    if (/permission|insufficient/i.test(msg)) {
      return 'La base de datos no da permiso: hay que pegar las reglas de seguridad en Firestore → Reglas.';
    }
    if (/network|unavailable|offline/i.test(msg)) {
      return 'Sin conexión ahora mismo; se sincronizará al volver la cobertura.';
    }
    if (/unauthorized-domain/i.test(msg)) {
      return 'Este dominio no está autorizado en Firebase (Authentication → Configuración → Dominios autorizados).';
    }
    if (/popup-closed|cancelled-popup/i.test(msg)) {
      return 'Se cerró la ventana de Google antes de terminar. Inténtalo de nuevo.';
    }
    return msg;
  }

  /* ---------- Sesión ---------- */

  function iniciar(callback) {
    avisarUI = callback || (() => {});
    if (!disponible) { estado = 'apagado'; return; }
    firebase.initializeApp(CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();
    // Caché local de Firestore: la app funciona sin conexión y sube al volver
    try { db.enablePersistence({ synchronizeTabs: true }).catch(() => {}); } catch (e) { /* no crítico */ }

    estado = 'desconectado';
    auth.onAuthStateChanged((u) => {
      usuario = u;
      if (u) {
        empezarEscuchas();
      } else {
        pararEscuchas();
        cambiarEstado('desconectado');
      }
      avisarUI();
    });
  }

  async function entrar() {
    if (!disponible) throw new Error('No se pudo cargar Firebase (¿sin conexión?). Inténtalo con internet.');
    cambiarEstado('conectando');
    const proveedor = new firebase.auth.GoogleAuthProvider();
    try {
      await auth.signInWithPopup(proveedor);
    } catch (e) {
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) {
        await auth.signInWithRedirect(proveedor); // algunos móviles bloquean la ventana emergente
        return;
      }
      cambiarEstado('desconectado');
      throw new Error(traducirError(e));
    }
  }

  async function salir() {
    pararEscuchas();
    if (auth) await auth.signOut();
    cambiarEstado('desconectado');
  }

  /* ---------- Escuchas y reconciliación ---------- */

  function empezarEscuchas() {
    pararEscuchas();
    cambiarEstado('sincronizando');
    ['registros', 'proveedores', 'borrados'].forEach((nombre) => {
      const parar = col(nombre).onSnapshot((snap) => {
        remotos[nombre] = new Map(snap.docs.map(d => [d.id, d.data()]));
        listos[nombre] = true;
        programarReconciliacion();
      }, (err) => {
        console.error('Escucha', nombre, err);
        cambiarEstado('error', traducirError(err));
      });
      paradas.push(parar);
    });
  }

  function pararEscuchas() {
    paradas.forEach(p => { try { p(); } catch (e) { /* nada */ } });
    paradas = [];
    ['registros', 'proveedores', 'borrados'].forEach(n => { remotos[n] = new Map(); listos[n] = false; });
  }

  function programarReconciliacion() {
    if (!listos.registros || !listos.proveedores || !listos.borrados) return;
    clearTimeout(timerReconciliar);
    timerReconciliar = setTimeout(reconciliar, 400);
  }

  async function reconciliar() {
    if (!usuario) return;
    if (reconciliando) { reconciliarOtraVez = true; return; }
    reconciliando = true;
    let huboCambiosLocales = false;
    try {
      const cambioRegistros = await reconciliarColeccion(
        'registros',
        await DB.todos(),
        (obj) => DB.guardar(obj, { remoto: true }),
        (id) => DB.borrar(id, { remoto: true })
      );
      const cambioProveedores = await reconciliarColeccion(
        'proveedores',
        await DB.provTodos(),
        (obj) => DB.provGuardar(obj, { remoto: true }),
        (id) => DB.provBorrar(id, { remoto: true })
      );
      huboCambiosLocales = cambioRegistros || cambioProveedores;
      cambiarEstado('sincronizado');
    } catch (e) {
      console.error('Reconciliación:', e);
      cambiarEstado('error', traducirError(e));
    } finally {
      reconciliando = false;
      if (reconciliarOtraVez) { reconciliarOtraVez = false; programarReconciliacion(); }
      if (huboCambiosLocales) avisarUI();
    }
  }

  /* Compara lo local con lo remoto de una colección. Devuelve true si cambió algo en local. */
  async function reconciliarColeccion(nombre, locales, guardarLocal, borrarLocal) {
    const remoto = remotos[nombre];
    const lapidas = remotos.borrados;
    let cambio = false;

    const localPorSid = new Map(locales.filter(r => r.sid).map(r => [r.sid, r]));

    for (const local of locales) {
      // Sin sid no debería pasar (db.js lo pone al guardar), pero por si acaso
      if (!local.sid) continue;
      if (lapidas.has(local.sid)) {
        await borrarLocal(local.id); // borrado en otro dispositivo
        cambio = true;
        continue;
      }
      const rem = remoto.get(local.sid);
      if (!rem || (local.mod || '') > (rem.mod || '')) {
        await subir(nombre, local); // falta en la nube o lo local es más nuevo
      }
    }

    for (const [sid, data] of remoto) {
      if (lapidas.has(sid)) continue;
      const local = localPorSid.get(sid);
      if (!local) {
        await guardarLocal(desdeRemoto(data)); // nuevo desde otro dispositivo
        cambio = true;
      } else if ((data.mod || '') > (local.mod || '')) {
        await guardarLocal({ ...desdeRemoto(data), id: local.id }); // actualizado fuera
        cambio = true;
      }
    }
    return cambio;
  }

  async function subir(nombre, obj) {
    await col(nombre).doc(obj.sid).set(await aRemoto(obj));
  }

  async function borrarRemoto(nombre, sid) {
    await col(nombre).doc(sid).delete();
    await col('borrados').doc(sid).set({ de: nombre, mod: new Date().toISOString() });
  }

  /* ---------- Cambios locales → nube (avisados por db.js) ---------- */

  function alCambioLocal(evento, dato) {
    if (!usuario || !dato || !dato.sid) return;
    const tarea = (() => {
      switch (evento) {
        case 'registro': return subir('registros', dato);
        case 'borrar-registro': return borrarRemoto('registros', dato.sid);
        case 'proveedor': return subir('proveedores', dato);
        case 'borrar-proveedor': return borrarRemoto('proveedores', dato.sid);
        default: return Promise.resolve();
      }
    })();
    tarea.catch((e) => {
      console.error('Subida a la nube:', e);
      cambiarEstado('error', traducirError(e));
    });
  }

  if (typeof DB !== 'undefined' && DB.alCambio) DB.alCambio(alCambioLocal);

  /* ---------- Estado para la interfaz ---------- */

  function estadoActual() {
    return {
      disponible,
      conectado: !!usuario,
      correo: usuario ? (usuario.email || '') : '',
      estado,
      detalle
    };
  }

  return { iniciar, entrar, salir, estado: estadoActual };
})();
