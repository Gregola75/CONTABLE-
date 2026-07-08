/* CONTABLE — lógica principal de la aplicación */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  let facturaPendiente = null; // { imagen: Blob, ocrTexto }
  let cierrePendiente = null;
  let provEditando = null; // proveedor en edición (o null si es alta nueva)
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

  /* ---------- Configuración de impuestos (previsión interna) ---------- */

  const CFG_DEFECTO = { ivaVentas: 21, ivaGastos: 21, irpfActivo: true, irpf: 20 };

  function leerConfig() {
    try {
      return { ...CFG_DEFECTO, ...JSON.parse(localStorage.getItem('contable-config') || '{}') };
    } catch { return { ...CFG_DEFECTO }; }
  }

  function guardarConfig(cfg) {
    localStorage.setItem('contable-config', JSON.stringify(cfg));
  }

  function pintarConfig() {
    const cfg = leerConfig();
    $('#cfg-iva-ventas').value = String(cfg.ivaVentas);
    $('#cfg-iva-gastos').value = String(cfg.ivaGastos);
    $('#cfg-irpf-activo').checked = cfg.irpfActivo;
    $('#cfg-irpf').value = cfg.irpf;
    $('#cfg-irpf-wrap').style.display = cfg.irpfActivo ? '' : 'none';
  }

  function actualizarConfig() {
    const cfg = {
      ivaVentas: +$('#cfg-iva-ventas').value,
      ivaGastos: +$('#cfg-iva-gastos').value,
      irpfActivo: $('#cfg-irpf-activo').checked,
      irpf: Math.max(0, Math.min(50, +$('#cfg-irpf').value || 0))
    };
    guardarConfig(cfg);
    $('#cfg-irpf-wrap').style.display = cfg.irpfActivo ? '' : 'none';
    toast('💾 Configuración de impuestos guardada.');
  }

  ['#cfg-iva-ventas', '#cfg-iva-gastos', '#cfg-irpf-activo', '#cfg-irpf'].forEach(sel => {
    $(sel).addEventListener('change', actualizarConfig);
  });

  /* ---------- Pestañas ---------- */

  $$('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab').forEach(b => b.classList.remove('active'));
      $$('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $('#tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'ajustes') { pintarStats(); pintarSeguridad(); }
      if (btn.dataset.tab === 'consultar') buscar();
    });
  });

  /* ---------- PDF: convertir la primera página en imagen ---------- */

  let pdfJsCargado = null;

  function cargarPdfJs() {
    if (!pdfJsCargado) {
      pdfJsCargado = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
        s.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
          resolve(window.pdfjsLib);
        };
        s.onerror = () => { pdfJsCargado = null; reject(new Error('No se pudo cargar el lector de PDF (¿sin conexión?).')); };
        document.head.appendChild(s);
      });
    }
    return pdfJsCargado;
  }

  /* Devuelve un Blob de imagen a partir del archivo: si es PDF,
     convierte la primera página; si ya es imagen, lo devuelve tal cual. */
  async function archivoAImagen(file) {
    const esPDF = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    if (!esPDF) return file;

    const pdfjs = await cargarPdfJs();
    const datos = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: datos }).promise;
    const pagina = await pdf.getPage(1);
    const viewport = pagina.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await pagina.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    if (pdf.numPages > 1) {
      toast(`ℹ️ El PDF tiene ${pdf.numPages} páginas; se usa la primera.`);
    }
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  /* ---------- PROVEEDORES: alta manual y reconocimiento ---------- */

  /* Normaliza un nombre para comparar: minúsculas, sin tildes ni signos. */
  function normalizarNombre(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9ñ ]+/gi, ' ')
      .replace(/\b(s\s?l\s?u?|s\s?a\s?u?|s\s?c|c\s?b|s\s?coop)\b/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /* Busca si un nombre/NIF corresponde a un proveedor dado de alta.
     Devuelve el proveedor o null. */
  async function reconocerProveedor(nombre, nif) {
    const lista = await DB.provTodos();
    const nifLimpio = String(nif || '').replace(/[\s\-\.]/g, '').toUpperCase();
    if (nifLimpio) {
      const porNif = lista.find(p => p.nif && p.nif.replace(/[\s\-\.]/g, '').toUpperCase() === nifLimpio);
      if (porNif) return porNif;
    }
    const n = normalizarNombre(nombre);
    if (n.length < 3) return null;
    return lista.find(p => {
      const pn = normalizarNombre(p.nombre);
      if (!pn) return false;
      return pn === n || (pn.length >= 4 && n.includes(pn)) || (n.length >= 4 && pn.includes(n));
    }) || null;
  }

  /* Pinta el aviso "reconocido / nuevo" bajo el campo proveedor. */
  async function actualizarEstadoProveedor() {
    const nombre = $('#f-proveedor').value.trim();
    const nif = $('#f-nif').value.trim();
    const estado = $('#f-prov-status');
    const wrap = $('#f-agregar-prov-wrap');

    if (!nombre) {
      estado.classList.add('hidden');
      wrap.classList.add('hidden');
      return;
    }
    const prov = await reconocerProveedor(nombre, nif);
    estado.classList.remove('hidden');
    if (prov) {
      estado.className = 'prov-status ok';
      estado.textContent = `✅ Proveedor reconocido: ${prov.nombre}`;
      wrap.classList.add('hidden');
      // Completar datos que falten con la ficha del proveedor
      if (!nif && prov.nif) $('#f-nif').value = prov.nif;
      if (prov.categoria) $('#f-categoria').value = prov.categoria;
      if (normalizarNombre(nombre) !== normalizarNombre(prov.nombre)) {
        $('#f-proveedor').value = prov.nombre;
      }
    } else {
      estado.className = 'prov-status nuevo';
      estado.textContent = '🆕 Proveedor nuevo: no está en tu lista.';
      wrap.classList.remove('hidden');
    }
  }

  $('#f-proveedor').addEventListener('change', actualizarEstadoProveedor);
  $('#f-nif').addEventListener('change', actualizarEstadoProveedor);

  function abrirFormProveedor(prov = null) {
    provEditando = prov;
    $('#p-nombre').value = prov ? prov.nombre : '';
    $('#p-nif').value = prov ? (prov.nif || '') : '';
    $('#p-categoria').value = prov ? (prov.categoria || 'Mercancía') : 'Mercancía';
    $('#prov-form').classList.remove('hidden');
    $('#p-nombre').focus();
  }

  $('#prov-nuevo').addEventListener('click', () => abrirFormProveedor());
  $('#prov-cancelar').addEventListener('click', () => {
    provEditando = null;
    $('#prov-form').classList.add('hidden');
  });

  $('#prov-guardar').addEventListener('click', async () => {
    const nombre = $('#p-nombre').value.trim();
    if (!nombre) { toast('⚠️ Pon el nombre del proveedor.'); return; }

    // Evitar duplicados (salvo que estemos editando ese mismo proveedor)
    const existente = await reconocerProveedor(nombre, $('#p-nif').value.trim());
    if (existente && (!provEditando || existente.id !== provEditando.id)) {
      toast(`⚠️ Ese proveedor ya existe en tu lista: ${existente.nombre}`);
      return;
    }

    await DB.provGuardar({
      ...(provEditando ? { id: provEditando.id, creado: provEditando.creado } : { creado: new Date().toISOString() }),
      nombre,
      nif: $('#p-nif').value.trim().toUpperCase(),
      categoria: $('#p-categoria').value
    });

    provEditando = null;
    $('#prov-form').classList.add('hidden');
    toast('💾 Proveedor guardado.');
    pintarProveedores();
    cargarProveedores();
  });

  async function pintarProveedores() {
    const lista = await DB.provTodos();
    const div = $('#prov-lista');
    if (!lista.length) {
      div.innerHTML = '<p class="vacio">Aún no tienes proveedores dados de alta.</p>';
      return;
    }
    div.innerHTML = lista.map(p => `
      <div class="item" data-pid="${p.id}">
        <div class="item-thumb placeholder">🏪</div>
        <div class="item-info">
          <div class="item-titulo">${escapar(p.nombre)}</div>
          <div class="item-sub">${escapar(p.nif || 'Sin NIF')} · ${escapar(p.categoria || '')}</div>
        </div>
        <button class="btn btn-small prov-borrar" data-pid="${p.id}" title="Eliminar">🗑️</button>
      </div>`).join('');

    div.querySelectorAll('.item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.prov-borrar')) return;
        const p = lista.find(x => x.id === +el.dataset.pid);
        if (p) abrirFormProveedor(p);
      });
    });
    div.querySelectorAll('.prov-borrar').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const p = lista.find(x => x.id === +btn.dataset.pid);
        if (p && confirm(`¿Eliminar "${p.nombre}" de tu lista de proveedores?\n(Las facturas ya guardadas no se tocan.)`)) {
          await DB.provBorrar(p.id);
          toast('🗑️ Proveedor eliminado.');
          pintarProveedores();
          cargarProveedores();
        }
      });
    });
  }

  /* Si el proveedor de la factura es nuevo y la casilla está marcada,
     se da de alta automáticamente. */
  async function altaProveedorSiNuevo(nombre, nif, categoria) {
    if (!nombre || nombre === 'Sin proveedor') return;
    if (!$('#f-agregar-prov').checked) return;
    const existente = await reconocerProveedor(nombre, nif);
    if (existente) return; // ya está dado de alta
    await DB.provGuardar({
      nombre, nif: (nif || '').toUpperCase(), categoria,
      creado: new Date().toISOString()
    });
    toast(`🏪 "${nombre}" añadido a tu lista de proveedores.`);
    pintarProveedores();
  }

  /* ---------- FACTURAS ---------- */

  async function procesarFactura(file) {
    if (!file) return;
    $('#factura-progress').classList.remove('hidden');
    $('#factura-form-card').classList.add('hidden');
    $('#factura-progress-text').textContent = 'Leyendo el documento… puede tardar unos segundos';

    try {
      file = await archivoAImagen(file);
    } catch (e) {
      console.error(e);
      $('#factura-progress').classList.add('hidden');
      toast('⚠️ ' + (e.message || 'No se pudo abrir el PDF.'));
      return;
    }

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
    $('#f-ivatipo').value = datos.ivaTipo != null ? String(datos.ivaTipo) : '';
    $('#f-ivacuota').value = datos.ivaCuota != null ? datos.ivaCuota : '';
    $('#f-base').value = datos.baseImponible != null ? datos.baseImponible : '';
    $('#f-rettipo').value = datos.retTipo != null && [19, 15, 7, 1].includes(datos.retTipo) ? String(datos.retTipo) : '';
    $('#f-retcuota').value = datos.retCuota != null ? datos.retCuota : '';
    $('#f-notas').value = '';
    $('#f-ocr-text').textContent = texto || '(no se detectó texto)';
    $('#factura-form-card').classList.remove('hidden');
    $('#factura-form-card').scrollIntoView({ behavior: 'smooth' });

    // Comprobar si el proveedor detectado ya está dado de alta
    await actualizarEstadoProveedor();

    if (datos.proveedor || datos.total != null) {
      toast('✅ Datos detectados. Revísalos antes de guardar.');
    } else {
      toast('No se detectaron datos claros. Rellénalos a mano, la foto se guardará igualmente.');
    }
  }

  $('#factura-camera').addEventListener('change', (e) => { procesarFactura(e.target.files[0]); e.target.value = ''; });
  $('#factura-file').addEventListener('change', (e) => { procesarFactura(e.target.files[0]); e.target.value = ''; });

  /* Autocálculo del IVA: al cambiar el total o el tipo, se recalculan
     la base y la cuota (sin pisar valores escritos a mano por el usuario). */
  function recalcularIVA(forzar = false) {
    const total = parseFloat($('#f-total').value);
    const tipo = parseFloat($('#f-ivatipo').value);
    if (isNaN(total) || total <= 0 || isNaN(tipo)) return;
    const cuotaVacia = $('#f-ivacuota').value === '';
    const baseVacia = $('#f-base').value === '';
    if (!forzar && !cuotaVacia && !baseVacia) return;
    const base = total / (1 + tipo / 100);
    if (forzar || baseVacia) $('#f-base').value = (Math.round(base * 100) / 100).toFixed(2);
    if (forzar || cuotaVacia) $('#f-ivacuota').value = (Math.round((total - base) * 100) / 100).toFixed(2);
  }

  $('#f-ivatipo').addEventListener('change', () => recalcularIVA(true));
  $('#f-total').addEventListener('change', () => recalcularIVA(false));

  /* Autocálculo de la retención: cuota = base imponible × tipo % */
  $('#f-rettipo').addEventListener('change', () => {
    const tipo = parseFloat($('#f-rettipo').value);
    const base = parseFloat($('#f-base').value);
    if (isNaN(tipo)) { $('#f-retcuota').value = ''; return; }
    if (!isNaN(base) && base > 0) {
      $('#f-retcuota').value = (Math.round(base * tipo) / 100).toFixed(2);
    }
  });

  $('#factura-guardar').addEventListener('click', async () => {
    const total = parseFloat($('#f-total').value);
    const fecha = $('#f-fecha').value;
    if (!fecha) { toast('⚠️ Falta la fecha.'); return; }
    if (isNaN(total) || total <= 0) { toast('⚠️ Pon el total de la factura.'); return; }

    const proveedor = $('#f-proveedor').value.trim() || 'Sin proveedor';
    const nif = $('#f-nif').value.trim();
    const categoria = $('#f-categoria').value;

    // Si es un proveedor nuevo y la casilla está marcada, darlo de alta
    await altaProveedorSiNuevo(proveedor, nif, categoria);

    const ivaCuota = parseFloat($('#f-ivacuota').value);
    const base = parseFloat($('#f-base').value);
    const tipoStr = $('#f-ivatipo').value;
    const retCuota = parseFloat($('#f-retcuota').value);
    const retTipoStr = $('#f-rettipo').value;

    await DB.guardar({
      tipo: 'factura',
      fecha,
      proveedor,
      nif,
      categoria,
      total: Math.round(total * 100) / 100,
      baseImponible: isNaN(base) ? null : Math.round(base * 100) / 100,
      ivaTipo: tipoStr === '' ? null : (tipoStr === 'varios' ? 'varios' : +tipoStr),
      ivaCuota: isNaN(ivaCuota) ? null : Math.round(ivaCuota * 100) / 100,
      retTipo: retTipoStr === '' ? null : +retTipoStr,
      retCuota: isNaN(retCuota) || retCuota <= 0 ? null : Math.round(retCuota * 100) / 100,
      notas: $('#f-notas').value.trim(),
      imagen: facturaPendiente ? facturaPendiente.imagen : null,
      ocrTexto: facturaPendiente ? facturaPendiente.ocrTexto : '',
      creado: new Date().toISOString()
    });

    facturaPendiente = null;
    $('#factura-form-card').classList.add('hidden');
    $('#f-prov-status').classList.add('hidden');
    $('#f-agregar-prov-wrap').classList.add('hidden');
    toast('💾 Factura guardada.');
    pintarRecientes();
    cargarProveedores();
  });

  $('#factura-cancelar').addEventListener('click', () => {
    facturaPendiente = null;
    $('#factura-form-card').classList.add('hidden');
    $('#f-prov-status').classList.add('hidden');
    $('#f-agregar-prov-wrap').classList.add('hidden');
  });

  /* ---------- CIERRES ---------- */

  async function procesarCierre(file) {
    $('#cierre-progress').classList.remove('hidden');
    $('#cierre-form-card').classList.add('hidden');

    if (file) {
      try {
        file = await archivoAImagen(file);
      } catch (e) {
        console.error(e);
        $('#cierre-progress').classList.add('hidden');
        toast('⚠️ ' + (e.message || 'No se pudo abrir el PDF.'));
        return;
      }
    }

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
    $('#c-alcance').value = 'dia';
    $('#c-fecha-wrap').classList.remove('hidden');
    $('#c-mes-wrap').classList.add('hidden');
    $('#c-fecha').value = datos.fecha || hoyISO();
    $('#c-mes').value = hoyISO().slice(0, 7);
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

  /* Cambiar entre cierre de un día y total de un mes completo */
  $('#c-alcance').addEventListener('change', () => {
    const esMes = $('#c-alcance').value === 'mes';
    $('#c-fecha-wrap').classList.toggle('hidden', esMes);
    $('#c-mes-wrap').classList.toggle('hidden', !esMes);
  });

  $('#cierre-guardar').addEventListener('click', async () => {
    const total = parseFloat($('#c-total').value);
    const esMes = $('#c-alcance').value === 'mes';
    if (isNaN(total) || total < 0) { toast('⚠️ Pon el total de ventas.'); return; }

    let fecha;
    if (esMes) {
      const mes = $('#c-mes').value; // YYYY-MM
      if (!mes) { toast('⚠️ Elige el mes.'); return; }
      fecha = mes + '-01';

      // Avisos para no contar ingresos dos veces
      const delMes = await DB.buscar({ tipo: 'cierre', desde: mes + '-01', hasta: mes + '-31' });
      const yaMensual = delMes.find(r => r.mensual);
      if (yaMensual && !confirm('Ya hay un total mensual guardado para ese mes. ¿Guardar otro de todas formas?')) return;
      const diarios = delMes.filter(r => !r.mensual);
      if (diarios.length && !confirm(`⚠️ Ese mes ya tiene ${diarios.length} cierres diarios guardados. Si añades también el total del mes, los ingresos se contarían DOS VECES en el informe. ¿Seguro que quieres guardarlo?`)) return;
    } else {
      fecha = $('#c-fecha').value;
      if (!fecha) { toast('⚠️ Falta la fecha.'); return; }

      // Avisar si ya hay un cierre para esa fecha
      const existentes = await DB.buscar({ tipo: 'cierre', desde: fecha, hasta: fecha });
      if (existentes.length && !confirm(`Ya hay un cierre guardado para el ${fmtFecha(fecha)}. ¿Guardar otro de todas formas?`)) {
        return;
      }
    }

    const efectivo = parseFloat($('#c-efectivo').value);
    const tarjeta = parseFloat($('#c-tarjeta').value);

    await DB.guardar({
      tipo: 'cierre',
      fecha,
      mensual: esMes,
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

  function mesEnLetras(fechaISO) {
    return INFORME.MESES[parseInt(fechaISO.slice(5, 7), 10) - 1] + ' ' + fechaISO.slice(0, 4);
  }

  function itemHTML(r) {
    const esFactura = r.tipo === 'factura';
    const titulo = esFactura ? (r.proveedor || 'Sin proveedor') : (r.mensual ? 'Ventas del mes' : 'Cierre de caja');
    const sub = r.mensual
      ? mesEnLetras(r.fecha) + ' · mes completo'
      : fmtFecha(r.fecha) + (esFactura && r.categoria ? ' · ' + r.categoria : '');
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
      ['Tipo', esFactura ? 'Factura (gasto)' : (r.mensual ? 'Ventas de un mes completo (ingreso)' : 'Cierre de caja (ingreso)')],
      r.mensual ? ['Mes', mesEnLetras(r.fecha)] : ['Fecha', fmtFecha(r.fecha)],
      esFactura ? ['Proveedor', r.proveedor || '—'] : null,
      esFactura && r.nif ? ['NIF/CIF', r.nif] : null,
      esFactura ? ['Categoría', r.categoria || '—'] : null,
      ['Total', INFORME.eur(r.total)],
      esFactura && typeof r.baseImponible === 'number' ? ['Base imponible', INFORME.eur(r.baseImponible)] : null,
      esFactura && r.ivaTipo != null ? ['Tipo IVA', r.ivaTipo === 'varios' ? 'Varios tipos' : r.ivaTipo + ' %'] : null,
      esFactura && typeof r.ivaCuota === 'number' ? ['Cuota IVA', INFORME.eur(r.ivaCuota)] : null,
      esFactura && typeof r.retCuota === 'number' ? ['Retención IRPF' + (r.retTipo ? ` (${r.retTipo} %)` : ''), INFORME.eur(r.retCuota)] : null,
      !esFactura && r.efectivo != null ? ['Efectivo', INFORME.eur(r.efectivo)] : null,
      !esFactura && r.tarjeta != null ? ['Tarjeta', INFORME.eur(r.tarjeta)] : null,
      r.notas ? ['Notas', r.notas] : null,
      ['Registrado', r.creado ? new Date(r.creado).toLocaleString('es-ES') : '—']
    ].filter(Boolean);

    $('#modal-body').innerHTML = `
      <h2 style="margin-bottom:8px">${esFactura ? '📄 ' + escapar(r.proveedor || 'Factura') : '💰 ' + (r.mensual ? 'Ventas de ' + mesEnLetras(r.fecha) : 'Cierre ' + fmtFecha(r.fecha))}</h2>
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

    // Previsión interna de impuestos (no va en el CSV ni en la impresión)
    const cfg = leerConfig();
    const prev = INFORME.prevision(informeActual, cfg);
    $('#prevision-contenido').innerHTML = INFORME.renderPrevisionHTML(prev, cfg);
    $('#prevision-card').classList.remove('hidden');

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
    const contrasena = prompt(
      'Contraseña para proteger la copia (recomendado).\n' +
      'Déjalo vacío para guardarla sin contraseña:');
    if (contrasena === null) return;

    toast('Preparando copia de seguridad…');
    const datos = await DB.exportarTodo();
    let contenido;
    if (contrasena.trim()) {
      const cifrado = await SEGURIDAD.cifrarTexto(JSON.stringify(datos), contrasena.trim());
      contenido = JSON.stringify(cifrado);
    } else {
      contenido = JSON.stringify(datos);
    }
    const blob = new Blob([contenido], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `contable_copia_${hoyISO()}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast(contrasena.trim()
      ? '⬇️ Copia cifrada descargada. Recuerda la contraseña: sin ella no se puede abrir.'
      : '⬇️ Copia descargada SIN contraseña. Guárdala en un lugar seguro.');
  });

  $('#backup-importar').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm('Se añadirán los registros de la copia a los actuales. ¿Continuar?')) return;
    try {
      const texto = await file.text();
      let datos = JSON.parse(texto);
      if (datos && datos.cifrado) {
        const contrasena = prompt('Esta copia está protegida. Introduce su contraseña:');
        if (contrasena === null) return;
        datos = JSON.parse(await SEGURIDAD.descifrarTexto(datos, contrasena.trim()));
      }
      const n = await DB.importarTodo(datos);
      toast(`✅ Copia restaurada: ${n} registros añadidos.`);
      pintarRecientes();
      pintarStats();
      cargarProveedores();
    } catch (err) {
      console.error(err);
      toast('⚠️ ' + (err.message || 'No se pudo restaurar la copia.'));
    }
  });

  /* ---------- SEGURIDAD: PIN de acceso ---------- */

  let intentosFallidos = 0;
  let ocultadoDesde = null;
  const BLOQUEO_TRAS_MS = 60 * 1000; // volver a pedir PIN tras 1 min en segundo plano

  function mostrarBloqueo() {
    if (!SEGURIDAD.pinActivado()) return;
    $('#lock-screen').classList.remove('hidden');
    $('#lock-pin').value = '';
    $('#lock-error').classList.add('hidden');
    const conHuella = SEGURIDAD.biometriaActivada();
    $('#lock-huella').classList.toggle('hidden', !conHuella);
    if (conHuella) {
      // Ofrecer la huella directamente al abrir
      setTimeout(intentarHuella, 250);
    } else {
      setTimeout(() => $('#lock-pin').focus(), 100);
    }
  }

  async function intentarHuella() {
    if (!SEGURIDAD.biometriaActivada()) return;
    const ok = await SEGURIDAD.verificarBiometria();
    if (ok) {
      intentosFallidos = 0;
      $('#lock-screen').classList.add('hidden');
    } else {
      $('#lock-error').textContent = 'No se pudo verificar la huella. Usa el PIN o inténtalo de nuevo.';
      $('#lock-error').classList.remove('hidden');
    }
  }

  $('#lock-huella').addEventListener('click', intentarHuella);

  async function intentarDesbloquear() {
    const pin = $('#lock-pin').value.trim();
    if (!pin) return;
    if (intentosFallidos >= 5) {
      $('#lock-error').textContent = 'Demasiados intentos. Espera 30 segundos.';
      $('#lock-error').classList.remove('hidden');
      return;
    }
    const ok = await SEGURIDAD.verificarPIN(pin);
    if (ok) {
      intentosFallidos = 0;
      $('#lock-screen').classList.add('hidden');
    } else {
      intentosFallidos++;
      $('#lock-pin').value = '';
      $('#lock-error').textContent = `PIN incorrecto (intento ${intentosFallidos} de 5).`;
      $('#lock-error').classList.remove('hidden');
      if (intentosFallidos >= 5) {
        setTimeout(() => { intentosFallidos = 0; }, 30000);
      }
    }
  }

  $('#lock-entrar').addEventListener('click', intentarDesbloquear);
  $('#lock-pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') intentarDesbloquear(); });

  $('#lock-olvido').addEventListener('click', () => {
    const seguro = confirm(
      'Sin el PIN no se puede entrar.\n\n' +
      'La única salida es BORRAR TODOS los datos de la app en este dispositivo ' +
      'y empezar de cero (luego podrías restaurar una copia de seguridad si la tienes).\n\n' +
      '¿Quieres borrar todos los datos?');
    if (!seguro) return;
    if (!confirm('⚠️ ÚLTIMA CONFIRMACIÓN: se borrarán todas las facturas, cierres y proveedores de este dispositivo. ¿Continuar?')) return;
    indexedDB.deleteDatabase('contable-db');
    localStorage.clear();
    location.reload();
  });

  /* Pedir un PIN nuevo con confirmación. Devuelve el PIN o null. */
  function pedirPINNuevo() {
    const pin = prompt('Elige un PIN de 4 a 8 dígitos:');
    if (pin === null) return null;
    if (!/^\d{4,8}$/.test(pin)) { alert('El PIN debe tener entre 4 y 8 dígitos (solo números).'); return null; }
    const repite = prompt('Repite el PIN para confirmar:');
    if (repite !== pin) { alert('Los PIN no coinciden. Inténtalo de nuevo.'); return null; }
    return pin;
  }

  async function exigirPINActual() {
    const actual = prompt('Introduce tu PIN actual:');
    if (actual === null) return false;
    if (!(await SEGURIDAD.verificarPIN(actual.trim()))) { alert('PIN incorrecto.'); return false; }
    return true;
  }

  async function pintarSeguridad() {
    const activo = SEGURIDAD.pinActivado();
    const bio = SEGURIDAD.biometriaActivada();
    $('#sec-estado').innerHTML = activo
      ? `<span>Estado</span><strong class="txt-ok">🔒 PIN activado${bio ? ' + huella' : ''}</strong>`
      : '<span>Estado</span><strong class="txt-bad">🔓 Sin PIN — cualquiera con tu teléfono puede entrar</strong>';
    $('#sec-activar').classList.toggle('hidden', activo);
    $('#sec-cambiar').classList.toggle('hidden', !activo);
    $('#sec-desactivar').classList.toggle('hidden', !activo);
    $('#sec-bloquear').classList.toggle('hidden', !activo);

    const disponible = activo && await SEGURIDAD.biometriaDisponible();
    $('#sec-huella-on').classList.toggle('hidden', !(disponible && !bio));
    $('#sec-huella-off').classList.toggle('hidden', !(activo && bio));
  }

  $('#sec-huella-on').addEventListener('click', async () => {
    try {
      await SEGURIDAD.activarBiometria();
      pintarSeguridad();
      toast('👆 Huella activada. Podrás entrar con la huella o con el PIN.');
    } catch (e) {
      console.error(e);
      toast('⚠️ No se pudo activar la huella. Comprueba que el teléfono la tiene configurada.');
    }
  });

  $('#sec-huella-off').addEventListener('click', async () => {
    if (!(await exigirPINActual())) return;
    SEGURIDAD.desactivarBiometria();
    pintarSeguridad();
    toast('Huella desactivada. Solo se pedirá el PIN.');
  });

  $('#sec-activar').addEventListener('click', async () => {
    const pin = pedirPINNuevo();
    if (!pin) return;
    await SEGURIDAD.establecerPIN(pin);
    pintarSeguridad();
    toast('🔒 PIN activado. Se pedirá al abrir la app.');
    alert('PIN activado.\n\nIMPORTANTE: memorízalo bien. Si lo olvidas, la única salida es borrar los datos y restaurar una copia de seguridad.');
  });

  $('#sec-cambiar').addEventListener('click', async () => {
    if (!(await exigirPINActual())) return;
    const pin = pedirPINNuevo();
    if (!pin) return;
    await SEGURIDAD.establecerPIN(pin);
    toast('✏️ PIN cambiado.');
  });

  $('#sec-desactivar').addEventListener('click', async () => {
    if (!(await exigirPINActual())) return;
    SEGURIDAD.desactivarPIN();
    SEGURIDAD.desactivarBiometria();
    pintarSeguridad();
    toast('🔓 PIN desactivado.');
  });

  $('#sec-bloquear').addEventListener('click', mostrarBloqueo);

  /* Bloquear al volver tras un rato en segundo plano */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      ocultadoDesde = Date.now();
    } else if (ocultadoDesde && Date.now() - ocultadoDesde > BLOQUEO_TRAS_MS) {
      mostrarBloqueo();
      ocultadoDesde = null;
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

  mostrarBloqueo(); // si hay PIN, la app arranca bloqueada
  iniciarSelectorAnio();
  pintarConfig();
  pintarSeguridad();
  pintarRecientes();
  pintarProveedores();
  cargarProveedores();
})();
