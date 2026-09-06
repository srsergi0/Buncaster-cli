# 🎛️ BunRadio as API

## La idea en una línea

BunRadio no es un servidor de radio. BunRadio es **un sistema operativo para audio en tiempo real** donde cada funcionalidad es una API que los desarrolladores pueden componer como piezas de Lego.

---

## ¿Qué problema resuelve?

Hoy, construir una radio online requiere ensamblar 5+ herramientas diferentes:

- Icecast o Shoutcast para servir el stream
- Liquidsoap o RadioDJ para el AutoDJ y scheduling
- Una GUI (AzuraCast) para manejar todo
- Un servicio de texto-a-voz si quieres un locutor
- Otro servicio para transcodificar formatos
- Otro para analytics

Cada pieza habla protocolos diferentes, se configura distinto, y escala por separado.

**BunRadio como API** reduce eso a: `curl https://api.bunradio.io/station/new`

---

## Bloques fundamentales

Cada bloque es una API individual, documentada, versionada, y componible:

```
BunRadio API
├── /audio     →  Procesamiento de audio
├── /stream    →  Stream en tiempo real
├── /schedule  →  Programación y scheduling
├── /voice     →  Locutor AI (TTS)
├── /mix       →  Mezcla y transiciones
├── /station   →  Gestión de estaciones
├── /analytics →  Métricas y datos
└── /identity  →  Perfiles de oyente
```

---

## 1. API de Audio — `/audio`

Procesamiento de audio crudo como microservicio.

```bash
# Subir un archivo y obtener metadatos
curl -X POST https://api.bunradio.io/audio/analyze \
  -F "file=@tema.mp3"
→ { "duration": 243, "bpm": 128, "key": "C#m", "loudness": -14.2, "replaygain": -2.1 }

# Normalizar volumen
curl -X POST https://api.bunradio.io/audio/normalize \
  -F "file=@tema.mp3" \
  -F "target_loudness=-16"
→ (binary: archivo normalizado)

# Transcodificar formato
curl -X POST https://api.bunradio.io/audio/transcode \
  -F "file=@tema.flac" \
  -F "format=mp3" \
  -F "bitrate=128"
→ (binary: archivo MP3)

# Detectar silencios/cortes
curl -X POST https://api.bunradio.io/audio/detect-silence \
  -F "file=@tema.mp3"
→ { "silences": [{ "start": 0.5, "end": 1.2 }, { "start": 120.0, "end": 120.5 }] }
```

---

## 2. API de Stream — `/stream`

Distribución de audio en tiempo real como servicio.

```bash
# Crear un stream (RTMP endpoint para OBS)
curl -X POST https://api.bunradio.io/stream/create \
  -H "Authorization: Bearer $API_KEY"
→ {
    "id": "str_abc123",
    "rtmp_url": "rtmp://bunradio.io/live/str_abc123",
    "stream_key": "a1b2c3d4e5f6",
    "listen_url": "https://bunradio.io/stream/str_abc123.mp3",
    "formats": ["mp3", "ogg", "aac"]
  }

# Agregar formato adicional
curl -X POST https://api.bunradio.io/stream/str_abc123/formats \
  -H "Authorization: Bearer $API_KEY" \
  -d '{ "format": "opus", "bitrate": 64 }'

# Obtener oyentes activos
curl -X GET https://api.bunradio.io/stream/str_abc123/listeners
→ { "active": 47, "peak_today": 89, "total_served": 12340 }

# Webhook: cuando un oyente conecta/desconecta
# POST /webhooks/listener → BunRadio llama a tu URL
```

---

## 3. API de Música — `/music`

Gestión de la librería musical.

```bash
# Subir música a tu librería
curl -X POST https://api.bunradio.io/music/upload \
  -H "Authorization: Bearer $API_KEY" \
  -F "files=@tema1.mp3" \
  -F "files=@tema2.flac"
→ { "imported": 2, "failed": 0, "ids": ["mus_001", "mus_002"] }

# Buscar canciones
curl -X GET 'https://api.bunradio.io/music/search?q=rock+1990&limit=20'
→ {
    "results": [
      { "id": "mus_001", "title": "...", "artist": "...", "bpm": 120, "energy": 0.85 }
    ]
  }

# Analizar y etiquetar automáticamente
curl -X POST https://api.bunradio.io/music/mus_001/analyze
→ { "genre": "rock", "mood": "energetic", "era": "1990s" }

# Crear playlist inteligente por reglas
curl -X POST https://api.bunradio.io/music/playlist \
  -d '{
    "name": "Rock matutino",
    "rules": {
      "genre": "rock",
      "max_bpm": 130,
      "not_played_in_hours": 4,
      "limit": 100
    }
  }'
```

---

## 4. API de Voz / Locutor — `/voice`

Texto-a-voz integrado para crear un locutor de radio automático.

```bash
# Configurar un locutor
curl -X POST https://api.bunradio.io/voice/personality \
  -d '{
    "name": "Alex",
    "voice": "echo",           # elevenlabs / openai / custom
    "language": "es-ES",
    "style": "energetic",
    "catchphrases": [
      "¡Y esto es BunRadio!",
      "Arriba esa energía"
    ]
  }'
→ { "id": "vp_001" }

# Generar un segmento de locutor
curl -X POST https://api.bunradio.io/voice/generate \
  -d '{
    "personality_id": "vp_001",
    "script": "A continuación, un clásico de los 90 que nadie puede olvidar."
  }'
→ { "url": "https://cdn.bunradio.io/voice/vp_001/seg_abc.mp3", "duration": 3.2 }

# Programar locución automática
curl -X POST https://api.bunradio.io/voice/schedule \
  -d '{
    "station_id": "str_abc123",
    "rules": {
      "announce_song_title": true,
      "announce_every_n_songs": 3,
      "weather_update": "every_30min",
      "time_announcement": "every_hour"
    }
  }'
```

---

## 5. API de Programación — `/schedule`

Scheduling estilo playlist de radio profesional, como API.

```bash
# Crear un bloque horario
curl -X POST https://api.bunradio.io/schedule/block \
  -d '{
    "station_id": "str_abc123",
    "name": "Rock de los 80",
    "time_range": { "start": "06:00", "end": "10:00", "days": ["mon-fri"] },
    "playlist_id": "pl_rock80s",
    "jingles": { "intro": "jing_001", "every_n_songs": 3 },
    "voice_personality": "vp_001"
  }'

# Programar evento especial
curl -X POST https://api.bunradio.io/schedule/event \
  -d '{
    "station_id": "str_abc123",
    "type": "live_dj",
    "start": "2026-08-01T20:00:00Z",
    "duration_minutes": 120,
    "dj_name": "DJ Sérgio",
    "auto_record": true
  }'

# Vista semanal de programación
curl -X GET https://api.bunradio.io/schedule/str_abc123/week
→ {
    "monday": [{ "06:00": "Rock 80s" }, { "10:00": "Pop Hits" }, ...],
    "tuesday": [...]
  }
```

---

## 6. API de Mezcla / Transiciones — `/mix`

Transiciones profesionales sin configuración.

```bash
# Aplicar crossfade entre dos canciones
curl -X POST https://api.bunradio.io/mix/crossfade \
  -d '{
    "track_a": "mus_001",
    "track_b": "mus_002",
    "duration": 4,
    "style": "power"  // power | smooth | eq_match | harmonic
  }'
→ (binary: archivo mezclado)

# Transición con efecto
curl -X POST https://api.bunradio.io/mix/transition \
  -d '{
    "track_a": "mus_001",
    "track_b": "mus_002",
    "effect": "echo_fade"
  }'

# Mezcla en vivo entre DJ y fallback
curl -X POST https://api.bunradio.io/mix/live-crossfade \
  -d '{
    "live_source": "rtmp://...",
    "fallback_source": "pl_001",
    "duration": 8
  }'
```

---

## 7. API de Estaciones — `/station`

Gestión completa de estaciones.

```bash
# Crear estación (radio completa en una request)
curl -X POST https://api.bunradio.io/station/create \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "name": "Rock Online",
    "genre": "rock",
    "description": "La mejor radio rock 24/7",
    "format": "mp3",
    "bitrate": 128,
    "timezone": "America/Sao_Paulo",
    "playlists": ["pl_rock80s", "pl_rock90s"],
    "voice_personality": "vp_001",
    "auto_schedule": true
  }'
→ { "id": "stn_001", "listen_url": "https://bunradio.io/stream/stn_001.mp3", "admin_token": "..." }

# Clonar estación
curl -X POST https://api.bunradio.io/station/stn_001/clone \
  -d '{ "name": "Rock Online - Low Bitrate", "bitrate": 64 }'

# Exportar configuración
curl -X GET https://api.bunradio.io/station/stn_001/export
→ (ZIP con toda la config: playlists, schedule, voice, DSP)

# Importar configuración
curl -X POST https://api.bunradio.io/station/import \
  -F "config=@mi-radio.zip"
```

---

## 8. API de Analytics — `/analytics`

Datos de oyentes, canciones, y engagement.

```bash
# Oyentes en tiempo real
curl -X GET https://api.bunradio.io/analytics/stn_001/listeners/realtime
→ { "current": 47, "last_5min": [42, 45, 47, 46, 47] }

# Canciones más reproducidas
curl -X GET https://api.bunradio.io/analytics/stn_001/top-tracks?period=week
→ [{ "track": "mus_001", "plays": 42 }, ...]

# Reporte SoundExchange (DMCA compliance)
curl -X GET https://api.bunradio.io/analytics/stn_001/soundexchange?month=2026-07
→ (CSV: track, artist, plays, duration, timestamps)

# Embed público para mostrar "Now Playing"
curl -X GET https://api.bunradio.io/analytics/stn_001/now-playing
→ { "title": "...", "artist": "...", "album_art": "https://...", "listeners": 47 }
```

---

## 9. API de Identidad de Oyente — `/identity`

Perfiles de oyente para personalización real.

```bash
# Registrar oyente (anónimo o con login)
curl -X POST https://api.bunradio.io/identity/listener \
  -d '{ "device_id": "abc123" }'
→ { "id": "lis_001", "token": "..." }

# Historial de lo que escuchó
curl -X GET 'https://api.bunradio.io/identity/lis_001/history?limit=50'
→ [{ "track": "mus_001", "played_at": "2026-07-15T21:00:00Z", "skipped": false }]

# Recomendación personalizada
curl -X GET https://api.bunradio.io/identity/lis_001/recommend
→ [{ "track": "mus_042", "confidence": 0.92 }]

# Perfil de preferencias (automático)
curl -X GET https://api.bunradio.io/identity/lis_001/profile
→ { "favorite_genre": "rock", "peak_hours": "18-22", "skip_rate": 0.05 }
```

---

## 10. Webhooks — `/webhooks`

Eventos que BunRadio dispara hacia tu backend.

```typescript
// Eventos disponibles
type BunRadioEvent =
  | "track.change"      // Cambió la canción
  | "listener.connect"  // Oyente conectó
  | "listener.disconnect" // Oyente desconectó
  | "listener.milestone" // 100, 1000, 10000 oyentes
  | "dj.connect"        // DJ en vivo conectó
  | "dj.disconnect"     // DJ en vivo desconectó
  | "schedule.trigger"  // Se activó un bloque horario
  | "schedule.change"   // Cambió la programación
  | "station.metrics"   // Reporte periódico de métricas
  | "error.critical"    // Error grave
```

---

## Casos de uso imposibles hoy

### Caso 1: Un SaaS de radio white-label

Un emprendedor crea **RadioKit.io** — un servicio donde cualquiera crea su propia estación de radio en 30 segundos.

```
Usuario → Radiokit.io → BunRadio API → Radio emitida
```

Cada estación es una llamada a la API. El emprendedor no toca infraestructura de audio. Solo se enfoca en su UI y captación de clientes. BunRadio maneja el encoding, el streaming, el scheduling, el AI DJ.

**Como Stripe para pagos, BunRadio para radio.**

---

### Caso 2: Radio generada por IA para negocios

Un restaurante quiere música + promociones habladas 24/7.

```bash
curl -X POST https://api.bunradio.io/station/create \
  -d '{
    "name": "Restaurante La Mesa",
    "music_genre": "latin_jazz",
    "voice_personality": {
      "name": "Chef",
      "promos": [
        { "text": "Hoy: 2x1 en margaritas", "every_minutes": 15 }
      ]
    }
  }'
```

La radio genera automáticamente música de fondo + locutor promocionando ofertas. Sin que el dueño haga nada.

---

### Caso 3: Radio efímera para eventos

Un festival de música crea una radio temporal para el evento. 3 días, después se destruye.

```bash
curl -X POST https://api.bunradio.io/station/create \
  -d '{
    "name": "Festival 2026",
    "expires_at": "2026-08-20T23:59:59Z",
    "playlists": ["pl_artists_invited", "pl_hype"],
    "schedule": { /* horario de sets en vivo */ }
  }'
```

Cuando termina el festival, la radio se autodestruye. Zero recursos desperdiciados.

---

## Stack técnico

Cómo se vería esto a nivel de implementación:

```
BunRadio Core (single binary)
└── HTTP API (Bun.serve)
    ├── POST /station/create
    │   └── spawns: AudioRouter + Broadcaster + Schedule
    ├── POST /audio/transcode
    │   └── spawns: ffmpeg process
    ├── POST /voice/generate
    │   └── calls: ElevenLabs / OpenAI TTS API
    ├── POST /mix/crossfade
    │   └── runs: dual-deck mixing internally
    └── POST /schedule/block
        └── runs: cron-like scheduler
```

Cada endpoint es **stateless** (escala horizontalmente) o **stateful** (si maneja un stream activo). Los streams activos se mantienen en memoria. La metadata (playlists, schedule) se persiste en SQLite.

---

## ¿Por qué NADIE más hace esto?

- **Icecast/Liquidsoap** fueron diseñados en 1998-2004. Son herramientas de terminal. No tienen APIs REST.
- **AzuraCast** tiene GUI pero no API-first. Es una app web, no una plataforma.
- **RadioBOSS/SAM** son software de escritorio para Windows. No son APIs.
- **Los servicios cloud** (Triton, Live365, Radio.co) son SaaS cerrados, no una plataforma para developers.

No existe un "Stripe de la radio". BunRadio como API sería el primero.

---

## Lo que BunRadio ya tiene para esto

| Feature actual | Sirve para API |
|----------------|----------------|
| `src/audio-router.ts` | `POST /audio/*` y `POST /mix/*` |
| `src/lame-ffi.ts` | `POST /audio/transcode` (nativo, rápido) |
| `src/dsp.ts` | `POST /audio/normalize` (sin ffmpeg) |
| `src/config.ts` | Multi-estación via `STREAM_FORMAT` |
| `src/icy-metadata.ts` | Stream metadata en API |
| `src/state.ts` | Per-estado de cada estación |
| `src/format-config.ts` | Multi-formato via API param |
| `src/broadcaster.ts` | Fan-out escalable |
| `src/pre-buffer.ts` | Instant-on para nuevos oyentes |

---

## MVP mínimo (30 días)

```
Semana 1: POST /station/create + POST /station/{id}/start
          └── Una estación = un AudioRouter + Broadcaster

Semana 2: POST /music/{id}/upload + GET /music/search
          └── Librería musical con metadatos

Semana 3: POST /schedule + POST /voice/generate
          └── Scheduling + locutor AI básico

Semana 4: GET /analytics + Webhooks
          └── Datos de oyentes + eventos
```

El resultado: **cualquier desarrollador construye una radio completa en 10 líneas de código.**
