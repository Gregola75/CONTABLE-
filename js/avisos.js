/* WanderContable — avisos en el móvil (notificaciones con la app cerrada).

   Cómo funciona, sin servidor propio y sin que las cuentas salgan del móvil:
   - Aquí se activa el permiso de notificaciones y este móvil obtiene una
     "dirección" a la que se le puede mandar un aviso, con un par de claves
     que se crean en el propio móvil.
   - El dueño copia el código (dirección + claves) y lo pega una vez en un
     secreto de su repositorio de GitHub (AVISOS_MOVIL).
   - GitHub manda cada día un "toque" vacío a esa dirección (avisos/enviar.js).
   - Al llegar, el service worker mira los datos guardados en el móvil y
     escribe la notificación (sw.js + js/avisos-parte.js).

   El código solo sirve para mandar un aviso a este móvil: no da acceso a
   ningún dato. Por defecto la notificación no enseña importes ni nombres,
   porque se lee con el móvil bloqueado. */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const CLAVE_CLAVES = 'contable-avisos-claves';      // el par de claves de este móvil
  const CLAVE_DIRECCION = 'contable-avisos-direccion'; // la dirección con la que se copió el código
  const CLAVE_DETALLE = 'contable-avisos-detalle';
  const CACHE_AVISOS = 'contable-avisos-v1';           // lo que lee sw.js

  const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const deB64url = (txt) => {
    const b = atob(txt.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((txt.length + 3) % 4));
    return Uint8Array.from(b, c => c.charCodeAt(0));
  };

  const soportado = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && location.protocol === 'https:';

  function toast(texto) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = texto;
    t.classList.remove('hidden');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), 4000);
  }

  /* El par de claves con el que se firman los avisos para este móvil. Se crea
     aquí, en el dispositivo, y no pasa por ningún otro sitio que el código que
     el dueño copia a su repositorio. */
  async function generarClaves() {
    const par = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const publica = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey)));
    const privada = (await crypto.subtle.exportKey('jwk', par.privateKey)).d;
    return { publica, privada };
  }

  function leerClaves() {
    try { const c = JSON.parse(localStorage.getItem(CLAVE_CLAVES) || 'null'); return c && c.publica && c.privada ? c : null; }
    catch (e) { return null; }
  }

  /* El texto que se pega en GitHub: la dirección de este móvil y sus claves */
  function codigoDe(suscripcion, claves) {
    const s = suscripcion.toJSON ? suscripcion.toJSON() : suscripcion;
    return JSON.stringify({
      v: 1,
      app: location.origin + location.pathname.replace(/[^/]*$/, ''),
      suscripcion: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
      vapid: { publica: claves.publica, privada: claves.privada }
    });
  }

  /* Dónde se pega el código: los secretos del repositorio que publica la app */
  function enlaceSecretos() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/);
    const repo = location.pathname.split('/').filter(Boolean)[0];
    return m && repo ? `https://github.com/${m[1]}/${repo}/settings/secrets/actions/new` : '';
  }

  const suscripcionActual = async () => (await navigator.serviceWorker.ready).pushManager.getSubscription();

  async function guardarDetalle(detalle) {
    try { localStorage.setItem(CLAVE_DETALLE, detalle ? '1' : ''); } catch (e) { /* se queda sin detalle */ }
    try {
      const cache = await caches.open(CACHE_AVISOS);
      await cache.put('./__avisos-ajustes', new Response(JSON.stringify({ detalle: !!detalle }), { headers: { 'Content-Type': 'application/json' } }));
    } catch (e) { toast('⚠️ No se pudo guardar ese ajuste en este dispositivo.'); }
  }

  async function pintar() {
    const estado = $('#avi-estado');
    if (!estado) return;
    const mostrar = (id, si) => $(id).classList.toggle('hidden', !si);
    $('#avi-detalle').checked = localStorage.getItem(CLAVE_DETALLE) === '1';
    if (!soportado()) {
      estado.innerHTML = '<span>Estado</span><strong class="txt-sec">No disponible aquí</strong>';
      $('#avi-msg').textContent = location.protocol === 'https:'
        ? 'Este navegador no admite notificaciones de este tipo. En Android, usa Chrome y la app instalada en la pantalla de inicio.'
        : 'Los avisos solo funcionan en la app publicada (la que abres desde tu móvil), no en esta copia.';
      ['#avi-activar', '#avi-codigo-wrap', '#avi-probar', '#avi-desactivar'].forEach(id => mostrar(id, false));
      return;
    }
    let sub = null;
    try { sub = await suscripcionActual(); } catch (e) { /* sin servicio en segundo plano todavía */ }
    const claves = leerClaves();
    const activo = !!sub && !!claves && Notification.permission === 'granted';
    const copiada = localStorage.getItem(CLAVE_DIRECCION) || '';
    estado.innerHTML = `<span>Estado</span><strong class="${activo ? 'txt-ok' : 'txt-sec'}">${activo ? '✓ Activados en este móvil' : 'Sin activar'}</strong>`;
    let msg = '';
    if (Notification.permission === 'denied') msg = '⚠️ Las notificaciones de esta app están bloqueadas en el móvil. Actívalas en los ajustes del navegador (Chrome → Ajustes → Notificaciones) y vuelve aquí.';
    else if (activo && copiada && copiada !== sub.endpoint) msg = '⚠️ El código de este móvil ha cambiado desde que lo copiaste: cópialo otra vez y actualiza el secreto en GitHub, o dejarán de llegarte los avisos.';
    $('#avi-msg').textContent = msg;
    mostrar('#avi-activar', !activo && Notification.permission !== 'denied');
    mostrar('#avi-codigo-wrap', activo);
    mostrar('#avi-probar', activo);
    mostrar('#avi-desactivar', activo);
    if (activo) {
      $('#avi-codigo').value = codigoDe(sub, claves);
      const enlace = enlaceSecretos();
      $('#avi-enlace').href = enlace || 'https://github.com';
      $('#avi-enlace').textContent = enlace ? 'Abrir los secretos de tu repositorio en GitHub' : 'Abrir GitHub (tu repositorio → Settings → Secrets and variables → Actions)';
    }
  }

  async function activar() {
    const msg = $('#avi-msg');
    try {
      const permiso = await Notification.requestPermission();
      if (permiso !== 'granted') { msg.textContent = '⚠️ Sin el permiso de notificaciones no se pueden activar los avisos.'; return; }
      const reg = await navigator.serviceWorker.ready;
      let claves = leerClaves();
      if (!claves) {
        claves = await generarClaves();
        localStorage.setItem(CLAVE_CLAVES, JSON.stringify(claves));
      }
      // Si había una dirección hecha con otras claves, no sirve: se rehace
      const vieja = await reg.pushManager.getSubscription();
      if (vieja) await vieja.unsubscribe();
      await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: deB64url(claves.publica) });
      await guardarDetalle($('#avi-detalle').checked);
      toast('🔔 Avisos activados. Ahora copia el código y pégalo en GitHub.');
    } catch (e) {
      msg.textContent = '⚠️ No se han podido activar los avisos: ' + ((e && e.message) || 'error desconocido') + '. Comprueba que hay conexión.';
      return;
    }
    pintar();
  }

  async function copiarCodigo() {
    const texto = $('#avi-codigo').value;
    try {
      await navigator.clipboard.writeText(texto);
    } catch (e) {
      $('#avi-codigo').select();
      if (!document.execCommand('copy')) { toast('⚠️ No se pudo copiar solo: mantén pulsado el cuadro y elige Copiar.'); return; }
    }
    try {
      const sub = await suscripcionActual();
      if (sub) localStorage.setItem(CLAVE_DIRECCION, sub.endpoint);
    } catch (e) { /* solo sirve para avisar si cambia */ }
    toast('📋 Código copiado. Pégalo en GitHub, en el secreto AVISOS_MOVIL.');
    pintar();
  }

  async function probar() {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (!reg.active) throw new Error('la app aún se está instalando; ciérrala y ábrela');
      reg.active.postMessage({ tipo: 'probar-aviso' });
      toast('🔔 Mira la barra de notificaciones del móvil: así llegará el aviso.');
    } catch (e) {
      toast('⚠️ No se pudo enseñar el aviso de prueba: ' + ((e && e.message) || 'error desconocido'));
    }
  }

  async function desactivar() {
    if (!confirm('¿Desactivar los avisos en este móvil? Dejarán de llegarte. (El secreto de GitHub puedes dejarlo: sin esto no hace nada.)')) return;
    try {
      const sub = await suscripcionActual();
      if (sub) await sub.unsubscribe();
      localStorage.removeItem(CLAVE_DIRECCION);
      toast('🔕 Avisos desactivados en este móvil.');
    } catch (e) {
      toast('⚠️ No se pudieron desactivar: ' + ((e && e.message) || 'error desconocido'));
    }
    pintar();
  }

  function conectar() {
    if (!$('#avi-estado')) return;
    $('#avi-activar').addEventListener('click', activar);
    $('#avi-copiar').addEventListener('click', copiarCodigo);
    $('#avi-probar').addEventListener('click', probar);
    $('#avi-desactivar').addEventListener('click', desactivar);
    $('#avi-detalle').addEventListener('change', (e) => guardarDetalle(e.target.checked));
    // Se repinta al entrar en Ajustes (el estado puede haber cambiado fuera)
    const pestana = document.querySelector('.tab[data-tab="ajustes"]');
    if (pestana) pestana.addEventListener('click', pintar);
    pintar();
  }

  conectar();

  window.AVISOS = { generarClaves, codigoDe, pintar, soportado };
})();
