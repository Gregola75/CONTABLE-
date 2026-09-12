/* VERIFICACIÓN COMPLETA DE WANDERCONTABLE
   Comprueba los cálculos de dinero, la integridad de los datos y los
   flujos críticos en un navegador real, con casos de contabilidad reales. */
const { chromium } = require('playwright-core');

const R = { ok: 0, fallos: [] };
function chk(area, nombre, condicion, detalle = '') {
  if (condicion) { R.ok++; console.log(`  ✓ ${nombre}`); }
  else { R.fallos.push({ area, nombre, detalle }); console.log(`  ✗ ${nombre}${detalle ? ' → ' + detalle : ''}`); }
}
const cerca = (a, b, tol = 0.011) => typeof a === 'number' && Math.abs(a - b) < tol;

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const erroresJS = [];
  page.on('pageerror', e => erroresJS.push(e.message));
  let ultimoDialogo = '';
  let aceptarDialogos = true;
  page.on('dialog', d => { ultimoDialogo = d.message(); aceptarDialogos ? d.accept() : d.dismiss(); });
  await page.goto('http://localhost:8904/index.html');
  await page.waitForTimeout(800);

  const limpiar = () => page.evaluate(async () => {
    for (const r of await DB.todos()) await DB.borrar(r.id);
    for (const p of await DB.provTodos()) await DB.provBorrar(p.id);
    for (const t of await DB.perTodos()) await DB.perBorrar(t.id);
    for (const g of await DB.pagoTodos()) await DB.pagoBorrar(g.id);
  });

  // ══════════════ 1. INFORME TRIMESTRAL ══════════════
  console.log('\n═══ 1. INFORME TRIMESTRAL (lo que va a la gestoría) ═══');
  await limpiar();
  const inf = await page.evaluate(async () => {
    // Trimestre 3 de 2026 (jul-sep): ingresos y gastos repartidos
    await DB.guardar({ tipo: 'cierre', fecha: '2026-07-05', total: 1000, proveedor: '', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'cierre', fecha: '2026-07-06', total: 500.55, proveedor: '', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'cierre', fecha: '2026-08-01', total: 2000, mensual: true, proveedor: '', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'cierre', fecha: '2026-09-30', total: 300, proveedor: '', creado: new Date().toISOString() });
    // Fuera del trimestre: no deben contar
    await DB.guardar({ tipo: 'cierre', fecha: '2026-06-30', total: 9999, proveedor: '', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'cierre', fecha: '2026-10-01', total: 8888, proveedor: '', creado: new Date().toISOString() });
    // Facturas del trimestre
    await DB.guardar({ tipo: 'factura', fecha: '2026-07-10', proveedor: 'Distribuciones García S.L.', nif: 'B41234567', total: 121, baseImponible: 100, ivaTipo: 21, ivaCuota: 21, categoria: 'Mercancía', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'factura', fecha: '2026-08-10', proveedor: 'Distribuciones García S.L.', nif: 'B41234567', total: 242, baseImponible: 200, ivaTipo: 21, ivaCuota: 42, categoria: 'Mercancía', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'factura', fecha: '2026-09-01', proveedor: 'Inmobiliaria Sur S.A.', nif: 'A41999888', total: 816, baseImponible: 800, ivaTipo: 21, ivaCuota: 168, retTipo: 19, retCuota: 152, categoria: 'Alquiler', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'factura', fecha: '2026-06-15', proveedor: 'Fuera', total: 500, creado: new Date().toISOString() });
    const i = await INFORME.generar(2026, 3);
    return { i, csv: INFORME.generarCSV(i) };
  });
  chk('informe', 'Ingresos del trimestre = 3.800,55 (no cuenta jun ni oct)', cerca(inf.i.totalIngresos, 3800.55), 'obtenido ' + inf.i.totalIngresos);
  chk('informe', 'Gastos del trimestre = 1.179,00 (no cuenta junio)', cerca(inf.i.totalGastos, 1179), 'obtenido ' + inf.i.totalGastos);
  chk('informe', 'Julio agrupa sus 2 cierres (1.500,55)', cerca(inf.i.ingresosPorMes[6].total, 1500.55));
  chk('informe', 'Julio cuenta 2 días con cierre', inf.i.ingresosPorMes[6].dias === 2);
  chk('informe', 'Agosto marcado como mes completo', inf.i.ingresosPorMes[7].mensual === true);
  chk('informe', 'Agrupa las 2 facturas del mismo proveedor (363,00)', cerca(inf.i.gastosPorProveedor['Distribuciones García S.L.'].total, 363));
  chk('informe', 'Conserva el NIF del proveedor', inf.i.gastosPorProveedor['Distribuciones García S.L.'].nif === 'B41234567');
  chk('informe', 'El proveedor de fuera del trimestre no aparece', !inf.i.gastosPorProveedor['Fuera']);
  chk('informe', 'CSV con formato español (coma decimal)', inf.csv.includes('3800,55') && inf.csv.includes(';'));
  chk('informe', 'CSV con BOM para que Excel lea las tildes', inf.csv.charCodeAt(0) === 0xFEFF);
  chk('informe', 'CSV incluye el resultado del trimestre', inf.csv.includes('RESULTADO DEL TRIMESTRE'));
  chk('informe', 'El CSV NO incluye datos de personal ni previsión', !/PREVISI|SUELDO|EMPLEAD|N[ÓO]MINA/i.test(inf.csv));

  // Seguridad del CSV: un nombre malicioso no debe ejecutarse en Excel
  const csvMalo = await page.evaluate(async () => {
    await DB.guardar({ tipo: 'factura', fecha: '2026-07-20', proveedor: '=HYPERLINK("http://malo")', total: 10, creado: new Date().toISOString() });
    const i = await INFORME.generar(2026, 3);
    const csv = INFORME.generarCSV(i);
    const linea = csv.split('\r\n').find(l => l.includes('HYPERLINK')) || '';
    const r = (await DB.todos()).find(x => (x.proveedor || '').includes('HYPERLINK'));
    if (r) await DB.borrar(r.id);
    return linea;
  });
  chk('informe', 'CSV blindado contra fórmulas de Excel (inyección)',
    csvMalo.includes("'=HYPERLINK") && !csvMalo.startsWith('='), csvMalo.slice(0, 40));

  // Un nombre con HTML no debe ejecutarse en la lista de facturas
  const xss = await page.evaluate(async () => {
    await DB.guardar({ tipo: 'factura', fecha: '2026-07-21', proveedor: '<img src=x onerror=window.__xss=1>', categoria: '<b>cat</b>', total: 5, creado: new Date().toISOString() });
    document.querySelector('.tab[data-tab="facturas"]').click();
    await new Promise(r => setTimeout(r, 700));
    const inyectado = window.__xss === 1 || !!document.querySelector('#facturas-recientes b');
    const r = (await DB.todos()).find(x => (x.proveedor || '').includes('onerror'));
    if (r) await DB.borrar(r.id);
    return inyectado;
  });
  chk('informe', 'Un nombre con código HTML no se ejecuta en pantalla (XSS)', !xss);

  // Un registro sin fecha (copia manipulada) no rompe el buscador ni el informe
  const sinFecha = await page.evaluate(async () => {
    await DB.guardar({ tipo: 'factura', proveedor: 'Sin Fecha', total: 5, creado: new Date().toISOString() });
    try {
      const b = await DB.buscar({});
      await INFORME.generar(2026, 3);
      await INFORME.estadisticas(null, null);
      const r = (await DB.todos()).find(x => x.proveedor === 'Sin Fecha');
      if (r) await DB.borrar(r.id);
      return b.length > 0;
    } catch (e) { return false; }
  });
  chk('informe', 'Un registro sin fecha no rompe búsquedas ni informes', sinFecha);

  // Trimestres: rangos correctos
  const rangos = await page.evaluate(async () => {
    const out = {};
    for (const t of [1, 2, 3, 4]) { const i = await INFORME.generar(2026, t); out[t] = [i.desde, i.hasta]; }
    const bis = await INFORME.generar(2024, 1); // año bisiesto
    out.bisiesto = [bis.desde, bis.hasta];
    return out;
  });
  chk('informe', 'T1 = 01/01 a 31/03', rangos[1][0] === '2026-01-01' && rangos[1][1] === '2026-03-31');
  chk('informe', 'T2 = 01/04 a 30/06', rangos[2][0] === '2026-04-01' && rangos[2][1] === '2026-06-30');
  chk('informe', 'T3 = 01/07 a 30/09', rangos[3][0] === '2026-07-01' && rangos[3][1] === '2026-09-30');
  chk('informe', 'T4 = 01/10 a 31/12', rangos[4][0] === '2026-10-01' && rangos[4][1] === '2026-12-31');
  chk('informe', 'Año bisiesto: T1 acaba el 31/03', rangos.bisiesto[1] === '2024-03-31');

  // ══════════════ 2. PREVISIÓN DE IMPUESTOS ══════════════
  console.log('\n═══ 2. PREVISIÓN DE IMPUESTOS (IVA, retenciones, IRPF) ═══');
  const prev = await page.evaluate(async () => {
    const i = await INFORME.generar(2026, 3);
    return INFORME.prevision(i, { ivaVentas: 10, ivaGastos: 21, irpfActivo: true, irpf: 20 });
  });
  // Ingresos 3800,55 con IVA 10% → base 3455,05 ; IVA repercutido 345,50
  chk('impuestos', 'Base de ingresos = ventas / 1,10', cerca(prev.baseIngresos, 3455.05, 0.02), 'obtenido ' + prev.baseIngresos);
  chk('impuestos', 'IVA repercutido = ventas − base', cerca(prev.ivaRepercutido, 345.50, 0.02), 'obtenido ' + prev.ivaRepercutido);
  // IVA soportado: 21 + 42 + 168 = 231
  chk('impuestos', 'IVA soportado suma las cuotas reales (231,00)', cerca(prev.ivaSoportado, 231), 'obtenido ' + prev.ivaSoportado);
  chk('impuestos', 'IVA del trimestre = repercutido − soportado', cerca(prev.ivaResultado, 345.50 - 231, 0.02), 'obtenido ' + prev.ivaResultado);
  // Base de gastos: 100 + 200 + 800 = 1100 (el alquiler con retención cuenta su base real)
  chk('impuestos', 'Base de gastos correcta con retención (1.100,00)', cerca(prev.baseGastos, 1100), 'obtenido ' + prev.baseGastos);
  chk('impuestos', 'Retenciones a ingresar (152,00 del alquiler)', cerca(prev.retenciones, 152), 'obtenido ' + prev.retenciones);
  chk('impuestos', 'Beneficio = base ingresos − base gastos', cerca(prev.beneficio, 3455.05 - 1100, 0.02), 'obtenido ' + prev.beneficio);
  chk('impuestos', 'IRPF 20% del beneficio', cerca(prev.irpfEstimado, (3455.05 - 1100) * 0.2, 0.05), 'obtenido ' + prev.irpfEstimado);
  chk('impuestos', 'Ninguna factura estimada (todas con IVA detectado)', prev.facturasEstimadas === 0);
  chk('impuestos', 'Total a reservar = IVA + retenciones + IRPF',
    cerca(prev.totalPrevisto, Math.max(0, prev.ivaResultado) + prev.retenciones + prev.irpfEstimado, 0.02));

  // IVA a compensar (más gastos que ingresos) no debe sumar al total a reservar
  const prevNeg = await page.evaluate(async () => {
    for (const r of await DB.todos()) await DB.borrar(r.id);
    await DB.guardar({ tipo: 'cierre', fecha: '2026-07-05', total: 110, proveedor: '', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'factura', fecha: '2026-07-10', proveedor: 'X', total: 1210, baseImponible: 1000, ivaCuota: 210, creado: new Date().toISOString() });
    const i = await INFORME.generar(2026, 3);
    return INFORME.prevision(i, { ivaVentas: 10, ivaGastos: 21, irpfActivo: true, irpf: 20 });
  });
  chk('impuestos', 'IVA negativo se marca a compensar', prevNeg.ivaResultado < 0);
  chk('impuestos', 'Un IVA a compensar no se suma como "a pagar"', cerca(prevNeg.totalPrevisto, 0), 'obtenido ' + prevNeg.totalPrevisto);
  chk('impuestos', 'Sin beneficio no hay IRPF que pagar', cerca(prevNeg.irpfEstimado, 0));

  // ══════════════ 3. CÁLCULOS DE FACTURA (IVA/base/retención) ══════════════
  console.log('\n═══ 3. FORMULARIO DE FACTURA (autocálculos) ═══');
  await limpiar();
  await page.click('.tab[data-tab="facturas"]');
  await page.click('#factura-manual');
  await page.waitForTimeout(300);
  await page.fill('#f-proveedor', 'Prueba S.L.');
  await page.fill('#f-total', '121');
  await page.selectOption('#f-ivatipo', '21');
  await page.waitForTimeout(200);
  const iva21 = await page.evaluate(() => ({ base: document.querySelector('#f-base').value, cuota: document.querySelector('#f-ivacuota').value }));
  chk('factura', 'Total 121 con IVA 21% → base 100,00', cerca(parseFloat(iva21.base), 100), 'base=' + iva21.base);
  chk('factura', 'Total 121 con IVA 21% → cuota 21,00', cerca(parseFloat(iva21.cuota), 21), 'cuota=' + iva21.cuota);

  await page.selectOption('#f-ivatipo', '10');
  await page.waitForTimeout(200);
  const iva10 = await page.evaluate(() => ({ base: document.querySelector('#f-base').value, cuota: document.querySelector('#f-ivacuota').value }));
  chk('factura', 'Cambiar a IVA 10% recalcula (base 110,00 / cuota 11,00)',
    cerca(parseFloat(iva10.base), 110) && cerca(parseFloat(iva10.cuota), 11), `base=${iva10.base} cuota=${iva10.cuota}`);

  // Varios tipos de IVA
  await page.selectOption('#f-ivatipo', 'varios');
  await page.waitForTimeout(200);
  await page.fill('#f-iva21', '21');
  await page.dispatchEvent('#f-iva21', 'input');
  await page.fill('#f-iva10', '5');
  await page.dispatchEvent('#f-iva10', 'input');
  await page.waitForTimeout(200);
  const varios = await page.evaluate(() => ({ cuota: document.querySelector('#f-ivacuota').value, base: document.querySelector('#f-base').value }));
  chk('factura', 'Varios IVA: suma las cuotas (26,00)', cerca(parseFloat(varios.cuota), 26), 'cuota=' + varios.cuota);
  chk('factura', 'Varios IVA: base = total − cuotas (95,00)', cerca(parseFloat(varios.base), 95), 'base=' + varios.base);

  // Retención sobre la base
  await page.selectOption('#f-ivatipo', '21');
  await page.waitForTimeout(200);
  await page.fill('#f-total', '816');
  await page.dispatchEvent('#f-total', 'change');
  await page.fill('#f-base', '800');
  await page.selectOption('#f-rettipo', '19');
  await page.waitForTimeout(200);
  const ret = await page.inputValue('#f-retcuota');
  chk('factura', 'Retención 19% sobre base 800 = 152,00', cerca(parseFloat(ret), 152), 'obtenido ' + ret);

  // Guardar y comprobar que se persiste con todos los campos
  await page.fill('#f-fecha', '2026-09-01');
  await page.click('#factura-guardar');
  await page.waitForTimeout(800);
  const guardada = await page.evaluate(async () => (await DB.todos())[0]);
  chk('factura', 'La factura se guarda con todos los datos',
    guardada && guardada.proveedor === 'Prueba S.L.' && cerca(guardada.total, 816) && cerca(guardada.retCuota, 152) && guardada.retTipo === 19,
    JSON.stringify(guardada && { p: guardada.proveedor, t: guardada.total, r: guardada.retCuota }));
  chk('factura', 'Al guardar se le asigna identificador de sincronización', !!(guardada && guardada.sid && guardada.mod));
  chk('factura', 'El proveedor nuevo se da de alta solo', await page.evaluate(async () => (await DB.provTodos()).some(p => p.nombre === 'Prueba S.L.')));
  chk('factura', 'No se guarda un total vacío o negativo', await page.evaluate(async () => {
    const antes = (await DB.todos()).length;
    document.querySelector('#factura-manual').click();
    await new Promise(r => setTimeout(r, 200));
    document.querySelector('#f-total').value = '-5';
    document.querySelector('#factura-guardar').click();
    await new Promise(r => setTimeout(r, 400));
    return (await DB.todos()).length === antes;
  }));

  // ══════════════ 4. COPIA DE SEGURIDAD ══════════════
  console.log('\n═══ 4. COPIA DE SEGURIDAD (tu red de seguridad) ═══');
  const backup = await page.evaluate(async () => {
    // Un dato de cada tipo, con foto
    const canvas = document.createElement('canvas');
    canvas.width = 60; canvas.height = 60;
    canvas.getContext('2d').fillRect(0, 0, 60, 60);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    await DB.guardar({ tipo: 'factura', fecha: '2026-09-02', proveedor: 'Con Foto S.L.', total: 50, imagen: blob, ocrTexto: 'texto ocr', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'cierre', fecha: '2026-09-03', total: 700, efectivo: 400, tarjeta: 300, proveedor: '', creado: new Date().toISOString() });
    await DB.perGuardar({ nombre: 'Empleado Prueba', sueldoMensual: 900, diasMes: 26, horasJornada: 7.5, tramos: [{ objetivo: 13500, porcentaje: 1 }], dias: ['2026-09-01'], tardes: [{ fecha: '2026-09-02', horas: 2 }], faltas: ['2026-09-05'], notasDias: [{ fecha: '2026-09-02', texto: 'llegó tarde' }], creado: new Date().toISOString() });
    const emp = (await DB.perTodos())[0];
    await DB.pagoGuardar({ trabajadorSid: emp.sid, fecha: '2026-09-04', importe: 250, notas: 'adelanto', creado: new Date().toISOString() });

    const datos = await DB.exportarTodo();
    const antes = {
      registros: (await DB.todos()).length,
      proveedores: (await DB.provTodos()).length,
      personal: (await DB.perTodos()).length,
      pagos: (await DB.pagoTodos()).length
    };
    return { datos: JSON.parse(JSON.stringify(datos)), antes };
  });
  chk('copia', 'La copia incluye registros', backup.datos.registros.length === backup.antes.registros);
  chk('copia', 'La copia incluye proveedores', Array.isArray(backup.datos.proveedores) && backup.datos.proveedores.length > 0);
  chk('copia', 'La copia incluye el personal', Array.isArray(backup.datos.personal) && backup.datos.personal.length === 1);
  chk('copia', 'La copia incluye los adelantos/pagos', Array.isArray(backup.datos.pagos) && backup.datos.pagos.length === 1);
  chk('copia', 'Las fotos van dentro de la copia', backup.datos.registros.some(r => typeof r.imagen === 'string' && r.imagen.startsWith('data:')));
  chk('copia', 'Los días, retrasos y notas del empleado se copian',
    backup.datos.personal[0].dias.length === 1 && backup.datos.personal[0].tardes.length === 1 && backup.datos.personal[0].notasDias.length === 1);

  // Restaurar sobre datos existentes NO debe duplicar
  const restaurar = await page.evaluate(async (datos) => {
    const antes = { r: (await DB.todos()).length, p: (await DB.perTodos()).length, g: (await DB.pagoTodos()).length };
    await DB.importarTodo(datos);
    const despues = { r: (await DB.todos()).length, p: (await DB.perTodos()).length, g: (await DB.pagoTodos()).length };
    return { antes, despues };
  }, backup.datos);
  chk('copia', 'Restaurar la misma copia NO duplica registros', restaurar.antes.r === restaurar.despues.r,
    `antes ${restaurar.antes.r} → después ${restaurar.despues.r}`);
  chk('copia', 'Restaurar la misma copia NO duplica personal', restaurar.antes.p === restaurar.despues.p,
    `antes ${restaurar.antes.p} → después ${restaurar.despues.p}`);
  chk('copia', 'Restaurar la misma copia NO duplica adelantos', restaurar.antes.g === restaurar.despues.g,
    `antes ${restaurar.antes.g} → después ${restaurar.despues.g}`);

  // Restaurar en un dispositivo vacío recupera TODO, con las fotos
  const restauraLimpio = await page.evaluate(async (datos) => {
    for (const r of await DB.todos()) await DB.borrar(r.id);
    for (const p of await DB.provTodos()) await DB.provBorrar(p.id);
    for (const t of await DB.perTodos()) await DB.perBorrar(t.id);
    for (const g of await DB.pagoTodos()) await DB.pagoBorrar(g.id);
    await DB.importarTodo(datos);
    const regs = await DB.todos();
    const emp = (await DB.perTodos())[0];
    return {
      registros: regs.length,
      conFoto: regs.filter(r => r.imagen instanceof Blob).length,
      personal: (await DB.perTodos()).length,
      pagos: (await DB.pagoTodos()).length,
      empDias: emp ? emp.dias.length : 0,
      cierreEfectivo: (regs.find(r => r.tipo === 'cierre') || {}).efectivo
    };
  }, backup.datos);
  chk('copia', 'En un móvil nuevo se recuperan todos los registros', restauraLimpio.registros === backup.antes.registros,
    `${restauraLimpio.registros} de ${backup.antes.registros}`);
  chk('copia', 'Las fotos se recuperan como imágenes', restauraLimpio.conFoto >= 1);
  chk('copia', 'Se recupera el personal con sus días', restauraLimpio.personal === 1 && restauraLimpio.empDias === 1);
  chk('copia', 'Se recuperan los adelantos', restauraLimpio.pagos === 1);
  chk('copia', 'Se recuperan los detalles del cierre (efectivo/tarjeta)', cerca(restauraLimpio.cierreEfectivo, 400));
  chk('copia', 'Un archivo que no es copia da error claro', await page.evaluate(async () => {
    try { await DB.importarTodo({ hola: 'mundo' }); return false; } catch (e) { return /copia de seguridad/i.test(e.message); }
  }));

  // ══════════════ 5. PERSONAL: SUELDOS Y COMISIONES ══════════════
  console.log('\n═══ 5. PERSONAL (sueldos, objetivos, deuda) ═══');
  await limpiar();
  const personal = await page.evaluate(async () => {
    // Ventas del mes: 20 días × 700 = 14.000, más un día de 500 con retraso
    const dias = [];
    for (let d = 1; d <= 20; d++) {
      const f = `2026-09-${String(d).padStart(2, '0')}`;
      await DB.guardar({ tipo: 'cierre', fecha: f, total: 700, proveedor: '', creado: new Date().toISOString() });
      dias.push(f);
    }
    await DB.guardar({ tipo: 'cierre', fecha: '2026-09-21', total: 500, proveedor: '', creado: new Date().toISOString() });
    // Objetivo pactado 13.500 → 1 %
    await DB.perGuardar({
      nombre: 'Santino', sueldoMensual: 900, diasMes: 26, horasJornada: 7.5,
      tramos: [{ objetivo: 13500, porcentaje: 1 }, { objetivo: 20000, porcentaje: 2 }],
      dias, tardes: [{ fecha: '2026-09-21', horas: 4 }], faltas: [], notasDias: [],
      creado: new Date().toISOString()
    });
    return true;
  });
  await page.click('.tab[data-tab="personal"]');
  await page.fill('#per-mes', '2026-09');
  await page.dispatchEvent('#per-mes', 'change');
  await page.waitForTimeout(900);
  await page.click('#per-lista .per-toggle');
  await page.waitForTimeout(500);
  const txtPer = (await page.textContent('#per-lista .per-body')).replace(/\s+/g, ' ');
  // Fijo: 21 días × 34,62 = 726,92 − descuento retraso (4/7,5 × 34,62 = 18,46) = 708,46
  chk('personal', 'Precio del día = 900 ÷ 26 = 34,62', txtPer.includes('34,62'));
  chk('personal', 'Descuento por 4 h de retraso = 18,46', txtPer.includes('18,46'));
  chk('personal', 'Fijo del mes 708,46 (21 días − retraso)', txtPer.includes('708,46'), txtPer.slice(0, 400));
  // Base de ventas: 14.000 + 500×3,5/7,5 (233,33) = 14.233,33 → supera 13.500 → 1 % = 142,33
  chk('personal', 'Ventas del día con retraso en proporción (14.233,33)', txtPer.includes('14.233,33'));
  chk('personal', 'Objetivo pactado 13.500 alcanzado → comisión 142,33', txtPer.includes('142,33'));
  chk('personal', 'Le corresponde el mes = fijo + comisión (850,79)', txtPer.includes('850,79'), 'no encontrado');

  // No llegar al objetivo → solo el fijo
  const sinObjetivo = await page.evaluate(async () => {
    const t = (await DB.perTodos())[0];
    t.tramos = [{ objetivo: 20000, porcentaje: 1 }];
    await DB.perGuardar(t);
    document.querySelector('#per-mes').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
    return document.querySelector('#per-lista').textContent.replace(/\s+/g, ' ');
  });
  chk('personal', 'Sin llegar al objetivo: solo el fijo pactado', sinObjetivo.includes('solo el fijo pactado'));
  chk('personal', 'Sin comisión, le corresponde solo 708,46', sinObjetivo.includes('708,46'));

  // ══════════════ 6. DEUDA ARRASTRADA Y LIQUIDACIÓN ══════════════
  console.log('\n═══ 6. DEUDA ENTRE MESES Y FINIQUITO ═══');
  const deuda = await page.evaluate(async () => {
    for (const t of await DB.perTodos()) await DB.perBorrar(t.id);
    for (const g of await DB.pagoTodos()) await DB.pagoBorrar(g.id);
    // Empleado con 10 días en agosto (275) y 2 días en septiembre (55)
    const dias = [];
    for (let d = 1; d <= 10; d++) dias.push(`2026-08-${String(d).padStart(2, '0')}`);
    dias.push('2026-09-01', '2026-09-02');
    await DB.perGuardar({ nombre: 'Deudor', sueldoMensual: 715, diasMes: 26, horasJornada: 7.5, tramos: [], dias, tardes: [], faltas: [], notasDias: [], creado: new Date().toISOString() });
    const t = (await DB.perTodos())[0];
    // Le da 200 en septiembre para saldar lo viejo
    await DB.pagoGuardar({ trabajadorSid: t.sid, fecha: '2026-09-01', importe: 200, notas: 'a cuenta', creado: new Date().toISOString() });
    return true;
  });
  await page.fill('#per-mes', '2026-09');
  await page.dispatchEvent('#per-mes', 'change');
  await page.waitForTimeout(900);
  const gen = (await page.textContent('#per-general')).replace(/\s+/g, ' ');
  // Devengado total: 12 días × 27,50 = 330 ; entregado 200 → debe 130
  chk('deuda', 'Visión general muestra la deuda TOTAL (130,00)', gen.includes('130,00'), gen.slice(0, 200));
  chk('deuda', 'Total que debe al equipo', gen.includes('TOTAL QUE DEBES AL EQUIPO'));

  // Pago posterior a la fecha de baja (caso crítico)
  const trasBaja = await page.evaluate(async () => {
    const t = (await DB.perTodos())[0];
    t.fin = '2026-09-02'; // deja de trabajar el 2 de septiembre
    await DB.perGuardar(t);
    // Le paga lo que le debía en OCTUBRE (después de la baja)
    await DB.pagoGuardar({ trabajadorSid: t.sid, fecha: '2026-10-05', importe: 130, notas: 'finiquito', creado: new Date().toISOString() });
    document.querySelector('#per-mes').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
    return document.querySelector('#per-lista').textContent.replace(/\s+/g, ' ');
  });
  chk('deuda', 'Un pago hecho DESPUÉS de la baja se descuenta de la deuda',
    /No le debes nada/.test(trasBaja) && !/DEBES PAGARLE \(todo lo pendiente\)130,00/.test(trasBaja),
    trasBaja.slice(0, 220));

  // Finiquito pagado el mes siguiente a la baja (el caso real más habitual)
  const finiquitoTardio = await page.evaluate(async () => {
    for (const t of await DB.perTodos()) await DB.perBorrar(t.id);
    for (const g of await DB.pagoTodos()) await DB.pagoBorrar(g.id);
    const dias = [];
    for (let d = 1; d <= 10; d++) dias.push(`2026-08-${String(d).padStart(2, '0')}`);
    await DB.perGuardar({ nombre: 'Extrabajador', sueldoMensual: 715, diasMes: 26, horasJornada: 7.5, tramos: [], dias, tardes: [], faltas: [], notasDias: [], fin: '2026-08-10', creado: new Date().toISOString() });
    const t = (await DB.perTodos())[0];
    await DB.pagoGuardar({ trabajadorSid: t.sid, fecha: '2026-09-05', importe: 275, notas: 'finiquito', creado: new Date().toISOString() });
    document.querySelector('#per-mes').value = '2026-08';
    document.querySelector('#per-mes').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
    return document.querySelector('#per-lista').textContent.replace(/\s+/g, ' ');
  });
  chk('deuda', 'Finiquito pagado el mes SIGUIENTE a la baja salda la deuda',
    /Sin deuda/.test(finiquitoTardio) && !/DEBES PAGARLE/.test(finiquitoTardio),
    finiquitoTardio.slice(0, 220));

  // ══════════════ 6b. FICHA DE UN TRABAJADOR YA LIQUIDADO ══════════════
  // Con esto el dueño puede contestar a un ex-empleado que discute su cuenta.
  console.log('\n═══ 6b. FICHA DE UN LIQUIDADO (verificar lo que le pagaste) ═══');
  await page.evaluate(async () => {
    for (const t of await DB.perTodos()) await DB.perBorrar(t.id);
    for (const g of await DB.pagoTodos()) await DB.pagoBorrar(g.id);
    // 10 días en agosto (275,00) y 2 en septiembre (55,00) → le corresponden 330,00
    const dias = [];
    for (let d = 1; d <= 10; d++) dias.push(`2026-08-${String(d).padStart(2, '0')}`);
    dias.push('2026-09-01', '2026-09-02');
    await DB.perGuardar({
      nombre: 'Antiguo', sueldoMensual: 715, diasMes: 26, horasJornada: 7.5, tramos: [],
      dias, tardes: [], faltas: [], notasDias: [], fin: '2026-09-02', creado: new Date().toISOString()
    });
    const t = (await DB.perTodos())[0];
    await DB.pagoGuardar({ trabajadorSid: t.sid, fecha: '2026-09-01', importe: 200, notas: 'a cuenta', creado: new Date().toISOString() });
  });
  await page.fill('#per-mes', '2026-09');
  await page.dispatchEvent('#per-mes', 'change');
  await page.waitForTimeout(900);

  // Abre la ficha (activa o liquidada): el cuerpo puede no existir o estar plegado
  const abrirFicha = async (caja) => {
    const yaAbierta = await page.evaluate(c => {
      const b = document.querySelector(c + ' .per-body');
      return !!b && !b.classList.contains('hidden');
    }, caja);
    if (!yaAbierta) { await page.click(caja + ' .per-toggle'); await page.waitForTimeout(900); }
  };

  // Se liquida por el camino de verdad: el botón de abonar el finiquito
  await abrirFicha('#per-lista');
  await page.click('#per-lista .per-abonar');
  await page.waitForTimeout(1100);
  const trasAbonar = await page.evaluate(async () => {
    const t = (await DB.perTodos())[0];
    const pagos = (await DB.pagoTodos()).filter(p => p.trabajadorSid === t.sid);
    return { liquidado: t.liquidado, pagos: pagos.map(p => ({ importe: p.importe, finiquito: p.finiquito === true })) };
  });
  chk('liquidado', 'Al abonar queda marcado como liquidado con su fecha', /^\d{4}-\d{2}-\d{2}$/.test(trasAbonar.liquidado || ''), String(trasAbonar.liquidado));
  chk('liquidado', 'Se apunta la entrega del finiquito (130,00) marcada como tal',
    trasAbonar.pagos.length === 2 && trasAbonar.pagos.some(p => cerca(p.importe, 130) && p.finiquito), JSON.stringify(trasAbonar.pagos));

  // La ficha se puede abrir (antes era una tarjeta muerta)
  chk('liquidado', 'La ficha de un liquidado ya se puede abrir',
    await page.evaluate(() => !!document.querySelector('#per-lista .per-toggle[data-sid]')));
  await abrirFicha('#per-lista');
  const txtLiq = (await page.textContent('#per-lista .per-body')).replace(/\s+/g, ' ');

  chk('liquidado', 'Se ven TODAS sus entregas, no solo las del mes elegido',
    txtLiq.includes('200,00') && txtLiq.includes('130,00'), txtLiq.slice(0, 220));
  chk('liquidado', 'El finiquito sale identificado', /Liquidación final/.test(txtLiq));
  chk('liquidado', 'El cuadre compara lo que le correspondió con lo que le pagaste',
    txtLiq.includes('Le correspondió en todo su tiempo') && txtLiq.includes('Le pagaste en total'));
  chk('liquidado', 'El cuadre sale a cero: se le pagó todo (330,00)',
    /Cuadra/.test(txtLiq) && (txtLiq.match(/330,00/g) || []).length >= 2, txtLiq.slice(0, 300));
  chk('liquidado', 'Desglose mes a mes: agosto 275,00 y septiembre 55,00',
    /Agosto 2026/.test(txtLiq) && txtLiq.includes('275,00') && /Septiembre 2026/.test(txtLiq) && txtLiq.includes('55,00'));
  chk('liquidado', 'La cuenta explicada también está aquí (715 ÷ 26 = 27,50 el día)',
    txtLiq.includes('27,50') && /De dónde sale cada número/.test(txtLiq));
  chk('liquidado', 'Una ficha liquidada no trae botones de borrar entregas',
    await page.evaluate(() => document.querySelectorAll('#per-lista .pago-borrar').length === 0));

  // El calendario es la prueba de los días: se ve, pero no se toca
  const cal = await page.evaluate(() => ({
    celdas: document.querySelectorAll('#per-lista .cal-lectura .dia').length,
    botones: document.querySelectorAll('#per-lista .cal-lectura button').length,
    trabajados: document.querySelectorAll('#per-lista .cal-lectura .dia.on').length
  }));
  chk('liquidado', 'Su calendario se muestra en solo lectura, sin botones', cal.celdas > 0 && cal.botones === 0, JSON.stringify(cal));
  chk('liquidado', 'Los días que trabajó siguen viéndose marcados (no se apagan)', cal.trabajados > 0, JSON.stringify(cal));
  const diasTrasClic = await page.evaluate(async () => {
    const det = document.querySelector('#per-lista details.ocr-details');
    if (det) det.open = true;
    await new Promise(r => setTimeout(r, 200));
    const celda = document.querySelector('#per-lista .cal-lectura .dia.on');
    if (celda) celda.click();
    await new Promise(r => setTimeout(r, 600));
    const t = (await DB.perTodos())[0];
    return { dias: t.dias.length, tardes: (t.tardes || []).length, faltas: (t.faltas || []).length };
  });
  chk('liquidado', 'Tocar un día de un liquidado NO le cambia los días',
    diasTrasClic.dias === 12 && diasTrasClic.tardes === 0 && diasTrasClic.faltas === 0, JSON.stringify(diasTrasClic));

  // El texto que se le envía: toda su cuenta y nada del negocio
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('sin portapapeles')) }, configurable: true
    });
  });
  await page.click('#per-lista .per-compartir');
  await page.waitForTimeout(700);
  const envio = await page.textContent('#modal-body pre');
  chk('liquidado', 'El texto para enviarle lleva toda su etapa, no un solo mes',
    /Agosto 2026/.test(envio) && /Septiembre 2026/.test(envio), envio.slice(0, 160));
  chk('liquidado', 'El texto lleva el total pagado y el cuadre',
    /Total pagado: 330,00/.test(envio) && /CUADRE/.test(envio), envio.slice(-160));
  chk('liquidado', 'El texto que se le envía no lleva nada del negocio ni de la app',
    !/wander|contable/i.test(envio), envio.slice(0, 120));
  await page.click('#modal-cerrar');
  await page.waitForTimeout(300);

  // Pasados los días de memoria, la MISMA ficha vive en el historial
  await page.evaluate(async () => {
    const t = (await DB.perTodos())[0];
    const d = new Date(); d.setDate(d.getDate() - 30);
    t.liquidado = d.toISOString().slice(0, 10);
    await DB.perGuardar(t);
    document.querySelector('#per-mes').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1100));
  });
  chk('liquidado', 'Pasados los días de memoria baja al historial y sale de la lista',
    await page.evaluate(() => !!document.querySelector('#per-historial .per-toggle') &&
      !document.querySelector('#per-lista .per-toggle')));
  await abrirFicha('#per-historial');
  const txtHist = (await page.textContent('#per-historial .per-body')).replace(/\s+/g, ' ');
  chk('liquidado', 'En el historial se ve exactamente la misma ficha completa',
    txtHist.includes('200,00') && txtHist.includes('130,00') && /Agosto 2026/.test(txtHist) &&
    txtHist.includes('27,50') && /Cuadra/.test(txtHist), txtHist.slice(0, 240));

  // Reabrir: la única forma de corregir una liquidación equivocada
  await page.click('#per-historial .per-reabrir');
  await page.waitForTimeout(1100);
  const reabierto = await page.evaluate(async () => {
    const t = (await DB.perTodos())[0];
    return {
      liquidado: t.liquidado,
      pagos: (await DB.pagoTodos()).length,
      enLista: !!document.querySelector('#per-lista .per-toggle'),
      historial: document.querySelector('#per-historial').textContent
    };
  });
  chk('liquidado', 'Reabrir devuelve al trabajador con los activos', !reabierto.liquidado && reabierto.enLista, JSON.stringify(reabierto.liquidado));
  chk('liquidado', 'Reabrir NO borra ninguna de las entregas que le hiciste', reabierto.pagos === 2, 'quedan ' + reabierto.pagos);
  chk('liquidado', 'El historial vuelve a quedar vacío', /Sin trabajadores antiguos/.test(reabierto.historial));
  const trasReabrir = await page.evaluate(async () => {
    const btn = document.querySelector('#per-lista .cal .dia:not([disabled])');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 700));
    return (await DB.perTodos())[0].dias.length;
  });
  chk('liquidado', 'Reabierto, su calendario se puede volver a tocar', trasReabrir !== 12, 'días: ' + trasReabrir);

  // ══════════════ 6c. RETRASOS: DÓNDE SE LE DESCONTÓ ══════════════
  // "No puede cobrar lo mismo un día normal que uno que llega tarde": el desglose
  // día a día tiene que cuadrar al céntimo aunque el empleado lo haga a mano.
  console.log('\n═══ 6c. RETRASOS (dónde se le descontó) ═══');
  const sembrarTrabajador = async (ficha, cierres) => {
    await page.evaluate(async ({ ficha, cierres }) => {
      for (const t of await DB.perTodos()) await DB.perBorrar(t.id);
      for (const g of await DB.pagoTodos()) await DB.pagoBorrar(g.id);
      for (const r of await DB.todos()) await DB.borrar(r.id);
      for (const c of cierres) {
        await DB.guardar({ tipo: 'cierre', fecha: c.fecha, total: c.total, proveedor: '', creado: new Date().toISOString() });
      }
      await DB.perGuardar(Object.assign({
        sueldoMensual: 900, diasMes: 26, horasJornada: 7.5, tramos: [],
        dias: [], tardes: [], faltas: [], notasDias: [], creado: new Date().toISOString()
      }, ficha));
    }, { ficha, cierres });
    await page.fill('#per-mes', '2026-09');
    await page.dispatchEvent('#per-mes', 'change');
    await page.waitForTimeout(900);
    const abierta = await page.evaluate(() => {
      const b = document.querySelector('#per-lista .per-body');
      return !!b && !b.classList.contains('hidden');
    });
    if (!abierta) { await page.click('#per-lista .per-toggle'); await page.waitForTimeout(800); }
    return (await page.textContent('#per-lista .per-body')).replace(/\s+/g, ' ');
  };
  const dd = (n) => `2026-09-${String(n).padStart(2, '0')}`;

  // --- Caso 1: un retraso de 4 h, con cierre ese día (el caso real) ---
  const dias20 = []; const cierres20 = [];
  for (let d = 1; d <= 20; d++) { dias20.push(dd(d)); cierres20.push({ fecha: dd(d), total: 700 }); }
  cierres20.push({ fecha: dd(21), total: 500 });
  const txtR = await sembrarTrabajador(
    { nombre: 'Retraso', dias: dias20, tardes: [{ fecha: dd(21), horas: 4 }], tramos: [{ objetivo: 13500, porcentaje: 1 }] },
    cierres20);

  chk('retrasos', 'El fijo se escribe como 900,00 ÷ 26 × 21, que cuadra a mano',
    /900,00\s*€?\s*÷\s*26\s*×\s*21/.test(txtR), txtR.slice(0, 300));
  chk('retrasos', 'Ya no aparece la multiplicación que no cuadra (727,02)', !txtR.includes('727,02'));
  chk('retrasos', 'Se ve el fijo bruto antes de descontar (726,92)', txtR.includes('726,92'));
  chk('retrasos', 'Las tres filas cuadran: 726,92 − 18,46 = 708,46',
    txtR.includes('726,92') && txtR.includes('18,46') && txtR.includes('708,46'), txtR.slice(0, 400));
  chk('retrasos', 'Dice el día exacto y las horas de retraso',
    /21\/09\/2026/.test(txtR) && /llegó 4 h tarde/.test(txtR), txtR.slice(0, 600));
  chk('retrasos', 'Dice cuántas horas estuvo ese día (3,5 h de 7,5 h)',
    /3,5 h de las 7,5 h/.test(txtR), txtR.slice(0, 600));
  chk('retrasos', 'Dice lo que cobró ese día frente a un día normal (16,16 en vez de 34,62)',
    /cobró 16,16 € en vez de 34,62 €/.test(txtR), txtR.slice(0, 700));
  chk('retrasos', 'Explica el efecto de ese día en su objetivo (233,33 de 500,00)',
    txtR.includes('233,33') && txtR.includes('500,00'));
  chk('retrasos', 'Lleva el total descontado por llegar tarde',
    /TOTAL DESCONTADO POR LLEGAR TARDE/i.test(txtR) && txtR.includes('18,46'));
  chk('retrasos', 'Invita a comprobar la resta (726,92 − 18,46 = 708,46)',
    /726,92 € − 18,46 € = 708,46 €/.test(txtR), txtR.slice(-400));
  chk('retrasos', 'Las horas se escriben con coma, no con punto', !/\d\.\d+ h/.test(txtR));

  // --- Caso 2: VARIOS retrasos el mismo mes (prueba de que suma exacto) ---
  const dias17 = []; for (let d = 1; d <= 17; d++) dias17.push(dd(d));
  const txtM = await sembrarTrabajador({
    nombre: 'Varios', dias: dias17,
    tardes: [{ fecha: dd(18), horas: 4 }, { fecha: dd(19), horas: 2 },
             { fecha: dd(20), horas: 1 }, { fecha: dd(21), horas: 3 }]
  }, []);
  chk('retrasos', 'Con 4 retrasos hay una fila por cada día (18,46 · 9,23 · 4,62 · 13,85)',
    ['18,46', '9,23', '4,62', '13,85'].every(v => txtM.includes(v)), txtM.slice(0, 800));
  chk('retrasos', 'Las 4 filas suman exactamente el total descontado (46,16, no 46,15)',
    txtM.includes('46,16') && !txtM.includes('46,15'), txtM.slice(0, 800));
  chk('retrasos', 'El fijo con 4 retrasos: 726,92 − 46,16 = 680,76',
    txtM.includes('680,76') && !txtM.includes('680,77'), txtM.slice(0, 500));

  // --- Caso 3: retraso apuntado sin horas ---
  const txt0 = await sembrarTrabajador(
    { nombre: 'SinHoras', dias: dias20, tardes: [{ fecha: dd(21), horas: 0 }] }, []);
  chk('retrasos', 'Un retraso sin horas dice que se le pagó el día entero',
    /Se le pagó el día entero/i.test(txt0), txt0.slice(0, 500));
  chk('retrasos', 'Un retraso sin horas no descuenta nada del fijo (726,92)',
    txt0.includes('726,92') && !/TOTAL DESCONTADO/i.test(txt0), txt0.slice(0, 400));

  // --- Caso 4: llegó más tarde que toda su jornada ---
  const txtX = await sembrarTrabajador(
    { nombre: 'MuyTarde', dias: dias20, tardes: [{ fecha: dd(21), horas: 9 }] }, []);
  chk('retrasos', 'Si llega más tarde que su jornada, ese día no cobra nada',
    /No llegó a hacer ninguna hora/.test(txtX) && /no cobró nada/.test(txtX), txtX.slice(0, 600));
  chk('retrasos', 'Y el descuento es como mucho un día entero (34,62)',
    txtX.includes('34,62') && !txtX.includes('41,54'), txtX.slice(0, 600));

  // --- Caso 5: todos los días con retraso completo → el fijo nunca sale negativo ---
  const tardesTodas = []; for (let d = 1; d <= 21; d++) tardesTodas.push({ fecha: dd(d), horas: 8 });
  const txtNeg = await sembrarTrabajador({ nombre: 'TodoTarde', dias: [], tardes: tardesTodas }, []);
  const fijoNeg = await page.evaluate(() => {
    const fila = [...document.querySelectorAll('#per-lista .stat-linea')]
      .find(el => /FIJO DEL MES/.test(el.textContent));
    return fila ? fila.lastElementChild.textContent.replace(/[^\d.,−-]/g, '').trim() : 'no encontrado';
  });
  chk('retrasos', 'Con todos los días de retraso completo el fijo no sale negativo',
    fijoNeg === '0,00', 'obtenido ' + fijoNeg);
  chk('retrasos', 'Y avisa de que el descuento se topa al fijo del mes',
    /no puede pasar del fijo del mes/i.test(txtNeg), txtNeg.slice(0, 500));

  // --- Caso 6: horas guardadas como texto (copia manipulada o dato viejo) ---
  const horasTexto = await page.evaluate(async () => {
    const t = (await DB.perTodos())[0];
    t.dias = ['2026-09-01', '2026-09-02', '2026-09-03'];
    t.tardes = [{ fecha: '2026-09-02', horas: '4' }, { fecha: '2026-09-03', horas: '2' }];
    await DB.perGuardar(t);
    document.querySelector('#per-mes').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
    const txt = document.querySelector('#per-lista .per-body').textContent.replace(/\s+/g, ' ');
    const m = txt.match(/\((\d+) días?, ([\d,]+) h\)/);
    return m ? m[2] : txt.slice(0, 200);
  });
  chk('retrasos', 'Unas horas guardadas como texto no inflan el total (6 h, no 42)',
    horasTexto === '6', 'obtenido ' + horasTexto);

  // --- Caso 7: retraso sin cierre de ventas ese día ---
  const txtSC = await sembrarTrabajador(
    { nombre: 'SinCierre', dias: dias17, tardes: [{ fecha: dd(18), horas: 4 }] }, []);
  chk('retrasos', 'Un día de retraso sin cierre se explica igual y no inventa ventas',
    /llegó 4 h tarde/.test(txtSC) && !/le contaron/.test(txtSC), txtSC.slice(0, 500));

  // --- Caso 8: el texto que se le envía por WhatsApp ---
  await sembrarTrabajador(
    { nombre: 'Envio', dias: dias20, tardes: [{ fecha: dd(21), horas: 4 }], tramos: [{ objetivo: 13500, porcentaje: 1 }] },
    cierres20);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('sin portapapeles')) }, configurable: true
    });
  });
  await page.click('#per-lista .per-compartir');
  await page.waitForTimeout(700);
  const envioMes = await page.textContent('#modal-body pre');
  chk('retrasos', 'El resumen de WhatsApp explica por qué se le descontó por llegar tarde',
    /POR QUÉ SE LE DESCONTÓ DINERO ALGUNOS DÍAS/.test(envioMes) && envioMes.includes('18,46'), envioMes.slice(0, 300));
  chk('retrasos', 'El resumen dice lo que cobró ese día en vez de un día normal',
    /cobró 16,16 € en vez de 34,62 €/.test(envioMes), envioMes.slice(0, 400));
  chk('retrasos', 'El resumen enseña de dónde sale el fijo (726,92 − 18,46 = 708,46)',
    envioMes.includes('726,92') && envioMes.includes('708,46'), envioMes.slice(0, 400));
  chk('retrasos', 'El resumen con el desglose sigue sin nombrar el negocio ni la app',
    !/wander|contable/i.test(envioMes), envioMes.slice(0, 120));
  await page.click('#modal-cerrar');
  await page.waitForTimeout(300);

  // --- Caso 9: en la ficha de un liquidado se ve el mismo desglose ---
  await page.evaluate(async () => {
    const t = (await DB.perTodos())[0];
    t.fin = '2026-09-21'; t.liquidado = '2026-09-22';
    await DB.perGuardar(t);
    document.querySelector('#per-mes').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1100));
  });
  const cajaLiq = await page.evaluate(() =>
    document.querySelector('#per-historial .per-toggle') ? '#per-historial' : '#per-lista');
  const yaAbierta = await page.evaluate(c => {
    const b = document.querySelector(c + ' .per-body');
    return !!b && !b.classList.contains('hidden');
  }, cajaLiq);
  if (!yaAbierta) { await page.click(cajaLiq + ' .per-toggle'); await page.waitForTimeout(900); }
  const txtLiqR = (await page.textContent(cajaLiq + ' .per-body')).replace(/\s+/g, ' ');
  chk('retrasos', 'La ficha de un liquidado enseña dónde se le descontó por llegar tarde',
    /Dónde se le descontó por llegar tarde/i.test(txtLiqR) && txtLiqR.includes('18,46'), txtLiqR.slice(0, 500));
  chk('retrasos', 'Y ahí el desglose no va metido en otro plegable dentro del mes',
    await page.evaluate(c => !document.querySelector(c + ' details details'), cajaLiq));

  // ══════════════ 6e. POR QUÉ SE LE DESCONTÓ (explicado) ══════════════
  // No basta con enseñar el resultado: el trabajador tiene que entender la regla.
  console.log('\n═══ 6e. POR QUÉ SE LE DESCONTÓ (la regla explicada) ═══');

  // Dos meses con un retraso cada uno, y ya liquidado
  await page.evaluate(async () => {
    for (const t of await DB.perTodos()) await DB.perBorrar(t.id);
    for (const g of await DB.pagoTodos()) await DB.pagoBorrar(g.id);
    for (const r of await DB.todos()) await DB.borrar(r.id);
    const dias = [];
    for (let d = 1; d <= 9; d++) dias.push(`2026-08-${String(d).padStart(2, '0')}`);
    for (let d = 1; d <= 20; d++) {
      const f = `2026-09-${String(d).padStart(2, '0')}`;
      await DB.guardar({ tipo: 'cierre', fecha: f, total: 700, proveedor: '', creado: new Date().toISOString() });
      dias.push(f);
    }
    await DB.guardar({ tipo: 'cierre', fecha: '2026-09-21', total: 500, proveedor: '', creado: new Date().toISOString() });
    await DB.perGuardar({
      nombre: 'DosMeses', sueldoMensual: 900, diasMes: 26, horasJornada: 7.5,
      tramos: [{ objetivo: 13500, porcentaje: 1 }], dias,
      tardes: [{ fecha: '2026-08-10', horas: 2 }, { fecha: '2026-09-21', horas: 4 }],
      faltas: [], notasDias: [], inicio: '2026-08-01', fin: '2026-09-21', liquidado: '2026-09-22',
      creado: new Date().toISOString()
    });
  });
  await page.fill('#per-mes', '2026-09');
  await page.dispatchEvent('#per-mes', 'change');
  await page.waitForTimeout(1200);
  const cajaExp = await page.evaluate(() =>
    document.querySelector('#per-historial .per-toggle') ? '#per-historial' : '#per-lista');

  // La línea de arriba tiene que verse SIN desplegar ningún mes
  const abiertaExp = await page.evaluate(c => {
    const b = document.querySelector(c + ' .per-body');
    return !!b && !b.classList.contains('hidden');
  }, cajaExp);
  if (!abiertaExp) { await page.click(cajaExp + ' .per-toggle'); await page.waitForTimeout(900); }
  const arriba = await page.evaluate(c => {
    const out = [];
    document.querySelectorAll(c + ' .per-body > .stat-linea').forEach(el => out.push(el.textContent.replace(/\s+/g, ' ')));
    return out.join(' | ');
  }, cajaExp);
  chk('retrasos', 'La ficha dice ARRIBA cuántos días llegó tarde en toda su etapa',
    /Llegó tarde 2 días en toda su etapa/.test(arriba), arriba.slice(0, 300));
  chk('retrasos', 'Y el total descontado de la etapa es la suma de los dos meses (9,23 + 18,46 = 27,69)',
    arriba.includes('27,69'), arriba.slice(0, 300));

  const txtExp = (await page.textContent(cajaExp + ' .per-body')).replace(/\s+/g, ' ');
  chk('retrasos', 'La ficha explica la regla con palabras (jornada y parte del día)',
    /Se cobra por día trabajado/.test(txtExp) && /solo la parte del día que se estuvo/.test(txtExp),
    txtExp.slice(0, 400));
  chk('retrasos', 'La ficha enseña la división hecha (4 h ÷ 7,5 h × 34,62 € = 18,46 €)',
    /4 h ÷ 7,5 h × 34,62 € = 18,46 €/.test(txtExp), txtExp.slice(0, 600));

  // El texto que se le envía de toda su etapa
  const envioExp = await page.evaluate(async (c) => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('no')) }, configurable: true
    });
    document.querySelector(c + ' .per-compartir').click();
    await new Promise(r => setTimeout(r, 700));
    const txt = document.querySelector('#modal-body pre').textContent;
    document.querySelector('#modal-cerrar').click();
    return txt;
  }, cajaExp);
  chk('retrasos', 'El texto de toda su etapa explica POR QUÉ se le descontó',
    /POR QUÉ SE LE DESCONTÓ DINERO ALGUNOS DÍAS/.test(envioExp) &&
    /Se cobra por día trabajado/.test(envioExp), envioExp.slice(0, 400));
  chk('retrasos', 'Lleva la división de cada uno de los dos días',
    /2 h ÷ 7,5 h × 34,62 € = 9,23 €/.test(envioExp) &&
    /4 h ÷ 7,5 h × 34,62 € = 18,46 €/.test(envioExp), envioExp.slice(-700));
  chk('retrasos', 'Dice lo que cobró cada uno de esos días frente a un día normal',
    /cobró 25,39 € en vez de 34,62 €/.test(envioExp) &&
    /cobró 16,16 € en vez de 34,62 €/.test(envioExp), envioExp.slice(-700));
  chk('retrasos', 'Y cierra con los días y el total de toda su etapa (27,69)',
    /Llegó tarde 2 días en toda su etapa/.test(envioExp) && envioExp.includes('27,69'), envioExp.slice(-400));
  chk('retrasos', 'El detalle ya no se repite dentro de cada mes',
    (envioExp.match(/Estuvo 3,5 h/g) || []).length === 1, envioExp.slice(0, 600));
  chk('retrasos', 'El texto explicado sigue sin nombrar el negocio ni la app',
    !/wander|contable/i.test(envioExp));

  // Sin retrasos: ni la línea de arriba ni la sección
  await page.evaluate(async () => {
    const t = (await DB.perTodos())[0];
    t.tardes = [];
    await DB.perGuardar(t);
    document.querySelector('#per-mes').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1200));
  });
  const abiertaSin = await page.evaluate(c => {
    const b = document.querySelector(c + ' .per-body');
    return !!b && !b.classList.contains('hidden');
  }, cajaExp);
  if (!abiertaSin) { await page.click(cajaExp + ' .per-toggle'); await page.waitForTimeout(900); }
  const txtSinTarde = (await page.textContent(cajaExp + ' .per-body')).replace(/\s+/g, ' ');
  chk('retrasos', 'Sin retrasos no aparece la línea de arriba ni la explicación',
    !/en toda su etapa/.test(txtSinTarde) && !/Se cobra por día trabajado/.test(txtSinTarde),
    txtSinTarde.slice(0, 300));

  // ══════════════ 6d. EL OBJETIVO EN LOS RESÚMENES ══════════════
  // "Objetivo pactado, facturado tanto, y lo que faltó para llegar": tiene que
  // salir igual en la ficha y en lo que se le envía, y sin datos del local.
  console.log('\n═══ 6d. EL OBJETIVO EN LOS RESÚMENES ═══');
  const conObjetivo = (totalDia) => {
    const dias = []; const cierres = [];
    for (let d = 1; d <= 20; d++) { dias.push(dd(d)); cierres.push({ fecha: dd(d), total: totalDia }); }
    cierres.push({ fecha: dd(21), total: 500 });
    return { dias, cierres };
  };
  const tramos2 = [{ objetivo: 13500, porcentaje: 1 }, { objetivo: 20000, porcentaje: 2 }];
  const leerEnvio = async () => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: () => Promise.reject(new Error('sin portapapeles')) }, configurable: true
      });
    });
    await page.click('#per-lista .per-compartir');
    await page.waitForTimeout(700);
    const txt = await page.textContent('#modal-body pre');
    await page.click('#modal-cerrar');
    await page.waitForTimeout(300);
    return txt;
  };

  // --- Alcanza el primer tramo y tiene otro por encima ---
  const alcanza = conObjetivo(700);
  const txtOk = await sembrarTrabajador(
    { nombre: 'ConObjetivo', dias: alcanza.dias, tardes: [{ fecha: dd(21), horas: 4 }], tramos: tramos2 },
    alcanza.cierres);
  chk('objetivos', 'La ficha dice el objetivo pactado (13.500,00)',
    /Objetivo pactado/.test(txtOk) && txtOk.includes('13.500,00'), txtOk.slice(0, 400));
  chk('objetivos', 'La ficha dice lo facturado en SUS días (14.233,33)',
    /Facturado en sus días/.test(txtOk) && txtOk.includes('14.233,33'), txtOk.slice(0, 400));
  chk('objetivos', 'Dice que alcanzó el objetivo con su comisión (1 % = 142,33)',
    /✅ Objetivo alcanzado/.test(txtOk) && txtOk.includes('142,33'), txtOk.slice(0, 500));
  chk('objetivos', 'Y lo que le faltó para el siguiente tramo (20.000,00 → 5766,67)',
    txtOk.includes('20.000,00') && txtOk.includes('5766,67'), txtOk.slice(0, 600));

  const envioOk = await leerEnvio();
  chk('objetivos', 'El WhatsApp del mes lleva el objetivo, lo facturado y la comisión',
    /SU OBJETIVO/.test(envioOk) && envioOk.includes('13.500,00') &&
    envioOk.includes('14.233,33') && envioOk.includes('142,33'), envioOk.slice(0, 400));
  chk('objetivos', 'El WhatsApp NO le enseña la facturación del local (14.500,00)',
    !envioOk.includes('14.500,00'), envioOk.slice(0, 200));
  chk('objetivos', 'El WhatsApp con el objetivo sigue sin nombrar el negocio ni la app',
    !/wander|contable/i.test(envioOk));

  // --- No llega al primer tramo ---
  const noLlega = conObjetivo(500);
  const txtNo = await sembrarTrabajador(
    { nombre: 'SinLlegar', dias: noLlega.dias, tardes: [{ fecha: dd(21), horas: 4 }], tramos: tramos2 },
    noLlega.cierres);
  chk('objetivos', 'Si no llega, dice cuánto le faltó (10.233,33 de 13.500 → 3266,67)',
    txtNo.includes('10.233,33') && txtNo.includes('3266,67') && /Faltan/.test(txtNo), txtNo.slice(0, 500));
  chk('objetivos', 'Y que ese mes cobra solo el fijo',
    /solo el fijo pactado/.test(txtNo), txtNo.slice(0, 500));
  const envioNo = await leerEnvio();
  chk('objetivos', 'El WhatsApp dice lo que le faltó para el objetivo',
    /SU OBJETIVO/.test(envioNo) && envioNo.includes('3266,67') && /solo el fijo/.test(envioNo), envioNo.slice(0, 400));
  chk('objetivos', 'Y tampoco ahí se le enseña la facturación del local (10.500,00)',
    !envioNo.includes('10.500,00'), envioNo.slice(0, 200));

  // --- Sin objetivos pactados: el bloque no sale ---
  const txtSin = await sembrarTrabajador(
    { nombre: 'SinTramos', dias: noLlega.dias, tardes: [], tramos: [] }, noLlega.cierres);
  chk('objetivos', 'Un trabajador sin objetivos no enseña el bloque',
    !/Objetivo pactado/.test(txtSin) && /Sin comisiones pactadas/.test(txtSin), txtSin.slice(0, 400));
  const envioSin = await leerEnvio();
  chk('objetivos', 'Y su WhatsApp tampoco habla de objetivos',
    !/SU OBJETIVO/.test(envioSin), envioSin.slice(0, 300));

  // --- Ficha de un liquidado: el mismo bloque, en pasado ---
  await sembrarTrabajador(
    { nombre: 'Liquidado', dias: alcanza.dias, tardes: [{ fecha: dd(21), horas: 4 }], tramos: tramos2 },
    alcanza.cierres);
  await page.evaluate(async () => {
    const t = (await DB.perTodos())[0];
    t.fin = '2026-09-21'; t.liquidado = '2026-09-22';
    await DB.perGuardar(t);
    document.querySelector('#per-mes').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1100));
  });
  const cajaObj = await page.evaluate(() =>
    document.querySelector('#per-historial .per-toggle') ? '#per-historial' : '#per-lista');
  const abiertaObj = await page.evaluate(c => {
    const b = document.querySelector(c + ' .per-body');
    return !!b && !b.classList.contains('hidden');
  }, cajaObj);
  if (!abiertaObj) { await page.click(cajaObj + ' .per-toggle'); await page.waitForTimeout(900); }
  const txtLiqObj = (await page.textContent(cajaObj + ' .per-body')).replace(/\s+/g, ' ');
  chk('objetivos', 'La ficha de un liquidado enseña su objetivo mes a mes',
    /Objetivo pactado/.test(txtLiqObj) && txtLiqObj.includes('13.500,00') &&
    txtLiqObj.includes('14.233,33'), txtLiqObj.slice(0, 500));
  chk('objetivos', 'Y ahí se escribe en pasado (le faltaron)',
    /le faltaron/.test(txtLiqObj) && !/le faltan /.test(txtLiqObj), txtLiqObj.slice(0, 600));

  const envioEtapa = await page.evaluate(async (caja) => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('no')) }, configurable: true
    });
    document.querySelector(caja + ' .per-compartir').click();
    await new Promise(r => setTimeout(r, 700));
    const txt = document.querySelector('#modal-body pre').textContent;
    document.querySelector('#modal-cerrar').click();
    return txt;
  }, cajaObj);
  chk('objetivos', 'El WhatsApp de toda su etapa lleva el objetivo de cada mes',
    /Objetivo pactado: 13\.500,00/.test(envioEtapa) && envioEtapa.includes('14.233,33'), envioEtapa.slice(0, 500));
  chk('objetivos', 'Y el total facturado en sus días, avisando de que los objetivos son mensuales',
    /Facturado en sus días, en total/.test(envioEtapa) && /cada mes empieza de cero/.test(envioEtapa), envioEtapa.slice(-400));
  chk('objetivos', 'El resumen de toda la etapa sigue sin nombrar el negocio ni la app',
    !/wander|contable/i.test(envioEtapa));
  await page.waitForTimeout(300);

  // ══════════════ 7. LECTURA DE FACTURAS (OCR) ══════════════
  console.log('\n═══ 7. DETECCIÓN AUTOMÁTICA DE FACTURAS ═══');
  const ocr = await page.evaluate(() => {
    const casos = [];
    const conocidos = [{ nombre: 'Distribuciones García S.L.', nif: 'B41234567' }];
    casos.push(['Factura con desglose', OCR.analizarFactura(`
DISTRIBUCIONES GARCIA S.L.
CIF: B41234567
Fecha: 02/09/2026
Base imponible 100,00
IVA 21% 21,00
TOTAL FACTURA 121,00`, conocidos)]);
    casos.push(['Ticket con cambio', OCR.analizarFactura(`
SUPERMERCADO EL AHORRO S.A.
04/09/2026
TOTAL 44,80
ENTREGADO 50,00
CAMBIO 5,20`, [])]);
    casos.push(['Alquiler con retención', OCR.analizarFactura(`
INMOBILIARIA SUR S.A.
Fecha factura: 01/09/2026
Vencimiento: 05/10/2026
Base imponible 800,00
IVA 21% 168,00
Retención IRPF 19% 152,00
TOTAL A PAGAR 816,00`, [])]);
    casos.push(['Cierre Z con apertura', OCR.analizarCierre(`
CIERRE Z
FECHA APERTURA: 10/09/2026 20:00
FECHA CIERRE: 11/09/2026 03:30
FECHA IMPRESION: 11/09/2026 03:31
TOTAL VENTAS 1.250,00
EFECTIVO 800,00
TARJETA 450,00`)]);
    return casos;
  });
  const f1 = ocr[0][1], f2 = ocr[1][1], f3 = ocr[2][1], c1 = ocr[3][1];
  chk('ocr', 'Reconoce al proveedor ya dado de alta', f1.proveedor === 'Distribuciones García S.L.');
  chk('ocr', 'Detecta total, base e IVA', cerca(f1.total, 121) && cerca(f1.baseImponible, 100) && cerca(f1.ivaCuota, 21));
  chk('ocr', 'Detecta la fecha de la factura', f1.fecha === '2026-09-02');
  chk('ocr', 'En un ticket no confunde el cambio con el total', cerca(f2.total, 44.80), 'total=' + f2.total);
  chk('ocr', 'Detecta la retención de IRPF del alquiler', f3.retTipo === 19 && cerca(f3.retCuota, 152));
  chk('ocr', 'Usa la fecha de emisión, no la de vencimiento', f3.fecha === '2026-09-01');
  chk('ocr', 'En el cierre usa la fecha de APERTURA', c1.fecha === '2026-09-10', 'fecha=' + c1.fecha);
  chk('ocr', 'Detecta ventas, efectivo y tarjeta del cierre', cerca(c1.total, 1250) && cerca(c1.efectivo, 800) && cerca(c1.tarjeta, 450));

  // ══════════════ 8. BÚSQUEDAS Y DUPLICADOS ══════════════
  console.log('\n═══ 8. BÚSQUEDAS, FILTROS Y AVISOS ═══');
  await limpiar();
  const busq = await page.evaluate(async () => {
    await DB.guardar({ tipo: 'factura', fecha: '2026-09-01', proveedor: 'Bebidas Pepe', total: 100, creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'factura', fecha: '2026-09-15', proveedor: 'Bebidas Pepe', total: 200, creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'factura', fecha: '2026-10-01', proveedor: 'Otro', total: 300, creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'cierre', fecha: '2026-09-10', total: 900, proveedor: '', creado: new Date().toISOString() });
    return {
      porProveedor: (await DB.buscar({ proveedor: 'bebidas' })).length,
      porFechas: (await DB.buscar({ desde: '2026-09-01', hasta: '2026-09-30' })).length,
      soloFacturas: (await DB.buscar({ tipo: 'factura' })).length,
      soloCierres: (await DB.buscar({ tipo: 'cierre' })).length,
      orden: (await DB.buscar({ tipo: 'factura' })).map(r => r.fecha)
    };
  });
  chk('busqueda', 'Buscar por proveedor sin distinguir mayúsculas', busq.porProveedor === 2, 'encontrados ' + busq.porProveedor);
  chk('busqueda', 'Filtrar por rango de fechas (septiembre)', busq.porFechas === 3, 'encontrados ' + busq.porFechas);
  chk('busqueda', 'Filtrar solo facturas / solo cierres', busq.soloFacturas === 3 && busq.soloCierres === 1);
  chk('busqueda', 'Resultados ordenados de más reciente a más antiguo',
    busq.orden[0] === '2026-10-01' && busq.orden[busq.orden.length - 1] === '2026-09-01');

  // ══════════════ 9. SEGURIDAD ══════════════
  console.log('\n═══ 9. SEGURIDAD (PIN y cifrado de copias) ═══');
  const seg = await page.evaluate(async () => {
    await SEGURIDAD.establecerPIN('1234');
    const ok = await SEGURIDAD.verificarPIN('1234');
    const mal = await SEGURIDAD.verificarPIN('9999');
    const activo = SEGURIDAD.pinActivado();
    const guardadoEnClaro = JSON.stringify(localStorage).includes('"1234"');
    // Cifrado de la copia
    const cifrado = await SEGURIDAD.cifrarTexto('secreto contable', 'micontraseña');
    const descifrado = await SEGURIDAD.descifrarTexto(cifrado, 'micontraseña');
    let fallaConOtra = false;
    try { await SEGURIDAD.descifrarTexto(cifrado, 'otra'); } catch (e) { fallaConOtra = true; }
    SEGURIDAD.desactivarPIN();
    return { ok, mal, activo, guardadoEnClaro, textoCifrado: JSON.stringify(cifrado), descifrado, fallaConOtra };
  });
  chk('seguridad', 'El PIN correcto abre la app', seg.ok === true);
  chk('seguridad', 'El PIN incorrecto no abre', seg.mal === false);
  chk('seguridad', 'El PIN NO se guarda en claro en el dispositivo', !seg.guardadoEnClaro);
  chk('seguridad', 'La copia cifrada no contiene el texto legible', !seg.textoCifrado.includes('secreto contable'));
  chk('seguridad', 'La copia cifrada se recupera con su contraseña', seg.descifrado === 'secreto contable');
  chk('seguridad', 'Con otra contraseña la copia no se abre', seg.fallaConOtra);

  // ══════════════ 9b. PROTECCIONES FISCALES ══════════════
  console.log('\n═══ 9b. PROTECCIONES FISCALES (lo que va a la declaración) ═══');
  await limpiar();
  const fiscal = await page.evaluate(async () => {
    await DB.guardar({ tipo: 'factura', fecha: '2026-07-10', proveedor: 'Bebidas Pepe', total: 121, baseImponible: 100, ivaCuota: 21, categoria: 'Mercancía', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'factura', fecha: '2026-07-11', proveedor: 'Luz de mi casa', total: 80, baseImponible: 66.12, ivaCuota: 13.88, categoria: 'Luz', personal: true, creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'cierre', fecha: '2026-07-10', total: 500, proveedor: '', creado: new Date().toISOString() });
    const i = await INFORME.generar(2026, 3);
    const prev = INFORME.prevision(i, { ivaVentas: 10, ivaGastos: 21, irpfActivo: true, irpf: 20 });
    const est = await INFORME.estadisticas(null, null);
    return { csv: INFORME.generarCSV(i), html: INFORME.renderHTML(i), totalGastos: i.totalGastos, ivaSoportado: prev.ivaSoportado, excluidos: prev.personalesExcluidos, estNombres: est.map(e => e.nombre) };
  });
  chk('fiscal', 'Un gasto de casa NO se mezcla con los gastos del negocio (121, no 201)', cerca(fiscal.totalGastos, 121), 'obtenido ' + fiscal.totalGastos);
  chk('fiscal', 'Un gasto de casa SÍ va al CSV de la gestoría, en su apartado propio',
    fiscal.csv.includes('GASTOS PERSONALES') && fiscal.csv.includes('Luz de mi casa') && fiscal.csv.includes('TOTAL PERSONALES;;80,00'));
  chk('fiscal', 'Y en la impresión del informe, en su apartado propio',
    fiscal.html.includes('a valorar por la gestoría') && fiscal.html.includes('Luz de mi casa'));
  chk('fiscal', 'El resultado del trimestre no lo resta (es del negocio)', fiscal.csv.includes('RESULTADO DEL TRIMESTRE (negocio);;379,00'));
  chk('fiscal', 'Su IVA NO se descuenta en la previsión interna, por prudencia (21, no 34,88)', cerca(fiscal.ivaSoportado, 21), 'obtenido ' + fiscal.ivaSoportado);
  chk('fiscal', 'La previsión avisa de cuántos gastos de casa hay', fiscal.excluidos === 1);
  chk('fiscal', 'No entra en las estadísticas del negocio por proveedor', !fiscal.estNombres.includes('Luz de mi casa'));

  // Factura duplicada: aviso y, si se rechaza, no se guarda
  await page.click('.tab[data-tab="facturas"]');
  await page.click('#factura-manual');
  await page.waitForTimeout(300);
  await page.fill('#f-proveedor', 'Bebidas Pepe');
  await page.fill('#f-fecha', '2026-07-10');
  await page.fill('#f-total', '121');
  aceptarDialogos = false; ultimoDialogo = '';
  await page.click('#factura-guardar');
  await page.waitForTimeout(700);
  chk('fiscal', 'Avisa al guardar una factura duplicada (mismo proveedor, fecha y total)', /DOS VECES/.test(ultimoDialogo), ultimoDialogo.slice(0, 80));
  chk('fiscal', 'Si dices que no, la duplicada NO se guarda',
    await page.evaluate(async () => (await DB.todos()).filter(r => r.proveedor === 'Bebidas Pepe').length === 1));
  aceptarDialogos = true;
  await page.click('#factura-cancelar');

  // Desglose que no cuadra: aviso
  await page.click('#factura-manual');
  await page.waitForTimeout(300);
  await page.fill('#f-proveedor', 'Descuadre S.L.');
  await page.fill('#f-fecha', '2026-07-12');
  await page.fill('#f-total', '121');
  await page.fill('#f-base', '100');
  await page.fill('#f-ivacuota', '30');
  aceptarDialogos = false; ultimoDialogo = '';
  await page.click('#factura-guardar');
  await page.waitForTimeout(700);
  chk('fiscal', 'Avisa si base + IVA no cuadra con el total (100 + 30 ≠ 121)', /no cuadran/.test(ultimoDialogo), ultimoDialogo.slice(0, 80));
  aceptarDialogos = true;
  await page.click('#factura-cancelar');

  // Un desglose correcto con retención NO avisa (800 + 168 − 152 = 816)
  await page.click('#factura-manual');
  await page.waitForTimeout(300);
  await page.fill('#f-proveedor', 'Alquiler Local');
  await page.fill('#f-fecha', '2026-07-13');
  await page.fill('#f-total', '816');
  await page.fill('#f-base', '800');
  await page.fill('#f-ivacuota', '168');
  await page.fill('#f-retcuota', '152');
  ultimoDialogo = '';
  await page.click('#factura-guardar');
  await page.waitForTimeout(700);
  chk('fiscal', 'Un desglose correcto con retención se guarda sin avisos', ultimoDialogo === '' &&
    await page.evaluate(async () => (await DB.todos()).some(r => r.proveedor === 'Alquiler Local')));

  // ══════════════ 9c. FACTURACIÓN: CÓMO VA EL MES ══════════════
  console.log('\n═══ 9c. FACTURACIÓN (cómo va el mes) ═══');
  await limpiar();
  await page.evaluate(async () => {
    const hoy = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const mes = `${hoy.getFullYear()}-${p(hoy.getMonth() + 1)}`;
    const ant = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
    const mesAnt = `${ant.getFullYear()}-${p(ant.getMonth() + 1)}`;
    // Este mes: 4 días → 100, 900, 300, 200 (mejor el 2º, flojos 100/200/300)
    await DB.guardar({ tipo: 'cierre', fecha: `${mes}-01`, total: 100, proveedor: '', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'cierre', fecha: `${mes}-02`, total: 900, proveedor: '', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'cierre', fecha: `${mes}-03`, total: 300, proveedor: '', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'cierre', fecha: `${mes}-04`, total: 200, proveedor: '', creado: new Date().toISOString() });
    // Mes anterior: 2 días de 250 → media 250
    await DB.guardar({ tipo: 'cierre', fecha: `${mesAnt}-10`, total: 250, proveedor: '', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'cierre', fecha: `${mesAnt}-11`, total: 250, proveedor: '', creado: new Date().toISOString() });
  });
  await page.click('.tab[data-tab="cierres"]');
  await page.waitForTimeout(800);
  const fac = (await page.textContent('#fac-resumen')).replace(/\s+/g, ' ');
  chk('facturacion', 'La pestaña se llama Facturación', (await page.textContent('.tab[data-tab="cierres"]')).includes('Facturación'));
  chk('facturacion', 'Total del mes 1.500,00', /1\.?500,00/.test(fac), fac.slice(0, 120));
  chk('facturacion', 'Media por día 375,00', fac.includes('375,00'));
  chk('facturacion', '🥇 Mejor día con 900,00', /🥇 Mejor día.*900,00/.test(fac));
  chk('facturacion', '🔻 Días más flojos (100, 200, 300)', fac.includes('más flojos') && fac.includes('100,00') && fac.includes('200,00'));
  chk('facturacion', 'Compara con el mes anterior (media 250 → +50 %)', fac.includes('▲') && fac.includes('50'));
  chk('facturacion', 'Media por día de la semana', fac.includes('Media por día de la semana'));

  // ══════════════ 9d. CUADRO DE MANDO DEL NEGOCIO ══════════════
  console.log('\n═══ 9d. CUADRO DE MANDO (cómo va el negocio) ═══');
  await limpiar();
  await page.evaluate(async () => {
    localStorage.removeItem('contable-trimestre-guardado');
    const hoy = new Date(); const p = (n) => String(n).padStart(2, '0');
    const mes = `${hoy.getFullYear()}-${p(hoy.getMonth() + 1)}`;
    await DB.guardar({ tipo: 'cierre', fecha: `${mes}-01`, total: 1000, proveedor: '', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'cierre', fecha: `${mes}-02`, total: 2000, proveedor: '', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'factura', fecha: `${mes}-01`, proveedor: 'Bebidas Pepe', total: 700, categoria: 'Mercancía', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'factura', fecha: `${mes}-02`, proveedor: 'Endesa', total: 200, categoria: 'Luz', creado: new Date().toISOString() });
    await DB.guardar({ tipo: 'factura', fecha: `${mes}-02`, proveedor: 'Alquiler casa', total: 100, categoria: 'Alquiler', personal: true, creado: new Date().toISOString() });
    // Empleado: 2 días a 900/26 = 69,23 devengado
    await DB.perGuardar({ nombre: 'Juan', sueldoMensual: 900, diasMes: 26, horasJornada: 7.5, tramos: [], dias: [`${mes}-01`, `${mes}-02`], tardes: [], faltas: [], notasDias: [], creado: new Date().toISOString() });
  });
  await page.click('.tab[data-tab="informe"]');
  await page.waitForTimeout(900);
  let res = (await page.textContent('#res-contenido')).replace(/\s+/g, ' ');
  let al = (await page.textContent('#res-alertas')).replace(/\s+/g, ' ');
  chk('cuadro', 'Ingresos del mes 3.000,00', /3\.?000,00/.test(res), res.slice(0, 120));
  chk('cuadro', 'Gastos del negocio 900,00 (el de casa no se resta)', res.includes('−900,00'));
  chk('cuadro', 'Personal devengado 69,23', res.includes('69,23'));
  chk('cuadro', 'TE QUEDA 2.030,77 (3000 − 900 − 69,23)', /2\.?030,77/.test(res) && res.includes('TE QUEDA'));
  chk('cuadro', 'Margen 68 %', res.includes('margen 68 %'));
  chk('cuadro', 'Gasto de casa aparte (100,00)', res.includes('Gastos de casa') && res.includes('100,00'));
  chk('cuadro', 'Mercancía con su % sobre ventas (23%)', res.includes('Mercancía') && res.includes('23%'));
  chk('cuadro', 'Alerta de trimestre cerrado sin guardar', al.includes('trimestre'));
  chk('cuadro', 'Alerta de facturas sin desglose de IVA (2)', al.includes('2 facturas sin desglose de IVA'));
  await page.click('#res-tri-hecho');
  await page.waitForTimeout(600);
  al = (await page.textContent('#res-alertas')).replace(/\s+/g, ' ');
  chk('cuadro', '"Ya lo hice" quita el aviso del trimestre', !al.includes('trimestre'));
  await page.evaluate(() => localStorage.removeItem('contable-trimestre-guardado'));

  // ══════════════ 10. ERRORES DE JAVASCRIPT ══════════════
  console.log('\n═══ 10. ESTABILIDAD ═══');
  chk('estabilidad', 'Ningún error de JavaScript durante toda la verificación',
    erroresJS.length === 0, erroresJS.join(' | '));

  await limpiar();
  await browser.close();

  console.log('\n' + '═'.repeat(56));
  console.log(`RESULTADO: ${R.ok} comprobaciones correctas, ${R.fallos.length} fallos`);
  if (R.fallos.length) {
    console.log('\nFALLOS ENCONTRADOS:');
    R.fallos.forEach(f => console.log(`  [${f.area}] ${f.nombre}${f.detalle ? '\n      → ' + f.detalle : ''}`));
  }
  process.exit(R.fallos.length ? 1 : 0);
})();
