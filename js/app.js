/* CONTABLE — lógica principal de la aplicación */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  let facturaPendiente = null; // { imagen: Blob, ocrTexto }
  let cierrePendiente = null;
  let provEditando = null; // proveedor en edición (o null si es alta nueva)
  let registroEditando = null; // factura/cierre guardado que se está corrigiendo
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
      if (btn.dataset.tab === 'ajustes') { pintarStats(); pintarSeguridad(); pintarNube(); }
      if (btn.dataset.tab === 'consultar') buscar();
      if (btn.dataset.tab === 'personal') pintarPersonal();
      if (btn.dataset.tab === 'cierres') pintarFacturacion();
      if (btn.dataset.tab === 'informe') pintarResumen();
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
    // Resolución alta (hasta ~2600 px) para que al ampliar la imagen
    // se lea bien la letra pequeña del desglose de IVA
    const base = pagina.getViewport({ scale: 1 });
    const escala = Math.max(2, Math.min(3, 2600 / Math.max(base.width, base.height)));
    const viewport = pagina.getViewport({ scale: escala });
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
      estado.textContent = `✅ Proveedor reconocido: ${prov.nombre}${prov.quien ? ` (${prov.quien})` : ''}`;
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
    $('#p-quien').value = prov ? (prov.quien || '') : '';
    $('#p-telefono').value = prov ? (prov.telefono || '') : '';
    $('#p-email').value = prov ? (prov.email || '') : '';
    $('#p-direccion').value = prov ? (prov.direccion || '') : '';
    $('#prov-form').classList.remove('hidden');
    $('#p-nombre').focus();
  }

  /* Comprobación ligera del formato de NIF/CIF español. */
  function formatoNIFValido(nif) {
    const limpio = nif.replace(/[\s\-\.]/g, '').toUpperCase();
    return /^[A-Z]\d{7}[0-9A-J]$/.test(limpio) || /^\d{8}[A-Z]$/.test(limpio) || /^[XYZ]\d{7}[A-Z]$/.test(limpio);
  }

  $('#prov-nuevo').addEventListener('click', () => abrirFormProveedor());
  $('#prov-cancelar').addEventListener('click', () => {
    provEditando = null;
    $('#prov-form').classList.add('hidden');
  });

  $('#prov-guardar').addEventListener('click', guardarConAviso(async () => {
    const nombre = $('#p-nombre').value.trim();
    const nif = $('#p-nif').value.trim().toUpperCase();
    if (!nombre) { toast('⚠️ El nombre es obligatorio.'); return; }
    if (!nif) { toast('⚠️ El NIF/CIF es obligatorio.'); return; }
    if (!formatoNIFValido(nif) &&
        !confirm(`El NIF/CIF "${nif}" no tiene el formato habitual (ej.: B12345678). ¿Guardarlo igualmente?`)) {
      return;
    }

    // Evitar duplicados (salvo que estemos editando ese mismo proveedor)
    const existente = await reconocerProveedor(nombre, nif);
    if (existente && (!provEditando || existente.id !== provEditando.id)) {
      toast(`⚠️ Ese proveedor ya existe en tu lista: ${existente.nombre}`);
      return;
    }

    await DB.provGuardar({
      ...(provEditando ? { id: provEditando.id, creado: provEditando.creado } : { creado: new Date().toISOString() }),
      nombre,
      nif,
      categoria: $('#p-categoria').value,
      quien: $('#p-quien').value.trim(),
      telefono: $('#p-telefono').value.trim(),
      email: $('#p-email').value.trim(),
      direccion: $('#p-direccion').value.trim()
    });

    provEditando = null;
    $('#prov-form').classList.add('hidden');
    toast('💾 Proveedor guardado.');
    pintarProveedores();
    cargarProveedores();
  }));

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
          <div class="item-sub">${escapar(p.nif || 'Sin NIF')} · ${escapar(p.categoria || '')}${p.telefono ? ' · 📞 ' + escapar(p.telefono) : ''}</div>
          ${p.quien ? `<div class="item-sub">💬 ${escapar(p.quien)}</div>` : ''}
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

  /* Prepara el formulario de factura. Con foto/PDF lee la imagen (OCR);
     sin archivo (anotar a mano) abre el formulario vacío. */
  async function procesarFactura(file) {
    $('#factura-form-card').classList.add('hidden');

    if (file) {
      $('#factura-progress').classList.remove('hidden');
      $('#factura-progress-text').textContent = 'Leyendo el documento… puede tardar unos segundos';
      try {
        file = await archivoAImagen(file);
      } catch (e) {
        console.error(e);
        $('#factura-progress').classList.add('hidden');
        toast('⚠️ ' + (e.message || 'No se pudo abrir el PDF.'));
        return;
      }
    }

    let texto = '';
    if (file) {
      try {
        texto = await OCR.leerImagen(file, (p, fase) => {
          $('#factura-progress-text').textContent = fase === 'preparando'
            ? `Preparando el lector de fotos… ${p}% (solo tarda la primera vez)`
            : `Leyendo la imagen… ${p}%`;
        });
      } catch (e) {
        console.error(e);
        toast('⚠️ No se pudo leer la imagen automáticamente. Rellena los datos a mano.');
      }
      $('#factura-progress').classList.add('hidden');
    }

    // Fichas completas (con NIF) primero: permiten reconocer al proveedor
    // por su NIF aunque el nombre venga distinto en la factura
    let conocidos = [];
    try {
      const [fichas, nombres] = await Promise.all([DB.provTodos(), DB.proveedores()]);
      conocidos = [...fichas, ...nombres];
    } catch (e) {
      console.error(e);
      toast('⚠️ ' + (e.message || 'No se pudo acceder a los datos guardados.'), 6000);
    }
    const datos = file ? OCR.analizarFactura(texto, conocidos) : {};

    registroEditando = null; // anotación nueva = registro nuevo
    facturaPendiente = { imagen: file || null, ocrTexto: texto };
    if (file) {
      $('#factura-preview').classList.remove('hidden');
      $('#factura-preview').src = urlImagen(file);
    } else {
      $('#factura-preview').classList.add('hidden');
    }
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
    $('#f-personal').checked = false;
    $('#f-iva21').value = '';
    $('#f-iva10').value = '';
    $('#f-iva4').value = '';
    $('#f-varios-wrap').classList.toggle('hidden', datos.ivaTipo !== 'varios');
    $('#f-ocr-text').textContent = texto || (file ? '(no se detectó texto)' : '(anotada a mano, sin foto)');
    $('#factura-form-card').classList.remove('hidden');
    $('#factura-form-card').scrollIntoView({ behavior: 'smooth' });

    // Comprobar si el proveedor detectado ya está dado de alta
    await actualizarEstadoProveedor();

    if (!file) {
      $('#f-proveedor').focus();
    } else if (datos.proveedor || datos.total != null) {
      toast('✅ Datos detectados. Revísalos antes de guardar.');
    } else {
      toast('No se detectaron datos claros. Rellénalos a mano, la foto se guardará igualmente.');
    }
  }

  $('#factura-camera').addEventListener('change', (e) => { procesarFactura(e.target.files[0]); e.target.value = ''; });
  $('#factura-file').addEventListener('change', (e) => { procesarFactura(e.target.files[0]); e.target.value = ''; });
  $('#factura-manual').addEventListener('click', () => procesarFactura(null));

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

  $('#f-ivatipo').addEventListener('change', () => {
    const esVarios = $('#f-ivatipo').value === 'varios';
    $('#f-varios-wrap').classList.toggle('hidden', !esVarios);
    if (!esVarios) recalcularIVA(true);
  });
  $('#f-total').addEventListener('change', () => recalcularIVA(false));

  /* Con varios tipos de IVA: sumar las cuotas de cada tramo */
  ['#f-iva21', '#f-iva10', '#f-iva4'].forEach(sel => {
    $(sel).addEventListener('input', () => {
      const suma = ['#f-iva21', '#f-iva10', '#f-iva4']
        .reduce((s, x) => s + (parseFloat($(x).value) || 0), 0);
      if (suma > 0) {
        $('#f-ivacuota').value = (Math.round(suma * 100) / 100).toFixed(2);
        const total = parseFloat($('#f-total').value);
        if (!isNaN(total) && total > 0) {
          $('#f-base').value = (Math.round((total - suma) * 100) / 100).toFixed(2);
        }
      }
    });
  });

  /* Autocálculo de la retención: cuota = base imponible × tipo % */
  $('#f-rettipo').addEventListener('change', () => {
    const tipo = parseFloat($('#f-rettipo').value);
    const base = parseFloat($('#f-base').value);
    if (isNaN(tipo)) { $('#f-retcuota').value = ''; return; }
    if (!isNaN(base) && base > 0) {
      $('#f-retcuota').value = (Math.round(base * tipo) / 100).toFixed(2);
    }
  });

  /* Guardar con aviso visible si algo falla (nunca fallar en silencio) */
  function guardarConAviso(fn) {
    return () => fn().catch((e) => {
      console.error(e);
      toast('⚠️ No se pudo guardar: ' + (e.message || e), 7000);
    });
  }

  $('#factura-guardar').addEventListener('click', guardarConAviso(async () => {
    const total = parseFloat($('#f-total').value);
    const fecha = $('#f-fecha').value;
    if (!fecha) { toast('⚠️ Falta la fecha.'); return; }
    if (isNaN(total) || total <= 0) { toast('⚠️ Pon el total de la factura.'); return; }

    const proveedor = $('#f-proveedor').value.trim() || 'Sin proveedor';
    const nif = $('#f-nif').value.trim();
    const categoria = $('#f-categoria').value;

    const ivaCuota = parseFloat($('#f-ivacuota').value);
    const base = parseFloat($('#f-base').value);
    const tipoStr = $('#f-ivatipo').value;
    const retCuota = parseFloat($('#f-retcuota').value);
    const retTipoStr = $('#f-rettipo').value;

    // Aviso de factura duplicada (misma fecha, proveedor y total): contarla
    // dos veces deduce IVA de más en la declaración
    const idActual = registroEditando ? registroEditando.id : null;
    const iguales = (await DB.buscar({ tipo: 'factura', desde: fecha, hasta: fecha }))
      .filter(r => r.id !== idActual && Math.abs((r.total || 0) - total) < 0.005 &&
        normalizarNombre(r.proveedor) === normalizarNombre(proveedor));
    if (iguales.length && !confirm(
      `⚠️ Ya hay una factura de "${proveedor}" del ${fmtFecha(fecha)} por ${INFORME.eur(total)}.\n\n` +
      'Si la guardas, ese gasto y su IVA se contarán DOS VECES en el informe.\n\n¿Seguro que es otra factura distinta?')) return;

    // Coherencia del desglose: base + IVA − retención tiene que dar el total
    if (!isNaN(base) && !isNaN(ivaCuota)) {
      const ret = isNaN(retCuota) ? 0 : retCuota;
      const esperado = Math.round((base + ivaCuota - ret) * 100) / 100;
      if (Math.abs(esperado - total) > 0.05 && !confirm(
        `⚠️ Los números no cuadran: base ${INFORME.eur(base)} + IVA ${INFORME.eur(ivaCuota)}` +
        `${ret ? ' − retención ' + INFORME.eur(ret) : ''} = ${INFORME.eur(esperado)}, pero el total es ${INFORME.eur(total)}.\n\n` +
        'Revisa el desglose (es lo que va a la declaración). ¿Guardar de todas formas?')) return;
    }

    // Si es un proveedor nuevo y la casilla está marcada, darlo de alta
    await altaProveedorSiNuevo(proveedor, nif, categoria);

    const desglose = tipoStr === 'varios' ? {
      v21: parseFloat($('#f-iva21').value) || null,
      v10: parseFloat($('#f-iva10').value) || null,
      v4: parseFloat($('#f-iva4').value) || null
    } : null;

    await DB.guardar({
      ...(registroEditando && registroEditando.tipo === 'factura'
        ? { id: registroEditando.id, creado: registroEditando.creado }
        : { creado: new Date().toISOString() }),
      tipo: 'factura',
      fecha,
      proveedor,
      nif,
      categoria,
      total: Math.round(total * 100) / 100,
      baseImponible: isNaN(base) ? null : Math.round(base * 100) / 100,
      ivaTipo: tipoStr === '' ? null : (tipoStr === 'varios' ? 'varios' : +tipoStr),
      ivaCuota: isNaN(ivaCuota) ? null : Math.round(ivaCuota * 100) / 100,
      ivaDesglose: desglose,
      retTipo: retTipoStr === '' ? null : +retTipoStr,
      retCuota: isNaN(retCuota) || retCuota <= 0 ? null : Math.round(retCuota * 100) / 100,
      personal: $('#f-personal').checked,
      notas: $('#f-notas').value.trim(),
      imagen: facturaPendiente ? facturaPendiente.imagen : null,
      ocrTexto: facturaPendiente ? facturaPendiente.ocrTexto : ''
    });

    const eraEdicion = !!registroEditando;
    registroEditando = null;
    facturaPendiente = null;
    $('#factura-form-card').classList.add('hidden');
    $('#f-prov-status').classList.add('hidden');
    $('#f-agregar-prov-wrap').classList.add('hidden');
    toast(eraEdicion ? '✏️ Factura corregida.' : '💾 Factura guardada.');
    buscar();
    pintarRecientes();
    cargarProveedores();
  }));

  $('#factura-cancelar').addEventListener('click', () => {
    registroEditando = null;
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
        texto = await OCR.leerImagen(file, (p, fase) => {
          $('#cierre-progress-text').textContent = fase === 'preparando'
            ? `Preparando el lector de fotos… ${p}% (solo tarda la primera vez)`
            : `Leyendo la imagen… ${p}%`;
        });
      } catch (e) {
        console.error(e);
        toast('⚠️ No se pudo leer la imagen. Rellena los datos a mano.');
      }
    }
    $('#cierre-progress').classList.add('hidden');

    const datos = file ? OCR.analizarCierre(texto) : {};
    registroEditando = null; // anotación nueva = registro nuevo
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

  $('#cierre-guardar').addEventListener('click', guardarConAviso(async () => {
    const total = parseFloat($('#c-total').value);
    const esMes = $('#c-alcance').value === 'mes';
    if (isNaN(total) || total < 0) { toast('⚠️ Pon el total de ventas.'); return; }

    let fecha;
    if (esMes) {
      const mes = $('#c-mes').value; // YYYY-MM
      if (!mes) { toast('⚠️ Elige el mes.'); return; }
      fecha = mes + '-01';

      // Avisos para no contar ingresos dos veces (sin contar el propio registro en edición)
      const idActual = registroEditando ? registroEditando.id : null;
      const delMes = (await DB.buscar({ tipo: 'cierre', desde: mes + '-01', hasta: mes + '-31' }))
        .filter(r => r.id !== idActual);
      const yaMensual = delMes.find(r => r.mensual);
      if (yaMensual && !confirm('Ya hay un total mensual guardado para ese mes. ¿Guardar otro de todas formas?')) return;
      const diarios = delMes.filter(r => !r.mensual);
      if (diarios.length && !confirm(`⚠️ Ese mes ya tiene ${diarios.length} cierres diarios guardados. Si añades también el total del mes, los ingresos se contarían DOS VECES en el informe. ¿Seguro que quieres guardarlo?`)) return;
    } else {
      fecha = $('#c-fecha').value;
      if (!fecha) { toast('⚠️ Falta la fecha.'); return; }

      // Avisar si ya hay un cierre para esa fecha (sin contar el propio registro en edición)
      const idActual = registroEditando ? registroEditando.id : null;
      const existentes = (await DB.buscar({ tipo: 'cierre', desde: fecha, hasta: fecha }))
        .filter(r => r.id !== idActual);
      if (existentes.length && !confirm(`Ya hay un cierre guardado para el ${fmtFecha(fecha)}. ¿Guardar otro de todas formas?`)) {
        return;
      }
    }

    const efectivo = parseFloat($('#c-efectivo').value);
    const tarjeta = parseFloat($('#c-tarjeta').value);

    await DB.guardar({
      ...(registroEditando && registroEditando.tipo === 'cierre'
        ? { id: registroEditando.id, creado: registroEditando.creado }
        : { creado: new Date().toISOString() }),
      tipo: 'cierre',
      fecha,
      mensual: esMes,
      proveedor: '',
      total: Math.round(total * 100) / 100,
      efectivo: isNaN(efectivo) ? null : Math.round(efectivo * 100) / 100,
      tarjeta: isNaN(tarjeta) ? null : Math.round(tarjeta * 100) / 100,
      notas: $('#c-notas').value.trim(),
      imagen: cierrePendiente ? cierrePendiente.imagen : null,
      ocrTexto: cierrePendiente ? cierrePendiente.ocrTexto : ''
    });

    const eraEdicion = !!registroEditando;
    registroEditando = null;
    cierrePendiente = null;
    $('#cierre-form-card').classList.add('hidden');
    toast(eraEdicion ? '✏️ Cierre corregido.' : '💾 Cierre guardado.');
    pintarRecientes();
    pintarFacturacion();
    buscar();
  }));

  $('#cierre-cancelar').addEventListener('click', () => {
    registroEditando = null;
    cierrePendiente = null;
    $('#cierre-form-card').classList.add('hidden');
  });

  /* ---------- FACTURACIÓN: cómo va el mes ---------- */

  const DIAS_SEMANA = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const diaSemanaDe = (iso) => DIAS_SEMANA[new Date(iso + 'T00:00:00').getDay()];
  const r2 = (n) => Math.round(n * 100) / 100;

  function mesAnteriorDe(mes) {
    const [a, m] = mes.split('-').map(Number);
    return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`;
  }

  async function pintarFacturacion() {
    if (!$('#fac-mes').value) $('#fac-mes').value = hoyISO().slice(0, 7);
    const mes = $('#fac-mes').value;
    const mesAnt = mesAnteriorDe(mes);
    const [cierres, cierresAnt] = await Promise.all([
      DB.buscar({ tipo: 'cierre', desde: mes + '-01', hasta: mes + '-31' }),
      DB.buscar({ tipo: 'cierre', desde: mesAnt + '-01', hasta: mesAnt + '-31' })
    ]);
    const div = $('#fac-resumen');
    if (!cierres.length) {
      div.innerHTML = '<p class="vacio">Aún no hay cierres anotados en este mes.</p>';
      return;
    }

    // Ventas por día (los totales mensuales sin detalle diario cuentan en el total, no por día)
    const porDia = new Map();
    let totalMensuales = 0;
    cierres.forEach(c => {
      if (c.mensual) totalMensuales += (c.total || 0);
      else porDia.set(c.fecha, r2((porDia.get(c.fecha) || 0) + (c.total || 0)));
    });
    const dias = [...porDia.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const totalDiarios = r2(dias.reduce((s, [, v]) => s + v, 0));
    const total = r2(totalDiarios + totalMensuales);
    const media = dias.length ? totalDiarios / dias.length : 0;

    // Mes anterior, para comparar
    const diasAnt = cierresAnt.filter(c => !c.mensual);
    const totalAnt = r2(cierresAnt.reduce((s, c) => s + (c.total || 0), 0));
    const mediaAnt = diasAnt.length ? diasAnt.reduce((s, c) => s + (c.total || 0), 0) / diasAnt.length : 0;

    const hoy = hoyISO();
    const esMesActual = mes === hoy.slice(0, 7);
    const [a, m] = mes.split('-').map(Number);
    const diasDelMes = new Date(a, m, 0).getDate();
    const ultimoDiaContado = esMesActual ? Math.min(+hoy.slice(8), diasDelMes) : diasDelMes;

    // Días que quedan sin cierre anotado (solo hasta hoy)
    const sinCierre = [];
    if (!totalMensuales) {
      for (let d = 1; d <= ultimoDiaContado; d++) {
        const f = `${mes}-${String(d).padStart(2, '0')}`;
        if (!porDia.has(f) && !(esMesActual && f === hoy)) sinCierre.push(f);
      }
    }

    // Mejor día y días más flojos
    const orden = [...dias].sort((x, y) => y[1] - x[1]);
    const mejor = orden[0];
    const flojos = orden.slice(-Math.min(3, Math.max(0, orden.length - 1))).reverse();

    // Media por día de la semana: cuáles flojean
    const agg = Array.from({ length: 7 }, () => ({ s: 0, n: 0 }));
    dias.forEach(([f, v]) => { const i = new Date(f + 'T00:00:00').getDay(); agg[i].s += v; agg[i].n++; });
    const mediasSemana = agg.map(x => (x.n ? x.s / x.n : null));
    const maxSemana = Math.max(1, ...mediasSemana.filter(x => x !== null));
    const minSemana = Math.min(...mediasSemana.filter(x => x !== null));
    const ordenSemana = [1, 2, 3, 4, 5, 6, 0]; // lunes a domingo
    const semanaHTML = ordenSemana.filter(i => mediasSemana[i] !== null).map(i => `
      <div class="fila-mes">
        <span class="mes-etq">${DIAS_SEMANA[i]}${mediasSemana[i] === minSemana && dias.length >= 4 ? ' 🔻' : ''}</span>
        <div class="barra"><div class="barra-fill" style="width:${Math.max(2, Math.round(mediasSemana[i] / maxSemana * 100))}%"></div></div>
        <span class="mes-val">${INFORME.eur(mediasSemana[i])}</span>
      </div>`).join('');

    // Barras por día
    const maxDia = Math.max(1, ...dias.map(([, v]) => v));
    const flojosSet = new Set(flojos.map(([f]) => f));
    const barrasHTML = dias.map(([f, v]) => `
      <div class="fila-mes">
        <span class="mes-etq">${+f.slice(8)} ${diaSemanaDe(f)}${mejor && f === mejor[0] ? ' 🥇' : (flojosSet.has(f) ? ' 🔻' : '')}</span>
        <div class="barra"><div class="barra-fill" style="width:${Math.max(2, Math.round(v / maxDia * 100))}%"></div></div>
        <span class="mes-val">${INFORME.eur(v)}</span>
      </div>`).join('');

    // Comparación con el mes anterior (por media diaria: justo aunque el mes no haya acabado)
    let comparaHTML = '';
    if (mediaAnt > 0 && media > 0) {
      const dif = (media - mediaAnt) / mediaAnt * 100;
      const signo = dif >= 0 ? '▲' : '▼';
      comparaHTML = `<div class="stat-linea"><span>Frente a ${mesEnLetras(mesAnt + '-01')} (media ${INFORME.eur(mediaAnt)}/día · total ${INFORME.eur(totalAnt)})</span><strong class="${dif >= 0 ? 'txt-ok' : 'txt-bad'}">${signo} ${Math.abs(dif).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %</strong></div>`;
    } else if (totalAnt > 0) {
      comparaHTML = `<div class="stat-linea"><span>${mesEnLetras(mesAnt + '-01')} cerró en</span><strong>${INFORME.eur(totalAnt)}</strong></div>`;
    }

    const ritmoHTML = esMesActual && dias.length >= 3 && ultimoDiaContado < diasDelMes
      ? `<div class="stat-linea"><span>Si sigue a este ritmo, el mes cerraría en <small class="txt-sec">(orientativo)</small></span><strong>~${INFORME.eur(total + media * (diasDelMes - ultimoDiaContado))}</strong></div>`
      : '';

    div.innerHTML = `
      <div class="stat-linea per-pendiente ok"><span>Facturado en ${mesEnLetras(mes + '-01')}</span><strong>${INFORME.eur(total)}</strong></div>
      <div class="stat-linea"><span>${dias.length} día${dias.length === 1 ? '' : 's'} con cierre${totalMensuales ? ' + total mensual' : ''} · media</span><strong>${INFORME.eur(media)}/día</strong></div>
      ${comparaHTML}
      ${ritmoHTML}
      ${mejor ? `<div class="stat-linea"><span>🥇 Mejor día: ${fmtFecha(mejor[0])} (${diaSemanaDe(mejor[0])})</span><strong class="txt-ok">${INFORME.eur(mejor[1])}</strong></div>` : ''}
      ${flojos.length ? `<p class="hint" style="margin:10px 0 2px">🔻 Los días más flojos del mes:</p>${flojos.map(([f, v]) => `<div class="stat-linea"><span>${fmtFecha(f)} (${diaSemanaDe(f)})</span><strong class="txt-bad">${INFORME.eur(v)}</strong></div>`).join('')}` : ''}
      ${sinCierre.length ? `<p class="hint" style="margin:10px 0 0;color:var(--oro)">⚠️ ${sinCierre.length} día${sinCierre.length === 1 ? '' : 's'} sin cierre anotado: ${sinCierre.slice(0, 6).map(f => +f.slice(8)).join(', ')}${sinCierre.length > 6 ? '…' : ''}</p>` : ''}
      ${semanaHTML ? `<p class="hint" style="margin:12px 0 4px">📅 Media por día de la semana (🔻 el más flojo):</p>${semanaHTML}` : ''}
      ${barrasHTML ? `<p class="hint" style="margin:12px 0 4px">Ventas de cada día:</p>${barrasHTML}` : ''}`;
  }

  $('#fac-mes').addEventListener('change', pintarFacturacion);

  /* ---------- Listas y detalle ---------- */

  function mesEnLetras(fechaISO) {
    return INFORME.MESES[parseInt(fechaISO.slice(5, 7), 10) - 1] + ' ' + fechaISO.slice(0, 4);
  }

  function itemHTML(r) {
    const esFactura = r.tipo === 'factura';
    const titulo = esFactura ? (r.proveedor || 'Sin proveedor') : (r.mensual ? 'Ventas del mes' : 'Cierre de caja');
    const sub = r.mensual
      ? mesEnLetras(r.fecha) + ' · mes completo'
      : fmtFecha(r.fecha) + (esFactura && r.categoria ? ' · ' + escapar(r.categoria) : '') + (esFactura && r.personal ? ' · 👤 personal' : '');
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
      esFactura && r.personal ? ['Gasto personal / de casa', 'Sí — va a la gestoría en apartado aparte'] : null,
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
        <button class="btn btn-primary" id="detalle-editar">✏️ Editar / corregir datos</button>
        <button class="btn btn-danger" id="detalle-borrar">🗑️ Eliminar este registro</button>
      </div>`;

    $('#modal').classList.remove('hidden');

    // La imagen del detalle también se puede ampliar para leer el IVA
    const imgModal = $('#modal-body .modal-img');
    if (imgModal) imgModal.addEventListener('click', () => abrirVisor(imgModal.src));

    $('#detalle-editar').addEventListener('click', () => {
      cerrarModal();
      editarRegistro(r);
    });

    $('#detalle-borrar').addEventListener('click', async () => {
      if (confirm('¿Seguro que quieres eliminar este registro? No se puede deshacer.')) {
        await DB.borrar(r.id);
        cerrarModal();
        toast('🗑️ Registro eliminado.');
        pintarRecientes();
        pintarFacturacion();
        buscar();
      }
    });
  }

  /* Abre el formulario correspondiente con los datos de un registro
     guardado para corregirlos. Al guardar se actualiza, no se duplica. */
  function editarRegistro(r) {
    registroEditando = r;
    const irA = (tab) => document.querySelector(`.tab[data-tab="${tab}"]`).click();

    if (r.tipo === 'factura') {
      irA('facturas');
      facturaPendiente = { imagen: r.imagen || null, ocrTexto: r.ocrTexto || '' };
      if (r.imagen instanceof Blob) {
        $('#factura-preview').classList.remove('hidden');
        $('#factura-preview').src = URL.createObjectURL(r.imagen);
      } else {
        $('#factura-preview').classList.add('hidden');
      }
      $('#f-proveedor').value = r.proveedor || '';
      $('#f-nif').value = r.nif || '';
      $('#f-fecha').value = r.fecha || hoyISO();
      $('#f-total').value = r.total != null ? r.total : '';
      $('#f-categoria').value = r.categoria || 'Mercancía';
      $('#f-ivatipo').value = r.ivaTipo != null ? String(r.ivaTipo) : '';
      $('#f-ivacuota').value = r.ivaCuota != null ? r.ivaCuota : '';
      $('#f-base').value = r.baseImponible != null ? r.baseImponible : '';
      $('#f-rettipo').value = r.retTipo != null ? String(r.retTipo) : '';
      $('#f-retcuota').value = r.retCuota != null ? r.retCuota : '';
      $('#f-notas').value = r.notas || '';
      $('#f-personal').checked = !!r.personal;
      const d = r.ivaDesglose || {};
      $('#f-iva21').value = d.v21 != null ? d.v21 : '';
      $('#f-iva10').value = d.v10 != null ? d.v10 : '';
      $('#f-iva4').value = d.v4 != null ? d.v4 : '';
      $('#f-varios-wrap').classList.toggle('hidden', r.ivaTipo !== 'varios');
      $('#f-ocr-text').textContent = r.ocrTexto || '(sin texto detectado)';
      $('#factura-form-card').classList.remove('hidden');
      actualizarEstadoProveedor();
      $('#factura-form-card').scrollIntoView({ behavior: 'smooth' });
    } else {
      irA('cierres');
      cierrePendiente = { imagen: r.imagen || null, ocrTexto: r.ocrTexto || '' };
      if (r.imagen instanceof Blob) {
        $('#cierre-preview').classList.remove('hidden');
        $('#cierre-preview').src = URL.createObjectURL(r.imagen);
      } else {
        $('#cierre-preview').classList.add('hidden');
      }
      $('#c-alcance').value = r.mensual ? 'mes' : 'dia';
      $('#c-fecha-wrap').classList.toggle('hidden', !!r.mensual);
      $('#c-mes-wrap').classList.toggle('hidden', !r.mensual);
      $('#c-fecha').value = r.fecha || hoyISO();
      $('#c-mes').value = (r.fecha || hoyISO()).slice(0, 7);
      $('#c-total').value = r.total != null ? r.total : '';
      $('#c-efectivo').value = r.efectivo != null ? r.efectivo : '';
      $('#c-tarjeta').value = r.tarjeta != null ? r.tarjeta : '';
      $('#c-notas').value = r.notas || '';
      $('#c-ocr-text').textContent = r.ocrTexto || '(sin foto)';
      $('#cierre-form-card').classList.remove('hidden');
      $('#cierre-form-card').scrollIntoView({ behavior: 'smooth' });
    }
    toast('✏️ Corrige lo que haga falta y pulsa Guardar.');
  }

  function cerrarModal() { $('#modal').classList.add('hidden'); }
  $('#modal-cerrar').addEventListener('click', cerrarModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') cerrarModal(); });

  /* ---------- Visor con zoom: para leer la letra pequeña (IVA…) ---------- */

  const visorArea = $('#visor-area');
  const visorImg = $('#visor-img');
  let vEscala = 1, vTx = 0, vTy = 0;
  const vPunteros = new Map(); // punteros activos (dedos/ratón)
  let vPellizco = null;        // estado al empezar un gesto de pellizco
  let vUltimoTap = 0;

  function visorAplicar() {
    visorImg.style.transform = `translate(${vTx}px, ${vTy}px) scale(${vEscala})`;
  }

  function abrirVisor(src) {
    if (!src) return;
    visorImg.src = src;
    vEscala = 1; vTx = 0; vTy = 0;
    visorAplicar();
    $('#visor').classList.remove('hidden');
  }

  function cerrarVisor() {
    $('#visor').classList.add('hidden');
    vPunteros.clear();
    vPellizco = null;
  }

  $('#visor-cerrar').addEventListener('click', cerrarVisor);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarVisor(); });

  function vCentro() {
    const r = visorArea.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /* Zoom hacia un punto de la pantalla manteniendo ese punto quieto. */
  function visorZoomHacia(px, py, nuevaEscala) {
    const c = vCentro();
    const s = Math.max(1, Math.min(6, nuevaEscala));
    vTx = (px - c.x) - (s / vEscala) * (px - c.x - vTx);
    vTy = (py - c.y) - (s / vEscala) * (py - c.y - vTy);
    vEscala = s;
    if (s === 1) { vTx = 0; vTy = 0; }
    visorAplicar();
  }

  visorArea.addEventListener('pointerdown', (e) => {
    visorArea.setPointerCapture(e.pointerId);
    vPunteros.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    if (vPunteros.size === 2) {
      const [a, b] = [...vPunteros.values()];
      vPellizco = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        escala: vEscala, tx: vTx, ty: vTy
      };
    }
  });

  visorArea.addEventListener('pointermove', (e) => {
    const p = vPunteros.get(e.pointerId);
    if (!p) return;
    const antesX = p.x, antesY = p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (vPunteros.size === 2 && vPellizco) {
      // Pellizco: escalar respecto al punto medio de los dos dedos
      const [a, b] = [...vPunteros.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const c = vCentro();
      const s = Math.max(1, Math.min(6, vPellizco.escala * (dist / vPellizco.dist)));
      vTx = (mid.x - c.x) - (s / vPellizco.escala) * (vPellizco.mid.x - c.x - vPellizco.tx);
      vTy = (mid.y - c.y) - (s / vPellizco.escala) * (vPellizco.mid.y - c.y - vPellizco.ty);
      vEscala = s;
      visorAplicar();
    } else if (vPunteros.size === 1) {
      vTx += p.x - antesX;
      vTy += p.y - antesY;
      visorAplicar();
    }
  });

  function vSoltar(e) {
    const p = vPunteros.get(e.pointerId);
    vPunteros.delete(e.pointerId);
    if (vPunteros.size < 2) vPellizco = null;
    // Doble toque (sin apenas movimiento): acercar / volver al tamaño normal
    if (e.type === 'pointerup' && p && vPunteros.size === 0) {
      const seMovio = Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 12;
      const ahora = Date.now();
      if (!seMovio && ahora - vUltimoTap < 320) {
        visorZoomHacia(e.clientX, e.clientY, vEscala > 1 ? 1 : 2.5);
        vUltimoTap = 0;
      } else {
        vUltimoTap = seMovio ? 0 : ahora;
      }
    }
  }
  visorArea.addEventListener('pointerup', vSoltar);
  visorArea.addEventListener('pointercancel', vSoltar);

  // Rueda del ratón (si se usa en ordenador)
  visorArea.addEventListener('wheel', (e) => {
    e.preventDefault();
    visorZoomHacia(e.clientX, e.clientY, vEscala * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
  }, { passive: false });

  $('#factura-preview').addEventListener('click', () => abrirVisor($('#factura-preview').src));
  $('#cierre-preview').addEventListener('click', () => abrirVisor($('#cierre-preview').src));

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
    } else if ($('#q-orden').value === 'proveedor') {
      // Agrupadas por proveedor: cabecera con número de facturas y total
      // de cada uno; dentro de cada grupo siguen ordenadas por fecha.
      div.className = 'lista';
      const grupos = new Map();
      for (const r of ultimosResultados) {
        const clave = r.tipo === 'factura' ? (r.proveedor || 'Sin proveedor') : '💰 Cierres de caja (ingresos)';
        if (!grupos.has(clave)) grupos.set(clave, []);
        grupos.get(clave).push(r);
      }
      const esCierres = (n) => n.startsWith('💰');
      const nombres = [...grupos.keys()].sort((a, b) =>
        (esCierres(a) ? 1 : 0) - (esCierres(b) ? 1 : 0) || a.localeCompare(b, 'es'));
      div.innerHTML = nombres.map(nombre => {
        const items = grupos.get(nombre);
        const total = items.reduce((s, r) => s + (r.total || 0), 0);
        return `
          <div class="grupo-cab">
            <span class="grupo-nombre">${escapar(nombre)}</span>
            <span class="grupo-resumen">${items.length} · ${INFORME.eur(total)}</span>
          </div>` + items.map(itemHTML).join('');
      }).join('');
    } else {
      div.className = 'lista';
      div.innerHTML = ultimosResultados.map(itemHTML).join('');
    }
    conectarDetalle(div, ultimosResultados);
  }

  $('#q-buscar').addEventListener('click', buscar);
  $('#q-orden').addEventListener('change', buscar);
  $('#q-limpiar').addEventListener('click', () => {
    $('#q-tipo').value = 'todos';
    $('#q-proveedor').value = '';
    $('#q-desde').value = '';
    $('#q-hasta').value = '';
    $('#q-orden').value = 'fecha';
    buscar();
  });

  /* "Ver todas": salta a Consultar con el filtro del tipo ya puesto */
  function verTodo(tipo) {
    $('#q-tipo').value = tipo;
    $('#q-proveedor').value = '';
    $('#q-desde').value = '';
    $('#q-hasta').value = '';
    document.querySelector('.tab[data-tab="consultar"]').click(); // la pestaña ya lanza la búsqueda
  }
  $('#ver-todas-facturas').addEventListener('click', () => verTodo('factura'));
  $('#ver-todos-cierres').addEventListener('click', () => verTodo('cierre'));
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

  /* ---------- CUADRO DE MANDO: cómo va el negocio este mes ---------- */

  const CLAVE_TRIMESTRE = 'contable-trimestre-guardado';

  /* Último trimestre ya cerrado (para recordar guardar la copia) */
  function ultimoTrimestreCerrado() {
    const hoy = new Date();
    const tActual = Math.floor(hoy.getMonth() / 3) + 1;
    return tActual === 1 ? { anio: hoy.getFullYear() - 1, t: 4 } : { anio: hoy.getFullYear(), t: tActual - 1 };
  }

  /* Coste de personal devengado en un mes (todos los empleados) */
  async function costePersonalMes(mes, cierresMes) {
    const trabajadores = await DB.perTodos();
    let total = 0;
    for (const t of trabajadores) {
      const ventasT = ventasParaTrabajador(t, cierresMes, mes);
      total += calcularMes(t, ventasT, [], mes).devengado;
    }
    return r2(total);
  }

  async function datosMes(mes) {
    const regs = await DB.buscar({ desde: mes + '-01', hasta: mes + '-31' });
    const cierres = regs.filter(r => r.tipo === 'cierre');
    const facturas = regs.filter(r => r.tipo === 'factura' && !r.personal);
    const personalesCasa = regs.filter(r => r.tipo === 'factura' && r.personal);
    const ingresos = r2(cierres.reduce((s, r) => s + (r.total || 0), 0));
    const gastos = r2(facturas.reduce((s, r) => s + (r.total || 0), 0));
    const porCategoria = {};
    facturas.forEach(r => {
      const c = r.categoria || 'Otros';
      porCategoria[c] = r2((porCategoria[c] || 0) + (r.total || 0));
    });
    const personal = await costePersonalMes(mes, cierres);
    const sinIVA = facturas.filter(r => typeof r.ivaCuota !== 'number').length;
    return {
      ingresos, gastos, personal, porCategoria, sinIVA,
      facturas: facturas.length, cierres: cierres.filter(c => !c.mensual).length,
      casa: r2(personalesCasa.reduce((s, r) => s + (r.total || 0), 0)),
      beneficio: r2(ingresos - gastos - personal)
    };
  }

  async function pintarResumen() {
    if (!$('#res-mes').value) $('#res-mes').value = hoyISO().slice(0, 7);
    const mes = $('#res-mes').value;
    const mesAnt = mesAnteriorDe(mes);
    const [d, ant] = await Promise.all([datosMes(mes), datosMes(mesAnt)]);
    const hoy = hoyISO();
    const esMesActual = mes === hoy.slice(0, 7);

    // ── Alertas: lo que necesita tu atención ──
    const alertas = [];
    const tri = ultimoTrimestreCerrado();
    const claveTri = `${tri.anio}-T${tri.t}`;
    if (localStorage.getItem(CLAVE_TRIMESTRE) !== claveTri) {
      alertas.push(`<div class="alerta"><span>📦 El <strong>${tri.t}º trimestre de ${tri.anio}</strong> ya cerró: genera el informe, descarga el CSV y el PDF, haz la copia de seguridad y guárdalos en Drive.</span><button class="btn btn-small" id="res-tri-hecho">Ya lo hice ✓</button></div>`);
    }
    if (esMesActual) {
      const cierresMes = await DB.buscar({ tipo: 'cierre', desde: mes + '-01', hasta: mes + '-31' });
      if (!cierresMes.some(c => c.mensual)) {
        const conCierre = new Set(cierresMes.map(c => c.fecha));
        const faltan = [];
        for (let dia = 1; dia < +hoy.slice(8); dia++) {
          const f = `${mes}-${String(dia).padStart(2, '0')}`;
          if (!conCierre.has(f)) faltan.push(dia);
        }
        if (faltan.length) alertas.push(`<div class="alerta">⚠️ <strong>${faltan.length} día${faltan.length === 1 ? '' : 's'} sin cierre</strong> este mes: ${faltan.slice(0, 8).join(', ')}${faltan.length > 8 ? '…' : ''}. Sin cierre no hay ingreso anotado.</div>`);
      }
    }
    if (d.sinIVA) alertas.push(`<div class="alerta">🧾 <strong>${d.sinIVA} factura${d.sinIVA === 1 ? '' : 's'} sin desglose de IVA</strong> este mes: la previsión de impuestos lo estima. Ábrelas y pon el IVA para afinar.</div>`);
    const trabajadores = await DB.perTodos();
    const pagos = await DB.pagoTodos();
    let deudaEquipo = 0;
    const cacheC = new Map();
    const cierresDe = async (m) => { if (!cacheC.has(m)) cacheC.set(m, await DB.buscar({ tipo: 'cierre', desde: m + '-01', hasta: m + '-31' })); return cacheC.get(m); };
    for (const t of trabajadores.filter(x => !x.liquidado)) {
      const deuda = await desgloseDeuda(t, pagos.filter(p => p.trabajadorSid === t.sid), cierresDe);
      if (deuda.total > 0) deudaEquipo += deuda.total;
    }
    if (deudaEquipo > 0) alertas.push(`<div class="alerta">👥 Debes <strong>${INFORME.eur(deudaEquipo)}</strong> al equipo en total (ver pestaña Personal).</div>`);
    $('#res-alertas').innerHTML = alertas.length ? alertas.join('') : '<p class="hint txt-ok" style="margin-bottom:8px">✅ Todo al día: sin avisos pendientes.</p>';
    const btnTri = $('#res-tri-hecho');
    if (btnTri) btnTri.addEventListener('click', () => { localStorage.setItem(CLAVE_TRIMESTRE, claveTri); pintarResumen(); toast('📦 Trimestre marcado como guardado.'); });

    // ── Números del mes ──
    const pct = (parte) => d.ingresos > 0 ? ` <small class="txt-sec">(${Math.round(parte / d.ingresos * 100)} % de las ventas)</small>` : '';
    const comparar = (ahora, antes) => {
      if (!antes) return '';
      const dif = (ahora - antes) / Math.abs(antes) * 100;
      return ` <small class="${dif >= 0 ? 'txt-ok' : 'txt-bad'}">${dif >= 0 ? '▲' : '▼'} ${Math.abs(dif).toLocaleString('es-ES', { maximumFractionDigits: 0 })} %</small>`;
    };
    const cats = Object.entries(d.porCategoria).sort((a, b) => b[1] - a[1]);
    const maxCat = Math.max(1, d.personal, ...cats.map(c => c[1]));
    const filaCat = (nombre, valor) => `
      <div class="fila-mes">
        <span class="mes-etq" style="width:88px">${escapar(nombre)}</span>
        <div class="barra"><div class="barra-fill" style="width:${Math.max(2, Math.round(valor / maxCat * 100))}%"></div></div>
        <span class="mes-val" style="width:120px">${INFORME.eur(valor)}${d.ingresos > 0 ? ` <small class="txt-sec">${Math.round(valor / d.ingresos * 100)}%</small>` : ''}</span>
      </div>`;
    const margen = d.ingresos > 0 ? Math.round(d.beneficio / d.ingresos * 100) : null;

    $('#res-contenido').innerHTML = `
      <div class="stat-linea"><span>💰 Ingresos (${d.cierres} cierre${d.cierres === 1 ? '' : 's'})</span><strong class="txt-ok">${INFORME.eur(d.ingresos)}${comparar(d.ingresos, ant.ingresos)}</strong></div>
      <div class="stat-linea"><span>📄 Gastos del negocio (${d.facturas} factura${d.facturas === 1 ? '' : 's'})${pct(d.gastos)}</span><strong class="txt-bad">−${INFORME.eur(d.gastos)}${comparar(d.gastos, ant.gastos)}</strong></div>
      <div class="stat-linea"><span>👥 Personal (sueldos + comisiones devengados)${pct(d.personal)}</span><strong class="txt-bad">−${INFORME.eur(d.personal)}${comparar(d.personal, ant.personal)}</strong></div>
      <div class="stat-linea per-pendiente ${d.beneficio >= 0 ? 'ok' : ''}"><span>${d.beneficio >= 0 ? '✅ TE QUEDA' : '🔴 PIERDES'}${margen !== null ? ` <small class="txt-sec">margen ${margen} %</small>` : ''}</span><strong>${INFORME.eur(Math.abs(d.beneficio))}${comparar(d.beneficio, ant.beneficio)}</strong></div>
      ${d.casa ? `<div class="stat-linea"><span>👤 Gastos de casa (aparte, no restan)</span><span class="txt-sec">${INFORME.eur(d.casa)}</span></div>` : ''}
      ${cats.length || d.personal ? `<p class="hint" style="margin:12px 0 4px">En qué se va el dinero (y qué % de las ventas es cada cosa):</p>${cats.map(([n, v]) => filaCat(n, v)).join('')}${d.personal ? filaCat('Personal', d.personal) : ''}` : ''}
      ${ant.ingresos || ant.gastos ? `<p class="hint" style="margin:12px 0 0">${mesEnLetras(mesAnt + '-01')}: ingresos ${INFORME.eur(ant.ingresos)} · gastos ${INFORME.eur(ant.gastos)} · personal ${INFORME.eur(ant.personal)} · te quedó ${INFORME.eur(ant.beneficio)}</p>` : ''}
      <p class="hint" style="margin:10px 0 0">Referencias de hostelería: mercancía ≈ 25-35 % de las ventas, personal ≈ 25-35 %. Si algo se dispara, ahí está el problema.</p>`;
  }

  $('#res-mes').addEventListener('change', pintarResumen);

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

  /* ---------- Gasto por proveedor en el tiempo ---------- */

  function rangoPeriodo(periodo) {
    const hoy = new Date();
    const p = (n) => String(n).padStart(2, '0');
    if (periodo === 'anio') {
      return { desde: `${hoy.getFullYear()}-01-01`, hasta: null };
    }
    if (periodo === '12m') {
      const d = new Date(hoy.getFullYear(), hoy.getMonth() - 11, 1);
      return { desde: `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`, hasta: null };
    }
    return { desde: null, hasta: null }; // todo el historial
  }

  function mesCorto(yyyymm) {
    const [a, m] = yyyymm.split('-');
    return INFORME.MESES[+m - 1].slice(0, 3) + ' ' + a.slice(2);
  }

  $('#e-generar').addEventListener('click', async () => {
    const { desde, hasta } = rangoPeriodo($('#e-periodo').value);
    const stats = await INFORME.estadisticas(desde, hasta);
    const div = $('#e-resultado');

    if (!stats.length) {
      div.innerHTML = '<p class="vacio">No hay facturas en ese periodo.</p>';
      return;
    }

    div.innerHTML = stats.map((s, i) => {
      const maxMes = Math.max(...s.meses.map(m => s.porMes[m]));
      const filas = s.meses.map(m => `
        <div class="fila-mes">
          <span class="mes-etq">${mesCorto(m)}</span>
          <div class="barra"><div class="barra-fill" style="width:${Math.max(2, Math.round(s.porMes[m] / maxMes * 100))}%"></div></div>
          <span class="mes-val">${INFORME.eur(s.porMes[m])}</span>
        </div>`).join('');

      return `
        <div class="stat-prov">
          <div class="stat-prov-cab" data-i="${i}">
            <div style="min-width:0">
              <div class="stat-prov-nombre">${escapar(s.nombre)}</div>
              ${s.nif ? `<div class="stat-prov-nif">${escapar(s.nif)}</div>` : ''}
            </div>
            <div class="stat-prov-total">${INFORME.eur(s.total)}</div>
          </div>
          <div class="stat-prov-medias">
            ${s.facturas} factura${s.facturas === 1 ? '' : 's'} ·
            media <strong>${INFORME.eur(s.mediaFactura)}</strong> por factura ·
            media <strong>${INFORME.eur(s.mediaMes)}</strong> al mes
          </div>
          <div class="stat-meses hidden" id="stat-meses-${i}">${filas}</div>
        </div>`;
    }).join('');

    div.querySelectorAll('.stat-prov-cab').forEach(cab => {
      cab.addEventListener('click', () => {
        $('#stat-meses-' + cab.dataset.i).classList.toggle('hidden');
      });
    });
  });

  /* ---------- PERSONAL: sueldos, adelantos y días trabajados ---------- */

  let perEditando = null; // trabajador en edición
  const perAbiertos = new Set(); // fichas de empleado desplegadas

  function mesPersonal() {
    return $('#per-mes').value || hoyISO().slice(0, 7);
  }

  /* Ventas del negocio en un mes (suma de los cierres anotados) */
  async function ventasDelMes(mes) {
    const cierres = await DB.buscar({ tipo: 'cierre', desde: mes + '-01', hasta: mes + '-31' });
    return Math.round(cierres.reduce((s, r) => s + (r.total || 0), 0) * 100) / 100;
  }

  function tramosDe(t) {
    return (t.tramos || []).filter(x => x && x.objetivo > 0 && x.porcentaje > 0)
      .sort((a, b) => a.objetivo - b.objetivo);
  }

  /* Cálculo del mes de un trabajador: fijo por días + comisión por tramo */
  function calcularMes(t, ventas, pagosMes, mes) {
    // Trabajó = días normales + días que llegó tarde (vino igualmente)
    const dias = [...new Set([...(t.dias || []), ...fechasTardes(t)])]
      .filter(d => d.startsWith(mes)).sort();
    const tardes = tardesDe(t).filter(x => x.fecha.startsWith(mes));
    const faltas = (t.faltas || []).filter(d => d.startsWith(mes));
    const fijoDia = (t.sueldoMensual || 0) / (t.diasMes || 26);
    const jornada = t.horasJornada || 7.5;
    const horasTarde = Math.round(tardes.reduce((s, x) => s + (x.horas || 0), 0) * 10) / 10;
    const descuentoTardes = Math.round(tardes.reduce(
      (s, x) => s + fijoDia * Math.min(1, (x.horas || 0) / jornada), 0) * 100) / 100;
    const fijo = Math.round((fijoDia * dias.length - descuentoTardes) * 100) / 100;

    const tramos = tramosDe(t);
    let tramoActual = null;
    let siguiente = null;
    for (const tr of tramos) {
      if (ventas >= tr.objetivo) tramoActual = tr;
      else if (!siguiente) siguiente = tr;
    }
    const comision = tramoActual ? Math.round(ventas * tramoActual.porcentaje) / 100 : 0;

    const entregado = Math.round(pagosMes.reduce((s, p) => s + (p.importe || 0), 0) * 100) / 100;
    const devengado = Math.round((fijo + comision) * 100) / 100;
    return {
      dias, tardes, faltas, horasTarde, descuentoTardes,
      fijo, comision, tramoActual, siguiente,
      devengado, entregado,
      pendiente: Math.round((devengado - entregado) * 100) / 100
    };
  }

  /* Calendario del mes: un botón por día, los trabajados en claro y
     con un puntito los días que tienen nota apuntada */
  function calendarioHTML(t, mes, soloLectura = false) {
    const [a, m] = mes.split('-').map(Number);
    const nDias = new Date(a, m, 0).getDate();
    const primerDiaSemana = (new Date(a, m - 1, 1).getDay() + 6) % 7; // lunes = 0
    const trabajados = new Set((t.dias || []).filter(d => d.startsWith(mes)));
    const tardes = new Set(fechasTardes(t).filter(d => d.startsWith(mes)));
    const faltas = new Set((t.faltas || []).filter(d => d.startsWith(mes)));
    const conNota = new Set((t.notasDias || []).map(n => n.fecha).filter(f => (f || '').startsWith(mes)));
    const cab = ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(d => `<span class="cal-cab">${d}</span>`).join('');
    let celdas = '';
    for (let i = 0; i < primerDiaSemana; i++) celdas += '<span></span>';
    for (let d = 1; d <= nDias; d++) {
      const fecha = `${mes}-${String(d).padStart(2, '0')}`;
      // Antes de su inicio (o después de su baja) no trabajaba: en negro, sin poder tocar
      const bloqueado = (t.inicio && fecha < t.inicio) || (t.fin && fecha > t.fin);
      const clase = trabajados.has(fecha) ? 'on' : (tardes.has(fecha) ? 'tarde' : (faltas.has(fecha) ? 'falta' : ''));
      const nota = conNota.has(fecha) ? 'con-nota' : '';
      if (soloLectura) {
        // Ficha ya liquidada: los días se ven, pero no se pueden tocar.
        // Se usan <span> y no un botón desactivado porque el estilo de
        // ":disabled" pintaría de negro también los días que sí trabajó.
        celdas += `<span class="dia ${clase || (bloqueado ? 'fuera' : '')} ${nota}">${d}</span>`;
      } else {
        celdas += `<button type="button" class="dia ${clase} ${nota}"${bloqueado ? ' disabled' : ''} data-sid="${t.sid}" data-fecha="${fecha}">${d}</button>`;
      }
    }
    const pie = soloLectura
      ? 'En claro los días que trabajó, ⏰ los que llegó tarde y en rojo los que faltó. Su cuenta ya está liquidada: no se pueden cambiar.'
      : 'Toques en el día → 1: trabajó · 2: ⏰ llegó tarde · 3: faltó · 4: nada. En negro: aún no trabajaba.';
    return `<div class="cal${soloLectura ? ' cal-lectura' : ''}">${cab}${celdas}</div>
      <p class="hint" style="margin:0 0 8px">${pie}</p>`;
  }

  /* Colores de los trabajadores (paleta validada para el tema oscuro).
     El punto lleva la inicial dentro para no depender solo del color. */
  const PALETA_PERSONAL = ['#5b8def', '#1fa383', '#9a6fd0', '#d5643f', '#b8892e'];

  /* Las tardes se guardan como { fecha, horas de retraso }. Las antiguas
     eran solo la fecha: se tratan como 0 horas (sin descuento). */
  const tardesDe = (t) => (t.tardes || []).map(x => (typeof x === 'string' ? { fecha: x, horas: 0 } : x));
  const fechasTardes = (t) => tardesDe(t).map(x => x.fecha);

  const pdot = (t, i) =>
    `<span class="pdot" style="background:${PALETA_PERSONAL[i % PALETA_PERSONAL.length]}">${escapar((t.nombre || '?')[0].toUpperCase())}</span>`;

  /* Ventas que cuentan para un trabajador en un mes: solo desde su fecha de
     inicio y hasta su baja. Si empezó el día 10, sus comisiones se calculan
     con las ventas desde el 10; al mes siguiente ya cuenta el mes entero.
     Un total mensual sin detalle por días se reparte proporcionalmente. */
  /* Ventas que cuentan para el objetivo de un trabajador: SOLO las de los
     días que él trabajó (marcados en su calendario, incluidos los días que
     llegó tarde). Las ventas de sus días libres o faltas no entran.
     Un total mensual sin detalle por días se reparte por proporción. */
  /* Ventas que cuentan para el objetivo de un trabajador:
     - Días trabajados normales: cuenta la venta completa del día.
     - Días que llegó tarde: cuenta la parte proporcional a las horas que
       estuvo (venta ÷ horas de jornada × horas trabajadas).
     - Días libres o faltas: no cuentan nada.
     Un total mensual sin detalle por días se reparte por proporción.
     Con conDetalle=true devuelve también el desglose de los días con retraso. */
  function ventasParaTrabajador(t, cierresMes, mes, conDetalle = false) {
    const [a, m] = mes.split('-').map(Number);
    const diasDelMes = new Date(a, m, 0).getDate();
    const jornada = t.horasJornada || 7.5;
    const normales = new Set((t.dias || []).filter(d => d.startsWith(mes)));
    const tardesMes = tardesDe(t).filter(x => x.fecha.startsWith(mes));
    const tardePorFecha = new Map(tardesMes.map(x => [x.fecha, x.horas || 0]));

    const ventasDia = new Map();
    let mensual = 0;
    for (const c of cierresMes) {
      if (c.mensual) mensual += (c.total || 0);
      else ventasDia.set(c.fecha, (ventasDia.get(c.fecha) || 0) + (c.total || 0));
    }

    let s = 0;
    const detalleTardes = [];
    for (const [f, v] of ventasDia) {
      if (normales.has(f)) {
        s += v;
      } else if (tardePorFecha.has(f)) {
        const horas = tardePorFecha.get(f);
        const horasTrabajadas = Math.max(0, Math.round((jornada - horas) * 10) / 10);
        const cuenta = Math.round(v * Math.max(0, (jornada - horas) / jornada) * 100) / 100;
        s += cuenta;
        detalleTardes.push({ fecha: f, horas, ventaDia: v, cuenta, horasTrabajadas });
      }
    }
    const trabajados = normales.size + tardesMes.length;
    s += mensual * Math.min(1, trabajados / diasDelMes);
    const total = Math.round(s * 100) / 100;
    return conDetalle ? { total, detalleTardes } : total;
  }

  function mesSiguiente(mes) {
    const [a, m] = mes.split('-').map(Number);
    return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`;
  }

  /* Deuda completa con un trabajador, mes a mes: lo devengado desde que
     empezó (hasta su baja u hoy) menos todo lo entregado. Devuelve el total
     y el desglose por meses para poder verlo en detalle. */
  async function desgloseDeuda(t, pagosT, cierresDeMes, conDetalle = false) {
    const fechas = [t.inicio || '', ...(t.dias || []), ...fechasTardes(t), ...pagosT.map(p => p.fecha || '')]
      .filter(Boolean).sort();
    if (!fechas.length) return { total: 0, meses: [] };
    let mes = fechas[0].slice(0, 7);
    // Hasta el último mes con actividad: si se le paga el finiquito después
    // de la baja (lo normal), ese pago también tiene que descontarse
    const ultimo = [(t.fin || hoyISO()).slice(0, 7), hoyISO().slice(0, 7), fechas[fechas.length - 1].slice(0, 7)]
      .sort().pop();
    const meses = [];
    let total = 0;
    while (mes <= ultimo) {
      const cierresMes = await cierresDeMes(mes);
      // Siempre con detalle: el total sale idéntico (conDetalle solo cambia la
      // forma de devolverlo) y así no hay dos caminos que puedan dar números
      // distintos. Ojo: a calcularMes se le pasa .total, nunca el objeto.
      const ventasDet = ventasParaTrabajador(t, cierresMes, mes, true);
      const pagosMes = pagosT.filter(p => (p.fecha || '').startsWith(mes));
      const calc = calcularMes(t, ventasDet.total, pagosMes, mes);
      const devengado = calc.devengado;
      const entregado = calc.entregado;
      if (devengado || entregado) {
        const fila = { mes, devengado, entregado, saldo: Math.round((devengado - entregado) * 100) / 100 };
        if (conDetalle) { fila.calc = calc; fila.ventasDet = ventasDet; fila.pagos = pagosMes; }
        meses.push(fila);
      }
      total += devengado - entregado;
      mes = mesSiguiente(mes);
    }
    return { total: Math.round(total * 100) / 100, meses };
  }

  async function pendienteTotal(t, pagosT) {
    const cache = new Map();
    const cierresDeMes = async (m) => {
      if (!cache.has(m)) cache.set(m, await DB.buscar({ tipo: 'cierre', desde: m + '-01', hasta: m + '-31' }));
      return cache.get(m);
    };
    return (await desgloseDeuda(t, pagosT, cierresDeMes)).total;
  }

  const DIAS_EN_MEMORIA = 10; // tras abonar, el trabajador pasa al historial

  function diasDesde(iso) {
    return Math.floor((new Date() - new Date(iso + 'T00:00:00')) / 86400000);
  }

  /* Gráfico del mes: barra de ventas por día con los puntos de quién trabajó,
     y la media de ventas de los días de cada uno. */
  function graficoPersonalHTML(trabajadores, cierresMes, mes) {
    const plantilla = trabajadores.filter(t => !t.liquidado);
    const ventasDia = new Map();
    cierresMes.filter(c => !c.mensual).forEach(c => {
      ventasDia.set(c.fecha, Math.round(((ventasDia.get(c.fecha) || 0) + (c.total || 0)) * 100) / 100);
    });
    const fechas = new Set(ventasDia.keys());
    const diasDe = (t) => [...new Set([...(t.dias || []), ...fechasTardes(t)])];
    plantilla.forEach(t => diasDe(t).filter(d => d.startsWith(mes)).forEach(d => fechas.add(d)));
    const lista = [...fechas].sort();
    if (!lista.length) return '<p class="vacio">Aún no hay cierres ni días marcados este mes.</p>';

    const max = Math.max(1, ...ventasDia.values());
    const filas = lista.map(f => {
      const v = ventasDia.get(f) || 0;
      const dots = plantilla
        .filter(t => diasDe(t).includes(f))
        .map(t => pdot(t, trabajadores.indexOf(t))).join('');
      return `
        <div class="fila-mes">
          <span class="mes-etq">día ${+f.slice(8)}</span>
          <div class="barra"><div class="barra-fill" style="width:${Math.max(2, Math.round(v / max * 100))}%"></div></div>
          <span class="mes-val">${v ? INFORME.eur(v) : '—'}</span>
          <span class="pdots">${dots}</span>
        </div>`;
    }).join('');

    const leyenda = plantilla.map(t => `<span class="ley-item">${pdot(t, trabajadores.indexOf(t))} ${escapar(t.nombre)}</span>`).join('');

    const medias = plantilla.map(t => {
      const i = trabajadores.indexOf(t);
      const suyos = diasDe(t).filter(d => d.startsWith(mes) && ventasDia.has(d));
      if (!suyos.length) {
        return `<div class="stat-linea"><span>${pdot(t, i)} ${escapar(t.nombre)}</span><span class="txt-sec">sin días con venta anotada</span></div>`;
      }
      const media = suyos.reduce((s, d) => s + ventasDia.get(d), 0) / suyos.length;
      return `<div class="stat-linea"><span>${pdot(t, i)} ${escapar(t.nombre)} · ${suyos.length} día${suyos.length === 1 ? '' : 's'} con venta</span><strong>media ${INFORME.eur(media)}/día</strong></div>`;
    }).join('');

    // 🏆 Los días que más se facturó en el mes
    const topDias = [...ventasDia.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const medallas = ['🥇', '🥈', '🥉'];
    const topHTML = topDias.map(([f, v], k) => {
      const dots = plantilla.filter(t => diasDe(t).includes(f)).map(t => pdot(t, trabajadores.indexOf(t))).join('');
      return `<div class="stat-linea"><span>${medallas[k]} ${fmtFecha(f)} ${dots}</span><strong>${INFORME.eur(v)}</strong></div>`;
    }).join('');

    // 📅 Media de ventas por día de la semana (qué días se factura más)
    const nombresDias = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    const agg = Array.from({ length: 7 }, () => ({ s: 0, n: 0 }));
    ventasDia.forEach((v, f) => {
      const i = (new Date(f + 'T00:00:00').getDay() + 6) % 7;
      agg[i].s += v;
      agg[i].n++;
    });
    const mediasSemana = agg.map(x => (x.n ? x.s / x.n : 0));
    const maxSemana = Math.max(1, ...mediasSemana);
    const semanaHTML = nombresDias.map((n, i) => agg[i].n ? `
      <div class="fila-mes">
        <span class="mes-etq">${n}</span>
        <div class="barra"><div class="barra-fill" style="width:${Math.max(2, Math.round(mediasSemana[i] / maxSemana * 100))}%"></div></div>
        <span class="mes-val">${INFORME.eur(mediasSemana[i])}</span>
      </div>` : '').join('');

    return `
      ${plantilla.length ? `<div class="ley-personal">${leyenda}</div>` : ''}
      ${filas}
      ${topHTML ? `<p class="hint" style="margin:12px 0 4px">🏆 Los días que más facturaste este mes:</p>${topHTML}` : ''}
      ${semanaHTML.trim() ? `<p class="hint" style="margin:12px 0 4px">📅 Media de ventas por día de la semana:</p>${semanaHTML}` : ''}
      ${plantilla.length ? `<p class="hint" style="margin:12px 0 4px">Media de ventas los días que trabaja cada uno:</p>${medias}` : ''}`;
  }

  /* Comparativa por combinaciones: qué se factura de media los días en que
     trabaja cada uno solo, los dos juntos, etc. */
  function combinacionesHTML(trabajadores, cierresMes, mes) {
    const plantilla = trabajadores.filter(t => !t.liquidado);
    if (!plantilla.length) return '';
    const ventasDia = new Map();
    cierresMes.filter(c => !c.mensual).forEach(c => {
      ventasDia.set(c.fecha, Math.round(((ventasDia.get(c.fecha) || 0) + (c.total || 0)) * 100) / 100);
    });
    if (!ventasDia.size) return '';

    const presencia = plantilla.map(t => new Set([...(t.dias || []), ...fechasTardes(t)]));
    const grupos = new Map(); // "Juan + Ana" → { n, total, quienes }
    for (const [f, v] of ventasDia) {
      const quienes = plantilla.filter((t, i) => presencia[i].has(f));
      const clave = quienes.length ? quienes.map(t => t.nombre).join(' + ') : 'sin-nadie';
      if (!grupos.has(clave)) grupos.set(clave, { n: 0, total: 0, quienes });
      const g = grupos.get(clave);
      g.n++;
      g.total += v;
    }

    const lista = [...grupos.entries()]
      .map(([clave, g]) => ({ clave, ...g, media: g.total / g.n }))
      .sort((a, b) => b.media - a.media);
    const maxMedia = Math.max(1, ...lista.map(g => g.media));
    const medallas = ['🥇', '🥈', '🥉'];

    const filas = lista.map((g, k) => {
      const dots = g.quienes.map(t => pdot(t, trabajadores.indexOf(t))).join('');
      const etiqueta = g.clave === 'sin-nadie'
        ? '<span class="txt-sec">Sin nadie marcado</span>'
        : (g.quienes.length === 1 ? `Solo ${escapar(g.quienes[0].nombre)}` : g.quienes.map(t => escapar(t.nombre)).join(' + '));
      return `
        <div class="combo-linea">
          <div class="combo-etq">${medallas[k] || ''} ${dots} ${etiqueta} <small class="txt-sec">· ${g.n} día${g.n === 1 ? '' : 's'}</small></div>
          <div class="fila-mes">
            <div class="barra"><div class="barra-fill" style="width:${Math.max(2, Math.round(g.media / maxMedia * 100))}%"></div></div>
            <span class="mes-val"><strong>${INFORME.eur(g.media)}</strong>/día</span>
          </div>
        </div>`;
    }).join('');

    return `
      <p class="hint" style="margin:0 0 6px">🧩 <strong>Media de ventas según quién trabaja</strong> — compara los días de cada uno solo y los días juntos:</p>
      ${filas}
      <div style="margin-bottom:14px"></div>`;
  }

  /* Rentabilidad de cada empleado activo: su coste del mes (fijo + comisión)
     frente a las ventas de sus días trabajados. */
  function rentabilidadHTML(trabajadores, cierresMes, mes) {
    const plantilla = trabajadores.filter(t => !t.liquidado && !t.fin);
    if (!plantilla.length) return '<p class="vacio">Sin empleados activos.</p>';

    const datos = plantilla.map(t => {
      const ventas = ventasParaTrabajador(t, cierresMes, mes);
      const c = calcularMes(t, ventas, [], mes);
      return { t, ventas, coste: c.devengado, dias: c.dias.length };
    });
    const conDatos = datos.filter(d => d.coste > 0 && d.ventas > 0)
      .sort((a, b) => b.ventas / b.coste - a.ventas / a.coste);
    const sinDatos = datos.filter(d => !(d.coste > 0 && d.ventas > 0));
    const medallas = ['🥇', '🥈', '🥉'];

    const filas = conDatos.map((d, k) => {
      const retorno = Math.round((d.ventas / d.coste) * 10) / 10;
      const pct = Math.round((d.coste / d.ventas) * 1000) / 10;
      const mediaDia = d.dias ? d.ventas / d.dias : 0;
      const costeDia = d.dias ? d.coste / d.dias : 0;
      return `
        <div class="renta-item">
          <div class="renta-cab">${medallas[k] || ''} ${pdot(d.t, trabajadores.indexOf(d.t))} <strong>${escapar(d.t.nombre)}</strong> <small class="txt-sec">· ${d.dias} día${d.dias === 1 ? '' : 's'} trabajado${d.dias === 1 ? '' : 's'}</small></div>
          <div class="stat-linea"><span><strong>Vende de media por día trabajado</strong></span><strong>${INFORME.eur(mediaDia)}/día</strong></div>
          <div class="stat-linea"><span>Te cuesta de media por día</span><strong>${INFORME.eur(costeDia)}/día</strong></div>
          <div class="stat-linea"><span>Total del mes: coste / ventas en sus días</span><span>${INFORME.eur(d.coste)} / ${INFORME.eur(d.ventas)}</span></div>
          <div class="stat-linea"><span>Rentabilidad</span><span style="text-align:right">por cada <strong>1 €</strong> que le pagas entran <strong>${retorno.toLocaleString('es-ES')} €</strong><br><small class="txt-sec">su coste es el ${pct.toLocaleString('es-ES')} % de lo que se vende con él</small></span></div>
        </div>`;
    }).join('');

    const otros = sinDatos.map(d =>
      `<div class="stat-linea"><span>${pdot(d.t, trabajadores.indexOf(d.t))} ${escapar(d.t.nombre)}</span><span class="txt-sec">sin días marcados o sin ventas este mes</span></div>`
    ).join('');

    const cuerpo = filas + otros;
    return combinacionesHTML(trabajadores, cierresMes, mes) +
      (cuerpo || '<p class="vacio">Marca los días trabajados y anota los cierres para poder medir.</p>');
  }

  /* Texto neutro con lo del trabajador, para enviarle por WhatsApp.
     Sin nombre del negocio, del dueño ni de la app. */
  function resumenTexto(t, c, deuda, pagosT, mes) {
    const lineas = [];
    lineas.push(`Resumen de ${t.nombre} — ${mesEnLetras(mes + '-01')}`);
    lineas.push('');
    lineas.push(`Días trabajados: ${c.dias.length}` +
      (c.tardes.length ? ` (⏰ ${c.tardes.length} con retraso${c.horasTarde ? `, ${c.horasTarde} h` : ''})` : '') +
      (c.faltas.length ? ` · Faltas: ${c.faltas.length}` : ''));
    lineas.push(`Corresponde este mes: ${INFORME.eur(c.devengado)}`);
    const pagosMes = pagosT.filter(p => (p.fecha || '').startsWith(mes));
    lineas.push(`Recibido este mes: ${INFORME.eur(c.entregado)}`);
    pagosMes.forEach(p => lineas.push(`  · ${fmtFecha(p.fecha)}: ${INFORME.eur(p.importe)}${p.notas ? ` (${p.notas})` : ''}`));
    const arrastre = Math.round((deuda.total - c.pendiente) * 100) / 100;
    if (Math.abs(arrastre) >= 0.01) {
      lineas.push(arrastre > 0
        ? `Pendiente de meses anteriores: ${INFORME.eur(arrastre)}`
        : `Recibido de más en meses anteriores: ${INFORME.eur(-arrastre)}`);
    }
    lineas.push('');
    lineas.push(deuda.total >= 0
      ? `PENDIENTE TOTAL A DÍA DE HOY: ${INFORME.eur(deuda.total)}`
      : `RECIBIDO DE MÁS (a devolver o descontar): ${INFORME.eur(-deuda.total)}`);
    return lineas.join('\n');
  }

  /* Las líneas de "la cuenta bien explicada" de un mes: de dónde sale cada
     número, paso a paso. Se usan igual en la ficha de un trabajador en activo
     y en la de uno ya liquidado, para que digan exactamente lo mismo. */
  function explicacionLineas(t, c, ventasDet, pasado = false) {
    const fijoDia = (t.sueldoMensual || 0) / (t.diasMes || 26);
    const jornada = t.horasJornada || 7.5;
    const ventasT = ventasDet.total;
    const ex = [];
    ex.push(`Precio del día: ${INFORME.eur(t.sueldoMensual || 0)} ÷ ${t.diasMes || 26} días = <strong>${INFORME.eur(fijoDia)}</strong>`);
    ex.push(`Fijo: ${c.dias.length} día${c.dias.length === 1 ? '' : 's'} trabajado${c.dias.length === 1 ? '' : 's'} × ${INFORME.eur(fijoDia)} = ${INFORME.eur(Math.round(fijoDia * c.dias.length * 100) / 100)}`);
    c.tardes.filter(x => x.horas > 0).forEach(x => {
      ex.push(`⏰ ${fmtFecha(x.fecha)}: llegó ${x.horas} h tarde → se descuentan ${INFORME.eur(Math.round(fijoDia * Math.min(1, x.horas / jornada) * 100) / 100)} del fijo`);
    });
    ventasDet.detalleTardes.filter(l => l.horas > 0).forEach(l => {
      ex.push(`⏰ ${fmtFecha(l.fecha)}: la venta del día fue ${INFORME.eur(l.ventaDia)}, pero solo estuvo ${l.horasTrabajadas} de ${jornada} h → para su objetivo cuentan ${INFORME.eur(l.ventaDia)} ÷ ${jornada} × ${l.horasTrabajadas} = <strong>${INFORME.eur(l.cuenta)}</strong>`);
    });
    if (tramosDe(t).length) {
      ex.push(`Ventas que cuentan para su objetivo: <strong>${INFORME.eur(ventasT)}</strong> (solo sus días; los de retraso, en proporción)`);
      ex.push(c.tramoActual
        ? `Objetivo de ${INFORME.eur(c.tramoActual.objetivo)} alcanzado → ${c.tramoActual.porcentaje} % de ${INFORME.eur(ventasT)} = <strong>${INFORME.eur(c.comision)}</strong>`
        : `No llegó al objetivo${c.siguiente ? ` de ${INFORME.eur(c.siguiente.objetivo)}` : ''} → sin comisión: cobra solo el fijo pactado`);
    }
    ex.push(`${pasado ? 'Le correspondió ese mes' : 'Le corresponde el mes'}: fijo ${INFORME.eur(c.fijo)} + comisión ${INFORME.eur(c.comision)} = <strong>${INFORME.eur(c.devengado)}</strong>`);
    return ex;
  }

  /* Las mismas líneas, plegadas, tal como salen en la ficha de un activo. */
  function explicacionPlegada(t, c, ventasDet) {
    return `
        <details class="ocr-details" style="margin:8px 0 0">
          <summary>📖 Ver la cuenta bien explicada (para enseñársela)</summary>
          ${explicacionLineas(t, c, ventasDet).map(l => `<div class="stat-linea"><span style="width:100%">${l}</span></div>`).join('')}
        </details>`;
  }

  /* Texto con TODA su cuenta (no solo un mes), para enviárselo al trabajador.
     Neutro a propósito: solo sus datos, nada del negocio ni de quien lo manda. */
  function resumenTextoCompleto(t, deuda, pagosT) {
    const lineas = [];
    lineas.push(`Cuenta completa de ${t.nombre}`);
    if (t.inicio || t.fin) {
      lineas.push(`${t.inicio ? 'Del ' + fmtFecha(t.inicio) : ''}${t.fin ? ' al ' + fmtFecha(t.fin) : ''}`.trim());
    }
    lineas.push('');
    lineas.push('LO QUE LE CORRESPONDIÓ, MES A MES');
    deuda.meses.forEach(m => {
      const c = m.calc;
      const dias = c ? `${c.dias.length} día${c.dias.length === 1 ? '' : 's'} · ` : '';
      const detalle = c ? `fijo ${INFORME.eur(c.fijo)} + comisión ${INFORME.eur(c.comision)} = ` : '';
      lineas.push(`${mesEnLetras(m.mes + '-01')}: ${dias}${detalle}${INFORME.eur(m.devengado)}`);
    });
    const correspondio = Math.round(deuda.meses.reduce((s, m) => s + m.devengado, 0) * 100) / 100;
    lineas.push(`Total que le correspondió: ${INFORME.eur(correspondio)}`);
    lineas.push('');
    lineas.push('LO QUE SE LE PAGÓ');
    if (!pagosT.length) lineas.push('(no hay ninguna entrega apuntada)');
    pagosT.forEach(p => {
      lineas.push(`${p.fecha ? fmtFecha(p.fecha) : 'sin fecha'}: ${INFORME.eur(p.importe)}${p.notas ? ` (${p.notas})` : ''}`);
    });
    const pagado = Math.round(pagosT.reduce((s, p) => s + (p.importe || 0), 0) * 100) / 100;
    lineas.push(`Total pagado: ${INFORME.eur(pagado)}`);
    lineas.push('');
    const dif = Math.round((correspondio - pagado) * 100) / 100;
    lineas.push(Math.abs(dif) < 0.01
      ? 'CUADRE: está todo pagado, no queda nada pendiente.'
      : (dif > 0 ? `CUADRE: queda pendiente ${INFORME.eur(dif)}.`
                 : `CUADRE: se pagaron ${INFORME.eur(-dif)} de más.`));
    return lineas.join('\n');
  }

  /* Ficha completa de un trabajador ya liquidado: cada entrega que se le hizo y
     de dónde sale cada número, mes a mes. Es la MISMA ficha en la lista (los
     primeros días) y en el historial, para que no puedan decir cosas distintas.
     No mira el mes elegido arriba: cubre toda su etapa.
     Devuelve el HTML y el texto neutro para enviárselo. */
  async function fichaLiquidacionHTML(t, i, pagosT, cierresDeMes, pie = '') {
    const totalPagado = r2(pagosT.reduce((s, p) => s + (p.importe || 0), 0));
    const abierta = perAbiertos.has(t.sid);
    const cabecera = `
        <div class="per-cab per-toggle" data-sid="${t.sid}">
          <div style="min-width:0">
            <div class="stat-prov-nombre">${pdot(t, i)} ${escapar(t.nombre)}</div>
            <div class="stat-prov-nif">Trabajó ${t.inicio ? 'del ' + fmtFecha(t.inicio) : ''}${t.fin ? ' al ' + fmtFecha(t.fin) : ''} · ✔️ liquidado el ${fmtFecha(t.liquidado)}</div>
          </div>
          <div class="per-resumen-cab"><strong class="txt-ok">${INFORME.eur(totalPagado)}</strong><span class="per-flecha">${abierta ? '▲' : '▼'}</span></div>
        </div>`;

    // Cerrada no se calcula nada: así el historial no rehace todas las cuentas
    // cada vez que tocas cualquier cosa en la pestaña.
    if (!abierta) {
      return {
        texto: '',
        html: `
        <div class="prov-form per-card">
          ${cabecera}
          <p class="hint" style="margin:8px 0 0">Toca su nombre para ver todo lo que le pagaste y cómo se calculó.</p>
          ${pie}
        </div>`
      };
    }

    const deuda = await desgloseDeuda(t, pagosT, cierresDeMes, true);
    const correspondio = r2(deuda.meses.reduce((s, m) => s + m.devengado, 0));
    const diferencia = r2(correspondio - totalPagado);

    // Una entrega sin fecha suma en el total pero no cae en ningún mes: hay que
    // decirlo, en vez de enseñar un cuadre que no cuadra sin explicar por qué.
    const repartido = r2(deuda.meses.reduce((s, m) => s + m.entregado, 0));
    const sinFecha = pagosT.filter(p => !p.fecha).length;
    const avisoSinFecha = (sinFecha || Math.abs(repartido - totalPagado) >= 0.01)
      ? `<p class="hint txt-bad" style="margin:6px 0 0">⚠️ Hay ${sinFecha || 1} entrega(s) sin fecha, por eso el reparto mes a mes no suma lo mismo que el total. Ponles fecha para que la cuenta cuadre.</p>`
      : '';

    let cuadreTxt, cuadreClase;
    if (Math.abs(diferencia) < 0.01) { cuadreTxt = '✓ Cuadra: no quedó nada pendiente'; cuadreClase = 'txt-ok'; }
    else if (diferencia > 0) { cuadreTxt = 'Quedó sin pagarle ' + INFORME.eur(diferencia); cuadreClase = 'txt-bad'; }
    else { cuadreTxt = 'Se le pagó de más ' + INFORME.eur(-diferencia); cuadreClase = 'txt-sec'; }

    const esFiniquito = (p) => p.finiquito === true || /finiquito|liquidación final/i.test(p.notas || '');
    const filaPago = (p) => `
          <div class="per-pago">
            <span>${p.fecha ? fmtFecha(p.fecha) : '⚠️ sin fecha'}${esFiniquito(p) ? ' · 🏁' : ''}${p.notas ? ' · ' + escapar(p.notas) : ''}</span>
            <span>${INFORME.eur(p.importe)}</span>
          </div>`;

    const pagosHTML = pagosT.length
      ? pagosT.map(filaPago).join('')
      : '<p class="vacio" style="padding:6px">No hay ninguna entrega apuntada a su nombre.</p>';

    const mesesHTML = deuda.meses.map(m => {
      const c = m.calc;
      const saldoTxt = Math.abs(m.saldo) < 0.01
        ? 'cuadró ✓'
        : (m.saldo > 0 ? 'quedó debiendo ' + INFORME.eur(m.saldo) : 'le diste ' + INFORME.eur(-m.saldo) + ' de más');
      const notasMes = (t.notasDias || []).filter(n => (n.fecha || '').startsWith(m.mes))
        .sort((a, b) => a.fecha.localeCompare(b.fecha));
      return `
          <details class="ocr-details">
            <summary>${mesEnLetras(m.mes + '-01')} · le correspondió ${INFORME.eur(m.devengado)} · le diste ${INFORME.eur(m.entregado)} · ${saldoTxt}</summary>
            ${calendarioHTML(t, m.mes, true)}
            <div class="stat-linea"><span>Asistencia</span><span>${c.dias.length} día${c.dias.length === 1 ? '' : 's'} trabajado${c.dias.length === 1 ? '' : 's'}${c.tardes.length ? ` · <strong class="txt-oro">⏰ ${c.tardes.length}</strong>` : ''}${c.faltas.length ? ` · <strong class="txt-bad">${c.faltas.length} falta${c.faltas.length === 1 ? '' : 's'}</strong>` : ''}</span></div>
            ${c.descuentoTardes > 0 ? `<div class="stat-linea"><span>Descuento por retrasos (${c.horasTarde} h de ${t.horasJornada || 7.5} h/jornada)</span><strong class="txt-bad">−${INFORME.eur(c.descuentoTardes)}</strong></div>` : ''}
            <p class="per-seccion">📖 De dónde sale cada número</p>
            ${explicacionLineas(t, c, m.ventasDet, true).map(l => `<div class="stat-linea"><span style="width:100%">${l}</span></div>`).join('')}
            <p class="per-seccion">💶 Lo que le diste ese mes</p>
            ${m.pagos.length ? m.pagos.map(filaPago).join('') : '<p class="vacio" style="padding:6px">Ese mes no le diste nada.</p>'}
            ${notasMes.length ? `<p class="per-seccion">📝 Notas de ese mes</p>${notasMes.map(n => `<div class="per-pago"><span>📝 ${fmtFecha(n.fecha)} · ${escapar(n.texto)}</span></div>`).join('')}` : ''}
          </details>`;
    }).join('');

    return {
      texto: resumenTextoCompleto(t, deuda, pagosT),
      html: `
        <div class="prov-form per-card">
          ${cabecera}
          <div class="per-body">
            <div class="per-baja">
              <div>✔️ Abonado y liquidado el <strong>${fmtFecha(t.liquidado)}</strong></div>
              <div>Esta ficha es tu prueba: cada entrega que le hiciste y de dónde sale cada número. Aquí no se puede cambiar nada; si necesitas corregir algo, usa «Reabrir su ficha» al final.</div>
            </div>

            <p class="per-seccion">📌 El resumen que cuadra</p>
            <div class="stat-linea"><span>Le correspondió en todo su tiempo</span><strong>${INFORME.eur(correspondio)}</strong></div>
            <div class="stat-linea"><span>Le pagaste en total (todas las entregas)</span><strong>${INFORME.eur(totalPagado)}</strong></div>
            <div class="stat-linea"><span>Diferencia</span><strong class="${cuadreClase}">${cuadreTxt}</strong></div>
            ${avisoSinFecha}

            <p class="per-seccion">💶 Todo lo que le pagaste (${pagosT.length} entrega${pagosT.length === 1 ? '' : 's'})</p>
            ${pagosHTML}
            <div class="stat-linea"><span><strong>TOTAL PAGADO</strong></span><strong>${INFORME.eur(totalPagado)}</strong></div>

            <p class="per-seccion">📅 Mes a mes, con la cuenta explicada</p>
            ${mesesHTML || '<p class="vacio" style="padding:6px">No hay ningún mes con movimiento.</p>'}

            <div class="form-actions">
              <button class="btn btn-small per-compartir" data-sid="${t.sid}">📤 Enviar su cuenta completa (WhatsApp…)</button>
              <button class="btn btn-small per-reabrir" data-sid="${t.sid}">↩️ Reabrir su ficha (corregir algo)</button>
            </div>
            ${pie}
          </div>
        </div>`
    };
  }

  async function pintarPersonal() {
    if (!$('#per-mes').value) $('#per-mes').value = hoyISO().slice(0, 7);
    const mes = mesPersonal();
    const [trabajadores, pagos, cierresMes] = await Promise.all([
      DB.perTodos(), DB.pagoTodos(),
      DB.buscar({ tipo: 'cierre', desde: mes + '-01', hasta: mes + '-31' })
    ]);
    const ventasNegocio = Math.round(cierresMes.reduce((s, r) => s + (r.total || 0), 0) * 100) / 100;

    $('#per-ventas').innerHTML =
      `Ventas del negocio en ${mesEnLetras(mes + '-01')}: <strong class="ingreso">${INFORME.eur(ventasNegocio)}</strong> (según tus cierres)`;

    const activos = trabajadores.filter(t => !t.liquidado || diasDesde(t.liquidado) < DIAS_EN_MEMORIA);
    const historial = trabajadores.filter(t => t.liquidado && diasDesde(t.liquidado) >= DIAS_EN_MEMORIA)
      .sort((a, b) => (b.liquidado || '').localeCompare(a.liquidado || ''));

    const cacheCierres = new Map([[mes, cierresMes]]);
    const cierresDeMes = async (m) => {
      if (!cacheCierres.has(m)) cacheCierres.set(m, await DB.buscar({ tipo: 'cierre', desde: m + '-01', hasta: m + '-31' }));
      return cacheCierres.get(m);
    };

    const div = $('#per-lista');
    const tarjetas = [];
    const resumenes = new Map(); // sid → texto para compartir
    const general = []; // visión general del equipo
    for (const t of activos) {
      const i = trabajadores.indexOf(t);
      const pagosT = pagos.filter(p => p.trabajadorSid === t.sid)
        .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
      const pagosMes = pagosT.filter(p => (p.fecha || '').startsWith(mes));

      // Ya abonado: ficha completa para poder comprobar sus pagos y sus cuentas
      if (t.liquidado) {
        const pieMemoria = `<p class="hint" style="margin:8px 0 0">Pasará al historial en ${Math.max(1, DIAS_EN_MEMORIA - diasDesde(t.liquidado))} día(s). Allí seguirás teniendo toda esta información.</p>`;
        const ficha = await fichaLiquidacionHTML(t, i, pagosT, cierresDeMes, pieMemoria);
        if (ficha.texto) resumenes.set(t.sid, ficha.texto);
        tarjetas.push(ficha.html);
        continue;
      }

      const ventasDet = ventasParaTrabajador(t, cierresMes, mes, true);
      const ventasT = ventasDet.total;
      const c = calcularMes(t, ventasT, pagosMes, mes);
      const abierta = perAbiertos.has(t.sid);

      // 📖 La cuenta bien explicada, paso a paso (para enseñársela al empleado)
      const explicaHTML = explicacionPlegada(t, c, ventasDet);

      const comisionTxt = c.tramoActual
        ? `✅ Objetivo de ${INFORME.eur(c.tramoActual.objetivo)} alcanzado → ${c.tramoActual.porcentaje} % = <strong>${INFORME.eur(c.comision)}</strong>`
        : (tramosDe(t).length ? 'Aún sin objetivo alcanzado: solo el fijo pactado' : 'Sin comisiones pactadas');
      const notaVentas = tramosDe(t).length
        ? `<p class="hint" style="margin:2px 0 0">Para su objetivo cuentan las ventas de sus días trabajados (los de retraso, en proporción a sus horas): <strong>${INFORME.eur(ventasT)}</strong> este mes.</p>` : '';
      const siguienteTxt = c.siguiente
        ? `<div class="per-siguiente">Faltan <strong>${INFORME.eur(Math.max(0, c.siguiente.objetivo - ventasT))}</strong> de ventas para el ${c.tramoActual ? 'siguiente' : 'primer'} objetivo (${INFORME.eur(c.siguiente.objetivo)} → ${c.siguiente.porcentaje} %)</div>`
        : '';

      // Deuda TOTAL con él (este mes + lo arrastrado de meses anteriores)
      const deuda = await desgloseDeuda(t, pagosT, cierresDeMes);
      const arrastre = Math.round((deuda.total - c.pendiente) * 100) / 100;

      // Dado de baja pero aún sin abonar: finiquito total pendiente
      let bajaHTML = '';
      if (t.fin) {
        bajaHTML = `
          <div class="per-baja">
            <div>🚪 Dejó de trabajar el <strong>${fmtFecha(t.fin)}</strong></div>
            <div class="stat-linea"><span>${deuda.total > 0 ? 'DEBES PAGARLE (todo lo pendiente)' : 'No le debes nada'}</span><strong class="${deuda.total > 0 ? 'txt-bad' : 'txt-ok'}">${INFORME.eur(Math.max(0, deuda.total))}</strong></div>
            <button class="btn btn-primary per-abonar" data-sid="${t.sid}">✔️ ${deuda.total > 0 ? 'Abonar ' + INFORME.eur(deuda.total) + ' y liquidar' : 'Marcar como liquidado'}</button>
          </div>`;
      }

      // Resumen para la cabecera de la ficha (visible siempre): la deuda TOTAL
      let resumenCab;
      if (t.fin) {
        resumenCab = deuda.total > 0
          ? `<strong class="txt-bad">Finiquito: ${INFORME.eur(deuda.total)}</strong>`
          : '<strong class="txt-ok">✓ Sin deuda</strong>';
      } else if (deuda.total > 0) {
        resumenCab = `<strong class="txt-bad">Le debes ${INFORME.eur(deuda.total)}</strong>`;
      } else if (deuda.total < 0) {
        resumenCab = `<strong class="txt-sec">Adelantado ${INFORME.eur(-deuda.total)}</strong>`;
      } else {
        resumenCab = '<strong class="txt-ok">✓ Al día</strong>';
      }

      // Desglose mes a mes (vista detallada, plegada)
      const filasMeses = deuda.meses.map(m => `
        <div class="stat-linea"><span>${mesEnLetras(m.mes + '-01')}: le correspondió ${INFORME.eur(m.devengado)} · le diste ${INFORME.eur(m.entregado)}</span><strong class="${m.saldo > 0 ? 'txt-bad' : (m.saldo < 0 ? 'txt-sec' : 'txt-ok')}">${m.saldo > 0 ? 'quedó debiendo ' : (m.saldo < 0 ? 'de más ' : '')}${m.saldo === 0 ? '✓' : INFORME.eur(Math.abs(m.saldo))}</strong></div>`).join('');
      const entregadoTotal = Math.round(pagosT.reduce((s, p) => s + (p.importe || 0), 0) * 100) / 100;

      const notasMes = (t.notasDias || []).map((n, idx) => ({ ...n, idx }))
        .filter(n => (n.fecha || '').startsWith(mes))
        .sort((a, b) => a.fecha.localeCompare(b.fecha));
      const notasHTML = notasMes.map(n => `
        <div class="per-pago">
          <span>📝 ${fmtFecha(n.fecha)} · ${escapar(n.texto)}</span>
          <button class="btn btn-small nota-borrar" data-sid="${t.sid}" data-idx="${n.idx}" title="Eliminar">🗑️</button>
        </div>`).join('');

      const pagosHTML = pagosMes.length
        ? pagosMes.map(p => `
            <div class="per-pago">
              <span>${fmtFecha(p.fecha)}${p.notas ? ' · ' + escapar(p.notas) : ''}</span>
              <span>${INFORME.eur(p.importe)} <button class="btn btn-small pago-borrar" data-id="${p.id}" title="Eliminar">🗑️</button></span>
            </div>`).join('')
        : '<p class="vacio" style="padding:6px">Sin entregas este mes.</p>';

      resumenes.set(t.sid, resumenTexto(t, c, deuda, pagosT, mes));
      general.push({ t, i, dias: c.dias.length, entregadoMes: c.entregado, deudaTotal: deuda.total });

      tarjetas.push(`
        <div class="prov-form per-card">
          <div class="per-cab per-toggle" data-sid="${t.sid}">
            <div style="min-width:0">
              <div class="stat-prov-nombre">${pdot(t, i)} ${escapar(t.nombre)}</div>
              ${t.inicio ? `<div class="stat-prov-nif">Trabaja desde el ${fmtFecha(t.inicio)}</div>` : ''}
            </div>
            <div class="per-resumen-cab">${resumenCab}<span class="per-flecha">${abierta ? '▲' : '▼'}</span></div>
          </div>
          <div class="per-body ${abierta ? '' : 'hidden'}">
            ${bajaHTML}
            <p class="per-seccion">📅 Días del mes</p>
            ${calendarioHTML(t, mes)}
            <div class="stat-linea"><span>Asistencia del mes</span><span>${c.dias.length} trabajado${c.dias.length === 1 ? '' : 's'}${c.tardes.length ? ` · <strong class="txt-oro">⏰ ${c.tardes.length} tarde${c.tardes.length === 1 ? '' : 's'}${c.horasTarde ? ` (${c.horasTarde} h)` : ''}</strong>` : ''}${c.faltas.length ? ` · <strong class="txt-bad">${c.faltas.length} falta${c.faltas.length === 1 ? '' : 's'}</strong>` : ''}</span></div>
            <div class="stat-linea"><span>Fijo: ${c.dias.length} día${c.dias.length === 1 ? '' : 's'} × ${INFORME.eur((t.sueldoMensual || 0) / (t.diasMes || 26))} <small class="txt-sec">(${INFORME.eur(t.sueldoMensual || 0)} ÷ ${t.diasMes || 26})</small></span><strong>${INFORME.eur(c.fijo)}</strong></div>
            ${c.descuentoTardes > 0 ? `<div class="stat-linea"><span>Descuento por retrasos (${c.horasTarde} h de ${t.horasJornada || 7.5} h/jornada)</span><strong class="txt-bad">−${INFORME.eur(c.descuentoTardes)}</strong></div>` : ''}
            <div class="stat-linea"><span>Comisión</span><span style="text-align:right">${comisionTxt}</span></div>
            ${notaVentas}
            ${siguienteTxt}
            <div class="stat-linea per-pendiente ${deuda.total > 0 ? '' : 'ok'}"><span>${deuda.total >= 0 ? 'LE DEBES EN TOTAL' : 'TE DEBE (adelantado de más)'}</span><strong>${INFORME.eur(Math.abs(deuda.total))}</strong></div>
            <div class="stat-linea"><span>Entregado en total (todos los adelantos y pagas)</span><strong>${INFORME.eur(entregadoTotal)}</strong></div>
            <details class="ocr-details" style="margin:6px 0 0">
              <summary>Ver el detalle (este mes y mes a mes)</summary>
              <div class="stat-linea"><span>Le corresponde este mes</span><strong>${INFORME.eur(c.devengado)}</strong></div>
              <div class="stat-linea"><span>Le has dado este mes</span><strong>${INFORME.eur(c.entregado)}</strong></div>
              <div class="stat-linea"><span>Saldo de este mes</span><strong class="${c.pendiente > 0 ? 'txt-bad' : 'txt-sec'}">${INFORME.eur(c.pendiente)}</strong></div>
              ${arrastre !== 0 ? `<div class="stat-linea"><span>Arrastre de meses anteriores</span><strong class="${arrastre > 0 ? 'txt-bad' : 'txt-sec'}">${arrastre > 0 ? '+' : ''}${INFORME.eur(arrastre)}</strong></div>` : ''}
              ${filasMeses}
            </details>
            ${explicaHTML}

            <p class="per-seccion">💶 Adelantos y pagos que le haces</p>
            <div class="form-row">
              <div class="form-group"><input type="date" class="pago-fecha" value="${hoyISO()}"></div>
              <div class="form-group"><input type="number" class="pago-importe" step="0.01" min="0" placeholder="€"></div>
            </div>
            <div class="form-row">
              <div class="form-group"><input type="text" class="pago-notas" placeholder="Nota (opcional): adelanto, paga…"></div>
            </div>
            <button class="btn btn-secondary pago-apuntar" data-sid="${t.sid}">➕ Apuntar entrega</button>
            <div style="margin-top:8px">${pagosHTML}</div>

            <p class="per-seccion">📝 Nota de un día (si pasó algo)</p>
            <div class="form-row">
              <div class="form-group"><input type="date" class="nota-fecha" value="${hoyISO()}"></div>
              <div class="form-group"><input type="text" class="nota-texto" placeholder="Qué pasó ese día"></div>
            </div>
            <button class="btn btn-small nota-apuntar" data-sid="${t.sid}">📝 Apuntar nota</button>
            ${notasHTML ? `<div style="margin-top:6px">${notasHTML}</div>` : ''}

            <div class="form-actions">
              <button class="btn btn-small per-compartir" data-sid="${t.sid}">📤 Enviar su resumen (WhatsApp…)</button>
              <button class="btn btn-small per-editar" data-id="${t.id}">✏️ Editar ficha (sueldo, objetivos, días…)</button>
              ${t.fin ? '' : `<button class="btn btn-small per-dar-baja" data-id="${t.id}">🚪 Dar de baja (dejó de trabajar)</button>`}
            </div>
          </div>
        </div>`);
    }
    div.innerHTML = tarjetas.length ? tarjetas.join('') : '<p class="vacio">Aún no tienes trabajadores dados de alta.</p>';

    // 👀 Visión general del equipo: una línea por empleado + totales
    const totalDeuda = general.reduce((s, g) => s + Math.max(0, g.deudaTotal), 0);
    const totalEntregadoMes = Math.round(general.reduce((s, g) => s + g.entregadoMes, 0) * 100) / 100;
    $('#per-general').innerHTML = general.length ? `
      <div class="prov-form" style="margin-bottom:12px">
        <p class="per-seccion" style="border:none;padding-top:0;margin-top:0">👀 Visión general del equipo <small class="txt-sec" style="text-transform:none;letter-spacing:0">(toca uno para ver su detalle)</small></p>
        ${general.map(g => `
          <div class="stat-linea per-gen-fila" data-sid="${g.t.sid}" style="cursor:pointer">
            <span>${pdot(g.t, g.i)} ${escapar(g.t.nombre)} <small class="txt-sec">· ${g.dias} día${g.dias === 1 ? '' : 's'} este mes</small></span>
            ${g.deudaTotal > 0
              ? `<strong class="txt-bad">debes ${INFORME.eur(g.deudaTotal)}</strong>`
              : (g.deudaTotal < 0 ? `<strong class="txt-sec">adelantado ${INFORME.eur(-g.deudaTotal)}</strong>` : '<strong class="txt-ok">✓ al día</strong>')}
          </div>`).join('')}
        <div class="stat-linea"><span><strong>TOTAL QUE DEBES AL EQUIPO</strong></span><strong class="${totalDeuda > 0 ? 'txt-bad' : 'txt-ok'}" style="font-size:1.05rem">${INFORME.eur(totalDeuda)}</strong></div>
        <div class="stat-linea"><span>Entregado este mes (entre todos)</span><strong>${INFORME.eur(totalEntregadoMes)}</strong></div>
      </div>` : '';

    $('#per-general').querySelectorAll('.per-gen-fila').forEach(fila => {
      fila.addEventListener('click', () => {
        perAbiertos.add(fila.dataset.sid);
        pintarPersonal().then(() => {
          const el = document.querySelector(`.per-toggle[data-sid="${fila.dataset.sid}"]`);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    });

    // Gráfico del mes, rentabilidad e historial de antiguos
    $('#per-grafico').innerHTML = graficoPersonalHTML(trabajadores, cierresMes, mes);
    $('#per-renta').innerHTML = rentabilidadHTML(trabajadores, cierresMes, mes);
    // Historial: la MISMA ficha completa, lo más reciente arriba
    const fichasHist = [];
    for (const t of historial) {
      const pagosT = pagos.filter(p => p.trabajadorSid === t.sid)
        .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
      const ficha = await fichaLiquidacionHTML(t, trabajadores.indexOf(t), pagosT, cierresDeMes);
      if (ficha.texto) resumenes.set(t.sid, ficha.texto);
      fichasHist.push(ficha.html);
    }
    $('#per-historial').innerHTML = fichasHist.length
      ? fichasHist.join('')
      : '<p class="vacio">Sin trabajadores antiguos todavía.</p>';

    // Los mismos botones tienen que funcionar en las fichas de arriba y en las
    // del historial. OJO: esto va DESPUÉS de pintar los dos contenedores.
    const cajasPer = [div, $('#per-historial')];
    const enCajas = (sel, fn) => cajasPer.forEach(c => c.querySelectorAll(sel).forEach(fn));

    // Abrir / cerrar la ficha de cada empleado
    enCajas('.per-toggle', cab => {
      cab.addEventListener('click', () => {
        const sid = cab.dataset.sid;
        if (perAbiertos.has(sid)) perAbiertos.delete(sid);
        else perAbiertos.add(sid);
        pintarPersonal();
      });
    });

    // Día del calendario: 1 toque = trabajó, 2 = faltó, 3 = nada
    enCajas('.cal:not(.cal-lectura) .dia', btn => {
      btn.addEventListener('click', guardarConAviso(async () => {
        const t = (await DB.perTodos()).find(x => x.sid === btn.dataset.sid);
        if (!t) return;
        if (t.liquidado) {
          toast('Su cuenta ya está liquidada. Para cambiar algo, pulsa antes «Reabrir su ficha».', 4500);
          return;
        }
        const f = btn.dataset.fecha;
        const dias = new Set(t.dias || []);
        const tardes = tardesDe(t);
        const faltas = new Set(t.faltas || []);
        const iTarde = tardes.findIndex(x => x.fecha === f);
        if (dias.has(f)) {
          // trabajó → llegó tarde: preguntar cuántas horas para descontar la parte del día
          dias.delete(f);
          const resp = prompt('⏰ ¿Cuántas horas llegó tarde ese día?\n(0 = se le paga el día entero igualmente)', '1');
          const horas = Math.max(0, parseFloat(String(resp || '0').replace(',', '.')) || 0);
          tardes.push({ fecha: f, horas });
        } else if (iTarde >= 0) {
          tardes.splice(iTarde, 1); faltas.add(f);                  // tarde → faltó
        } else if (faltas.has(f)) {
          faltas.delete(f);                                          // faltó → nada
        } else {
          dias.add(f);                                               // nada → trabajó
        }
        t.dias = [...dias].sort();
        t.tardes = tardes.sort((a, b) => a.fecha.localeCompare(b.fecha));
        t.faltas = [...faltas].sort();
        await DB.perGuardar(t);
        pintarPersonal();
      }));
    });

    // Apuntar nota de un día
    enCajas('.nota-apuntar', btn => {
      btn.addEventListener('click', guardarConAviso(async () => {
        const card = btn.closest('.per-card');
        const fecha = card.querySelector('.nota-fecha').value;
        const texto = card.querySelector('.nota-texto').value.trim();
        if (!fecha) { toast('⚠️ Falta la fecha de la nota.'); return; }
        if (!texto) { toast('⚠️ Escribe la nota.'); return; }
        const t = (await DB.perTodos()).find(x => x.sid === btn.dataset.sid);
        if (!t) return;
        t.notasDias = [...(t.notasDias || []), { fecha, texto }];
        await DB.perGuardar(t);
        toast('📝 Nota apuntada.');
        pintarPersonal();
      }));
    });

    // Borrar nota de un día
    enCajas('.nota-borrar', btn => {
      btn.addEventListener('click', guardarConAviso(async () => {
        if (!confirm('¿Eliminar esta nota?')) return;
        const t = (await DB.perTodos()).find(x => x.sid === btn.dataset.sid);
        if (!t || !t.notasDias) return;
        t.notasDias.splice(+btn.dataset.idx, 1);
        await DB.perGuardar(t);
        pintarPersonal();
      }));
    });

    // Abonar el finiquito y liquidar
    enCajas('.per-abonar', btn => {
      btn.addEventListener('click', guardarConAviso(async () => {
        const t = (await DB.perTodos()).find(x => x.sid === btn.dataset.sid);
        if (!t) return;
        const pagosT = (await DB.pagoTodos()).filter(p => p.trabajadorSid === t.sid);
        const finiquito = await pendienteTotal(t, pagosT);
        const mensaje = finiquito > 0
          ? `Se apuntará una entrega de ${INFORME.eur(finiquito)} como liquidación final y "${t.nombre}" quedará como ABONADO. ¿Continuar?`
          : `¿Marcar a "${t.nombre}" como liquidado? (no le debes nada)`;
        if (!confirm(mensaje)) return;
        if (finiquito > 0) {
          await DB.pagoGuardar({
            trabajadorSid: t.sid, fecha: hoyISO(),
            importe: finiquito, notas: 'Liquidación final (finiquito)', finiquito: true,
            creado: new Date().toISOString()
          });
        }
        t.liquidado = hoyISO();
        await DB.perGuardar(t);
        toast('✔️ Abonado. Quedará en el historial como prueba de pago.');
        pintarPersonal();
      }));
    });

    // Reabrir a un liquidado (si te equivocaste o hay que corregir algo)
    enCajas('.per-reabrir', btn => {
      btn.addEventListener('click', guardarConAviso(async () => {
        const t = (await DB.perTodos()).find(x => x.sid === btn.dataset.sid);
        if (!t) return;
        if (!confirm(`Se volverá a abrir la ficha de "${t.nombre}" para poder corregir días, sueldo u objetivos.\n\nLo que ya le pagaste NO se borra. Si alguna entrega está mal, bórrala después desde su lista.\n\n¿Continuar?`)) return;
        t.liquidado = '';
        await DB.perGuardar(t);
        perAbiertos.add(t.sid);
        toast('↩️ Ficha reabierta. Vuelve a aparecer arriba con el resto.');
        pintarPersonal();
      }));
    });

    // Dar de baja: abre la ficha y lleva directo al campo de la fecha
    enCajas('.per-dar-baja', btn => {
      btn.addEventListener('click', async () => {
        const t = (await DB.perTodos()).find(x => x.id === +btn.dataset.id);
        if (!t) return;
        abrirFormPersonal(t);
        if (!$('#pe-fin').value) $('#pe-fin').value = hoyISO();
        setTimeout(() => {
          $('#pe-fin').scrollIntoView({ behavior: 'smooth', block: 'center' });
          $('#pe-fin').focus();
        }, 150);
        toast('Revisa la fecha de baja y pulsa Guardar. Después podrás abonarle el finiquito.', 4500);
      });
    });

    // Compartir el resumen del trabajador (texto neutro)
    enCajas('.per-compartir', btn => {
      btn.addEventListener('click', async () => {
        const texto = resumenes.get(btn.dataset.sid);
        if (!texto) return;
        try {
          if (navigator.share) { await navigator.share({ text: texto }); return; }
        } catch (e) { if (e && e.name === 'AbortError') return; }
        try {
          await navigator.clipboard.writeText(texto);
          toast('📋 Resumen copiado. Pégalo en WhatsApp.');
        } catch (e) {
          $('#modal-body').innerHTML = `
            <h2>📤 Resumen para enviar</h2>
            <p class="hint">Mantén pulsado el texto para copiarlo y pégalo en WhatsApp:</p>
            <pre style="white-space:pre-wrap;word-break:break-word;background:#0f0f12;border:1px solid var(--borde);padding:12px;border-radius:8px;font-size:.85rem">${escapar(texto)}</pre>`;
          $('#modal').classList.remove('hidden');
        }
      });
    });

    // Editar trabajador
    enCajas('.per-editar', btn => {
      btn.addEventListener('click', async () => {
        const t = (await DB.perTodos()).find(x => x.id === +btn.dataset.id);
        if (t) abrirFormPersonal(t);
      });
    });

    // Apuntar entrega
    enCajas('.pago-apuntar', btn => {
      btn.addEventListener('click', guardarConAviso(async () => {
        const card = btn.closest('.per-card');
        const importe = parseFloat(card.querySelector('.pago-importe').value);
        const fecha = card.querySelector('.pago-fecha').value;
        if (isNaN(importe) || importe <= 0) { toast('⚠️ Pon el importe entregado.'); return; }
        if (!fecha) { toast('⚠️ Falta la fecha.'); return; }
        await DB.pagoGuardar({
          trabajadorSid: btn.dataset.sid,
          fecha,
          importe: Math.round(importe * 100) / 100,
          notas: card.querySelector('.pago-notas').value.trim(),
          creado: new Date().toISOString()
        });
        toast('💾 Entrega apuntada.');
        pintarPersonal();
      }));
    });

    // Borrar entrega
    enCajas('.pago-borrar', btn => {
      btn.addEventListener('click', guardarConAviso(async () => {
        if (!confirm('¿Eliminar esta entrega?')) return;
        await DB.pagoBorrar(+btn.dataset.id);
        pintarPersonal();
      }));
    });
  }

  function abrirFormPersonal(t = null) {
    perEditando = t;
    $('#pe-nombre').value = t ? t.nombre : '';
    $('#pe-sueldo').value = t && t.sueldoMensual != null ? t.sueldoMensual : '';
    $('#pe-diasmes').value = t && t.diasMes ? t.diasMes : 26;
    $('#pe-jornada').value = t && t.horasJornada ? t.horasJornada : 7.5;
    $('#pe-inicio').value = t ? (t.inicio || '') : '';
    $('#pe-fin').value = t ? (t.fin || '') : '';
    const tramos = t ? (t.tramos || []) : [];
    [1, 2, 3].forEach(i => {
      $(`#pe-obj${i}`).value = tramos[i - 1] ? tramos[i - 1].objetivo : '';
      $(`#pe-pct${i}`).value = tramos[i - 1] ? tramos[i - 1].porcentaje : '';
    });
    $('#pe-notas').value = t ? (t.notas || '') : '';
    $('#per-borrar').classList.toggle('hidden', !t);
    $('#per-form').classList.remove('hidden');
    $('#pe-nombre').focus();
  }

  $('#per-nuevo').addEventListener('click', () => abrirFormPersonal());
  $('#per-cancelar').addEventListener('click', () => {
    perEditando = null;
    $('#per-form').classList.add('hidden');
  });

  $('#per-guardar').addEventListener('click', guardarConAviso(async () => {
    const nombre = $('#pe-nombre').value.trim();
    const sueldo = parseFloat($('#pe-sueldo').value);
    const diasMes = Math.round(parseFloat($('#pe-diasmes').value));
    if (!nombre) { toast('⚠️ El nombre es obligatorio.'); return; }
    if (isNaN(sueldo) || sueldo < 0) { toast('⚠️ Pon el sueldo mensual pactado.'); return; }
    if (isNaN(diasMes) || diasMes < 1 || diasMes > 31) { toast('⚠️ Pon los días que trabaja al mes (ej.: 26).'); return; }

    const tramos = [1, 2, 3].map(i => ({
      objetivo: parseFloat($(`#pe-obj${i}`).value) || 0,
      porcentaje: parseFloat($(`#pe-pct${i}`).value) || 0
    })).filter(x => x.objetivo > 0 && x.porcentaje > 0);

    await DB.perGuardar({
      ...(perEditando
        ? {
            id: perEditando.id, sid: perEditando.sid,
            dias: perEditando.dias || [], tardes: perEditando.tardes || [], faltas: perEditando.faltas || [], notasDias: perEditando.notasDias || [],
            liquidado: perEditando.liquidado || '', creado: perEditando.creado
          }
        : { dias: [], tardes: [], faltas: [], notasDias: [], liquidado: '', creado: new Date().toISOString() }),
      nombre,
      sueldoMensual: Math.round(sueldo * 100) / 100,
      diasMes,
      horasJornada: Math.max(1, Math.min(16, parseFloat($('#pe-jornada').value) || 7.5)),
      inicio: $('#pe-inicio').value || '',
      fin: $('#pe-fin').value || '',
      tramos,
      notas: $('#pe-notas').value.trim()
    });
    perEditando = null;
    $('#per-form').classList.add('hidden');
    toast('💾 Trabajador guardado.');
    pintarPersonal();
  }));

  $('#per-borrar').addEventListener('click', guardarConAviso(async () => {
    if (!perEditando) return;
    if (!confirm(`¿Eliminar a "${perEditando.nombre}" y todas sus entregas apuntadas? No se puede deshacer.`)) return;
    const pagos = (await DB.pagoTodos()).filter(p => p.trabajadorSid === perEditando.sid);
    for (const p of pagos) await DB.pagoBorrar(p.id);
    await DB.perBorrar(perEditando.id);
    perEditando = null;
    $('#per-form').classList.add('hidden');
    toast('🗑️ Trabajador eliminado.');
    pintarPersonal();
  }));

  $('#per-mes').addEventListener('change', pintarPersonal);

  /* ---------- AJUSTES ---------- */

  async function pintarStats() {
    const lista = await DB.todos();
    const facturas = lista.filter(r => r.tipo === 'factura');
    const cierres = lista.filter(r => r.tipo === 'cierre');
    const conFoto = lista.filter(r => r.imagen instanceof Blob).length;
    let persistente = false;
    try {
      if (navigator.storage && navigator.storage.persisted) persistente = await navigator.storage.persisted();
    } catch (e) { /* nada */ }
    $('#ajustes-stats').innerHTML = `
      <div class="stat-linea"><span>Facturas guardadas</span><strong>${facturas.length}</strong></div>
      <div class="stat-linea"><span>Cierres guardados</span><strong>${cierres.length}</strong></div>
      <div class="stat-linea"><span>Registros con foto</span><strong>${conFoto}</strong></div>
      <div class="stat-linea"><span>Protegido contra limpiezas del navegador</span><strong class="${persistente ? 'txt-ok' : 'txt-sec'}">${persistente ? '✅ Sí' : 'Aún no'}</strong></div>`;
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

  /* ---------- NUBE: sesión y estado de sincronización ---------- */

  function pintarNube() {
    const est = NUBE.estado();
    const linea = $('#nube-estado');
    const det = $('#nube-detalle');

    if (!est.disponible) {
      linea.innerHTML = '<span>Nube</span><strong class="txt-sec">Sin conexión ahora mismo</strong>';
      $('#nube-entrar').classList.add('hidden');
      $('#nube-salir').classList.add('hidden');
      det.classList.add('hidden');
      return;
    }
    const textos = {
      desconectado: ['txt-sec', '⚪ No conectada'],
      conectando: ['txt-sec', '⏳ Conectando…'],
      sincronizando: ['txt-sec', '🔄 Sincronizando…'],
      sincronizado: ['txt-ok', '✅ Sincronizada'],
      error: ['txt-bad', '⚠️ Problema al sincronizar']
    };
    const [clase, texto] = textos[est.estado] || textos.desconectado;
    linea.innerHTML = `<span>${est.conectado ? escapar(est.correo) : 'Nube'}</span><strong class="${clase}">${texto}</strong>`;
    $('#nube-entrar').classList.toggle('hidden', est.conectado);
    $('#nube-salir').classList.toggle('hidden', !est.conectado);
    det.textContent = est.detalle || '';
    det.classList.toggle('hidden', !est.detalle);
  }

  $('#nube-entrar').addEventListener('click', async () => {
    try {
      await NUBE.entrar();
      toast('☁️ Nube conectada. Tus datos se están sincronizando.');
    } catch (e) {
      console.error(e);
      toast('⚠️ ' + e.message, 5000);
    }
    pintarNube();
  });

  $('#nube-salir').addEventListener('click', async () => {
    if (!confirm('¿Desconectar la nube en este dispositivo?\n\nLos datos guardados aquí NO se borran; simplemente dejarán de sincronizarse hasta que vuelvas a entrar.')) return;
    await NUBE.salir();
    pintarNube();
    toast('Nube desconectada en este dispositivo.');
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

  /* Nombres para los desplegables de proveedor (facturas y buscador). */
  let nombresProveedores = [];

  async function cargarProveedores() {
    nombresProveedores = await DB.proveedores();
  }

  function normalizarBusqueda(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  /* Desplegable propio de proveedores: el <datalist> nativo no se abre
     bien en muchos móviles y solo sugiere por el principio del texto. */
  function crearComboProveedores(idInput) {
    const input = $(idInput);
    const wrap = input.closest('.combo');
    const listaEl = wrap.querySelector('.combo-lista');
    const toggle = wrap.querySelector('.combo-toggle');

    function abrir(filtro) {
      const f = normalizarBusqueda(filtro);
      const items = f
        ? nombresProveedores.filter(n => normalizarBusqueda(n).includes(f))
        : nombresProveedores;
      if (!items.length) {
        listaEl.innerHTML = `<div class="combo-vacio">${nombresProveedores.length
          ? 'Ningún proveedor coincide con lo escrito.'
          : 'Aún no tienes proveedores guardados. Se irán añadiendo con tus facturas.'}</div>`;
      } else {
        listaEl.innerHTML = items.map(n => `<button type="button" class="combo-item">${escapar(n)}</button>`).join('');
      }
      listaEl.classList.remove('hidden');
    }
    const cerrar = () => listaEl.classList.add('hidden');

    toggle.addEventListener('click', () => {
      if (listaEl.classList.contains('hidden')) abrir(''); // el botón enseña SIEMPRE la lista completa
      else cerrar();
    });
    input.addEventListener('input', () => abrir(input.value.trim()));
    input.addEventListener('focus', () => abrir(input.value.trim()));
    listaEl.addEventListener('mousedown', (e) => e.preventDefault()); // no robar el foco al input
    listaEl.addEventListener('click', (e) => {
      const item = e.target.closest('.combo-item');
      if (!item) return;
      input.value = item.textContent;
      cerrar();
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) cerrar(); });
  }

  function escapar(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------- Arranque ---------- */

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    const habiaControlador = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // Cuando se instala una versión nueva, avisar (la app arranca desde caché)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (habiaControlador) toast('🆕 Actualización instalada. Cierra y abre la app para usarla.', 7000);
    });
  }

  // Almacenamiento persistente: que el navegador NUNCA borre la contabilidad
  // por su cuenta si el móvil va justo de espacio
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // Preparar el lector de fotos en segundo plano, pero SIN estorbar al
  // arranque: unos segundos después y cuando el móvil esté libre
  const precargarOCR = () => { if (typeof OCR !== 'undefined' && OCR.precargar && !document.hidden) OCR.precargar(); };
  setTimeout(() => {
    if ('requestIdleCallback' in window) requestIdleCallback(precargarOCR, { timeout: 10000 });
    else precargarOCR();
  }, 8000);

  mostrarBloqueo(); // si hay PIN, la app arranca bloqueada
  crearComboProveedores('#f-proveedor');
  crearComboProveedores('#q-proveedor');
  iniciarSelectorAnio();
  pintarConfig();
  pintarSeguridad();
  pintarRecientes();
  pintarProveedores();
  cargarProveedores();

  // Nube: al cambiar la sesión o llegar datos de otro dispositivo,
  // refrescar las listas en pantalla. Arranca un momento después de pintar
  // la app para que el desbloqueo vaya fluido.
  setTimeout(() => NUBE.iniciar(() => {
    pintarNube();
    pintarRecientes();
    pintarProveedores();
    cargarProveedores();
    if (document.querySelector('.tab[data-tab="consultar"]').classList.contains('active')) buscar();
    if (document.querySelector('.tab[data-tab="personal"]').classList.contains('active')) pintarPersonal();
    if (document.querySelector('.tab[data-tab="cierres"]').classList.contains('active')) pintarFacturacion();
    if (document.querySelector('.tab[data-tab="informe"]').classList.contains('active')) pintarResumen();
  }), 1200);
  pintarNube();
})();
