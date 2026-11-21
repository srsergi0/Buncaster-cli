# Mesa redonda — Motor de Bloom 2.0 (Buncaster / BunRadio)

> Continuación escrita de la mesa redonda del 21-nov-2026. Cada rol inspeccionó el código real
> (las citas `archivo:línea` sin prefijo se refieren a la **línea base**: `HEAD c732a17` + los
> cambios sin commitear que ya había en el árbol; las marcadas *(nuevo)* al código tras esta sesión).
> Todas las medidas se tomaron en contenedores aparte (`buncaster-cli:roundtable-base` = línea base,
> `buncaster-cli:roundtable` = este trabajo) en `127.0.0.1:4396-4399`, con música de prueba de solo
> lectura. El contenedor de producción `buncaster` solo se **leyó** (`docker top`, `docker logs`,
> `/health`, los primeros 400 B de `/opus`).

---

## 0. Lo que vimos en producción antes de empezar (solo lectura)

| Observación | Valor | Fuente |
|---|---|---|
| Uptime / oyentes | 34,9 días / 1 (el publisher de bloom en `/opus`) | `/health` |
| Procesos | `buncaster` + `ffmpeg` opus 192k + `ffmpeg` SRT listener + **`ffmpeg -fflags nobuffer -re -i <canción>`** | `docker top buncaster` |
| Reloj de audio | 144 862 088 216 frames / 3 015 037 s = **48 046 frames/s (+0,097 %)** | `/health` |
| Opus efectivo | 74,4 GB / 3 015 037 s = 197,5 kbps (192k + framing Ogg); páginas de **24 897 B ≈ 1 s** | `/health`, cabecera `/opus` |
| Cabeceras opus servidas | OpusHead 47 B + OpusTags 90 B (bien… por suerte, ver §2.6) | primeros bytes de `/opus` |
| Errores en el log | 45 trazas `TypeError: Invalid URL input: "/"` → 500 | `docker logs buncaster` |
| Env relevante | `PREBUFFER_BYTES=1572864`, `OPUS_TIER_BITRATE_KBPS=192`, `CROSSFADE_SECONDS=2`, `LOW_LATENCY` sin definir (= `true`) | `docker inspect` |

---

## 1. Ronda de inspección

**MODERADORA:** Reglas recordadas: nada se toca en producción, sin commits, línea base guardada en
`scratchpad/buncaster-baseline.patch`. Cada uno confirma o descarta su hipótesis con evidencia.

### 1.1 Ingeniera de audio broadcast (BS.1770-5, EBU R128, Tech 3341/3342)

**Hipótesis:** sin DSP, la sonoridad entre pistas salta >10 LU; normalizar por pista es casi gratis.

**Código:** el DSP se quitó en `cc73973`; el único procesado restante es el *soft-knee* de
`mixSamples` (`src/audio-router.ts:254-297`), que solo actúa durante crossfades. No hay medición
de sonoridad en ningún sitio.

**Evidencia:**

- Biblioteca real (6 pistas muestreadas, `ebur128=peak=true`): **I entre −13,1 y −5,8 LUFS** y
  **true-peak de hasta +2,4 dBTP** (ya hay clipping inter-muestra en los masters).
- Coste de medir: `ffmpeg … ebur128,silencedetect -f null` en un hilo va a **74–122× tiempo real**
  → 2–3 s de CPU por canción de 3–4 min, una sola vez.

**Veredicto:** confirmada. Propuesta: ganancia estática hacia −16 LUFS limitada por true-peak
(−1 dBTP), sin compresor ni limitador — estilo ReplayGain “prevent clipping”.

### 1.2 Investigador de MIR / DJ automático (Vande Veire & De Bie 2018; Bello et al. 2005)

**Hipótesis:** el crossfade es lineal y de duración fija, ciego al audio; corta colas y pisa intros.

**Código:**

- La curva **ya es equal-power** (`cos`/`cos(1−p)`): `src/audio-router.ts:1230-1232` y en vivo
  `:1479-1480`. Parte de la hipótesis **descartada**.
- Pero el crossfade se dispara con reloj de pared: `remaining = duration − (Date.now() − startedAt)`
  (`:1290-1294`) y su progreso también es de pared (`:1227-1228`).
- Los decks son `ffmpeg -loglevel warning -fflags nobuffer -re -i <archivo>` (`:1139-1149`).

**Evidencia (sondeando `/debug-state` cada 100 ms, base, crossfade configurado de 2 s):**

| Medida | Línea base |
|---|---|
| Duración real de los crossfades | **0,24 s, 2,12 s, 0,32 s** |
| Log `Deck X terminó; completando transición` | en casi todas las transiciones |
| Audio del tema entrante saltado en el relevo | **96 768 B = 0,504 s** por relevo (queda en `deck.buffer` y nunca se emite) |

Al seguir el rastro apareció un bug mayor que nadie buscaba: **`-fflags nobuffer` con un archivo
descarta los paquetes leídos durante el sondeo**. Medido en 14 archivos reales: MP3 pierden
**1 176–1 306 ms del inicio** (10/10), FLAC 92–104 ms (3/4) y 1 281 ms (1/4). La biblioteca tiene
238 MP3 de 323 pistas: **casi todas las canciones de Bloom empiezan 1,2 s tarde** y, como el
archivo “dura” 1,2 s menos de lo que dice ffprobe, el crossfade se queda sin audio a los 0,2–0,3 s.

**Veredicto:** equal-power descartado (ya estaba); crossfade roto confirmado, con causa raíz
distinta a la supuesta. La detección de cola/intro por energía se implementa reutilizando la misma
pasada de análisis (`silencedetect`, umbral −50 dBFS, 0,5 s), no con un RMS en JS.

### 1.3 Ingeniero de baja latencia (LMAX Disruptor, *Mechanical Sympathy*)

**Hipótesis:** “ring compartido + cursor por oyente” está solo en papel; hay copias por oyente.

**Código:**

- `broadcast()` (`src/broadcaster.ts:117-158`) empuja a cada oyente con `controller.enqueue(data)`
  la **misma** `Uint8Array` inmutable que guarda el ring (`:121-122`): **cero copias de payload por
  oyente** (ICY usa `subarray`, tampoco copia). No hay cursores: `AudioRingBuffer.readSince`
  (`src/ring-buffer.ts:314-327`) no lo usa nadie fuera de los tests.
- El ring desalojaba con `Array.shift()` (O(n), `src/ring-buffer.ts:268`) y el snapshot hacía
  `unshift` en bucle (O(k²), `:300-305`).
- `test/backpressure-bytes.test.ts` y `test/deck-state-machine.test.ts` prueban **clases definidas
  dentro del propio test**, no el código de `src/`: también “en papel”.

**Evidencia (200 oyentes simulados, 100 mp3 + 100 opus, 30 s, host de 2 núcleos compartido):**

| Config | CPU contenedor | RSS (cgroup) | TTFB p99 |
|---|---|---|---|
| Línea base, prebuffer 1,5 MB | 18,6 % (idle 10,0 %) | 75,8 MiB (idle 62,9) | 476 ms |
| Nuevo, defaults (1,5 MB) | 18,0 % (idle 10,3 %) | 75,2 MiB (idle 56,6) | 225 ms |
| Nuevo, `PREBUFFER_SECONDS=10` | 20,0–23,1 % | **67–69 MiB** | 124–230 ms |
| Nuevo, `PREBUFFER_SECONDS=10` + HWM = tamaño prebuffer (experimento) | 21,6–27,3 % | **118–123 MiB** | — |

Clientes atascados (20 sockets con `SO_RCVBUF=4096` que no leen, 30 s) y lentos (1 KB/s, 40 s):
0 expulsiones y RSS plano en base — el kernel absorbe la cola; no se observó crecimiento de memoria.

**Veredicto:** la distribución ya es *single-writer* con buffers compartidos; un modelo de cursores
no ahorraría copias (no las hay) y el coste real son las llamadas por oyente. **No se reescribe.**
Se arreglan las dos complejidades del ring (ahora O(1) amortizado / O(k)). El experimento de
subir el `highWaterMark` (que propuse para que la ráfaga inicial no contara como *strikes*) **empeoró
el RSS un 75 %** sin evitar ninguna expulsión: revertido.

### 1.4 Investigadora de transporte y latencia (BBR, MoQ, *The Tail at Scale*)

**Hipótesis:** `PREBUFFER_BYTES=1572864` ≈ 65 s detrás del directo.

**Código:** `preBufferBytes: envInt("PREBUFFER_BYTES", …)` (`src/config.ts:102`) se aplica igual a
ambos tiers (`src/pre-buffer.ts:30-31`); en `start()` del stream se encola el snapshot completo
(`src/http-server.ts:179-193`).

**Evidencia (bytes recibidos en el primer segundo de conexión):**

| Tier | Línea base | Nuevo con `PREBUFFER_SECONDS=10` |
|---|---|---|
| `/opus` 192k | 1 574 071 B → **65,6 s** detrás del directo | 241 958 B → **10,1 s** |
| `/mp3` 320k | 1 614 276 B → **40,3 s** | 439 983 B → **11,0 s** |

TTFB individual ≈ 2 ms en ambos (no empeora). Con 200 conexiones simultáneas el p99 baja de
476 ms a 124–230 ms porque cada una mueve 6× menos bytes.

**Veredicto:** confirmada. Además, el reloj de producción va +0,097 % rápido; en las pruebas
(pistas de 14–18 s) la deriva medida fue −0,07 % tanto en base como en el nuevo motor, así que no
la causan estos cambios; queda expuesta como métrica (`radio_audio_clock_drift_seconds`).

### 1.5 SRE (Armstrong 2003; Google SRE book)

**Hipótesis:** no hay supervisión real; un proceso vivo pero mudo deja la radio callada.

**Código:**

- El watchdog solo mira el directo (`checkAudioWatchdog`, `src/audio-router.ts:712-738`).
- Un deck colgado no lo detecta nadie; `/health` solo se degrada si `audioClockSamples === 0`
  (`src/http-server.ts:360`).
- Encoder opus: si muere, nadie lo reinicia hasta el próximo `startFallback()`
  (`src/audio-router.ts:764-765`); si se cuelga (vivo, sin salida) nunca, porque
  `state.opusProcess` no es `null`. Además `stopOpusEncoder` usa `preBufferOpus` **sin importarlo**
  (`:972`) → `ReferenceError` (visto en el log de producción del 17-oct al apagar).

**Inyección de fallos (línea base vs nuevo):**

| Fallo inyectado | Línea base | Nuevo |
|---|---|---|
| `SIGSTOP` al ffmpeg del deck | **25,1 s sin bytes y sin recuperarse**; `/health` = `ok` | 5,4–5,8 s y recupera (salta de pista); `/health` = `degraded` durante el corte; `radio_dead_air_seconds_total 5.4` |
| `kill -9` al ffmpeg opus | 11,7 s sin opus (hasta el siguiente tema; en producción, hasta ~4 min); un oyente nuevo tras el fallo recibe un stream **que ffmpeg no abre** | 2,6 s (backoff 1 s); oyente nuevo decodifica con 0 errores |
| `SIGSTOP` al ffmpeg opus | **36,8 s+ sin opus, sin fin**, RSS +6 MB en 36 s (~190 KB/s de PCM retenido, sin límite) | detectado a los 10,4 s, reiniciado; corte total 13,5 s |
| Entrada SRT en vivo de 12 s (entrar y salir) | — | hueco máximo 0,2 s; vuelve el fallback con fundido |

**Veredicto:** confirmada. La propuesta de conmutar a fallback por *silencio digital en vivo* se
**veta** (ver §3): un micro silenciado es legítimo. Solo se mide.

### 1.6 Investigador de codificación (RFC 6716, RFC 7845, RFC 6330)

**Hipótesis:** las páginas Ogg pueden estar mal cortadas y las cabeceras no reenviarse bien.

**Código:** `pipeOpus` busca las dos páginas de cabecera **en una sola lectura del pipe**
(`extractOggOpusHeaders`, `src/audio-router.ts:901-925, 938-950`); si no están las dos juntas, el
*fallback* copia la lectura entera si contiene “OpusHead”. Las cabeceras no se invalidan si ffmpeg
muere (solo en `stopOpusEncoder`).

**Evidencia:** en el contenedor de prueba la primera lectura traía **solo** OpusHead (47 B): log
`headers captured (fallback) 47B`. Cada oyente nuevo recibía OpusHead + páginas de audio **sin
OpusTags**: `ffmpeg -i captura.ogg` → `Header processing failed: Invalid data` (2/2 capturas).
Producción sirve 137 B correctos porque ganó la carrera al arrancar el 17-oct; cualquier reinicio
del contenedor o del encoder la vuelve a jugar. Las páginas de audio sí venían enteras (ffmpeg
escribe páginas de ~1 s), pero nada lo garantizaba.

**Veredicto:** bug real confirmado. Opus 192 → 128 kbps no se toca (decisión de producto).

### 1.7 Abogada del diablo

> “Me alegra que nadie haya propuesto reescribir nada. Acepto los arreglos *por defecto* que
> reparen algo que hoy está roto y medido (inicio de canciones, crossfades, cabeceras opus,
> watchdogs, el 500 por URL), siempre con interruptor para volver atrás. Lo que **cambia el sonido
> o la latencia por decisión editorial** (normalización, transiciones inteligentes, prebuffer en
> segundos) entra apagado y lo enciende un humano en el `.env`. Veto el failover por silencio en
> vivo y todo lo que no traiga número.”

---

## 2. Priorización

| # | Mejora | Impacto | Riesgo | Esfuerzo | Medible | Decisión |
|---|---|---|---|---|---|---|
| 1 | Quitar `-fflags nobuffer` de los decks (archivos) | Alto: 1,2 s de cada MP3 recuperados | Bajo | Mínimo | Sí (bytes decodificados) | **Hecho, default on** |
| 2 | Crossfade por reloj de muestras + relevo de deck sin pérdidas | Alto: crossfades de 2 s reales, sin salto de 0,5 s | Medio | Medio | Sí (`/debug-state`, métricas) | **Hecho, default on** (`CROSSFADE_SAMPLE_CLOCK`) |
| 3 | Opus: ensamblado de páginas, cabeceras por generación, supervisión con backoff + detección de cuelgue | Alto: tier de producción | Bajo-medio | Medio | Sí (ffmpeg decode, inyección) | **Hecho, default on** (`ENCODER_SUPERVISION`) |
| 4 | Watchdog de fallback + métricas de aire muerto / silencio digital + `/health` degradado | Alto | Bajo | Bajo | Sí (inyección) | **Hecho, default on** (`FALLBACK_STALL_SECONDS=5`) |
| 5 | `PREBUFFER_SECONDS` por tier + métricas de backlog | Alto (65 s → 10 s) | Bajo | Bajo | Sí | **Hecho, default off** |
| 6 | Normalización BS.1770 con caché + transiciones por energía | Alto (sonido) | Medio (cambia el sonido) | Medio | Sí (ebur128 sobre captura) | **Hecho, default off** |
| 7 | `new URL(req.url)` sin base → 500 | Bajo | Nulo | Mínimo | Sí | **Hecho** |
| 8 | Ring O(1)/O(k) | Bajo | Bajo | Mínimo | Test | **Hecho** |
| 9 | HWM = tamaño del prebuffer | — | — | — | Medido: +75 % RSS | **Revertido** |
| 10 | Cursores por oyente (LMAX) | Bajo (ya hay 0 copias) | Alto | Alto | — | Descartado |
| 11 | Failover por silencio digital en vivo | ? | Alto (roba el aire a un micro mudo) | Bajo | — | **Vetado** (solo métrica) |
| 12 | `-page_duration` de Ogg más corto (~200 ms) | Medio (latencia/granularidad) | Bajo | Mínimo | No medido aquí | Siguiente fase |
| 13 | Fountain codes (RaptorQ) | Ver §5 | Alto | Muy alto | — | No-go para oyentes |

---

## 3. Lo implementado

### 3.1 Decks: inicio completo, crossfade por muestras, relevo sin pérdidas

- `-fflags nobuffer` ya no se pasa a los decks (*(nuevo)* `src/audio-router.ts:1359`; se conserva
  en SRT/RTMP, donde sí tiene sentido). `DECK_FFLAGS_NOBUFFER=true` restaura lo anterior.
- Cada deck cuenta los frames que realmente emite (`framesOut`); el disparo del crossfade y su
  progreso usan ese reloj (*(nuevo)* `:1441`, `:1526`), no `Date.now()`.
- Relevo FIFO: si el deck entrante llega al primer plano con audio precargado (la ráfaga de
  0,5 s de `ffmpeg -re`), lo sigue sirviendo a 1× en orden (*(nuevo)* `:1427`) en vez de saltárselo.
- Si el saliente llega a EOF a mitad del fundido, su resto pasa al entrante, que completa la rampa
  mezclándolo (*(nuevo)* `:1551`, `tailFadeIn`), sin rellenar con silencio.
- `CROSSFADE_SAMPLE_CLOCK=false` restaura el comportamiento anterior.

| Medida (crossfade configurado 2 s) | Línea base | Nuevo |
|---|---|---|
| Duración observada | 0,24 / 2,12 / 0,32 s | 1,41–1,95 s de pared (2,0 s de audio por muestras) |
| `radio_crossfades_total{result}` | — | completed 4/4, 9/9, 3/3; truncated 0 |
| Audio entrante perdido en el relevo | 0,504 s por relevo | 0 (drenado FIFO: `radio_deck_handover_buffered_bytes_total`) |
| Huecos audibles del entrante (p ≥ 0,1) | — | `radio_crossfade_underrun_bytes_total 0` |
| Deriva de reloj 60–90 s | −0,07 % | −0,07 % |

### 3.2 Opus: páginas enteras, cabeceras por generación, supervisión

- `OggPageAssembler` / `OpusHeaderCollector` (*(nuevo)* `src/ogg.ts:28`, `:106`): solo páginas
  completas; cabeceras = página BOS + páginas con granule 0; un BOS nuevo resetea el prebuffer.
- `handleOpusOutput` (*(nuevo)* `src/audio-router.ts:1121`): cabeceras a `opusHeaders` (se envían
  en banda a quien ya escucha, pero no entran al prebuffer); páginas de audio al ring.
- Supervisión (*(nuevo)* `:1006`, `:1023`): reinicio con backoff 1 s → 30 s (se resetea tras 60 s
  sanos) y `SIGKILL` si lleva 10 s sin páginas mientras entra PCM. `ENCODER_SUPERVISION=false` lo
  desactiva. Se corrige el `ReferenceError` de `preBufferOpus`.

| Medida | Línea base | Nuevo |
|---|---|---|
| Captura de un oyente nuevo → `ffmpeg -v error` | 4 errores fatales (no abre) ×2 | 0 errores ×3 |
| Tras `kill -9` del encoder | 11,7 s sin opus; oyente nuevo roto | 2,6 s; oyente nuevo 0 errores |
| Tras `SIGSTOP` del encoder | sin fin; +190 KB/s de RSS | 13,5 s |

### 3.3 Aire muerto: watchdog de fallback y métricas

- `checkFallbackWatchdog` (*(nuevo)* `src/audio-router.ts:847`): sin directo, sin pausa y N s sin
  PCM → `SIGKILL` a los decks y salto de pista (un reintento por ventana). `FALLBACK_STALL_SECONDS=0`
  lo desactiva.
- `accountAirTime` (*(nuevo)* `:346`): huecos de PCM > 500 ms (`radio_dead_air_seconds_total`) y
  bloques con pico < −60 dBFS (`radio_digital_silence_seconds_total`).
- `/health` → `degraded` con más de 2 s de aire muerto (*(nuevo)* `src/http-server.ts:417`).

### 3.4 Prebuffer en segundos

`PREBUFFER_SECONDS` (default `0` = sigue mandando `PREBUFFER_BYTES`) → bytes = s × kbps del tier ×
125 (*(nuevo)* `src/config.ts:186`). Métricas: `radio_prebuffer_seconds{tier}`,
`radio_listener_join_backlog_seconds_{sum,count,max}`, y bloque `engine.latency` en `/status`.

### 3.5 Sonoridad BS.1770 y transiciones por energía

- `src/track-analysis.ts` *(nuevo)*: una pasada `ebur128=peak=true,silencedetect` por pista
  (`nice -n 10`, 1 hilo, en serie), caché por ruta+mtime en `ANALYSIS_CACHE_FILE`; la pista actual
  y las dos siguientes tienen prioridad sobre el barrido de fondo (`ANALYSIS_PRESCAN`).
- Ganancia (*(nuevo)* `:55`): `min(objetivo − I, LOUDNESS_MAX_GAIN_DB, techoTP − TP)`; se aplica con
  `-af volume=XdB` en el ffmpeg del deck (*(nuevo)* `src/audio-router.ts:1364`), así que MP3 y Opus
  reciben el mismo PCM. Una pista aún sin analizar suena tal cual (gain 0) y se analiza.
- `SMART_TRANSITIONS`: `-ss` sobre el silencio inicial y fin efectivo = inicio del silencio final
  (*(nuevo)* `:67`), con salvaguardas (≥ 5 s de cuerpo, salto ≤ 10 s).
- Visible en el log (`Reproduciendo: X (gain -6.3 dB, I=-9.7 LUFS, TP=0 dBTP, salta 1s de intro
  muda, cruza en 14.0s)`) y en `/status` → `engine.loudness.currentTrack`.

| Captura del stream `/mp3`, `ffmpeg -af ebur128` | Línea base | `LOUDNESS_NORMALIZATION` + `SMART_TRANSITIONS` |
|---|---|---|
| Sintéticas (−9,7 / −22,1 / −14,1 LUFS) | I −12,6 · LRA 12,5 LU · TP 0,0 dBTP · dispersión S p5–p95 **14,2 LU** · silencios de 3,0 s | I −16,0 · LRA 0,2 · TP −3,5 · dispersión **0,2 LU** · sin silencios > 0,5 s |
| 6 fragmentos reales + 1 locución TTS | I −8,0 · LRA 6,2 · **TP +1,6 dBTP** · dispersión **17,2 LU** | I −15,9 · LRA 2,3 · TP −3,5 · dispersión **2,7 LU** |

### 3.6 Menores

- `new URL(req.url, "http://localhost")` (*(nuevo)* `src/http-server.ts:147`): una petición sin
  `Host` daba 500 + traza (45 en el log de producción); ahora 200.
- Ring con índice de cabeza: desalojo O(1) amortizado, snapshot O(k).

### 3.7 Tests

`bun test`: **64 pass, 0 fail** (línea base: 45 pass). Nuevos: `test/ogg-page-assembler.test.ts`
(cortes arbitrarios, resincronización, regresión de OpusTags, cambio de generación),
`test/track-analysis.test.ts` (parser con stderr real de ffmpeg, ganancia, plan),
`test/engine-supervision.test.ts` (inyección de fallos: deck colgado, opus colgado/caído, backoff,
aire muerto, prebuffer en segundos, ring). `tsc --noEmit`: 15 errores, todos ya presentes en la
línea base; ninguno en los archivos nuevos.

---

## 4. Descartado y por qué

- **Curvas equal-power:** ya existían (`src/audio-router.ts:1230`).
- **Cursores por oyente / reescritura del broadcaster:** la distribución ya es *zero-copy*; con
  200 oyentes el motor sube unos 8–10 puntos de CPU y unos 13–20 MiB. Nada que ganar a cambio del riesgo.
- **HWM proporcional al prebuffer:** medido, +75 % de RSS (68 → 120 MiB con 200 oyentes) y ninguna
  expulsión evitada. Revertido.
- **Failover por silencio digital en vivo:** vetado por la abogada del diablo; queda la métrica.
- **Activar `USE_NATIVE_DECODE`:** `NativeDecoder` se importa pero no se usa (`src/audio-router.ts:9`);
  activarlo es un cambio de motor de decodificación, fuera de esta fase.
- **Bajar Opus a 128 kbps:** decisión de producto.
- **`-page_duration` corto en Ogg:** prometedor (hoy las páginas son de ~1 s), pero no se midió aquí.

---

## 5. Nota de viabilidad: fountain codes (RaptorQ, RFC 6330) — Moonshot 3

**Qué prometen.** Un código fuente sin tasa fija permite reconstruir K símbolos a partir de
cualquier K(1+ε) recibidos (ε ≈ 0,2–5 % en RaptorQ) sin retransmisiones ni *feedback*. Es la
herramienta adecuada cuando **un mismo paquete llega a muchos receptores con pérdidas
independientes**: multicast IP, broadcast radio (3GPP MBMS/eMBMS, ATSC 3.0, DVB-H) o enlaces sin
canal de retorno.

**Por qué no aplica a la distribución de Bloom.**

1. **No hay medio broadcast.** Internet hacia navegadores es unicast: cada oyente necesita su propio
   flujo. Con FEC el ancho de banda por oyente es `bitrate × (1 + ε + redundancia)`, es decir, **mayor**,
   no menor. Lo de “decenas de miles de oyentes con el ancho de banda de 1 000” de `MOONSHOTS.md`
   solo es cierto con multicast, y los ISP no lo ofrecen a usuarios finales.
2. **TCP no desperdicia un 40–80 %.** Las cabeceras TCP/IP suponen ~3–5 % a estos tamaños, y las
   retransmisiones son proporcionales a la pérdida real (en redes fijas, < 1 %). El margen que se
   puede recuperar es pequeño.
3. **Cliente propio obligatorio.** Un navegador no recibe UDP crudo: haría falta WebTransport
   (datagramas QUIC) o WebRTC DataChannel no fiable, más un decodificador RaptorQ en WASM. Se pierde
   el `<audio src=…>`, la caché CDN y la compatibilidad con reproductores y directorios.
4. **IPR.** RFC 6330 tiene declaraciones de patentes (Qualcomm). Hay implementaciones libres
   (p. ej. el crate `raptorq`), pero exige revisión legal.
5. **Para audio ya existen herramientas mejores:** Opus trae FEC en banda (LBRR) y ocultación de
   pérdidas. Para baja latencia con muchos oyentes, el camino estándar es **Media over QUIC** con
   relays y CDN.

**Dónde sí tiene sentido.** En la **ingesta** OBS → SRT: libsrt ya incluye FEC (`packetfilter=fec`)
además de ARQ. Es un experimento barato: activarlo en OBS y en la URL del listener, y medir
pérdida y latencia contra `latency=20`.

**Recomendación: no-go** para distribuir a oyentes. Se revisa si aparece un medio con multicast;
mientras tanto la inversión va a MoQ/relays y a acortar el prebuffer (§3.4).

---

## 6. Acta

**Implementado (8 cambios, 4 grupos):** decks (sin `nobuffer`, crossfade por muestras, relevo sin
pérdidas), Opus (páginas, cabeceras por generación, supervisión), aire muerto (watchdog, métricas,
`/health`), latencia (`PREBUFFER_SECONDS`, métricas), sonoridad y transiciones (BS.1770 con caché,
`SMART_TRANSITIONS`), más el arreglo de URL y el del ring.

**Flags nuevas y defaults:**

| Variable | Default | ¿Cambia el comportamiento por defecto? |
|---|---|---|
| `CROSSFADE_SAMPLE_CLOCK` | `true` | Sí: arregla crossfades truncados y el salto de 0,5 s (medido). `false` = antes |
| `DECK_FFLAGS_NOBUFFER` | `false` | Sí: arregla 1,2 s perdidos al inicio de cada MP3. `true` = antes |
| `FALLBACK_STALL_SECONDS` | `5` | Solo actúa cuando hoy habría aire muerto indefinido. `0` = antes |
| `ENCODER_SUPERVISION` | `true` | Solo actúa si el encoder opus muere o se cuelga. `false` = antes |
| `PREBUFFER_SECONDS` | `0` | No |
| `LOUDNESS_NORMALIZATION` (+`_TARGET_LUFS=-16`, `_TRUE_PEAK_DBTP=-1`, `_MAX_GAIN_DB=12`) | `false` | No |
| `SMART_TRANSITIONS` (+`SILENCE_THRESHOLD_DB=-50`) | `false` | No |
| `ANALYSIS_PRESCAN` | `true` | Solo si se activa el análisis |
| `ANALYSIS_CACHE_FILE` | `.analysis-cache.json` | — |

Sin flag (arreglos de errores): cabeceras y páginas Ogg, `ReferenceError` de `preBufferOpus`,
`new URL` con base, ring O(1)/O(k), `/health` → `degraded` con aire muerto.

**Riesgos para producción:**

1. Por defecto **cambia el sonido de las transiciones**: los crossfades pasan a durar 2 s de verdad
   y las canciones empiezan 1,2 s antes (ya no se corta la intro). Es lo que se pretendía, pero hay
   que escucharlo.
2. Con la supervisión, un reinicio del encoder opus manda un **BOS nuevo en mitad del stream** al
   publisher (Ogg encadenado). Antes pasaba igual en cada reinicio, pero ahora el reinicio es
   automático. Hay que verificar que el publisher de bloom lo tolera, matando el encoder en staging.
3. `FALLBACK_STALL_SECONDS=5` puede saltar una fuente remota (URL http en la cola) que tarde más
   de 5 s en arrancar. En producción la cola son archivos locales.
4. Al activar la sonoridad: barrido de fondo de unos 13 min de un núcleo a `nice 10` (323 pistas)
   en un host de 2 núcleos, y la radio queda **7–9 dB más baja** que hoy (los masters están a
   −6/−9 LUFS). Valorar `LOUDNESS_TARGET_LUFS=-14`. Guardar la caché en un volumen
   (`ANALYSIS_CACHE_FILE=music/.analysis-cache.json`); si no, se pierde al recrear el contenedor.
5. `PREBUFFER_SECONDS=10` reduce la ráfaga que recibe el publisher de 1,5 MB a 240 KB. Hay que
   confirmarlo con el equipo de web/API, por si el publisher depende de esa ráfaga.
6. El commit incluirá también los cambios sin commitear que ya había (logger, events,
   boot-report…), que no son de esta sesión y necesitan su propia revisión.

**Pasos para revisar y desplegar (humano):**

```bash
cd /root/projects/buncaster-cli
# 1. Revisar: cambios previos (ajenos) vs. esta sesión
git status && git diff
#    línea base ajena: /tmp/claude-0/-root-projects/eb730593-f4fa-5994-b3c2-8083e759cdfb/scratchpad/buncaster-baseline.patch
#    solo esta sesión: /tmp/claude-0/-root-projects/eb730593-f4fa-5994-b3c2-8083e759cdfb/scratchpad/roundtable-changes.patch
# 2. Tests
docker run --rm -v $PWD:/app -w /app oven/bun:1.2 bun test && rm -f bunradio.log opus-debug.log
# 3. Commit + push (ojo: el push a main dispara CI y TAMBIÉN docker-publish → :latest)
git add -A && git commit -m "engine: crossfade por muestras, decks sin nobuffer, opus supervisado, prebuffer en segundos, BS.1770"
git push origin main
gh run watch                                  # CI Build + Build and Push Docker Image
# (o manual) gh workflow run docker-publish.yml -f image_name=srsergi0/buncaster-cli
# 4. Paso A (solo defaults; sin tocar .env)
docker pull ghcr.io/srsergi0/buncaster-cli:latest
docker rm -f buncaster && cd /root/projects/bloom && docker compose up -d buncaster
docker network inspect bloom_default | grep -q '"buncaster"' || docker network connect bloom_default buncaster
# 5. Verificar
curl -s localhost:4321/health | jq '.status, .engine'
curl -s localhost:4321/metrics | grep -E 'crossfades_total|dead_air|opus_encoder_restarts|fallback_stall'
docker logs buncaster 2>&1 | grep -E 'Cabeceras Ogg/Opus completas|clock":"samples'
# 6. Paso B (tras escuchar el A y validarlo con el publisher), en /root/projects/bloom/.env:
#    PREBUFFER_SECONDS=10
#    LOUDNESS_NORMALIZATION=true
#    SMART_TRANSITIONS=true
#    ANALYSIS_CACHE_FILE=music/.analysis-cache.json
#    y recrear como en el paso 4.
```

**Rollback:** sin cambiar de imagen, `CROSSFADE_SAMPLE_CLOCK=false`, `DECK_FFLAGS_NOBUFFER=true`,
`FALLBACK_STALL_SECONDS=0` y `ENCODER_SUPERVISION=false` devuelven el comportamiento anterior. Para
volver del todo, la imagen anterior es `sha256:019d1840564e…`; retaguéala antes del `docker pull` si
quieres conservarla.

**MODERADORA (cierre):** recomendación de la mesa: **desplegar en dos pasos**. El paso A (defaults)
arregla errores medidos y tiene interruptores. El paso B (sonoridad, transiciones, prebuffer de
10 s) se activa tras escuchar el A y confirmar con el equipo del publisher la ráfaga de 240 KB y el
BOS encadenado.
