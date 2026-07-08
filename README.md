# 📒 CONTABLE — Control de gastos y facturación del local

Aplicación web para llevar el control de **gastos (facturas de proveedores)** e **ingresos (cierres diarios de caja)** de un pequeño negocio, pensada para preparar la información que se envía a la gestoría cada trimestre.

Funciona directamente en el móvil o el ordenador, **sin servidores y sin cuotas**: todos los datos y las fotos se guardan en tu propio dispositivo.

## ✨ Qué hace

- **📄 Facturas**: haces una foto de la factura o ticket del proveedor y la app lee la imagen (OCR en español) e intenta detectar automáticamente el **proveedor, el NIF/CIF, la fecha y el total**. Tú revisas los datos, eliges la categoría (mercancía, luz, alquiler…) y se guarda junto con la foto.
- **💰 Cierres diarios**: cada día subes la foto del ticket de cierre (Z) de la caja y la app detecta el **total de ventas** (y efectivo/tarjeta si aparecen). También puedes anotar el cierre a mano sin foto.
- **🔍 Consultar**: busca facturas y cierres **por fechas, por proveedor o por tipo**, en vista de lista o de **galería de fotos**. Tocando cualquier registro ves la imagen original y todos los datos.
- **📊 Informe trimestral**: eliges año y trimestre y genera el informe para la gestoría con:
  - **Ingresos por mes** (suma de los cierres diarios)
  - **Gastos por proveedor o servicio** (con NIF, categoría y nº de facturas)
  - Resultado del trimestre (ingresos − gastos)

  Se descarga como **CSV que abre Excel** (formato español, con tildes correctas) o se puede **imprimir / guardar en PDF**.
- **⚙️ Copia de seguridad**: exporta todos los datos (fotos incluidas) a un archivo que puedes guardar en Drive, correo, etc., y restaurarlo en otro dispositivo.

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
