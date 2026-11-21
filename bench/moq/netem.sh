#!/bin/sh
# Pérdida/jitter SOLO hacia un destino (el navegador de prueba), en el netns de un
# contenedor del banco (relay para MoQ, engine para HTTP), sin privilegios en ellos:
# un contenedor auxiliar con NET_ADMIN comparte su red.
# Uso: netem.sh <contenedor> <ip-destino> <loss%> <delay_ms> <jitter_ms> | netem.sh <contenedor> off
C=$1
if [ "$2" = "off" ]; then
  docker run --rm --net container:$C --cap-add NET_ADMIN bcmoq-netem tc qdisc del dev eth0 root 2>/dev/null; exit 0
fi
IP=$2; LOSS=$3; DELAY=${4:-0}; JIT=${5:-0}
docker run --rm --net container:$C --cap-add NET_ADMIN bcmoq-netem sh -c "
  tc qdisc del dev eth0 root 2>/dev/null
  tc qdisc add dev eth0 root handle 1: prio bands 3 priomap 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1
  tc qdisc add dev eth0 parent 1:3 handle 30: netem delay ${DELAY}ms ${JIT}ms loss ${LOSS}%
  tc filter add dev eth0 protocol ip parent 1:0 prio 1 u32 match ip dst $IP/32 flowid 1:3
  tc -s qdisc show dev eth0 | head -4"
