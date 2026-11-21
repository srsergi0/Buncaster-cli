# Mesa redonda: Buncaster "Curley + Valin" (Media over QUIC + Opus bien medido)

> 21-nov-2026. Sigue a `docs/ENGINE-ROUNDTABLE.md` (ronda 1) y `docs/ENGINE-BUN-WAY.md` (ronda 2).
> Línea base: `main` en `0a89a49`. Producción (`buncaster`, gestionado por `bloom/docker-compose.yml`)
> **solo se ha leído** (`docker ps/inspect/exec ls`, `/health`, `/metrics`). Todas las pruebas se
> hicieron en un banco aparte (`moq/docker-compose.test.yml`: `bcmoq-engine` en `127.0.0.1:4390`,
> `bcmoq-relay` en `127.0.0.1:4433/udp`, sin SRT publicado), con navegadores reales (Playwright
> 1.65.1: Chromium 159, Firefox 159, WebKit 27.2) en contenedores de la misma red. No hay commits.
> Los contenedores y puertos de prueba se cerraron al terminar (§9).

---

## 0. Resumen

| | Antes (HTTP `/opus`, producción) | Después (MoQ, valores por defecto) |
|---|---|---|
| Glass-to-glass (entrada del motor → altavoz), Chromium | **63,6 s** (`PREBUFFER_BYTES=1572864`)<br>9,9 s con `PREBUFFER_SECONDS=10` | **0,33–0,36 s** (p50 334–359 ms) |
| Con 10 % de pérdida + 50 ± 50 ms de jitter | 11,7 s (prebuffer de 10 s), 0 paradas<br>5,3 s y 3 paradas con prebuffer mínimo | **0,45 s**, 0 vaciados, 100 ms rellenados en 60 s |
| Bitrate | Opus 192 kbps | Opus 128 kbps (medidos 128,4 kbps de media) |
| Si algo falla | — | cae a HTTP: 0,2 s si el relay no está; ≤ 2 s si muere a mitad |

**Arquitectura elegida:** el motor codifica Opus en proceso (libopus por FFI, tramas de 20 ms) y lo publica en formato *hang* a un **sidecar `moq-relay`** (Rust, de Luke Curley, binario oficial) por WebSocket interno. El relay sirve a los navegadores por **WebTransport/UDP 4433**, con certificados efímeros fijados por `serverCertificateHashes`. El cliente `client/moq-player.ts` usa WebCodecs y AudioWorklet y cae al stream HTTP de siempre. Todo va detrás de `MOQ_ENABLED=false`.

---

## 1. Ronda de inspección

**MODERADORA:** Reglas de la sesión: producción solo se lee; sin commits; flags apagadas; banco propio; números antes que opiniones. Cada rol confirma o descarta su hipótesis con evidencia.

### 1.1 Arquitecto de transporte (Luke Curley: `draft-lcurley-warp`, `draft-ietf-moq-transport`, moq-rs)

**Hipótesis:** HTTP progresivo sobre TCP acumula retraso porque prioriza integridad sobre actualidad. Con QUIC, cada grupo va en su stream y lo viejo se descarta. Queda pendiente comprobar si Bun basta o hace falta el relay de Curley.

**Evidencia sobre Bun 1.4.5** (`oven/bun:1.4.5`):

| Prueba | Resultado |
|---|---|
| `Object.keys(Bun)` con quic/h3/http3/webtransport | solo `udpSocket` |
| `globalThis.WebTransport` | `undefined` |
| `Bun.serve({ h3: true })` / `http3` / `quic` | se ignoran: el servidor arranca en HTTP/1.1 |
| `import("node:quic")` | **existe** (experimental, aviso `ExperimentalWarning`): `listen`/`connect`; un handshake QUIC con ALPN propio funciona (verificado con certificado propio). **No hay capa HTTP/3 ni WebTransport** (CONNECT extendido, SETTINGS_WT, capsules, QPACK) |
| `import("quic")` | es el paquete npm antiguo `quic` (auto-instalación de Bun), no QUIC moderno |

Un servidor WebTransport en Bun obligaría a escribir HTTP/3 + WebTransport sobre una API experimental, dentro del proceso que da la radio. **Descartado.**

**Evidencia sobre moq-relay:** el repositorio `moq-dev/moq` (antes `kixelated/moq`) tiene 1 632 estrellas, el último push es de hoy y saca releases de `moq-relay` cada 2-5 días (v0.17.17 del 16-nov). Ofrece binarios oficiales x86_64/aarch64 con `SHA256SUMS`, imagen Docker y paquetes apt. Implementa moq-lite (subconjunto compatible de `draft-ietf-moq-transport`) sobre WebTransport, QUIC crudo y WebSocket (qmux). Trae caché, prioridades, descarte por `maxAge`, clustering de relays (`--cluster-connect`), recarga de certificados en caliente y un servidor de auth de referencia (`moq auth serve`: JWT, lectura/escritura por patrones y `--limit-remote`).

**Veredicto:** confirmada la tesis, descartado el QUIC en proceso. Se usa el relay de Curley como sidecar. El motor no necesita QUIC: publica por WebSocket al relay local con `@moq/net` (la librería TS de Curley, que en Bun usa WebSocket porque no hay WebTransport).

### 1.2 Ingeniero de códecs (Jean-Marc Valin: RFC 6716, RFC 7845, libopus 1.5, DRED)

**Hipótesis:** 192 kbps es excesivo y 96 kbps no se oye. DRED y Deep PLC ayudarían ante pérdidas.

**DRED y PLC neuronal en las libopus reales** (llamadas FFI a la librería instalada):

| Imagen | libopus | `OPUS_SET_DRED_DURATION` | Tamaño de la .so |
|---|---|---|---|
| alpine 3.20 (runtime de producción; `opus-1.5.2-r0`) | 1.5.2 | **−5 `OPUS_UNIMPLEMENTED`** | 419 KB (sin pesos DNN) |
| Debian trixie (`oven/bun:1.4.5` + `libopus0 1.5.2-2`) | 1.5.2 | **−5** | 3,5 MB |
| Debian bookworm (`oven/bun:1.2`) | 1.3.1 | −5 | — |

DRED no está compilado en ninguna (necesita `--enable-dred`). Además, el `AudioDecoder` de WebCodecs no expone DRED ni PLC: solo decodifica paquetes que llegan. Aprovecharlo exigiría compilar libopus con DRED en el servidor y llevar al navegador un decoder libopus en WASM con los pesos (megabytes). Y DRED está entrenado y evaluado para **voz** a baja tasa (Valin et al., ICASSP 2023), no para música estéreo. **Descartado.**

**FEC en banda (LBRR):** con `-fec 1 -packet_loss 10`, libopus 1.5.2 pasa **todos** los paquetes a modo HYBRID, incluso a 128k estéreo (TOC de 601 paquetes: 601 HYBRID, frente a 601 CELT sin FEC). Para música eso es catastrófico:

| PEAQ avanzado (ODG) | FEC off | FEC on |
|---|---|---|
| pista 1, 96k | −0,90 | **−2,84** |
| pista 1, 128k | −0,43 | **−2,14** |
| pista 5, 96k | −0,57 | −1,95 |
| pista 5, 128k | −0,19 | −1,14 |

**Bitrate:** medido con **PEAQ** (ITU-R BS.1387, modelo avanzado, `gstpeaq` compilado en un contenedor) sobre 12 s de 6 pistas reales de la biblioteca de Bloom (4 FLAC y 2 MP3 320k). La codificación es libopus 1.5.2 VBR con complejidad 10, la misma configuración que usa el motor. Escala ODG: 0 = imperceptible, −1 = perceptible pero no molesto, −2 = algo molesto.

| | ref vs ref | 32k | 64k | 96k | 128k | 192k |
|---|---|---|---|---|---|---|
| Rango en 6 pistas | +0,21 | −2,9…−3,3 | −1,2…−1,8 | **−0,45…−0,89** | **−0,15…−0,43** | −0,00…−0,09 |
| Media | | −3,21 | −1,52 | −0,71 | −0,33 | −0,06 |

**Veredicto:**

- 96k **no** queda demostrado como transparente: la mitad de las pistas se acerca a −0,9. PEAQ penaliza a los códecs modernos y no sustituye a la escucha, pero la regla era "medir, no fe". Por eso **128 kbps por defecto en MoQ** (33 % menos que el HTTP), con 96 como opción (`MOQ_OPUS_BITRATE_KBPS=96`) tras un ABX ciego del dueño.
- **FEC off** y **DRED descartado**.
- La robustez ante pérdidas la dan la retransmisión de QUIC dentro de cada grupo, el descarte de grupos viejos (`maxAge`) y el jitter buffer del cliente con fundidos. Son los números de §5.2.

### 1.3 Ingeniera de navegadores

**Hipótesis:** WebTransport funciona en Chrome, Edge y Firefox; en Safari depende de la versión. Cloudflare Tunnel no pasa QUIC, así que el canal va directo a la IP con `serverCertificateHashes`. El fallback HTTP tiene que funcionar siempre.

**Evidencia:**

- MDN browser-compat-data 8.1.10 (19-nov-2026): matriz en §6.
- Pruebas reales, mismo certificado autofirmado ECDSA de 10 días con su hash:

| Navegador (Playwright 1.65.1) | WebTransport + hash | Audio por MoQ | Fallback |
|---|---|---|---|
| Chromium 159 | **OK** (moq-lite-06, conexión en 22–45 ms) | **OK**, medido (§5) | OK |
| Firefox 159 | **OK** | transporte y WebCodecs OK (1 005 tramas decodificadas); la salida no se puede medir en el contenedor (sin dispositivo de audio, `AudioContext` queda `suspended`) | OK |
| WebKit 27.2 (Linux) | no existe `WebTransport` | — | **OK**: HTTP síncrono, el `<audio>` avanza |

- `serverCertificateHashes`: el certificado tiene que ser X.509v3, ECDSA P-256 y con validez ≤ 14 días. Lo generamos con WebCrypto, sin openssl (DER a mano, `src/moq/cert.ts`). `openssl verify` da OK, y Chrome y Firefox lo aceptan.
- **Rotación verificada en vivo:** se promovió `next` a activo en el volumen, el relay registró `reloading server certificates`, el hash antiguo pasó a fallar y el `next` anunciado conectaba. Los clientes que pidieron los hashes antes de la rotación tienen los dos.
- `@moq/net` 0.4.8 mantiene **Safari en WebSocket** aunque Safari 26.4 tenga el API ("WebKit bugs stall long sessions"), y usa WebTransport en Firefox solo desde la 153.

**Veredicto:** confirmada. Política del cliente, decidida de forma **síncrona** dentro del gesto del usuario:

- Sin WebTransport, sin `AudioDecoder` u Opus, o sin `AudioWorklet` → HTTP.
- Safari → HTTP por política (Web Audio además se suspende con la pantalla bloqueada en iOS; `<audio>` no). `allowSafari: true` existe para probarlo.

### 1.4 SRE

**Hipótesis:** sin medida glass-to-glass real no hay mejora. MoQ no puede empeorar el camino HTTP ni comerse el VPS de 2 núcleos.

**Método glass-to-glass:** `MOQ_LATENCY_PROBE=true` habilita `POST /admin/api/moq/probe`, que sustituye 40 ms del siguiente trozo de PCM **en la entrada del motor** (`writeToMaster`, antes de cualquier encoder) por un tono de 2 kHz a −6 dBFS y devuelve `Date.now()` exacto. El navegador pasa el audio por un `AudioWorklet` detector (umbral −34 dBFS tras 300 ms de silencio) en la salida del `AudioContext`, y suma `outputLatency` + `baseLatency` (42 ms en Chromium headless). HTTP y MoQ pasan por el **mismo** detector: en HTTP, `<audio>` → `MediaElementSource` → detector. Motor y navegador comparten host, así que comparten reloj de pared (el desfase medido es de −4 a 0 ms y se resta). La música de prueba son 6 pistas reales de Bloom atenuadas 40 dB (pico −39 dBFS): el detector las ve como silencio, pero Opus las codifica a los mismos 191 kbps que al volumen original.

**Pérdidas:** `tc netem` en el namespace de red del relay (MoQ) o del motor (HTTP), solo hacia la IP del navegador, con un contenedor auxiliar con `NET_ADMIN` (`bench/moq/netem.sh`): pérdida 2/5/10 % + `delay 50ms 50ms`. Así ningún servicio necesita privilegios.

**Veredicto:** números en §5. Hallazgos operativos: con 200 clientes lentos el relay murió por **OOM** (límite de 256 MiB) porque `send_window` de 2 MiB por conexión permite acumular ~400 MB; se bajó a 256 KiB. El coste del relay va por **paquetes y streams, no por bytes**.

### 1.5 Seguridad

**Hipótesis:** un UDP público abre superficie. Hay que limitar por IP, impedir publicar sin credencial, vigilar la amplificación y proteger la clave privada.

| Control | Implementación | Verificado |
|---|---|---|
| Publicar solo con credencial | `moq auth serve` (loopback del contenedor del relay) verifica `?jwt=` HS256 con `publish.jwk`. El motor firma tokens de 24 h con `root=bloom`, `publish=[radio.hang]`. Lectura anónima solo bajo `bloom/**` | Nuestro JWT pasa `moq auth verify`; con `public_publish` vacío no hay escritura anónima |
| Sesiones por IP | `--limit-remote ${MOQ_LIMIT_PER_IP:-8}` (+ `--revalidate 60s --expires 1d`) | La 9.ª sesión desde una IP: `the auth server refused the session` |
| Ancho de banda por sesión | `max_streams = 32` (suscripciones por sesión) y `send_window = 256 KiB` | OOM reproducido con 2 MiB; sin OOM con 256 KiB |
| Recursos del relay | Contenedor aparte: `cpus: 1.0`, `mem_limit: 256m`, usuario sin privilegios (uid 10001) | El relay no puede quitarle el segundo núcleo a la radio |
| Amplificación | QUIC (quinn) limita a 3× antes de validar la dirección (RFC 9000 §8). Prueba con datagramas falsos desde la red docker → | basura de 1200 B: 0 B de respuesta; Initial v1 basura: 0 B; versión desconocida: Version Negotiation de 55 B (factor 0,05 con 1200 B y 0,92 con 60 B, **siempre < 1**) |
| Clave privada | Generada en el volumen `moq-secrets` (fuera del repo), 0600, propiedad del uid del relay; `.gitignore` con `*.pem`, `*.jwk`, `moq-secrets/` | `ls -la /certs`: `key.pem`/`next.key`/`publish.jwk` en `-rw-------` |
| Puertos | Solo 4433/udp al host. El 4434 (WebSocket de publicación) y el 9101 (interno) quedan dentro de la red docker | compose de prueba |

Límite pendiente: el host **no tiene cortafuegos** (no hay `ufw`, `iptables` ni `nft` instalados), así que no hay límite de ancho de banda **por IP a nivel de red**. Hoy lo acotan sesiones/IP × suscripciones/sesión × 128 kbps. Si hace falta, se añade `hashlimit`/`tc` en el proveedor o en el netns del relay (ver §8).

### 1.6 Abogada del diablo (oyente)

> "Si Safari de iPhone no cae limpio, no me sirve; si no se mide glass-to-glass, no me lo creo;
> prefiero algo pequeño y medido."

Comprobado:

- WebKit cae a HTTP de forma síncrona y suena.
- Con el relay caído antes de dar a play, Chromium está en HTTP a los **194 ms**.
- Si el relay muere a mitad, el watchdog del cliente pasa a HTTP. Medido con 3 s de umbral; ahora el defecto es **2 s**.
- La latencia se mide con un clic en la entrada y su detección en la salida.

Dos vetos aplicados:

1. Nada de grupos de 1 s ni tramas de 60 ms por defecto: ahorran CPU pero cortan 0,5–1,6 s por minuto con pérdidas (§5.2).
2. El 96k no entra por defecto sin ABX.

---

## 2. Decisión: tabla de impacto, riesgo y esfuerzo

| # | Opción | Impacto | Riesgo | Esfuerzo | Medible | Decisión |
|---|---|---|---|---|---|---|
| 1 | Servidor HTTP/3 + WebTransport + moq-lite **en Bun** (`node:quic`) | = relay | **Alto**: API experimental, todo dentro del proceso de la radio | Muy alto (HTTP/3, QPACK, WT, moq-lite, prioridades) | — | **Descartado** |
| 2 | **Sidecar `moq-relay`** (binario oficial) + publicador en proceso (`@moq/net` por WebSocket interno) | 64 s → 0,35 s | Medio: proceso nuevo y puerto UDP; aislado con cpus/mem y uid propio | Medio | Sí | **Elegido** |
| 3 | Relay + `moq import fmp4` (ffmpeg → fMP4 → moq-cli) como publicador | Igual | +2 procesos permanentes (ffmpeg + moq) | Bajo | Sí | Descartado: libopus FFI cuesta 1,4 % y no es un proceso más |
| 4 | Implementar moq-lite a mano (cliente y publicador) | Igual, ~10 KB de JS | Alto: protocolo vivo (moq-lite-06), qmux con control de flujo | Alto | — | Descartado: no reinventar; se fija la versión |
| 5 | Encoder Opus en proceso (libopus FFI) solo para MoQ; HTTP sigue con ffmpeg | Paquetes sueltos de 20 ms al instante (las páginas Ogg son de ~1 s) | Bajo-medio (librería C en el proceso; la misma que ya usa ffmpeg) | Bajo | Sí | **Hecho** |
| 6 | Opus 96 kbps | −25 % frente a 128 | Calidad: PEAQ −0,45…−0,89 | Mínimo | Sí | Flag; **128 por defecto** |
| 7 | FEC en banda | ~0 con streams QUIC | **Alto**: fuerza HYBRID, ODG −2,1 | Mínimo | Sí | **Descartado** (flag off) |
| 8 | DRED / Deep PLC + libopus WASM en el navegador | Solo voz; megabytes de pesos | Alto | Muy alto | — | **Descartado** (no compilado: −5) |
| 9 | Cliente propio (WebCodecs + AudioWorklet) en vez de `@moq/watch` | Audio solo, mide su latencia, fallback HTTP | Bajo | Medio | Sí | **Hecho** (`@moq/net` solo para el transporte) |
| 10 | Certificados efímeros + `serverCertificateHashes` + rotación con solape | Necesario sin dominio directo | Bajo | Bajo | Sí | **Hecho** |
| 11 | Fallback WebSocket (qmux) para Safari vía Cloudflare Tunnel | Safari con ~TCP | Medio (HoL de TCP; toca la config del túnel de Bloom) | Bajo | Pendiente | Siguiente fase |
| 12 | Tramas de 60 ms / grupos de 1 s | Relay −40 % / −68 % | Cortes con pérdidas | Mínimo | Sí | Flags; **20 ms / 100 ms por defecto** |

---

## 3. Lo implementado (todo detrás de `MOQ_ENABLED=false`)

```
PCM del motor ─(setPcmHooks.tap, antes del lote de ENCODER_BATCH_MS)─▶ PcmFramer 20 ms ─▶ libopus FFI
      │                                                                                       │
      ├─▶ LAME / ffmpeg-opus / HTTP: sin cambios                              hang legacy (varint pts + paquete)
      │                                                                                       ▼
      └─ (sonda) setPcmHooks.transform: tono marcador            MoqPublisher (@moq/net, WebSocket ws://moq-relay:4434)
                                                                                              │
     navegador ◀── WebTransport UDP 4433 (hash de certificado) ── moq-relay 0.17.17 + moq auth serve ◀┘
```

| Pieza | Archivo | Notas |
|---|---|---|
| Ganchos de PCM | `src/audio-router.ts` (`setPcmHooks`) | Nulos por defecto: el camino HTTP ejecuta exactamente lo mismo que antes |
| libopus FFI | `src/moq/opus-ffi.ts` | `APPLICATION_AUDIO`, VBR sin restricción, complejidad 10, FEC off, `OPUS_RESET_STATE`. Tramas de 20/40/60 ms. Funciona con Bun 1.2 (libopus 1.3.1) y 1.4.5 (1.5.2); desactivado en macOS arm64 (variádica) |
| Formato hang | `src/moq/hang.ts` | `catalog.json` (AudioDecoderConfig, `container: legacy`, `clock`) + extensión `bloom.clock` (pares pts→pared cada 0,5 s). **Interoperable**: el `moq` CLI de Curley lee el catálogo y exporta fMP4 que ffmpeg decodifica (`DECODE_OK`, opus 48 kHz estéreo) |
| Publicador | `src/moq/publisher.ts` | Origin persistente entre reconexiones; reintento con backoff 1 → 30 s; catálogo con `maxAge` infinito (si no, un visor tardío no arranca: bug encontrado); audio con `maxAge=MOQ_MAX_AGE_MS` y prioridad 255 |
| Servicio | `src/moq/index.ts` | **Codifica solo con demanda** (`track.used`): sin oyentes MoQ no gasta libopus; el PTS sigue avanzando |
| Certificados | `src/moq/cert.ts` | ECDSA P-256, `MOQ_CERT_DAYS=10`, `cert.pem` activo + `next.pem` ya anunciado; promueve a los 5 días si `next` lleva ≥ 1 h publicado; escritura atómica 0600 |
| JWT | `src/moq/jwt.ts` | Mismo formato que `moq auth generate/sign` |
| HTTP | `src/http-server.ts` | `GET /moq/session` (url, hashes, fallback, objetivo, hora del servidor; `no-store`; sin secretos), `GET /moq/player.js`, `GET /moq/demo`, `POST /admin/api/moq/probe` (admin + flag), bloque `moq` en `/status`, `radio_moq_*` en `/metrics` (solo con la flag) |
| Cliente | `client/moq-player.ts`, `client/worklet.ts`, `client/demo.html` | 350 KB minificados / **95 KB gzip** (casi todo `@moq/net`). Jitter buffer de 250 ms con control de ritmo ±0,5 % (≈ 9 cents; el motor va +0,1 % y suelta ráfagas de 0,5 s en cada relevo), recorte del exceso al arrancar, fundidos de 5 ms en huecos, saltos y vaciados, silencio del mismo largo si falta un grupo, estimación de retraso, fallback HTTP (arranque > 6 s, 2 s sin tramas, conexión cerrada o error del decoder) |
| Sidecar | `moq/relay/{Dockerfile,relay.toml,entrypoint.sh}` | debian:trixie-slim + binarios oficiales verificados por SHA-256 (amd64/arm64), usuario 10001; el entrypoint espera a los secretos y sale si muere el relay o el auth |
| Banco | `moq/docker-compose.test.yml`, `bench/moq/*` | `g2g.mjs` (sonda), `matrix.sh` + `netem.sh` (pérdidas), `load.mjs` + `load-client.ts` (N pestañas WebTransport), `native-load.sh` (N `moq` CLI) |
| Imagen | `Dockerfile` | Compila `public/moq-player.js` y copia la demo |
| Dependencia | `package.json` | `@moq/net` **0.4.8** fijada (habla moq-lite-06 con el relay 0.17.17). Solo se carga con la flag (`import()` dinámico) |

Arreglo colateral (solo test): `test/watchdog-failover.test.ts` dejaba `state.isBroadcasting=true` según el orden; con `bun test --randomize --seed=4252762272` fallaba `integration.test.ts` **también en `0a89a49`**. Ahora restaura el estado tras cada test (6 semillas, 0 fallos).

---

## 4. Lo descartado y por qué

| Idea | Por qué no |
|---|---|
| WebTransport/HTTP/3 en Bun | Bun 1.4.5 no lo tiene; `node:quic` es experimental y no trae HTTP/3/WT (§1.1) |
| Compilar moq-relay desde fuente | Minutos de 2 núcleos en un host de producción; hay binarios oficiales firmados por hash |
| DRED / Deep PLC / libopus WASM | No compilado en Alpine ni Debian (−5); WebCodecs no lo expone; pesos de megabytes; pensado para voz |
| FEC en banda | Fuerza HYBRID: ODG −0,43 → −2,14 a 128k; con streams QUIC no aporta |
| 96 kbps por defecto | PEAQ −0,45…−0,89 (perceptible); necesita ABX |
| Datagramas QUIC + FEC propia | Los streams con retransmisión y `maxAge` ya dan 0 vaciados al 10 % de pérdida (§5.2) |
| Grupos de 1 s | Relay −68 % de CPU, pero 2-4 vaciados y 0,5–1 s rellenados por minuto con pérdidas |
| Tramas de 60 ms por defecto | Relay −40 % y publicador −45 %, pero 0,86–1,58 s rellenados por minuto con pérdidas (dos pasadas) |
| `@moq/watch` como reproductor | Componente de vídeo y audio mucho mayor; no mide glass-to-glass ni cae a HTTP |
| Prebuffer HTTP mínimo en vez de MoQ (control) | 4,1 s en limpio y 4–5,3 s con 1-4 paradas por minuto con pérdidas: el `<audio>` + páginas Ogg de 1 s no bajan de ~4 s |
| Fallback WebSocket directo a la IP | La página de Bloom es HTTPS: `ws://` es contenido mixto y `wss://` a IP no admite fijar hash. El camino es `wss://` vía Cloudflare Tunnel (siguiente fase) |

---

## 5. Mediciones (acta numérica)

Banco: música real −40 dB, perfil de producción (`OPUS_TIER_BITRATE_KBPS=192`, `CROSSFADE_SECONDS=2`, `MP3_ON_DEMAND`, `SRT_ON_DEMAND`, decode nativo), MoQ por defecto (128k, 20 ms, grupos de 100 ms, objetivo 250 ms). Navegador: Chromium 159 headless. Cada pasada duró ≤ 90 s.

### 5.1 Glass-to-glass (sonda: entrada del motor → salida de audio)

| Camino | n | p50 | rango | Notas |
|---|---|---|---|---|
| HTTP `/opus`, `PREBUFFER_BYTES=1572864` (**producción**) | 3 | **63 648 ms** | 63 647–63 648 | Con el anillo lleno. Recién arrancado el motor, 19–22 s |
| HTTP `/opus`, `PREBUFFER_SECONDS=10` | 5 | 9 902 ms | 9 902–9 903 | |
| HTTP `/opus`, `PREBUFFER_BYTES=8192` (control) | 10 | 4 088 ms | 4 087–4 089 | 1 parada de 1,0 s al arrancar |
| **MoQ** (pasada 1) | 10 | **334 ms** | 327–336 | buffer 257 ms, salida 42 ms, estimación del cliente 323 ms |
| **MoQ** (imagen final) | 10 | **354 ms** | 353–355 | conexión 22 ms, primer audio 555 ms |
| MoQ, tramas de 60 ms | 10 | 371 / 355 ms | | con grupos de 1 s / de 100 ms |

Desglose aproximado de MoQ: espera de trama ≤ 20 ms + lookahead 6,5 ms + publicación y relay ~5 ms + **jitter buffer 250 ms** + salida 42 ms. Bajar `MOQ_CLIENT_TARGET_MS` a 150 daría ~0,25 s, pero con menos margen ante jitter.

Hora del primer sonido: HTTP 135–180 ms (pero con 10–65 s de retraso); MoQ 0,55–0,87 s (sesión + worklet + llenar 250 ms).

### 5.2 Pérdidas: 2/5/10 % + jitter 50 ± 50 ms, 60 s por pasada

| Camino | Pérdida | g2g p50 (rango) | Vaciados / tiempo en rebuffer | Huecos rellenados | Paradas `<audio>` |
|---|---|---|---|---|---|
| **MoQ** 20 ms / 100 ms | 0 % | 359 ms (341–362) | 0 / 0 | 0 | — |
| | 2 % | 427 ms (352–435) | **0 / 0** | 100 ms | — |
| | 5 % | 396 ms (393–719) | **0 / 0** | 200 ms | — |
| | 10 % | **446 ms** (436–458) | **0 / 0** | 100 ms | — |
| MoQ 60 ms / 1 s | 2 / 5 / 10 % | 1 284 / 407 / 396 ms | 0 / 2 (196 ms) / 4 (441 ms) | 1 000 / 500 / 500 ms | — |
| MoQ 60 ms / 100 ms | 2 / 5 / 10 % | 835 / 453 / 893 ms (máx. 5,8 s) | 0 | 860 / 1 220 / 1 580 ms | — |
| HTTP, prebuffer 10 s | 2 / 5 / 10 % | 11 874 / 11 800 / 11 734 ms | — | — | 0 / 0 / 0 |
| HTTP, prebuffer 8 KB | 0 / 2 / 5 / 10 % | 4 088 / 5 307 / 4 309 / 5 288 ms | — | — | 1 (1,0 s) / 4 (2,1 s) / 1 (0,07 s) / 3 (1,3 s) |

Lectura: el retraso extra de MoQ con pérdidas son los ~50 ms de retardo medio de netem más algún grupo retransmitido. Los huecos rellenados son grupos que superaron `maxAge`; el cliente los rellena con silencio y fundidos de 5 ms. Con el prebuffer de 10 s, HTTP no se para, pero arrastra 12 s de retraso y lo que la pérdida añade no se recupera nunca.

Medidas de una sola pasada por condición: cuentan las tendencias; las diferencias de ±50 ms no.

### 5.3 CPU, RSS y syscalls

**Relay** (cgroup, % de un núcleo; RSS de `moq-relay` + `moq auth serve`):

| Oyentes MoQ | 20 ms / grupos 100 ms (defecto) | 60 ms / 100 ms | 20 ms / 1 s | 60 ms / 1 s | RSS | Syscalls/s (defecto) |
|---|---|---|---|---|---|---|
| 0 | **0,2 %** | | | | 22,6 + 15,7 MB | — |
| 1 | **3,7–4,1 %** | | | | 25,9 + 15,7 MB | — |
| 50 | **32,7–35,9 %** (tres pasadas, dos generadores) | 21,0 % | 25,2 % | 11,4 % | 38 + 15,7 MB | 3 230–3 351 (`sendmsg` 2 570–2 660) |
| 200 | **no medible honestamente en este host** (abajo) | 42,7 % con 150 conectados, de los que la mayoría se quedaban atrás | | | 124–163 MB (antes del arreglo: **OOM a 256 MiB**) | 1 509 |

Por qué no hay una cifra limpia para 200:

- Con 4 Chromium (≤ 50 sesiones por pestaña; más y el renderer cae), el host llegó a load 12,9 y los clientes perdían tramas (`lagged: frames were evicted`).
- El generador nativo (N procesos `moq`) cuesta 77 % y 294 MB por cada 50: para 200 harían falta ~3 núcleos.

Modelo lineal medido: **≈ 0,65–0,7 % de núcleo por oyente** con 20 ms (≈ 130–140 % para 200) y ≈ 0,42 % con 60 ms (≈ 85 %). El relay está capado a `cpus: 1.0`, así que a partir de ~130 oyentes por núcleo se degradan los oyentes MoQ, no la radio. Para escalar: `MOQ_OPUS_FRAME_MS=60`, o un segundo relay en otro servidor con `--cluster-connect` (lo previsto por Curley). Una prueba de 200 limpia necesita una máquina de carga aparte.

**Motor** (cgroup; mismo archivo fijo; A/B medidos a la vez; 1 oyente HTTP `/opus` como el publisher):

| | Base `0a89a49` | Nuevo, MoQ off | Nuevo, MoQ on y 0 oyentes MoQ | MoQ on y ≥ 1 oyente MoQ |
|---|---|---|---|---|
| CPU (ventana tranquila) | 3,37 % | 3,39 % | 3,44 % | 8,3–9,4 % (frente a 3,7–3,8 % de MoQ off en el mismo par) |
| Memoria anónima del cgroup | 38,4 MiB | 40,9 MiB | 39,9 MiB | 54–55 MiB |
| Procesos | 2 | 2 | 2 | 2 |

- El coste con oyentes **no crece con el número de oyentes**: con 50 y con 200 el motor estaba en 6,3–8,5 %, porque reparte el relay.
- De los +4,6–5,6 puntos, **1,4** son libopus (13,6 ms de CPU por segundo de audio, `encodeMsPerSecond`).
- El resto es `@moq/net` por WebSocket. Microbenchmark del publicador solo:
  - sin conexión útil: 0,39 %
  - escribiendo sin suscriptor: 1,14 %
  - con suscriptor: **5,68 %** con tramas de 20 ms, 4,69 % con grupos de 1 s y 3,16 % con tramas de 60 ms
- Siguiente optimización (no hecha): publicador en un `Worker` de Bun, para que ese coste no compita con el bucle de eventos de la radio.

**Camino HTTP:** sin la flag no cambia nada observable. `/status`, `/metrics` y los logs no tienen ninguna línea `moq`, `/moq/session` responde `{"enabled":false,...}` y la sonda da 404. La CPU es igual a la base (3,37 frente a 3,39 %) y los ganchos de PCM son `null`.

### 5.4 Bitrate

| | HTTP `/opus` | MoQ |
|---|---|---|
| Códec | Opus 192k VBR, Ogg de ~1 s por página | Opus 128k VBR, paquetes de 20 ms |
| Medido | 197,5 kbps efectivos en producción | 128,4 kbps de media (Opus + varint); por el cable, +~20 kbps de cabeceras QUIC/UDP/IP a 50 paquetes/s (estimado) |

---

## 6. Matriz de compatibilidad de navegadores

Datos de MDN BCD 8.1.10 y pruebas propias (Playwright 1.65.1).

| Navegador | WebTransport | `serverCertificateHashes` | `AudioDecoder` | AudioWorklet | Comportamiento del cliente |
|---|---|---|---|---|---|
| Chrome / Edge escritorio | 97+ | 100+ | 94+ | 66+ / 79+ | **MoQ** (medido en Chromium 159) |
| Chrome Android | 97+ | 100+ | 94+ | 66+ | MoQ (no probado en dispositivo) |
| Samsung Internet | 18+ | 19+ | 17+ | 9+ | MoQ (no probado) |
| Firefox escritorio | 114+ (`@moq/net` lo usa desde 153) | 125+ | 130+ | 76+ | **MoQ** (transporte y decode verificados en 159) |
| Firefox Android | 114+ | 125+ | **no** | 79+ | **HTTP** (sin `AudioDecoder`) |
| Safari macOS / iOS 26.4+ | 26.4+ | 26.4+ | 26+ | 14.1 / 14.5 | **HTTP por política** (WebKit atasca sesiones largas según `@moq/net`; Web Audio se suspende con la pantalla bloqueada en iOS). `allowSafari: true` para probar |
| Safari < 26.4 / WebKit Linux | no | — | — | — | **HTTP** (verificado en WebKit 27.2 de Playwright) |

Sobre el fallback en Safari: el cliente usa la `fallbackUrl` de la sesión (`MOQ_FALLBACK_URL`, por defecto `/opus`). En la web de Bloom tiene que ser **la misma URL que ya reproduce hoy en Safari**.

---

## 7. Pasos exactos para desplegar (los ejecuta el dueño)

### 7.1 Revisar, probar y publicar

```bash
cd /root/projects/buncaster-cli
git status && git diff
docker run --rm -v $PWD:/app -w /app oven/bun:1.2   bun test
docker run --rm -v $PWD:/app -w /app oven/bun:1.4.5 bun test
rm -f bunradio.log opus-debug.log
git add -A
git commit -m "moq: canal Media over QUIC opcional (sidecar moq-relay, libopus FFI, cliente WebCodecs)"
git push origin main          # CI Build + docker-publish → ghcr.io/srsergi0/buncaster-cli:latest
gh run watch
docker tag ghcr.io/srsergi0/buncaster-cli:latest buncaster-cli:pre-moq    # para volver (antes del pull)
docker pull ghcr.io/srsergi0/buncaster-cli:latest
docker build -t buncaster-moq-relay:0.17.17 /root/projects/buncaster-cli/moq/relay
```

### 7.2 Compose de Bloom (`/root/projects/bloom/docker-compose.yml`; editarlo a mano)

```yaml
  buncaster:
    # … lo que ya hay …
    volumes:
      - ./music:/app/music
      - moq-secrets:/moq-secrets            # NUEVO

  moq-relay:                                # NUEVO
    image: buncaster-moq-relay:0.17.17
    container_name: moq-relay
    restart: unless-stopped
    depends_on: [buncaster]
    environment:
      MOQ_LIMIT_PER_IP: "8"
    volumes:
      - moq-secrets:/certs:ro
    ports:
      - "4433:4433/udp"                     # SOLO este; 4434 queda en la red docker
    cpus: 1.0
    mem_limit: 256m

volumes:
  moq-secrets:                              # NUEVO (o añadir a la sección existente)
```

### 7.3 `/root/projects/bloom/.env`

```
MOQ_ENABLED=true
MOQ_RELAY_URL=http://moq-relay:4434
MOQ_PUBLIC_URL=https://185.139.1.222:4433
MOQ_CERT_NAMES=185.139.1.222,localhost
MOQ_FALLBACK_URL=https://radio.tceoslabs.com/radiobloom.opus   # el tier MP3 está apagado en producción (404); usar el Opus
```

### 7.4 Cortafuegos

El host no tiene `ufw`, `iptables` ni `nft` instalados: Docker publica 4433/udp en 0.0.0.0 directamente, como ya hace con 1936/udp. Si el proveedor del VPS tiene cortafuegos de red, abrir **UDP 4433 entrante**. Opcional, como límite de ancho de banda por IP: una regla `hashlimit` en el proveedor, o `tc`/`iptables` en el netns del relay con un contenedor auxiliar (igual que `bench/moq/netem.sh`).

### 7.5 Recrear y verificar

```bash
docker rm -f buncaster && cd /root/projects/bloom && docker compose up -d buncaster moq-relay
docker network inspect bloom_default | grep -q '"buncaster"' || docker network connect bloom_default buncaster
docker logs buncaster 2>&1 | grep -E "moq\.(started|publisher|disabled)"   # "MoQ activo" + "publicando … transport=websocket"
docker logs moq-relay 2>&1 | grep -E "listening|auth server"
curl -s localhost:4321/moq/session | head -c 400; echo
curl -s localhost:4321/metrics | grep -E "radio_moq_(enabled|relay_connected|frames_total)"
# desde un portátil o móvil fuera de la LAN: http://185.139.1.222:4321/moq/demo
#   (http://IP no es contexto seguro → usar la integración HTTPS del 7.6, o abrir la demo por un túnel/localhost)
```

### 7.6 Integración en la web de Bloom (otro ingeniero; `bloom/` no se ha tocado)

1. El publisher expone por HTTPS (Cloudflare) `GET /api/moq/session` → proxy a `http://buncaster:4321/moq/session`, con `Cache-Control: no-store`. Los hashes viajan por HTTPS, así que nadie puede sustituirlos.
2. Servir el módulo: copiar `public/moq-player.js` de la imagen (o proxy a `/moq/player.js`) como `/moq-player.js` de la web.
3. En el botón de play:
   ```js
   import { MoqPlayer } from "/moq-player.js";
   const p = new MoqPlayer({ sessionUrl: "/api/moq/session", audio: document.querySelector("audio") });
   button.onclick = () => p.play();
   ```
   Dentro del gesto: Safari, iOS y Firefox Android van directos al `<audio>` de siempre.
4. Si hay CSP, `connect-src` debe incluir `https://185.139.1.222:4433`.
5. Mostrar `p.stats.latencyMs` en "modo directo" y usarlo para pedidos, dedicatorias y corazones.
6. Recomendado: empezar como opción ("modo directo") o solo para Chrome/Edge/Firefox escritorio y Android, y mirar `radio_moq_*` y los logs del relay durante unos días.

### 7.7 CI

Sin cambios en los workflows. `bun test` incluye `test/moq.test.ts`. En el runner (Ubuntu + ffmpeg trae `libopus0`) corren también los dos tests de libopus; sin libopus se saltan.

---

## 8. Rollback

| Para… | Hacer |
|---|---|
| Apagar MoQ sin tocar imagen | `MOQ_ENABLED=false` (o quitar la línea) en `bloom/.env` y recrear `buncaster`. El HTTP vuelve a ser idéntico a `0a89a49` |
| Quitar el relay | `docker compose stop moq-relay && docker compose rm -f moq-relay`. El cliente ya cae a HTTP en ~0,2 s, y el motor solo reintenta en segundo plano (backoff hasta 30 s, sin efecto en el audio) |
| Volver a la imagen anterior | `docker tag buncaster-cli:pre-moq ghcr.io/srsergi0/buncaster-cli:latest` y recrear como en §7.5 |
| Invalidar certificados y clave JWT | `docker volume rm bloom_moq-secrets` (con motor y relay parados); se regeneran al arrancar |
| Bajar carga del relay sin apagar | `MOQ_OPUS_FRAME_MS=60` (−40 % de CPU en el relay, +40 ms, peor ante pérdidas) o bajar `MOQ_LIMIT_PER_IP` |

---

## 9. Tests, verificación y limpieza

| Entorno | Resultado |
|---|---|
| `oven/bun:1.2` (sin ffmpeg ni libopus) | 82 pass, 5 skip, 0 fail (línea base 68 pass) |
| `oven/bun:1.4.5` | 82 pass, 5 skip, 0 fail |
| Ubuntu 24.04 + ffmpeg 6.1 + bun 1.4.5 (tipo runner) | **87/87**, tres veces |
| Ubuntu 24.04 + ffmpeg + bun 1.2.23 | 85 pass, 2 skip (decode nativo desactivado por versión) |
| Ubuntu 24.04 sin ffmpeg + bun 1.4.5 | 82 pass, 5 skip |
| `bun test --randomize` (6 semillas, runner) | 0 fallos (antes del arreglo de §3, 1 fallo también en `0a89a49`) |
| `tsc --noEmit` | 14 errores, **los mismos** que en `0a89a49` |

Tests nuevos (`test/moq.test.ts`, 16, sin tocar `state` ni arrancar el motor):

- varint en sus límites
- frame legacy
- forma del catálogo y época del reloj
- certificado (EC P-256, autofirmado, validez ≤ 14 días, SAN, hash = SHA-256 del DER)
- tope de 14 días
- rotación con solape (activo ← next anunciado; claves 0600)
- JWT (claims exactos y firma)
- JWK en base64url 0600
- `PcmFramer` con 6 troceados
- tamaños de trama
- duración por TOC
- libopus 1 s → 50 paquetes CELT (se salta sin libopus)
- tramas de 60 ms
- marcador sobre copia
- flags apagadas por defecto
- política del cliente sin WebTransport

Contenedores y puertos de prueba: se eliminan `bcmoq-*`, `bcab-*` y `moqproto-*`, el volumen `buncaster-moq-test_moq-secrets` y las redes de prueba. 4433/udp, 4390-4393 y 4499 quedan libres (`ss -lntup`). Las imágenes `buncaster-cli:moq`, `buncaster-cli:moq-base`, `buncaster-moq-relay:test`, `peaq-tool:local`, `bcmoq-netem` y `bc-runner:*` se conservan para repetir las medidas.

---

## 10. Riesgos y recomendación

**Riesgos:**

1. **CPU del relay por oyente** (≈ 0,7 % de núcleo con 20 ms). Hasta unos 130 oyentes MoQ por núcleo; el `cpus: 1.0` protege la radio. Más allá: tramas de 60 ms o un segundo relay.
2. **+4,6–5,6 puntos de CPU en el motor** en cuanto hay ≥ 1 oyente MoQ (libopus 1,4 + `@moq/net` ~4), en el mismo bucle de eventos que la radio. Con 0 oyentes, 0. Mitigación futura: publicador en un `Worker`.
3. **Librería C en el proceso** (libopus FFI): un fallo nativo tumbaría el motor. Es la misma librería que usa ffmpeg, con tramas de tamaño fijo y llamadas validadas. Mitigación inmediata: `MOQ_ENABLED=false`.
4. **Acoplamiento de versiones:** relay 0.17.17 y `@moq/net` 0.4.8 negocian moq-lite-06. Actualizarlos siempre juntos y repetir `bench/moq/g2g.mjs`.
5. **Fallback a HTTP = salto atrás en el tiempo:** quien cae de MoQ a `/opus` oye el prebuffer HTTP (10–65 s antes). Es preferible a quedarse sin radio, pero conviene `PREBUFFER_SECONDS=10` en Bloom.
6. **Puerto UDP público nuevo:** autenticado para escribir y limitado por IP en sesiones, pero sin límite de ancho de banda por IP a nivel de red (no hay cortafuegos en el host).
7. **Safari/iOS sigue en HTTP** (decisión consciente). La latencia baja llega a Chrome, Edge, Firefox de escritorio, Chrome Android y Samsung Internet.
8. **La estimación de retraso del cliente** (`latencyMs`) coincide con la sonda en limpio (±30 ms), pero con pérdidas puede desviarse varios segundos porque el track de reloj se retrasa. Es indicativa; la medida buena es la sonda.

**Recomendación:** desplegar en dos pasos.

- **A:** imagen nueva + relay + `MOQ_ENABLED=true`, sin tocar la web. Probar `/moq/demo` desde redes reales (móvil 4G, Wi-Fi de casa) unos días, mirando `radio_moq_*`, los logs del relay y `docker stats moq-relay`.
- **B:** integración en la web como "modo directo" con fallback, empezando por Chrome/Edge/Firefox. Antes de bajar a 96 kbps, un ABX ciego. Antes de esperar más de ~100 oyentes MoQ simultáneos, una prueba de 200 con una máquina de carga aparte, o pasar a `MOQ_OPUS_FRAME_MS=60` y medir.
