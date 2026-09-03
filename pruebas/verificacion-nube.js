/* Verificación de la sincronización en la nube.
   Usa un Firebase simulado (stub-firebase.js) para no tocar la nube real:
   comprueba la subida inicial, la llegada de cambios de otro dispositivo,
   los borrados, los conflictos y que desconectar no borre nada. */
const { chromium } = require('playwright-core');

const R = { ok: 0, fallos: [] };
const chk = (n, c, d = '') => {
  if (c) { R.ok++; console.log('  ✓ ' + n); }
  else { R.fallos.push(n); console.log('  ✗ ' + n + (d ? ' → ' + d : '')); }
};

const URL = process.env.URL_PRUEBAS_NUBE || 'http://localhost:8903/index.html';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errores = [];
  page.on('pageerror', e => errores.push(e.message));
  await page.goto(URL);
  await page.waitForTimeout(900);

  console.log('\n═══ SINCRONIZACIÓN EN LA NUBE ═══');

  // Datos ya guardados en el móvil ANTES de conectar la nube
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 500; canvas.height = 700;
    const x = canvas.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 500, 700);
    x.fillStyle = '#000'; x.font = '20px sans-serif'; x.fillText('FACTURA', 30, 40);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    await DB.guardar({ tipo: 'factura', fecha: '2026-09-01', proveedor: 'Local S.L.', total: 121, baseImponible: 100, ivaCuota: 21, imagen: blob, creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'cierre', fecha: '2026-09-02', total: 800, proveedor: '', creado: new Date().toISOString() });
    await DB.provGuardar({ nombre: 'Local S.L.', nif: 'B11111111', categoria: 'Mercancía', creado: new Date().toISOString() });
    await DB.perGuardar({ nombre: 'Empleado', sueldoMensual: 900, diasMes: 26, horasJornada: 7.5, tramos: [{ objetivo: 13500, porcentaje: 1 }], dias: ['2026-09-01'], tardes: [{ fecha: '2026-09-02', horas: 2 }], faltas: [], notasDias: [], creado: new Date().toISOString() });
    const e = (await DB.perTodos())[0];
    await DB.pagoGuardar({ trabajadorSid: e.sid, fecha: '2026-09-03', importe: 200, notas: 'adelanto', creado: new Date().toISOString() });
  });

  await page.evaluate(() => NUBE.entrar());
  await page.waitForTimeout(2200);
  const nube = await page.evaluate(() => ({
    registros: Object.values(__stub.datos('registros')),
    proveedores: Object.values(__stub.datos('proveedores')),
    personal: Object.values(__stub.datos('personal')),
    pagos: Object.values(__stub.datos('pagos'))
  }));
  chk('Al conectar sube las facturas y cierres que ya tenías', nube.registros.length === 2, 'subidos ' + nube.registros.length);
  chk('Sube los proveedores', nube.proveedores.length === 1);
  chk('Sube el personal con sus días y retrasos',
    nube.personal.length === 1 && nube.personal[0].dias.length === 1 && nube.personal[0].tardes.length === 1);
  chk('Sube los adelantos', nube.pagos.length === 1);
  const conFoto = nube.registros.find(r => r.imagenB64);
  chk('La foto de la factura se sube comprimida', !!conFoto && conFoto.imagenB64.startsWith('data:image/jpeg'));
  chk('La foto cabe en el límite de la nube (<1 MB)', !!conFoto && conFoto.imagenB64.length < 1000000,
    conFoto ? Math.round(conFoto.imagenB64.length / 1024) + ' KB' : '');
  chk('Los importes suben intactos', nube.registros.some(r => r.total === 121 && r.ivaCuota === 21));
  chk('Estado "Sincronizada"', await page.evaluate(() => NUBE.estado().estado === 'sincronizado'));

  await page.evaluate(async () => {
    await DB.guardar({ tipo: 'factura', fecha: '2026-09-04', proveedor: 'Nueva S.L.', total: 50, creado: new Date().toISOString() });
  });
  await page.waitForTimeout(1400);
  chk('Una factura nueva se sube al momento',
    await page.evaluate(() => Object.values(__stub.datos('registros')).length === 3));

  await page.evaluate(() => {
    __stub.inyectar('registros', 'remoto-1', {
      sid: 'remoto-1', mod: new Date().toISOString(), tipo: 'factura',
      fecha: '2026-09-05', proveedor: 'Desde el ordenador', total: 75, imagenB64: null, creado: new Date().toISOString()
    });
  });
  await page.waitForTimeout(1600);
  chk('Lo anotado en otro dispositivo aparece aquí',
    await page.evaluate(async () => (await DB.todos()).some(r => r.proveedor === 'Desde el ordenador')));

  await page.evaluate(() => {
    __stub.quitar('registros', 'remoto-1');
    __stub.inyectar('borrados', 'remoto-1', { de: 'registros', mod: new Date().toISOString() });
  });
  await page.waitForTimeout(1600);
  chk('Lo borrado en otro dispositivo se borra aquí',
    await page.evaluate(async () => !(await DB.todos()).some(r => r.sid === 'remoto-1')));

  await page.evaluate(async () => {
    const r = (await DB.todos()).find(x => x.proveedor === 'Nueva S.L.');
    const copia = { ...r }; delete copia.imagen; delete copia.id;
    __stub.inyectar('registros', r.sid, { ...copia, total: 999, mod: new Date(Date.now() + 60000).toISOString() });
  });
  await page.waitForTimeout(1600);
  chk('Si se edita en dos sitios, gana la versión más nueva',
    await page.evaluate(async () => (await DB.todos()).some(r => r.total === 999)));

  const antes = await page.evaluate(async () => (await DB.todos()).length);
  await page.evaluate(() => NUBE.salir());
  await page.waitForTimeout(900);
  const despues = await page.evaluate(async () => (await DB.todos()).length);
  chk('Desconectar la nube NO borra tus datos del móvil', antes === despues, `${antes} → ${despues}`);
  chk('La app sigue guardando sin nube', await page.evaluate(async () => {
    await DB.guardar({ tipo: 'cierre', fecha: '2026-09-06', total: 111, proveedor: '', creado: new Date().toISOString() });
    return (await DB.todos()).some(r => r.total === 111);
  }));
  chk('Sin errores de JavaScript', errores.length === 0, errores.join(' | '));

  await browser.close();
  console.log(`\nNUBE: ${R.ok} correctas, ${R.fallos.length} fallos`);
  process.exit(R.fallos.length ? 1 : 0);
})();
