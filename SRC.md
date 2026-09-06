# Código Fuente - `src/`

## `src/audio-router.ts`

```ts
import fs from "fs";
import { config } from "./config";
import { rtmpLog } from "./logger";
import { state } from "./state";
import { broadcast, broadcastOpus } from "./broadcaster";
import { bitrateDetector } from "./bitrate-detector";
import { LameEncoder, isNativeLameAvailable } from "./lame-ffi";
import { NativeDecoder, isNativeDecodeAvailable } from "./decode-ffi";
import { FORMAT_CONFIG } from "./format-config";

export let opusHeaders: Uint8Array | null = null;

// =============================================================
// 1. CLASE BUFFER FIFO DE AUDIO PCM
// =============================================================
// Diseño "cero allocaciones": un deck secundario solo necesita la
// ventana de crossfade de audio bufferizada (el resto de la canción se
// descarta al llenarse el FIFO). Antes se bufferizaba la canción
// completa (~46MB por tema a 192KB/s) y esa memoria quedaba retenida
// hasta que el deck moría. pullInto() escribe en un buffer del pool PCM
// (reutilizable) en vez de alocar uno nuevo por chunk.
// 192KB/s = 48000Hz × 2ch × 2bytes.
const DECK_BUFFER_CAP_BYTES = (config.crossfadeSeconds + 1) * 192_000;
class AudioStreamBuffer {
  private queue: Uint8Array[] = [];
  private totalBytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes = 0) {
    this.maxBytes = maxBytes;
  }

  push(chunk: Uint8Array) {
    this.queue.push(chunk);
    this.totalBytes += chunk.byteLength;
    if (this.maxBytes > 0) {
      while (this.totalBytes > this.maxBytes && this.queue.length > 1) {
        const removed = this.queue.shift()!;
        this.totalBytes -= removed.byteLength;
      }
    }
  }

  pull(bytesNeeded: number): Uint8Array {
    const out = new Uint8Array(bytesNeeded);
    if (this.totalBytes === 0) {
      return out; // Retornar silencio
    }

    let bytesWritten = 0;
    while (bytesWritten < bytesNeeded && this.queue.length > 0) {
      const chunk = this.queue[0]!;
      const remaining = bytesNeeded - bytesWritten;

      if (chunk.byteLength <= remaining) {
        out.set(chunk, bytesWritten);
        bytesWritten += chunk.byteLength;
        this.queue.shift();
        this.totalBytes -= chunk.byteLength;
      } else {
        out.set(chunk.subarray(0, remaining), bytesWritten);
        this.queue[0] = chunk.subarray(remaining);
        this.totalBytes -= remaining;
        bytesWritten += remaining;
      }
    }
    return out;
  }

  clear() {
    this.queue = [];
    this.totalBytes = 0;
  }

  get length() {
    return this.totalBytes;
  }
}

// =============================================================
// 2. ESTRUCTURA DE DECKS (REPRODUCTORES DE AUDIO)
// =============================================================
interface Deck {
  id: "A" | "B";
  buffer: AudioStreamBuffer;
  process: any | null;
  currentTrackFile: string | null;
}

export const deckA: Deck = {
  id: "A",
  buffer: new AudioStreamBuffer(),
  process: null,
  currentTrackFile: null,
};

export const deckB: Deck = {
  id: "B",
  buffer: new AudioStreamBuffer(),
  process: null,
  currentTrackFile: null,
};

export let fallbackPlaylist: string[] = [];
export let currentPlaylistIndex = 0;
export let isPlaylistInitialized = false;

// Variables de Control de Transición
export let activeDeck: "A" | "B" = "A";
export let transitionStarted = false;
let crossfadeStartTime = 0;

let isLiveTransitionActive = false;
let liveTransitionStartTime = 0;

let isFallbackFadeInActive = false;
let fallbackFadeInStartTime = 0;

export let isStoppingFallback = false;

// Encoder nativo (LAME-FFI). Si está activo, reemplaza proceso master ffmpeg.
let nativeEncoder: { encoder: LameEncoder } | null = null;

function shuffle(array: string[]) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = array[i]!;
    array[i] = array[j]!;
    array[j] = temp;
  }
}

// =============================================================
// 3. POOL DE BUFFERS PCM (evita allocations en hot path)
// =============================================================
// mixSamples y applyVolume son llamadas ~48 veces/segundo durante
// crossfades/fades. Antes allocateaban un ArrayBuffer nuevo por
// llamada, presionando el GC. Este pool rota N ArrayBuffers
// pre-asignados al tamaño máximo visto. Después de writeToMaster()
// (write + flush síncronos al pipe kernel) el buffer es seguro de
// reutilizar.
const PCM_POOL_SIZE = 4;
const pcmPool: (ArrayBuffer | null)[] = new Array(PCM_POOL_SIZE).fill(null);
let pcmPoolIdx = 0;
let pcmMaxBytes = 0;

function acquirePcmBuffer(byteLength: number): ArrayBuffer {
  if (byteLength > pcmMaxBytes) {
    pcmMaxBytes = byteLength;
    for (let i = 0; i < PCM_POOL_SIZE; i++) {
      pcmPool[i] = new ArrayBuffer(pcmMaxBytes);
    }
  }
  const buf = pcmPool[pcmPoolIdx]!;
  pcmPoolIdx = (pcmPoolIdx + 1) % PCM_POOL_SIZE;
  return buf;
}

// =============================================================
// 4. CACHÉ PERSISTENTE DE METADATOS FFPROBE
// =============================================================
// Evita spawmear ffprobe por cada canción nueva, especialmente en
// loops de playlist corta donde la misma canción se repite. La
// clave es la ruta absoluta del archivo; se invalida por mtime.
const META_CACHE_FILE = ".meta-cache.json";
const metaCache = new Map<string, { title: string; artist: string; duration: number; mtime: number }>();
let metaCacheDirty = false;
let metaCacheLoaded = false;

function loadMetaCache() {
  if (metaCacheLoaded) return;
  metaCacheLoaded = true;
  try {
    const raw = fs.readFileSync(META_CACHE_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && typeof (v as any).mtime === "number") {
          metaCache.set(k, v as any);
        }
      }
      rtmpLog.debug(`[Meta Cache] Loaded ${metaCache.size} metadata cached from ${META_CACHE_FILE}.`);
    }
  } catch {
    // No existe o inválido - empezar vacío
  }
}

function persistMetaCache() {
  if (!metaCacheDirty) return;
  try {
    const obj: Record<string, { title: string; artist: string; duration: number; mtime: number }> = {};
    for (const [k, v] of metaCache) obj[k] = v;
    fs.writeFileSync(META_CACHE_FILE, JSON.stringify(obj));
    metaCacheDirty = false;
  } catch {
    // noop
  }
}

// =============================================================
// 5. MEZCLADORES MATEMÁTICOS DE PCM (TypedArrays)
// =============================================================
function mixSamples(chunkA: Uint8Array, volA: number, chunkB: Uint8Array, volB: number): Uint8Array {
  const samplesA = new Int16Array(chunkA.buffer, chunkA.byteOffset, chunkA.byteLength / 2);
  const samplesB = new Int16Array(chunkB.buffer, chunkB.byteOffset, chunkB.byteLength / 2);

  const length = Math.max(samplesA.length, samplesB.length);
  const byteLength = length * 2;
  const outBuffer = acquirePcmBuffer(byteLength);
  const outSamples = new Int16Array(outBuffer, 0, length);

  // Recorrer la parte solapada sin chequeo de undefined (fast path)
  const minLen = Math.min(samplesA.length, samplesB.length);
  for (let i = 0; i < minLen; i++) {
    let mixed = (samplesA[i]! * volA) + (samplesB[i]! * volB);
    if (mixed > 32767) mixed = 32767;
    else if (mixed < -32768) mixed = -32768;
    outSamples[i] = mixed;
  }
  // Cola del stream más largo (sin mezclar, solo volumen)
  if (samplesA.length > minLen) {
    for (let i = minLen; i < length; i++) {
      outSamples[i] = samplesA[i]! * volA;
    }
  } else if (samplesB.length > minLen) {
    for (let i = minLen; i < length; i++) {
      outSamples[i] = samplesB[i]! * volB;
    }
  }

  return new Uint8Array(outBuffer, 0, byteLength);
}

function applyVolume(chunk: Uint8Array, volume: number): Uint8Array {
  if (volume === 1.0) return chunk;
  if (volume === 0.0) return new Uint8Array(chunk.length);

  const byteLength = chunk.byteLength;
  const outBuffer = acquirePcmBuffer(byteLength);
  const outSamples = new Int16Array(outBuffer, 0, byteLength / 2);
  const inSamples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);

  for (let i = 0; i < outSamples.length; i++) {
    const scaled = Math.round(inSamples[i]! * volume);
    outSamples[i] = Math.max(-32768, Math.min(32767, scaled));
  }
  return new Uint8Array(outBuffer, 0, byteLength);
}

function writeToMaster(chunk: Uint8Array) {
  // Opus tier - siempre escribe PCM crudo (o procesado) al encoder opus si está habilitado
  // Se hace primero para que opus tenga loudnorm vía ffmpeg -af si audioProcessing
  if (config.opusTierEnabled && state.opusProcess?.stdin) {
    try {
      state.opusProcess.stdin.write(chunk);
      state.opusProcess.stdin.flush();
    } catch {
      /* noop */
    }
  }

  if (nativeEncoder) {
    // --- Modo nativo: LAME FFI (sin DSP) ---
    const frameBytes = 4; // stereo s16le = 4 bytes por frame
    const alignedLen = Math.floor(chunk.byteLength / frameBytes) * frameBytes;
    if (alignedLen === 0) return;

    const pcm = new Int16Array(
      chunk.buffer,
      chunk.byteOffset,
      alignedLen / 2,
    );

    const mp3 = nativeEncoder.encoder.encode(pcm);
    if (mp3.length > 0) {
      bitrateDetector.feed(mp3);
      broadcast(mp3);
    }
  } else if (state.masterProcess?.stdin) {
    // --- Modo ffmpeg (fallback) ---
    try {
      state.masterProcess.stdin.write(chunk);
      state.masterProcess.stdin.flush();
    } catch {
      /* noop */
    }
  }
}

export function reshufflePlaylist() {
  shuffle(fallbackPlaylist);
  currentPlaylistIndex = 0;
  rtmpLog.debug("[Fallback Playlist] Playlist reshuffled on API request.");
  if ((deckA.process || deckB.process) && !state.isBroadcasting) {
    stopFallback();
  }
}

async function getFileMetadata(file: string) {
  const isUrl = /^(https?|rtmp):\/\//i.test(file);
  if (isUrl) {
    const urlName = file.split("/").pop() || "Stream Externo";
    return {
      title: urlName.substring(0, 60),
      artist: "Web Stream",
      duration: 0,
    };
  }

  loadMetaCache();

  // Cache lookup: si tenemos el metadato y el mtime coincide, devolverlo sin ffprobe
  let mtime = 0;
  try {
    const stat = fs.statSync(file);
    mtime = stat.mtimeMs;
    const cached = metaCache.get(file);
    if (cached && cached.mtime === mtime) {
      return { title: cached.title, artist: cached.artist, duration: cached.duration };
    }
  } catch {
    // Si stat falla, no podemos usar la caché pero intentamos ffprobe igual
  }

  try {
    const proc = Bun.spawn([
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format_tags=title,artist:format=duration",
      "-of",
      "json",
      file,
    ]);
    const text = await new Response(proc.stdout).text();
    const data = JSON.parse(text);
    const tags = data.format?.tags || {};
    const duration = Number(data.format?.duration) || 0;
    const meta = {
      title: tags.title || tags.TITLE || "",
      artist: tags.artist || tags.ARTIST || "",
      duration,
    };

    // Guardar en caché persistente
    if (mtime > 0) {
      metaCache.set(file, { ...meta, mtime });
      metaCacheDirty = true;
      persistMetaCache();
    }

    return meta;
  } catch (err) {
    rtmpLog.debug("Error reading metadata with ffprobe:", (err as Error).message);
    return { title: "", artist: "", duration: 0 };
  }
}

function getAudioFilesRecursive(dir: string): string[] {
  let results: string[] = [];
  try {
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const filePath = `${dir}/${file}`;
      const stat = fs.statSync(filePath);
      if (stat && stat.isDirectory()) {
        results = results.concat(getAudioFilesRecursive(filePath));
      } else if (/\.(mp3|flac|wav|m4a|aac|ogg)$/i.test(file)) {
        results.push(filePath);
      }
    }
  } catch (err) {
    // Si hay un error leyendo una subcarpeta (por ejemplo, permisos), lo ignoramos para continuar con el resto
  }
  return results;
}

function initializeFallbackSource() {
  if (!config.fallbackSource) return;

  try {
    const stat = fs.statSync(config.fallbackSource);
    if (stat.isDirectory()) {
      const audioFiles = getAudioFilesRecursive(config.fallbackSource);

      if (audioFiles.length === 0) {
        rtmpLog.info(`🔇 No music files in "${config.fallbackSource}" — playing silence until you go live.`);
        fallbackPlaylist = [];
        return;
      }

      fallbackPlaylist = audioFiles;
      shuffle(fallbackPlaylist);
      currentPlaylistIndex = 0;
      isPlaylistInitialized = true;
      rtmpLog.info(`🎵 Found ${audioFiles.length} songs in "${config.fallbackSource}"`);
    } else {
      fallbackPlaylist = [config.fallbackSource];
      currentPlaylistIndex = 0;
      isPlaylistInitialized = true;
      rtmpLog.info(`🎵 Found 1 song: ${config.fallbackSource}`);
    }
  } catch (err) {
    rtmpLog.info(`🔇 Music folder "${config.fallbackSource}" not found — playing silence until you go live.`);
    rtmpLog.debug(`FALLBACK_SOURCE stat failed: ${(err as Error).message}`);
    fallbackPlaylist = [];
  }
}

// =============================================================
// 3b. FILE WATCHER — Detección en caliente de cambios en la carpeta fallback
// =============================================================
let playlistWatcher: fs.FSWatcher | null = null;
let rescanDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let lastKnownFiles: string[] = [];
const RESCAN_DEBOUNCE_MS = 500;
const POLL_INTERVAL_MS = 5000;

/**
 * Compara la lista actual de archivos con la caché y dispara rescan si hay cambios.
 */
function pollForChanges() {
  if (!config.fallbackSource || !isPlaylistInitialized) return;

  try {
    const stat = fs.statSync(config.fallbackSource);
    if (!stat.isDirectory()) return;

    const currentFiles = getAudioFilesRecursive(config.fallbackSource);
    const prevFiles = lastKnownFiles;

    if (prevFiles.length === 0) {
      lastKnownFiles = currentFiles;
      return;
    }

    // Comparación rápida por longitud y contenido
    const sameLength = currentFiles.length === prevFiles.length;
    const sameContent = sameLength && currentFiles.every((f, i) => f === prevFiles[i]);

    if (!sameContent) {
      lastKnownFiles = currentFiles;
      // Debounce para evitar múltiples rescans si el watcher también detecta
      if (rescanDebounceTimer) clearTimeout(rescanDebounceTimer);
      rescanDebounceTimer = setTimeout(() => {
        rescanPlaylist();
        rescanDebounceTimer = null;
      }, RESCAN_DEBOUNCE_MS);
    }
  } catch {
    // Silenciar errores de polling
  }
}

/**
 * Re-escanea la carpeta de fallback y reconstruye la playlist.
 * Preserva el orden relativo de las canciones que siguen existentes
 * y ajusta el índice actual para no perder la posición.
 */
function rescanPlaylist() {
  if (!config.fallbackSource || !isPlaylistInitialized) return;

  try {
    const stat = fs.statSync(config.fallbackSource);
    if (!stat.isDirectory()) return;

    const newFiles = getAudioFilesRecursive(config.fallbackSource);
    lastKnownFiles = newFiles; // Actualizar caché

    const oldFiles = new Set(fallbackPlaylist);

    // Detectar cambios
    const added = newFiles.filter((f) => !oldFiles.has(f));
    const removed = fallbackPlaylist.filter((f) => !newFiles.includes(f));

    if (added.length === 0 && removed.length === 0) return; // Sin cambios reales

    // Loggear cambios
    for (const f of added) {
      rtmpLog.debug(`[Playlist Watch] + Song added: ${f.split("/").pop()}`);
    }
    for (const f of removed) {
      rtmpLog.debug(`[Playlist Watch] - Song removed: ${f.split("/").pop()}`);
    }

    // Determinar la canción que está sonando ahora mismo para preservar posición
    const currentFile = state.currentTrack?.file;
    const oldIndex = currentPlaylistIndex > 0 ? currentPlaylistIndex - 1 : 0;
    const fileAtIndex = fallbackPlaylist[oldIndex];

    // Reconstruir playlist: mantener orden relativo de las que siguen, añadir nuevas al final
    const existingInOrder = fallbackPlaylist.filter((f) => newFiles.includes(f));
    const trulyNew = added; // Ya están en newFiles pero no en oldFiles
    fallbackPlaylist.length = 0;
    fallbackPlaylist.push(...existingInOrder, ...trulyNew);

    // Reconstruir índice: apuntar a la siguiente canción después de la que estaba sonando
    if (currentFile && newFiles.includes(currentFile)) {
      const idx = fallbackPlaylist.indexOf(currentFile);
      currentPlaylistIndex = (idx + 1) % fallbackPlaylist.length;
    } else if (fileAtIndex && newFiles.includes(fileAtIndex)) {
      const idx = fallbackPlaylist.indexOf(fileAtIndex);
      currentPlaylistIndex = (idx + 1) % fallbackPlaylist.length;
    } else {
      // La canción de referencia ya no existe, ajustar índice
      if (currentPlaylistIndex > fallbackPlaylist.length) {
        currentPlaylistIndex = 0;
      }
    }

    rtmpLog.debug(
      `[Playlist Watch] Playlist rebuilt: ${removed.length} removed, ${added.length} added. Total: ${fallbackPlaylist.length} tracks.`,
    );
  } catch (err) {
    rtmpLog.debug(`[Playlist Watch] Error rescanning folder: ${(err as Error).message}`);
  }
}

/**
 * Inicia el file watcher en la carpeta de fallback.
 * Estrategia híbrida:
 *  1. fs.watch() para cambios instantáneos (funciona en la mayoría de sistemas)
 *  2. Polling cada 5s como safety net (necesario en Docker Windows→Linux)
 */
function startPlaylistWatcher() {
  if (playlistWatcher || !config.fallbackSource) return;

  try {
    const stat = fs.statSync(config.fallbackSource);
    if (!stat.isDirectory()) return;

    // Cachear archivos iniciales para el polling
    lastKnownFiles = getAudioFilesRecursive(config.fallbackSource);

    // 1. fs.watch() — notificación instantánea
    try {
      playlistWatcher = fs.watch(config.fallbackSource, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (!/\.(mp3|flac|wav|m4a|aac|ogg)$/i.test(filename)) return;

        if (rescanDebounceTimer) clearTimeout(rescanDebounceTimer);
        rescanDebounceTimer = setTimeout(() => {
          rescanPlaylist();
          rescanDebounceTimer = null;
        }, RESCAN_DEBOUNCE_MS);
      });
      rtmpLog.debug(`[Playlist Watch] fs.watch() active on: ${config.fallbackSource}`);
    } catch {
      rtmpLog.debug("[Playlist Watch] fs.watch() not available, using polling only.");
    }

    // 2. Polling — safety net cada 5s (necesario en Docker/Windows)
    pollingTimer = setInterval(pollForChanges, POLL_INTERVAL_MS);
    rtmpLog.debug(`[Playlist Watch] Polling active every ${POLL_INTERVAL_MS / 1000}s.`);
  } catch (err) {
    rtmpLog.debug(`[Playlist Watch] Could not watch folder: ${(err as Error).message}`);
  }
}

/**
 * Detiene el file watcher y el polling (llamado en shutdown).
 */
export function stopPlaylistWatcher() {
  if (rescanDebounceTimer) {
    clearTimeout(rescanDebounceTimer);
    rescanDebounceTimer = null;
  }
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
  if (playlistWatcher) {
    playlistWatcher.close();
    playlistWatcher = null;
  }
  rtmpLog.debug("[Playlist Watch] Watcher and polling stopped.");
}

export function startMasterEncoder() {
  if (state.masterProcess || nativeEncoder) {
    if (config.opusTierEnabled && !state.opusProcess) startOpusEncoder();
    return;
  }

  // --- Intentar modo nativo (LAME-FFI sin DSP) solo para MP3 ---
  if (config.streamFormat === "mp3" && config.useNativeLame !== "false" && isNativeLameAvailable()) {
    try {
      const encoder = new LameEncoder(
        48000,
        2,
        config.fallbackBitrateKbps,
        2, // quality 2 = buena calidad (0=mejor, 9=más rápido)
      );
      nativeEncoder = { encoder };
      rtmpLog.debug(
        `[Master Encoder] Native mode active (LAME-FFI) at ${config.fallbackBitrateKbps}kbps. No ffmpeg process.`,
      );
      if (config.opusTierEnabled) startOpusEncoder();
      return;
    } catch (err) {
      rtmpLog.error(
        "[Master Encoder] Error iniciando LAME nativo, fallback a ffmpeg:",
        (err as Error).message,
      );
    }
  }

  // --- Fallback: FFmpeg master encoder ---
  startFfmpegMasterEncoder();
  if (config.opusTierEnabled) startOpusEncoder();
}

function startFfmpegMasterEncoder() {
  const fmt = FORMAT_CONFIG[config.streamFormat];
  rtmpLog.debug(`Starting FFmpeg Master Encoder [${config.streamFormat.toUpperCase()}] at ${config.fallbackBitrateKbps}kbps...`);

  const args = [
    "-loglevel", "warning",
    "-fflags", "nobuffer",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "-i", "pipe:0",
    ...(config.audioProcessing
      ? ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11,compand=attacks=0:decays=1:points=-90/-90|-20/-20|0/-10"]
      : []),
    "-acodec", fmt.codec,
    ...fmt.args(config.fallbackBitrateKbps),
    "-flush_packets", "1",
    "-f", fmt.muxer,
    "-"
  ];

  try {
    state.masterProcess = Bun.spawn(["ffmpeg", ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const reader = state.masterProcess.stdout.getReader();
    
    const processInstance = state.masterProcess;
    processInstance.exited.then((exitCode: number) => {
      if (state.masterProcess === processInstance) {
        rtmpLog.debug(`[Master Encoder] ended (exit ${exitCode})`);
        try {
          reader.cancel();
        } catch {
          /* noop */
        }
        state.masterProcess = null;
      }
    }).catch(() => {});

    pipeMaster(reader);
  } catch (err) {
    rtmpLog.debug(`Master Encoder start failed: ${(err as Error).message}`);
  }
}

async function pipeMaster(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        rtmpLog.debug("Master Encoder output stream closed.");
        break;
      }
      bitrateDetector.feed(value);
      broadcast(value);
    }
  } catch (err) {
    if (!state.shuttingDown) {
      rtmpLog.debug("Error reading Master Encoder output:", (err as Error).message);
    }
  }
}

// --- Opus tier (moonshot per-listener efficiency) ---
export function startOpusEncoder() {
  if (state.opusProcess) return;
  if (!config.opusTierEnabled) return;
  // Verificar codec disponible
  const opusFmt = FORMAT_CONFIG["opus"];
  rtmpLog.debug(`Starting Opus Tier Encoder [OPUS] at ${config.opusTierBitrateKbps}kbps ...`);
  rtmpLog.debug(`[Opus Debug] source pcm 48k s16le stereo -> libopus ${config.opusTierBitrateKbps}k, audioProcessing=${config.audioProcessing}, fallbackBitrate=${config.fallbackBitrateKbps}k`);
  const args = [
    "-loglevel", "warning",
    "-fflags", "nobuffer",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "-i", "pipe:0",
    ...(config.audioProcessing
      ? ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11,compand=attacks=0:decays=1:points=-90/-90|-20/-20|0/-10"]
      : []),
    "-acodec", opusFmt.codec,
    ...opusFmt.args(config.opusTierBitrateKbps),
    "-flush_packets", "1",
    "-f", opusFmt.muxer,
    "-"
  ];
  try {
    state.opusProcess = Bun.spawn(["ffmpeg", ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = state.opusProcess.stdout.getReader();
    const proc = state.opusProcess;
    proc.exited.then((code: number) => {
      if (state.opusProcess === proc) {
        rtmpLog.debug(`[Opus Tier] process ended (exit ${code})`);
        try { reader.cancel(); } catch {}
        state.opusProcess = null;
      }
    }).catch(()=>{});
    pipeOpus(reader);
  } catch (err) {
    rtmpLog.debug("Error starting Opus Tier:", (err as Error).message);
  }
}

let opusPackets = 0;
let opusBytesTotal = 0;
async function pipeOpus(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        rtmpLog.debug("Opus stream closed");
        break;
      }
      // Captura headers OpusHead/OpusTags (primer chunk contiene OggS + OpusHead)
      if (!opusHeaders) {
        const text = new TextDecoder().decode(value.subarray(0, Math.min(value.length, 200)));
        if (text.includes("OpusHead")) {
          // Guarda todo el primer chunk como headers (contiene ambas cabeceras)
          opusHeaders = value.slice();
          rtmpLog.debug(`[Opus Tier] headers captured ${opusHeaders.length}B`);
          rtmpLog.debug(`[Opus Debug] headers hex ${Array.from(value.subarray(0,32)).map(b=>b.toString(16).padStart(2,"0")).join(" ")}`);
        } else if (value.length < 8192) {
          // Primer chunk pequeño sin OpusHead aún, acumular? Por ahora guarda primer chunk
          // No debería pasar, pero por seguridad guarda primer chunk
          opusHeaders = value.slice();
          rtmpLog.debug(`[Opus Tier] headers (fallback) ${opusHeaders.length}B`);
        }
      }
      opusPackets++;
      opusBytesTotal += value.length;
      if (opusPackets % 200 === 0) {
        rtmpLog.debug(`[Opus Debug] pkt ${opusPackets} size ${value.length}B avg ${(opusBytesTotal/opusPackets).toFixed(1)}B total ${(opusBytesTotal/1024).toFixed(1)}KB`);
      }
      broadcastOpus(value);
    }
  } catch (err) {
    if (!state.shuttingDown) rtmpLog.debug(`Error reading Opus: ${(err as Error).message}`);
  }
}

export function stopOpusEncoder() {
  if (!state.opusProcess) return;
  rtmpLog.debug("Stopping Opus Tier...");
  try {
    state.opusProcess.stdin.end();
    state.opusProcess.kill();
  } catch {}
  state.opusProcess = null;
}

export function stopMasterEncoder() {
  // Opus tier
  stopOpusEncoder();

  // --- Modo nativo ---
  if (nativeEncoder) {
    rtmpLog.debug("Stopping Native Master Encoder...");
    const flushed = nativeEncoder.encoder.flush();
    if (flushed.length > 0) {
      bitrateDetector.feed(flushed);
      broadcast(flushed);
    }
    nativeEncoder.encoder.close();
    nativeEncoder = null;
    return;
  }

  // --- Modo ffmpeg ---
  if (!state.masterProcess) return;
  rtmpLog.debug("Stopping FFmpeg Master Encoder...");
  try {
    state.masterProcess.stdin.end();
    state.masterProcess.kill();
  } catch {
    /* noop */
  }
  state.masterProcess = null;
}

let silenceInterval: ReturnType<typeof setInterval> | null = null;

function startSilence() {
  if (silenceInterval) return;
  if (state.isBroadcasting) return;
  startMasterEncoder();
  rtmpLog.debug("Silence generator started (live-only)");
  const silenceChunk = new Uint8Array(4800 * 4); // 100ms s16le stereo 48k
  silenceInterval = setInterval(() => {
    if (state.isBroadcasting || state.shuttingDown) {
      if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
      return;
    }
    writeToMaster(silenceChunk);
  }, 100);
}

export function stopSilence() {
  if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
}

export function setFallbackSource(newSource: string) {
  if ((config as any).fallbackSource === newSource) return;
  (config as any).fallbackSource = newSource;
  process.env.FALLBACK_SOURCE = newSource;
  // Reset playlist so it rescans new folder
  isPlaylistInitialized = false;
  fallbackPlaylist.length = 0;
  currentPlaylistIndex = 0;
  stopPlaylistWatcher();
  stopFallback();
  stopSilence();
  // startFallback will re-init with new source (or silence if empty)
  startFallback();
}

export function startFallback() {
  // Ensure silence stops when music starts (fix: silence and fallback both writing to master caused rapid switching)
  stopSilence();
  // No fallback: live-only silence
  if (!config.fallbackSource || config.fallbackSource.trim() === "") {
    rtmpLog.info("🔇 No music — playing silence until you go live");
    startSilence();
    return;
  }

  let currentDeck = activeDeck === "A" ? deckA : deckB;
  if (currentDeck.process) {
    // Si el deck activo ya está reproduciendo, cargamos en el deck inactivo (para crossfade)
    currentDeck = activeDeck === "A" ? deckB : deckA;
  }
  if (currentDeck.process) return;

  if (state.fallbackPaused) {
    state.currentTrack = null;
    return;
  }

  if (!isPlaylistInitialized) {
    initializeFallbackSource();
    startPlaylistWatcher();
  }

  startMasterEncoder();

  let fileToPlay = "";
  if (state.fallbackQueue.length > 0) {
    fileToPlay = state.fallbackQueue.shift()!;
  } else {
    if (fallbackPlaylist.length === 0) {
      // already logged friendly message in initializeFallbackSource / startSilence
      rtmpLog.debug("Fallback playlist empty — silence");
      startSilence();
      return;
    }
    fileToPlay = fallbackPlaylist[currentPlaylistIndex]!;
    currentPlaylistIndex++;
    if (currentPlaylistIndex >= fallbackPlaylist.length) {
      rtmpLog.debug("[Fallback Playlist] End of list. Reshuffling...");
      shuffle(fallbackPlaylist);
      currentPlaylistIndex = 0;
    }
  }

  const cleanName = fileToPlay.split("/").pop() || "Desconocido";
  rtmpLog.debug(`[Deck ${currentDeck.id}] Loading track: ${cleanName}`);

  currentDeck.currentTrackFile = fileToPlay;

  getFileMetadata(fileToPlay).then((meta) => {
    state.currentTrack = {
      file: fileToPlay,
      title: meta.title || cleanName.replace(/\.[^/.]+$/, ""),
      artist: meta.artist || "Artista Desconocido",
      duration: meta.duration,
      startedAt: Date.now(),
    };
  });

  const args = [
    "-loglevel", "warning",
    "-fflags", "nobuffer",
    "-re",
    "-i", fileToPlay,
    "-vn",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "-"
  ];

  try {
    currentDeck.process = Bun.spawn(["ffmpeg", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const reader = currentDeck.process.stdout.getReader();
    pipeFallback(currentDeck, reader);
  } catch (err) {
    rtmpLog.debug(`Error starting FFmpeg on Deck ${currentDeck.id}: ${(err as Error).message}`);
  }
}

// =============================================================
// 4. BUCLE DE INGESTA DE FALLBACK (RELOJ CONDUCIDO POR EVENTOS)
// =============================================================
async function pipeFallback(deck: Deck, reader: ReadableStreamDefaultReader<Uint8Array>) {
  const processInstance = deck.process;
  if (processInstance) {
    processInstance.exited.then((exitCode: number) => {
      if (deck.process === processInstance && !transitionStarted) {
        rtmpLog.debug(`[Deck ${deck.id}] Process ended (exitCode: ${exitCode}).`);
        try {
          reader.cancel();
        } catch {
          /* noop */
        }
      }
    }).catch(() => {});
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Si este deck es el secundario, simplemente almacenamos en búfer y no escribimos al maestro.
      // El deck primario (reloj) consumirá este búfer en sus fundidos.
      if (activeDeck !== deck.id) {
        deck.buffer.push(value);
        continue;
      }

      // Si este deck es el primario (conductor del reloj de ingesta):
      if (!state.isBroadcasting) {
        if (transitionStarted) {
          // Fundido cruzado activo entre Deck A y Deck B
          const elapsed = Date.now() - crossfadeStartTime;
          const progress = Math.min(1.0, elapsed / (config.crossfadeSeconds * 1000));
          
          // Equal-power crossfade (cosine) - potencia constante, evita dip -3dB de linear y pico por ganancia
          // Solo se ejecuta durante ~2s, coste extra ~2x cos por chunk (~48Hz) despreciable
          const volOut = Math.cos(progress * Math.PI * 0.5);
          const volIn = Math.cos((1 - progress) * Math.PI * 0.5);

          const nextDeck = deck.id === "A" ? deckB : deckA;
          const otherChunk = nextDeck.buffer.pull(value.length);
          const mixed = mixSamples(value, volOut, otherChunk, volIn);

          writeToMaster(mixed);

          if (progress >= 1.0) {
            transitionStarted = false;
            // Detener el deck saliente (este deck)
            const oldDeck = deck;
            activeDeck = nextDeck.id; // El nuevo deck pasa a ser el primario
            
            setTimeout(() => {
              if (oldDeck.process) {
                try { oldDeck.process.kill(); } catch {}
                oldDeck.process = null;
                oldDeck.currentTrackFile = null;
                oldDeck.buffer.clear();
              }
            }, 50);
          }
        } else if (isFallbackFadeInActive) {
          // Fundido de entrada suave (después de desconexión de OBS) - low-latency usa 0.2s
          const fadeSec = config.lowLatency ? config.crossfadeLiveSeconds : config.crossfadeSeconds;
          const elapsed = Date.now() - fallbackFadeInStartTime;
          const progress = Math.min(1.0, elapsed / (fadeSec * 1000));

          const faded = applyVolume(value, progress);
          writeToMaster(faded);

          if (progress >= 1.0) {
            isFallbackFadeInActive = false;
          }
        } else {
          // Reproducción normal al 100% de volumen
          writeToMaster(value);

          // Monitorear final de tema para disparar crossfade
          if (state.currentTrack && state.currentTrack.duration > 0) {
            const elapsed = (Date.now() - state.currentTrack.startedAt) / 1000;
            const remaining = state.currentTrack.duration - elapsed;

            if (remaining <= config.crossfadeSeconds && !transitionStarted) {
              transitionStarted = true;
              crossfadeStartTime = Date.now();
              rtmpLog.debug(`[Crossfade] Track ending. Crossfading from Deck ${deck.id}.`);
              
              // Iniciar el siguiente en el deck inactivo
              startFallback();
            }
          }
        }
      }
    }
  } catch (err) {
    if (!isStoppingFallback) {
      rtmpLog.debug(`Error reading Deck stream ${deck.id}: ${(err as Error).message}`);
    }
  } finally {
    const wasIntentionallyStopped = deck.process === null;
    deck.process = null;
    deck.currentTrackFile = null;
    deck.buffer.clear();

    if (!state.isBroadcasting && !state.shuttingDown && !wasIntentionallyStopped) {
      if (activeDeck === deck.id && !transitionStarted) {
        // Caso normal: deck terminó sin crossfade activo
        activeDeck = activeDeck === "A" ? "B" : "A";
        startFallback();
      } else if (activeDeck === deck.id && transitionStarted) {
        // FIX: Deck terminó durante un crossfade — completar la transición
        rtmpLog.debug(`[Deck ${deck.id}] Process ended during crossfade. Completing transition.`);
        transitionStarted = false;
        activeDeck = deck.id === "A" ? "B" : "A";
        const newDeck = activeDeck === "A" ? deckA : deckB;
        newDeck.buffer.clear();
        if (!newDeck.process) {
          startFallback();
        }
      }
    }
  }
}

export function stopFallback() {
  isStoppingFallback = true;
  if (deckA.process) {
    try { deckA.process.kill(); } catch {}
    deckA.process = null;
  }
  if (deckB.process) {
    try { deckB.process.kill(); } catch {}
    deckB.process = null;
  }
  deckA.buffer.clear();
  deckB.buffer.clear();
  
  state.currentTrack = null;
  
  isStoppingFallback = false;
}

export function actionSkipFallback() {
  rtmpLog.debug("[API] Skip request received.");
  stopFallback();
  transitionStarted = false;
  isFallbackFadeInActive = false;

  setTimeout(() => {
    if (!state.isBroadcasting && !state.shuttingDown) {
      activeDeck = activeDeck === "A" ? "B" : "A";
      startFallback();
    }
  }, 100);
}

// =============================================================
// 5. BUCLE DE EN VIVO DE OBS (RELOJ CONDUCIDO POR RED RTMP)
// =============================================================
export async function runRtmpListener() {
  startMasterEncoder();

  // Detección de flaps: si RTMP se desconecta muchas veces en poco tiempo,
  // se ignora la fuente durante un periodo de cooldown para no romper
  // el audio de respaldo con idas y venidas continuas.
  const flapWindowMs = config.lowLatency ? 10000 : 30000;
  const flapMaxCount = config.lowLatency ? 5 : 3;
  const flapCooldownMs = config.lowLatency ? 5000 : 60000;
  let disconnectTimestamps: number[] = [];
  let rtmpCooldownUntil = 0;

  while (true) {
    if (state.shuttingDown) break;

    if (Date.now() < rtmpCooldownUntil) {
      rtmpLog.warn(`[RTMP] In cooldown due to flaps. Ignoring connections until ${new Date(rtmpCooldownUntil).toISOString()}`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    rtmpLog.debug(`Waiting for RTMP connection from OBS on rtmp://${config.host}:${config.rtmpPort}/live/${config.rtmpStreamKey}`);

    const args = [
      "-loglevel", "warning",
      "-fflags", "nobuffer",
      "-listen", "1",
      "-i", `rtmp://${config.host}:${config.rtmpPort}/live/${config.rtmpStreamKey}`,
      "-vn",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "-"
    ];

    try {
      state.sourceProcess = Bun.spawn(["ffmpeg", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });

      state.sourceConnected = true;
      const reader = state.sourceProcess.stdout.getReader();

      const processInstance = state.sourceProcess;
      processInstance.exited.then((exitCode: number) => {
        if (state.sourceProcess === processInstance) {
          rtmpLog.debug(`[RTMP] process ended (exit ${exitCode})`);
          try {
            reader.cancel();
          } catch {
            /* noop */
          }
        }
      }).catch(() => {});

      // No pasar a "vivo" hasta recibir audio de forma sostenida. Esto filtra
      // conexiones breves/sondas que provocan cortes en el respaldo.
      let firstAudioAt = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value.byteLength > 0) {
          state.totalBytesReceived += value.byteLength;
          if (firstAudioAt === 0) firstAudioAt = Date.now();
          const sustained = config.lowLatency ? true : (Date.now() - firstAudioAt) >= config.rtmpMinLiveSeconds * 1000;

          if (!state.isBroadcasting && sustained) {
            state.isBroadcasting = true;
            stopSilence();
            liveTransitionStartTime = Date.now();
            isLiveTransitionActive = config.crossfadeLiveSeconds > 0;
            const rtmpLiveMsg = config.lowLatency ? "RTMP LIVE! (low-latency instant)" : `RTMP connection established and live (after ${config.rtmpMinLiveSeconds}s sustained audio)`;
            rtmpLog.info(rtmpLiveMsg);

            state.currentTrack = null;
          }
        } else {
          firstAudioAt = 0; // Reiniciar conteo si hay un vacío de audio
        }

        if (state.isBroadcasting) {
          if (isLiveTransitionActive) {
            // Fundido cruzado de entrada (Música de fondo -> En Vivo) - lowLatency 0.2s
            const elapsed = Date.now() - liveTransitionStartTime;
            const progress = Math.min(1.0, elapsed / (config.crossfadeLiveSeconds * 1000));

            const currentMusicDeck = activeDeck === "A" ? deckA : deckB;
            const fallbackChunk = currentMusicDeck.buffer.pull(value.length);

            // Equal-power crossfade live (mismo coste despreciable, solo durante transición)
            const volLive = Math.cos((1 - progress) * Math.PI * 0.5);
            const volFallback = Math.cos(progress * Math.PI * 0.5);
            const mixed = mixSamples(value, volLive, fallbackChunk, volFallback);
            writeToMaster(mixed);

            if (progress >= 1.0) {
              isLiveTransitionActive = false;
              stopFallback(); // Apagar procesos físicos de fallback de fondo
            }
          } else {
            // Emisión directa
            writeToMaster(value);
          }
        }
      }
    } catch (err) {
      rtmpLog.debug("Error in RTMP FFmpeg process:", (err as Error).message);
    } finally {
      const wasBroadcasting = state.isBroadcasting;
      rtmpLog.debug("RTMP source disconnected. Cleaning up...");
      state.isBroadcasting = false;
      state.sourceConnected = false;
      state.detectedBitrateKbps = null;
      state.detectedSampleRate = null;
      bitrateDetector.reset();

      if (state.sourceProcess) {
        try {
          state.sourceProcess.kill();
        } catch {
          /* noop */
        }
        state.sourceProcess = null;
      }

      // Detección de flaps
      const now = Date.now();
      disconnectTimestamps = disconnectTimestamps.filter((t) => now - t < flapWindowMs);
      disconnectTimestamps.push(now);
      if (disconnectTimestamps.length > flapMaxCount) {
        rtmpCooldownUntil = now + flapCooldownMs;
        rtmpLog.warn(`[RTMP] Too many rapid disconnections (${disconnectTimestamps.length} en ${flapWindowMs / 1000}s). Entering cooldown ${flapCooldownMs / 1000}s.`);
        disconnectTimestamps = [];
      }

      if (!state.shuttingDown && wasBroadcasting) {
        // Only resume fallback if we were live
        isFallbackFadeInActive = config.lowLatency ? config.crossfadeLiveSeconds > 0 : config.crossfadeSeconds > 0;
        fallbackFadeInStartTime = Date.now();
        startFallback();
      }
    }

    await new Promise((r) => setTimeout(r, config.lowLatency ? 200 : 1000));
  }
}

// =============================================================
// 6. BUCLE SRT (reemplazo RTMP sin plan B - UDP, 0-RTT, sin HOL)
// =============================================================
export async function runSrtListener() {
  startMasterEncoder();

  const flapWindowMs = config.lowLatency ? 10000 : 30000;
  const flapMaxCount = config.lowLatency ? 5 : 3;
  const flapCooldownMs = config.lowLatency ? 5000 : 60000;
  let disconnectTimestamps: number[] = [];
  let srtCooldownUntil = 0;

  while (true) {
    if (state.shuttingDown) break;

    if (Date.now() < srtCooldownUntil) {
      rtmpLog.debug(`[SRT] cooldown until ${new Date(srtCooldownUntil).toISOString()}`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    // SRT ready is debug only (TUI shows status via side panel, not log spam)
    rtmpLog.debug(`[SRT] listener restart (port ${config.srtPort})`);
    rtmpLog.debug(`SRT listener srt://${config.host}:${config.srtPort}?streamid=live/${config.rtmpStreamKey}`);

    const args = [
      "-loglevel", "warning",
      "-fflags", "nobuffer",
      "-i", `srt://${config.host}:${config.srtPort}?mode=listener&transtype=live${config.lowLatency ? "&latency=20&rcvlatency=20&peerlatency=20" : ""}`,
      "-vn",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "-"
    ];

    try {
      state.sourceProcess = Bun.spawn(["ffmpeg", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });

      state.sourceConnected = true;
      const reader = state.sourceProcess.stdout.getReader();
      const proc = state.sourceProcess;
      proc.exited.then((code: number) => {
        if (state.sourceProcess === proc) {
          rtmpLog.debug(`[SRT] process ended (exit ${code})`);
          try { reader.cancel(); } catch {}
        }
      }).catch(()=>{});

      rtmpLog.debug(`[SRT] connected, waiting for audio`);

      let firstAudioAt = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > 0) {
          state.totalBytesReceived += value.byteLength;
          if (firstAudioAt === 0) {
            firstAudioAt = Date.now();
            rtmpLog.debug(`[SRT] first audio ${value.byteLength}B`);
          }
          const sustained = config.lowLatency ? true : (Date.now() - firstAudioAt) >= config.rtmpMinLiveSeconds * 1000;
          if (!state.isBroadcasting && sustained) {
            state.isBroadcasting = true;
            stopSilence();
            liveTransitionStartTime = Date.now();
            isLiveTransitionActive = config.crossfadeLiveSeconds > 0;
            const liveMsg = config.lowLatency ? "🔴 LIVE — you're on air!" : `🔴 LIVE (after ${config.rtmpMinLiveSeconds}s)`;
            rtmpLog.info(liveMsg);
            state.currentTrack = null;
          }
        } else {
          firstAudioAt = 0;
        }
        if (state.isBroadcasting) {
          if (isLiveTransitionActive) {
            const elapsed = Date.now() - liveTransitionStartTime;
            const progress = Math.min(1.0, elapsed / (config.crossfadeLiveSeconds * 1000));
            const curDeck = activeDeck === "A" ? deckA : deckB;
            const fbChunk = curDeck.buffer.pull(value.length);
            const volLive = Math.cos((1 - progress) * Math.PI * 0.5);
            const volFb = Math.cos(progress * Math.PI * 0.5);
            const mixed = mixSamples(value, volLive, fbChunk, volFb);
            writeToMaster(mixed);
            if (progress >= 1.0) {
              isLiveTransitionActive = false;
              stopFallback();
            }
          } else {
            writeToMaster(value);
          }
        }
      }
    } catch (err) {
      rtmpLog.debug("Error SRT:", (err as Error).message);
    } finally {
      const wasBroadcasting = state.isBroadcasting;
      rtmpLog.debug("SRT source disconnected. Cleaning up...");
      state.isBroadcasting = false;
      state.sourceConnected = false;
      state.detectedBitrateKbps = null;
      state.detectedSampleRate = null;
      bitrateDetector.reset();
      if (state.sourceProcess) {
        try { state.sourceProcess.kill(); } catch {}
        state.sourceProcess = null;
      }
      const now = Date.now();
      disconnectTimestamps = disconnectTimestamps.filter(t => now - t < flapWindowMs);
      disconnectTimestamps.push(now);
      if (disconnectTimestamps.length > flapMaxCount) {
        srtCooldownUntil = now + flapCooldownMs;
        rtmpLog.debug(`[SRT] too many flaps (${disconnectTimestamps.length}) cooldown ${flapCooldownMs/1000}s`);
        disconnectTimestamps = [];
      }
      if (!state.shuttingDown && wasBroadcasting) {
        // Only resume fallback if we were actually live — otherwise we were already on fallback, don't restart it
        isFallbackFadeInActive = config.lowLatency ? config.crossfadeLiveSeconds > 0 : config.crossfadeSeconds > 0;
        fallbackFadeInStartTime = Date.now();
        startFallback();
      }
    }
    await new Promise(r=>setTimeout(r, config.lowLatency ? 200 : 1000));
  }
}

```

---

## `src/bitrate-detector.ts`

```ts
import { config } from "./config";
import { rtmpLog } from "./logger";

export interface Mp3FrameInfo {
  bitrateKbps: number;
  sampleRate: number;
}

const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1];
const MPEG2_LAYER3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1];
const SAMPLE_RATES_MPEG1 = [44100, 48000, 32000, -1];
const SAMPLE_RATES_MPEG2 = [22050, 24000, 16000, -1];
const SAMPLE_RATES_MPEG25 = [11025, 12000, 8000, -1];

function findMp3FrameInfo(buf: Uint8Array): Mp3FrameInfo | null {
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] !== 0xff) continue;
    const b2 = buf[i + 1];
    if (b2 === undefined || (b2 & 0xe0) !== 0xe0) continue;

    const versionBits = (b2 >> 3) & 0b11;
    const layerBits = (b2 >> 1) & 0b11;
    if (versionBits === 0b01 || layerBits !== 0b01) continue;

    const b3 = buf[i + 2];
    if (b3 === undefined) continue;
    const bitrateIndex = (b3 >> 4) & 0x0f;
    const sampleRateIndex = (b3 >> 2) & 0b11;
    if (bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 0b11) continue;

    const isMpeg1 = versionBits === 0b11;
    const bitrateKbps = (isMpeg1 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES)[bitrateIndex];
    if (bitrateKbps === undefined || bitrateKbps <= 0) continue;

    const sampleRate = isMpeg1
      ? SAMPLE_RATES_MPEG1[sampleRateIndex]
      : versionBits === 0b10
        ? SAMPLE_RATES_MPEG2[sampleRateIndex]
        : SAMPLE_RATES_MPEG25[sampleRateIndex];
    if (sampleRate === undefined || sampleRate <= 0) continue;

    return { bitrateKbps, sampleRate };
  }
  return null;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

export class BitrateDetector {
  private acc: Uint8Array | null = null;
  private done = false;
  private readonly maxAccBytes = 8192;

  constructor(private readonly onDetected: (info: Mp3FrameInfo) => void) { }

  feed(chunk: Uint8Array): void {
    if (this.done) return;

    // Para formatos no-MP3, usar bitrate de config directamente
    if (config.streamFormat !== "mp3") {
      this.done = true;
      this.onDetected({ bitrateKbps: config.fallbackBitrateKbps, sampleRate: 48000 });
      return;
    }

    this.acc = this.acc ? concatBytes(this.acc, chunk) : chunk;

    const info = findMp3FrameInfo(this.acc);
    if (info) {
      this.done = true;
      this.acc = null;
      this.onDetected(info);
      return;
    }

    if (this.acc.byteLength > this.maxAccBytes) {
      this.done = true;
      this.acc = null;
      rtmpLog.warn(
        `No se pudo autodetectar el bitrate del MP3 tras ${this.maxAccBytes} bytes; ` +
        `usando predeterminado de ${config.fallbackBitrateKbps}kbps`
      );
    }
  }

  reset(): void {
    this.acc = null;
    this.done = false;
  }
}
export const bitrateDetector = new BitrateDetector((info) => {
  rtmpLog.debug(`Detected real bitrate: ${info.bitrateKbps}kbps @ ${info.sampleRate}Hz`);
});

```

---

## `src/broadcaster.ts`

```ts
import { state } from "./state";
import { preBuffer, preBufferOpus } from "./pre-buffer";
import { httpLog } from "./logger";
import { chunkWithIcy } from "./icy-metadata";

const MAX_SLOW_STRIKES = 5;

export function evictClient(id: string, reason: string): void {
  const client = state.clients.get(id);
  if (!client) return;
  try {
    client.controller.close();
  } catch {
    /* noop */
  }
  state.clients.delete(id);
  httpLog.info(`Listener ${id} disconnected (${reason}). Active: ${state.clients.size}`);
}

function getCurrentTitle(): string {
  return state.currentTrack
    ? `${state.currentTrack.artist} - ${state.currentTrack.title}`
    : "";
}

export function broadcast(chunk: Uint8Array): void {
  preBuffer.push(chunk);

  for (const [id, client] of state.clients) {
    if (client.tier !== "mp3") continue;
    try {
      if (client.icy) {
        const pieces = chunkWithIcy(chunk, client.icy, getCurrentTitle());
        for (const piece of pieces) {
          client.controller.enqueue(piece);
        }
      } else {
        client.controller.enqueue(chunk);
      }
    } catch (err) {
      evictClient(id, `fallo al enviar datos: ${(err as Error).message}`);
      continue;
    }

    client.bytesSent += chunk.byteLength;
    state.totalBytesSent += chunk.byteLength;

    const desiredSize = client.controller.desiredSize;
    if (desiredSize !== null && desiredSize < 0) {
      client.slowStrikes++;
      if (client.slowStrikes >= MAX_SLOW_STRIKES) {
        evictClient(id, "cannot keep up with stream (buffer saturated)");
      }
    } else {
      client.slowStrikes = 0;
    }
  }
}

export function broadcastOpus(chunk: Uint8Array): void {
  preBufferOpus.push(chunk);

  for (const [id, client] of state.clients) {
    if (client.tier !== "opus") continue;
    try {
      // Opus via Ogg no usa icy
      client.controller.enqueue(chunk);
    } catch (err) {
      evictClient(id, `fallo al enviar datos (opus): ${(err as Error).message}`);
      continue;
    }

    client.bytesSent += chunk.byteLength;
    state.totalBytesSentOpus += chunk.byteLength;

    const desiredSize = client.controller.desiredSize;
    if (desiredSize !== null && desiredSize < 0) {
      client.slowStrikes++;
      if (client.slowStrikes >= MAX_SLOW_STRIKES) {
        evictClient(id, "cannot keep up with stream opus (buffer saturated)");
      }
    } else {
      client.slowStrikes = 0;
    }
  }
}

```

---

## `src/cli.ts`

```ts
#!/usr/bin/env bun
// =============================================================
// BunRadio — CLI prompts for ports, then opens dashboard
// =============================================================
import fs from "fs";
import path from "path";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`Invalid ${name}=${raw}`);
  return n;
}

async function ask(question: string, def: string): Promise<string> {
  // If we have piped lines (e.g., printf "8082\n" | ), use them
  const piped = getPipedLines();
  if (piped.length > pipedIdx) {
    const v = piped[pipedIdx++]!.trim();
    console.log(`${question} [${def}]: ${v} (piped)`);
    return v === "" ? def : v;
  }
  const isTTY = !!process.stdin.isTTY;
  if (!isTTY) {
    console.log(`${question}: ${def} (non-TTY, using default)`);
    return def;
  }
  try {
    const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
    const ans: string = await new Promise(res => {
      const to = setTimeout(() => { try { rl.close(); } catch {}; res(""); }, 30000);
      rl.question(`${question} [${def}]: `, (a: string) => { clearTimeout(to); rl.close(); res(a); });
    });
    const trimmed = String(ans ?? "").trim();
    return trimmed === "" ? def : trimmed;
  } catch {
    console.log(`${question}: ${def} (no TTY, using default)`);
    return def;
  }
}

function isValidPort(v: string): boolean {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

// Piped input handling (e.g., printf "8082\n8083\n" | bun run)
let pipedLines: string[] | null = null;
let pipedIdx = 0;
function getPipedLines(): string[] {
  if (pipedLines !== null) return pipedLines;
  pipedLines = [];
  if (process.stdin.isTTY) return pipedLines;
  try {
    // Try to read piped data synchronously if available (non-blocking check)
    const stat = fs.fstatSync(0);
    if (stat.isFIFO() || stat.isFile()) {
      const data = fs.readFileSync(0, "utf-8");
      pipedLines = data.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
      // If we consumed stdin, we need to restore it for later readline? For now, just use pipedLines
    }
  } catch {}
  return pipedLines;
}

// Defaults
const defDashboard = String(envInt("DASHBOARD_PORT", envInt("PORT", 8080)));
const defOutput = String(envInt("OUTPUT_PORT", envInt("STREAM_PORT", Number(defDashboard))));
const defSrt = String(envInt("SRT_PORT", 1936));

console.log("");
console.log("  ╔══════════════════════════════════════════════════╗");
console.log("  ║           ◉  B U N R A D I O  — Setup          ║");
console.log("  ╚══════════════════════════════════════════════════╝");
console.log("");

// Prompt for ports — dashboard, outputs, SRT
let dashboardPort = defDashboard;
let outputPort = defOutput;
let srtPort = defSrt;

{
  let v = await ask("Dashboard port (web UI)", defDashboard);
  while (!isValidPort(v)) { console.log("  ✖ Port must be 1-65535"); v = await ask("Dashboard port (web UI)", defDashboard); }
  dashboardPort = v;
}
{
  // Default for outputs to the just-entered dashboard port (so they match unless user changes)
  const defOut2 = outputPort === defOutput ? dashboardPort : outputPort;
  let v = await ask("Outputs port (streams /mp3 and /opus)", defOut2);
  while (!isValidPort(v)) { console.log("  ✖ Port must be 1-65535"); v = await ask("Outputs port (streams /mp3 and /opus)", defOut2); }
  outputPort = v;
}
{
  let v = await ask("OBS input port (SRT ingest)", defSrt);
  while (!isValidPort(v)) { console.log("  ✖ Port must be 1-65535"); v = await ask("OBS input port (SRT ingest)", defSrt); }
  srtPort = v;
}
console.log("");

// Set env for config.ts (must be before import)
process.env.DASHBOARD_PORT = dashboardPort;
process.env.OUTPUT_PORT = outputPort;
process.env.STREAM_PORT = outputPort;
process.env.PORT = dashboardPort;
process.env.SRT_PORT = srtPort;

// Also persist to .env if user wants? Not for now, just runtime

// Load config after env is set (dynamic import so it picks up new env)
const { config } = await import("./config");

// Small delay to ensure config is loaded

// Start radio
await import("./index-rtmp.ts");

// Give server a moment to bind, then open browser
const dashUrl = `http://localhost:${config.dashboardPort}/`;
const mp3Url = `http://localhost:${config.outputPort}/mp3`;
const opusUrl = `http://localhost:${config.outputPort}/opus`;
const srtUrl = `srt://localhost:${config.srtPort}?streamid=live/${config.rtmpStreamKey}`;

console.log("");
console.log(`  ✓ Dashboard: ${dashUrl}`);
console.log(`  ✓ MP3:       ${mp3Url}`);
console.log(`  ✓ OPUS:      ${opusUrl}`);
console.log(`  ✓ SRT:       ${srtUrl}`);
console.log("");

if (process.stdin.isTTY && process.stdout.isTTY) {
  console.log("  Opening dashboard in browser...");
  const url = dashUrl;
  try {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", url] : [url];
    Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore" });
  } catch (e) {
    console.log(`  Could not open browser automatically. Open ${url} manually.`);
  }
  // Also try xdg-open as fallback
  try {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
    }
  } catch {}
}

// Keep alive
setInterval(() => {}, 1000);

```

---

## `src/config.ts`

```ts
import crypto from "crypto";
import { type StreamFormat, validateFormat } from "./format-config";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  httpPort: number; // dashboard + streams (back-compat, same as dashboardPort)
  dashboardPort: number;
  outputPort: number;
  rtmpPort: number;
  srtPort: number;
  host: string;
  maxListeners: number;
  preBufferBytes: number;
  corsOrigin: string;
  logLevel: LogLevel;
  fallbackBitrateKbps: number;
  fallbackSource: string;
  audioProcessing: boolean;
  crossfadeSeconds: number;
  crossfadeLiveSeconds: number;
  rtmpStreamKey: string;
  rtmpMinLiveSeconds: number;
  useNativeLame: "auto" | "true" | "false";
  useNativeDecode: "auto" | "true" | "false";
  streamFormat: StreamFormat;
  // Moonshot tier opus: per-listener efficiency
  opusTierEnabled: boolean;
  opusTierBitrateKbps: number;
  lowLatency: boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Environment variable ${name} invalid: "${raw}" (expected a non-negative integer)`);
  }
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const val = process.env[name];
  if (!val) return fallback;
  if (val !== "true" && val !== "false") {
    throw new Error(`Environment variable ${name} invalid: "${val}" (expected "true" or "false")`);
  }
  return val === "true";
}

function findFreePort(start: number, exclude: number[]): number {
  let port = start;
  while (exclude.includes(port)) port++;
  return port;
}

function generateStreamKey(): string {
  return crypto.randomBytes(16).toString("hex");
}

function loadConfig(): Config {
  const rtmpKey = process.env.RTMP_STREAM_KEY || generateStreamKey();
  // Dashboard (web) and outputs (streams) can be same or separate — user is prompted via CLI
  const dashboardPort = envInt("DASHBOARD_PORT", envInt("PORT", 8080));
  const outputPort = envInt("OUTPUT_PORT", envInt("STREAM_PORT", dashboardPort));
  const httpPort = dashboardPort; // back-compat alias
  const rtmpPort = envInt("RTMP_PORT", findFreePort(1935, [dashboardPort, outputPort]));
  const srtPort = envInt("SRT_PORT", findFreePort(1936, [dashboardPort, outputPort, rtmpPort]));
  const host = process.env.HOST || "0.0.0.0";

  const allPorts = [dashboardPort, outputPort, rtmpPort, srtPort];
  // Only enforce distinct for SRT/RTMP vs dashboard/output if they are not intentionally the same for dashboard/output
  if (new Set([rtmpPort, srtPort, dashboardPort]).size !== 3 && dashboardPort !== outputPort) {
    // dashboard and output may be same, that's ok; but RTMP/SRT must be distinct
  }
  if (rtmpPort === srtPort) {
    throw new Error("RTMP_PORT y SRT_PORT deben ser distintos");
  }

  const lowLatency = envBool("LOW_LATENCY", true);
  const cfg: Config = {
    httpPort,
    dashboardPort,
    outputPort,
    rtmpPort,
    srtPort,
    host,
    maxListeners: envInt("MAX_LISTENERS", 500),
    preBufferBytes: envInt("PREBUFFER_BYTES", lowLatency ? 8192 : 65536),
    corsOrigin: process.env.CORS_ORIGIN || "*",
    logLevel: (process.env.LOG_LEVEL as LogLevel) || "info",
    fallbackBitrateKbps: envInt("STREAM_BITRATE_KBPS", 320),
    fallbackSource: process.env.FALLBACK_SOURCE !== undefined ? process.env.FALLBACK_SOURCE : "",
    audioProcessing: envBool("AUDIO_PROCESSING", false),
    crossfadeSeconds: envInt("CROSSFADE_SECONDS", lowLatency ? 1 : 2),
    crossfadeLiveSeconds: envInt("CROSSFADE_LIVE_SECONDS", lowLatency ? 0.2 : 2),
    rtmpStreamKey: rtmpKey,
    rtmpMinLiveSeconds: envInt("RTMP_MIN_LIVE_SECONDS", lowLatency ? 0 : 10),
    useNativeLame: (() => {
      const v = process.env.USE_NATIVE_LAME;
      if (v === "true" || v === "false") return v;
      return "auto";
    })(),
    useNativeDecode: (() => {
      const v = process.env.USE_NATIVE_DECODE;
      if (v === "true" || v === "false") return v;
      return "auto";
    })(),
    streamFormat: validateFormat((process.env.STREAM_FORMAT as StreamFormat) || "mp3"),
    opusTierEnabled: envBool("ENABLE_OPUS_TIER", true),
    opusTierBitrateKbps: envInt("OPUS_TIER_BITRATE_KBPS", 96),
    lowLatency,
  };

  return cfg;
}

export const config = loadConfig();

```

---

## `src/decode-ffi.ts`

```ts
import { dlopen, ptr } from "bun:ffi";
import { rtmpLog } from "./logger";

// =============================================================
// DECODIFICADOR NATIVO — FFI libavformat + libavcodec + swresample
// =============================================================
// Elimina los procesos ffmpeg de los decks: el binario abre el archivo,
// demuxa y decodifica en proceso (los MISMOS codecs que usa ffmpeg CLI,
// así que el resultado es idéntico). El patrón ya está validado con
// LAME-FFI (encoder MP3 in-process).
//
// Los offsets de struct se verificaron con un probe C contra las libs
// del runtime (alpine 3.20 / ffmpeg 6.1, libavformat 60):
//   AVFormatContext.streams=48  nb_streams=44
//   AVStream.codecpar=16
//   AVCodecParameters: format=28  channel_layout=104  channels=112  sample_rate=116
//   AVFrame: data=0  linesize=64  nb_samples=112  format=116
//   AVPacket.stream_index=36
// Para otras versiones se derivan: avcodec = avformat, avutil = -2, swresample = -56
// (mapping válido para ffmpeg 4.x-7.x). Si nada carga, se usa ffmpeg CLI.

const AVFORMAT_STREAMS = 48;
const AVFORMAT_NB_STREAMS = 44;
const AVSTREAM_CODECPAR = 16;
const CODEPAR_FORMAT = 28;
const CODEPAR_CHANNEL_LAYOUT = 104;
const CODEPAR_CHANNELS = 112;
const CODEPAR_SAMPLE_RATE = 116;
const AVFRAME_NB_SAMPLES = 112;
const AVPACKET_STREAM_INDEX = 36;
// (verificados con probe C contra libavformat 60 / ffmpeg 6.1)

// enum AVMediaType: AVMEDIA_TYPE_AUDIO = 1
const AVMEDIA_TYPE_AUDIO = 1;
// enum AVSampleFormat: AV_SAMPLE_FMT_S16 = 1
const AV_SAMPLE_FMT_S16 = 1;
// AV_CH_LAYOUT_STEREO = 0x3, AV_CH_LAYOUT_MONO = 0x4
const AV_CH_LAYOUT_STEREO = 0x3;
const AV_CH_LAYOUT_MONO = 0x4;
const AVERROR_EAGAIN = -11;

// Salida: 48000 Hz × 2ch × 2 bytes = 192 KB/s
const PCM_BYTES_PER_SECOND = 192_000;
// Margen para el frame más grande posible (24.5K samples × 4B ≈ 96KB)
const ACCUM_CAPACITY = PCM_BYTES_PER_SECOND + 98_304;

interface Symbols {
  avformat_open_input: (fmtCtxOut: number, path: number, fmt: number | null, opts: number | null) => number;
  avformat_find_stream_info: (fmtCtx: number, opts: number | null) => number;
  av_find_best_stream: (fmtCtx: number, type: number, wanted: number, related: number, decoderOut: number, flags: number | null) => number;
  avformat_close_input: (fmtCtxOut: number) => void;
  av_read_frame: (fmtCtx: number, pkt: number) => number;
  avcodec_alloc_context3: (decoder: number) => number;
  avcodec_parameters_to_context: (avctx: number, codecpar: number) => number;
  avcodec_open2: (avctx: number, decoder: number, opts: number | null) => number;
  avcodec_send_packet: (avctx: number, pkt: number | null) => number;
  avcodec_receive_frame: (avctx: number, frame: number) => number;
  avcodec_free_context: (avctxOut: number) => void;
  av_packet_alloc: () => number;
  av_packet_unref: (pkt: number) => void;
  av_packet_free: (pktOut: number) => void;
  av_frame_alloc: () => number;
  av_frame_unref: (frame: number) => void;
  av_frame_free: (frameOut: number) => void;
  swr_alloc_set_opts: (s: number | null, outLayout: number, outFmt: number, outRate: number, inLayout: number, inFmt: number, inRate: number, logOff: number, logCtx: number | null) => number;
  swr_convert: (s: number, out: number, outCount: number, input: number, inCount: number) => number;
  swr_init: (s: number) => number;
  swr_free: (sOut: number) => void;
}

let symbols: Symbols | null = null;

function writePtr(buf: Uint8Array, value: number) {
  new DataView(buf.buffer).setBigUint64(0, BigInt(value), true); // little-endian (x86-64)
}

// =============================================================
// LECTURA DE MEMORIA C
// toArrayBuffer() devuelve basura con punteros nativos en Bun 1.3
// (bug conocido). Leemos memoria C vía memcpy de libc (FFI), que es
// una primitiva trivial y fiable: copia a un scratch Uint8Array y se
// interpreta con DataView (little-endian, x86-64).
// =============================================================
let memcpy: ((dst: number, src: number, n: number) => number) | null = null;

function loadMemcpy(): boolean {
  const LIBC_PATHS = [
    "libc.so.6",
    "/lib/ld-musl-x86_64.so.1",
    "/usr/lib/libc.musl-x86_64.so.1",
    "libc.musl-x86_64.so.1",
  ];
  for (const path of LIBC_PATHS) {
    try {
      const libc = dlopen(path, { memcpy: { args: ["ptr", "ptr", "usize"] as const, returns: "ptr" as const } });
      memcpy = libc.symbols.memcpy as unknown as (dst: number, src: number, n: number) => number;
      return true;
    } catch {
      // siguiente ruta
    }
  }
  return false;
}

const scratch = new Uint8Array(8);

function readPtr(p: number): number {
  memcpy!(ptr(scratch), p, 8);
  return Number(new DataView(scratch.buffer).getBigUint64(0, true));
}

function readI32(p: number, off: number): number {
  memcpy!(ptr(scratch), p + off, 4);
  return new DataView(scratch.buffer).getInt32(0, true);
}

function readI64(p: number, off: number): number {
  memcpy!(ptr(scratch), p + off, 8);
  return Number(new DataView(scratch.buffer).getBigInt64(0, true));
}

function loadLibs(): Symbols | null {
  const majors = ["60", "61", "59", "58"];
  const baseDirs = ["/usr/lib", "/usr/lib/x86_64-linux-gnu"];
  for (const major of majors) {
    const avcodec = major;
    const avutil = String(Number(major) - 2);
    const swr = String(Number(major) - 56);
    for (const dir of baseDirs) {
      const paths = {
        avformat: `${dir}/libavformat.so.${major}`,
        avcodec: `${dir}/libavcodec.so.${avcodec}`,
        avutil: `${dir}/libavutil.so.${avutil}`,
        swresample: `${dir}/libswresample.so.${swr}`,
      };
      try {
        // Cada lib se abre SOLO con sus propios símbolos (dlopen falla si
        // pide un símbolo que la lib no exporta).
        const defAvformat = {
          avformat_open_input: { args: ["ptr", "ptr", "ptr", "ptr"] as const, returns: "i32" as const },
          avformat_find_stream_info: { args: ["ptr", "ptr"] as const, returns: "i32" as const },
          av_find_best_stream: { args: ["ptr", "i32", "i32", "i32", "ptr", "i32"] as const, returns: "i32" as const },
          avformat_close_input: { args: ["ptr"] as const, returns: "void" as const },
          av_read_frame: { args: ["ptr", "ptr"] as const, returns: "i32" as const },
        };
        const defAvcodec = {
          avcodec_alloc_context3: { args: ["ptr"] as const, returns: "ptr" as const },
          avcodec_parameters_to_context: { args: ["ptr", "ptr"] as const, returns: "i32" as const },
          avcodec_open2: { args: ["ptr", "ptr", "ptr"] as const, returns: "i32" as const },
          avcodec_send_packet: { args: ["ptr", "ptr"] as const, returns: "i32" as const },
          avcodec_receive_frame: { args: ["ptr", "ptr"] as const, returns: "i32" as const },
          avcodec_free_context: { args: ["ptr"] as const, returns: "void" as const },
          av_packet_alloc: { args: [] as const, returns: "ptr" as const },
          av_packet_unref: { args: ["ptr"] as const, returns: "void" as const },
          av_packet_free: { args: ["ptr"] as const, returns: "void" as const },
        };
        const defAvutil = {
          av_frame_alloc: { args: [] as const, returns: "ptr" as const },
          av_frame_unref: { args: ["ptr"] as const, returns: "void" as const },
          av_frame_free: { args: ["ptr"] as const, returns: "void" as const },
        };
        const defSwr = {
          swr_alloc_set_opts: { args: ["ptr", "i64", "i32", "i32", "i64", "i32", "i32", "i32", "ptr"] as const, returns: "ptr" as const },
          swr_convert: { args: ["ptr", "ptr", "i32", "ptr", "i32"] as const, returns: "i32" as const },
          swr_init: { args: ["ptr"] as const, returns: "i32" as const },
          swr_free: { args: ["ptr"] as const, returns: "void" as const },
        };
        const libFmt = dlopen(paths.avformat, defAvformat);
        const libCodec = dlopen(paths.avcodec, defAvcodec);
        const libUtil = dlopen(paths.avutil, defAvutil);
        const libSwr = dlopen(paths.swresample, defSwr);
        const all = { ...libFmt.symbols, ...libCodec.symbols, ...libUtil.symbols, ...libSwr.symbols } as unknown as Symbols;
        rtmpLog.info(`[NativeDecoder] libavformat ${major} cargada (${paths.avformat}). Decks sin proceso ffmpeg.`);
        return all;
      } catch {
        // probar siguiente versión
      }
    }
  }
  rtmpLog.warn("[NativeDecoder] No se pudo cargar libavformat. Decks con ffmpeg CLI.");
  return null;
}

export function isNativeDecodeAvailable(): boolean {
  return symbols !== null;
}

interface TrackState {
  fmtCtx: number;
  avctx: number;
  swr: number;
  frame: number;
  pkt: number;
  streamIdx: number;
  fmtBuf: Uint8Array;
  ctxBuf: Uint8Array;
  swrBuf: Uint8Array;
  frameBuf: Uint8Array;
  pktBuf: Uint8Array;
  swrOutPtr: Uint8Array;
}

function openTrack(path: string): TrackState {
  if (!symbols) throw new Error("libavformat no cargada");
  const S = symbols;

  const fmtBuf = new Uint8Array(8);
  // Bun 1.3 no acepta strings en args FFI: ruta NUL-terminada como buffer
  // (avformat la copia internamente, el buffer puede liberarse tras la llamada)
  const pathBuf = new TextEncoder().encode(path + "\0");
  let r = S.avformat_open_input(ptr(fmtBuf), ptr(pathBuf), null, null);
  if (r < 0) throw new Error(`avformat_open_input falló (${r})`);
  const fmtCtx = readPtr(ptr(fmtBuf));

  r = S.avformat_find_stream_info(fmtCtx, null);
  if (r < 0) throw new Error(`avformat_find_stream_info falló (${r})`);

  const streams = readPtr(fmtCtx + AVFORMAT_STREAMS);
  const decBuf = new Uint8Array(8);
  const streamIdx = S.av_find_best_stream(fmtCtx, AVMEDIA_TYPE_AUDIO, -1, -1, ptr(decBuf), null);
  if (streamIdx < 0) throw new Error("archivo sin flujo de audio");
  const decoder = readPtr(ptr(decBuf));

  const avctx = S.avcodec_alloc_context3(decoder);
  if (!avctx) throw new Error("avcodec_alloc_context3");

  const streamPtr = readPtr(streams + streamIdx * 8);
  const codecpar = readPtr(streamPtr + AVSTREAM_CODECPAR);
  r = S.avcodec_parameters_to_context(avctx, codecpar);
  if (r < 0) throw new Error(`avcodec_parameters_to_context falló (${r})`);
  r = S.avcodec_open2(avctx, decoder, null);
  if (r < 0) throw new Error(`avcodec_open2 falló (${r})`);

  const inFmt = readI32(codecpar, CODEPAR_FORMAT);
  const inRate = readI32(codecpar, CODEPAR_SAMPLE_RATE);
  let inLayout = readI64(codecpar, CODEPAR_CHANNEL_LAYOUT);
  if (!inLayout) {
    inLayout = readI32(codecpar, CODEPAR_CHANNELS) === 1 ? AV_CH_LAYOUT_MONO : AV_CH_LAYOUT_STEREO;
  }

  const swr = S.swr_alloc_set_opts(null, AV_CH_LAYOUT_STEREO, AV_SAMPLE_FMT_S16, 48000, inLayout, inFmt, inRate, 0, null);
  if (!swr) throw new Error("swr_alloc_set_opts falló");
  if (S.swr_init(swr) < 0) throw new Error("swr_init falló");

  const frame = S.av_frame_alloc();
  const pkt = S.av_packet_alloc();
  if (!frame || !pkt) throw new Error("av_frame_alloc/av_packet_alloc falló");

  const ctxBuf = new Uint8Array(8);
  const swrBuf = new Uint8Array(8);
  const frameBuf = new Uint8Array(8);
  const pktBuf = new Uint8Array(8);
  writePtr(ctxBuf, avctx);
  writePtr(swrBuf, swr);
  writePtr(frameBuf, frame);
  writePtr(pktBuf, pkt);

  return { fmtCtx, avctx, swr, frame, pkt, streamIdx, fmtBuf, ctxBuf, swrBuf, frameBuf, pktBuf, swrOutPtr: new Uint8Array(8) };
}

function closeTrack(st: TrackState) {
  const S = symbols;
  if (!S) return;
  try { S.swr_free(ptr(st.swrBuf)); } catch { /* noop */ }
  try { S.avcodec_free_context(ptr(st.ctxBuf)); } catch { /* noop */ }
  try { S.av_frame_free(ptr(st.frameBuf)); } catch { /* noop */ }
  try { S.av_packet_free(ptr(st.pktBuf)); } catch { /* noop */ }
  try { S.avformat_close_input(ptr(st.fmtBuf)); } catch { /* noop */ }
}

// =============================================================
// NATIVE DECODER — misma interfaz que un proceso ffmpeg:
//   .stdout.getReader() → chunks PCM s16le 48k stereo (1/s, 192KB)
//   .kill()  .exited
// El pacing es por reloj (equivalente a -re): emite 1s de audio por
// segundo de pared, autocorrigiendo el drift.
// =============================================================
export class NativeDecoder {
  readonly exited: Promise<number>;
  stdout!: ReadableStream<Uint8Array>;
  private cancelled = false;

  constructor(path: string) {
    const st = openTrack(path); // síncrono: lanza Error si no se puede abrir

    this.exited = new Promise<number>((resolve) => {
      this.stdout = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.run(st, controller)
            .then(() => resolve(0))
            .catch((err) => {
              rtmpLog.error("[NativeDecoder] error en bucle de decode:", err);
              try { controller.error(err); } catch { /* noop */ }
              resolve(1);
            });
        },
      });
    });
  }

  kill() {
    this.cancelled = true;
  }

  // Acumula frames decodificados en `out` hasta 1s (192KB) o EOF.
  // Devuelve el total acumulado; 0 = EOF sin datos nuevos.
  private fill(st: TrackState, out: Uint8Array, flushedState: { flushed: boolean }): number {
    const S = symbols!;
    let written = 0;
    while (written < PCM_BYTES_PER_SECOND) {
      const r = S.avcodec_receive_frame(st.avctx, st.frame);
      if (r === AVERROR_EAGAIN) {
        const pr = S.av_read_frame(st.fmtCtx, st.pkt);
        if (pr < 0) {
          // Fin del archivo: flush del decoder (packet nulo)
          if (!flushedState.flushed) {
            flushedState.flushed = true;
            S.avcodec_send_packet(st.avctx, null);
          }
          return written;
        }
        if (readI32(st.pkt, AVPACKET_STREAM_INDEX) !== st.streamIdx) continue;
        const sr = S.avcodec_send_packet(st.avctx, st.pkt);
        // avcodec_send_packet NO libera el paquete: sin av_packet_unref,
        // cada paquete (~192KB/s de audio comprimido) se fuga para siempre
        // (~11MB/min de RSS). Mismo criterio con av_frame_unref tras swr.
        S.av_packet_unref(st.pkt);
        if (sr < 0 && sr !== AVERROR_EAGAIN) return written;
        continue; // volver a recibir (si send fue EAGAIN, el receive drena la cola)
      }
      if (r < 0) return written; // EOF del decoder

      const nbSamples = readI32(st.frame, AVFRAME_NB_SAMPLES);
      if (nbSamples <= 0) continue;

      writePtr(st.swrOutPtr, ptr(out) + written);
      const outCount = S.swr_convert(st.swr, ptr(st.swrOutPtr), 48000, st.frame, nbSamples);
      S.av_frame_unref(st.frame); // liberar el búfer del frame decodificado
      if (outCount <= 0) continue;
      written += outCount * 4;
      if (written >= out.length) break; // margen lleno: cortar (no debería pasar)
    }
    return written;
  }

  private async run(st: TrackState, controller: ReadableStreamDefaultController<Uint8Array>) {
    const out = new Uint8Array(ACCUM_CAPACITY);
    const flushedState = { flushed: false };
    let emittedBytes = 0;
    const t0 = performance.now();

    while (!this.cancelled) {
      // Pacing real-time (equivalente a -re): 192 B/ms, en slices de 50ms
      // para que kill() responda en <50ms (antes esperaba hasta 1s el
      // sleep completo, dejando un deck muerto escribiendo un chunk más).
      const targetMs = emittedBytes / 192;
      while (true) {
        const wait = targetMs - (performance.now() - t0);
        if (wait <= 0 || this.cancelled) break;
        await Bun.sleep(Math.min(50, wait));
      }
      if (this.cancelled) break;
      if (controller.desiredSize !== null && controller.desiredSize < -PCM_BYTES_PER_SECOND) {
        await Bun.sleep(100); // consumidor lento: backoff simple
        continue;
      }

      const n = this.fill(st, out, flushedState);
      if (n <= 0) break; // EOF sin datos pendientes

      // Copia 1/s (allocación grande → mmap → el allocator la devuelve al OS)
      const chunk = out.slice(0, n);
      try {
        controller.enqueue(chunk);
      } catch {
        break; // stream cancelado
      }
      emittedBytes += n;
      if (n < PCM_BYTES_PER_SECOND) break; // chunk parcial = fin de pista
    }

    try { controller.close(); } catch { /* noop */ }
    closeTrack(st);
  }
}

symbols = loadLibs();

// memcpy de libc para leer memoria C (toArrayBuffer roto en Bun 1.3)
if (!loadMemcpy()) {
  rtmpLog.warn("[NativeDecoder] No se pudo cargar memcpy de libc. Decks con ffmpeg CLI.");
  symbols = null;
}

```

---

## `src/format-config.ts`

```ts
import { rtmpLog } from "./logger";

export type StreamFormat = "mp3" | "ogg" | "aac" | "flac" | "opus";

export interface FormatConfig {
  codec: string;
  muxer: string;
  mime: string;
  args: (bitrate: number) => string[];
  defaultBitrate: number;
}

export const FORMAT_CONFIG: Record<StreamFormat, FormatConfig> = {
  mp3: {
    codec: "libmp3lame",
    muxer: "mp3",
    mime: "audio/mpeg",
    args: (bitrate) => ["-ab", `${bitrate}k`],
    defaultBitrate: 320,
  },
  ogg: {
    codec: "libvorbis",
    muxer: "ogg",
    mime: "audio/ogg; codecs=vorbis",
    args: () => ["-q:a", "6"],
    defaultBitrate: 128,
  },
  opus: {
    codec: "libopus",
    muxer: "opus",
    mime: "audio/ogg; codecs=opus",
    args: (bitrate) => ["-b:a", `${bitrate}k`],
    defaultBitrate: 128,
  },
  aac: {
    codec: "aac",
    muxer: "adts",
    mime: "audio/aac",
    args: (bitrate) => ["-ab", `${bitrate}k`],
    defaultBitrate: 128,
  },
  flac: {
    codec: "flac",
    muxer: "flac",
    mime: "audio/flac",
    args: () => ["-compression_level", "5"],
    defaultBitrate: 0,
  },
};

export function isCodecAvailable(format: StreamFormat): boolean {
  const codec = FORMAT_CONFIG[format].codec;
  try {
    const proc = Bun.spawnSync(["ffmpeg", "-encoders"], { stdout: "pipe", stderr: "pipe" });
    const output = new TextDecoder().decode(proc.stdout);
    return output.includes(codec);
  } catch {
    return false;
  }
}

export function validateFormat(format: StreamFormat): StreamFormat {
  if (FORMAT_CONFIG[format] && isCodecAvailable(format)) {
    return format;
  }
  rtmpLog.warn(`Codec for "${format}" not available, fallback to MP3`);
  return "mp3";
}

```

---

## `src/http-helpers.ts`

```ts
import { config } from "./config";

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": config.corsOrigin,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS, POST, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Session-Id, MCP-Protocol-Version",
    "Access-Control-Expose-Headers": "MCP-Session-Id, MCP-Protocol-Version",
  };
}

export function checkStreamKey(req: Request): boolean {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice(7) === config.rtmpStreamKey;
}

export function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Admin", Bearer realm="BunRadio"' },
  });
}

export function getClientIp(req: Request, server: Bun.Server<undefined>): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return server.requestIP(req)?.address ?? "unknown";
}

```

---

## `src/http-server.ts`

```ts
import { config } from "./config";
import { state } from "./state";
import { preBuffer, preBufferOpus } from "./pre-buffer";
import { httpLog } from "./logger";

// Rutas literales: /mp3 (320k) y /opus (96k) — solo estas
const STREAM_PATHS = new Set(["/mp3", "/opus"]);
import {
  corsHeaders,
  checkStreamKey,
  unauthorized,
  getClientIp,
} from "./http-helpers";
import {
  deckA,
  deckB,
  activeDeck,
  transitionStarted,
  isStoppingFallback,
  opusHeaders,
} from "./audio-router";

import { StreamableHttpTransport, InMemorySessionAdapter } from "mcp-lite";
import { mcpServer } from "./mcp-server";
import { FORMAT_CONFIG } from "./format-config";
import { type IcyClientState, createIcyState } from "./icy-metadata";

const mcpSessionAdapter = new InMemorySessionAdapter({ maxEventBufferSize: 100 });
const mcpTransport = new StreamableHttpTransport({
  sessionAdapter: mcpSessionAdapter,
});
const handleMcpRequest = mcpTransport.bind(mcpServer);

function generateClientId(): string {
  return crypto.randomUUID();
}

function tryServe(port: number, retries = 5): ReturnType<typeof Bun.serve> {
  for (let p = port; p < port + retries; p++) {
    try {
      const s = Bun.serve({
        hostname: config.host,
        port: p,
        idleTimeout: 0,
        async fetch(req: Request, server: any) { return (globalThis as any).__bunServeFetch(req, server); },
        error(err: any) { httpLog.error("Error in HTTP server:", err); return new Response("Internal Server Error", { status: 500 }); }
      } as any);
      if (p !== port) {
        httpLog.warn(`Port ${port} in use, using ${p} instead`);
        (config as any).httpPort = p;
      }
      return s;
    } catch (e: any) {
      if (e?.code === "EADDRINUSE" || String(e).includes("in use")) {
        httpLog.warn(`Port ${p} in use, trying ${p+1}...`);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to bind HTTP port ${port} after ${retries} tries`);
}

// Store fetch handler for tryServe wrapper
(globalThis as any).__bunServeFetch = async (req: Request, server: any) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  if (path.startsWith("/mcp")) {
    if (!checkStreamKey(req)) return unauthorized();
    const response = await handleMcpRequest(req);
    const headers = new Headers(response.headers);
    for (const [key, val] of Object.entries(corsHeaders())) {
      headers.set(key, val);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  // ---- Stream (literal /mp3 and /opus) ----
  if (STREAM_PATHS.has(path) && (req.method === "GET" || req.method === "HEAD")) {
    if (state.clients.size >= config.maxListeners) {
      return new Response("Server at max listeners", { status: 503, headers: corsHeaders() });
    }

    const isOpus = path === "/opus";
    const tier: "mp3" | "opus" = isOpus ? "opus" : "mp3";

    if (isOpus && !config.opusTierEnabled) {
      return new Response("Opus tier deshabilitado", { status: 404, headers: corsHeaders() });
    }

    const streamHeaders: Record<string, string> = {
      "Content-Type": isOpus ? FORMAT_CONFIG["opus"].mime : FORMAT_CONFIG[config.streamFormat].mime,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Content-Encoding": "identity",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
      ...corsHeaders(),
    };

    const icyMetaRequested = !isOpus && req.headers.get("icy-metadata") === "1";
    let icyState: any;
    if (icyMetaRequested) {
      icyState = createIcyState();
      streamHeaders["icy-metaint"] = String(icyState.metaInterval);
      streamHeaders["icy-name"] = "BunRadio";
      streamHeaders["icy-genre"] = "Various";
      streamHeaders["icy-br"] = String(config.fallbackBitrateKbps);
      streamHeaders["icy-url"] = "";
      streamHeaders["icy-pub"] = "0";
    }
    if (isOpus) streamHeaders["icy-br"] = String(config.opusTierBitrateKbps);
    if (req.method === "HEAD") return new Response(null, { headers: streamHeaders });

    const clientId = generateClientId();
    const ip = getClientIp(req, server);
    const userAgent = req.headers.get("user-agent") || "unknown";
    const chosenPreBuffer = isOpus ? preBufferOpus : preBuffer;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (isOpus && opusHeaders) { try { controller.enqueue(opusHeaders); } catch {} }
        const shouldSendPreBuffer = !config.lowLatency || !state.isBroadcasting;
        if (shouldSendPreBuffer) {
          for (const chunk of chosenPreBuffer.snapshot()) { try { controller.enqueue(chunk); } catch {} }
        } else if (config.lowLatency && state.isBroadcasting) {
          httpLog.debug(`[HTTP] low-latency live: bypass preBuffer`);
        }
        state.clients.set(clientId, { id: clientId, controller, connectedAt: new Date(), ip, userAgent, bytesSent: 0, slowStrikes: 0, icy: icyState, tier });
        state.totalListenersServed++;
        const opusCount = [...state.clients.values()].filter(c=>c.tier==="opus").length;
        const mp3Count = state.clients.size - opusCount;
        httpLog.info(`Listener connected: ${clientId} tier=${tier} desde ${ip} (${state.clients.size} activos mp3:${mp3Count} opus:${opusCount})`);
      },
      cancel() { state.clients.delete(clientId); httpLog.info(`Listener disconnected: ${clientId} tier=${tier} (${state.clients.size} activos)`); },
    }, { highWaterMark: config.lowLatency ? 16 * 1024 : config.preBufferBytes + 256 * 1024 });
    req.signal.addEventListener("abort", () => { state.clients.delete(clientId); });
    return new Response(stream, { headers: streamHeaders });
  }

  // ---- Web UI (TSX — Bun compiles) ----
  if (path === "/" || path === "/index.html") {
    try {
      const html = await Bun.file("public/index.html").text();
      return new Response(html, { headers: { "Content-Type": "text/html", ...corsHeaders() } });
    } catch {
      return new Response("<h1>BUNRADIO</h1><p>Web UI not built — run <code>bun run build</code></p><p><a href='/mp3'>/mp3</a> <a href='/opus'>/opus</a></p>", { headers: { "Content-Type": "text/html", ...corsHeaders() } });
    }
  }
  if (path === "/app.js") {
    try {
      // Bun natively compiles TSX — build on the fly (cached)
      const build = await Bun.build({ entrypoints: ["src/web/App.tsx"], target: "browser", minify: false });
      if (!build.success || !build.outputs[0]) throw new Error("Build failed");
      const js = await build.outputs[0].text();
      return new Response(js, { headers: { "Content-Type": "application/javascript", ...corsHeaders() } });
    } catch (e: any) {
      return new Response(`console.error("Web build failed: ${String(e.message).replace(/"/g, "'")}");`, { headers: { "Content-Type": "application/javascript", ...corsHeaders() } });
    }
  }

  // ---- Web API — control from TSX (no auth for local, uses same as MCP later) ----
  if (path === "/api/fallback" && req.method === "POST") {
    try {
      const { folder } = await req.json() as any;
      const { setFallbackSource } = await import("./audio-router");
      const f = String(folder ?? "").trim();
      setFallbackSource(f);
      return Response.json({ ok: true, message: f === "" ? "Live-only" : `Folder set to ${f}` }, { headers: corsHeaders() });
    } catch (e: any) { return Response.json({ ok: false, message: String(e.message) }, { status: 500, headers: corsHeaders() }); }
  }
  if (path === "/api/queue/add" && req.method === "POST") {
    try {
      const { file } = await req.json() as any;
      const f = String(file ?? "").trim();
      if (!f) throw new Error("file required");
      const { state: st } = await import("./state");
      const { startFallback } = await import("./audio-router");
      // @ts-ignore
      st.fallbackQueue = (st as any).fallbackQueue || [];
      // @ts-ignore
      (st as any).fallbackQueue.push(f);
      try { startFallback(); } catch {}
      return Response.json({ ok: true, message: `Added ${f.split("/").pop()}` }, { headers: corsHeaders() });
    } catch (e: any) { return Response.json({ ok: false, message: String(e.message) }, { status: 500, headers: corsHeaders() }); }
  }
  if (path === "/api/skip" && req.method === "POST") {
    try {
      const { stopFallback, startFallback } = await import("./audio-router");
      // @ts-ignore
      const { state: st } = await import("./state");
      // force skip: stop current and start next
      try { stopFallback(); } catch {}
      // reshuffle index
      setTimeout(() => { try { startFallback(); } catch {} }, 100);
      return Response.json({ ok: true, message: "Skipped" }, { headers: corsHeaders() });
    } catch (e: any) { return Response.json({ ok: false, message: String(e.message) }, { status: 500, headers: corsHeaders() }); }
  }
  if (path === "/api/stop" && req.method === "POST") {
    setTimeout(() => process.exit(0), 200);
    return Response.json({ ok: true, message: "Stopping..." }, { headers: corsHeaders() });
  }

  // ---- Health/Status/Metrics ----
  if (path === "/health") {
    const uptimeSeconds = Math.floor((Date.now() - state.startTime.getTime()) / 1000);
    const mem = process.memoryUsage();
    const fallbackActive = !state.isBroadcasting && state.currentTrack !== null;
    const masterAlive = state.masterProcess !== null;
    const opusAlive = state.opusProcess !== null;
    const sourceAlive = state.sourceProcess !== null;
    const opusCount = [...state.clients.values()].filter(c=>c.tier==="opus").length;
    const mp3Count = state.clients.size - opusCount;
    return Response.json({ status: "ok", uptime: uptimeSeconds, memory: { rss: Math.round(mem.rss/1024/1024), heapTotal: Math.round(mem.heapTotal/1024/1024), heapUsed: Math.round(mem.heapUsed/1024/1024), external: Math.round(mem.external/1024/1024) }, processes: { masterEncoder: masterAlive, opusTier: opusAlive, rtmpSource: sourceAlive }, broadcasting: state.isBroadcasting, sourceConnected: state.sourceConnected, fallback: { active: fallbackActive, paused: state.fallbackPaused, currentTrack: state.currentTrack?.title || null }, listeners: state.clients.size, listenersMp3: mp3Count, listenersOpus: opusCount, maxListeners: config.maxListeners, totalListenersServed: state.totalListenersServed, totalBytesReceived: state.totalBytesReceived, totalBytesSent: state.totalBytesSent, totalBytesSentOpus: state.totalBytesSentOpus, detectedBitrateKbps: state.detectedBitrateKbps, detectedSampleRate: state.detectedSampleRate, tiers: { mp3: { bitrate: config.fallbackBitrateKbps, mime: FORMAT_CONFIG[config.streamFormat].mime }, opus: config.opusTierEnabled ? { bitrate: config.opusTierBitrateKbps, mime: FORMAT_CONFIG["opus"].mime } : null } }, { headers: corsHeaders() });
  }
  if (path === "/debug-state") {
    return Response.json({ activeDeck, transitionStarted, isStoppingFallback, deckA: { hasProcess: deckA.process !== null, currentTrackFile: deckA.currentTrackFile, bufferLength: deckA.buffer.length }, deckB: { hasProcess: deckB.process !== null, currentTrackFile: deckB.currentTrackFile, bufferLength: deckB.buffer.length } }, { headers: corsHeaders() });
  }
  if (path === "/status") {
    const uptimeSeconds = Math.floor((Date.now() - state.startTime.getTime()) / 1000);
    const opusCount = [...state.clients.values()].filter(c=>c.tier==="opus").length;
    return Response.json({ broadcasting: state.isBroadcasting, sourceConnected: state.sourceConnected, listeners: state.clients.size, listenersMp3: state.clients.size - opusCount, listenersOpus: opusCount, maxListeners: config.maxListeners, totalListenersServed: state.totalListenersServed, totalBytesReceived: state.totalBytesReceived, totalBytesSent: state.totalBytesSent, totalBytesSentOpus: state.totalBytesSentOpus, uptimeSeconds, stationName: "BunRadio", detectedBitrateKbps: state.detectedBitrateKbps, detectedSampleRate: state.detectedSampleRate, fallbackBitrateKbps: config.fallbackBitrateKbps, opusTierBitrateKbps: config.opusTierBitrateKbps, opusTierEnabled: config.opusTierEnabled, fallbackActive: !state.isBroadcasting && state.currentTrack !== null }, { headers: corsHeaders() });
  }
  if (path === "/metrics") {
    const opusCount = [...state.clients.values()].filter(c=>c.tier==="opus").length;
    const mp3Count = state.clients.size - opusCount;
    const lines = ["# HELP radio_listeners Oyentes conectados actualmente","# TYPE radio_listeners gauge",`radio_listeners ${state.clients.size}`,"# HELP radio_listeners_mp3 Oyentes mp3","# TYPE radio_listeners_mp3 gauge",`radio_listeners_mp3 ${mp3Count}`,"# HELP radio_listeners_opus Oyentes opus tier","# TYPE radio_listeners_opus gauge",`radio_listeners_opus ${opusCount}`,"# HELP radio_broadcasting 1 si hay una fuente transmitiendo, 0 si no","# TYPE radio_broadcasting gauge",`radio_broadcasting ${state.isBroadcasting ? 1 : 0}`,"# HELP radio_bytes_received_total Bytes totales recibidos de la fuente","# TYPE radio_bytes_received_total counter",`radio_bytes_received_total ${state.totalBytesReceived}`,"# HELP radio_bytes_sent_total Bytes totales enviados a oyentes mp3","# TYPE radio_bytes_sent_total counter",`radio_bytes_sent_total ${state.totalBytesSent}`,"# HELP radio_bytes_sent_opus_total Bytes totales enviados opus tier","# TYPE radio_bytes_sent_opus_total counter",`radio_bytes_sent_opus_total ${state.totalBytesSentOpus}`,"# HELP radio_fallback_active 1 if fallback audio is playing, 0 otherwise","# TYPE radio_fallback_active gauge",`radio_fallback_active ${(!state.isBroadcasting && state.currentTrack !== null) ? 1 : 0}`,"# HELP radio_opus_tier_enabled 1 si opus tier habilitado","# TYPE radio_opus_tier_enabled gauge",`radio_opus_tier_enabled ${config.opusTierEnabled ? 1 : 0}`];
    return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "text/plain; version=0.0.4", ...corsHeaders() } });
  }
  return Response.json({ error: "Not Found" }, { status: 404, headers: corsHeaders() });
};

export const httpServer = tryServe(config.dashboardPort);
export const outputServer = config.outputPort !== config.dashboardPort ? tryServe(config.outputPort) : httpServer;


```

---

## `src/icy-metadata.ts`

```ts
const META_INTERVAL = 65536;

export function buildMetadataBlock(streamTitle: string): Uint8Array {
  const trimmed = streamTitle.slice(0, 400).replace(/'/g, "\\'");
  const encoded = new TextEncoder().encode(`StreamTitle='${trimmed}';StreamUrl='';`);
  const blockSize = Math.ceil((encoded.length + 1) / 16) * 16;
  const buf = new Uint8Array(blockSize + 1);
  buf[0] = blockSize / 16;
  buf.set(encoded, 1);
  return buf;
}

export interface IcyClientState {
  bytesSinceMeta: number;
  metaInterval: number;
}

export function createIcyState(): IcyClientState {
  return {
    bytesSinceMeta: 0,
    metaInterval: META_INTERVAL,
  };
}

export function chunkWithIcy(
  chunk: Uint8Array,
  state: IcyClientState,
  title: string,
): Uint8Array[] {
  if (!title) return [chunk];

  const result: Uint8Array[] = [];
  let offset = 0;

  while (offset < chunk.length) {
    const remaining = chunk.length - offset;
    const space = state.metaInterval - state.bytesSinceMeta;

    if (remaining <= space) {
      const piece = remaining === chunk.length ? chunk : chunk.slice(offset);
      result.push(piece);
      state.bytesSinceMeta += remaining;
      offset = chunk.length;
    } else {
      result.push(chunk.slice(offset, offset + space));
      state.bytesSinceMeta += space;
      offset += space;

      const metaBlock = buildMetadataBlock(title);
      result.push(metaBlock);
      state.bytesSinceMeta = 0;
    }
  }

  return result;
}

```

---

## `src/index-rtmp.ts`

```ts
#!/usr/bin/env bun
// =============================================================
// Radio Server — Ingesta RTMP + Streaming HTTP + Fallback
// -------------------------------------------------------------
// Coordinador principal del servidor.
// =============================================================

import { config } from "./config";
import { sysLog, httpLog } from "./logger";
import { state } from "./state";
import { startFallback, stopFallback, stopMasterEncoder, stopPlaylistWatcher, runSrtListener, stopSilence } from "./audio-router";
import "./http-server"; // Levanta el servidor HTTP automáticamente al importar

// =============================================================
// 1. INICIALIZACIÓN DE FUENTES
// =============================================================

// TUI is the only interface now — no console banner (TUI header shows streams)
if (false) {
  console.log("");
}

// Arrancar audio de respaldo (fallback) inmediatamente
startFallback();

// Arrancar receptor SRT en segundo plano (sin RTMP, sin plan B)
runSrtListener();

// =============================================================
// 2. APAGADO ORDENADO
// =============================================================

function shutdown(signal: string): void {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  sysLog.info(`Signal ${signal} received, shutting down server...`);

  // Detener todos los oyentes de forma limpia
  for (const [, client] of state.clients) {
    try {
      client.controller.close();
    } catch {
      /* noop */
    }
  }
  state.clients.clear();

  // Matar subprocesos de FFmpeg activos
  stopPlaylistWatcher();
  stopFallback();
  stopSilence();
  stopMasterEncoder();

  if (state.sourceProcess) {
    sysLog.info("Stopping SRT receiver...");
    try {
      state.sourceProcess.kill();
    } catch {
      /* noop */
    }
  }

  sysLog.info("Server closed correctly.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  sysLog.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  sysLog.error("Unhandled promise rejection:", reason);
});

```

---

## `src/lame-ffi.ts`

```ts
import { dlopen, ptr } from "bun:ffi";
import { rtmpLog } from "./logger";

// ======================================================// Wrapper Bun.FFI sobre libmp3lame.so — encoding MP3 sin ffmpeg
// ======================================================// Llama directamente a la librería C compartida del sistema,
// sin spawn de procesos, sin pipes stdin/stdout. Esto elimina
// el proceso master ffmpeg (~100MB RSS, ~45% CPU con loudnorm).
//
// La librería ya está en el contenedor: /usr/lib/libmp3lame.so.0
// (instalada como dependencia de `apk add ffmpeg`).

const LIB_PATHS = [
  "/usr/lib/libmp3lame.so.0",
  "/usr/lib/libmp3lame.so",
  "libmp3lame.so.0",
  "libmp3lame.so",
];

interface LameSymbols {
  lame_init: () => number;
  lame_set_in_samplerate: (lame: number, rate: number) => number;
  lame_set_num_channels: (lame: number, channels: number) => number;
  lame_set_brate: (lame: number, brate: number) => number;
  lame_set_quality: (lame: number, quality: number) => number;
  lame_set_out_samplerate: (lame: number, rate: number) => number;
  lame_set_VBR: (lame: number, vbr: number) => number;
  lame_set_VBR_q: (lame: number, q: number) => number;
  lame_init_params: (lame: number) => number;
  lame_encode_buffer_interleaved: (
    lame: number,
    pcm: number,
    numSamples: number,
    mp3buf: number,
    mp3bufSize: number,
  ) => number;
  lame_encode_flush: (
    lame: number,
    mp3buf: number,
    mp3bufSize: number,
  ) => number;
  lame_close: (lame: number) => number;
}

let symbols: LameSymbols | null = null;
let loadAttempted = false;

export function isNativeLameAvailable(): boolean {
  if (symbols) return true;
  if (loadAttempted) return false;
  loadAttempted = true;

  for (const path of LIB_PATHS) {
    try {
      const lib = dlopen(path, {
        lame_init: { args: [], returns: "ptr" },
        lame_set_in_samplerate: { args: ["ptr", "i32"], returns: "i32" },
        lame_set_num_channels: { args: ["ptr", "i32"], returns: "i32" },
        lame_set_brate: { args: ["ptr", "i32"], returns: "i32" },
        lame_set_quality: { args: ["ptr", "i32"], returns: "i32" },
        lame_set_out_samplerate: { args: ["ptr", "i32"], returns: "i32" },
        lame_set_VBR: { args: ["ptr", "i32"], returns: "i32" },
        lame_set_VBR_q: { args: ["ptr", "i32"], returns: "i32" },
        lame_init_params: { args: ["ptr"], returns: "i32" },
        lame_encode_buffer_interleaved: {
          args: ["ptr", "ptr", "i32", "ptr", "i32"],
          returns: "i32",
        },
        lame_encode_flush: { args: ["ptr", "ptr", "i32"], returns: "i32" },
        lame_close: { args: ["ptr"], returns: "i32" },
      });
      symbols = lib.symbols as unknown as LameSymbols;
      rtmpLog.debug(`[LAME-FFI] libmp3lame loaded from ${path}`);
      return true;
    } catch {
      // intentar siguiente ruta
    }
  }
  rtmpLog.warn(
    "[LAME-FFI] Could not load libmp3lame. Using ffmpeg fallback for MP3 encoding.",
  );
  return false;
}

// Anillo de buffers MP3 pre-asignados (diseño "cero allocaciones"):
// la steady-state de un stream 24/7 no debe alocar memoria por chunk.
// encode() escribe en el siguiente slot del anillo y devuelve una vista
// (sin copia). Con los decks emitiendo ~1 chunk/s (asetnsamples), el slot
// se reutiliza tras MP3_SLOT_COUNT encodes (~128s), y la política de
// expulsión de oyentes lentos (highWaterMark 256KB + 5 strikes ≈ ~7s de
// lag máximo) garantiza que ningún oyente lea un slot ya sobrescrito.
// preBuffer (64KB) solo retiene vistas recientes, siempre válidas.
const MP3_SLOT_SIZE = 72 * 1024;
const MP3_SLOT_COUNT = 128;
const EMPTY_MP3 = new Uint8Array(0);

export class LameEncoder {
  private lame = 0;
  private slots: Uint8Array[] = [];
  private slotIdx = 0;
  private closed = false;

  constructor(
    sampleRate: number,
    channels: number,
    bitrateKbps: number,
    quality: number = 2,
    vbrQuality?: number, // si se define 0..9, activa VBR V0..V9 (0=mejor) - mejora calidad/bandwidth sin coste CPU
  ) {
    if (!symbols) throw new Error("libmp3lame no cargada");
    const s = symbols;

    this.lame = s.lame_init();
    if (!this.lame) throw new Error("lame_init() returned NULL");

    s.lame_set_in_samplerate(this.lame, sampleRate);
    s.lame_set_num_channels(this.lame, channels);
    if (vbrQuality !== undefined) {
      // VBR mtrh (4) - mejor calidad variable, bitrate medio ~150-245k para V0 vs CBR 320 fijo
      s.lame_set_VBR(this.lame, 4);
      s.lame_set_VBR_q(this.lame, Math.max(0, Math.min(9, vbrQuality)));
    } else {
      s.lame_set_brate(this.lame, bitrateKbps);
    }
    s.lame_set_quality(this.lame, quality);
    s.lame_set_out_samplerate(this.lame, sampleRate);

    const ret = s.lame_init_params(this.lame);
    if (ret !== 0) {
      s.lame_close(this.lame);
      this.lame = 0;
      throw new Error(`lame_init_params() failed (code ${ret})`);
    }

    // Anillo de slots pre-asignado: ~128 × 72KB ≈ 9MB.
    // Un slot solo se crece (caso raro: chunk PCM gigante) y nunca se
    // libera, evitando cualquier churn en el hot path.
    for (let i = 0; i < MP3_SLOT_COUNT; i++) {
      this.slots[i] = new Uint8Array(MP3_SLOT_SIZE);
    }
  }

  private nextSlot(needed: number): Uint8Array {
    const idx = this.slotIdx;
    this.slotIdx = (this.slotIdx + 1) % MP3_SLOT_COUNT;
    const slot = this.slots[idx]!;
    if (slot.byteLength >= needed) return slot;
    const grown = new Uint8Array(Math.max(needed, slot.byteLength * 2));
    this.slots[idx] = grown;
    return grown;
  }

  /**
   * Encodea PCM interleaved stereo (Int16Array) a MP3.
   * Devuelve una vista de un slot del anillo (sin copia). El slot es
   * seguro de usar por los oyentes hasta que el anillo dé la vuelta
   * (MP3_SLOT_COUNT encodes después).
   */
  encode(pcm: Int16Array): Uint8Array {
    if (this.closed || !this.lame || !symbols) return EMPTY_MP3;

    const numSamples = pcm.length / 2; // frames (stereo interleaved)
    if (numSamples === 0) return EMPTY_MP3;

    const needed = Math.floor(1.25 * numSamples + 7200);
    const slot = this.nextSlot(needed);

    const written = symbols.lame_encode_buffer_interleaved(
      this.lame,
      ptr(pcm),
      numSamples,
      ptr(slot),
      slot.byteLength,
    );

    if (written < 0) {
      rtmpLog.error(`[LAME-FFI] encoding error: ${written}`);
      return EMPTY_MP3;
    }

    return slot.subarray(0, written);
  }

  /**
   * Flush final: devuelve los últimos frames MP3 pendientes.
   */
  flush(): Uint8Array {
    if (this.closed || !this.lame || !symbols) return EMPTY_MP3;

    const slot = this.nextSlot(MP3_SLOT_SIZE);
    const written = symbols.lame_encode_flush(
      this.lame,
      ptr(slot),
      slot.byteLength,
    );

    if (written < 0) return EMPTY_MP3;
    return slot.subarray(0, written);
  }

  close() {
    if (this.closed || !this.lame) return;
    this.closed = true;
    try {
      symbols?.lame_close(this.lame);
    } catch {
      /* noop */
    }
    this.lame = 0;
  }
}

```

---

## `src/logger.ts`

```ts
import { config } from "./config";
import type { LogLevel } from "./config";

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function ts(): string {
  return new Date().toISOString();
}

function appendFileLog(scope: string, level: string, args: unknown[]) {
  try {
    const line = `[${ts()}] ${level} [${scope}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`;
    // No reinicia terminal -- escribe a archivo persistente
    require("fs").appendFileSync("opus-debug.log", line);
    require("fs").appendFileSync("bunradio.log", line);
  } catch {}
}

function makeLogger(scope: string) {
  const enabled = (level: LogLevel) => LOG_LEVELS[level] >= LOG_LEVELS[config.logLevel];
  const isTui = () => process.env.BUNRADIO_TUI === "1";
  return {
    debug: (...args: unknown[]) => {
      if (!enabled("debug")) return;
      if (!isTui()) console.debug(`DEBUG [${scope}]`, ...args);
      appendFileLog(scope, "DEBUG", args);
    },
    info: (...args: unknown[]) => {
      if (!enabled("info")) return;
      if (!isTui()) console.log(`INFO  [${scope}]`, ...args);
      appendFileLog(scope, "INFO", args);
    },
    warn: (...args: unknown[]) => {
      if (!enabled("warn")) return;
      if (!isTui()) console.warn(`WARN  [${scope}]`, ...args);
      appendFileLog(scope, "WARN", args);
    },
    error: (...args: unknown[]) => {
      if (!enabled("error")) return;
      if (!isTui()) console.error(`ERROR [${scope}]`, ...args);
      appendFileLog(scope, "ERROR", args);
    },
  };
}

export const rtmpLog = makeLogger("RTMP");
export const httpLog = makeLogger("HTTP");
export const sysLog = makeLogger("SYS");

```

---

## `src/mcp-server.ts`

```ts
import fs from "fs";
import { McpServer } from "mcp-lite";
import { createInterface } from "readline";
import { state } from "./state";
import { config } from "./config";
import { actionSkipFallback, reshufflePlaylist, startFallback, stopFallback } from "./audio-router";

// Create the MCP server
const server = new McpServer({
  name: "bunradio-mcp-server",
  version: "1.0.0",
});

// 1. Get Status
server.tool("get_status", {
  description: "Get the current status of the radio station, including broadcasting state, listener counts, and active track details",
  handler: async () => {
    try {
      const uptimeSeconds = Math.floor((Date.now() - state.startTime.getTime()) / 1000);
      const status = {
        broadcasting: state.isBroadcasting,
        sourceConnected: state.sourceConnected,
        listeners: state.clients.size,
        maxListeners: config.maxListeners,
        totalListenersServed: state.totalListenersServed,
        totalBytesReceived: state.totalBytesReceived,
        totalBytesSent: state.totalBytesSent,
        uptimeSeconds,
        stationName: "BunRadio",
        detectedBitrateKbps: state.detectedBitrateKbps,
        detectedSampleRate: state.detectedSampleRate,
        fallbackBitrateKbps: config.fallbackBitrateKbps,
        fallbackActive: !state.isBroadcasting && state.currentTrack !== null,
        currentTrack: state.currentTrack,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 2. Get Queue
server.tool("get_queue", {
  description: "Retrieve the current playback priority queue",
  handler: async () => {
    try {
      return {
        content: [{ type: "text", text: JSON.stringify({ queue: state.fallbackQueue }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 3. Push to Queue
server.tool("push_to_queue", {
  description: "Add a local audio file path or remote stream URL (e.g. http/rtmp) to the playback queue",
  inputSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: "Path to the local file or URL to enqueue" }
    },
    required: ["file"]
  },
  handler: async ({ file }: any) => {
    try {
      if (!file || typeof file !== "string") throw new Error("Parameter 'file' invalid");
      state.fallbackQueue.push(file);
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, queue: state.fallbackQueue }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 4. Remove from Queue
server.tool("remove_from_queue", {
  description: "Remove an item from the priority queue by its 0-based index",
  inputSchema: {
    type: "object",
    properties: {
      index: { type: "integer", minimum: 0, description: "The index of the item to remove" }
    },
    required: ["index"]
  },
  handler: async ({ index }: any) => {
    try {
      const idx = Number(index);
      if (Number.isNaN(idx) || idx < 0 || idx >= state.fallbackQueue.length) throw new Error("Parameter 'index' out of range");
      state.fallbackQueue.splice(idx, 1);
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, queue: state.fallbackQueue }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 5. Clear Queue
server.tool("clear_queue", {
  description: "Clear all tracks from the priority queue",
  handler: async () => {
    try {
      state.fallbackQueue = [];
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, queue: [] }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 6. Move in Queue
server.tool("move_in_queue", {
  description: "Move a track in the priority queue from one position to another",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "integer", minimum: 0, description: "Source index of the track" },
      to: { type: "integer", minimum: 0, description: "Destination index of the track" }
    },
    required: ["from", "to"]
  },
  handler: async ({ from, to }: any) => {
    try {
      const f = Number(from);
      const t = Number(to);
      if (Number.isNaN(f) || f < 0 || f >= state.fallbackQueue.length || Number.isNaN(t) || t < 0 || t >= state.fallbackQueue.length) {
        throw new Error("Valores 'from' o 'to' fuera de rango");
      }
      const [movedItem] = state.fallbackQueue.splice(f, 1);
      if (movedItem) state.fallbackQueue.splice(t, 0, movedItem);
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, queue: state.fallbackQueue }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 7. Skip Track
server.tool("skip_track", {
  description: "Skip the current song. Note: Live RTMP streams cannot be skipped, only fallback tracks",
  handler: async () => {
    try {
      if (!state.isBroadcasting && state.currentTrack) {
        actionSkipFallback();
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, message: "Skipping track..." }, null, 2) }],
        };
      }
      throw new Error("Live cannot be skipped, stop stream from OBS or no active track");
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 8. Shuffle Playlist
server.tool("shuffle_playlist", {
  description: "Reshuffle the fallback playlist and restart playback from the first track",
  handler: async () => {
    try {
      reshufflePlaylist();
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 9. List Files
server.tool("list_files", {
  description: "List the available audio files in the local fallback directory configured on the server",
  handler: async () => {
    try {
      if (!config.fallbackSource) return { content: [{ type: "text", text: JSON.stringify({ files: [] }, null, 2) }] };
      const stat = fs.statSync(config.fallbackSource);
      let files: string[] = [];
      if (stat.isDirectory()) {
        files = fs.readdirSync(config.fallbackSource)
          .filter((f) => /\.(mp3|flac|wav|m4a|aac|ogg)$/i.test(f))
          .map((f) => `${config.fallbackSource}/${f}`);
      } else {
        files = [config.fallbackSource];
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ files }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 10. Toggle Fallback
server.tool("toggle_fallback", {
  description: "Toggle (pause or resume) fallback music playback when no live stream is active",
  handler: async () => {
    try {
      state.fallbackPaused = !state.fallbackPaused;
      if (state.fallbackPaused) {
        stopFallback();
      } else {
        startFallback();
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, paused: state.fallbackPaused }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

export { server as mcpServer };

// Stdio transport implementation using readline interface, run only if called directly
if (import.meta.main) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const request = JSON.parse(line);
      const response = await server._dispatch(request);
      if (response) {
        console.log(JSON.stringify(response));
      }
    } catch (error: any) {
      const errResponse = {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${error.message}`,
        },
      };
      console.log(JSON.stringify(errResponse));
    }
  });

  console.error("BunRadio MCP Server is running over Stdio.");
}

```

---

## `src/pre-buffer.ts`

```ts
import { config } from "./config";

export class PreBuffer {
  private chunks: Uint8Array[] = [];
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) { }

  push(chunk: Uint8Array): void {
    if (this.maxBytes <= 0) return;
    this.chunks.push(chunk);
    this.totalBytes += chunk.byteLength;
    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      this.totalBytes -= removed.byteLength;
    }
  }

  snapshot(): Uint8Array[] {
    return [...this.chunks];
  }

  reset(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}

export const preBuffer = new PreBuffer(config.preBufferBytes);
export const preBufferOpus = new PreBuffer(config.preBufferBytes);

```

---

## `src/state.ts`

```ts
import { type IcyClientState } from "./icy-metadata";

export interface RadioClient {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  connectedAt: Date;
  ip: string;
  userAgent: string;
  bytesSent: number;
  slowStrikes: number;
  icy?: IcyClientState;
  tier: "mp3" | "opus";
}

export interface ActiveTrackInfo {
  file: string;
  title: string;
  artist: string;
  duration: number; // en segundos
  startedAt: number; // timestamp ms
}

export const state = {
  clients: new Map<string, RadioClient>(),
  isBroadcasting: false,
  sourceConnected: false,
  sourceProcess: null as any | null,
  masterProcess: null as any | null,
  opusProcess: null as any | null,
  shuttingDown: false,
  startTime: new Date(),
  totalListenersServed: 0,
  totalBytesReceived: 0,
  totalBytesSent: 0,
  totalBytesSentOpus: 0,
  detectedBitrateKbps: null as number | null,
  detectedSampleRate: null as number | null,

  fallbackQueue: [] as string[],
  currentTrack: null as ActiveTrackInfo | null,
  fallbackPaused: false,
};

```

