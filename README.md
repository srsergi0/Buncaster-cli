# 🎙️ BunRadio

**Tu radio en un solo binario. Sin Node, sin npm.**

Servidor de radio profesional built con **Bun** y **FFmpeg**. Acepta streaming en vivo desde OBS Studio via RTMP, genera una stream MP3 continua y gapless para oyentes, con sistema de fallback musical.

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
docker run -p 8080:8080 -p 1935:1935 -v ./musica:/app/musica ghcr.io/srsergi0/buncaster:latest
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
| **Puerto RTMP** | 1935 (o el siguiente disponible) |
| **Stream Key** | Se genera automáticamente (ej: `a1b2c3d4e5f6...`) |
| **Música fallback** | Directorio donde se ejecuta el binario |
| **Procesamiento de audio** | Activado por defecto (limiter + compressor) |
| **Crossfade** | 2 segundos entre canciones |

### Formato de stream

BunRadio soporta múltiples formatos de audio. Cambia con una sola variable:

```bash
STREAM_FORMAT=ogg    # OGG Vorbis
STREAM_FORMAT=aac    # AAC
STREAM_FORMAT=opus   # Opus (mejor codec moderno)
STREAM_FORMAT=flac   # FLAC lossless
STREAM_FORMAT=mp3    # MP3 (default, máxima compatibilidad)
```

Docker:
```bash
docker run -e STREAM_FORMAT=ogg -p 8080:8080 -p 1935:1935 \
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

## 📡 OBS Studio

1. Abre **OBS Studio**
2. Ve a **Settings** → **Stream**
3. **Service**: `Custom...`
4. **Server**: `rtmp://localhost:1935/live`
5. **Stream Key**: (la que aparece en la consola al iniciar)
6. Click **"Start Streaming"**

---

## 🔌 API REST

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `GET /stream` | GET | Stream de audio MP3 |
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
