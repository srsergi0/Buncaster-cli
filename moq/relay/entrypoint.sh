#!/bin/sh
# Arranca `moq auth serve` (loopback) y `moq-relay`; si cualquiera muere, sale
# para que Docker reinicie el contenedor (restart: unless-stopped).
set -eu
CERTS=${MOQ_CERT_DIR:-/certs}
LIMIT=${MOQ_LIMIT_PER_IP:-8}
PREFIX=${MOQ_PATH_PREFIX:-bloom}

# Buncaster genera certificado y clave JWT; esperar hasta 60 s.
i=0
while [ ! -s "$CERTS/cert.pem" ] || [ ! -s "$CERTS/key.pem" ] || [ ! -s "$CERTS/publish.jwk" ]; do
  i=$((i+1)); [ $i -gt 120 ] && { echo "moq-entrypoint: faltan $CERTS/{cert.pem,key.pem,publish.jwk}" >&2; exit 1; }
  sleep 0.5
done

moq auth serve --listen 127.0.0.1:4440 \
  --key "$CERTS/publish.jwk" \
  --public-subscribe "$PREFIX/**" \
  --expires 1d --revalidate 60s \
  --limit-remote "$LIMIT" &
AUTH=$!

# Esperar al servidor de auth (sin curl: /dev/tcp no existe en dash; reintentar con el relay)
sleep 0.3
moq-relay /etc/moq/relay.toml "$@" &
RELAY=$!

trap 'kill -TERM $RELAY $AUTH 2>/dev/null; wait' TERM INT
# El primero que termine tumba al otro.
while kill -0 $AUTH 2>/dev/null && kill -0 $RELAY 2>/dev/null; do sleep 1; done
kill -TERM $RELAY $AUTH 2>/dev/null || true
wait || true
exit 1
