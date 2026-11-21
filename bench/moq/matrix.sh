#!/bin/sh
# Matriz de pérdidas: <modo> <contenedor-con-netem> <loss...>. Cada pasada ≤ ~70 s.
# Requiere el banco (moq/docker-compose.test.yml) y un contenedor Playwright "bcmoq-pw"
# en su red con este directorio en /w.
MODE=$1; TARGET=$2; shift 2
DIR=$(cd "$(dirname "$0")" && pwd)
PWIP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' bcmoq-pw)
for L in "$@"; do
  if [ "$L" = "0" ]; then "$DIR/netem.sh" $TARGET off; else "$DIR/netem.sh" $TARGET $PWIP $L 50 50 >/dev/null; fi
  R=$(docker exec -e SOAK_MS=${SOAK_MS:-60000} -e SPACING_MS=5000 -e MAX_WAIT_MS=${MAX_WAIT_MS:-30000} bcmoq-pw node /w/g2g.mjs $MODE ${N:-10} 2>&1 | tail -1)
  "$DIR/netem.sh" $TARGET off
  echo "loss=$L% $R"
  sleep ${COOL:-10}
done
