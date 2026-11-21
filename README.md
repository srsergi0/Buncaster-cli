# 🎙️ BunRadio

**Your entire internet radio station in a single binary. No Node, no npm.**

Professional broadcast radio server built with **Bun** and **FFmpeg**. Ingests live broadcast streams from OBS Studio via SRT, delivers continuous, gapless MP3 and Opus streams to listeners, and features an automated music fallback and priority queue system.

---

## ⚡ Quick Start in 3 Seconds

### Option 1: Automated Installer (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/srsergi0/Buncaster-cli/main/install.sh | bash
source ~/.bashrc
bunradio
```

### Option 2: Docker

```bash
# With music folder mounted:
docker run -p 8080:8080 -p 1936:1936/udp -v ./musica:/app/musica ghcr.io/srsergi0/buncaster-cli:latest

# Live-only (silence until you go live):
docker run -p 8080:8080 -p 1936:1936/udp -e FALLBACK_SOURCE="" ghcr.io/srsergi0/buncaster-cli:latest
```

### Option 3: From Source

```bash
bun install

# Start immediately without prompts (uses env or defaults):
bun run dev -- -y

# Or launch with the interactive setup wizard:
bun run dev
```

### Option 4: Termux (Android)

See [docs/TERMUX.md](docs/TERMUX.md) for detailed instructions. Additional architectural documentation is available in [docs/](docs/).

---

## 🎯 Zero Config & CLI Options

BunRadio runs **zero-config** out of the box, or accepts CLI flags for unattended/headless production deployments:

```bash
# CLI Flags:
bun run dev -- -y                      # Non-interactive mode (uses env or defaults)
bun run dev -- -p 8080 -s 1936 -y      # Explicit web and SRT ports
bun run dev -- --help                  # Display all CLI flags and help
```

| Aspect | Default Behavior | Environment Variable | CLI Flag |
|--------|------------------|----------------------|----------|
| **Web / Dashboard Port** | 8080 (or next free port) | `PORT` / `DASHBOARD_PORT` | `-p`, `-d`, `--dashboard-port` |
| **Streams Port (/mp3, /opus)** | Same as Dashboard | `OUTPUT_PORT` / `STREAM_PORT` | `-p`, `-o`, `--output-port` |
| **OBS Ingest Port (SRT)** | 1936/udp (or next free) | `SRT_PORT` | `-s`, `--srt-port` |
| **Non-Interactive Mode** | Disabled (interactive) | `NO_PROMPT=true` | `-y`, `--yes`, `--no-prompt` |
| **Stream Key** | Auto-generated hex string | `RTMP_STREAM_KEY` | - |
| **Music Fallback Source** | Current directory (or silence) | `FALLBACK_SOURCE` | - |
| **Opus Tier** | Enabled (`mp3 320k` + `opus 96k`) | `ENABLE_OPUS_TIER=true` | - |

### Stream Endpoints

BunRadio broadcasts in real-time **dual-tier**: `mp3 320k` (universal compatibility) + `opus 96k` (high-fidelity extreme efficiency). Direct URLs:

```bash
http://localhost:8080/mp3                 # Direct MP3 320k stream
http://localhost:8080/opus                # Direct Opus 96k stream
http://localhost:8080/stream              # Default stream
http://localhost:8080/stream?format=opus  # Query parameter selector
```

---

## 🎛️ Engine tuning (Bloom 2.0 roundtable)

Measured rationale for every flag: [docs/ENGINE-ROUNDTABLE.md](docs/ENGINE-ROUNDTABLE.md).

| Variable | Default | Effect |
|----------|---------|--------|
| `PREBUFFER_SECONDS` | `0` (off → `PREBUFFER_BYTES`) | Join burst measured in **seconds of audio per tier** (`seconds × tier kbps × 125` bytes). `10` ≈ 10 s behind live instead of ~65 s (opus 192k) with `PREBUFFER_BYTES=1572864`. |
| `LOUDNESS_NORMALIZATION` | `false` | Per-track static gain toward `LOUDNESS_TARGET_LUFS` (ITU-R BS.1770 / EBU R128 measurement, cached). No compression/limiting. |
| `LOUDNESS_TARGET_LUFS` | `-16` | Integrated loudness target. |
| `LOUDNESS_TRUE_PEAK_DBTP` | `-1` | Gain is capped so the track's true peak stays at or below this ceiling. |
| `LOUDNESS_MAX_GAIN_DB` | `12` | Maximum positive gain (quiet tracks / TTS). |
| `SMART_TRANSITIONS` | `false` | Skips leading digital silence and starts the crossfade where the trailing silence begins (same analysis pass). |
| `SILENCE_THRESHOLD_DB` | `-50` | Silence threshold for `SMART_TRANSITIONS`. |
| `ANALYSIS_PRESCAN` | `true` | With loudness/smart enabled, analyse the whole fallback folder in the background (`nice`, 1 thread, one file at a time). |
| `ANALYSIS_CACHE_FILE` | `.analysis-cache.json` | Analysis cache (path + mtime). Mount it on a volume to keep it across container recreations. |
| `CROSSFADE_SAMPLE_CLOCK` | `true` | Crossfade timed by samples (not wall clock) + lossless deck handover. `false` restores the old behaviour. |
| `DECK_FFLAGS_NOBUFFER` | `false` | `true` restores the old `-fflags nobuffer` on deck ffmpeg (which drops ~1.2 s at the start of every MP3). |
| `FALLBACK_STALL_SECONDS` | `5` | Skip to the next track if no PCM reached the encoder for N s while not live (hung deck). `0` disables. |
| `ENCODER_SUPERVISION` | `true` | Restart the Opus encoder with exponential backoff (1 s → 30 s) if it dies or stops emitting pages for 10 s. |

New observability: `/status` and `/health` include an `engine` block (current track loudness/gain, prebuffer seconds per tier, join backlog, dead air, crossfade results, encoder restarts). `/metrics` adds `radio_dead_air_seconds_total`, `radio_digital_silence_seconds_total`, `radio_fallback_stall_restarts_total`, `radio_opus_encoder_restarts_total`, `radio_crossfades_total{result}`, `radio_prebuffer_seconds{tier}`, `radio_listener_join_backlog_seconds_*`, `radio_audio_clock_drift_seconds`.

---

## 📡 OBS Studio (Live SRT Ingestion)

1. Open **OBS Studio** → **Settings** → **Stream**
2. **Service**: `Custom...`
3. **Server**: 
   ```text
   srt://127.0.0.1:1936?streamid=live/YOUR_STREAM_KEY
   ```
   *(Important: use `127.0.0.1` on Windows instead of `localhost` to avoid IPv6 loopback resolution timeout).*
4. **Stream Key**: **LEAVE COMPLETELY BLANK** (the ID is already embedded in the `?streamid` URL parameter).
5. Click **"Start Streaming"**.

---

## 🔌 REST API & Queue Management

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/stream` (or `/mp3`, `/opus`) | GET | Public | Continuous live audio stream |
| `/api/now-playing` | GET | Public | Current track metadata, artist, title, progress & duration |
| `/health` | GET | Public | Health check with RAM usage, process state, and diagnostics |
| `/status` | GET | Public | Real-time station metrics (JSON) |
| `/metrics` | GET | Public | Prometheus-compatible metrics |
| `/api/queue` | GET | Admin | Retrieve current ordered playback queue |
| `/api/queue/add` | POST | Admin | Enqueue track (`{"file": "musica/track.mp3"}`) |
| `/api/queue/remove` | POST | Admin | Remove track by index or filename (`{"index": 0}`) |
| `/api/queue/move` | POST | Admin | Reorder track in queue (`{"from": 2, "to": 0}`) |
| `/api/queue/clear` | POST | Admin | Clear entire playback queue |
| `/api/skip` | POST | Admin | Skip current playing track |
| `/api/fallback` | POST | Admin | Change music directory (`{"folder": "musica/rock"}`) |
| `/api/stop` | POST | Admin | Graceful server shutdown |

---

## 🏥 Health Check & Observability

The `/health` endpoint exposes truthful runtime diagnostics:

```json
{
  "status": "ok",
  "uptime": 120,
  "memory": { "rss": 85, "heapTotal": 4, "heapUsed": 38, "external": 42 },
  "processes": { "masterEncoder": true, "opusTier": true, "rtmpSource": true },
  "broadcasting": false,
  "sourceConnected": false,
  "fallback": {
    "active": true,
    "paused": false,
    "currentTrack": "Artist - Song Title",
    "queue": []
  },
  "listeners": 0,
  "listenersMp3": 0,
  "listenersOpus": 0,
  "maxListeners": 500,
  "audio": {
    "clockSamples": 5760000,
    "samplesProduced": 5760000,
    "underruns": 0
  }
}
```

Docker includes an automated `HEALTHCHECK` running every 30 seconds.

---

## 🔒 Security & Access Control

Control and mutation routes (`/api/*`, `/admin/api/*`, `/mcp`) are secured via:
- **HTTP Basic Auth**: Configured via `.env` credentials (`ADMIN_USER`, `ADMIN_PASSWORD`).
- **Bearer Token**: `Authorization: Bearer <YOUR_STREAM_KEY>`.

---

## 🤖 MCP Integration (AI Assistants)

BunRadio includes a Model Context Protocol (MCP) server allowing direct control from Claude Desktop, Cursor, or Windsurf:

```json
{
  "mcpServers": {
    "bunradio": {
      "url": "http://localhost:8080/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_STREAM_KEY"
      }
    }
  }
}
```

Included MCP tools: `get_status`, `get_queue`, `push_to_queue`, `remove_from_queue`, `clear_queue`, `move_in_queue`, `skip_track`.

---

## 📚 Technical Documentation

Explore in-depth architectural audits and performance reports in the [`docs/`](docs/) directory:
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md): Memory profiles, Audio Ring Buffer, and benchmarks.
- [docs/SRC2.md](docs/SRC2.md) & [docs/IMPLEMENTACION.md](docs/IMPLEMENTACION.md): Architectural audit, FFI memory bounds, and state machines.
- [docs/RELAY-EXPLAINER.md](docs/RELAY-EXPLAINER.md): Mass-scale fan-out architecture via relays and edge CDNs.

---

## 📜 License

[MIT](LICENSE)
