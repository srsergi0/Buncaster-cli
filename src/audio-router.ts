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
