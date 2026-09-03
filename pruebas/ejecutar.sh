#!/usr/bin/env bash
# Verificación completa de WanderContable.
# Levanta la app en un servidor local, la abre en un navegador de verdad
# y comprueba los cálculos de dinero, los datos y la sincronización.
#
#   bash pruebas/ejecutar.sh
#
# Requisitos: node, python3 y playwright-core (npm i playwright-core).
# El navegador se toma de CHROME_PATH si está definido.

set -u
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUERTO_APP=8904
PUERTO_NUBE=8903
TMP="$(mktemp -d)"
FALLOS=0

limpiar() {
  kill $PID_APP $PID_NUBE 2>/dev/null
  rm -rf "$TMP"
}
trap limpiar EXIT

# 1) La app tal cual, para las pruebas de contabilidad
python3 -m http.server $PUERTO_APP --directory "$RAIZ" >/dev/null 2>&1 &
PID_APP=$!

# 2) Una copia con el Firebase simulado, para las pruebas de sincronización
cp -r "$RAIZ"/* "$TMP"/ 2>/dev/null
cp "$RAIZ/pruebas/stub-firebase.js" "$TMP/stub-firebase.js"
python3 - "$TMP/index.html" <<'PY'
import io, re, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
s = re.sub(r'<script src="https://www\.gstatic\.com/firebasejs/[^"]+"></script>\s*', '', s)
s = s.replace('<script src="js/seguridad.js"></script>',
              '<script src="stub-firebase.js"></script>\n<script src="js/seguridad.js"></script>')
io.open(p, 'w', encoding='utf-8').write(s)
PY
python3 -m http.server $PUERTO_NUBE --directory "$TMP" >/dev/null 2>&1 &
PID_NUBE=$!

sleep 2

echo "════════════════════════════════════════════════════════"
echo " VERIFICACIÓN DE WANDERCONTABLE"
echo "════════════════════════════════════════════════════════"

node "$RAIZ/pruebas/verificacion.js" || FALLOS=1
node "$RAIZ/pruebas/verificacion-nube.js" || FALLOS=1

echo ""
if [ $FALLOS -eq 0 ]; then
  echo "✅ TODO CORRECTO — la app calcula y guarda bien."
else
  echo "❌ HAY FALLOS — revisa la lista de arriba antes de usar la app."
fi
exit $FALLOS
