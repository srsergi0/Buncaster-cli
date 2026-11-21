#!/bin/sh
# Generador de carga nativo: N suscriptores `moq` (CLI de Curley, Rust) contra el relay,
# cada uno exporta el audio a fMP4 y lo tira. Mucho más ligero que N pestañas de Chromium.
# Uso: native-load.sh <n> <segundos>   (se ejecuta DENTRO de la imagen del relay, en la red del banco)
N=$1; T=$2
i=0
while [ $i -lt $N ]; do
  timeout $T moq --log-level warn --connect https://relay:4433/bloom --connect-tls-root /certs/cert.pem --broadcast radio.hang export fmp4 2>/dev/null | wc -c > /tmp/bytes.$i &
  i=$((i+1)); sleep 0.02
done
wait
ok=0; tot=0
for f in /tmp/bytes.*; do b=$(cat $f); tot=$((tot+b)); [ "$b" -gt 1000 ] && ok=$((ok+1)); done
echo "{\"n\":$N,\"secs\":$T,\"receiving\":$ok,\"kbpsPerListener\":$(( tot*8/1000/T/N ))}"
