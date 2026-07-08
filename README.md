# WanderContable — Control de gastos y facturación del local

Aplicación web para llevar el control de **gastos (facturas de proveedores)** e **ingresos (cierres diarios de caja)** de un pequeño negocio, pensada para preparar la información que se envía a la gestoría cada trimestre.

Funciona directamente en el móvil o el ordenador, **sin servidores y sin cuotas**: todos los datos y las fotos se guardan en tu propio dispositivo.

## ✨ Qué hace

- **📄 Facturas**: haces una foto de la factura o ticket del proveedor y la app lee la imagen (OCR en español) e intenta detectar automáticamente el **proveedor, el NIF/CIF, la fecha y el total**. Tú revisas los datos, eliges la categoría (mercancía, luz, alquiler…) y se guarda junto con la foto.
- **🏪 Mis proveedores**: puedes dar de alta tus proveedores habituales a mano (nombre, NIF y categoría habitual). Al procesar la foto de una factura, la app comprueba si el proveedor **ya está en tu lista** (por NIF o por nombre, aunque cambien tildes o mayúsculas) y te avisa: «✅ Proveedor reconocido» o «🆕 Proveedor nuevo». Si es reconocido, rellena solo el NIF y la categoría; si es nuevo, puede añadirlo automáticamente a tu lista al guardar la factura.
- **💰 Cierres diarios**: cada día subes la foto del ticket de cierre (Z) de la caja y la app detecta el **total de ventas** (y efectivo/tarjeta si aparecen). También puedes anotar el cierre a mano sin foto.
- **🔍 Consultar**: busca facturas y cierres **por fechas, por proveedor o por tipo**, en vista de lista o de **galería de fotos**. Tocando cualquier registro ves la imagen original y todos los datos.
- **📊 Informe trimestral**: eliges año y trimestre y genera el informe para la gestoría con:
  - **Ingresos por mes** (suma de los cierres diarios)
  - **Gastos por proveedor o servicio** (con NIF, categoría y nº de facturas)
  - Resultado del trimestre (ingresos − gastos)

  Se descarga como **CSV que abre Excel** (formato español, con tildes correctas) o se puede **imprimir / guardar en PDF**.
- **🧾 IVA y retenciones**: al leer una factura también detecta la **base imponible, el tipo de IVA (21/10/4 %) y la cuota**, incluso con varios tipos en la misma factura, y la **retención de IRPF** típica del alquiler del local (19 %) o de profesionales (15 %/7 %). Si el ticket no trae desglose, se puede calcular automáticamente eligiendo el tipo.
- **📎 Facturas en PDF**: además de fotos, se pueden cargar **archivos PDF** guardados en el dispositivo (facturas recibidas por correo electrónico); la app convierte la primera página en imagen y la lee igual que una foto.
- **🔒 Previsión de impuestos (solo interna)**: junto al informe del trimestre, la app muestra una tarjeta aparte con lo que **aproximadamente** te tocará pagar: IVA del trimestre (IVA cobrado en ventas menos IVA pagado en compras, estilo modelo 303), las **retenciones a ingresar** (por ejemplo la del alquiler del local, modelo 115) y opcionalmente el pago a cuenta de IRPF (modelo 130). Esta previsión **no se incluye en el CSV ni en la impresión** que se envía a la gestoría — es solo para ti, para reservar el dinero. Los tipos de IVA de tus ventas y el % de IRPF se configuran en Ajustes.
- **⚙️ Copia de seguridad**: exporta todos los datos (fotos incluidas) a un archivo que puedes guardar en Drive, correo, etc., y restaurarlo en otro dispositivo. Al exportar puedes ponerle **contraseña**: la copia se cifra con AES-256 y sin la contraseña nadie puede abrirla.
- **🔐 Seguridad**: los datos viven solo en tu dispositivo (nada se sube a servidores). Además puedes activar un **PIN de acceso** — la app arranca bloqueada y se vuelve a bloquear tras un minuto en segundo plano — y el **desbloqueo con huella o cara** del teléfono (WebAuthn). El PIN no se guarda en claro (hash PBKDF2 con sal) y si se falla 5 veces hay que esperar 30 segundos. Importante: si olvidas el PIN, la única salida es borrar los datos y restaurar una copia de seguridad.

## 🚀 Cómo ponerla en marcha

### Opción recomendada: GitHub Pages (gratis)

1. Entra en la configuración del repositorio en GitHub: **Settings → Pages**.
2. En **Source**, elige **Deploy from a branch**, selecciona la rama principal y la carpeta `/ (root)`. Guarda.
3. En un par de minutos tendrás la app en `https://TU-USUARIO.github.io/NOMBRE-DEL-REPO/`.
4. Abre esa dirección en el móvil con Chrome o Safari.

### Instalarla como app en el móvil

- **Android (Chrome)**: abre la web → menú ⋮ → **«Añadir a pantalla de inicio»** / «Instalar aplicación».
- **iPhone (Safari)**: abre la web → botón de compartir → **«Añadir a pantalla de inicio»**.

Queda como una app más, con su icono, y funciona incluso sin conexión (tras la primera apertura).

### Probarla en el ordenador

Basta con servir la carpeta, por ejemplo:

```bash
python3 -m http.server 8080
# y abrir http://localhost:8080
```

## 📱 Uso diario recomendado

1. Cuando llegue una factura de un proveedor → pestaña **Facturas** → 📷 foto → revisar datos → guardar.
2. Al cerrar el local cada día → pestaña **Cierres** → 📷 foto del cierre Z → revisar el total → guardar.
3. Al final de cada trimestre → pestaña **Informe** → generar → **Descargar CSV** → enviarlo a la gestoría por correo o WhatsApp.
4. De vez en cuando → pestaña **⚙️** → **Descargar copia de seguridad** y guardarla en un lugar seguro.

## ⚠️ Importante

- La lectura automática de las fotos (OCR) **puede equivocarse**, sobre todo con tickets arrugados o fotos con poca luz. **Revisa siempre** el proveedor, la fecha y el total antes de guardar (la app te los muestra para confirmar).
- Los datos viven **solo en el navegador del dispositivo** donde los guardas. Si borras los datos del navegador, se pierden: haz copias de seguridad con regularidad.
- Consejos para mejores fotos: buena luz, el documento plano y ocupando toda la pantalla.

## 🧱 Tecnología

- HTML + CSS + JavaScript puro (sin frameworks, sin compilación).
- [Tesseract.js](https://tesseract.projectnaptha.com/) para el OCR en español, ejecutado **en el propio dispositivo** (las fotos no se suben a ningún servidor).
- IndexedDB para guardar registros e imágenes.
- PWA: instalable y con funcionamiento sin conexión (service worker).
