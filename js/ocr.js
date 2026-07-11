/* CONTABLE — lectura de imágenes (OCR) y detección de datos.
   Usa Tesseract.js en el propio dispositivo: las fotos nunca se suben a ningún servidor. */

const OCR = (() => {
  let workerPromise = null;

  function obtenerWorker(onProgreso) {
    if (!workerPromise) {
      workerPromise = Tesseract.createWorker('spa', 1, {
        logger: (m) => {
          if (m.status === 'recognizing text' && onProgreso) {
            onProgreso(Math.round(m.progress * 100));
          }
        }
      });
      // Si falla la descarga del lector (mala cobertura), permitir reintentar
      // en la siguiente foto en vez de quedarse roto para siempre
      workerPromise.catch(() => { workerPromise = null; });
    }
    return workerPromise;
  }

  /* Reduce la imagen para acelerar el OCR sin perder demasiada calidad. */
  function prepararImagen(blob, maxLado = 1600) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width: w, height: h } = img;
        const escala = Math.min(1, maxLado / Math.max(w, h));
        w = Math.round(w * escala);
        h = Math.round(h * escala);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        // Mejorar contraste: escala de grises simple
        const datos = ctx.getImageData(0, 0, w, h);
        const px = datos.data;
        for (let i = 0; i < px.length; i += 4) {
          const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
          const v = g > 140 ? Math.min(255, g * 1.15) : g * 0.85;
          px[i] = px[i + 1] = px[i + 2] = v;
        }
        ctx.putImageData(datos, 0, 0);
        resolve(canvas);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo cargar la imagen')); };
      img.src = url;
    });
  }

  async function leerImagen(blob, onProgreso) {
    const trabajo = (async () => {
      const worker = await obtenerWorker(onProgreso);
      const canvas = await prepararImagen(blob);
      const { data } = await worker.recognize(canvas);
      return data.text || '';
    })();
    // Tiempo límite: si el lector no responde (descarga lenta, cuelgue…),
    // no dejar la app clavada en "Leyendo la imagen…" para siempre
    const limite = new Promise((_, reject) => setTimeout(() =>
      reject(new Error('La lectura automática tardó demasiado. La foto se guarda igual: rellena los datos a mano.')), 90000));
    return Promise.race([trabajo, limite]);
  }

  /* ---------- Detección de datos en el texto ---------- */

  function normalizarNumero(str) {
    // "1.234,56" -> 1234.56 ; "1234.56" -> 1234.56 ; "12,5" -> 12.5
    let s = str.replace(/[€\s]/g, '');
    if (/,\d{1,2}$/.test(s)) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
    const n = parseFloat(s);
    return isNaN(n) ? null : Math.round(n * 100) / 100;
  }

  /* Extrae todas las fechas de una línea (formatos numéricos y con mes en letras). */
  function fechasDeLinea(linea, hoy) {
    const meses = { enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6, julio:7, agosto:8,
      septiembre:9, setiembre:9, octubre:10, noviembre:11, diciembre:12,
      ene:1, feb:2, mar:3, abr:4, may:5, jun:6, jul:7, ago:8, sep:9, sept:9, oct:10, nov:11, dic:12 };
    const encontradas = [];
    let m;
    const reISO = /(\d{4})-(\d{2})-(\d{2})/g;
    while ((m = reISO.exec(linea)) !== null) {
      const f = new Date(+m[1], +m[2] - 1, +m[3]);
      if (esFechaRazonable(f, hoy)) encontradas.push(f);
    }
    const reEU = /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4}|\d{2})(?!\d)/g;
    while ((m = reEU.exec(linea)) !== null) {
      let [, d, mes, a] = m;
      d = +d; mes = +mes; a = +a;
      if (a < 100) a += 2000;
      // Algunas facturas vienen en formato MM/DD: si el "mes" es imposible, probar al revés
      if (mes > 12 && d >= 1 && d <= 12) { const t = d; d = mes; mes = t; }
      if (d >= 1 && d <= 31 && mes >= 1 && mes <= 12) {
        const f = new Date(a, mes - 1, d);
        if (esFechaRazonable(f, hoy)) encontradas.push(f);
      }
    }
    // Fechas con mes en letras: 12 de marzo de 2026 / 12 MAR 2026 / 12-mar-2026
    const reTxt = /(\d{1,2})[\s\-\.]*(?:de\s+)?([a-záéíóú]{3,12})\.?[\s\-\.]*(?:de[l]?\s+)?(\d{4}|\d{2})(?!\d)/gi;
    while ((m = reTxt.exec(linea)) !== null) {
      const mes = meses[m[2].toLowerCase()];
      if (mes) {
        let a = +m[3];
        if (a < 100) a += 2000;
        const f = new Date(a, mes - 1, +m[1]);
        if (esFechaRazonable(f, hoy)) encontradas.push(f);
      }
    }
    return encontradas;
  }

  function detectarFecha(texto) {
    const hoy = new Date();
    const candidatas = []; // { f, peso }

    // Cada empresa coloca la fecha en un sitio: se puntúa por el contexto
    // de la línea en vez de quedarse con la primera que aparezca.
    for (const linea of texto.split('\n')) {
      const esVencimiento = /vencimient|caducidad|v[aá]lido\s*hasta|entrega|pr[oó]ximo|cobro/i.test(linea);
      const esEmision = /fecha|emisi[oó]n|emitida|expedici[oó]n|expedida|fra\.?|f\.\s*factura/i.test(linea);
      const peso = esVencimiento ? -1 : (esEmision ? 2 : 0);
      for (const f of fechasDeLinea(linea, hoy)) candidatas.push({ f, peso });
    }

    if (!candidatas.length) return null;
    const maxPeso = Math.max(...candidatas.map(c => c.peso));
    const pool = candidatas.filter(c => c.peso === maxPeso).map(c => c.f);
    // Preferir la más reciente que no sea futura (las facturas suelen ser de hoy o días atrás)
    pool.sort((a, b) => b - a);
    const noFuturas = pool.filter(f => f <= hoy);
    const elegida = noFuturas[0] || pool[pool.length - 1];
    return aISO(elegida);
  }

  function esFechaRazonable(f, hoy) {
    if (isNaN(f)) return false;
    const min = new Date(hoy.getFullYear() - 3, 0, 1);
    const max = new Date(hoy.getFullYear() + 1, 11, 31);
    return f >= min && f <= max;
  }

  function aISO(f) {
    const p = (n) => String(n).padStart(2, '0');
    return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`;
  }

  function detectarTotal(texto) {
    const lineas = texto.split('\n');
    const reImporte = /(\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d{2})\s*€?/g;
    // Cada empresa etiqueta el total a su manera: se puntúan las etiquetas
    // de más específica a más genérica y gana la de mayor puntuación.
    const clavesFuertes = /total\s*(factura|a\s*pagar|a\s*abonar|importe|general|documento)|importe\s*total|gran\s*total|total\s*(€|eur)|a\s*pagar|l[ií]quido\s*(a\s*percibir)?|total\s*iva\s*inclu/i;
    const clavesTotal = /\btotal\b|t0tal|tota1|importe|suma/i;
    const clavesEvitar = /subtotal|sub\s*total|base|\biva\b|i\.\s?v\.\s?a|cuota|cambio|entregado|entrega|dto|descuento|ahorro|devoluci|vuelta|efectivo|tarjeta|retenci|irpf|unid|cant|precio/i;

    const candidatos = []; // { n, peso }

    for (let i = 0; i < lineas.length; i++) {
      const linea = lineas[i];
      const evitar = clavesEvitar.test(linea) && !/total\s*iva\s*inclu|iva\s*incluido/i.test(linea);
      let peso = 0;
      if (!evitar) {
        if (clavesFuertes.test(linea)) peso = 5;
        else if (clavesTotal.test(linea)) peso = 3;
      }
      const nums = extraerImportes(linea, reImporte).filter(n => n > 0);
      if (nums.length) {
        for (const n of nums) candidatos.push({ n, peso });
      } else if (peso >= 3) {
        // Etiqueta "TOTAL" sola: en muchos diseños el importe cae en la línea siguiente
        const sig = lineas[i + 1] || '';
        if (!clavesEvitar.test(sig)) {
          for (const n of extraerImportes(sig, reImporte).filter(x => x > 0)) {
            candidatos.push({ n, peso: peso - 1 });
          }
        }
      }
    }

    if (!candidatos.length) return null;
    const maxPeso = Math.max(...candidatos.map(c => c.peso));
    // Con etiqueta clara: el mayor importe de esas líneas.
    // Sin ninguna etiqueta: el mayor importe del documento (suele ser el total).
    const pool = maxPeso > 0 ? candidatos.filter(c => c.peso === maxPeso) : candidatos;
    return Math.max(...pool.map(c => c.n));
  }

  /* Detecta el desglose de IVA de una factura: base imponible, tipo (%) y cuota.
     Devuelve { baseImponible, ivaTipo, ivaCuota } (null en lo que no encuentre). */
  function detectarIVA(texto, total) {
    const lineas = texto.split('\n');
    const reImporte = /(\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d{2})/g;
    const reTipo = /(\d{1,2}(?:[.,]\d{1,2})?)\s*%/;
    const esLineaIVA = (l) => /\biva\b|i\.\s?v\.\s?a/i.test(l);

    let base = null;
    let basePareja = 0; // suma de bases encontradas junto a su cuota (facturas con varios tipos)
    const tipos = new Set();
    let cuotaTotal = 0;
    let hayCuota = false;

    for (let i = 0; i < lineas.length; i++) {
      const linea = lineas[i];
      // Las líneas de retención (IRPF) no son IVA: se tratan aparte
      if (/retenci|irpf/i.test(linea)) continue;
      if (/total\s*iva|iva\s*incluido/i.test(linea) && !reTipo.test(linea)) continue;

      // Línea de base imponible
      if (/base\s*(imponible)?/i.test(linea) && base === null) {
        const nums = extraerImportes(linea, reImporte);
        if (nums.length) base = Math.max(...nums);
      }

      const mt = linea.match(reTipo);
      if (!esLineaIVA(linea) && !mt) continue;
      if (!esLineaIVA(linea) && !/\biva\b/i.test(texto)) continue;
      if (!mt && !esLineaIVA(linea)) continue;

      let tipo = null;
      if (mt) {
        tipo = parseFloat(mt[1].replace(',', '.'));
        if (isNaN(tipo) || tipo < 0 || tipo > 30) tipo = null;
      }
      if (tipo === null && !esLineaIVA(linea)) continue;

      // Importes de la línea, quitando el número que es el propio porcentaje
      let nums = extraerImportes(linea, reImporte).filter(n => tipo === null || Math.abs(n - tipo) > 0.001);
      if (!nums.length && tipo !== null && esLineaIVA(linea)) {
        // Desglose en tabla por columnas: la base y la cuota pueden caer
        // en la línea siguiente a la etiqueta "IVA 21%"
        const sig = lineas[i + 1] || '';
        if (!/retenci|irpf|total/i.test(sig) && !reTipo.test(sig)) {
          nums = extraerImportes(sig, reImporte).filter(n => Math.abs(n - tipo) > 0.001);
        }
      }
      if (!nums.length) { if (tipo !== null) tipos.add(tipo); continue; }

      if (tipo !== null && nums.length >= 2) {
        // Buscar pareja base/cuota coherente: cuota ≈ base × tipo%
        let pareja = null;
        for (const b of nums) {
          for (const c of nums) {
            if (b === c) continue;
            if (Math.abs(b * tipo / 100 - c) <= Math.max(0.06, b * 0.02)) { pareja = [b, c]; break; }
          }
          if (pareja) break;
        }
        if (pareja) {
          basePareja += pareja[0];
          cuotaTotal += pareja[1];
          hayCuota = true;
          tipos.add(tipo);
          continue;
        }
      }

      // Un solo importe: se toma como cuota si es pequeño respecto al total
      const menor = Math.min(...nums);
      if (total == null || menor <= total * 0.35) {
        cuotaTotal += menor;
        hayCuota = true;
        if (tipo !== null) tipos.add(tipo);
      } else if (tipo !== null) {
        tipos.add(tipo);
      }
    }

    let ivaTipo = tipos.size === 1 ? [...tipos][0] : (tipos.size > 1 ? 'varios' : null);
    let ivaCuota = hayCuota ? Math.round(cuotaTotal * 100) / 100 : null;

    // Las bases encontradas junto a sus cuotas son más fiables que la línea "BASE"
    if (basePareja > 0) base = Math.round(basePareja * 100) / 100;

    // Si conocemos el tipo pero no la cuota, calcularla a partir del total
    if (ivaCuota === null && typeof ivaTipo === 'number' && total != null) {
      const b = total / (1 + ivaTipo / 100);
      ivaCuota = Math.round((total - b) * 100) / 100;
      if (base === null) base = Math.round(b * 100) / 100;
    }
    // Si hay base y cuota pero no tipo, deducirlo
    if (ivaTipo === null && base && ivaCuota) {
      const t = Math.round((ivaCuota / base) * 100);
      if ([4, 5, 10, 21].includes(t)) ivaTipo = t;
    }
    // Coherencia: la cuota nunca puede superar el total
    if (total != null && ivaCuota !== null && ivaCuota >= total) { ivaCuota = null; }
    if (total != null && base !== null && base >= total + 0.01) { base = null; }
    if (base === null && total != null && ivaCuota !== null) {
      base = Math.round((total - ivaCuota) * 100) / 100;
    }

    return { baseImponible: base, ivaTipo, ivaCuota };
  }

  /* Detecta la retención de IRPF (típica en el alquiler del local: 19 %,
     o en facturas de profesionales: 15 %/7 %).
     Devuelve { retTipo, retCuota } (null si no hay). */
  function detectarRetencion(texto, total) {
    const lineas = texto.split('\n');
    const reImporte = /(\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d{2})/g;
    const reTipo = /(\d{1,2}(?:[.,]\d{1,2})?)\s*%/;
    let retTipo = null;
    let retCuota = null;

    for (const linea of lineas) {
      // Solo palabras claras: "retención" o "IRPF". Evita falsos positivos como
      // "RET. ENVASES" (retorno de envases) o el recargo de equivalencia.
      if (!/retenci|irpf/i.test(linea)) continue;
      if (/envas|recargo|equival/i.test(linea)) continue;
      const mt = linea.match(reTipo);
      let tipo = null;
      if (mt) {
        tipo = parseFloat(mt[1].replace(',', '.'));
        if (isNaN(tipo) || tipo <= 0 || tipo > 25) tipo = null;
      }
      const nums = extraerImportes(linea, reImporte).filter(n => tipo === null || Math.abs(n - tipo) > 0.001);
      if (tipo !== null && retTipo === null) retTipo = tipo;
      if (nums.length && retCuota === null) {
        // La cuota de retención suele ser el importe menor de la línea
        const menor = Math.min(...nums);
        if (total == null || menor < total) retCuota = menor;
      }
    }

    // Si hay tipo pero no cuota y conocemos base ≈ podemos dejarlo a mano
    if (retCuota !== null) retCuota = Math.round(retCuota * 100) / 100;
    return { retTipo, retCuota };
  }

  function extraerImportes(linea, reImporte) {
    const nums = [];
    let m;
    const re = new RegExp(reImporte.source, 'g');
    while ((m = re.exec(linea)) !== null) {
      const n = normalizarNumero(m[1]);
      if (n !== null && n >= 0 && n <= 100000) nums.push(n);
    }
    return nums;
  }

  function limpiarNIF(nif) {
    return String(nif || '').replace(/[\s\-\.]/g, '').toUpperCase();
  }

  /* Devuelve TODOS los NIF/CIF/NIE del texto, primero los que van junto
     a la palabra "CIF"/"NIF" (los más fiables). */
  function detectarNIFs(texto) {
    // CIF: letra + 7 dígitos + dígito/letra | NIF: 8 dígitos + letra | NIE: X/Y/Z + 7 dígitos + letra
    const patrones = [
      /\b([ABCDEFGHJKLMNPQRSUVW])[\s\-\.]?(\d{7})[\s\-\.]?([0-9A-J])\b/gi,
      /\b([XYZ])[\s\-\.]?(\d{7})[\s\-\.]?([A-Z])\b/gi,
      /\b(\d{8})[\s\-\.]?([A-Z])\b/g
    ];
    const encontrados = [];
    for (const linea of texto.split('\n')) {
      const juntoAClave = /\b(c\.?\s?i\.?\s?f|n\.?\s?i\.?\s?f|vat)\b/i.test(linea);
      for (const patron of patrones) {
        let m;
        const re = new RegExp(patron.source, patron.flags);
        while ((m = re.exec(linea)) !== null) {
          encontrados.push({ nif: limpiarNIF(m.slice(1).join('')), juntoAClave });
        }
      }
    }
    encontrados.sort((a, b) => (b.juntoAClave ? 1 : 0) - (a.juntoAClave ? 1 : 0));
    return [...new Set(encontrados.map(e => e.nif))];
  }

  function detectarNIF(texto) {
    return detectarNIFs(texto)[0] || '';
  }

  /* ---------- Comparación difusa de nombres (tolera fallos del OCR) ---------- */

  function levenshtein(a, b) {
    const n = a.length, m = b.length;
    if (!n) return m;
    if (!m) return n;
    let prev = Array.from({ length: m + 1 }, (_, j) => j);
    for (let i = 1; i <= n; i++) {
      const fila = [i];
      for (let j = 1; j <= m; j++) {
        fila[j] = Math.min(prev[j] + 1, fila[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = fila;
    }
    return prev[m];
  }

  /* Clave para comparar: minúsculas, sin tildes, con las confusiones típicas
     del OCR unificadas (0↔O, 1↔L, 5↔S, 8↔B) y sin la forma societaria. */
  function claveDifusa(s) {
    return String(s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/0/g, 'o').replace(/1/g, 'l').replace(/5/g, 's').replace(/8/g, 'b')
      .replace(/[^a-zñ ]+/g, ' ')
      .replace(/\b(s\s?l\s?u?|s\s?a\s?u?|s\s?l\s?l|s\s?c(oop)?|c\s?b)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  /* Parecido entre dos claves difusas: 1 = idénticas, 0 = nada que ver. */
  function similitud(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const corto = a.length <= b.length ? a : b;
    if (corto.length >= 4 && (a.includes(b) || b.includes(a))) return 0.93;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  }

  /* Parecido por palabras: qué parte de las palabras del nombre conocido
     aparecen (aunque sea con algún fallo de letra) en la línea. */
  function similitudTokens(clave, lineaClave) {
    const palabras = clave.split(' ').filter(t => t.length >= 3);
    if (!palabras.length) return 0;
    const enLinea = lineaClave.split(' ').filter(t => t.length >= 3);
    if (!enLinea.length) return 0;
    let aciertos = 0, aciertoLargo = false;
    for (const p of palabras) {
      if (enLinea.some(t => similitud(p, t) >= 0.8)) {
        aciertos++;
        if (p.length >= 4) aciertoLargo = true;
      }
    }
    if (!aciertoLargo) return 0; // exigir al menos una palabra significativa
    return (aciertos / palabras.length) * 0.9;
  }

  /* Detección del proveedor. `conocidos` admite nombres (strings) y fichas
     completas { nombre, nif } de los proveedores dados de alta. */
  function detectarProveedor(texto, conocidos = []) {
    const fichas = conocidos
      .map(c => (typeof c === 'string' ? { nombre: c, nif: '' } : c))
      .filter(c => c && c.nombre);
    const lineas = texto.split('\n').map(l => l.trim()).filter(l => l.length >= 3);

    // 1) Por NIF/CIF: lo más fiable, funciona sea cual sea el diseño de la factura
    const nifsTexto = detectarNIFs(texto);
    for (const nif of nifsTexto) {
      const p = fichas.find(f => f.nif && limpiarNIF(f.nif) === nif);
      if (p) return p.nombre;
    }

    // 2) Por nombre conocido, con comparación difusa línea a línea
    //    (el OCR confunde letras: "GARC1A" también debe reconocerse)
    let mejorNombre = '', mejorPunt = 0;
    const tope = Math.min(lineas.length, 25);
    const clavesLineas = lineas.slice(0, tope).map(claveDifusa);
    for (const f of fichas) {
      const clave = claveDifusa(f.nombre);
      if (clave.length < 4) continue;
      for (let i = 0; i < tope; i++) {
        if (!clavesLineas[i]) continue;
        let punt = similitud(clave, clavesLineas[i]);
        if (punt < 0.8) punt = Math.max(punt, similitudTokens(clave, clavesLineas[i]));
        punt -= i * 0.004; // ligera preferencia por la cabecera del documento
        if (punt > mejorPunt) { mejorPunt = punt; mejorNombre = f.nombre; }
      }
    }
    if (mejorPunt >= 0.78) return mejorNombre;

    // 3) Proveedor no dado de alta: puntuar las líneas de cabecera y quedarse
    //    con la que más "pinta de nombre de empresa" tenga
    const reSociedad = /\b(s\.?\s?l\.?\s?u?|s\.?\s?a\.?\s?u?|s\.?\s?coop|s\.?\s?c\b|c\.?\s?b\b|s\.?\s?l\.?\s?l)\b/i;
    const reDescarta = /factura|ticket|tique|simplificad|albar[aá]n|presupuesto|fecha|hora|tel[eé]f|tfno|fax|www|@|http|cod\.?\s*postal|cliente|mesa|camarero|caja|n[ºo°]\s|total|importe|base|unidad|precio|cant\.?|descripci|concepto|forma\s*de\s*pago|efectivo|tarjeta|vencimient|p[aá]gina|registro\s*mercantil/i;
    const reDireccion = /\b(c\/|cl\.|calle|avda|avenida|plaza|pza|ctra|carretera|pol[ií]gono|pol\.|camino|paseo|urb\.|local|nave)\b/i;

    let mejorLinea = '', mejorScore = 0;
    const topeCabecera = Math.min(lineas.length, 12);
    for (let i = 0; i < topeCabecera; i++) {
      const linea = lineas[i];
      if (linea.length < 4 || linea.length > 55) continue;
      if (reDescarta.test(linea) || reDireccion.test(linea)) continue;
      const letras = (linea.match(/[a-záéíóúñü]/gi) || []).length;
      const digitos = (linea.match(/\d/g) || []).length;
      if (letras < 4 || digitos > letras) continue;

      let score = 1;
      if (reSociedad.test(linea)) score += 4; // forma societaria: casi seguro que es el nombre
      if (i === 0) score += 2;
      else if (i <= 2) score += 1.5;
      else if (i <= 5) score += 0.5;
      if (letras >= 4 && linea === linea.toUpperCase()) score += 1; // las cabeceras suelen ir en mayúsculas
      if (digitos === 0) score += 0.5;
      const siguiente = lineas[i + 1] || '';
      if (reDireccion.test(siguiente) || /\b(cif|nif)\b/i.test(siguiente)) score += 1.5; // debajo del nombre suele venir la dirección o el CIF
      if (/\b(cif|nif)\s*[:\.]/i.test(linea)) score -= 2;

      if (score > mejorScore) { mejorScore = score; mejorLinea = linea; }
    }
    return mejorLinea ? limpiarNombre(mejorLinea) : '';
  }

  function limpiarNombre(s) {
    return s
      .replace(/\b(c\.?i\.?f|n\.?i\.?f)\.?\s*:?\s*[A-Z0-9\-\.\s]*$/i, ' ') // quitar "CIF: B123…" pegado al nombre
      .replace(/[*#|_~=]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /* Analiza el texto completo de una factura. */
  function analizarFactura(texto, proveedoresConocidos = []) {
    const total = detectarTotal(texto);
    const iva = detectarIVA(texto, total);
    const ret = detectarRetencion(texto, total);
    return {
      proveedor: detectarProveedor(texto, proveedoresConocidos),
      nif: detectarNIF(texto),
      fecha: detectarFecha(texto),
      total,
      baseImponible: iva.baseImponible,
      ivaTipo: iva.ivaTipo,
      ivaCuota: iva.ivaCuota,
      retTipo: ret.retTipo,
      retCuota: ret.retCuota
    };
  }

  /* Analiza el texto de un cierre de caja (ticket Z). */
  function analizarCierre(texto) {
    const lineas = texto.split('\n');
    const reImporte = /(\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d{2})/g;
    const clavesVentas = /total|ventas|venta\s*d[ií]a|recaudaci[oó]n|z\b|gran\s*total/i;
    let total = null;
    let efectivo = null;
    let tarjeta = null;

    for (const linea of lineas) {
      const nums = [];
      let m;
      const re = new RegExp(reImporte.source, 'g');
      while ((m = re.exec(linea)) !== null) {
        const n = OCR.normalizarNumero ? OCR.normalizarNumero(m[1]) : normalizarNumero(m[1]);
        if (n !== null && n > 0 && n <= 100000) nums.push(n);
      }
      if (!nums.length) continue;
      const mayor = Math.max(...nums);
      if (/efectivo|metalico|met[aá]lico|cash/i.test(linea) && efectivo === null) efectivo = mayor;
      else if (/tarjeta|visa|card|datafono|dat[aá]fono|tpv/i.test(linea) && tarjeta === null) tarjeta = mayor;
      else if (clavesVentas.test(linea)) total = Math.max(total || 0, mayor);
    }

    if (total === null) total = detectarTotal(texto);
    if (total === null && efectivo !== null && tarjeta !== null) {
      total = Math.round((efectivo + tarjeta) * 100) / 100;
    }

    return { fecha: detectarFecha(texto), total, efectivo, tarjeta };
  }

  return { leerImagen, analizarFactura, analizarCierre, normalizarNumero };
})();
