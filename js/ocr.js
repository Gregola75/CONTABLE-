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
    const worker = await obtenerWorker(onProgreso);
    const canvas = await prepararImagen(blob);
    const { data } = await worker.recognize(canvas);
    return data.text || '';
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

  function detectarFecha(texto) {
    const hoy = new Date();
    const patrones = [
      // 12/03/2026, 12-03-26, 12.03.2026
      /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4}|\d{2})/g,
      // 2026-03-12
      /(\d{4})-(\d{2})-(\d{2})/g
    ];
    const candidatas = [];

    let m;
    const reISO = /(\d{4})-(\d{2})-(\d{2})/g;
    while ((m = reISO.exec(texto)) !== null) {
      const f = new Date(+m[1], +m[2] - 1, +m[3]);
      if (esFechaRazonable(f, hoy)) candidatas.push(f);
    }
    const reEU = /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4}|\d{2})(?!\d)/g;
    while ((m = reEU.exec(texto)) !== null) {
      let [, d, mes, a] = m;
      d = +d; mes = +mes; a = +a;
      if (a < 100) a += 2000;
      if (d >= 1 && d <= 31 && mes >= 1 && mes <= 12) {
        const f = new Date(a, mes - 1, d);
        if (esFechaRazonable(f, hoy)) candidatas.push(f);
      }
    }
    // Fechas con mes en letras: 12 de marzo de 2026 / 12 MAR 2026
    const meses = { enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6, julio:7, agosto:8,
      septiembre:9, setiembre:9, octubre:10, noviembre:11, diciembre:12,
      ene:1, feb:2, mar:3, abr:4, may:5, jun:6, jul:7, ago:8, sep:9, oct:10, nov:11, dic:12 };
    const reTxt = /(\d{1,2})\s*(?:de\s+)?([a-záéíóú]{3,12})\.?\s*(?:de\s+)?(\d{4})/gi;
    while ((m = reTxt.exec(texto)) !== null) {
      const mes = meses[m[2].toLowerCase()];
      if (mes) {
        const f = new Date(+m[3], mes - 1, +m[1]);
        if (esFechaRazonable(f, hoy)) candidatas.push(f);
      }
    }

    if (!candidatas.length) return null;
    // Preferir la más reciente que no sea futura (las facturas suelen ser de hoy o días atrás)
    candidatas.sort((a, b) => b - a);
    const noFuturas = candidatas.filter(f => f <= hoy);
    const elegida = noFuturas[0] || candidatas[candidatas.length - 1];
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
    const clavesTotal = /total|importe|a\s*pagar|t0tal|suma/i;
    const clavesEvitar = /subtotal|base|iva|cambio|entregado|dto|descuento|ahorro/i;

    let candidatosTotal = [];
    let todos = [];

    for (const linea of lineas) {
      let m;
      const re = new RegExp(reImporte.source, 'g');
      while ((m = re.exec(linea)) !== null) {
        const n = normalizarNumero(m[1]);
        if (n === null || n <= 0 || n > 100000) continue;
        todos.push(n);
        if (clavesTotal.test(linea) && !clavesEvitar.test(linea)) {
          candidatosTotal.push(n);
        }
      }
    }

    if (candidatosTotal.length) {
      // En líneas con "TOTAL", el importe correcto suele ser el mayor de ellas
      return Math.max(...candidatosTotal);
    }
    if (todos.length) {
      return Math.max(...todos);
    }
    return null;
  }

  function detectarNIF(texto) {
    // CIF: letra + 7 dígitos + dígito/letra | NIF: 8 dígitos + letra
    const reCIF = /\b([ABCDEFGHJKLMNPQRSUVW])[\s\-\.]?(\d{7})[\s\-\.]?([0-9A-J])\b/i;
    const reNIF = /\b(\d{8})[\s\-\.]?([A-Z])\b/;
    let m = texto.match(reCIF);
    if (m) return (m[1] + m[2] + m[3]).toUpperCase();
    m = texto.match(reNIF);
    if (m) return m[1] + m[2].toUpperCase();
    return '';
  }

  function detectarProveedor(texto, conocidos = []) {
    const lineas = texto.split('\n').map(l => l.trim()).filter(l => l.length >= 3);

    // 1) Si alguna línea coincide con un proveedor ya guardado, usarlo
    for (const linea of lineas.slice(0, 15)) {
      for (const p of conocidos) {
        if (p.length >= 4 && linea.toLowerCase().includes(p.toLowerCase())) return p;
      }
    }

    // 2) Línea con forma societaria (S.L., S.A., etc.)
    const reSociedad = /\b(S\.?\s?L\.?U?|S\.?\s?A\.?U?|S\.?\s?C\.?|C\.?\s?B\.?|S\.?\s?COOP\.?|SLU|SAU)\b\.?$/i;
    for (const linea of lineas.slice(0, 12)) {
      if (reSociedad.test(linea) && linea.length <= 50) {
        return limpiarNombre(linea);
      }
    }

    // 3) Primera línea "con pinta de nombre": mayoritariamente letras, sin muchos números
    for (const linea of lineas.slice(0, 6)) {
      const letras = (linea.match(/[a-záéíóúñü]/gi) || []).length;
      const digitos = (linea.match(/\d/g) || []).length;
      if (letras >= 4 && letras > digitos * 2 && linea.length <= 40 &&
          !/factura|ticket|simplificada|fecha|tel[eé]fono|c\/|calle|avda|cif|nif/i.test(linea)) {
        return limpiarNombre(linea);
      }
    }
    return '';
  }

  function limpiarNombre(s) {
    return s.replace(/[*#|_~=]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  /* Analiza el texto completo de una factura. */
  function analizarFactura(texto, proveedoresConocidos = []) {
    return {
      proveedor: detectarProveedor(texto, proveedoresConocidos),
      nif: detectarNIF(texto),
      fecha: detectarFecha(texto),
      total: detectarTotal(texto)
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
