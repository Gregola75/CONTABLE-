/* WanderContable — el aviso diario: qué dice la notificación del móvil.

   Lo carga el service worker (sw.js) y también la página. Cuando llega el
   "toque" diario, el móvil mira SUS datos y escribe el aviso con esto: las
   cuentas no salen del teléfono.

   Es un resumen sencillo a propósito, no las cuentas completas de la app (esas
   viven en js/app.js y necesitan la pantalla): si falta el cierre de ayer, si
   hay trabajadores con días ya pasados sin marcar y, si el dueño lo activa,
   cuánto se lleva vendido en el mes. El parte completo está al abrir la app.

   Sin "detalle" (lo normal) el aviso no enseña importes ni nombres, porque una
   notificación se lee con el móvil bloqueado, sin pasar por el PIN. */
(function (raiz) {
  'use strict';

  const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const MES_SUELDO_POR_MES = '2026-10';   // desde aquí un día sin marcar no se paga (igual que en js/app.js)

  const aISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hoy = () => aISO(new Date());
  const sumar = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return aISO(d); };
  const diaSemana = (iso) => new Date(iso + 'T00:00:00').getDay();
  const eur = (n) => Number(n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  const lista = (nombres) => nombres.length <= 1 ? (nombres[0] || '') : `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;

  /* ¿Abre el local ese día de la semana? Si en las últimas 8 semanas hay
     cierres pero ninguno cae en ese día, es que cierra: no se reclama. Con poca
     historia no se supone nada y se reclama. */
  function abreEseDia(diarios, fecha) {
    const desde = sumar(fecha, -56);
    const recientes = diarios.filter(c => c.fecha >= desde && c.fecha < fecha);
    if (recientes.length < 8) return true;
    return recientes.some(c => diaSemana(c.fecha) === diaSemana(fecha));
  }

  /* Los días ya pasados de este mes que un trabajador tiene sin marcar. Se deja
     un día de margen (el de ayer puede estar aún por apuntar), como en la app. */
  function diasSinMarcar(t, fechaHoy) {
    const mes = fechaHoy.slice(0, 7);
    if (mes < MES_SUELDO_POR_MES) return [];
    const ayer = sumar(fechaHoy, -1);
    const fechasDe = (l) => (l || []).map(x => (typeof x === 'string' ? x : (x && x.fecha))).filter(Boolean);
    const marcados = new Set([...fechasDe(t.dias), ...fechasDe(t.descansos), ...fechasDe(t.faltas), ...fechasDe(t.tardes), ...fechasDe(t.cerrados)]);
    const sin = [];
    for (let f = mes + '-01'; f < ayer; f = sumar(f, 1)) {
      if (t.inicio && f < t.inicio) continue;
      if (t.fin && f > t.fin) continue;
      if (!marcados.has(f)) sin.push(f);
    }
    return sin;
  }

  /* El aviso de hoy a partir de los registros y el personal guardados en el móvil.
     opciones.detalle: enseñar importes y nombres (por defecto no). */
  function calcular(registros, personal, fechaHoy, opciones = {}) {
    const detalle = !!opciones.detalle;
    const mes = fechaHoy.slice(0, 7);
    const ayer = sumar(fechaHoy, -1);
    const cierres = (registros || []).filter(r => r && r.tipo === 'cierre' && r.fecha);
    const diarios = cierres.filter(c => !c.mensual);
    const delMes = cierres.filter(c => c.fecha.startsWith(mes));
    const ventas = Math.round(delMes.reduce((s, c) => s + (c.total || 0), 0) * 100) / 100;
    const noches = delMes.filter(c => !c.mensual).length;

    const avisos = [];
    // 1) El cierre de ayer (salvo que ese mes se lleve con el total, o que ese día no abra)
    const mesDeAyerConTotal = cierres.some(c => c.mensual && c.fecha.startsWith(ayer.slice(0, 7)));
    if (!diarios.some(c => c.fecha === ayer) && !mesDeAyerConTotal && abreEseDia(diarios, ayer)) {
      avisos.push(`falta el cierre de ayer (${DIAS[diaSemana(ayer)]})`);
    }
    // 2) Trabajadores con días ya pasados sin marcar: no se les pagan
    const conHuecos = (personal || [])
      .filter(t => t && !t.esRRPP && !t.liquidado)
      .map(t => ({ nombre: t.nombre || 'Alguien', dias: diasSinMarcar(t, fechaHoy).length }))
      .filter(x => x.dias > 0);
    if (conHuecos.length) {
      avisos.push(detalle
        ? `${lista(conHuecos.map(x => x.nombre))} ${conHuecos.length === 1 ? 'tiene' : 'tienen'} días sin marcar`
        : (conHuecos.length === 1 ? 'hay 1 trabajador con días sin marcar' : `hay ${conHuecos.length} trabajadores con días sin marcar`));
    }

    const progreso = detalle
      ? (noches || ventas
        ? `${MESES[+mes.slice(5) - 1]}: ${eur(ventas)}${noches ? ` en ${noches} ${noches === 1 ? 'noche' : 'noches'}` : ''}.`
        : `${MESES[+mes.slice(5) - 1]}: aún sin cierres apuntados.`)
      : 'Toca para ver cómo va el mes.';
    const frase = avisos.join(' · ');
    return {
      titulo: avisos.length ? `📣 ${avisos.length} aviso${avisos.length === 1 ? '' : 's'} pendiente${avisos.length === 1 ? '' : 's'}` : '📣 Parte de hoy',
      cuerpo: avisos.length ? `${frase.charAt(0).toUpperCase()}${frase.slice(1)}.\n${progreso}` : `Todo apuntado ✓. ${progreso}`,
      avisos,
      hayAvisos: avisos.length > 0
    };
  }

  raiz.PARTE_AVISOS = { calcular, hoy, abreEseDia, diasSinMarcar };
})(typeof self !== 'undefined' ? self : this);
