# Buncaster (BunRadio)

Radio por internet: ingesta RTMP (OBS) + transcodificación nativa (LAME-FFI + decode libavcodec FFI) + streaming HTTP. Cero procesos ffmpeg en reproducción.

## Puertos

| Puerto | Uso |
|---|---|
| 4321 | HTTP: stream (`/stream`, `/radiobloom.mp3`, `/radio.mp3`, `/stream.mp3`, `/`), panel `/admin`, API `/admin/api/*`, `/health`, `/status` |
| 1935 | RTMP de ingesta (OBS) |

## Variables de entorno clave

- `PORT`, `RTMP_PORT`, `MAX_LISTENERS`, `PREBUFFER_BYTES` (1.5MB para arranque instantáneo)
- `STREAM_BITRATE_KBPS`, `CROSSFADE_SECONDS`, `FALLBACK_SOURCE`
- `USE_NATIVE_LAME=auto` (encoder MP3 in-process), `USE_NATIVE_DECODE=auto` (decode in-process)
- `ADMIN_USER`/`ADMIN_PASSWORD` (panel), `CORS_ORIGIN`
- `RTMP_MIN_LIVE_SECONDS` (segundos de audio sostenido antes de pasar a "en vivo")

### Motor (mesa redonda Bloom 2.0 — ver `docs/ENGINE-ROUNDTABLE.md`)

| Variable | Default | Qué hace |
|---|---|---|
| `PREBUFFER_SECONDS` | `0` (usa `PREBUFFER_BYTES`) | Prebuffer en segundos por tier. Con `PREBUFFER_BYTES=1572864` un oyente opus 192k entra **~65 s** detrás del directo (mp3 320k: ~39 s). Recomendado: `10`. |
| `LOUDNESS_NORMALIZATION` | `false` | Ganancia estática por pista hacia `LOUDNESS_TARGET_LUFS` (-16) con techo `LOUDNESS_TRUE_PEAK_DBTP` (-1) y `LOUDNESS_MAX_GAIN_DB` (12). Medición BS.1770 cacheada en `ANALYSIS_CACHE_FILE`. |
| `SMART_TRANSITIONS` | `false` | Salta silencio inicial y cruza donde empieza el silencio final (`SILENCE_THRESHOLD_DB`, -50). |
| `ANALYSIS_PRESCAN` | `true` | Con análisis activo, analiza toda la carpeta en segundo plano (nice, 1 hilo). ~2-3 s de CPU por pista, una sola vez. |
| `CROSSFADE_SAMPLE_CLOCK` | `true` | Crossfade por muestras + relevo de deck sin pérdidas (antes el crossfade de 2 s duraba 0.2-0.3 s). `false` = comportamiento anterior. |
| `DECK_FFLAGS_NOBUFFER` | `false` | `true` = comportamiento anterior (recorta ~1.2 s al inicio de cada MP3). |
| `FALLBACK_STALL_SECONDS` | `5` | Salta de pista si el encoder lleva N s sin PCM fuera de directo (deck colgado). `0` = off. |
| `ENCODER_SUPERVISION` | `true` | Reinicio con backoff del encoder opus si muere o se cuelga (10 s sin páginas). |

### Eficiencia "Bun way" (ver `docs/ENGINE-BUN-WAY.md`)

| Variable | Default | Qué hace |
|---|---|---|
| `ENCODER_BATCH_MS` | `100` | PCM a LAME/ffmpeg-opus en bloques de 100 ms. Mismos bytes de salida (verificado); ~4× menos syscalls y envíos por oyente mp3. `0` = antes. |
| `USE_NATIVE_DECODE` | `auto` | Decks decodificados en proceso (libavcodec FFI): sin `ffmpeg -re` por canción. Solo libavformat 60 + Bun ≥ 1.3. `false` = ffmpeg CLI. |
| `MP3_ON_DEMAND` | `false` | Sin oyentes `/mp3` 30 s → LAME en reposo (en Bloom el mp3 tiene 0 bytes servidos en 35 días). Recomendado `true` en Bloom. |
| `SRT_ON_DEMAND` | `false` | Sin ffmpeg SRT en reposo; un socket UDP de Bun lo lanza al primer paquete (+0,3 s para entrar en directo). Recomendado `true` en Bloom. |

Notas verificadas (nov-2026): las rutas de stream servidas son solo `/mp3` y `/opus` (el publisher usa `OPUS_UPSTREAM_URL=http://buncaster:4321/opus`); desde ENGINE-BUN-WAY los decks **sí** usan `NativeDecoder` con `USE_NATIVE_DECODE=auto` (comprobar `radio_deck_decodes_total{engine="native"}` en `/metrics`; antes, desde `e44120e`, eran siempre procesos `ffmpeg -re`); `/health` pasa a `degraded` si hay >2 s de aire muerto. No hay endpoint SSE: `src/events.ts` es solo el catálogo de nombres de evento del log.

## Despliegue en producción
## Despliegue en producción

El contenedor `buncaster` **lo gestiona el docker-compose de bloom** (`/root/projects/bloom/docker-compose.yml`, servicio `buncaster`). NO crear el contenedor con `docker run`: la red `bloom_default` y el env se asignan solos por compose, y el publisher de bloom (contenedor `bloom-publisher-1`, puerto 9876) consume `http://buncaster:4321/stream` por hostname docker.

**Para recrear tras un `docker pull`:**

```bash
docker rm -f buncaster
cd /root/projects/bloom && docker compose up -d buncaster
```

El `.env` de bloom debe contener (clave para el arranque rápido y el decode nativo):
`PREBUFFER_BYTES=1572864` y `USE_NATIVE_DECODE=auto` (además de PORT=4321, RTMP_PORT=1935, FALLBACK_SOURCE=music/songs).

**Síntoma si el buncaster queda fuera de `bloom_default`:** el publisher no lo resuelve → su fallback sirve frames MP3 de silencio (el player avanza pero no se escucha nada). Log del publisher: `Upstream connection failed: Unable to connect`. Si pasa, reconectar a mano: `docker network connect bloom_default buncaster`.

## URL públicas

- Directo: `http://185.139.1.222:4321/radiobloom.mp3`
- Tuneada (vía cloudflared → publisher de bloom): `https://radio-bloom.taptapp.xyz/radiobloom.mp3`

## Verificación

- `curl -s http://localhost:4321/health` → `{"status":"ok",...}`
- RSS saludable ~90-110MB; 0 procesos ffmpeg de decks (solo el encoder opus y, en live, la fuente SRT)
- Logs de arranque: `(native.decode.loaded) libavformat 60 cargada` + `(native.decode.loaded) Decks con decode nativo` + `Encoder master nativo LAME-FFI`
- `/metrics`: `radio_deck_decodes_total{engine="native"}` crece y `{engine="ffmpeg"}` se queda en 0

## Workflow de release

1. `git push origin main` → CI Build (push)
2. `gh workflow run docker-publish.yml` → Build and Push Docker Image → `ghcr.io/srsergi0/buncaster:latest`
3. `docker pull` + recrear contenedor + **reconectar red** (arriba)
