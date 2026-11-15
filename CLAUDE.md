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
| `index.html` | Toda la interfaz, en pestañas (Inicio, Facturas, Facturación, Consultar, Personal, RRPP, Informes, Ajustes), más la burbuja flotante del asesor |
| `js/db.js` | Almacenamiento local (IndexedDB): registros, proveedores, personal, pagos |
| `js/nube.js` | Sincronización con Firebase (Firestore) del proyecto del propio usuario |
| `js/ocr.js` | Lectura de fotos con Tesseract y detección de proveedor, fechas, totales, IVA y retenciones |
| `js/report.js` | Informe trimestral, CSV para la gestoría y previsión interna de impuestos |
| `js/app.js` | Lógica de la interfaz y todos los cálculos de personal |
| `js/asesor.js` | El asesor: chat con Claude que contesta con los datos de la app (ver más abajo) |
| `js/vendor/anthropic-sdk.js` | SDK oficial de Anthropic empaquetado en un archivo (no editar; la cabecera dice cómo rehacerlo) |
| `js/seguridad.js` | PIN de acceso, huella y cifrado de las copias de seguridad |
| `sw.js` | Service worker (caché offline) |
| `pruebas/` | Verificación de la app (ver más abajo) |

**Al cambiar cualquier archivo de la app hay que subir la versión de la caché**
en `sw.js` (`const CACHE = 'contable-vNN'`), o los móviles seguirán con la
versión antigua.

**El arranque no depende de nada externo.** `index.html` **no** carga Tesseract ni
Firebase con `<script src>`: los cargan `js/ocr.js` y `js/nube.js` por su cuenta, y solo
cuando hacen falta. Si volvieran al HTML, el móvil tendría que procesarlos enteros
**antes** de que `js/seguridad.js` existiera, o sea antes de que la huella pudiera
responder (medido: unos 600 ms de espera de más). Hay dos comprobaciones que lo vigilan.
Sin conexión todo sigue: la nube queda "apagada" y una foto avisa de que no se pudo
cargar el lector, en vez de romperse.

**Con PIN, la app arranca sin pintar nada pesado.** Lo que se ve al entrar (el panel de
inicio y las listas recientes) queda en `pendienteTrasDesbloqueo` y se pinta al desbloquear
(`desbloqueada()`), para que la huella no compita con nada. Sin PIN se pinta al momento. La
fuente de Google se carga sin bloquear (`rel="preload" as="style"`): con mala cobertura,
esperar a la hoja de estilos retrasaba la primera pintada varios segundos.

**Las fotos se guardan ligeras y con miniatura.** Al guardar una factura o un cierre,
`optimizarFoto` deja la foto a 2.000 px como mucho (JPEG; con el zoom se sigue leyendo el
IVA) y crea `miniatura` (220 px) para las listas. Antes cada lista obligaba al móvil a
decodificar diez fotos de 12 megapíxeles para enseñar 52 px, y eso era lo que hacía lenta la
app al abrir y al buscar. Las listas usan `r.miniatura || r.imagen`, con `loading="lazy"`
(ojo: una imagen en diferido dentro de una pestaña oculta no se carga hasta que se ve). A
las fotos guardadas antes se les crea la miniatura en segundo plano
(`crearMiniaturasQueFaltan`, unos segundos después de arrancar), guardando con
`{ remoto: true }` para **no** cambiar `mod` ni volver a subir nada a la nube. La miniatura
es solo local: `nube.js` la quita al subir y `db.js` al exportar la copia (se rehace al
restaurar). `window.APP` expone `inicio`, `recientes` y `miniaturas` para la verificación.

## Reglas de negocio (acordadas con el dueño, no cambiar sin preguntar)

**Facturas e impuestos**
- IVA español: 21 / 10 / 4 / 5 / 0 %, y facturas con varios tipos a la vez.
- Casilla **"gasto personal o de casa"** (`personal: true`): SÍ se envía a
  la gestoría, pero en un **apartado aparte** del informe y del CSV ("Gastos
  personales / de casa — a valorar por la gestoría"), sin sumarse a los gastos
  del negocio ni al resultado: la gestoría decide qué parte es deducible. En
  la previsión interna no se descuentan (prudencia) y no entran en las
  estadísticas del negocio.
- **Apunte del total de un trimestre** (`trimestral: true`): para empresas cuyas
  facturas se cargan de golpe (la asesoría, etc.), el apunte manual permite elegir
  "una factura con su fecha" o "el total de un trimestre". El registro se guarda
  con la fecha del **primer día del trimestre** y la marca `trimestral`. Entra en
  el informe de la gestoría como un gasto más, y en el repaso de gastos que faltan
  **cubre sus tres meses**. Aviso de doble cuenta en los dos sentidos: al guardar
  el total si ya hay facturas sueltas del proveedor en ese trimestre, y al guardar
  una suelta si ya está el total. Ojo: en las vistas por mes (Inicio y cuadro de
  mando) el total cae entero en el primer mes del trimestre, no se reparte.
- Al guardar una factura se avisa si ya existe otra con el mismo proveedor,
  fecha y total (contarla dos veces deduce IVA de más) y si el desglose no
  cuadra (`base + IVA − retención ≠ total`). Son avisos con confirmación, no
  bloqueos.
- Con los cierres, el aviso de "se contaría DOS VECES" salta **en los dos sentidos**:
  al guardar el total del mes si ya hay cierres diarios, y al guardar un cierre diario
  si ya hay total del mes. Antes solo saltaba en el primero y los ingresos podían ir
  duplicados al informe de la gestoría.
- Retención de IRPF típica del alquiler (19 %) y de profesionales (15 / 7 %).
  En una factura con retención, el total pagado ya lleva la retención
  descontada: `base = total − IVA + retención`.
- La previsión de impuestos (IVA, retenciones, IRPF) es **solo interna**: nunca
  debe aparecer en el CSV ni en la impresión que va a la gestoría.
- **Repaso de gastos que faltan en el trimestre** (`INFORME.queFaltaDe`): compara
  el trimestre con el anterior, solo facturas del negocio (las de casa no). Un
  proveedor con facturas en ≥2 meses del trimestre anterior se trata como mensual
  y se reclama cada mes **ya terminado** que no tenga factura; uno que apareció un
  solo mes se reclama una vez, y solo cuando el trimestre entero ha acabado. Nunca
  se reclama un mes sin terminar. Sale como aviso (Inicio y cuadro de mando)
  mientras el trimestre cerrado no esté marcado como guardado, y como tarjeta
  "Repaso antes de enviarlo" al generar el informe (`#faltan-card`). Es **solo
  interno**: jamás en el CSV ni en la impresión.

**Facturación (cierres de caja)**
- La pestaña se llama "Facturación". Tiene el panel "Cómo va el mes": total,
  media por día, comparación con el mes anterior por media diaria, mejor día,
  días más flojos, media por día de la semana y días sin cierre anotado.
- **Formas de pago**: cada cierre puede desglosarse en **efectivo, tarjeta y
  SumUp** (los tres opcionales; el OCR detecta "SumUp" antes que "tarjeta" para
  que "TARJETA SUMUP" cuente como SumUp). Si el total está vacío se rellena solo
  con la suma según se escribe (sin pisar un total puesto a mano, vía
  `dataset.auto`), y si el desglose suma más que el total se avisa antes de
  guardar. El panel del mes y la tarjeta "El trimestre entero" (`#ftri-resumen`,
  con su año y trimestre) enseñan "cómo entró el dinero": efectivo, tarjeta,
  SumUp y lo sin desglosar, con su % del total, y el trimestre además por mes.
- La fecha de un ticket Z es la de **apertura** de caja, no la de impresión
  (una caja abierta el 11 que cierra de madrugada el 12 es venta del 11).

**Inicio** (la primera pestaña, lo que se ve al abrir; solo interno)
- El panel visual del negocio (`pintarInicio`): el mes con ◀ ▶, cuatro cifras grandes
  (ventas con la variación frente al mes anterior, gastos y personal con su % de las ventas,
  y lo que queda con el margen), media por día con cierre, botones de "Nueva factura" y
  "Cierre de caja", los mismos avisos que el cuadro de mando (`alertasDelMes`, botón
  `.tri-hecho`), y gráficos dibujados en SVG sin librerías: **ventas de cada día** (mejor
  día en verde, media en dorado, día sin cierre como guion rojo), **últimos 6 meses**
  (ventas frente a gastos + personal, con lo que quedó encima), **en qué se va cada euro**
  (barra apilada al 100 % con cada partida, personal y lo que queda), los **cinco
  proveedores que más pesan** y el **equipo** (días del mes y lo pendiente con cada uno).
- Todo sale de UNA lectura de la base de datos (`datosMesDe(regs, trabajadores, mes)`, la
  versión sin `await` de `datosMes`) y no toca ninguna foto, para que aparezca al instante
  tras desbloquear. Los números son los mismos del cuadro de mando: comparten
  `datosMesDe`, `deudaConElEquipo` y `alertasDelMes`.
- Ojo con `toLocaleString('es-ES')`: un número de cuatro cifras sale **sin** punto de
  millar (`3000,00 €`), así que las comprobaciones usan `3\.?000`.

**Cuadro de mando** (pestaña Informes, arriba; solo interno)
- Por mes: ingresos, gastos del negocio, coste de personal devengado, **todos los
  costes juntos**, lo que queda y el margen, con % de cada partida sobre las ventas y
  comparación con el mes anterior. Los gastos de casa se muestran aparte y no restan.
- **Por proveedor** (`porProveedor` en `datosMes`): cada proveedor del mes (el alquiler,
  el de las bebidas, la luz…) con su total, su categoría y el % de la facturación que se
  lleva, más el personal y la línea "todo junto". Lo pidió el dueño: ver qué % de lo que
  factura se va en cada cosa. Los gastos de casa no entran.
- Alertas: trimestre cerrado pendiente de guardar (botón "Ya lo hice", clave
  `contable-trimestre-guardado` en localStorage), días sin cierre, facturas
  sin desglose de IVA, deuda total con el equipo y **trabajadores con días ya pasados sin
  marcar** (con el sueldo por mes no se pagan; se deja un día de margen: el de ayer aún no
  avisa). `APP.alertas(mes)` las da en texto para la verificación.

**Personal** (pestaña privada, tampoco sale en el informe de la gestoría)
- **El sueldo es POR MES** (acordado con el dueño, desde octubre de 2026,
  `MES_SUELDO_POR_MES`): **precio del día = sueldo ÷ los días que tiene ese mes
  natural** (31 → el día vale menos, 30 → más, febrero → más todavía) y se pagan
  los días **trabajados + los de descanso** (`c.diasPagados`), así el mes completo
  es el sueldo justo. Una falta o un día sin marcar no se paga. `calcularMes`
  devuelve `porMes`, `divisor`, `diasPagados`, `precioDia` y `sinMarcar` (días ya
  pasados sin marcar: la ficha los avisa con su fecha para que no se queden sin
  pagar por un olvido). Todo lo que escribe el fijo usa `fijoCuenta(c)`
  ("900,00 € ÷ 31 × 31") y `fijoQueEs(c)` ("los 31 días que tiene octubre × los 31
  que se le pagan (26 trabajados + 5 de descanso)"), y el precio del día sale de
  `c.precioDia`, no de `precioDeUnDia(t)`.
- **Los meses anteriores a octubre de 2026 no se reescriben**: se pagaron con la
  cuenta antigua, **sueldo ÷ días de trabajo pactados** (`diasMes`, 26 por defecto)
  **× días trabajados**, y siguen así (igual que la comisión por tramos). El campo
  "Días que trabaja al mes" del formulario solo cuenta para esos meses.
- Estados de cada día en el calendario: trabajó · 🛌 descansó · ⏰ llegó tarde (pregunta
  cuántas horas) · 🚫 faltó (pregunta el motivo) · sin marcar. **Un toque abre un menú**
  (`abrirMenuDia`, en el modal de la app) y se elige el estado directamente: nada de dar
  vueltas por los demás ni pasar por preguntas que no tocan. Si el día ya es un retraso, el
  menú ofrece cambiar las horas; si ya es una falta, cambiar el motivo. **Cancelar una
  pregunta cierra el menú y no cambia nada.** Antes era un ciclo de toques: marcar una
  falta costaba 4 toques y 2 preguntas, y cancelar la de las horas dejaba el día atascado.
  Los días anteriores a su fecha de inicio (o posteriores a su baja) salen bloqueados.
- **Las horas de retraso se leen como las escribe una persona** (`leerHoras`): `1,5`,
  `1:30`, `1h30`, `45 min`, `media hora`, `½`. Lo que no se entiende se vuelve a
  preguntar, nunca se guarda como 0. Un número suelto mayor que la jornada (`30`) casi
  siempre son minutos: se pregunta "¿son 30 MINUTOS?" antes de guardar 30 horas y
  quitarle el día entero. Si son horas de verdad y pasan de la jornada, se pide confirmar.
  Cancelar deja el día como estaba.
- **El descanso se marca, no se adivina** (`t.descansos`). Antes se calculaba restando
  los trabajados y las faltas a los días del mes, y cualquier día sin marcar se colaba
  como descanso: a un empleado le salían 3 descansos cuando solo había descansado 2.
  Un día sin marcar **no cuenta como nada**.
- **Semana sin librar** (`semanasSinDescanso`, expuesta como `APP.semanas`): cada
  trabajador tiene 1 día libre a la semana; si una semana (de lunes a domingo, la
  semana es del mes de su lunes) tiene **los 7 días marcados como trabajados**
  (venir tarde es venir), sale un aviso en el Inicio y en el cuadro de mando con el
  nombre y las fechas. Solo con los 7 marcados: un día sin marcar no lo dispara.
  **Es solo para el dueño**: no va en los mensajes que se le envían al trabajador.
- **Retrasos**: descuentan del fijo la parte proporcional
  (`horas de retraso ÷ horas de jornada × precio del día`). Jornada por
  defecto 7,5 h (el local abre de 20:00 a 3:30). El descuento se calcula con el
  **precio del día ya redondeado** y **día a día**, no sobre la suma del mes, para
  que el desglose que se le enseña al trabajador cuadre al céntimo si lo comprueba
  con una calculadora. Nunca puede pasar del fijo del mes (llegar tarde hace perder
  como mucho el día, nunca más). El fijo bruto se escribe como
  `sueldo ÷ días del mes × días trabajados`, **no** como `precio del día × días`,
  porque lo segundo no cuadra a mano (900 ÷ 26 son 34,615…, no 34,62 justos).
- La ficha de cada trabajador, activo o liquidado, tiene el apartado **"Dónde se le
  descontó por llegar tarde"**: una fila por día con las horas que estuvo, lo que
  cobró ese día frente a un día normal y lo que se le quitó. Va también en el texto
  que se le envía por WhatsApp. Un día marcado como retraso pero con 0 horas dice
  que se le pagó entero, para que no parezca un olvido.
- **La regla se le explica con palabras al propio trabajador**, no solo el resultado:
  "se cobra por día trabajado, la jornada es de X h y el día sale a Y €; el día que se
  llega tarde se paga solo la parte del día que se estuvo". Y en cada día se enseña la
  división hecha (`horas ÷ jornada × precio del día = descuento`). La división se
  escribe sobre el **descuento**, no sobre lo cobrado, porque el descuento es lo que la
  app calcula de verdad y así las dos líneas cuadran al céntimo si las comprueba a mano.
- Existe el **total de toda su etapa**: cuántos días llegó tarde y cuánto se le descontó
  en total. En la ficha de un liquidado sale **arriba, junto al cuadre**, sin tener que
  desplegar ningún mes, y en el texto de toda su etapa va en un apartado propio con
  todos los días. Antes la ficha se leía como "esto era, se te dio, ya está pagado".
- **Comisiones por objetivos, por tramos "de la diferencia"** (acordado con el
  dueño; antes se aplicaba el % del tramo más alto a toda la base): el % de cada
  tramo se aplica **solo a la parte de las ventas que cae en su tramo**. El
  primero, al alcanzarlo, paga sobre toda la base (10.000 al 2 % → 200,00 €);
  lo que pasa del objetivo del siguiente va al % del siguiente: con 10.000→2 %
  y 15.000→3 %, hacer 15.100 son 2 % de 15.000 + 3 % de 100 = 303,00 €. Así
  subir de tramo nunca multiplica la comisión entera. Si no llega al primer
  objetivo, cobra **solo el fijo**. Los objetivos no se prorratean nunca. Cada
  parte se redondea por separado (`c.comisionTramos`) y la ficha, la cuenta
  explicada y los mensajes escriben el desglose (`comisionEscrita`:
  "2 % de 15.000,00 € + 3 % de 100,00 €"), para que cuadre con calculadora.
  **La fórmula nueva vale desde octubre de 2026** (`MES_COMISION_POR_TRAMOS`):
  los meses anteriores se pagaron con la antigua y no se reescriben, igual que
  un cambio de sueldo no toca lo ya pagado; en esos meses `comisionTramos`
  lleva un único tramo con toda la base, así que la explicación antigua sigue
  siendo verdad ("3 % de 15.100,00 €").
- El apartado **"🎯 Su objetivo"** sale en la ficha del activo, en cada mes de la
  del liquidado y en los dos textos que se le envían: el objetivo pactado (el primer
  tramo), lo **facturado en sus días** y lo que faltó para llegar. Si alcanza un tramo
  se dice cuál y su comisión, y además lo que faltó para el de arriba si lo hay.
  **Nunca se le enseña la facturación del local**: solo la base de sus días. Si no
  tiene tramos pactados, el bloque no aparece. En el resumen de toda su etapa se
  añade el total facturado en sus días, avisando de que los objetivos son de cada
  mes y no se suman.
- **Base de ventas de cada empleado**: solo los días que él trabajó. Los días
  con retraso cuentan en proporción a sus horas
  (`venta del día ÷ horas de jornada × horas trabajadas`). Sus días libres o
  de falta no cuentan nada.
- **Los días que no vino** se enseñan con su fecha, no solo el número, en la ficha
  (activo y liquidado) y en los dos textos que se le envían. Una falta no descuenta
  dinero: simplemente ese día no está entre los trabajados.
- **Motivo de cada ausencia**: al pasar un día a "faltó" se pregunta por qué (opcional).
  Se guarda como nota de ese día con `motivoFalta: true` y sale junto a la fecha en la
  ficha ("sin motivo apuntado" si se dejó en blanco). Si el día deja de ser ausencia, el
  motivo se quita; las notas normales del día se quedan. **Es solo para el dueño: no va
  en los mensajes que se le envían.** Cancelar la pregunta deja el día como estaba.
- Los dos mensajes empiezan con los recuentos: **días trabajados, días de descanso y
  días que no vino** (estos con su fecha), todos salidos de lo que está marcado. La línea
  de descanso **solo sale si hay alguno marcado**: los meses de antes de poder marcarlos
  dirían "0" y eso, en una prueba de pago, sería falso.
- En los mensajes, un retraso solo se explica si **descontó dinero** (sin sueldo fijo no
  hay "cobró 0,00 € en vez de 0,00 €"), y si actuó el tope se dice, para que las filas y
  el total cuadren también ahí.
- **En los mensajes NO se escribe que los días no trabajados no se pagan.** Lo pidió el
  dueño: esa frase por escrito se puede usar en su contra. El motivo del importe ya se
  entiende con la línea del fijo (`sueldo ÷ días del mes × días trabajados`).
- **Los mensajes que se le envían NO mencionan las horas de jornada.** El dueño lo pidió
  expresamente: no conviene dejar por escrito una jornada que no todos los días es igual.
  El retraso se explica con las horas que llegó tarde y el dinero (`cobró 16,16 € en vez
  de 34,62 €`), sin la división. **En la ficha sí se mantiene** la división completa
  (`4 h ÷ 7,5 h × 34,62 € = 18,46 €`), porque es donde el dueño comprueba la cuenta.
- **Las cuentas llegan hasta el día de la baja, no hasta el día del finiquito.** Un día
  marcado antes del alta o después de la baja **no se paga** (`calcularMes` y
  `ventasParaTrabajador` filtran por `inicio`/`fin`) y la ficha avisa de cuántos hay
  fuera de periodo. Los meses posteriores a la baja **no salen** en la lista de "lo que
  le correspondió, mes a mes": el finiquito aparece donde le toca, en lo que se le pagó.
  **Ojo**: el bucle de `desgloseDeuda` NO se acorta, porque un pago posterior a la baja
  tiene que seguir descontando de la deuda (hay dos pruebas que lo exigen); lo único que
  se filtra es qué meses entran en la lista.
- **Cambiar el sueldo, los días, la jornada o los objetivos NO reescribe los meses
  pasados.** El formulario tiene el campo "valen desde" (`#pe-desde`, un mes). El
  historial vive en `t.condiciones = [{ desde: 'AAAA-MM' | '' (desde siempre), sueldoMensual,
  diasMes, horasJornada, tramos }]` y `calcularMes`/`ventasParaTrabajador` usan las
  condiciones vigentes en cada mes (`trabajadorEn(t, mes)`). Cada `c` lleva `c.cond`, y todo
  lo que se pinta a partir de un `c` usa esas condiciones (`condDe(t, c)`), para que la
  explicación de un mes antiguo diga el sueldo de entonces. Los campos sueltos de `t` son
  siempre los vigentes hoy. Con "desde" **en blanco** es una corrección de todo el historial
  (se borra `condiciones`): es lo que la app hacía siempre antes, ahora explícito. Antes,
  subir el sueldo a alguien que estaba al día lo dejaba "debiéndole" la diferencia de todos
  los meses ya pagados.
- **Desde cuándo vale el sueldo, a la vista** (lo pidió el dueño al subirle el sueldo a un
  chico): la ficha abre con **"💶 Su sueldo"** (`sueldoVigenteHTML`, con `periodosSueldo`):
  cada periodo con su importe, "desde … hasta …", cuál está vigente ahora y cuál es el del
  mes que se ve, más la cuenta del mes (`En noviembre 2026 (30 días) el día sale a 31,67 €;
  el mes completo, 950,00 €`). En el formulario, el campo «valen desde» va **justo debajo
  del sueldo** con "Ahora mismo: 900,00 € desde que empezó" (`#pe-sueldo-actual`), y el
  formulario se trae a la vista al editar. **Al guardar un cambio se pide confirmación**
  con lo que cambia, desde qué mes vale, que los meses de antes se quedan con el sueldo de
  antes y el precio del día resultante; cancelar no guarda nada y deja el formulario
  abierto. Guardar otro cambio con el mismo «desde» sustituye al anterior, no se acumula.
- **La cuenta se congela al liquidar** (`t.cuadreLiquidacion`, con `fotoDelCuadre`): fecha, lo
  que le correspondió, lo pagado y los meses. La ficha del liquidado compara la cuenta de hoy
  con la cerrada: si coinciden lo dice con un candado; si algo cambió después (un cierre, un
  día, una entrega) avisa en rojo y **vale la cuenta que se cerró**. El texto de toda la
  etapa dice "Cuenta cerrada el X" y usa los totales cerrados. Reabrir borra la foto.
- **La deuda es general, no mensual**: se arrastra de un mes a otro. La vista
  principal muestra el total pendiente; el detalle por meses va plegado. **Pero si el
  total no es solo lo de este mes, el reparto sale a la vista** (`origenDelTotalHTML`):
  una línea por cada mes que deja saldo, **con la cuenta de ese mes a la vista**
  (sueldo de entonces ÷ días pactados × días que vino, retrasos, comisión, bono, y lo
  que le llegó de las entregas — lo pidió el dueño para poder "verificar el coste del
  día" de un mes viejo sin cambiar de mes; necesita `desgloseDeuda` con detalle), y una
  pista de cómo corregirlo (la fecha de alta, un día del calendario o el sueldo con su
  «valen desde»). Y el botón **"✓ Lo de antes ya se lo pagué: apuntarlo"**
  (`.per-saldar-viejo`): si el dinero se dio en mano y no se apuntó, un toque apunta una
  entrega por lo que queda sin cubrir de cada mes **ya terminado** (nunca el mes en
  curso ni el que se está viendo), con fecha de ese mes y la nota "Ya estaba pagado",
  tras una pregunta que dice mes a mes lo que se va a apuntar (cancelar no apunta
  nada). Se recalcula al pulsar. Caso real: alta
  el 31 de agosto con ese día marcado y 16 € entregados; viendo septiembre la cabecera
  decía "Le debes 918,62 €" con un fijo de 900,00 € y nada a la vista explicaba los
  18,62 €. El mensaje que se le envía reparte igual el pendiente de otros meses.
- **El reparto de lo pendiente se imputa a lo más antiguo** (`m.pendiente` en
  `desgloseDeuda`): todas las entregas juntas, en orden, cubren primero los meses
  más viejos. Caso real: un trabajador al día salvo el mes en curso salía
  "debiendo viejo" solo porque el sueldo de septiembre se pagó a primeros de
  octubre. Con la imputación, septiembre queda cubierto y la ficha dice
  "Meses anteriores ✓ todo pagado · este mes +X". `m.saldo` (lo devengado y lo
  dado DENTRO de ese mes) no se toca: es el hecho contable del detalle plegado, y
  **el mensaje al trabajador tampoco cambia** (sus líneas cuadran con
  calculadora: este mes ± arrastre = total). Solo cambia la explicación del
  dueño en la ficha.
- En la línea del fijo se dice qué es cada número (`sueldo ÷ los 26 días pactados al mes
  × los 26 días que vino`), porque cuando coinciden "÷ 26 × 26" no se entiende.
- **Bonos** (`t.bonos = [{ fecha, importe, motivo }]`): un extra que el dueño decide darle
  a alguien un mes, si quiere. Se apunta en la ficha del activo (fecha, importe y motivo
  opcional) y **se suma a lo que le corresponde ese mes** (`calcularMes` devuelve `bonos` y
  `bono`; `devengado = fijo + comisión + bono`), así que arrastra como deuda igual que el
  resto y entra en el coste de personal del cuadro de mando. **No es una entrega**: el
  dinero se apunta luego como pago, como siempre. Sale en la ficha (activo y liquidado, en
  su mes), en la cuenta explicada y en los dos textos, con el motivo
  (`Bono (cubrió a un compañero): 50,00 €` y `fijo + comisión + bono = total`). Sin bono, los
  textos no cambian ni una coma. Un bono con fecha fuera de su etapa no se guarda, para que
  no se pierda en un mes que no se enseña. Al guardar la ficha se conservan (`bonos:
  actual.bonos`), como los días.
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
- Al dar de baja a alguien al que se le adelantó **más** de lo que le correspondía, la
  ficha dice "TE DEBE ÉL A TI" con el importe, la cabecera "Te debe X" y el aviso de
  liquidar lo repite. Antes ponía "No le debes nada 0,00 €" y lo escondía.
- Al **guardar la ficha** (sueldo, objetivos, fechas) se relee el trabajador de la base de
  datos en ese momento y del formulario solo salen los campos del formulario. El
  calendario sigue a la vista con el formulario abierto, y los días que se marquen
  mientras tanto no se pierden.
- **El historial va plegado** (`#per-historial-plegado`): un toque lo abre o lo
  cierra (crece con los años) y se recuerda si estaba abierto para que un
  repintado no lo cierre. Las pruebas lo destapan con `destaparHistorial()`
  antes de tocar dentro.
- **Nada se borra por antigüedad**: los 10 días solo deciden cuándo baja al historial, y
  allí se queda indefinidamente. Para que no se pierda la prueba por un toque, a un
  trabajador **liquidado no se le puede eliminar**: hay que reabrir su ficha primero.

**RRPP / promotores** (pestaña propia, separada de Personal; tampoco va a la gestoría)
- Tienen **su pestaña** con su selector de mes (`#rrpp-mes`, `pintarRRPPTab`):
  todo lo del bloque RRPP repinta esa pestaña, no la de Personal.
- Viven en el almacén de personal con `esRRPP: true` (así la nube y la copia de
  seguridad los llevan solos) y **todas las vistas de trabajadores los filtran**
  (`pintarPersonal`, `deudaConElEquipo`, rentabilidad, historial…). Sus entregas
  van al almacén de pagos normal (notas `RRPP`).
- **Sin sueldo fijo**: cobran **por semana** (lunes a domingo; la semana es del
  mes de su lunes) sobre la **primera consumición de cada cliente** que traen.
  Comisión por tramos "de la diferencia", cada tramo con SUS ventas (por defecto
  20 % de los primeros 200, 25 % de los siguientes 300, 30 % de lo que pase de
  500; configurable por persona en su ficha). Cada parte se redondea aparte
  (`calcularSemanaRRPP`, expuesta como `APP.rrppSemana`).
- **El bono es DEL DÍA, no de cada RRPP** (`bonoDelDia`, `guardarNocheRRPP` /
  `APP.rrppNoche`): el primer RRPP al que se le apunta la noche fija el bono
  (importe y cifra a SUPERAR; 150 justos no dan bono; por defecto 20 € si pasa
  de 150, cambiable cada día: 10, 20, 30…), a los demás de esa noche se les
  aplica solo sin preguntar, y corregirlo lo cambia para todos los de esa noche.
- Tienen **calendario como los trabajadores** (`calendarioRRPPHTML`): se toca el
  día, se apunta lo facturado esa noche (0 la quita; cancelar no cambia nada).
  La ficha lleva **"Comenzó el"** (`inicio`): los días anteriores salen
  bloqueados y una noche de antes del inicio no se guarda
  (`guardarNocheRRPP` la descarta).
- **Lo que factura un RRPP se descuenta de la venta del día en la base de
  comisión de los trabajadores** (`ventasParaTrabajador` recibe `rrpps`;
  `desgloseDeuda` los lee solo si no se los pasan): contarlo dos veces sería
  pagar comisión doble. Y sus semanas entran como **coste de personal** del mes
  de su lunes (`costeRRPPDe` dentro de `costePersonalDe`), así el Inicio y el
  cuadro de mando cuentan ese dinero.
- El resumen semanal para enviarle (`textoSemanaRRPP`) es neutro y cuadra con
  calculadora: noches con su bono, ventas, comisión tramo a tramo y total.
- **Al pagar se le explica la cuenta** (`textoCuentaRRPP`, expuesta como
  `APP.rrppCuenta`): al apuntar una entrega la app ofrece enviarle la cuenta
  completa — cada semana con su comisión tramo a tramo y sus bonos, todo lo
  recibido con fechas y el pendiente a día de hoy — y hay botón para enviarla
  en cualquier momento ("Enviar la cuenta completa").
- Un RRPP solo se puede **eliminar si no tiene noches ni entregas**; con
  historial, se conserva como prueba.

## El asesor (burbuja flotante)

Un chat donde el dueño pregunta por su negocio y le contesta "un asesor financiero
de bares de copas". Lo pidió así: que hable con seguridad, que vaya aprendiendo,
**que no se invente datos** y que **le apunte lo que le dicta** ("Movistar, 45 €,
ayer"; "100 en efectivo a Jeferson hoy"). Es solo interno: no sale en el CSV ni en la
impresión.

- **Es una burbuja flotante** (`#ase-burbuja`), no una pestaña: está en todas las
  pantallas y al tocarla abre el panel del chat (`#ase-panel`), que saluda por el nombre
  ("¿Qué tal, Gregory? ¿Qué necesitas?"; el nombre se cambia en la rueda ⚙️ del panel,
  `contable-asesor-nombre`). Va por debajo de los avisos, el visor y la pantalla de
  bloqueo, y no se imprime. La rueda ⚙️ enseña lo aprendido, el nombre, la clave y la
  privacidad.
- **Apuntar es lo único que puede escribir, y nunca solo** (`apuntar_gasto`,
  `apuntar_cierre`, `apuntar_entrega`, `marcar_dias`): `APP.asesor.prepararGasto` /
  `prepararCierre` / `prepararEntrega` / `prepararDias` comprueban lo dictado y
  devuelven el registro, las líneas de una **tarjeta de confirmación** y **los mismos
  avisos que el formulario** (factura duplicada, total de trimestre ya guardado, cierre
  ya apuntado ese día, total del mes ya guardado, desglose que suma más que el total,
  fecha futura, proveedor sin dar de alta). El dueño ve la tarjeta y **solo se guarda si
  pulsa Guardar** (`guardarApunte`); con Cancelar no se guarda nada y al modelo se le dice.
  Si falta el proveedor, el importe o la fecha, no hay tarjeta: se le devuelve que lo
  pregunte. El registro queda igual que uno del formulario (con `origen: 'asesor'`), el
  proveedor se escribe como ya está en la app (el dado de alta o el de sus facturas
  anteriores, porque el informe agrupa por nombre exacto) y el IVA solo se desglosa si se
  dice; con retención, `total = base + IVA − retención`. **No puede cambiar ni borrar
  facturas, cierres o entregas ya apuntados, ni tocar sueldos o bonos, ni las noches de un
  RRPP**: no hay herramienta para eso. Tras guardar se repinta la pantalla que se esté
  viendo (`refrescarPantalla`).
- **Días del calendario** (`prepararDias`, lo pidió el dueño: "debería apuntar los días de
  los trabajadores si se lo pido"): trabajó, descansó, faltó (con motivo), llegó tarde (con
  horas) o sin marcar, para días sueltos o un tramo, un estado por llamada. Usa
  `ponerEstadoDia`, **la misma lógica del menú del calendario** (un día, un estado), sin sus
  preguntas. La tarjeta dice para quién, qué días, cómo se marcan y **cómo cambia lo que le
  corresponde ese mes** ("150,00 € (ahora 30,00 €)", con la cuenta de Personal), y avisa si
  se cambia una marca que ya había, si hay días futuros o si alguno queda fuera de su etapa
  (esos no se marcan). No marca a un RRPP ni a un liquidado, ni un retraso sin horas, y si
  todo estaba ya así dice que no hay nada que cambiar. Al guardar se relee al trabajador.
- **Avisos y parte del día** (lo pidió así: "enviarme notificaciones de cómo va todo o
  alguna alerta"). La app no tiene servidor, así que **no puede avisar con el móvil
  cerrado**; lo que hace: cada vez que pinta el Inicio del mes en curso publica el parte
  (`publicarParte` → `window.APP_PARTE` + evento `contable-parte`: ventas, noches, media y
  la del mes anterior, gastos, personal, lo que queda y los avisos de `alertasDelMes` en
  texto). Si hay avisos **nuevos** (otro día u otros avisos que los ya vistos,
  `contable-asesor-parte-visto`) sale su número sobre la burbuja (`#ase-globo`), y al abrir
  el chat se enseña el parte (`#ase-parte`); el megáfono 📣 lo vuelve a enseñar. Lo calcula
  la app: **ni clave ni saldo**. Con clave ofrece "Coméntamelo", que le pide el parte al
  asesor.
- **Entregas al equipo** (`prepararEntrega`, lo pidió el dueño: "100 efectivo a Jeferson
  hoy"): adelantos, pagas y pagos a RRPP, al almacén de pagos de siempre (a un RRPP, con la
  nota `RRPP`). **Si varias personas coinciden con el nombre no elige** (`buscarPersona`):
  devuelve la lista numerada con lo que las distingue (tipo, estado, cuándo empezó, sueldo)
  y su `persona_id`, el asesor pregunta "¿al 1 o al 2?" y vuelve a llamar con ese
  identificador. La tarjeta enseña **lo que se le debe hoy y cómo quedará después**, y avisa
  si ya hay una entrega igual ese día, si la fecha es futura o anterior a su alta, o si con
  ella se le adelanta de más. A un **liquidado no se le apunta nada** (cuenta cerrada: hay
  que reabrir su ficha). Cómo se pagó ("en efectivo") va en la nota. La herramienta
  `trabajador` acepta también `persona_id` y da `este_mes.lo_que_vale_cada_dia` (sueldo ÷
  días del mes) y lo pendiente, que es lo que el dueño pregunta ("qué le debo y qué vale
  cada día").

- **Es Claude (Anthropic), llamado desde el navegador** con la clave del propio dueño
  (`contable-asesor-clave` en localStorage). La app no tiene servidor, así que se usa el
  SDK oficial con `dangerouslyAllowBrowser`, cargado solo al usar la pestaña desde
  `js/vendor/anthropic-sdk.js` (un archivo propio: el arranque sigue sin depender de nada
  externo). Modelo `claude-opus-5-5`, esfuerzo `medium`, y `fallbacks: "default"` (beta
  `server-side-fallback-2026-07-01`) para que una negativa por error se reintente sola.
  **Sin clave no se envía nada**: el panel solo explica cómo activarlo y qué datos salen.
- **Cada cifra la da la app, no el modelo.** Claude no tiene las cuentas: las pide con
  herramientas que se ejecutan en el móvil (`APP.asesor` en `js/app.js`: `resumenMes`,
  `evolucion`, `ventasPorDia`, `facturas`, `proveedores`, `personalMes`, `trabajador`,
  `impuestosTrimestre`, `avisos`), que reutilizan **las mismas funciones** del Inicio, el
  cuadro de mando y Personal (`datosMesDe`, `desgloseDeuda`, `INFORME.prevision`…). Si se
  cambia una cuenta de la app, el asesor la hereda; no hay que duplicar nada. Las
  herramientas de consulta son **solo de lectura** y nunca devuelven fotos. Las listas largas se recortan **diciéndolo** y con los
  totales de todo, nunca en silencio.
- Las cuentas las hace con la herramienta `calcular` (un lector propio de `+ − × ÷` y
  paréntesis, sin `eval`), no "de cabeza".
- **Debajo de cada respuesta se enseña qué datos consultó** ("📊 Datos consultados en tu
  app: Resumen de octubre de 2026"), **qué apuntó** ("✍️ Apuntado en la app: Movistar ·
  45,00 € · 12/11/2026") o, si no hizo ninguna de las dos cosas, "Respuesta sin consultar
  datos de la app (conocimiento general del asesor)", y lo que costó aprox. en dólares. Si
  la respuesta falla después de haber guardado algo, el aviso lo dice igualmente.
- **Va aprendiendo** con las herramientas `recordar` / `olvidar`: notas cortas en
  `contable-asesor-memoria` que se le vuelven a dar en cada pregunta y que el dueño ve y
  puede borrar en "🧠 Lo que el asesor ha aprendido". Lo que guarda a mitad de una
  respuesta vale desde la siguiente (las instrucciones se fijan al empezar la pregunta).
- De la conversación (`contable-asesor-chat`) se reenvían las últimas preguntas y
  respuestas **como texto**; los datos consultados entonces no, para que siempre vuelva a
  pedir los de ahora. Dentro de una misma pregunta el contenido de Claude se devuelve tal
  cual llegó (lo exige la API para seguir el hilo).
- **La clave, la conversación y lo aprendido viven solo en el dispositivo**: no van a la
  nube de la app ni a las copias de seguridad (hay una comprobación). Pendiente conocido:
  por eso lo aprendido no pasa de un dispositivo a otro.
- **Nada falla en silencio**: clave inválida, sin saldo, sin conexión, servicio caído o una
  negativa del modelo salen como aviso en el chat, y la pregunta se conserva.
- El texto del asesor se pinta escapado (`aHTML`: solo párrafos, **negrita** y listas).
- El tono y las reglas están en `INSTRUCCIONES` (`js/asesor.js`). Si se cambia una regla de
  negocio que el asesor deba conocer (cómo cuenta la app), hay que actualizarla también ahí.

## Sincronización en la nube

Firebase del propio usuario (proyecto `wandercontable`), con reglas que solo
permiten el acceso a su cuenta de Google. Cada registro lleva `sid`
(identificador estable) y `mod` (fecha de modificación) para reconciliar; los
borrados dejan una "lápida" en la colección `borrados`. Las fotos se comprimen
a JPEG para caber en un documento de Firestore.

La app **debe seguir funcionando igual sin nube y sin conexión**: Firebase se
carga aparte y si falta, todo sigue en local.

**Restaurar una copia de seguridad conserva la fecha de modificación (`mod`) de cada
registro** (`importarTodo` guarda con `conservarMod`). Si se le pusiera la de hoy, al
conectar la nube lo restaurado pisaría datos más nuevos que hubiera allí (al estrenar
móvil, la copia de hace un mes machacaría ese mes en la nube). Una copia antigua sin
`mod` se trata como muy vieja: gana la nube. Pendiente conocido: si un registro restaurado
fue borrado en la nube, su lápida lo vuelve a borrar en la siguiente sincronización.

## Verificar antes de publicar

```bash
cd pruebas && npm install     # solo la primera vez
bash pruebas/ejecutar.sh
```

Son 498 comprobaciones en un navegador real sobre los cálculos de dinero, las
copias de seguridad, el personal, el OCR, la seguridad, el asesor (con un Claude
simulado: no gasta saldo ni necesita clave) y la sincronización.
Debe terminar en `✅ TODO CORRECTO`. Ver `pruebas/README.md`.

## Estilo

Interfaz y comentarios **en español**, pensados para alguien sin conocimientos
técnicos: mensajes claros, nada de jerga. Tema oscuro (negro y plata), diseñado
para móvil. Los errores nunca deben fallar en silencio: si algo no se puede
guardar, hay que decirlo en pantalla.
