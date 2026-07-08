/* CONTABLE — lógica principal de la aplicación */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  let facturaPendiente = null; // { imagen: Blob, ocrTexto }
  let cierrePendiente = null;
  let informeActual = null;
  let vistaFotos = false;
  let ultimosResultados = [];

  /* ---------- Utilidades ---------- */

  function hoyISO() {
    const f = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`;
  }

  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  function urlImagen(blob) {
    return blob instanceof Blob ? URL.createObjectURL(blob) : null;
  }

  function fmtFecha(iso) {
    return INFORME.formatear(iso);
  }

  /* ---------- Pestañas ---------- */

  $$('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab').forEach(b => b.classList.remove('active'));
      $$('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $('#tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'ajustes') pintarStats();
      if (btn.dataset.tab === 'consultar') buscar();
    });
  });

  /* ---------- FACTURAS ---------- */

  async function procesarFactura(file) {
    if (!file) return;
    $('#factura-progress').classList.remove('hidden');
    $('#factura-form-card').classList.add('hidden');
    $('#factura-progress-text').textContent = 'Leyendo la imagen… puede tardar unos segundos';

    let texto = '';
    try {
      texto = await OCR.leerImagen(file, (p) => {
        $('#factura-progress-text').textContent = `Leyendo la imagen… ${p}%`;
      });
    } catch (e) {
      console.error(e);
      toast('⚠️ No se pudo leer la imagen automáticamente. Rellena los datos a mano.');
    }
    $('#factura-progress').classList.add('hidden');

    const conocidos = await DB.proveedores();
    const datos = OCR.analizarFactura(texto, conocidos);

    facturaPendiente = { imagen: file, ocrTexto: texto };
    $('#factura-preview').src = urlImagen(file);
    $('#f-proveedor').value = datos.proveedor || '';
    $('#f-nif').value = datos.nif || '';
    $('#f-fecha').value = datos.fecha || hoyISO();
    $('#f-total').value = datos.total != null ? datos.total : '';
    $('#f-notas').value = '';
    $('#f-ocr-text').textContent = texto || '(no se detectó texto)';
    $('#factura-form-card').classList.remove('hidden');
    $('#factura-form-card').scrollIntoView({ behavior: 'smooth' });

    if (datos.proveedor || datos.total != null) {
      toast('✅ Datos detectados. Revísalos antes de guardar.');
    } else {
      toast('No se detectaron datos claros. Rellénalos a mano, la foto se guardará igualmente.');
    }
  }

  $('#factura-camera').addEventListener('change', (e) => { procesarFactura(e.target.files[0]); e.target.value = ''; });
  $('#factura-file').addEventListener('change', (e) => { procesarFactura(e.target.files[0]); e.target.value = ''; });

  $('#factura-guardar').addEventListener('click', async () => {
    const total = parseFloat($('#f-total').value);
    const fecha = $('#f-fecha').value;
    if (!fecha) { toast('⚠️ Falta la fecha.'); return; }
    if (isNaN(total) || total <= 0) { toast('⚠️ Pon el total de la factura.'); return; }

    await DB.guardar({
      tipo: 'factura',
      fecha,
      proveedor: $('#f-proveedor').value.trim() || 'Sin proveedor',
      nif: $('#f-nif').value.trim(),
      categoria: $('#f-categoria').value,
      total: Math.round(total * 100) / 100,
      notas: $('#f-notas').value.trim(),
      imagen: facturaPendiente ? facturaPendiente.imagen : null,
      ocrTexto: facturaPendiente ? facturaPendiente.ocrTexto : '',
      creado: new Date().toISOString()
    });

    facturaPendiente = null;
    $('#factura-form-card').classList.add('hidden');
    toast('💾 Factura guardada.');
    pintarRecientes();
    cargarProveedores();
  });

  $('#factura-cancelar').addEventListener('click', () => {
    facturaPendiente = null;
    $('#factura-form-card').classList.add('hidden');
  });

  /* ---------- CIERRES ---------- */

  async function procesarCierre(file) {
    $('#cierre-progress').classList.remove('hidden');
    $('#cierre-form-card').classList.add('hidden');

    let texto = '';
    if (file) {
      try {
        texto = await OCR.leerImagen(file, (p) => {
          $('#cierre-progress-text').textContent = `Leyendo la imagen… ${p}%`;
        });
      } catch (e) {
        console.error(e);
        toast('⚠️ No se pudo leer la imagen. Rellena los datos a mano.');
      }
    }
    $('#cierre-progress').classList.add('hidden');

    const datos = file ? OCR.analizarCierre(texto) : {};
    cierrePendiente = { imagen: file || null, ocrTexto: texto };

    if (file) {
      $('#cierre-preview').src = urlImagen(file);
      $('#cierre-preview').classList.remove('hidden');
    } else {
      $('#cierre-preview').classList.add('hidden');
    }
    $('#c-fecha').value = datos.fecha || hoyISO();
    $('#c-total').value = datos.total != null ? datos.total : '';
    $('#c-efectivo').value = datos.efectivo != null ? datos.efectivo : '';
    $('#c-tarjeta').value = datos.tarjeta != null ? datos.tarjeta : '';
    $('#c-notas').value = '';
    $('#c-ocr-text').textContent = texto || '(sin foto)';
    $('#cierre-form-card').classList.remove('hidden');
    $('#cierre-form-card').scrollIntoView({ behavior: 'smooth' });

    if (file && datos.total != null) toast('✅ Total detectado. Revísalo antes de guardar.');
  }

  $('#cierre-camera').addEventListener('change', (e) => { procesarCierre(e.target.files[0]); e.target.value = ''; });
  $('#cierre-file').addEventListener('change', (e) => { procesarCierre(e.target.files[0]); e.target.value = ''; });
  $('#cierre-manual').addEventListener('click', () => procesarCierre(null));

  $('#cierre-guardar').addEventListener('click', async () => {
    const total = parseFloat($('#c-total').value);
    const fecha = $('#c-fecha').value;
    if (!fecha) { toast('⚠️ Falta la fecha.'); return; }
    if (isNaN(total) || total < 0) { toast('⚠️ Pon el total de ventas del día.'); return; }

    // Avisar si ya hay un cierre para esa fecha
    const existentes = await DB.buscar({ tipo: 'cierre', desde: fecha, hasta: fecha });
    if (existentes.length && !confirm(`Ya hay un cierre guardado para el ${fmtFecha(fecha)}. ¿Guardar otro de todas formas?`)) {
      return;
    }

    const efectivo = parseFloat($('#c-efectivo').value);
    const tarjeta = parseFloat($('#c-tarjeta').value);

    await DB.guardar({
      tipo: 'cierre',
      fecha,
      proveedor: '',
      total: Math.round(total * 100) / 100,
      efectivo: isNaN(efectivo) ? null : Math.round(efectivo * 100) / 100,
      tarjeta: isNaN(tarjeta) ? null : Math.round(tarjeta * 100) / 100,
      notas: $('#c-notas').value.trim(),
      imagen: cierrePendiente ? cierrePendiente.imagen : null,
      ocrTexto: cierrePendiente ? cierrePendiente.ocrTexto : '',
      creado: new Date().toISOString()
    });

    cierrePendiente = null;
    $('#cierre-form-card').classList.add('hidden');
    toast('💾 Cierre guardado.');
    pintarRecientes();
  });

  $('#cierre-cancelar').addEventListener('click', () => {
    cierrePendiente = null;
    $('#cierre-form-card').classList.add('hidden');
  });

  /* ---------- Listas y detalle ---------- */

  function itemHTML(r) {
    const esFactura = r.tipo === 'factura';
    const titulo = esFactura ? (r.proveedor || 'Sin proveedor') : 'Cierre de caja';
    const sub = fmtFecha(r.fecha) + (esFactura && r.categoria ? ' · ' + r.categoria : '');
    return `
      <div class="item" data-id="${r.id}">
        ${r._thumb
          ? `<img class="item-thumb" src="${r._thumb}" alt="">`
          : `<div class="item-thumb placeholder">${esFactura ? '📄' : '💰'}</div>`}
        <div class="item-info">
          <div class="item-titulo">${escapar(titulo)}</div>
          <div class="item-sub">${sub}</div>
        </div>
        <div class="item-monto ${esFactura ? 'gasto' : 'ingreso'}">${esFactura ? '−' : '+'}${INFORME.eur(r.total)}</div>
      </div>`;
  }

  function prepararThumbs(lista) {
    lista.forEach(r => { r._thumb = r.imagen instanceof Blob ? URL.createObjectURL(r.imagen) : null; });
  }

  function conectarDetalle(contenedor, lista) {
    contenedor.querySelectorAll('.item, .foto').forEach(el => {
      el.addEventListener('click', () => {
        const r = lista.find(x => x.id === +el.dataset.id);
        if (r) abrirDetalle(r);
      });
    });
  }

  async function pintarRecientes() {
    const facturas = (await DB.buscar({ tipo: 'factura' })).slice(0, 5);
    const cierres = (await DB.buscar({ tipo: 'cierre' })).slice(0, 5);
    prepararThumbs(facturas);
    prepararThumbs(cierres);

    const fDiv = $('#facturas-recientes');
    fDiv.innerHTML = facturas.length ? facturas.map(itemHTML).join('') : '<p class="vacio">Aún no hay facturas guardadas.</p>';
    conectarDetalle(fDiv, facturas);

    const cDiv = $('#cierres-recientes');
    cDiv.innerHTML = cierres.length ? cierres.map(itemHTML).join('') : '<p class="vacio">Aún no hay cierres guardados.</p>';
    conectarDetalle(cDiv, cierres);
  }

  function abrirDetalle(r) {
    const esFactura = r.tipo === 'factura';
    const img = r.imagen instanceof Blob ? URL.createObjectURL(r.imagen) : null;
    const lineas = [
      ['Tipo', esFactura ? 'Factura (gasto)' : 'Cierre de caja (ingreso)'],
      ['Fecha', fmtFecha(r.fecha)],
      esFactura ? ['Proveedor', r.proveedor || '—'] : null,
      esFactura && r.nif ? ['NIF/CIF', r.nif] : null,
      esFactura ? ['Categoría', r.categoria || '—'] : null,
      ['Total', INFORME.eur(r.total)],
      !esFactura && r.efectivo != null ? ['Efectivo', INFORME.eur(r.efectivo)] : null,
      !esFactura && r.tarjeta != null ? ['Tarjeta', INFORME.eur(r.tarjeta)] : null,
      r.notas ? ['Notas', r.notas] : null,
      ['Registrado', r.creado ? new Date(r.creado).toLocaleString('es-ES') : '—']
    ].filter(Boolean);

    $('#modal-body').innerHTML = `
      <h2 style="color:#1a5c3a;margin-bottom:8px">${esFactura ? '📄 ' + escapar(r.proveedor || 'Factura') : '💰 Cierre ' + fmtFecha(r.fecha)}</h2>
      ${img ? `<img class="modal-img" src="${img}" alt="Imagen del documento">` : ''}
      ${lineas.map(([k, v]) => `<div class="detalle-linea"><span class="etiqueta">${k}</span><span>${escapar(String(v))}</span></div>`).join('')}
      <div class="form-actions">
        <button class="btn btn-danger" id="detalle-borrar">🗑️ Eliminar este registro</button>
      </div>`;

    $('#modal').classList.remove('hidden');

    $('#detalle-borrar').addEventListener('click', async () => {
      if (confirm('¿Seguro que quieres eliminar este registro? No se puede deshacer.')) {
        await DB.borrar(r.id);
        cerrarModal();
        toast('🗑️ Registro eliminado.');
        pintarRecientes();
        buscar();
      }
    });
  }

  function cerrarModal() { $('#modal').classList.add('hidden'); }
  $('#modal-cerrar').addEventListener('click', cerrarModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') cerrarModal(); });

  /* ---------- CONSULTAR ---------- */

  async function buscar() {
    const filtros = {
      tipo: $('#q-tipo').value,
      proveedor: $('#q-proveedor').value.trim(),
      desde: $('#q-desde').value,
      hasta: $('#q-hasta').value
    };
    ultimosResultados = await DB.buscar(filtros);
    prepararThumbs(ultimosResultados);

    const gastos = ultimosResultados.filter(r => r.tipo === 'factura').reduce((s, r) => s + (r.total || 0), 0);
    const ingresos = ultimosResultados.filter(r => r.tipo === 'cierre').reduce((s, r) => s + (r.total || 0), 0);
    $('#q-resumen').innerHTML = ultimosResultados.length
      ? `${ultimosResultados.length} registros · Ingresos: <strong class="ingreso">${INFORME.eur(ingresos)}</strong> · Gastos: <strong class="gasto">${INFORME.eur(gastos)}</strong>`
      : 'Sin resultados con esos filtros.';

    const div = $('#q-resultados');
    if (!ultimosResultados.length) { div.innerHTML = ''; return; }

    if (vistaFotos) {
      div.className = 'galeria';
      div.innerHTML = ultimosResultados.map(r => `
        <div class="foto" data-id="${r.id}">
          ${r._thumb
            ? `<img src="${r._thumb}" alt="">`
            : `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:2rem">${r.tipo === 'factura' ? '📄' : '💰'}</div>`}
          <div class="pie">${escapar(r.tipo === 'factura' ? (r.proveedor || 'Factura') : 'Cierre')}<br>${fmtFecha(r.fecha)} · ${INFORME.eur(r.total)}</div>
        </div>`).join('');
    } else {
      div.className = 'lista';
      div.innerHTML = ultimosResultados.map(itemHTML).join('');
    }
    conectarDetalle(div, ultimosResultados);
  }

  $('#q-buscar').addEventListener('click', buscar);
  $('#q-limpiar').addEventListener('click', () => {
    $('#q-tipo').value = 'todos';
    $('#q-proveedor').value = '';
    $('#q-desde').value = '';
    $('#q-hasta').value = '';
    buscar();
  });
  $('#vista-lista').addEventListener('click', () => {
    vistaFotos = false;
    $('#vista-lista').classList.add('active');
    $('#vista-fotos').classList.remove('active');
    buscar();
  });
  $('#vista-fotos').addEventListener('click', () => {
    vistaFotos = true;
    $('#vista-fotos').classList.add('active');
    $('#vista-lista').classList.remove('active');
    buscar();
  });

  /* ---------- INFORME ---------- */

  function iniciarSelectorAnio() {
    const sel = $('#i-anio');
    const actual = new Date().getFullYear();
    for (let a = actual; a >= actual - 4; a--) {
      const op = document.createElement('option');
      op.value = a;
      op.textContent = a;
      sel.appendChild(op);
    }
    // Trimestre actual por defecto
    $('#i-trimestre').value = String(Math.floor(new Date().getMonth() / 3) + 1);
  }

  $('#i-generar').addEventListener('click', async () => {
    const anio = +$('#i-anio').value;
    const trimestre = +$('#i-trimestre').value;
    informeActual = await INFORME.generar(anio, trimestre);
    $('#informe-contenido').innerHTML = INFORME.renderHTML(informeActual);
    $('#informe-resultado').classList.remove('hidden');
    $('#informe-resultado').scrollIntoView({ behavior: 'smooth' });
  });

  $('#i-descargar-csv').addEventListener('click', () => {
    if (informeActual) INFORME.descargarCSV(informeActual);
  });

  $('#i-imprimir').addEventListener('click', () => window.print());

  /* ---------- AJUSTES ---------- */

  async function pintarStats() {
    const lista = await DB.todos();
    const facturas = lista.filter(r => r.tipo === 'factura');
    const cierres = lista.filter(r => r.tipo === 'cierre');
    const conFoto = lista.filter(r => r.imagen instanceof Blob).length;
    $('#ajustes-stats').innerHTML = `
      <div class="stat-linea"><span>Facturas guardadas</span><strong>${facturas.length}</strong></div>
      <div class="stat-linea"><span>Cierres guardados</span><strong>${cierres.length}</strong></div>
      <div class="stat-linea"><span>Registros con foto</span><strong>${conFoto}</strong></div>`;
  }

  $('#backup-exportar').addEventListener('click', async () => {
    toast('Preparando copia de seguridad…');
    const datos = await DB.exportarTodo();
    const blob = new Blob([JSON.stringify(datos)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `contable_copia_${hoyISO()}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('⬇️ Copia de seguridad descargada. Guárdala en un lugar seguro.');
  });

  $('#backup-importar').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm('Se añadirán los registros de la copia a los actuales. ¿Continuar?')) return;
    try {
      const texto = await file.text();
      const n = await DB.importarTodo(JSON.parse(texto));
      toast(`✅ Copia restaurada: ${n} registros añadidos.`);
      pintarRecientes();
      pintarStats();
      cargarProveedores();
    } catch (err) {
      console.error(err);
      toast('⚠️ ' + (err.message || 'No se pudo restaurar la copia.'));
    }
  });

  /* ---------- Comunes ---------- */

  async function cargarProveedores() {
    const lista = await DB.proveedores();
    $('#proveedores-list').innerHTML = lista.map(p => `<option value="${escapar(p)}">`).join('');
  }

  function escapar(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------- Arranque ---------- */

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  iniciarSelectorAnio();
  pintarRecientes();
  cargarProveedores();
})();
