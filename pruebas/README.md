# Verificación de WanderContable

Como la app lleva contabilidad real, estas pruebas comprueban en un navegador
de verdad que **las cuentas salen bien y que no se pierde nada**.

## Cómo ejecutarlas

```bash
npm install playwright-core     # solo la primera vez
bash pruebas/ejecutar.sh
```

Al final dice `✅ TODO CORRECTO` o lista los fallos encontrados.

## Qué se comprueba (101 comprobaciones)

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
