/* WanderContable — el "toque" diario.

   Lo ejecuta GitHub una vez al día (.github/workflows/avisos.yml). Manda a cada
   móvil apuntado una notificación VACÍA: no sabe nada de las cuentas ni las lee.
   Al recibirla, el propio móvil mira sus datos y escribe el aviso (sw.js).

   Cada móvil se apunta pegando su código en un secreto del repositorio
   (AVISOS_MOVIL, y AVISOS_MOVIL_2 / _3 para más móviles). El código lo da la
   app en Ajustes → Avisos en el móvil; lleva la dirección de ese móvil y sus
   claves de envío. Con él solo se puede mandar un aviso a ese móvil: no da
   acceso a ningún dato.

     node avisos/enviar.js              envía el toque
     node avisos/enviar.js --comprobar  solo comprueba los códigos, sin enviar */
'use strict';

const NOMBRES = ['AVISOS_MOVIL', 'AVISOS_MOVIL_2', 'AVISOS_MOVIL_3'];
const esTexto = (v) => typeof v === 'string' && v.length > 0;

/* Los móviles apuntados, a partir de los secretos. Devuelve { moviles, errores }. */
function leerMoviles(env) {
  const moviles = [];
  const errores = [];
  NOMBRES.forEach(nombre => {
    const texto = (env[nombre] || '').trim();
    if (!texto) return;
    let dato;
    try { dato = JSON.parse(texto); }
    catch (e) { errores.push(`${nombre}: el código no se ha pegado entero (no se puede leer).`); return; }
    (Array.isArray(dato) ? dato : [dato]).forEach(m => {
      const s = m && m.suscripcion;
      const v = m && m.vapid;
      if (!s || !esTexto(s.endpoint) || !/^https:\/\//.test(s.endpoint) || !s.keys || !esTexto(s.keys.p256dh) || !esTexto(s.keys.auth) ||
          !v || !esTexto(v.publica) || !esTexto(v.privada)) {
        errores.push(`${nombre}: al código le faltan datos. Vuelve a copiarlo desde la app.`);
        return;
      }
      moviles.push({
        nombre,
        suscripcion: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
        vapid: { subject: esTexto(m.app) && /^https:\/\//.test(m.app) ? m.app : 'https://github.com', publicKey: v.publica, privateKey: v.privada }
      });
    });
  });
  return { moviles, errores };
}

async function principal() {
  const soloComprobar = process.argv.includes('--comprobar');
  const { moviles, errores } = leerMoviles(process.env);
  errores.forEach(e => console.error('⚠️ ' + e));
  if (!moviles.length && !errores.length) {
    console.log('Todavía no hay ningún móvil apuntado. En la app: Ajustes → Avisos en el móvil → Activar, y pega el código en el secreto AVISOS_MOVIL.');
    return 0;
  }
  if (soloComprobar) {
    console.log(`${moviles.length} móvil(es) con el código correcto.`);
    return errores.length ? 1 : 0;
  }
  const webpush = require('web-push');
  let fallos = errores.length;
  for (const m of moviles) {
    try {
      // 12 horas de margen: si el móvil está apagado, el aviso le llega al encenderlo
      await webpush.sendNotification(m.suscripcion, JSON.stringify({ tipo: 'parte' }), { vapidDetails: m.vapid, TTL: 12 * 3600, urgency: 'normal' });
      console.log(`✓ ${m.nombre}: toque enviado.`);
    } catch (e) {
      fallos++;
      const codigo = e && e.statusCode;
      console.error(codigo === 404 || codigo === 410
        ? `✗ ${m.nombre}: ese móvil ya no admite avisos con este código (se desactivaron o cambió). En la app: Ajustes → Avisos en el móvil → copia el código de nuevo y actualiza el secreto.`
        : `✗ ${m.nombre}: no se pudo enviar (${codigo || (e && e.message) || 'error desconocido'}).`);
    }
  }
  return fallos ? 1 : 0;
}

module.exports = { leerMoviles, NOMBRES };

if (require.main === module) {
  principal().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(1); });
}
