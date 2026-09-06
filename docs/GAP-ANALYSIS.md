# 🔍 Gap Analysis — BunRadio vs Icecast

Qué le falta a BunRadio para ser una alternativa completa a Icecast.

---

## ✅ Lo que BunRadio YA tiene (y Icecast NO)

| Feature | BunRadio | Icecast |
|---------|----------|---------|
| RTMP ingest (desde OBS) | ✅ | ❌ (necesita source client) |
| Encoder MP3 integrado | ✅ | ❌ (necesita Liquidsoap/BUTT) |
| Panel DJ web | ✅ | ❌ (solo admin básico) |
| AutoDJ / fallback music | ✅ | ❌ (necesita Liquidsoap) |
| Crossfade entre canciones | ✅ | ❌ |
| DSP (limiter + compressor) | ✅ | ❌ |
| MCP server (control por IA) | ✅ | ❌ |
| Server-Sent Events | ✅ | ❌ |
| Un solo binario standalone | ✅ | ❌ (depende de source clients) |
| Zero config | ✅ | ❌ (XML config) |

---

## ❌ Lo que Icecast TIENE y BunRadio NO

### 🔴 Crítico (funcionalidad core)

| Feature | Icecast | BunRadio | Impacto |
|---------|---------|----------|---------|
| **Múltiples mount points** | ✅ Ilimitados | ❌ Solo `/stream` | No puedes correr 2 radios en 1 server |
| **Relay master→slave** | ✅ Mirroring automático | ❌ | No puedes escalar con CDN/relay |
| **Relay on-demand** | ✅ Solo cuando hay listeners | ❌ | Ahorro de bandwidth |
| **Fallback entre mounts** | ✅ Cascade fallback | ❌ | Si el source cae, no hay respaldo automático |
| **Autenticación de source** | ✅ user/pass por mount | ❌ (solo stream key) | Cualquiera puede hacer push al RTMP |
| **Autenticación de listeners** | ✅ htpasswd / URL auth | ❌ | No puedes poner contraseña al stream |
| **Múltiples formatos** | ✅ MP3, OGG, AAC, FLAC, Opus | ❌ Solo MP3 | Limita calidad y compatibilidad |

### 🟡 Importante (usabilidad y producción)

| Feature | Icecast | BunRadio | Impacto |
|---------|---------|----------|---------|
| **TLS/SSL (HTTPS)** | ✅ Nativo | ❌ | Stream no cifrado |
| **ICY metadata headers** | ✅ Título, artista, etc. | ❌ | Players no muestran info |
| **Directory listing (YP)** | ✅ Icecast Yellow Pages | ❌ | No apareces en directorios de radio |
| **Per-mount config** | ✅ Config diferente por mount | ❌ | Un mount puede tener max-listeners, otro no |
| **Intro file** | ✅ Audio antes del stream | ❌ | No puedes poner un intro/jingle |
| **Dump file** | ✅ Grabar stream a disco | ❌ | No puedes grabar lo que se transmite |
| **Custom HTTP headers** | ✅ Por mount | ❌ | No puedes setear cache-control, etc. |
| **Charset handling** | ✅ UTF-8/Latin1 configurable | ❌ | Metadata con caracteres raros |

### 🟢 Nice to have

| Feature | Icecast | BunRadio | Impacto |
|---------|---------|----------|---------|
| **Connection limits per mount** | ✅ | ❌ | No puedes limitar listeners por estación |
| **Bandwidth limits** | ✅ | ❌ | No puedes controlar ancho de banda |
| **Max listener duration** | ✅ | ❌ | No puedes desconectar listeners after X time |
| **Stream name/description/URL/genre** | ✅ | ❌ | Metadata para directorios |
| **Public/private mounts** | ✅ | ❌ | Controlar qué mounts se anuncian |
| **Admin XML/XSL pages** | ✅ | ❌ | Stats detallados |
| **URL-based auth** | ✅ | ❌ | Auth via API externa |

---

## 🗺️ Roadmap sugerido

### Fase 1 — Paridad funcional básica
1. **Múltiples mount points** — `/stream`, `/stream2`, etc.
2. **Autenticación de source** — user/pass por mount point
3. **ICY metadata** — enviar título/artista en el stream
4. **TLS/SSL** — HTTPS nativo

### Fase 2 — Producción
5. **Relay system** — master→slave mirroring
6. **Fallback cascade** — mount A → mount B → archivo
7. **Autenticación de listeners** — htpasswd o URL
8. **Múltiples formatos** — OGG, AAC (además de MP3)

### Fase 3 — Escalabilidad
9. **Relay on-demand** — solo conecta si hay listeners
10. **Per-mount config** — max-listeners, bitrate, etc. por mount
11. **Directory listing** — registrar en Icecast YP
12. **Dump file** — grabar streams a disco

---

## 💡 Estrategia

BunRadio no debería intentar ser Icecast. Debería enfocarse en su ventaja:

**"Icecast para mortales"** — todo-en-uno sin configurar nada.

| Estrategia | Descripción |
|-----------|-------------|
| **No competir en relay** | Icecast gana en escalabilidad CDN. BunRadio puede relay como client, no como server |
| **Ganar en simplicidad** | 1 binario vs stack de 5 servicios |
| **Múltiples mount points** | Feature #1 para ser productivo |
| **ICY metadata** | Fácil de implementar, alto impacto |
| **TLS** | Obligatorio en 2026 |
| **Auth básica** | Stream key ya existe, solo extenderlo a source/listener |

---

## 📊 Comparativa final

| Categoría | Icecast | BunRadio | Gap |
|-----------|---------|----------|-----|
| Simplicidad | 3/10 | 10/10 | BunRadio gana |
| Features core | 10/10 | 6/10 | Falta multiplemount, relay, auth |
| Producción | 9/10 | 5/10 | Falta TLS, metadata, directory |
| Escalabilidad | 10/10 | 4/10 | Falta relay, CDN support |
| UX | 4/10 | 9/10 | BunRadio gana |
| **Overall** | **7/10** | **7/10** | Diferentes mercados |
