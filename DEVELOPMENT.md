# 🔨 Desarrollo de BunRadio

## Build para todas las plataformas

Compila binarios para Linux, Windows y macOS:

```bash
# Con Docker (cross-compile para todas las plataformas)
bash build.sh

# Solo para tu plataforma
bun run build
```

### Output

| Plataforma | Archivo | Tamaño |
|------------|---------|--------|
| Linux x64 | `bunradio-linux-x64` | ~87 MB |
| Linux ARM64 | `bunradio-linux-arm64` | ~85 MB |
| macOS Intel | `bunradio-macos-x64` | ~66 MB |
| macOS Apple Silicon | `bunradio-macos-arm64` | ~61 MB |
| Windows x64 | `bunradio-windows-x64.exe` | ~94 MB |

---

## Estructura del proyecto

```
bunradio/
├── src/
│   ├── index-rtmp.ts      # Entry point
│   ├── config.ts           # Configuración (todo opcional)
│   ├── audio-router.ts     # Motor de audio principal
│   ├── broadcaster.ts      # Fan-out a oyentes
│   ├── pre-buffer.ts       # Buffer para conexión instantánea
│   ├── dsp.ts              # Cadena de procesamiento de audio
│   ├── lame-ffi.ts         # Encoder MP3 nativo via FFI
│   ├── http-server.ts      # Servidor HTTP + API
│   ├── http-helpers.ts     # Utilidades HTTP
│   ├── mcp-server.ts       # Servidor MCP para IA
│   └── logger.ts           # Sistema de logging
├── musica/                 # Carpeta de música fallback
├── build.sh               # Script de build multi-plataforma
├── install.sh             # Instalador automático
├── Dockerfile             # Build multi-stage para Docker
└── docker-compose.yml     # Configuración Docker Compose
```
