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
const CHROME = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
  .find(r => r && require('fs').existsSync(r) && require('fs').statSync(r).isFile());

(async () => {
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errores = [];
  page.on('pageerror', e => errores.push(e.message));
  page.on('dialog', d => d.accept());
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

  // ── Corregir un apunte con la nube conectada: tiene que seguir siendo UNO ──
  // (antes se le daba otra identidad: la nube devolvía la versión vieja y el gasto
  //  o el ingreso se contaba dos veces)
  await page.evaluate(async () => {
    await DB.guardar({ tipo: 'factura', fecha: '2026-09-10', proveedor: 'Corregible S.L.', total: 100, creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'cierre', fecha: '2026-09-11', total: 640, proveedor: '', creado: new Date().toISOString() });
    await DB.provGuardar({ nombre: 'Corregible S.L.', nif: 'B22222222', categoria: 'Mercancía', creado: new Date().toISOString() });
  });
  await page.waitForTimeout(1400);
  const sidsAntes = await page.evaluate(async () => ({
    factura: (await DB.todos()).find(r => r.proveedor === 'Corregible S.L.').sid,
    cierre: (await DB.todos()).find(r => r.tipo === 'cierre' && r.total === 640).sid,
    prov: (await DB.provTodos()).find(x => x.nombre === 'Corregible S.L.').sid
  }));
  const abrirApunte = async (tab, busca) => {
    await page.click(`.tab[data-tab="${tab}"]`);
    await page.waitForTimeout(500);
    await page.evaluate(async (b) => {
      const r = (await DB.todos()).find(x => b === 'factura' ? x.proveedor === 'Corregible S.L.' : (x.tipo === 'cierre' && x.total === 640));
      [...document.querySelectorAll('.item[data-id], .foto[data-id]')].find(e => +e.dataset.id === r.id).click();
    }, busca);
    await page.waitForTimeout(300);
    await page.click('#detalle-editar');
    await page.waitForTimeout(400);
  };
  await abrirApunte('facturas', 'factura');
  await page.fill('#f-total', '120');
  await page.click('#factura-guardar');
  await page.waitForTimeout(1500);
  await abrirApunte('cierres', 'cierre');
  await page.fill('#c-total', '700');
  await page.click('#cierre-guardar');
  await page.waitForTimeout(1500);
  // El proveedor, por su formulario (la lista está en la pestaña de facturas)
  await page.click('.tab[data-tab="facturas"]');
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    const pr = (await DB.provTodos()).find(x => x.nombre === 'Corregible S.L.');
    [...document.querySelectorAll('.item[data-pid]')].find(e => +e.dataset.pid === pr.id).click();
  });
  await page.waitForTimeout(300);
  await page.fill('#p-nif', 'B33333333');
  await page.click('#prov-guardar');
  await page.waitForTimeout(1500);
  const trasCorregir = await page.evaluate(async () => {
    const regs = await DB.todos(), provs = await DB.provTodos();
    const nubeR = Object.values(__stub.datos('registros')), nubeP = Object.values(__stub.datos('proveedores'));
    return {
      facturas: regs.filter(r => r.proveedor === 'Corregible S.L.').map(r => [r.total, r.sid]),
      cierres: regs.filter(r => r.tipo === 'cierre' && r.fecha === '2026-09-11').map(r => [r.total, r.sid]),
      provs: provs.filter(x => x.nombre === 'Corregible S.L.').map(x => [x.nif, x.sid]),
      nubeFacturas: nubeR.filter(r => r.proveedor === 'Corregible S.L.').map(r => [r.total, r.sid]),
      nubeCierres: nubeR.filter(r => r.tipo === 'cierre' && r.fecha === '2026-09-11').map(r => [r.total, r.sid]),
      nubeProvs: nubeP.filter(x => x.nombre === 'Corregible S.L.').map(x => [x.nif, x.sid]),
      repetidos: APP.repetidos(regs).length + APP.repetidos(provs).length
    };
  });
  const unoSolo = (lista, valor, sid) => lista.length === 1 && lista[0][0] === valor && lista[0][1] === sid;
  chk('Corregir una factura con la nube conectada deja UNA sola (120 €), con la misma identidad, aquí y en la nube',
    unoSolo(trasCorregir.facturas, 120, sidsAntes.factura) && unoSolo(trasCorregir.nubeFacturas, 120, sidsAntes.factura), JSON.stringify(trasCorregir));
  chk('Corregir un cierre deja UNO solo (700 €): el ingreso no se cuenta dos veces',
    unoSolo(trasCorregir.cierres, 700, sidsAntes.cierre) && unoSolo(trasCorregir.nubeCierres, 700, sidsAntes.cierre), JSON.stringify(trasCorregir));
  chk('Corregir un proveedor no lo duplica',
    unoSolo(trasCorregir.provs, 'B33333333', sidsAntes.prov) && unoSolo(trasCorregir.nubeProvs, 'B33333333', sidsAntes.prov), JSON.stringify(trasCorregir));
  chk('Un apunte bien corregido no sale como repetido', trasCorregir.repetidos === 0, String(trasCorregir.repetidos));

  // ── Lo que ya quedó repetido de antes: se avisa y se quita en todos los dispositivos ──
  await page.evaluate(async () => {
    const f = (await DB.todos()).find(r => r.proveedor === 'Corregible S.L.');
    // la versión de antes que la nube aún guarda: otra identidad, mismo 'creado'
    __stub.inyectar('registros', 'version-vieja', {
      sid: 'version-vieja', mod: f.creado, creado: f.creado, tipo: 'factura',
      fecha: f.fecha, proveedor: f.proveedor, total: 100, imagenB64: null
    });
  });
  await page.waitForTimeout(1600);
  await page.click('.tab[data-tab="inicio"]');
  await page.waitForTimeout(700);
  const avisoRep = await page.evaluate(() => ({
    texto: (document.querySelector('#ini-alertas') || document.body).textContent,
    boton: !!document.querySelector('#ini-alertas .rep-revisar')
  }));
  chk('La versión de antes que aún guarda la nube se detecta y el Inicio avisa de que se cuenta dos veces',
    avisoRep.boton && /1 apunte repetido/.test(avisoRep.texto) && /dos veces/.test(avisoRep.texto), avisoRep.texto.slice(0, 300));
  await page.click('#ini-alertas .rep-revisar');
  await page.waitForTimeout(400);
  await page.click('#modal-body .rep-quitar');
  await page.waitForTimeout(1600);
  const trasQuitar = await page.evaluate(async () => ({
    locales: (await DB.todos()).filter(r => r.proveedor === 'Corregible S.L.').map(r => r.total),
    enNube: Object.values(__stub.datos('registros')).filter(r => r.proveedor === 'Corregible S.L.').map(r => r.total),
    lapida: !!__stub.datos('borrados')['version-vieja']
  }));
  chk('Al quitarla se queda la corregida (120 €), desaparece de la nube y deja su marca para los demás dispositivos',
    trasQuitar.locales.length === 1 && trasQuitar.locales[0] === 120 && trasQuitar.enNube.length === 1 && trasQuitar.enNube[0] === 120 && trasQuitar.lapida,
    JSON.stringify(trasQuitar));

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
