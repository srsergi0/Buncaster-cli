# 🎙️ BunRadio

**Tu radio en un solo binario. Sin Node, sin npm.**

Servidor de radio profesional built con **Bun** y **FFmpeg**. Acepta streaming en vivo desde OBS Studio via SRT, genera streams MP3 + Opus continuos y gapless para oyentes, con sistema de fallback musical opcional (live-only sin carpeta).

---

## ⚡ Empieza en 3 segundos

### Opción 1: Instalador automático (recomendado)

```bash
curl -fsSL https://raw.githubusercontent.com/srsergi0/Buncaster/main/install.sh | bash
source ~/.bashrc
bunradio
```

### Opción 2: Docker

```bash
docker run -p 8080:8080 -p 1936:1936/udp -v ./musica:/app/musica ghcr.io/srsergi0/buncaster:latest
# sin música (live-only, silencio hasta vivo):
docker run -p 8080:8080 -p 1936:1936/udp -e FALLBACK_SOURCE="" ghcr.io/srsergi0/buncaster:latest
```

### Opción 3: Desde código fuente

```bash
bun install
bun run start
```

### Opción 4: Termux (Android)

Ver [TERMUX.md](TERMUX.md) para instrucciones detalladas.

---

## 🎯 Zero Config

BunRadio funciona **sin configuración**. Ejecuta el binario y:

| Aspecto | Comportamiento automático |
|---------|---------------------------|
| **Puerto HTTP** | 8080 (o el siguiente disponible) |
| **Puerto SRT** | 1936/udp (o el siguiente disponible) |
| **Stream Key** | Se genera automáticamente (ej: `a1b2c3d4e5f6...`) |
| **Música fallback** | Directorio donde se ejecuta el binario, o silencio si no hay audios / `FALLBACK_SOURCE=""` (live-only) |
| **Procesamiento de audio** | Desactivado por defecto (`AUDIO_PROCESSING=false`, passthrough) |
| **Crossfade** | 1s entre canciones, 0.2s al entrar vivo (low-latency) |
| **Tier Opus** | `mp3 320k` + `opus 96k` (`/stream?format=opus`) |

### Formato de stream

BunRadio emite **dual-tier**: `mp3 320k` (compat) + `opus 96k` (eco, ~10× eficiencia). El cliente elige:

```bash
http://localhost:8080/stream              # mp3 320k
http://localhost:8080/stream?format=opus  # opus 96k
```

Desactivar opus: `ENABLE_OPUS_TIER=false`.

Docker:
```bash
docker run -e ENABLE_OPUS_TIER=false -p 8080:8080 -p 1936:1936/udp \
  -v ./musica:/app/musica ghcr.io/srsergi0/buncaster:latest
```

### Configuración opcional

Solo edita lo que quieras cambiar via variables de entorno o archivo `.env`:

```bash
# Ejemplo: cambiar puerto
PORT=9090
```

Ver `.env.example` para todas las opciones.

---

## 📡 OBS Studio (SRT — sin plan B)

1. Abre **OBS Studio**
2. Ve a **Settings** → **Stream**
3. **Service**: `Custom...`
4. **Server**: `srt://localhost:1936?streamid=live/TU_STREAM_KEY`
5. **Stream Key**: (la que aparece en la consola al iniciar, va dentro de `streamid`)
6. Click **"Start Streaming"**

> Alternativa FFmpeg: `ffmpeg -re -i input.mp3 -c:a libmp3lame -b:a 320k -f mpegts "srt://localhost:1936?streamid=live/TU_KEY"`

---

## 🔌 API REST

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `GET /stream` | GET | Stream MP3 320k (`?format=opus` → Opus 96k) |
| `GET /health` | GET | Health check con diagnósticos |
| `GET /status` | GET | Estado de la estación (JSON) |
| `GET /metrics` | GET | Métricas Prometheus |

---

## 🏥 Health Check

El endpoint `/health` retorna diagnósticos completos:

```json
{
  "status": "ok",
  "uptime": 120,
  "memory": { "rss": 72, "heapTotal": 2, "heapUsed": 42, "external": 41 },
  "processes": { "masterEncoder": false, "rtmpSource": true },
  "broadcasting": false,
  "fallback": { "active": true, "currentTrack": "I'm on My Way" },
  "listeners": 0
}
```

Docker incluye `HEALTHCHECK` automático cada 30 segundos.

---

## 🔒 Seguridad

El **stream key** (que aparece en la consola al iniciar) se usa como token de autenticación para las rutas protegidas. Pásalo como `Bearer` token:

| Ruta | Método | Protección |
|------|--------|------------|
| `/mcp` | POST | Stream key (Bearer) |
| `/stream` | GET | Abierto |
| `/health` | GET | Abierto |
| `/status` | GET | Abierto |
| `/metrics` | GET | Abierto |

---

## 🤖 MCP Integration (AI Assistants)

BunRadio incluye un servidor MCP para controlar la radio desde Claude Desktop, Cursor, o Windsurf.

### Configuración

```json
{
  "mcpServers": {
    "bunradio": {
      "url": "http://localhost:8080/mcp",
      "headers": {
        "Authorization": "Bearer TU_STREAM_KEY"
      }
    }
  }
}
```

### Herramientas disponibles

- `get_status` - Estado de la radio
- `get_queue` - Cola de reproducción
- `push_to_queue` - Agregar pista
- `skip_track` - Saltar pista
- `shuffle_playlist` - Re-shuffle
- `toggle_fallback` - Pausar/reanudar
- Y más...

---

## 📜 Licencia

[MIT](LICENSE)
