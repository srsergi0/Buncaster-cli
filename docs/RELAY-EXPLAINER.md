# 🔄 Relay — Escalando radio streaming

## El problema

Tu servidor de radio tiene un límite de ancho de banda.

```cal
Una persona escuchando a 128 kbps = 128 kbps de salida
100 personas = 12.8 Mbps
1.000 personas = 128 Mbps
10.000 personas = 1.28 Gbps
```

Tu VPS típico tiene 100 Mbps–1 Gbps. Llegas a ~800 oyentes y saturas.

No puedes hacer `load balancing` normal porque el stream es **constante y en tiempo real** — no como HTTP donde cada request es independiente.

## La solución: Relay

Un relay es un **servidor esclavo** que copia el stream del servidor maestro y lo distribuye a sus propios oyentes.

```
                    ┌──────────────────┐
                    │   Maestro        │
                    │  (BunRadio)      │
                    │  300 oyentes     │
                    └────────┬─────────┘
                             │ 1 stream
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
       ┌────────────┐ ┌────────────┐ ┌────────────┐
       │  Relay 1   │ │  Relay 2   │ │  Relay 3   │
       │  300 oy.   │ │  300 oy.   │ │  300 oy.   │
       │  EE.UU.    │ │  Europa    │ │  Asia      │
       └────────────┘ └────────────┘ └────────────┘
```

**Total: 1200 oyentes, cada servidor solo maneja 300.**

## Cómo funciona en BunRadio

BunRadio aún no lo tiene implementado, pero el concepto es simple:

### Master (origen)
```
BunRadio corriendo normalmente
Oyentes conectados directo o via relay
URL: https://radio.midominio.com/stream
```

### Slave (relay)
```
Otro BunRadio (o Icecast) configurado en modo relay:
1. Se conecta al maestro como si fuera un oyente
2. Sirve ese mismo stream a sus propios oyentes locales
```

En Icecast el relay se configura así:

```xml
<relay>
  <server>maestro.dominio.com</server>
  <port>8000</port>
  <mount>/stream</mount>
  <local-mount>/stream</local-mount>
  <on-demand>1</on-demand>
</relay>
```

El flag `on-demand` es clave: **solo consume el stream del maestro cuando hay oyentes en el relay**. Si nadie escucha en Asia, el relay no gasta ancho de banda del maestro.

## Relay on-demand

El relay más inteligente. Solo se activa cuando hay oyentes:

```
Sin oyentes en Europa:
  Maestro ──(sin conexión)── Relay Europa

Llega 1 oyente en Europa:
  Maestro ──conecta── Relay Europa ── 1 oyente

Llegan 50 oyentes en Europa:
  Maestro ──conecta── Relay Europa ── 50 oyentes

Se van todos los oyentes:
  Maestro ──(desconecta)── Relay Europa
```

Esto ahorra ancho de banda del maestro drásticamente.

## Alternativa moderna: CDN

Los CDNs (Cloudflare, Fastly, Akamai) son relays pero como servicio:

```
BunRadio ──push── CDN (Cloudflare) ── millones de oyentes
```

BunRadio envía 1 stream al CDN. El CDN lo replica en 300+ edge servers globalmente. Cada oyente se conecta al edge más cercano.

Cloudflare Stream cuesta ~$10/mes + $1/1000 minutos vistos. No necesitas administrar relays tú mismo.

## Alternativa moderna: P2P (WebTorrent/WebRTC)

Los propios oyentes se ayudan entre sí:

```
Oyente 1 recibe del server
Oyente 2 recibe del server + ayuda a Oyente 3
Oyente 3 recibe de Oyente 2 + ayuda a Oyente 4
...
El server solo sirve a los primeros ~10 oyentes
El resto se replica P2P entre ellos
```

Esto escala a millones sin costo de bandwidth. Es lo que usa PeerTube para video. Nadie lo ha hecho para radio en vivo aún.

## Comparativa

| Método | Setup | Costo | Latencia | Escala máxima |
|--------|-------|-------|----------|---------------|
| **Un solo server** | Nada | 1 VPS | Baja | ~500 oyentes |
| **Relays manuales** | Configurar N slaves | N VPS | Media | ~5000 oyentes |
| **CDN (Cloudflare)** | 1 click | ~$10-100/mes | Baja | Millones |
| **P2P (WebTorrent)** | Integración JS | $0 | Alta | Ilimitado |

## Para BunRadio

La implementación más práctica para BunRadio sería:

1. **Salida CDN**: BunRadio envía el stream a un CDN (Cloudflare Stream, LivePush, etc.) además de servirlo localmente. El usuario final escucha desde el CDN.

2. **Entrada relay**: BunRadio puede conectarse a otro servidor Icecast/BunRadio como fuente, para usarlo como slave.

3. **Futuro: P2P**: Usar WebTorrent o WebRTC para que los oyentes se ayuden entre sí. Esto haría a BunRadio literalmente escalable al infinito.

Pero para el 99% de los casos, **un solo BunRadio en un VPS de $10/mes sirve a ~500 oyentes**. Si necesitas más, Cloudflare CDN es la solución moderna.
