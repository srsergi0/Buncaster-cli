# 🌐 3 Moonshots — Optimización de Red para Streaming

Solo networking. Sin P2P, sin CDN, sin cambios en formato de audio. First principles.

---

## El problema desde la red

Cada oyente = 1 conexión TCP. TCP fue diseñado en 1974 para transferencia de archivos CONFIABLE. Radio no necesita confiabilidad — necesita CONTINUIDAD.

```
TCP overhead por paquete:       20 bytes (TCP) + 20 bytes (IP) = 40 bytes
TCP handshake:                  3 paquetes (SYN, SYN-ACK, ACK) ≈ 220 bytes
HTTP request por listener:      500+ bytes de headers
HTTP response:                  500+ bytes de headers
TLS handshake (si hay HTTPS):   2-3 KB adicionales
ACKs por paquete recibido:      1 ACK ≈ 40 bytes cada 2-3 paquetes
```

**En un stream de 128kbps con paquetes de ~1460 bytes:**
```
Por cada 1460 bytes de audio:
  → 40 bytes de overhead TCP/IP (2.7%)
  → 1 ACK de vuelta (40 bytes) (2.7%)
  → Total overhead ≈ 5.4% por oyente

1000 oyentes = ~7 Mbps de overhead solo en TCP (sin contar headers HTTP)
```

**First principle:** El protocolo HTTP/TCP asume comunicación BIDIRECCIONAL. Un stream de radio es UNIDIRECCIONAL. Cada ACK de vuelta es desperdicio puro.

---

## 🌙 Moonshot 1: QUIC Datagrams / Sin TCP

**Problema:** TCP trata cada oyente como una conexión individual con handshake, ventana de congestión, retransmisiones, ACKs.

**Idea:** Enviar audio como **datagramas QUIC no confiables** (WebTransport). El servidor envía paquetes UDP sin esperar ACKs. Si se pierde un paquete, no se retransmite — el siguiente frame de audio sigue adelante. Esto es lo que hacen WebRTC y los protocolos de streaming en vivo real.

```
TCP:         [ENVIAR] → espera ACK → [ENVIAR] → espera ACK → (125ms RTT)
QUIC Datagram: [ENVIAR] [ENVIAR] [ENVIAR] [ENVIAR] → sin esperar (0ms RTT)
```

**Network savings:**

| Aspecto | TCP | QUIC Datagram | Ahorro |
|---------|-----|---------------|--------|
| Handshake | 3 paquetes | 0 (0-RTT) | ~220 bytes/oyente |
| ACKs | 1 cada 2 paquetes | 0 | ~50% de tráfico bidireccional |
| Headers | 40 bytes TCP+IP | 12 bytes UDP | 70% menos overhead |
| Retransmisiones | 5-10% del tráfico | 0 | 5-10% bandwidth |
| **Total overhead** | **~10-15%** | **~2-3%** | **~10% bandwidth saved** |

**Para BunRadio:** Bun ya soporta WebTransport/QUIC via su runtime HTTP/3. El endpoint `/stream` podría responder con QUIC datagrams en vez de TCP chunked response. El cliente es un WebSocket/WebTransport que recibe datagrams.

**Cambios necesarios:**
- Del lado del servidor: nuevo handler `/stream/quic` que envía datagrams vía `Bun.serve` con HTTP/3
- Del lado del cliente: `<audio>` tag estándar no soporta QUIC datagrams. Necesitas un WebAssembly decodificador o un proxy local que convierta datagrams → MP3 estándar

---

## 🌙 Moonshot 2: TCP Tuning para Larga Duración

**Problema:** Bun.serve usa defaults de TCP pensados para web (conexiones cortas, requests pequeñas). Radio tiene conexiones de HORAS.

**Idea:** Tunea el stack TCP de BunRadio específicamente para streaming de larga duración. Sin cambiar protocolo, solo ajustando parámetros.

```
Default TCP:        Slow start, Nagle, buffers pequeños
Stream TCP:         BBR, inicial grande, sin Nagle, buffers grandes
```

**Parámetros a tunear:**

```typescript
Bun.serve({
  // TCP tuning para streaming
  tcp_fast_open: true,         // Evita handshake en reconexiones
  tcp_nodelay: true,           // Desactiva Nagle (envía inmediatamente)
  tcp_keepalive: 60,           // Mantén conexiones vivas
  send_buffer_size: 256 * 1024,  // Buffer de envío grande (evita pauses)
  recv_buffer_size: 64 * 1024,   // Buffer de recepción pequeño (no necesitamos)
  
  // HTTP tuning
  max_request_body_size: 0,     // Sin límite (stream constante)
  
  fetch(req) { ... }
})
```

**Network savings:**

| Tuning | Problema que resuelve | Ahorro |
|--------|----------------------|--------|
| `tcp_nodelay` | Nagle retiene paquetes 200ms → latencia | -200ms latencia |
| `send_buffer_size: 256KB` | Buffer pequeño causa pausas cuando escritura > buffer | -0% bandwidth, +calidad |
| `tcp_fast_open` | Reconexión tras timeout sin 3-way handshake | -220 bytes/reconexión |
| **BBR congestion control** | Reno/Cubic cortan la tasa ante pérdidas | **+30-50% throughput** |

**BBR (Bottleneck Bandwidth and Round-trip):** Desarrollado por Google para YouTube. En vez de asumir congestión cuando hay pérdidas (como Reno/Cubic), mide el ancho de banda real y la latencia. En streaming, las pérdidas suelen ser por buffer lleno (no congestión real). BBR evita falsos positivos.

```
Cubic en pérdida:  "Hay pérdida → bajo tasa a la mitad" → stream se entrecorta
BBR en pérdida:    "Hay pérdida → midamos el bandwidth real" → stream sigue fluido
```

**Para BunRadio:** Configurar el sistema operativo para usar BBR:

```bash
# Linux: cambiar congestion control a BBR
sysctl -w net.ipv4.tcp_congestion_control=bbr
```

**Reversión a Cubic automática** si BBR no está disponible. Sin cambios en código, solo configuración del sistema.

---

## 🌙 Moonshot 3: Connection Pooling / Colapso de Oyentes

**Problema:** Cada oyente es una conexión TCP separada. 1000 oyentes = 1000 conexiones = 1000× el overhead de headers, handshakes, y buffers.

**Idea:** Si varios oyentes comparten la misma IP de origen (ej: detrás de un NAT corporativo o de un ISP), colapsa sus conexiones en UNA sola. El servidor envía audio UNA VEZ y el router o proxy local lo replica.

**Cómo funciona en redes reales:**

```
Internet ← ─ ─ ─ ─ ─ ─ → VPS
                           │
                    BunRadio Server
                           │
                 ┌─────────┼─────────┐
                 │         │         │
              NAT ISP   NAT ISP   NAT ISP
                 │         │         │
              20 oyentes 15 oyentes 30 oyentes
```

Sin pooling: el servidor maneja 65 conexiones independientes.
Con pooling: el servidor maneja 3 conexiones (una por NAT), cada NAT replica a sus oyentes.

**El moonshot: multicast por proxy**

BunRadio incluye un **proxy ligero** que se ejecuta en el router/local network del oyente:

```bash
# El oyente instala:
bunradio proxy --upstream https://radio.midominio.com/stream --listen :8080

# Sus amigos se conectan a:
http://192.168.1.100:8080/stream
```

El proxy recibe UN stream del servidor y lo replica a N oyentes locales. El servidor solo ve 1 conexión (la del proxy) en vez de N conexiones.

**Pero el verdadero moonshot es HTTP/3 Server Push:**

HTTP/2 y HTTP/3 permiten **server push**: el servidor envía recursos sin que el cliente los pida. En vez de que cada oyente haga `GET /stream`, el servidor "empuja" el audio a todos los oyentes conectados en la misma sesión QUIC.

```
HTTP/1.1:    Oyente1→GET /stream → server envía
             Oyente2→GET /stream → server envía (mismos bytes!)
HTTP/3 Push: Oyente1→GET /stream → server envía + PUSH a Oyente2
             Oyente2 recibe sin hacer request (0 bytes de overhead)
```

**Network savings:**

| Escenario | Sin pooling | Con pooling/push | Ahorro |
|-----------|-------------|------------------|--------|
| 100 oyentes mismo NAT | 100 conexiones | 1 conexión (+ proxy local) | -99% conexiones |
| 1000 oyentes, 20 NATs | 1000 conexiones | 20 conexiones | -98% conexiones |
| HTTP headers | 500+ bytes/oyente | 0 bytes (push) | -100% headers |
| Handshakes TCP | 1000 × 220 bytes | 20 × 220 bytes | -98% handshake |

**Para BunRadio:**
- Fase 1: Proxy ligero (200 líneas de Bun) que el oyente corre localmente. Replica el stream a la red local.
- Fase 2: HTTP/3 server push para oyentes que llegan con `?push=1` en la URL. El servidor mantiene un pool de streams abiertos y push a nuevos oyentes.

---

## Comparativa Networking

| | Moonshot 1: QUIC Datagram | Moonshot 2: TCP Tuning | Moonshot 3: Pooling |
|---|---|---|---|
| **Reduce** | Overhead de protocolo (ACKs, headers, handshake) | Retransmisiones y falsas congestiones | Conexiones duplicadas |
| **Ahorro estimado** | ~10-15% bandwidth | ~10-30% throughput | ~50-98% conexiones |
| **Complejidad** | Alta (nuevo protocolo) | Baja (config OS) | Media (proxy local) |
| **Cambio en cliente** | Sí (WebTransport) | No | Sí (proxy opcional) |
| **Protocolo** | UDP/QUIC | TCP (tuneado) | HTTP/3 Push + TCP |
| **Time to market** | Mes | Días | Semana |

**Orden recomendado:**

1. **Semana 1:** TCP Tuning (config). 0 líneas de código, impacto inmediato.
2. **Semana 2-3:** Proxy local. El oyente instala un mini server que replica el stream en su LAN. Ideal para escuelas, oficinas, cibercafés donde múltiples personas escuchan la misma radio.
3. **Mes 2-3:** QUIC Datagrams cuando Bun/el runtime lo soporte nativamente.

---

## First Principle aplicado a networking

```
Pregunta:  "¿Por qué cada oyente necesita una conexión TCP completa?"
Realidad:  TCP asume 2 cosas falsas para radio:
           1. Que la conexión es bidireccional (no lo es, es 99% server→client)
           2. Que los datos perdidos deben retransmitirse (no, el siguiente frame ya viene)

Solución:  Eliminar todo lo que TCP hace y no necesitamos:
           - Handshake de 3 vías → 0-RTT
           - ACKs → no enviarlos
           - Retransmisiones → no hacerlas (FEC o skip)
           - Congestion window → no existe en un stream constante
           - Headers HTTP → no repetirlos

Resultado: Un "TCP" que es 90% más eficiente porque hace solo lo necesario.
```
