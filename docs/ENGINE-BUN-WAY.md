# Motor de Bloom "a la manera de Bun" — modelo de costes medido y optimizaciones

> 21-nov-2026. Continúa `docs/ENGINE-ROUNDTABLE.md` (sin rehacer nada de aquello).
> Regla de la casa, la de Jarred Sumner: **medir o no ha pasado**. Cada cambio de este
> documento lleva su número antes/después en esta máquina (2 núcleos, compartida con
> producción). Lo que no movió un número está en §6 (rechazado).
>
> Producción (`buncaster`) solo se **leyó**: `docker top`, `docker stats`, `docker logs`,
> `docker inspect`, `/health`, `/metrics`. Todas las pruebas se hicieron en contenedores
> propios (`buncaster-cli:bunway-base` = `HEAD c83e9ba`, `buncaster-cli:bunway` = este
> trabajo) en `127.0.0.1:4389-4398`, sin publicar SRT, con `music/` de bloom en solo lectura.

---

## 0. Resumen

| | Antes (`c83e9ba`) | Después, defaults | Después + `MP3_ON_DEMAND` + `SRT_ON_DEMAND` |
|---|---|---|---|
| CPU en reposo como producción (1 oyente opus, pista MP3) | 10,9 % de un núcleo | 8,5 % (−21 %) | **3,4 % (−71 %)** |
| CPU con 200 oyentes (100 mp3 + 100 opus) | 18,4–19,2 % | 11,6 % (−40 %) | 9,6–9,8 % (−49 %) |
| Syscalls/s en reposo | 1 939 | 1 131 | 648 |
| Procesos en reposo | 4 | 3 | 2 |
| Procesos lanzados por canción | 1 `ffmpeg -re` | 0 | 0 |

Las tres causas principales, todas de tipo *hacer menos trabajo*:

1. **Se codifica MP3 320k para nadie.** En producción, `totalBytesSent` (mp3) = **0 bytes en
   35 días**: todo el tráfico va por `/opus` (el publisher). LAME es el **74 %** de la CPU del
   proceso principal.
2. **El decode nativo existía pero no se usaba.** El cableado de `NativeDecoder` en
   `startFallback` se perdió en `e44120e` (04-sep, "moonshot dual-tier opus"). Desde entonces
   cada canción lanza un `ffmpeg -re` cuyo coste (1,9 %) es **8 veces** el de decodificar (0,25 %).
   Además, el decoder tenía dos bugs latentes, corregidos aquí (§5.2).
3. **Un `ffmpeg` SRT escuchando en vacío** gasta 1,5–1,7 % de un núcleo (libsrt hace unos 450
   `recvmsg`/s con timeout): son las 14 h de CPU que acumuló en producción sin ningún directo.

---

## 1. Método

- **CPU por proceso**: ticks `utime+stime` de `/proc/<pid>/stat` durante 30 s; total del
  contenedor con `cpu.stat` del cgroup (100 % = un núcleo). RSS por proceso y `memory.current`
  del cgroup. Script: `scratchpad/measure.sh`.
- **Syscalls**: `strace -c -f -p` sobre cada proceso del contenedor (15–20 s), en llamadas/s.
- **Perfil**: `perf record -g -p <bun>` agrupado por DSO (LAME, kernel, runtime de Bun, JIT).
- **Asignaciones/GC**: motor ejecutado desde el código fuente con `--preload` que muestrea
  `heapStats()` de `bun:jsc` cada 100 ms. La suma de las subidas de `heapSize + extraMemorySize`
  da una cota inferior de los bytes asignados; cada caída de más de 256 KB cuenta como un GC.
- **Carga**: cliente Bun propio (`scratchpad/load/load.ts`) con 200 oyentes (100 `/mp3` + 100
  `/opus`) que leen de verdad. Mide el TTFB de la estampida y una **sonda**: 60 conexiones nuevas,
  de una en una, en régimen estable. Cada prueba duró ≤ 55 s.
- **Ruido del host.** El host es compartido: una misma configuración varió ±2 puntos entre pasadas
  separadas, y la pista que sonara (MP3 o FLAC) cambiaba todos los costes. Por eso **las cifras de
  comparación se tomaron con A, B y C funcionando a la vez** y con la **misma pista fija**
  (`FALLBACK_SOURCE` = un archivo). La biblioteca tiene 238 MP3 + 16 `.MP3` + 85 FLAC.
- **Entorno de pruebas** como el de producción: `alpine:3.20` + ffmpeg 6.1.1 (libavformat 60) +
  binario compilado desde el `Dockerfile` del repo, con el env de producción (opus 192k, mp3 320k,
  `PREBUFFER_BYTES=1572864`, `CROSSFADE_SECONDS=2`, etc.).

---

## 2. Lo que vimos en producción (solo lectura)

| Observación | Valor | Fuente |
|---|---|---|
| Imagen | `sha256:019d1840564e…`, construida el **16-sep**: anterior a la mesa redonda (`7453418`) y a este trabajo | `docker inspect` |
| CPU acumulada en 35 días | main 2 d 6 h (6,4 %) · ffmpeg opus 22 h (2,6 %) · **ffmpeg SRT 14 h 24 min (1,7 %)** sin ningún directo · decks: un `ffmpeg -re` por canción | `docker top` |
| SRT en reposo, por hilo | `SRT:RcvQ:w1` 11,4 h · hilo principal de ffmpeg 3 h · `SRT:GC` 0,03 h; 7–8 ticks cada 5 s (≈1,5 %) | `/proc/<pid>/task/*/stat` |
| Tráfico | mp3: **0 B** en 35 días; opus: 75,1 GB (1 oyente, el publisher) | `/health` |
| Logs de arranque | ninguna línea de `NativeDecoder` (se confirma que no se usa) | `docker logs \| head -80` |
| Librerías en la imagen | `libavformat.so.60`, `libmp3lame.so.0` y **`libopus.so.0`** presentes | `docker exec ls /usr/lib` |
| `docker stats` | buncaster 8,7 % / 127 MiB; publisher 1,4 % / 121 MiB | `docker stats` |

*Nota:* a las 09:26 UTC alguien modificó `bloom/.env` y `bloom/docker-compose.yml` y, a las 09:37,
recreó el stack bloom (misma imagen `019d1840…`, mismas variables relevantes). No fue este trabajo.
Las cifras de esta tabla son anteriores a esa recreación.

**¿Por qué no se usaba el decode nativo?** No es un problema de detección ni de las librerías de
alpine, que están todas. El `if (useNativeDecode && isNativeDecodeAvailable()) new NativeDecoder(…)`
que añadió `5d5f401` desapareció en `e44120e` al reescribir `startFallback`. El módulo seguía
importándose y abría las librerías al cargar, pero nadie lo instanciaba. `AGENTS.md` ("cero procesos
ffmpeg en reproducción") estaba desactualizado desde entonces.

---

## 3. Modelo de costes (Fase 1)

### 3.1 En reposo: 0 oyentes, pista MP3 320k (línea base, host tranquilo)

| Proceso | CPU (% de un núcleo) | RSS | Syscalls/s (principales) |
|---|---|---|---|
| `buncaster` (Bun) | **6,07** | 53 MB | 395 — `recvfrom` 117 (78 con `EAGAIN`), `epoll_ctl` 78, **`statx` 65**, `epoll_pwait` 49, `sendto` 38 |
| `ffmpeg` opus 192k | 2,60 | 38 MB | 557 — `futex` 514, `read` 38 |
| `ffmpeg -re` deck | 1,87 | 40 MB | 595 — `futex` 460, `write` 38, `nanosleep` 38 |
| `ffmpeg` SRT listener (vacío) | 1,63 | 36 MB | 547 — **`recvmsg` 450 (todos `EAGAIN`)**, `futex` 97 |
| **Total** | **12,28** | cgroup 81 MiB | **2 096** |

`perf` del proceso Bun: **libmp3lame 73,7 %**, kernel 11,2 %, runtime de Bun 10,9 %, musl 2,9 %,
código JIT 1,2 %. El JavaScript en sí es casi gratis; quien gasta es LAME.

El ritmo de 38 llamadas/s que se repite por todas partes es el de un deck MP3: `ffmpeg -re` escribe
un frame decodificado (1 254 muestras ≈ 26 ms ≈ 5 016 B) por `write`. Cada uno se convierte en un
`recvfrom` en Bun, una llamada FFI a LAME, un `sendto` al pipe de opus, un `read` en ffmpeg-opus y
un broadcast, es decir, **un `sendto` por oyente `/mp3`**.

### 3.2 Por oyente (200 = 100 mp3 + 100 opus)

| | 0 oyentes | 200 oyentes | Por oyente |
|---|---|---|---|
| CPU del proceso Bun | 6,07 % | 15,93 % | **+0,049 puntos** |
| `sendto`/s | 38 | **3 739** | = 100 oyentes mp3 × 38 chunks/s (+100 `sendmsg`/s de opus: 1 página/s) |
| `perf` | — | **kernel 57 %**, LAME 28,7 %, runtime 10 % | el coste por oyente es pila TCP: una llamada por chunk y oyente |
| Memoria (cgroup) | 81 MiB | 110 MiB | ~0,15 MiB |

La distribución ya era *zero-copy*, como ya midió la mesa redonda: todos los oyentes reciben la misma
`Uint8Array` inmutable. Lo que escala con los oyentes no son las copias, sino el **número de
syscalls por oyente**.

### 3.3 Por cambio de pista

| Paso | Coste medido |
|---|---|
| `ffprobe` de metadatos (1.ª vez por archivo y contenedor; `.meta-cache.json` vive en la capa del contenedor) | 70–120 ms de CPU, 110–140 ms de pared |
| `ffmpeg -re` del deck: spawn + sondeo hasta el primer PCM | ~50 ms de CPU en el hijo, **101 ms de pared**, +40 MB de RSS mientras suena |
| *(nuevo)* abrir y sondear en proceso (`avformat_open_input` + `find_stream_info`) | **7–56 ms de CPU, síncrono** (FLAC 7 ms; MP3 25–56 ms porque lavf sondea más frames) |

### 3.4 Sesión SRT en directo (emisor `ffmpeg … -c:a aac -f mpegts srt://…`)

| Proceso | CPU | Syscalls/s |
|---|---|---|
| `buncaster` | 4,73 % (LAME sigue codificando para nadie) | 372 |
| `ffmpeg` SRT con datos | 2,83 % | 1 251 — `futex` 707, `recvmsg` 465, `write` 46 |
| `ffmpeg` opus | 2,07 % | 537 |
| **Total** | **9,70 %** | 2 161 |

### 3.5 Microbenchmarks de las funciones calientes

| Función | Medida | Lectura |
|---|---|---|
| Decodificar sin `-re` (ffmpeg CLI, 1 hilo) | MP3 de 261 s: 0,65 s de CPU (**0,25 %**); FLAC: 0,18 % | decodificar es barato |
| *(nuevo)* `decodeFileToPcm` en proceso | **400–650× tiempo real** (0,15–0,25 %) | igual que ffmpeg; el coste del deck estaba en `-re` y los hilos |
| LAME-FFI 320k q2 | **3,3 % de un núcleo** en tiempo real (~30×); **sha256 idéntico** con chunks de 5 016, 19 200 y 192 000 B | la salida no depende del troceado |
| Solo codificar opus 192k | 1,27 % | el proceso en el pipeline cuesta 2,6–2,9 %: la mitad es sobrecoste |
| ffmpeg-opus alimentado a 1× según tamaño del chunk | 5 016 B: **2,78 %** · 19 200 B: **2,12 %** · 38 400 B: 1,83 % · 19 200 B + `-threads 1`: 1,87 % | `read` 880 → 319 en 20 s; los paquetes son **idénticos** (`framemd5`) con 5 016, 19 200 y 7 777 B |
| `GET /status` | 0,29 ms de CPU por petición | a 0,5 req/s (publisher) = **0,015 %** |
| Sondeo de playlist (`getAudioFilesRecursive`, 323 archivos, cada 5 s) | 2,09 ms → **0,04 %**; de ahí los 65 `statx`/s | despreciable |
| `AudioRingBuffer.push` (copia + slot + desalojo) | 0,46–0,81 µs → **< 0,002 %**; snapshot de 1,5 MB: 12,7 µs | despreciable |
| `FileSink.write` reutilizando el buffer con el lector parado (SIGSTOP) | bytes idénticos en Bun 1.2.23 y 1.4.5 | Bun copia lo pendiente; se puede reutilizar un lote |
| Asignación JS (heapStats) | 483–501 KB/s, 2–3 GC/min, heap máx. 22–24 MB | sin presión de GC relevante |

### 3.6 Ranking de puntos calientes por coste medido

| # | Punto caliente | Coste (reposo como producción) | Principio que lo ataca |
|---|---|---|---|
| 1 | **LAME codificando MP3 sin oyentes** | 3,3–4,5 puntos, 24/7 (74 % del proceso principal) | *Hacer menos trabajo*: el trabajo más barato es el que no se hace (Sumner) |
| 2 | **Proceso opus alimentado a trozos de 26 ms** | 2,6 puntos, de los que ~1,3 son sobrecoste: 557 syscalls/s, `futex` por cada `read` | *Menos syscalls, agrupar escrituras* (Axboe, "Efficient IO with io_uring") |
| 3 | **`ffmpeg -re` por canción** | 1,9 puntos (decodificar solo vale 0,25) + 595 syscalls/s + 40 MB + spawn por canción | *Nativo antes que spawn*: FFI en proceso quita un proceso, un pipe y una copia |
| 4 | **Listener SRT ocioso** | 1,6 puntos + 547 syscalls/s + 36 MB, sin nadie emitiendo | *Hacer menos trabajo* / *menos syscalls*: un socket en epoll no despierta nunca |
| 5 | **Un `sendto` por chunk y oyente** | 0,05 puntos por oyente; 3 739 syscalls/s con 100 oyentes mp3 | *Agrupar escrituras*: menos llamadas más grandes |
| 6 | Pequeños: `statx` 65/s, `/status`, ring, asignaciones de 500 KB/s | < 0,05 puntos cada uno | *Medir o no ha pasado*: no se tocan (§6) |

---

## 4. Lo que no hacía falta arreglar (comprobado)

- **Copias en el ring y en el fan-out.** `new Uint8Array(chunk)` en `push` hace falta: la salida de
  LAME vive en un scratch que se reutiliza. `slots.slice()` solo compacta cada >1 024 desalojos
  (amortizado O(1)). Coste medido: < 0,002 % de un núcleo. El fan-out ya comparte un único buffer
  inmutable entre todos los oyentes.
- **SSE frente al sondeo de `/status`.** **No hay SSE en el motor**: `src/events.ts` es el catálogo
  de nombres de evento del log. El sondeo del publisher cada 2 s cuesta 0,015 % de un núcleo. Un
  endpoint SSE no ahorraría CPU medible; su único valor sería la latencia de los cambios de
  *now-playing* (≤ 2 s hoy). Diseño en §5.6, sin implementar.

---

## 5. Cambios (Fase 2), de menor a mayor diff

### 5.1 `ENCODER_BATCH_MS=100`: lote de PCM hacia los encoders (defecto activado; salida idéntica)

**Problema (#2 y #5):** cada trozo de deck de 26 ms costaba 1 `write` al pipe de opus, 1 `read` y
unos 10 `futex` en ffmpeg, 1 llamada FFI a LAME y 1 broadcast (= 1 `sendto` por oyente mp3).

**Cambio:** `writeToMaster` sigue haciendo por trozo la contabilidad (reloj de muestras, aire muerto),
pero copia el PCM a un **lote contiguo preasignado** de 100 ms (19 200 B, sin asignaciones) y entrega
el lote a los encoders cuando se llena (`feedEncoders`). `stopMasterEncoder` vacía el resto.
*Principios:* Axboe (agrupar, menos syscalls) y Drepper (buffer contiguo reutilizado).

**Prueba de salida idéntica** (regla 5; por eso va activado por defecto):

- LAME: el MP3 sale con **el mismo sha256** troceando de 5 016 o de 19 200 B
  (`test/bun-way.test.ts`, que corre en CI) y de 192 000 B (microbenchmark).
- Opus: `ffmpeg -i out.opus -c copy -f framemd5` da **los mismos paquetes** con chunks de 5 016,
  19 200 y 7 777 B. El sha del archivo Ogg completo cambia en cada ejecución, también sin este
  cambio, porque oggenc elige un número de serie aleatorio.
- Reutilizar el lote tras `stdin.write` es seguro: verificado con el lector parado (SIGSTOP) en
  Bun 1.2.23 y 1.4.5.

**Coste:** ≤ 100 ms más de latencia (frente a prebuffers de 10–65 s). `ENCODER_BATCH_MS=0` vuelve
al comportamiento anterior.

**Efecto medido** (incluido en las columnas B/C): `read` del proceso opus 38/s → 10/s; `sendto`
del proceso Bun 38/s → 10/s en reposo y **3 739/s → ~1 000/s con 100 oyentes mp3**; CPU del proceso
opus 2,3–2,5 % → 1,7–1,9 %.

### 5.2 `USE_NATIVE_DECODE=auto` vuelve a funcionar (decode en proceso)

**Problema (#3):** §2.

**Cambio en `startFallback`:** si `USE_NATIVE_DECODE != false`, la pista es un archivo local, no hay
ganancia ni salto del análisis (el decoder nativo no aplica `-af volume` ni `-ss`), no se pide
`DECK_FFLAGS_NOBUFFER` y la librería está disponible, se usa `new NativeDecoder(file)` con la misma
interfaz que un `Subprocess` (`stdout`, `kill`, `exited`). Si falla al abrir, se usa ffmpeg para esa
pista. Contadores nuevos: `radio_deck_decodes_total{engine="native"|"ffmpeg"}`.

**Cambios en `src/decode-ffi.ts`**, todos por evidencia:

| Qué | Por qué (medido) |
|---|---|
| **Vaciar el decoder y swresample al llegar a EOF** (paquete nulo → frames retenidos → `swr_convert(NULL)`) | Antes se volvía en cuanto se enviaba el paquete nulo. Sin vaciar swr, los archivos de 44,1 kHz perdían las **últimas 18 muestras** (72 B): 2 de 3 archivos difieren de ffmpeg CLI; con el vaciado, 0 de 21 |
| **Ritmo `-re` fiel**: ráfaga inicial de 0,5 s (el `readrate_initial_burst` de ffmpeg 6.1) y luego 1× | Esa ráfaga es la que llena el buffer del deck entrante antes de cada crossfade. El código viejo no la tenía y emitía **trozos de 1 s**: el volumen del crossfade habría subido en 2 escalones en vez de unos 90 (lectura de código) |
| Trozos de **4 KiB (21 ms)**: vistas sin copia de un bloque de ~1 s | Granularidad del crossfade igual o más fina que ffmpeg (26 ms en MP3, 93 ms en FLAC) |
| Bloque al tamaño exacto (`scratch.slice(0, n)`) | Reservar el bloque con el margen de 98 KB subía la asignación de 483 a **693 KB/s**; con el tamaño exacto, **503 KB/s** (= base) |
| Solo **libavformat 60** (offsets verificados) y comprobación de cordura (rate, formato, canales) | Con otra versión mayor, los offsets fijos leerían basura |
| Solo con **Bun ≥ 1.3** | **Bun 1.2.23 con glibc revienta** (segfault/SIGILL) dentro de `avformat_find_stream_info` vía FFI; 1.2 musl, 1.3.14 y 1.4.5 funcionan |
| Carga perezosa de las libs y `av_log_set_level(AV_LOG_FATAL)` | En proceso, libav escribía avisos por frame en el stderr del motor |
| Errores sueltos de decodificación: se sigue (como ffmpeg CLI); solo se para tras 100 seguidos | Antes, un frame malo cortaba la pista |

**Prueba de salida idéntica:** `decodeFileToPcm` frente a `ffmpeg -i X -vn -f s16le -ar 48000 -ac 2 -`.
**21/21 archivos idénticos byte a byte** (longitud y sha256): 15 reales de la biblioteca (MP3 44,1 y
48 kHz, FLAC, `.MP3`) y 6 sintéticos (MP3 mono a 22,05 kHz, FLAC con carátula, WAV 48k, AAC/M4A,
Vorbis con pista de vídeo Theora). El test de CI hace lo mismo con un WAV de 44,1 kHz.

**Audio extremo a extremo** (clips de 15 s, 6 formatos, crossfade de 2 s, 90 s, base y nuevo a la vez):

| | Base (ffmpeg) | Nuevo (nativo) |
|---|---|---|
| Crossfades completos / truncados | 7 / 0 | 7 / 0 |
| `radio_crossfade_underrun_bytes_total` | 29 280 | **0** |
| Aire muerto | 0 | 0 |
| Deriva del reloj de audio | +0,72 s | +0,43 s |
| Captura `/mp3`: errores de decodificación / silencios > 0,2 s | 0 / 0 | 0 / 0 (y `/opus`: 0 / 0) |
| Fuga de memoria | — | ninguna: 46 pistas, RssAnon estable en 17–24 MB |

**Efecto:** −1 proceso, −40 MB y −1 spawn por canción, −595 syscalls/s. Con pista MP3, CPU total
**−2 puntos** (pares concurrentes: B/A = 0,75–0,80); el proceso principal se queda igual o baja algo,
aunque ahora decodifica él. Con pista FLAC, CPU neutra (A ≈ B), porque el FLAC ya llegaba en bloques
de 93 ms, pero se mantiene el ahorro de proceso y memoria.

### 5.3 `MP3_ON_DEMAND` (defecto `false`; recomendado `true` en Bloom)

**Problema (#1):** LAME 320k q2 cuesta 3,3–4,5 puntos 24/7 para 0 oyentes.

**Cambio:** con la flag, `feedEncoders` escribe el PCM en un `PcmHistory`: anillo contiguo
preasignado de tantos segundos como el prebuffer mp3 (39 s con `PREBUFFER_BYTES=1572864`, unos
7,5 MB), con posiciones absolutas y sin asignar memoria. Tras **30 s sin oyentes `/mp3`**, LAME
deja de codificar y se vacía el prebuffer mp3, que ya sería audio viejo. Cuando el servidor HTTP
registra un oyente `/mp3`, llama a `mp3ListenerJoined()`: crea un LAME nuevo (el estado del anterior
era de hace minutos), codifica el historial en **rodajas de 0,25 s (~9 ms)** cediendo el event loop
entre una y otra y sigue en vivo. Un token de generación invalida las rodajas pendientes si se para
el encoder. Si se entra en directo con low-latency, no se manda historial (como el snapshot actual).

**Comportamiento observable:** el oyente recibe la **misma ráfaga de prebuffer** que hoy, solo que
codificada en ese momento:

| Prueba | Resultado |
|---|---|
| Primer oyente tras el reposo | TTFB **44 ms**; en 12 s recibe 2,05 MB = 51,3 s de audio (39 s de historial + 12 s en vivo); **0 errores** al decodificar |
| Segundo oyente justo después | TTFB 2 ms y 1,57 MB en 1 s (prebuffer completo) |
| 30 s sin oyentes `/mp3` | `radio_mp3_encoder_active 0` |
| Despertar en frío con 200 conexiones a la vez | p50 62 ms, **p99 ≈ 0,4–0,5 s** (frente a ~0,2 s sin la flag): el historial se codifica en las mismas fracciones de segundo en que llegan las conexiones. Con rodajas de 1 s el p99 era peor; por eso se dejaron en 0,25 s |

**Costes y riesgos:** ~1,3 s de CPU repartidos en cada despertar en frío; el stream de ese oyente
empieza con el retardo de LAME (~25 ms de silencio); `bitrateDetector` no se actualiza en reposo.
Va desactivado por defecto porque cambia *cuándo* se codifica el prebuffer.

### 5.4 `SRT_ON_DEMAND` (defecto `false`; recomendado `true` en Bloom)

**Problema (#4):** el listener SRT ocioso hace 450 `recvmsg`/s y ~100 `futex`/s y gasta 1,5–1,7 % y
36 MB. libsrt no tiene un flag para un reposo más barato: el bucle de recepción con timeout corto es
interno.

**Cambio:** `waitForSrtKnock()` abre un `Bun.udpSocket` en el puerto SRT (en epoll: **0 despertares**
en reposo). Al llegar el primer datagrama (el handshake de inducción del emisor), lo cierra y lanza el
`ffmpeg` listener de siempre, que contesta al siguiente reintento del handshake (el emisor SRT repite
cada ~250 ms durante sus 3 s de timeout de conexión). Si en 15 s no llega audio (un escáner o una
sonda), mata ese ffmpeg y vuelve al reposo. Si no puede abrir el socket UDP (10 intentos), usa el
listener permanente de antes.

| Medida | Antes | `SRT_ON_DEMAND=true` |
|---|---|---|
| Procesos SRT en reposo | 1 ffmpeg (36 MB) | 0 |
| Tiempo hasta salir en directo (incluye arrancar el contenedor emisor) | 5 367 / 5 415 ms | 5 627 / 5 685 / 5 725 ms (**+0,3 s**: un reintento de handshake) |
| Tras terminar la sesión | ffmpeg relanzado escuchando | vuelve a reposo armado (`radio_srt_armed 1`) |

**Riesgo:** depende de que el emisor reintente el handshake. libsrt lo hace (OBS usa libsrt), y lo
comprobé con `ffmpeg … srt://…?mode=caller`. Conviene probarlo una vez con el OBS real antes de dejarlo.

### 5.5 libopus por FFI en vez del proceso ffmpeg: diseño y estimación (no implementado)

**Medido:** codificar opus 192k cuesta 1,27 %; el proceso, después del lote, 1,7–1,9 %, y además
37 MB de RSS y ~520 `futex`/s. `libopus.so.0` ya está en la imagen.

**Diseño:**

- `opus-ffi.ts` con `opus_encoder_create(48000, 2, OPUS_APPLICATION_AUDIO)`, `opus_encode` sobre
  tramas de 960 muestras tomadas del lote de 100 ms (5 tramas por lote, sin resto) y
  `opus_encoder_ctl`. Esta última es variádica: en x86-64 SysV se puede llamar con una firma fija
  `(ptr, i32, i32)`, porque `%al` solo acota cuántos registros vectoriales se usan.
- Mismos parámetros que el wrapper de ffmpeg (VBR, complejidad 10, trama de 20 ms) para obtener los
  **mismos paquetes**.
- Muxer Ogg en JS (RFC 7845): página BOS con OpusHead (pre-skip = `OPUS_GET_LOOKAHEAD`), OpusTags,
  páginas de ~1 s con granule = muestras + pre-skip, CRC32 con tabla. `OggPageAssembler` y
  `OpusHeaderCollector` siguen sirviendo tal cual, alimentados por este muxer.
- Supervisión: sin proceso no hay nada que matar. Un fallo del encoder en proceso se gestiona
  recreándolo, pero un crash nativo tiraría todo el motor.

**Estimación:** −0,5 a −0,7 puntos de CPU, −37 MB y −520 syscalls/s; unas 300 líneas más tests de
paquetes idénticos frente a ffmpeg. Lo dejo para otra fase, detrás de una flag `OPUS_NATIVE` en
`false`. Con el lote de 5.1 ya se recuperó la mitad del sobrecoste del proceso, y el resto no
justifica todavía el riesgo de meter otra librería C en el proceso del motor.

### 5.6 Otros diseños sin implementar

- **`track-analysis.ts` en proceso.** Solo cuesta con `LOUDNESS_NORMALIZATION`/`SMART_TRANSITIONS`,
  ambos desactivados en producción: 2–3 s de CPU por pista, una sola vez y cacheado.
  `decodeFileToPcm` ya da el PCM exacto a 400–650× tiempo real. Faltaría el filtro K de BS.1770
  (dos biquads sobre `Float32Array`), la integración con puertas de −70 LUFS y −10 LU, el true-peak
  con sobremuestreo ×4 (un FIR polifásico) y `silencedetect`. Calculo que la medición de sonoridad
  quedaría en ~50–100× tiempo real en JS frente a los 74–122× de ffmpeg: ahorra el spawn, no CPU.
  No compensa hasta que se active el análisis.
- **Metadatos sin `ffprobe`.** Con lavf ya abierto, duración y etiquetas salen de `AVFormatContext`.
  Necesita más offsets verificados. Hoy son ~0,1 s de CPU por archivo y contenedor; conviene más
  persistir `.meta-cache.json` en un volumen.
- **Integración con el publisher** (repo bloom, no tocado). El sondeo de `/status` cada 2 s cuesta
  0,015 %. Si se quiere *now-playing* inmediato, un `GET /events` (SSE, `text/event-stream`) que emita
  `track` / `live` / `listeners` al cambiar el estado: una conexión ociosa por consumidor y cero
  trabajo entre eventos. El publisher cambiaría el `setInterval` por un `EventSource` con reconexión
  y dejaría `/status` como respaldo. Es una mejora de latencia, no de eficiencia.

---

## 6. Rechazado porque los números no se movieron (o no compensaba)

| Idea | Medida | Decisión |
|---|---|---|
| Quitar la copia de `AudioRingBuffer.push` / la compactación con `slice` | < 0,002 % de un núcleo | No se toca (la copia de la salida de LAME hace falta) |
| `ReadableStream` `type: "direct"` para los oyentes | Con 200 oyentes (después del lote): kernel 39,6 %, LAME 38 %, runtime de Bun 14 %, JIT 1,8 %. El techo de lo que puede ahorrar la parte JS de los streams es ~1 punto | No compensa: perdería la contrapresión `desiredSize` en la que se basa la expulsión de oyentes lentos |
| `-threads 1` en ffmpeg-opus | 2,12 % → 1,87 % (−0,25) con chunks de 100 ms | Marginal y sin verificar salida idéntica: no |
| SSE en vez de sondear `/status` | 0,015 % | Solo mejora latencia (§5.6) |
| Sondeo de playlist cada 5 s (65 `statx`/s) | 0,04 % | No se toca |
| Copia FIFO del relevo de deck (`AudioStreamBuffer.pull` copia ~192 KB/s durante toda la pista tras un crossfade) | La asignación total es de ~500 KB/s y 2–5 GC/min; no tiene coste de CPU medible | Evitarla obligaría a trocear distinto las rampas: no merece el riesgo |
| Trozos nativos de 50 ms en vez de 21 ms (menos JS por trozo con FLAC) | Con FLAC, B ≈ A; la mejora posible sería < 0,5 puntos y engrosaría los escalones del crossfade | Se quedan los 21 ms |
| Bajar la calidad de LAME (q2 → q5) | — | Decisión de sonido, no de eficiencia: fuera de alcance |

---

## 7. Antes / después (Fase 3)

A = `c83e9ba` · B = este trabajo con los defaults (`ENCODER_BATCH_MS=100`, `USE_NATIVE_DECODE=auto`) ·
C = B + `MP3_ON_DEMAND=true` + `SRT_ON_DEMAND=true`. Pista fija; **A, B y C medidos a la vez**
(rangos de 3–6 ventanas de 30 s); env de producción.

| Métrica | A | B | C |
|---|---|---|---|
| CPU en reposo, 1 oyente opus, pista MP3 (como producción) | 9,9–12,8 % (mediana 10,9) | 7,9–10,1 % (8,5); **−21 %** por pares | 3,2–3,6 % (3,4); **−71 %** |
| CPU en reposo, pista FLAC | 8,3–10,1 % | 8,4–10,4 % (≈ A) | 3,2–3,8 % |
| CPU con 200 oyentes (100 mp3 + 100 opus) | 18,4–19,2 % | **11,6 %** (−40 %) | **9,6–9,8 %** (−49 %; incluye el despertar en frío de LAME) |
| CPU en directo SRT | 9,2 % (par con C) / 14,9 %\* (par con B) | 14,3 %\* | **4,9 %** |
| Memoria del cgroup en reposo | 54–64 MiB | 43–56 MiB | 42–47 MiB |
| Memoria del cgroup con 200 oyentes | 75–79 MiB | 73 MiB | 55–65 MiB |
| RSS anónima del proceso Bun en reposo | 14–17 MB | 19 MB (+ libav mapeada, compartida y respaldada por archivo) | 36 MB (incluye 7,5 MB de historial PCM) |
| Syscalls/s en reposo | 1 939 | 1 131 | **648** |
| Syscalls/s con 200 oyentes | 5 378–6 194 | 2 361 | 1 689–1 761 |
| Procesos en reposo / en directo | 4 / 3 | 3 / 3 | **2** / 3 |
| Spawns por canción | 1 `ffmpeg` (+1 `ffprobe` la 1.ª vez) | 0 (+`ffprobe` la 1.ª vez) | igual que B |
| TTFB p99, estampida de 200 | 212–1 098 ms (muy variable) | 465 ms | 387–498 ms (despertar en frío) |
| TTFB de la sonda en régimen, p50 / p90 | 3,1–4,6 / 9–11 ms | 3,5 / 6,8 ms | 2,4–3,3 / 11–13 ms |
| Asignación JS / GC | 483–501 KB/s, 2–3 GC/min | 503 KB/s, 4–5 GC/min (ruido de la ventana) | no medido (el historial no asigna; LAME en reposo no copia) |
| Tiempo hasta salir en directo SRT | 5,37–5,42 s | igual | 5,63–5,73 s (+0,3 s) |

\* El host estaba cargado (load 2,4) durante ese par: cuenta la comparación dentro del par, no el
valor absoluto. En directo no hay deck, así que B solo ahorra el lote; el grueso del ahorro en
directo es `MP3_ON_DEMAND`.

**Proyección a producción** (con C): de ~11 % a ~3,5 % de un núcleo de media (≈ −0,75 núcleos-hora
al día), −2 procesos permanentes (SRT y deck) y −70 a −75 MB de RSS en procesos hijos. Lo que queda
es, sobre todo, el encoder opus (1,8 %), que es el que de verdad se escucha.

**Tests:** `bun test` → **bun 1.2: 68 pass, 3 skip, 0 fail**; **bun 1.4.5: 68 pass, 3 skip, 0 fail**
(imágenes `oven/bun`, sin ffmpeg ni libs). En una imagen como el runner de CI (Ubuntu 24.04 +
ffmpeg 6.1.1): **bun 1.4.5 71/71** (3 veces seguidas) y **bun 1.2: 69 pass + 2 skip** (decode nativo
desactivado por versión). En el runtime de producción (alpine 3.20 + ffmpeg 6.1): 71/71. Línea base:
64 pass. Tests nuevos: `test/bun-way.test.ts` (7): invariancia de LAME al troceado, `PcmHistory`, PCM
nativo = ffmpeg CLI, ritmo de `-re`, archivo inexistente y despertar SRT por UDP. Ninguno arranca el
motor ni deja `state` modificado.
**`tsc --noEmit`** (TypeScript 5.9.3): 14 errores antes y 14 después, los mismos (ninguno nuevo).

---

## 8. Despliegue (manual, por el propietario)

Este cambio trae también lo de la mesa redonda (`7453418` y siguientes), que **nunca llegó a
producción**: la imagen actual es del 16-sep. Aplican también sus riesgos (`ENGINE-ROUNDTABLE.md` §6).

```bash
cd /root/projects/buncaster-cli
git status && git diff                     # revisar
docker run --rm -v $PWD:/app -w /app oven/bun:1.2   bun test
docker run --rm -v $PWD:/app -w /app oven/bun:1.4.5 bun test
rm -f bunradio.log opus-debug.log          # los generan los tests
git add -A && git commit -m "engine: decode nativo recableado, lote PCM a encoders, MP3/SRT bajo demanda"
git push origin main                       # dispara CI y docker-publish → ghcr.io/srsergi0/buncaster-cli:latest
gh run watch

# Guardar la imagen actual para poder volver
docker tag ghcr.io/srsergi0/buncaster-cli:latest buncaster-cli:pre-bunway

# Paso A: solo defaults (el .env de bloom ya tiene USE_NATIVE_DECODE=auto → decode nativo activo)
docker pull ghcr.io/srsergi0/buncaster-cli:latest
docker rm -f buncaster && cd /root/projects/bloom && docker compose up -d buncaster
docker network inspect bloom_default | grep -q '"buncaster"' || docker network connect bloom_default buncaster
docker logs buncaster 2>&1 | grep -E 'native.decode.loaded|LAME-FFI'
curl -s localhost:4321/metrics | grep -E 'deck_decodes_total|crossfades_total|dead_air_seconds'
docker top buncaster                       # sin ffmpeg -re por canción
docker stats --no-stream buncaster         # esperado ~7 % (antes 8,7 %)

# Paso B (tras escuchar el A unas horas), en /root/projects/bloom/.env:
#   MP3_ON_DEMAND=true
#   SRT_ON_DEMAND=true
# recrear como arriba y verificar:
curl -s localhost:4321/metrics | grep -E 'mp3_encoder_active|srt_armed'   # 0 y 1 a los 30 s
docker top buncaster                       # solo buncaster + ffmpeg opus
# probar una vez una entrada real desde OBS (SRT) → debe entrar en directo (~0,3 s más)
```

**Vuelta atrás** sin cambiar de imagen, en el `.env` de bloom y recreando:

| Para volver a… | Poner |
|---|---|
| decks con ffmpeg | `USE_NATIVE_DECODE=false` |
| un write por trozo | `ENCODER_BATCH_MS=0` |
| LAME siempre activo | `MP3_ON_DEMAND=false` (o quitarlo) |
| listener SRT permanente | `SRT_ON_DEMAND=false` (o quitarlo) |
| todo lo anterior a la mesa redonda | además `CROSSFADE_SAMPLE_CLOCK=false`, `DECK_FFLAGS_NOBUFFER=true`, `FALLBACK_STALL_SECONDS=0`, `ENCODER_SUPERVISION=false` |
| la imagen anterior | `docker tag buncaster-cli:pre-bunway ghcr.io/srsergi0/buncaster-cli:latest` y recrear (o la imagen `sha256:019d1840564e…`) |

---

## 9. Riesgos para producción

1. **Decode en proceso.** Un crash de libavcodec con un archivo corrupto ahora tira el motor entero.
   Con `restart: unless-stopped`, eso supone unos segundos de corte y que los oyentes reconecten, en
   vez de perder solo un deck. Son las mismas librerías que usa ffmpeg, hay 21 archivos verificados,
   y los fallos al abrir caen a ffmpeg por pista. Mitigación inmediata: `USE_NATIVE_DECODE=false`.
2. **Bloqueo al abrir pista:** 7–56 ms síncronos por canción en el event loop. No afecta al audio:
   los encoders y los oyentes tienen buffer.
3. **La versión de Bun del builder no está fijada** (`FROM oven/bun:alpine`). El decode nativo se
   desactiva solo por debajo de Bun 1.3, pero conviene fijar `oven/bun:1.4.5-alpine` para que el
   binario sea reproducible. No lo he cambiado.
4. **`MP3_ON_DEMAND`:** en un despertar en frío con una oleada de oyentes `/mp3`, el TTFB p99 sube a
   ~0,5 s y se gastan ~1,3 s de CPU. En Bloom, en 35 días no ha habido ningún oyente mp3.
5. **`SRT_ON_DEMAND`:** +0,3 s para entrar en directo. Depende de que el emisor reintente el
   handshake (libsrt y OBS lo hacen); probarlo una vez con el OBS real.
6. **`ENCODER_BATCH_MS`:** +≤100 ms de latencia y los slots del prebuffer mp3 pasan a ~100 ms. Los
   bytes de salida son los mismos.

**Recomendación:** desplegar en dos pasos. El **A** (defaults) ya cambia el decode de los decks y
debe escucharse unas horas, mirando `radio_deck_decodes_total`, `radio_crossfades_total` y el aire
muerto. Si todo va bien, el **B** activa `MP3_ON_DEMAND` y `SRT_ON_DEMAND`, que es donde está la
mayor parte del ahorro (~11 % → ~3,5 % de un núcleo), con una prueba real de OBS por SRT.
