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
bun run dev -- -y              # Inicia inmediatamente sin preguntas
# o con el asistente interactivo:
bun run dev
```

### Opción 4: Termux (Android)

Ver [docs/TERMUX.md](docs/TERMUX.md) para instrucciones detalladas. Documentación técnica adicional en [docs/](docs/).

---

## 🎯 Zero Config y Opciones CLI

BunRadio funciona **sin configuración** o con flags directas para entornos desatendidos:

```bash
# Flags disponibles en CLI:
bun run dev -- -y                      # Modo no-interactivo (usa env o defaults)
bun run dev -- -p 8080 -s 1936 -y      # Asigna puertos web y SRT directamente
bun run dev -- --help                  # Muestra todas las opciones
```

| Aspecto | Comportamiento automático | Variable de entorno | Flag CLI |
|---------|---------------------------|---------------------|----------|
| **Puerto Web / Dashboard** | 8080 (o siguiente libre) | `PORT` / `DASHBOARD_PORT` | `-p`, `-d`, `--dashboard-port` |
| **Puerto Streams (/mp3, /opus)**| Igual a Dashboard | `OUTPUT_PORT` / `STREAM_PORT` | `-p`, `-o`, `--output-port` |
| **Puerto Ingesta SRT (OBS)** | 1936/udp (o siguiente) | `SRT_PORT` | `-s`, `--srt-port` |
| **Modo No-Interactivo** | Desactivado (pregunta) | `NO_PROMPT=true` | `-y`, `--yes`, `--no-prompt` |
| **Stream Key** | Generada automáticamente | `RTMP_STREAM_KEY` | - |
| **Música fallback** | Silencio si no hay audios | `FALLBACK_SOURCE` | - |
| **Tier Opus** | Activado (`mp3 320k` + `opus 96k`) | `ENABLE_OPUS_TIER=true` | - |

### Formato de stream

BunRadio emite **dual-tier** en tiempo real: `mp3 320k` (compatibilidad universal) + `opus 96k` (eficiencia extrema). Rutas directas:

```bash
http://localhost:8080/mp3                 # Stream MP3 directo
http://localhost:8080/opus                # Stream Opus directo
http://localhost:8080/stream              # Stream predeterminado
http://localhost:8080/stream?format=opus  # Selector por query param
```

---

## 📡 OBS Studio (Ingesta SRT en Directo)

1. Abre **OBS Studio** → **Ajustes** → **Emisión**
2. **Servicio**: `Personalizado...` (*Custom...*)
3. **Servidor**: 
   ```text
   srt://127.0.0.1:1936?streamid=live/TU_STREAM_KEY
   ```
   *(Importante: usa `127.0.0.1` en Windows en vez de `localhost` para evitar problemas de resolución IPv6).*
4. **Clave de retransmisión** (*Stream Key*): **DEJAR EN BLANCO** (el ID ya viaja dentro del parámetro `?streamid`).
5. Clic en **"Iniciar Transmisión"**.

---

## 🔌 API REST y Gestión de Colas

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/stream` (o `/mp3`, `/opus`) | GET | Abierto | Emisión de audio en vivo continuo |
| `/health` | GET | Abierto | Chequeo de salud verídico, uso de RAM y diagnósticos |
| `/status` | GET | Abierto | Estado en tiempo real de la estación (JSON) |
| `/metrics` | GET | Abierto | Métricas en formato Prometheus |
| `/api/queue` | GET | Admin | Lista actual de pistas en la cola de reproducción |
| `/api/queue/add` | POST | Admin | Añade una pista a la cola (`{"file": "musica/tema.mp3"}`) |
| `/api/queue/remove` | POST | Admin | Elimina una pista por índice o archivo (`{"index": 0}`) |
| `/api/queue/move` | POST | Admin | Reordena una pista en la cola (`{"from": 2, "to": 0}`) |
| `/api/queue/clear` | POST | Admin | Vacía toda la cola de reproducción |
| `/api/skip` | POST | Admin | Salta la canción actual de fallback |
| `/api/fallback` | POST | Admin | Cambia la carpeta de música (`{"folder": "musica/rock"}`) |
| `/api/stop` | POST | Admin | Apagado ordenado del servidor (*graceful shutdown*) |

---

## 🔒 Seguridad y Control de Acceso

Las rutas de control (`/api/*`, `/admin/api/*`, `/mcp`) están protegidas mediante:
- **HTTP Basic Auth**: Credenciales configurables en `.env` (`ADMIN_USER`, `ADMIN_PASSWORD`).
- **Bearer Token**: Cabecera `Authorization: Bearer <TU_STREAM_KEY>`.

---

## 🤖 Integración MCP (Asistentes de IA)

BunRadio incluye un servidor MCP para controlar la radio desde Claude Desktop, Cursor o Windsurf:

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

Herramientas MCP incluidas: `get_status`, `get_queue`, `push_to_queue`, `remove_from_queue`, `clear_queue`, `move_in_queue`, `skip_track`.

---

## 📚 Documentación Técnica Detallada

En la carpeta [`docs/`](docs/) encontrarás análisis a fondo:
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md): Rendimiento de memoria, Ring Buffer y benchmarks.
- [docs/SRC2.md](docs/SRC2.md) y [docs/IMPLEMENTACION.md](docs/IMPLEMENTACION.md): Auditoría de arquitectura y motores FFI.
- [docs/RELAY-EXPLAINER.md](docs/RELAY-EXPLAINER.md): Arquitectura de escala mediante relays y CDN.

---

## 📜 Licencia

[MIT](LICENSE)
