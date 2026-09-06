# 🚀 3 Moonshots — Menos recursos por oyente

Sin P2P, sin CDN de pago, solo protocolos estándar (MP3, OGG, etc.). First principles thinking.

---

## El problema desde cero

```
Ancho de banda total = bitrate × oyentes
Ej: 128 kbps × 1000 oyentes = 128 Mbps
```

Tu VPS de $10/mes tiene ~100 Mbps. Te da para ~800 oyentes.

**Para servir más oyentes sin pagar más, solo hay 3 caminos:**

1. **Enviar menos datos** por oyente (bajar bitrate)
2. **Reutilizar datos** entre oyentes (no re-enviar lo mismo)
3. **Optimizar cuándo** se envían los datos (evitar picos)

Cada moonshot ataca uno de estos.

---

## 🌙 Moonshot 1: NanoCache / Chunk Deduplication

**Principio:** En radio, el mismo audio se repite. Jingles, intros, promos, canciones populares. ¿Por qué enviar los mismos bytes 1000 veces?

**Idea:** El servidor divide el audio en "chunks" de 1 segundo (~16 KB a 128kbps). Cada chunk tiene un hash (SHA-256). El servidor cachea chunks en memoria. Cuando un chunk ya fue enviado una vez, no se re-envía — se envía un **token de 32 bytes** que el cliente usa para recomponerlo desde su cache local.

```
Primera vez:  [cliente] ← MP3 chunk (16 KB)
Segunda vez:  [cliente] ← hash:abc123 (32 bytes) + "repite el chunk anterior"
```

El cache del cliente se construye naturalmente mientras escucha. Si el servidor reproduce el mismo jingle 3 veces, solo los primeros 16 KB se envían realmente. Las siguientes 2 veces son 32 bytes de hash.

**Impacto teórico:**
- Canciones repetidas: -66% bandwidth (la 2da y 3ra vez son hash)
- Jingles/IDs: -90% bandwidth
- Transiciones repetidas (crossfade entre canciones populares): -50%
- Oyentes que se unen a mitad de canción: el cache ya tiene chunks del pre-buffer

**Requisito:** Modificación del lado del cliente (reproductor custom o WebAssembly), o crear un proxy ligero que el oyente instala. El proxy recibe tokens y reensambla el stream standard.

**Ventaja clave:** Mientras más oyentes y más tiempo escuchen, MÁS eficiente se vuelve. Es anti-intuitivo: la escalabilidad mejora con el uso.

---

## 🌙 Moonshot 2: Latency Tiers / Degradación Elegante

**Principio:** No todos los oyentes necesitan latencia real. Un oyente casual no nota 30 segundos de delay. Pero USAN el mismo ancho de banda que el DJ en vivo.

**Idea:** Tres tiers de oyente, asignados automáticamente según la carga del servidor:

| Tier | Latencia | Bitrate | Prioridad | Cuándo se asigna |
|------|----------|---------|-----------|------------------|
| 🥇 **Live** | <1s | Alto (320k) | DJ, admin, listeners VIP | Siempre disponible para pocos |
| 🥈 **Balanced** | ~15s | Medio (128k) | Oyentes normales | Por defecto |
| 🥉 **Eco** | ~60s | Bajo (64k) | Oyentes en saturación | Solo cuando el server está >80% de bandwidth |

El servidor monitorea su ancho de banda en tiempo real. Cuando se acerca al límite, automáticamente mueve oyentes del tier Live → Balanced, o Balanced → Eco.

**Cómo funciona sin re-encoding:** El encoder ya produce el formato más alto (320k). Para los tiers inferiores, el servidor **extrae** frames del stream principal. En MP3, puedes "downsample" saltando frames (cada 3 de 4 frames para bajar de 320k a 80k). En Opus, puedes truncar paquetes.

```
Encoder → 320kbps una sola vez
           ├── Tier Live → 320k directo (sin transformación)
           ├── Tier Balanced → toma 1 de cada 2 frames = 160k
           └── Tier Eco → toma 1 de cada 4 frames = 80k
```

**Impacto:** En lugar de que el servidor se sature y corte a todos, los oyentes Eco reciben un stream de menor calidad pero NO se caen. El DJ siempre tiene Live. Los oyentes Premium pueden pagar por tier Live.

**Analogía:** Como Netflix que baja la calidad cuando hay congestión, pero en vivo y sin re-encoding.

---

## 🌙 Moonshot 3: Fountain Stream / Codificación Fountain

**Principio:** Los streams actuales son secuenciales. Si pierdes un paquete, hay un "glitch". Si te unes tarde, te perdiste el principio. Esto es ineficiente.

**Idea:** Usar **RaptorQ** o **Luby Transform codes** (fountain codes) para codificar el audio. El servidor produce paquetes que contienen información redundante del audio. El cliente solo necesita recibir **cualquier** N paquetes para reconstruir N segundos de audio.

```
Stream normal:     [1][2][3][4][5][6]... (necesitas todos)
Fountain stream:   [a][b][c][a⊕b][b⊕c][a⊕c]... (necesitas ~cualquier 4 de 6)
```

**El moonshot:** El servidor puede ajustar dinámicamente la tasa de envío. Cuando hay 1000 oyentes, envía a 100 kbps (sobre-envío 25%). Cuando hay 5000 oyentes, envía a 75 kbps (justo lo necesario). Los oyentes con buena conexión reciben más paquetes y tienen mejor calidad. Los oyentes con mala conexión reciben menos paquetes pero aún así escuchan — solo con más artefactos.

**La magia:** Fountain codes permiten que el servidor **no sepa qué paquetes perdió cada cliente**. Es inherentemente broadcast-friendly. Es como si cada oyente recibiera un stream personalizado, pero el servidor envía un solo flujo de datos para todos.

**Aplicación real:** El estándar **3GPP MBMS** (Multimedia Broadcast/Multicast Service) usa fountain codes para transmitir video a millones de teléfonos simultáneamente. Lo mismo se puede aplicar a radio.

**Para BunRadio:** Implementar fountain coding sobre UDP (no P2P, solo server→client). El servidor envía un flujo UDP de paquetes fountain. El cliente BunRadio (desktop/app/web) los decodifica en MP3 estándar. Funciona con cualquier reproductor si el proxy local lo traduce a HTTP.

**Ventaja killer:** Un servidor puede servir a **decenas de miles de oyentes con el mismo ancho de banda** que hoy usa para 1000, porque la sobrecarga de fountain coding es mínima (~5-10%) vs la ineficiencia de TCP (retransmisiones, ventanas de congestión, etc.).

---

## Comparativa

| | Moonshot 1: NanoCache | Moonshot 2: Latency Tiers | Moonshot 3: Fountain |
|---|---|---|---|
| **Qué reduce** | Datos repetidos entre oyentes | Bitrate por oyente | Sobre-envío de protocolo |
| **Ahorro estimado** | 30-60% | 40-60% | 40-80% |
| **Complejidad** | Media (proxy local) | Baja (server-side only) | Alta (nuevo protocolo) |
| **Cliente especial** | Sí (proxy o WA) | No (reproductor estándar) | Sí (aplicación custom) |
| **Protoc. estándar** | HTTP/ICY | HTTP/ICY | UDP custom |
| **Time to market** | 2-3 semanas | 1 semana | 4-6 semanas |

---

## El orden que haría

1. **Latency Tiers** — Semana 1. Solo código server-side, 0 cambios en cliente. Impacto inmediato. Cuando el server se satura, baja bitrate de oyentes "normales" antes de cortar a todos.

2. **NanoCache** — Semana 2-3. Proxy ligero en JS que el oyente pega en su navegador o app. Reduce drásticamente bandwidth para canciones repetidas y jingles.

3. **Fountain** — Mes 2. Cambio más profundo, pero el impacto es orders of magnitude. Permite servir decenas de miles de oyentes desde un solo VPS de $10.

---

## Principio First Principle aplicado

```
Pregunta original:  "¿Cómo sirvo más oyentes con el mismo VPS?"
Respuesta naive:    "Compra un VPS más grande"
Respuesta moonshot: "¿Por qué cada oyente necesita su propia copia de los mismos bytes?"
```

**Los 3 moonshots responden la misma pregunta de 3 formas distintas:**
- NanoCache: porque los bytes se repiten, cacheémoslos
- Latency Tiers: porque todos reciben la misma calidad, pero no todos la necesitan
- Fountain: porque TCP es ineficiente para 1→N, usemos un protocolo diseñado para broadcast
