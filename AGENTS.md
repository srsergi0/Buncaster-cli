# Buncaster (BunRadio)

Radio por internet: ingesta RTMP (OBS) + transcodificación nativa (LAME-FFI + decode libavcodec FFI) + streaming HTTP. Cero procesos ffmpeg en reproducción.

## Puertos

| Puerto | Uso |
|---|---|
| 4321 | HTTP: stream (`/stream`, `/radiobloom.mp3`, `/radio.mp3`, `/stream.mp3`, `/`), panel `/admin`, API `/admin/api/*`, `/health`, `/status` |
| 1935 | RTMP de ingesta (OBS) |

## Variables de entorno clave

- `PORT`, `RTMP_PORT`, `MAX_LISTENERS`, `PREBUFFER_BYTES` (1.5MB para arranque instantáneo)
- `STREAM_BITRATE_KBPS`, `AUDIO_PROCESSING`, `CROSSFADE_SECONDS`, `FALLBACK_SOURCE`
- `USE_NATIVE_LAME=auto` (encoder MP3 in-process), `USE_NATIVE_DECODE=auto` (decode in-process)
- `ADMIN_USER`/`ADMIN_PASSWORD` (panel), `CORS_ORIGIN`
- `RTMP_MIN_LIVE_SECONDS` (segundos de audio sostenido antes de pasar a "en vivo")

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
- RSS saludable ~90-110MB; 0 procesos ffmpeg de decks (solo la fuente RTMP en live)
- Logs de arranque: `[NativeDecoder] libavformat 60 cargada` + `[Master Encoder] Modo nativo activo`

## Workflow de release

1. `git push origin main` → CI Build (push)
2. `gh workflow run docker-publish.yml` → Build and Push Docker Image → `ghcr.io/srsergi0/buncaster:latest`
3. `docker pull` + recrear contenedor + **reconectar red** (arriba)
