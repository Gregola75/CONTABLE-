/* CONTABLE — informe trimestral para la gestoría.
   Ingresos por mes (cierres) y gastos por proveedor/servicio (facturas). */

const INFORME = (() => {
  const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

  function rangoTrimestre(anio, trimestre) {
    const mesInicio = (trimestre - 1) * 3; // 0, 3, 6, 9
    const desde = `${anio}-${String(mesInicio + 1).padStart(2, '0')}-01`;
    const ultimoDia = new Date(anio, mesInicio + 3, 0).getDate();
    const hasta = `${anio}-${String(mesInicio + 3).padStart(2, '0')}-${String(ultimoDia).padStart(2, '0')}`;
    return { desde, hasta, meses: [mesInicio, mesInicio + 1, mesInicio + 2] };
  }

  function eur(n) {
    return (n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }

  async function generar(anio, trimestre) {
    const { desde, hasta, meses } = rangoTrimestre(anio, trimestre);
    const registros = await DB.buscar({ desde, hasta });

    // Ingresos por mes (cierres)
    const ingresosPorMes = {};
    meses.forEach(m => { ingresosPorMes[m] = { total: 0, dias: 0 }; });
    registros.filter(r => r.tipo === 'cierre').forEach(r => {
      const mes = parseInt(r.fecha.slice(5, 7), 10) - 1;
      if (ingresosPorMes[mes] !== undefined) {
        ingresosPorMes[mes].total += (r.total || 0);
        ingresosPorMes[mes].dias += 1;
      }
    });

    // Gastos por proveedor/servicio (facturas)
    const gastosPorProveedor = {};
    registros.filter(r => r.tipo === 'factura').forEach(r => {
      const clave = (r.proveedor || 'Sin proveedor').trim() || 'Sin proveedor';
      if (!gastosPorProveedor[clave]) {
        gastosPorProveedor[clave] = { total: 0, facturas: 0, categoria: r.categoria || '', nif: r.nif || '' };
      }
      gastosPorProveedor[clave].total += (r.total || 0);
      gastosPorProveedor[clave].facturas += 1;
      if (!gastosPorProveedor[clave].nif && r.nif) gastosPorProveedor[clave].nif = r.nif;
    });

    const totalIngresos = meses.reduce((s, m) => s + ingresosPorMes[m].total, 0);
    const totalGastos = Object.values(gastosPorProveedor).reduce((s, g) => s + g.total, 0);

    // Detalle de IVA de cada factura (solo para la previsión interna)
    const facturasDetalle = registros.filter(r => r.tipo === 'factura').map(r => ({
      total: r.total || 0,
      baseImponible: (typeof r.baseImponible === 'number') ? r.baseImponible : null,
      ivaCuota: (typeof r.ivaCuota === 'number') ? r.ivaCuota : null
    }));

    return { anio, trimestre, desde, hasta, meses, ingresosPorMes, gastosPorProveedor, totalIngresos, totalGastos, facturasDetalle };
  }

  /* Previsión interna de impuestos del trimestre (orientativa, no se exporta).
     cfg: { ivaVentas, ivaGastos, irpfActivo, irpf } */
  function prevision(inf, cfg) {
    const rv = (cfg.ivaVentas || 0) / 100;
    const rd = (cfg.ivaGastos || 0) / 100;

    // IVA repercutido: el IVA incluido en las ventas de los cierres
    const baseIngresos = rv > 0 ? inf.totalIngresos / (1 + rv) : inf.totalIngresos;
    const ivaRepercutido = inf.totalIngresos - baseIngresos;

    // IVA soportado: cuota detectada en cada factura; si no la hay, se estima
    let ivaSoportado = 0;
    let baseGastos = 0;
    let facturasEstimadas = 0;
    (inf.facturasDetalle || []).forEach(f => {
      if (f.ivaCuota !== null) {
        ivaSoportado += f.ivaCuota;
        baseGastos += (f.baseImponible !== null) ? f.baseImponible : (f.total - f.ivaCuota);
      } else if (rd > 0) {
        const b = f.total / (1 + rd);
        ivaSoportado += f.total - b;
        baseGastos += b;
        facturasEstimadas++;
      } else {
        baseGastos += f.total;
        facturasEstimadas++;
      }
    });

    const ivaResultado = ivaRepercutido - ivaSoportado;
    const beneficio = baseIngresos - baseGastos;
    const irpfEstimado = cfg.irpfActivo ? Math.max(0, beneficio) * ((cfg.irpf || 0) / 100) : null;

    const r2 = (n) => Math.round(n * 100) / 100;
    return {
      baseIngresos: r2(baseIngresos),
      ivaRepercutido: r2(ivaRepercutido),
      baseGastos: r2(baseGastos),
      ivaSoportado: r2(ivaSoportado),
      ivaResultado: r2(ivaResultado),
      beneficio: r2(beneficio),
      irpfEstimado: irpfEstimado === null ? null : r2(irpfEstimado),
      totalPrevisto: r2(Math.max(0, ivaResultado) + (irpfEstimado || 0)),
      facturasEstimadas,
      numFacturas: (inf.facturasDetalle || []).length
    };
  }

  function renderPrevisionHTML(prev, cfg) {
    const avisoEstimadas = prev.facturasEstimadas > 0
      ? `<p class="hint">⚠️ En ${prev.facturasEstimadas} de ${prev.numFacturas} facturas no se detectó el IVA y se ha estimado al ${cfg.ivaGastos} %. Puedes corregirlo abriendo cada factura.</p>`
      : '';

    return `
      <table class="informe-tabla">
        <tbody>
          <tr><td>Ventas sin IVA (base)</td><td class="num">${eur(prev.baseIngresos)}</td></tr>
          <tr><td>IVA cobrado en ventas (repercutido, ${cfg.ivaVentas} %)</td><td class="num">${eur(prev.ivaRepercutido)}</td></tr>
          <tr><td>Gastos sin IVA (base)</td><td class="num">${eur(prev.baseGastos)}</td></tr>
          <tr><td>IVA pagado en compras (soportado)</td><td class="num">−${eur(prev.ivaSoportado)}</td></tr>
          <tr class="total">
            <td>IVA del trimestre (aprox. modelo 303)</td>
            <td class="num" style="color:${prev.ivaResultado >= 0 ? '#b23a3a' : '#2e8b57'}">
              ${prev.ivaResultado >= 0 ? 'a pagar ' + eur(prev.ivaResultado) : 'a compensar ' + eur(-prev.ivaResultado)}
            </td>
          </tr>
          ${prev.irpfEstimado !== null ? `
          <tr><td>Beneficio del trimestre (sin IVA)</td><td class="num">${eur(prev.beneficio)}</td></tr>
          <tr class="total">
            <td>IRPF a cuenta (aprox. modelo 130, ${cfg.irpf} %)</td>
            <td class="num" style="color:#b23a3a">${eur(prev.irpfEstimado)}</td>
          </tr>` : ''}
          <tr class="total">
            <td>💶 TOTAL PREVISTO A RESERVAR</td>
            <td class="num" style="color:#b23a3a;font-size:1.05rem">${eur(prev.totalPrevisto)}</td>
          </tr>
        </tbody>
      </table>
      ${avisoEstimadas}
      <p class="hint">Es una aproximación: no tiene en cuenta retenciones, gastos deducibles especiales, recargos ni tu situación personal. Confírmalo siempre con tu gestoría.</p>
    `;
  }

  function renderHTML(inf) {
    const filasIngresos = inf.meses.map(m => `
      <tr>
        <td>${MESES[m]} ${inf.anio}</td>
        <td class="num">${inf.ingresosPorMes[m].dias}</td>
        <td class="num">${eur(inf.ingresosPorMes[m].total)}</td>
      </tr>`).join('');

    const proveedoresOrdenados = Object.entries(inf.gastosPorProveedor)
      .sort((a, b) => b[1].total - a[1].total);

    const filasGastos = proveedoresOrdenados.map(([nombre, g]) => `
      <tr>
        <td>${escapar(nombre)}${g.nif ? `<br><small style="color:#6b7280">${escapar(g.nif)}</small>` : ''}</td>
        <td>${escapar(g.categoria)}</td>
        <td class="num">${g.facturas}</td>
        <td class="num">${eur(g.total)}</td>
      </tr>`).join('');

    const balance = inf.totalIngresos - inf.totalGastos;

    return `
      <h2 style="color:#1a5c3a">Informe ${inf.trimestre}º trimestre ${inf.anio}</h2>
      <p style="font-size:.85rem;color:#6b7280">Periodo: ${formatear(inf.desde)} a ${formatear(inf.hasta)} · Generado el ${formatear(hoyISO())}</p>

      <h3 class="informe-titulo">📈 Ingresos por mes</h3>
      <table class="informe-tabla">
        <thead><tr><th>Mes</th><th class="num">Días con cierre</th><th class="num">Ingresos</th></tr></thead>
        <tbody>
          ${filasIngresos}
          <tr class="total"><td>TOTAL INGRESOS</td><td></td><td class="num">${eur(inf.totalIngresos)}</td></tr>
        </tbody>
      </table>

      <h3 class="informe-titulo">📉 Gastos por proveedor / servicio</h3>
      ${proveedoresOrdenados.length ? `
      <table class="informe-tabla">
        <thead><tr><th>Proveedor</th><th>Categoría</th><th class="num">Nº fact.</th><th class="num">Importe</th></tr></thead>
        <tbody>
          ${filasGastos}
          <tr class="total"><td>TOTAL GASTOS</td><td></td><td></td><td class="num">${eur(inf.totalGastos)}</td></tr>
        </tbody>
      </table>` : '<p class="vacio">No hay facturas en este trimestre.</p>'}

      <div class="informe-balance">
        <strong>Resultado del trimestre:</strong>
        <span style="color:${balance >= 0 ? '#2e8b57' : '#b23a3a'};font-weight:700"> ${eur(balance)}</span>
        <br><small style="color:#6b7280">(ingresos ${eur(inf.totalIngresos)} − gastos ${eur(inf.totalGastos)})</small>
      </div>
    `;
  }

  /* CSV con punto y coma (formato español para Excel) y BOM UTF-8. */
  function generarCSV(inf) {
    const L = [];
    const num = (n) => (n || 0).toFixed(2).replace('.', ',');
    L.push(`INFORME TRIMESTRAL;${inf.trimestre}º trimestre ${inf.anio}`);
    L.push(`Periodo;${formatear(inf.desde)} a ${formatear(inf.hasta)}`);
    L.push('');
    L.push('INGRESOS POR MES');
    L.push('Mes;Dias con cierre;Ingresos (EUR)');
    inf.meses.forEach(m => {
      L.push(`${MESES[m]} ${inf.anio};${inf.ingresosPorMes[m].dias};${num(inf.ingresosPorMes[m].total)}`);
    });
    L.push(`TOTAL INGRESOS;;${num(inf.totalIngresos)}`);
    L.push('');
    L.push('GASTOS POR PROVEEDOR / SERVICIO');
    L.push('Proveedor;NIF/CIF;Categoria;Numero de facturas;Importe (EUR)');
    Object.entries(inf.gastosPorProveedor)
      .sort((a, b) => b[1].total - a[1].total)
      .forEach(([nombre, g]) => {
        L.push(`${csvCampo(nombre)};${csvCampo(g.nif)};${csvCampo(g.categoria)};${g.facturas};${num(g.total)}`);
      });
    L.push(`TOTAL GASTOS;;;;${num(inf.totalGastos)}`);
    L.push('');
    L.push(`RESULTADO DEL TRIMESTRE;;;;${num(inf.totalIngresos - inf.totalGastos)}`);
    return '\uFEFF' + L.join('\r\n');
  }

  function csvCampo(s) {
    s = String(s || '');
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function descargarCSV(inf) {
    const csv = generarCSV(inf);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `informe_${inf.anio}_T${inf.trimestre}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function formatear(iso) {
    if (!iso) return '';
    const [a, m, d] = iso.split('-');
    return `${d}/${m}/${a}`;
  }

  function hoyISO() {
    const f = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`;
  }

  function escapar(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return { generar, prevision, renderPrevisionHTML, renderHTML, generarCSV, descargarCSV, eur, formatear, MESES };
})();
