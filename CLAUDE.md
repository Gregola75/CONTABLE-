# WanderContable — notas para trabajar en este proyecto

App web (PWA) de contabilidad para un bar/local: facturas de gasto, cierres de
caja, informe trimestral para la gestoría y control privado de personal.
**Se usa en producción para la contabilidad real del negocio**, así que hay que
tratar los cálculos de dinero con cuidado y verificar antes de publicar.

## Cómo está montada

Sin framework ni compilación: HTML + CSS + JavaScript plano, todo en el
navegador. Se publica en GitHub Pages (`https://gregola75.github.io/CONTABLE-/`)
desde la rama por defecto del repositorio.

| Archivo | Qué hace |
|---|---|
| `index.html` | Toda la interfaz, en pestañas (Facturas, Cierres, Consultar, Personal, Informe, Ajustes) |
| `js/db.js` | Almacenamiento local (IndexedDB): registros, proveedores, personal, pagos |
| `js/nube.js` | Sincronización con Firebase (Firestore) del proyecto del propio usuario |
| `js/ocr.js` | Lectura de fotos con Tesseract y detección de proveedor, fechas, totales, IVA y retenciones |
| `js/report.js` | Informe trimestral, CSV para la gestoría y previsión interna de impuestos |
| `js/app.js` | Lógica de la interfaz y todos los cálculos de personal |
| `js/seguridad.js` | PIN de acceso, huella y cifrado de las copias de seguridad |
| `sw.js` | Service worker (caché offline) |
| `pruebas/` | Verificación de la app (ver más abajo) |

**Al cambiar cualquier archivo de la app hay que subir la versión de la caché**
en `sw.js` (`const CACHE = 'contable-vNN'`), o los móviles seguirán con la
versión antigua.

## Reglas de negocio (acordadas con el dueño, no cambiar sin preguntar)

**Facturas e impuestos**
- IVA español: 21 / 10 / 4 / 5 / 0 %, y facturas con varios tipos a la vez.
- Casilla **"gasto personal o de casa"** (`personal: true`): SÍ se envía a
  la gestoría, pero en un **apartado aparte** del informe y del CSV ("Gastos
  personales / de casa — a valorar por la gestoría"), sin sumarse a los gastos
  del negocio ni al resultado: la gestoría decide qué parte es deducible. En
  la previsión interna no se descuentan (prudencia) y no entran en las
  estadísticas del negocio.
- Al guardar una factura se avisa si ya existe otra con el mismo proveedor,
  fecha y total (contarla dos veces deduce IVA de más) y si el desglose no
  cuadra (`base + IVA − retención ≠ total`). Son avisos con confirmación, no
  bloqueos.
- Retención de IRPF típica del alquiler (19 %) y de profesionales (15 / 7 %).
  En una factura con retención, el total pagado ya lleva la retención
  descontada: `base = total − IVA + retención`.
- La previsión de impuestos (IVA, retenciones, IRPF) es **solo interna**: nunca
  debe aparecer en el CSV ni en la impresión que va a la gestoría.

**Facturación (cierres de caja)**
- La pestaña se llama "Facturación". Tiene el panel "Cómo va el mes": total,
  media por día, comparación con el mes anterior por media diaria, mejor día,
  días más flojos, media por día de la semana y días sin cierre anotado.
- La fecha de un ticket Z es la de **apertura** de caja, no la de impresión
  (una caja abierta el 11 que cierra de madrugada el 12 es venta del 11).

**Cuadro de mando** (pestaña Informes, arriba; solo interno)
- Por mes: ingresos, gastos del negocio, coste de personal devengado, lo que
  queda y el margen, con % de cada partida sobre las ventas y comparación con
  el mes anterior. Los gastos de casa se muestran aparte y no restan.
- Alertas: trimestre cerrado pendiente de guardar (botón "Ya lo hice", clave
  `contable-trimestre-guardado` en localStorage), días sin cierre, facturas
  sin desglose de IVA y deuda total con el equipo.

**Personal** (pestaña privada, tampoco sale en el informe de la gestoría)
- Sueldo mensual pactado con ~1 día libre a la semana → **precio del día =
  sueldo ÷ días de trabajo al mes** (26 por defecto, configurable por persona).
  Se paga por día trabajado; el día que no viene, no se paga.
- Estados de cada día en el calendario, por toques: 1 = trabajó · 2 = llegó
  tarde (pregunta cuántas horas) · 3 = faltó · 4 = nada. Los días anteriores a
  su fecha de inicio (o posteriores a su baja) salen bloqueados.
- **Retrasos**: descuentan del fijo la parte proporcional
  (`horas de retraso ÷ horas de jornada × precio del día`). Jornada por
  defecto 7,5 h (el local abre de 20:00 a 3:30).
- **Comisiones por objetivos**: tramos de ventas; se aplica el % del tramo más
  alto alcanzado. Si no llega al primer objetivo, cobra **solo el fijo**.
  Los objetivos son la cifra pactada y no se prorratean nunca.
- **Base de ventas de cada empleado**: solo los días que él trabajó. Los días
  con retraso cuentan en proporción a sus horas
  (`venta del día ÷ horas de jornada × horas trabajadas`). Sus días libres o
  de falta no cuentan nada.
- **La deuda es general, no mensual**: se arrastra de un mes a otro. La vista
  principal muestra el total pendiente; el detalle por meses va plegado.
- Al dar de baja, se calcula el finiquito completo; al abonarlo queda 10 días
  visible y luego pasa al historial como prueba de pago.
- **Un trabajador liquidado conserva su ficha entera y comprobable**, tanto esos
  10 días como ya en el historial: todas las entregas que se le hicieron (con el
  finiquito marcado), el cuadre (lo que le correspondió frente a lo que se le
  pagó) y, mes a mes, su calendario y la cuenta explicada paso a paso. Es la
  prueba con la que contestarle si discute su cuenta, y se le puede enviar
  entera por WhatsApp con el mismo texto neutro. Su calendario queda en **solo
  lectura** (se pinta con `<span>`, no con botones desactivados, porque
  `.dia:disabled` taparía los días trabajados). Para corregir algo hay que
  **reabrir la ficha**, que la devuelve a los activos sin borrar ningún pago.

## Sincronización en la nube

Firebase del propio usuario (proyecto `wandercontable`), con reglas que solo
permiten el acceso a su cuenta de Google. Cada registro lleva `sid`
(identificador estable) y `mod` (fecha de modificación) para reconciliar; los
borrados dejan una "lápida" en la colección `borrados`. Las fotos se comprimen
a JPEG para caber en un documento de Firestore.

La app **debe seguir funcionando igual sin nube y sin conexión**: Firebase se
carga aparte y si falta, todo sigue en local.

## Verificar antes de publicar

```bash
cd pruebas && npm install     # solo la primera vez
bash pruebas/ejecutar.sh
```

Son 154 comprobaciones en un navegador real sobre los cálculos de dinero, las
copias de seguridad, el personal, el OCR, la seguridad y la sincronización.
Debe terminar en `✅ TODO CORRECTO`. Ver `pruebas/README.md`.

## Estilo

Interfaz y comentarios **en español**, pensados para alguien sin conocimientos
técnicos: mensajes claros, nada de jerga. Tema oscuro (negro y plata), diseñado
para móvil. Los errores nunca deben fallar en silencio: si algo no se puede
guardar, hay que decirlo en pantalla.
