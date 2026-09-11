# Verificación de WanderContable

Como la app lleva contabilidad real, estas pruebas comprueban en un navegador
de verdad que **las cuentas salen bien y que no se pierde nada**.

## Cómo ejecutarlas

```bash
npm install playwright-core     # solo la primera vez
bash pruebas/ejecutar.sh
```

Al final dice `✅ TODO CORRECTO` o lista los fallos encontrados.

## Qué se comprueba (182 comprobaciones)

**Informe trimestral** — que los ingresos y gastos del trimestre son los
correctos, que no se cuelan registros de otros meses, que se agrupan las
facturas por proveedor con su NIF, que los rangos de los cuatro trimestres son
exactos (también en año bisiesto) y que el CSV sale en formato español con
tildes y **sin datos de personal ni de la previsión interna**.

**Previsión de impuestos** — IVA repercutido y soportado, base de gastos con
facturas con retención (alquiler), retenciones a ingresar, beneficio, IRPF, y
que un IVA a compensar no se sume como si fuera a pagar.

**Formulario de facturas** — los autocálculos de base y cuota al elegir el tipo
de IVA, el desglose con varios tipos, la retención sobre la base, que la
factura se guarde completa y que no se guarden totales inválidos.

**Copia de seguridad** — que incluye registros, proveedores, personal, adelantos
y las fotos; que restaurarla en un móvil nuevo lo recupera todo; y que
restaurar la misma copia dos veces **no duplica nada**.

**Personal** — precio del día según los días pactados, descuento proporcional
por retrasos, ventas del día con retraso contadas por horas, objetivos
alcanzados o no, deuda arrastrada entre meses y liquidaciones (incluido el
caso de pagar el finiquito el mes siguiente a la baja).

**Retrasos** — que la ficha dice el día exacto en que se le descontó, las horas
que estuvo y lo que cobró ese día frente a un día normal; que las tres líneas del
fijo cuadran (`726,92 − 18,46 = 708,46`); que con **varios retrasos en un mes** las
filas suman exactamente el total; que un retraso sin horas dice que se le pagó el
día entero; que llegar más tarde que la jornada descuenta como mucho ese día y el
fijo nunca sale negativo; que unas horas guardadas como texto no inflan el total; y
que todo esto sale también en el texto que se le envía, sin nombrar el negocio.

**Trabajadores ya liquidados** — que al abonar el finiquito queda apuntado como
entrega, que su ficha se puede abrir y enseña **todas** las entregas (no solo las
del mes), el cuadre entre lo que le correspondió y lo que se le pagó, el desglose
mes a mes con la cuenta explicada, que su calendario es de solo lectura y tocarlo
no le cambia los días, que en el historial se ve esa misma ficha, que el texto que
se le envía no lleva nada del negocio ni de la app, y que reabrir la ficha lo
devuelve a los activos sin borrarle ningún pago.

**Lectura de facturas (OCR)** — reconocimiento del proveedor por NIF, totales
sin confundir el cambio de un ticket, retención del alquiler, fecha de emisión
frente a la de vencimiento y fecha de apertura en los cierres Z.

**Búsquedas** — filtros por proveedor, fechas y tipo, y el orden de los
resultados.

**Seguridad** — que el PIN no se guarda en claro, que uno incorrecto no abre la
app, y que las copias cifradas no se pueden leer sin su contraseña.

**Sincronización en la nube** — con un Firebase simulado (`stub-firebase.js`,
no toca la nube real): subida inicial de todo lo que ya había, compresión de
las fotos, llegada de cambios de otro dispositivo, borrados en ambos sentidos,
conflictos de edición y que desconectar la nube no borre nada del móvil.

## Si algo falla

El fallo dice qué comprobación no pasó y con qué valor. Conviene arreglarlo
antes de seguir usando la app para la contabilidad del trimestre en curso.
