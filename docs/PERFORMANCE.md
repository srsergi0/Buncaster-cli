# ⚡ Performance — BunRadio vs Alternativas

Comparación real de BunRadio con las herramientas más populares de radio streaming.

---

## 📊 La comparación correcta

BunRadio es **un solo binario** que reemplaza TODO este stack:

```
Liquidsoap (AutoDJ) + Icecast (distribución) + Nginx (web panel) + DSP + FFmpeg + RTMP server
```

La comparación justa no es BunRadio vs Liquidsoap (eso es comparar una navaja suiza con una cuchara). Es:

| **BunRadio** | **vs Stack tradicional** | **vs AzuraCast** |
|---|---|---|
| 1 binario | Liquidsoap + Icecast + Nginx + FFmpeg | Docker stack: PHP + MariaDB + Redis + Nginx + Icecast + Liquidsoap |
| ~27 MB RAM | ~250 MB (suma de todos) | ~600 MB |
| 3 segundos | 30–60 min config | 30–60 min setup |
| Zero deps | 4 servicios que configurar | 6 servicios en Docker |

---

## 📊 Resumen rápido

| | **BunRadio** | **Stack tradicional** | **AzuraCast** |
|---|---|---|---|
| | (1 binario) | Liquidsoap + Icecast + Nginx + FFmpeg | (todo en Docker) |
| **RAM idle** | **~27 MB** | ~250 MB | ~500 MB–1 GB |
| **RAM (100 listeners)** | **~60 MB** | ~350 MB | ~1–1.5 GB |
| **Imagen Docker** | **83 MB** | ~500 MB (suma) | ~800 MB |
| **Servicios** | **1** | 4–5 | 6 |
| **Setup** | **3 segundos** | 30–60 minutos | 30–60 minutos |
| **Panel DJ** | ✅ Incluido | ❌ Nginx + HTML aparte | ✅ Incluido |
| **DSP / Crossfade** | ✅ Incluido | ❌ Liquidsoap script | ✅ Liquidsoap config |
| **ICY Metadata** | ✅ Incluido | ❌ Config manual | ✅ Incluido |
| **Multi-formato** | ✅ Incluido | ❌ Config adicional | ✅ Incluido |
| **MCP Server (IA)** | ✅ Incluido | ❌ No existe | ❌ No existe |

---

## El mito de "Icecast usa menos RAM"

Es cierto: Icecast solo usa ~5 MB de RAM. Pero Icecast **no hace nada solo** — es como decir que una llanta usa menos combustible que un auto.

**Icecast sin Liquidsoap + FFmpeg + Nginx + source client = radio que no funciona.**

La comparación real:

| Componente | RAM | ¿Qué hace? |
|-----------|-----|------------|
| **BunRadio** | **27 MB** | **TODO: RTMP + encoder + AutoDJ + DSP + web + distribución** |
| Icecast solo | 5 MB | ❌ No tiene AutoDJ, no tiene encoder, no tiene panel |
| Icecast + Liquidsoap | 165 MB | ✅ AutoDJ + distribución |
| Icecast + Liquidsoap + Nginx | 175 MB | ✅ + panel web básico |
| Icecast + Liquidsoap + Nginx + DSP | 180 MB | ✅ + procesamiento |
| **Stack completo** | **~250 MB** | ✅ **Igual que BunRadio** |

**Resultado:** BunRadio hace el trabajo de 250 MB de software con 27 MB.

---

## 🏗️ Arquitectura

### BunRadio — 1 binario
```
┌────────────────────────────────────────────┐
│              BunRadio                       │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐ │
│  │ RTMP     │ │ Encoder  │ │ AutoDJ     │ │
│  │ Server   │ │ (MP3/OGG │ │ + Playlist │ │
│  │          │ │  /etc)   │ │ + Crossfade│ │
│  └────┬─────┘ └────┬─────┘ └──────┬──────┘ │
│       │            │              │        │
│  ┌────▼────────────▼──────────────▼──────┐ │
│  │         DSP (loudnorm + limiter)       │ │
│  └────────────────┬───────────────────────┘ │
│       │            │              │        │
│  ┌────▼─────┐ ┌────▼─────┐ ┌──────┴──────┐ │
│  │ Broadcaster│ │ PreBuf  │ │ Panel DJ   │ │
│  │ Fan-out   │ │ + MCP   │ │ Web        │ │
│  └───────────┘ └──────────┘ └────────────┘ │
└────────────────────────────────────────────┘
```

**Un proceso. Zero dependencias. Un binario.**

### Stack tradicional — 4+ servicios
```
┌─────────────────────────────────────────────────┐
│                   Usuario                         │
│ Configura 4 programas diferentes + los mantiene  │
└─────────────────────────────────────────────────┘
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
┌──────────────┐ ┌──────────┐ ┌──────────────┐
│   OBS/BUTT   │ │Liquidsoap│ │    Nginx     │
│ (Source)     │ │(AutoDJ)  │ │(Panel web)   │
└──────────────┘ └────┬─────┘ └──────────────┘
                      │              │
                      ▼              ▼
               ┌──────────┐  ┌──────────────┐
               │ Icecast  │  │   FFmpeg     │
               │ (Stream) │  │  (DSP)       │
               └──────────┘  └──────────────┘
```

**4–5 procesos. Dependencias por separado. Configuración individual.**

---

## 🧪 Benchmark Docker (datos reales)

Benchmark ejecutado el 2026-07-15 en Windows (16 GB RAM, Docker Desktop).

### Resultados reales

| Tool | Image Size | Startup | RAM idle | HTTP |
|------|-----------|---------|----------|------|
| **BunRadio** | **83 MB** | **~4s** | **26.9 MB** | **12ms** |
| Stack tradicional* | ~500 MB | ~15s | ~250 MB | ~15ms |
| AzuraCast | ~800 MB | ~30–60s | ~600 MB | ~50ms |

*\* Liquidsoap + Icecast + Nginx combinados*

### Cómo ejecutar el benchmark

```bash
bash benchmark.sh
```

---

## 🎯 Casos de uso

### Elige **BunRadio** si:
- Quieres **1 binario que haga TODO**
- Arrancar en 3 segundos sin leer documentación
- Panel DJ web sin instalar nada extra
- Streaming desde OBS con fallback automático
- Control por IA (MCP)
- **Valoras tu tiempo** sobre tener control de cada pieza

### Elige **Stack tradicional** si:
- Ya tienes experiencia con Liquidsoap/Icecast
- Necesitas control granular de cada componente
- Tienes infraestructura existente que mantener
- Quieres escalar a miles de oyentes

### Elige **AzuraCast** si:
- Necesitas **multi-estación** (10+ radios en un server)
- Quieres scheduling profesional con GUI
- Tienes un VPS con al menos 2 GB RAM
- Prefieres una plataforma completa aunque sea pesada

---

## 📈 Escalabilidad realista

| Listeners | BunRadio | Stack tradicional | AzuraCast |
|-----------|----------|-------------------|-----------|
| 10 | ✅ 27 MB | ✅ 250 MB | ✅ 600 MB |
| 100 | ✅ 60 MB | ✅ 350 MB | ✅ 1 GB |
| 500 | ✅ 200 MB | ✅ 500 MB | ✅ 1.5 GB |
| 1,000 | ⚠️ 400 MB | ✅ 600 MB | ✅ 2 GB |
| 5,000 | ❌ Relay | ✅ Relay | ✅ Relay |
| 10,000+ | CDN/relay | CDN/relay | CDN/relay |

**El bottleneck no es el software — es el ancho de banda.** A 128kbps, 1000 oyentes consumen ~128 Mbps. A 320kbps, ~320 Mbps. Para >1000 oyentes, necesitas CDN o relays con cualquiera de las opciones.

---

## 🏆 Veredicto

| Categoría | Ganador |
|-----------|---------|
| **Simplicidad** | 🥇 BunRadio (1 binario vs 4 servicios) |
| **Consumo de recursos** | 🥇 BunRadio (27 MB vs 250 MB) |
| **Setup** | 🥇 BunRadio (3s vs 30-60 min) |
| **Funcionalidades** | 🥇 BunRadio / AzuraCast (empate) |
| **Scheduling** | 🥇 AzuraCast / Liquidsoap |
| **Escalabilidad** | 🥇 Stack tradicional |
| **Multi-estación** | 🥇 AzuraCast |
| **Innovación (MCP, AI)** | 🥇 BunRadio (único) |

**BunRadio gana en:** simplicidad radical, eficiencia de recursos, innovación.
**Pierde en:** scheduling complejo y multi-estación.

**La pregunta real:** ¿Para qué necesitas 250 MB de software cuando 27 MB hacen lo mismo?

---

## 🐳 Bonus: Docker image size real

| Componente | Tamaño |
|-----------|--------|
| **BunRadio** | **83 MB** |
| Liquidsoap + Icecast + Nginx | ~500 MB |
| AzuraCast | ~800 MB |
| BunRadio Alpine | ~35 MB (con musl, sin ffmpeg) |
| BunRadio ultra-min | ~15 MB (solo encoder, sin ffmpeg) |
