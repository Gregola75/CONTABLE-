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

**El arranque no depende de nada externo.** `index.html` **no** carga Tesseract ni
Firebase con `<script src>`: los cargan `js/ocr.js` y `js/nube.js` por su cuenta, y solo
cuando hacen falta. Si volvieran al HTML, el móvil tendría que procesarlos enteros
**antes** de que `js/seguridad.js` existiera, o sea antes de que la huella pudiera
responder (medido: unos 600 ms de espera de más). Hay dos comprobaciones que lo vigilan.
Sin conexión todo sigue: la nube queda "apagada" y una foto avisa de que no se pudo
cargar el lector, en vez de romperse.

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
- Con los cierres, el aviso de "se contaría DOS VECES" salta **en los dos sentidos**:
  al guardar el total del mes si ya hay cierres diarios, y al guardar un cierre diario
  si ya hay total del mes. Antes solo saltaba en el primero y los ingresos podían ir
  duplicados al informe de la gestoría.
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
- Estados de cada día en el calendario, por toques: 1 = trabajó · 2 = 🛌 descansó ·
  3 = ⏰ llegó tarde (pregunta cuántas horas) · 4 = faltó · 5 = sin marcar. Los días
  anteriores a su fecha de inicio (o posteriores a su baja) salen bloqueados.
  El descanso va el segundo porque es lo segundo más frecuente (un día a la semana).
- **El descanso se marca, no se adivina** (`t.descansos`). Antes se calculaba restando
  los trabajados y las faltas a los días del mes, y cualquier día sin marcar se colaba
  como descanso: a un empleado le salían 3 descansos cuando solo había descansado 2.
  Un día sin marcar **no cuenta como nada**.
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
- **Comisiones por objetivos**: tramos de ventas; se aplica el % del tramo más
  alto alcanzado. Si no llega al primer objetivo, cobra **solo el fijo**.
  Los objetivos son la cifra pactada y no se prorratean nunca.
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
- Al dar de baja a alguien al que se le adelantó **más** de lo que le correspondía, la
  ficha dice "TE DEBE ÉL A TI" con el importe, la cabecera "Te debe X" y el aviso de
  liquidar lo repite. Antes ponía "No le debes nada 0,00 €" y lo escondía.
- Al **guardar la ficha** (sueldo, objetivos, fechas) se relee el trabajador de la base de
  datos en ese momento y del formulario solo salen los campos del formulario. El
  calendario sigue a la vista con el formulario abierto, y los días que se marquen
  mientras tanto no se pierden.
- **Nada se borra por antigüedad**: los 10 días solo deciden cuándo baja al historial, y
  allí se queda indefinidamente. Para que no se pierda la prueba por un toque, a un
  trabajador **liquidado no se le puede eliminar**: hay que reabrir su ficha primero.

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

Son 256 comprobaciones en un navegador real sobre los cálculos de dinero, las
copias de seguridad, el personal, el OCR, la seguridad y la sincronización.
Debe terminar en `✅ TODO CORRECTO`. Ver `pruebas/README.md`.

## Estilo

Interfaz y comentarios **en español**, pensados para alguien sin conocimientos
técnicos: mensajes claros, nada de jerga. Tema oscuro (negro y plata), diseñado
para móvil. Los errores nunca deben fallar en silencio: si algo no se puede
guardar, hay que decirlo en pantalla.
