import fs from "fs";
import path from "path";
import { config } from "./config";
import { rtmpLog } from "./logger";
import { state, type DeckState } from "./state";
import { broadcast, broadcastOpus } from "./broadcaster";
import { bitrateDetector } from "./bitrate-detector";
import { LameEncoder, isNativeLameAvailable } from "./lame-ffi";
import { NativeDecoder, isNativeDecodeAvailable } from "./decode-ffi";
import { FORMAT_CONFIG } from "./format-config";
import { Event, ErrorCode, missingBinaryCode } from "./events";
import { preBufferOpus } from "./pre-buffer";
import { OggPageAssembler, OpusHeaderCollector } from "./ogg";
import { analysisEnabled, getCachedAnalysis, planTrack, requestAnalysis, type TrackPlan } from "./track-analysis";

export let opusHeaders: Uint8Array | null = null;

// =============================================================
// 1. CLASE BUFFER FIFO DE AUDIO PCM & ACUMULADOR DE RESIDUOS
// =============================================================
export class PcmResidueAccumulator {
  private residue: Uint8Array = new Uint8Array(0);

  /**
   * Asegura que solo se entreguen frames completos de 4 bytes (stereo 16-bit).
   * Retiene 1-3 bytes remanentes en memoria para unirlos con el siguiente chunk.
   */
  feed(chunk: Uint8Array): Uint8Array {
    let combined: Uint8Array;
    if (this.residue.length > 0) {
      combined = new Uint8Array(this.residue.length + chunk.length);
      combined.set(this.residue, 0);
      combined.set(chunk, this.residue.length);
    } else {
      combined = chunk;
    }

    const frameBytes = 4;
    const alignedLength = Math.floor(combined.length / frameBytes) * frameBytes;
    const remainder = combined.length - alignedLength;

    if (remainder > 0) {
      this.residue = combined.slice(alignedLength);
    } else {
      this.residue = new Uint8Array(0);
    }

    if (alignedLength === 0) return new Uint8Array(0);
    return combined.subarray(0, alignedLength);
  }

  reset() {
    this.residue = new Uint8Array(0);
  }
}

const DECK_BUFFER_CAP_BYTES = Math.max(384_000, Math.round((config.crossfadeSeconds + 1) * 192_000));
class AudioStreamBuffer {
  private queue: Uint8Array[] = [];
  private totalBytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes = 0) {
    this.maxBytes = maxBytes;
  }

  push(chunk: Uint8Array) {
    if (chunk.byteLength === 0) return;
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
// 2. ESTRUCTURA DE DECKS CON MÁQUINA DE ESTADOS Y SESIÓN
// =============================================================
export interface Deck {
  id: "A" | "B";
  state: DeckState;
  sessionId: string;
  generation: number;
  buffer: AudioStreamBuffer;
  historyBuffer: AudioStreamBuffer;
  residueAcc: PcmResidueAccumulator;
  process: any | null;
  currentTrackFile: string | null;
  pendingTrackMeta: { file: string; title: string; artist: string; duration: number } | null;
  /** Frames (48 kHz estéreo) de esta pista ya emitidos al master: reloj por muestras. */
  framesOut: number;
  /** Duración del archivo según ffprobe (s), 0 si aún se desconoce. */
  durationSec: number;
  /** Plan de reproducción derivado del análisis (ganancia, salto de intro, fin efectivo). */
  plan: TrackPlan | null;
}

export const deckA: Deck = {
  id: "A",
  state: "IDLE",
  sessionId: "",
  generation: 0,
  buffer: new AudioStreamBuffer(DECK_BUFFER_CAP_BYTES),
  historyBuffer: new AudioStreamBuffer(DECK_BUFFER_CAP_BYTES),
  residueAcc: new PcmResidueAccumulator(),
  process: null,
  currentTrackFile: null,
  pendingTrackMeta: null,
  framesOut: 0,
  durationSec: 0,
  plan: null,
};

export const deckB: Deck = {
  id: "B",
  state: "IDLE",
  sessionId: "",
  generation: 0,
  buffer: new AudioStreamBuffer(DECK_BUFFER_CAP_BYTES),
  historyBuffer: new AudioStreamBuffer(DECK_BUFFER_CAP_BYTES),
  residueAcc: new PcmResidueAccumulator(),
  process: null,
  currentTrackFile: null,
  pendingTrackMeta: null,
  framesOut: 0,
  durationSec: 0,
  plan: null,
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

// Reloj por muestras del crossfade (CROSSFADE_SAMPLE_CLOCK)
const SAMPLE_RATE = 48000;
let crossfadeFramesDone = 0;
let crossfadeTotalFrames = 0;
/**
 * Si el deck saliente llega a EOF antes de acabar el fundido, el entrante pasa a
 * conducir el reloj y completa la rampa mezclando lo que quedaba del saliente
 * (`leftover`), sin insertar silencios en la pista entrante.
 */
let tailFadeIn: { done: number; total: number; leftover: AudioStreamBuffer | null } | null = null;

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
// 5. MEZCLADORES MATEMÁTICOS DE PCM (TypedArrays con Limitador Suave)
// =============================================================
function mixSamples(chunkA: Uint8Array, volA: number, chunkB: Uint8Array, volB: number): Uint8Array {
  const samplesA = new Int16Array(chunkA.buffer, chunkA.byteOffset, chunkA.byteLength / 2);
  const samplesB = new Int16Array(chunkB.buffer, chunkB.byteOffset, chunkB.byteLength / 2);

  const length = Math.max(samplesA.length, samplesB.length);
  const byteLength = length * 2;
  const outBuffer = acquirePcmBuffer(byteLength);
  const outSamples = new Int16Array(outBuffer, 0, length);

  const minLen = Math.min(samplesA.length, samplesB.length);
  const THRESHOLD = 28000;
  const CEILING = 32767;
  const RANGE = CEILING - THRESHOLD;

  // Soft-knee limiter: evita distorsión digital dura (clipping) al sumar pistas
  for (let i = 0; i < minLen; i++) {
    const mixed = (samplesA[i]! * volA) + (samplesB[i]! * volB);
    const abs = Math.abs(mixed);
    let val: number;
    if (abs <= THRESHOLD) {
      val = mixed;
    } else {
      const over = abs - THRESHOLD;
      const compressed = THRESHOLD + RANGE * Math.tanh(over / RANGE);
      val = Math.sign(mixed) * compressed;
    }
    outSamples[i] = Math.max(-32768, Math.min(32767, Math.round(val)));
  }

  // Cola del stream más largo (sin mezclar, solo volumen)
  if (samplesA.length > minLen) {
    for (let i = minLen; i < length; i++) {
      const scaled = Math.round(samplesA[i]! * volA);
      outSamples[i] = Math.max(-32768, Math.min(32767, scaled));
    }
  } else if (samplesB.length > minLen) {
    for (let i = minLen; i < length; i++) {
      const scaled = Math.round(samplesB[i]! * volB);
      outSamples[i] = Math.max(-32768, Math.min(32767, scaled));
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

// Aire muerto: huecos sin PCM hacia el encoder; silencio digital: pico < -60 dBFS
const DEAD_AIR_GAP_MS = 500;
const DIGITAL_SILENCE_PEAK = 33; // ≈ -60 dBFS en s16
let firstPcmTimeMs = 0;

export function accountAirTime(chunk: Uint8Array, now: number): void {
  const last = state.lastPcmSampleTimeMs;
  if (last > 0) {
    const gap = now - last;
    if (gap > DEAD_AIR_GAP_MS) {
      state.deadAirSeconds += gap / 1000;
      state.deadAirEvents++;
    }
  }
  const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength >> 1);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    const a = v < 0 ? -v : v;
    if (a > peak) {
      peak = a;
      if (peak >= DIGITAL_SILENCE_PEAK) break;
    }
  }
  if (peak < DIGITAL_SILENCE_PEAK) state.digitalSilenceSeconds += (chunk.byteLength >> 2) / SAMPLE_RATE;
}

/** Deriva del reloj de audio respecto al reloj de pared (s). Positivo = se emite más rápido que el tiempo real. */
export function audioClockDriftSeconds(now = Date.now()): number {
  if (firstPcmTimeMs === 0) return 0;
  return state.audioSamplesProduced / SAMPLE_RATE - (now - firstPcmTimeMs) / 1000;
}

function writeToMaster(chunk: Uint8Array) {
  if (chunk.byteLength === 0) return;

  const nowMs = Date.now();
  if (firstPcmTimeMs === 0) firstPcmTimeMs = nowMs;
  accountAirTime(chunk, nowMs);
  state.lastPcmSampleTimeMs = nowMs;

  // Actualizar métricas del reloj multimedia basado en muestras (1 frame = 4 bytes stereo s16le)
  const frames = Math.floor(chunk.byteLength / 4);
  state.audioClockSamples += frames;
  state.audioSamplesProduced += frames;

  // Opus tier - escribe el mismo PCM crudo al encoder opus si está habilitado
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

/** Publica los metadatos pendientes del deck como pista actual (en el momento de emisión). */
function activateTrackMeta(deck: Deck): void {
  if (!deck.pendingTrackMeta) return;
  const plan = deck.plan;
  state.currentTrack = {
    file: deck.pendingTrackMeta.file,
    title: deck.pendingTrackMeta.title,
    artist: deck.pendingTrackMeta.artist,
    duration: deck.pendingTrackMeta.duration,
    startedAt: Date.now(),
    loudness: plan && plan.analyzed ? {
      integratedLufs: plan.integratedLufs ?? 0,
      truePeakDbtp: plan.truePeakDbtp ?? 0,
      gainDb: plan.gainDb,
      leadSkipSec: plan.leadSkipSec,
      tailStartSec: plan.tailStartSec,
    } : null,
  };
  deck.pendingTrackMeta = null;
}

/** Segundos (en tiempo del deck) en los que la música de la pista termina. 0 = desconocido. */
function deckEndSec(deck: Deck, metaDuration: number): number {
  if (deck.plan?.endSec) return deck.plan.endSec;
  const dur = metaDuration > 0 ? metaDuration : deck.durationSec;
  if (dur <= 0) return 0;
  return dur - (deck.plan?.leadSkipSec ?? 0);
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
        rtmpLog.ok(Event.fallbackSilence, "Sin archivos de música: silencio hasta que haya directo", { source: config.fallbackSource });
        fallbackPlaylist = [];
        return;
      }

      fallbackPlaylist = audioFiles;
      shuffle(fallbackPlaylist);
      currentPlaylistIndex = 0;
      isPlaylistInitialized = true;
      rtmpLog.ok(Event.fallbackScan, `Encontradas ${audioFiles.length} canciones`, { source: config.fallbackSource, count: audioFiles.length });
    } else {
      fallbackPlaylist = [config.fallbackSource];
      currentPlaylistIndex = 0;
      isPlaylistInitialized = true;
      rtmpLog.ok(Event.fallbackScan, "Fallback de un solo archivo", { source: config.fallbackSource, count: 1 });
    }
  } catch (err) {
    rtmpLog.fail(ErrorCode.fallbackDir, `Carpeta de fallback no encontrada: "${config.fallbackSource}"`, { source: config.fallbackSource });
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
  if (!config.fallbackSource) return;

  if (!isPlaylistInitialized) {
    initializeFallbackSource();
    if (fallbackPlaylist.length > 0 && !state.isBroadcasting) {
      stopSilence();
      startFallback();
    }
    return;
  }

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

    // Si estábamos reproduciendo silencio porque la carpeta arrancó vacía, arrancar música inmediatamente
    if (silenceInterval && fallbackPlaylist.length > 0 && !state.isBroadcasting) {
      stopSilence();
      startFallback();
    }
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

// =============================================================
// SUBPROCESS STDERR DRAINING & AUDIO WATCHDOG
// =============================================================
export function drainProcessStderr(proc: any, name: string): void {
  if (!proc?.stderr) return;
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  const tail: string[] = [];
  const MAX_TAIL = 10;

  (async () => {
    let remainder = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const text = remainder + decoder.decode(value, { stream: true });
        const lines = text.split("\n");
        remainder = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          tail.push(trimmed);
          if (tail.length > MAX_TAIL) tail.shift();
        }
      }
    } catch {
      // stream cerrado o terminado
    } finally {
      try { reader.cancel(); } catch {}
    }
  })();

  if (proc.exited) {
    proc.exited.then((exitCode: number) => {
      if (exitCode !== 0 && tail.length > 0) {
        rtmpLog.warn(`[Subprocess ${name}] exited with code ${exitCode}. Stderr tail:\n${tail.map((l) => `  [${name}] ${l}`).join("\n")}`);
      }
    }).catch(() => {});
  }
}

export function checkAudioWatchdog(now = Date.now()): boolean {
  if (!state.isBroadcasting) return false;
  if (!state.sourceConnected) return false;
  if (state.lastSourceAudioTimeMs === 0) return false;

  const silenceDurationMs = now - state.lastSourceAudioTimeMs;
  if (silenceDurationMs > 2500) {
    rtmpLog.event("warn", Event.sourceAudioFrozen, `Audio en vivo congelado (${silenceDurationMs}ms sin frames). Forzando failover a fallback.`, { silenceMs: silenceDurationMs });
    state.audioUnderruns++;
    state.isBroadcasting = false;
    state.sourceConnected = false;
    state.lastSourceAudioTimeMs = 0;

    if (state.sourceProcess) {
      try {
        state.sourceProcess.kill();
      } catch {
        /* noop */
      }
      state.sourceProcess = null;
    }

    startFallback();
    return true;
  }
  return false;
}

// -------------------------------------------------------------
// Watchdog del fallback (FALLBACK_STALL_SECONDS): si no hay directo, no
// está en pausa y el encoder lleva N s sin recibir PCM (deck colgado,
// ffmpeg bloqueado, spawn fallido…), se fuerza el salto a la siguiente
// pista. Sin esto, un deck colgado deja la radio muda indefinidamente.
// -------------------------------------------------------------
let lastFallbackStallRestartMs = 0;

function restartFallbackAfterStall(): void {
  // SIGKILL: un proceso detenido (SIGSTOP) ignora SIGTERM hasta que se reanuda
  for (const d of [deckA, deckB]) {
    if (d.process) { try { d.process.kill(9); } catch { /* noop */ } }
  }
  actionSkipFallback();
}

export function checkFallbackWatchdog(now = Date.now(), restart: () => void = restartFallbackAfterStall): boolean {
  const stallMs = config.fallbackStallSeconds * 1000;
  if (stallMs <= 0) return false;
  if (state.isBroadcasting || state.shuttingDown || state.fallbackPaused) return false;
  if (state.lastPcmSampleTimeMs === 0) return false; // aún no arrancó el audio
  const silentMs = now - state.lastPcmSampleTimeMs;
  if (silentMs < stallMs) return false;
  if (now - lastFallbackStallRestartMs < stallMs) return false; // un reintento por ventana
  lastFallbackStallRestartMs = now;
  state.fallbackStallRestarts++;
  rtmpLog.event("warn", Event.fallbackStalled, `Fallback sin audio hace ${silentMs}ms; saltando a la siguiente pista`, {
    silentMs, deckA: deckA.state, deckB: deckB.state, track: deckA.currentTrackFile ?? deckB.currentTrackFile,
  });
  restart();
  return true;
}

let watchdogTimer: ReturnType<typeof setInterval> | null = null;
export function startAudioWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (state.shuttingDown) {
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      return;
    }
    checkAudioWatchdog();
    checkFallbackWatchdog();
    checkOpusStall();
  }, 1000);
}

export function stopAudioWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

export function startMasterEncoder() {
  startAudioWatchdog();
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
      rtmpLog.ok(Event.encoderMasterStarted, `Encoder master nativo LAME-FFI @ ${config.fallbackBitrateKbps}kbps (sin ffmpeg)`, { engine: "lame-ffi", bitrateKbps: config.fallbackBitrateKbps });
      if (config.opusTierEnabled) startOpusEncoder();
      return;
    } catch (err) {
      rtmpLog.fail(ErrorCode.ffmpegSpawn, "Error iniciando LAME nativo; se usará ffmpeg", { error: (err as Error).message });
    }
  }

  // --- Fallback: FFmpeg master encoder ---
  startFfmpegMasterEncoder();
  if (config.opusTierEnabled) startOpusEncoder();
}

function startFfmpegMasterEncoder() {
  const fmt = FORMAT_CONFIG[config.streamFormat];
  rtmpLog.ok(Event.encoderMasterStarted, `Encoder master [${config.streamFormat.toUpperCase()}] @ ${config.fallbackBitrateKbps}kbps`, { codec: fmt.codec, bitrateKbps: config.fallbackBitrateKbps });

  const args = [
    "-loglevel", "warning",
    "-fflags", "nobuffer",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "-i", "pipe:0",
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
    drainProcessStderr(state.masterProcess, "MasterEncoder");

    const reader = state.masterProcess.stdout.getReader();
    
    const processInstance = state.masterProcess;
    processInstance.exited.then((exitCode: number) => {
      if (state.masterProcess === processInstance) {
        const okExit = exitCode === 0 || state.shuttingDown;
        rtmpLog.event(okExit ? "info" : "warn", okExit ? Event.encoderMasterStopped : Event.encoderMasterCrashed, `Encoder master terminó (exit ${exitCode})`, { exitCode });
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
    rtmpLog.fail(missingBinaryCode(err) ?? ErrorCode.ffmpegSpawn, "No se pudo iniciar el encoder master ffmpeg", { error: (err as Error).message });
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
      rtmpLog.fail(ErrorCode.ffmpegSpawn, "Error leyendo la salida del encoder master", { error: (err as Error).message });
    }
  }
}

// --- Opus tier (moonshot per-listener efficiency) ---
// Supervisión (ENCODER_SUPERVISION): si ffmpeg-opus muere o deja de producir
// páginas mientras recibe PCM, se reinicia con backoff exponencial (1s→30s).
// Cada arranque es una generación nueva: cabeceras y prebuffer se invalidan.
let opusAssembler = new OggPageAssembler();
const opusHeaderCollector = new OpusHeaderCollector();
let opusIntentionalStop = false;
let opusRestartTimer: ReturnType<typeof setTimeout> | null = null;
let opusBackoffMs = 1000;
let opusStartedAtMs = 0;
let opusLastOutputMs = 0;
const OPUS_BACKOFF_MAX_MS = 30_000;
const OPUS_HEALTHY_RESET_MS = 60_000;
export const OPUS_STALL_MS = 10_000;

function resetOpusGeneration() {
  opusHeaders = null;
  opusHeaderCollector.reset();
  opusAssembler = new OggPageAssembler();
  preBufferOpus.reset();
}

export function scheduleOpusRestart(reason: string): number | null {
  if (!config.encoderSupervision || !config.opusTierEnabled || state.shuttingDown) return null;
  if (opusRestartTimer) return null;
  if (opusStartedAtMs > 0 && Date.now() - opusStartedAtMs > OPUS_HEALTHY_RESET_MS) opusBackoffMs = 1000;
  const delay = opusBackoffMs;
  opusBackoffMs = Math.min(OPUS_BACKOFF_MAX_MS, opusBackoffMs * 2);
  rtmpLog.event("warn", Event.encoderOpusRestart, `Reiniciando encoder opus en ${delay}ms (${reason})`, { delayMs: delay, reason });
  opusRestartTimer = setTimeout(() => {
    opusRestartTimer = null;
    if (state.shuttingDown || state.opusProcess) return;
    state.opusEncoderRestarts++;
    startOpusEncoder();
  }, delay);
  return delay;
}

/** Detecta un encoder opus vivo pero colgado (no emite páginas mientras recibe PCM). */
export function checkOpusStall(now = Date.now()): boolean {
  if (!config.encoderSupervision || !state.opusProcess) return false;
  if (now - opusStartedAtMs < OPUS_STALL_MS) return false;
  const pcmFlowing = state.lastPcmSampleTimeMs > 0 && now - state.lastPcmSampleTimeMs < 2000;
  const lastOut = opusLastOutputMs || opusStartedAtMs;
  if (!pcmFlowing || now - lastOut < OPUS_STALL_MS) return false;
  rtmpLog.event("warn", Event.encoderOpusStalled, `Encoder opus sin salida hace ${now - lastOut}ms con PCM entrando; matando proceso`, { silentMs: now - lastOut });
  try { state.opusProcess.kill(9); } catch { /* noop */ }
  return true;
}

export function startOpusEncoder() {
  if (state.opusProcess) return;
  if (!config.opusTierEnabled) return;
  if (opusRestartTimer) { clearTimeout(opusRestartTimer); opusRestartTimer = null; }
  // Verificar codec disponible
  const opusFmt = FORMAT_CONFIG["opus"];
  rtmpLog.ok(Event.encoderOpusStarted, `Encoder opus @ ${config.opusTierBitrateKbps}kbps`, { codec: opusFmt.codec, bitrateKbps: config.opusTierBitrateKbps });
  const args = [
    "-loglevel", "warning",
    "-fflags", "nobuffer",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "-i", "pipe:0",
    "-acodec", opusFmt.codec,
    ...opusFmt.args(config.opusTierBitrateKbps),
    "-flush_packets", "1",
    "-f", opusFmt.muxer,
    "-"
  ];
  opusIntentionalStop = false;
  resetOpusGeneration();
  state.opusEncoderGeneration++;
  try {
    state.opusProcess = Bun.spawn(["ffmpeg", ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    opusStartedAtMs = Date.now();
    opusLastOutputMs = 0;
    drainProcessStderr(state.opusProcess, "OpusEncoder");
    const reader = state.opusProcess.stdout.getReader();
    const proc = state.opusProcess;
    proc.exited.then((code: number) => {
      if (state.opusProcess === proc) {
        const okExit = code === 0 || state.shuttingDown;
        rtmpLog.event(okExit ? "info" : "warn", okExit ? Event.encoderOpusStopped : Event.encoderOpusCrashed, `Encoder opus terminó (exit ${code})`, { exitCode: code });
        try { reader.cancel(); } catch {}
        state.opusProcess = null;
        if (config.encoderSupervision) resetOpusGeneration(); // cabeceras/prebuffer de una generación muerta
        if (!opusIntentionalStop) scheduleOpusRestart(`exit ${code}`);
      }
    }).catch(()=>{});
    pipeOpus(reader, proc);
  } catch (err) {
    rtmpLog.fail(missingBinaryCode(err) ?? ErrorCode.ffmpegSpawn, "No se pudo iniciar el encoder opus", { error: (err as Error).message });
    state.opusProcess = null;
    scheduleOpusRestart("spawn failed");
  }
}

export function extractOggOpusHeaders(buf: Uint8Array): Uint8Array | null {
  let offset = 0;
  let pagesFound = 0;
  while (offset + 27 <= buf.length) {
    if (buf[offset] !== 0x4f || buf[offset + 1] !== 0x67 || buf[offset + 2] !== 0x67 || buf[offset + 3] !== 0x73) {
      break;
    }
    const numSegments = buf[offset + 26]!;
    if (offset + 27 + numSegments > buf.length) break;

    let payloadLen = 0;
    for (let i = 0; i < numSegments; i++) {
      payloadLen += buf[offset + 27 + i]!;
    }
    const pageLen = 27 + numSegments + payloadLen;
    if (offset + pageLen > buf.length) break;

    pagesFound++;
    offset += pageLen;
    if (pagesFound === 2) {
      return buf.slice(0, offset);
    }
  }
  return null;
}

let opusPackets = 0;
let opusBytesTotal = 0;

/**
 * Procesa la salida de ffmpeg-opus página a página: las páginas de cabecera
 * (OpusHead + OpusTags) se acumulan en `opusHeaders` y no entran al prebuffer;
 * las páginas de audio sí, de modo que un oyente nuevo recibe siempre
 * cabeceras completas + páginas enteras de la generación actual.
 */
export function handleOpusOutput(value: Uint8Array): void {
  const pages = opusAssembler.feed(value);
  for (const page of pages) {
    if (page.bos) {
      // Stream lógico nuevo: lo previo pertenece a otra generación
      preBufferOpus.reset();
    }
    const isHeader = opusHeaderCollector.accept(page);
    if (isHeader) {
      opusHeaders = opusHeaderCollector.headers;
      if (page.magic.startsWith("OpusTags")) {
        rtmpLog.debug(`[Opus Tier] Cabeceras Ogg/Opus completas: ${opusHeaders?.length ?? 0}B (gen ${state.opusEncoderGeneration})`);
      }
      broadcastOpus(page.data, false); // oyentes ya conectados la necesitan en banda
      continue;
    }
    broadcastOpus(page.data);
  }
}

async function pipeOpus(reader: ReadableStreamDefaultReader<Uint8Array>, proc?: any) {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        rtmpLog.debug("Opus stream closed");
        break;
      }
      if (proc && state.opusProcess !== proc) break; // generación sustituida
      opusLastOutputMs = Date.now();
      opusPackets++;
      opusBytesTotal += value.length;
      if (opusPackets % 200 === 0) {
        rtmpLog.debug(`[Opus Debug] pkt ${opusPackets} size ${value.length}B avg ${(opusBytesTotal/opusPackets).toFixed(1)}B total ${(opusBytesTotal/1024).toFixed(1)}KB`);
      }
      handleOpusOutput(value);
    }
  } catch (err) {
    if (!state.shuttingDown) rtmpLog.debug(`Error reading Opus: ${(err as Error).message}`);
  }
}

export function stopOpusEncoder() {
  opusIntentionalStop = true;
  if (opusRestartTimer) { clearTimeout(opusRestartTimer); opusRestartTimer = null; }
  if (!state.opusProcess) return;
  rtmpLog.ok(Event.encoderOpusStopped, "Deteniendo encoder opus");
  try {
    state.opusProcess.stdin.end();
    state.opusProcess.kill();
  } catch {}
  state.opusProcess = null;
  resetOpusGeneration();
}

export function stopMasterEncoder() {
  // Opus tier
  stopOpusEncoder();

  // --- Modo nativo ---
  if (nativeEncoder) {
    rtmpLog.ok(Event.encoderMasterStopped, "Deteniendo encoder master nativo (LAME-FFI)");
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
  rtmpLog.ok(Event.encoderMasterStopped, "Deteniendo encoder master ffmpeg");
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
  rtmpLog.event("debug", Event.fallbackSilence, "Generador de silencio iniciado (live-only)");
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
    rtmpLog.ok(Event.fallbackSilence, "Sin música: silencio hasta que haya directo");
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
    // Barrido de fondo (nice, 1 hilo, en serie) para que todas las pistas lleguen analizadas
    if (analysisEnabled() && config.analysisPrescan) requestAnalysis([...fallbackPlaylist]);
  }

  startMasterEncoder();

  let fileToPlay = "";
  if (state.fallbackQueue.length > 0) {
    fileToPlay = state.fallbackQueue.shift()!;
  } else {
    if (fallbackPlaylist.length === 0) {
      rtmpLog.event("debug", Event.fallbackSilence, "Playlist de fallback vacía: silencio");
      startSilence();
      return;
    }
    fileToPlay = fallbackPlaylist[currentPlaylistIndex]!;
    currentPlaylistIndex++;
    if (currentPlaylistIndex >= fallbackPlaylist.length) {
      rtmpLog.event("debug", Event.fallbackReshuffle, "Fin de lista; re-mezclando playlist");
      shuffle(fallbackPlaylist);
      currentPlaylistIndex = 0;
    }
  }

  // Generar nueva sesión e incrementar generación para invalidar callbacks previos
  currentDeck.generation++;
  currentDeck.sessionId = `${currentDeck.id}-${currentDeck.generation}-${Date.now()}`;
  currentDeck.state = "PRELOADING";
  state.deckState[currentDeck.id] = currentDeck.state;
  state.deckSessions[currentDeck.id] = currentDeck.sessionId;
  state.deckGenerations[currentDeck.id] = currentDeck.generation;
  const session = currentDeck.sessionId;

  currentDeck.currentTrackFile = fileToPlay;
  currentDeck.pendingTrackMeta = null;
  currentDeck.buffer.clear();
  currentDeck.residueAcc.reset();
  currentDeck.framesOut = 0;
  currentDeck.durationSec = 0;

  // Análisis BS.1770 + silencios (si LOUDNESS_NORMALIZATION / SMART_TRANSITIONS)
  const analysisOn = analysisEnabled();
  const plan = analysisOn ? planTrack(getCachedAnalysis(fileToPlay)) : null;
  currentDeck.plan = plan;
  if (analysisOn) {
    // Pista actual (si falta) + las dos siguientes, para tenerlas listas a tiempo
    const upcoming = [...state.fallbackQueue.slice(0, 2), fallbackPlaylist[currentPlaylistIndex], fallbackPlaylist[(currentPlaylistIndex + 1) % Math.max(1, fallbackPlaylist.length)]];
    requestAnalysis([fileToPlay, ...upcoming], { priority: true });
  }

  const basename = path.basename(fileToPlay);
  const cleanName = basename.replace(/\.[^/.]+$/, "") || "Desconocido";
  const planInfo = plan ? (plan.analyzed
    ? ` (gain ${plan.gainDb >= 0 ? "+" : ""}${plan.gainDb} dB, I=${plan.integratedLufs} LUFS, TP=${plan.truePeakDbtp} dBTP${plan.leadSkipSec > 0 ? `, salta ${plan.leadSkipSec}s de intro muda` : ""}${plan.endSec ? `, cruza en ${plan.endSec.toFixed(1)}s` : ""})`
    : " (sin análisis aún; gain 0 dB)") : "";
  rtmpLog.ok(Event.trackStarted, `Reproduciendo: ${cleanName}${planInfo}`, {
    deck: currentDeck.id, file: fileToPlay,
    ...(plan ? { analyzed: plan.analyzed, gainDb: plan.gainDb, integratedLufs: plan.integratedLufs, truePeakDbtp: plan.truePeakDbtp, leadSkipSec: plan.leadSkipSec, endSec: plan.endSec } : {}),
  });

  let parsedArtist = "";
  let parsedTitle = cleanName;
  if (cleanName.includes(" - ")) {
    const parts = cleanName.split(" - ");
    parsedArtist = parts[0]?.trim() || "";
    parsedTitle = parts.slice(1).join(" - ").trim() || cleanName;
  }

  getFileMetadata(fileToPlay).then((meta) => {
    if (currentDeck.sessionId !== session) return; // Callback obsoleto ignorado

    const finalTitle = (meta.title && meta.title.trim()) || parsedTitle;
    const finalArtist = (meta.artist && meta.artist.trim()) || parsedArtist || "Artista Desconocido";

    currentDeck.pendingTrackMeta = {
      file: fileToPlay,
      title: finalTitle,
      artist: finalArtist,
      duration: meta.duration,
    };
    currentDeck.durationSec = meta.duration;

    // Si el deck ya empezó a sonar en el master, activar metadatos de inmediato
    if (currentDeck.state === "PLAYING" && activeDeck === currentDeck.id) {
      activateTrackMeta(currentDeck);
    }
  });

  // `-fflags nobuffer` con un ARCHIVO descarta los paquetes leídos durante el sondeo:
  // se perdían ~1.2 s del inicio de cada MP3 (~0.1 s en FLAC). Solo tiene sentido en
  // entradas en vivo; se conserva tras DECK_FFLAGS_NOBUFFER=true por compatibilidad.
  const args = [
    "-loglevel", "warning",
    ...(config.deckFflagsNobuffer ? ["-fflags", "nobuffer"] : []),
    "-re",
    ...(plan && plan.leadSkipSec > 0 ? ["-ss", plan.leadSkipSec.toFixed(3)] : []),
    "-i", fileToPlay,
    "-vn",
    ...(plan && plan.gainDb !== 0 ? ["-af", `volume=${plan.gainDb}dB`] : []),
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
    drainProcessStderr(currentDeck.process, `Deck-${currentDeck.id}`);

    const reader = currentDeck.process.stdout.getReader();
    pipeFallback(currentDeck, reader, session);
  } catch (err) {
    rtmpLog.fail(ErrorCode.deckDecode, `Error al iniciar ffmpeg en deck ${currentDeck.id}`, { file: currentDeck.currentTrackFile, error: (err as Error).message });
  }
}

// =============================================================
// 4. BUCLE DE INGESTA DE FALLBACK CON MÁQUINA DE ESTADOS
// =============================================================
async function pipeFallback(deck: Deck, reader: ReadableStreamDefaultReader<Uint8Array>, session: string) {
  const processInstance = deck.process;
  if (processInstance) {
    processInstance.exited.then((exitCode: number) => {
      if (deck.process === processInstance && deck.sessionId === session && !transitionStarted && !(config.crossfadeSampleClock && exitCode === 0)) {
        rtmpLog.debug(`[Deck ${deck.id}] Process ended (Session ${session}, exitCode: ${exitCode}).`);
        try {
          reader.cancel();
        } catch {
          /* noop */
        }
      }
    }).catch(() => {});
  }

  let eofLeftover: AudioStreamBuffer | null = null;

  /** Procesa un bloque PCM alineado del deck. `flushing`: viene del propio buffer del deck (EOF). */
  const handleChunk = (aligned: Uint8Array, flushing: boolean): void => {
    // Si este deck es el secundario, precarga su FIFO para el futuro crossfade
    if (activeDeck !== deck.id) {
      deck.state = "PRELOADING";
      state.deckState[deck.id] = deck.state;
      deck.buffer.push(aligned);
      return;
    }

    // Deck activo: marcar PLAYING y sincronizar metadatos en el momento de emisión
    if (deck.state !== "PLAYING" && !transitionStarted) {
      deck.state = "PLAYING";
      state.deckState[deck.id] = deck.state;
      activateTrackMeta(deck);
    }

    const sampleClock = config.crossfadeSampleClock;
    // Relevo sin pérdidas: si el deck llegó al primer plano con audio ya
    // precargado (ráfaga inicial de `ffmpeg -re` ≈0.5 s), se sigue sirviendo
    // en orden FIFO a 1x en vez de saltárselo.
    let out = aligned;
    if (sampleClock && !flushing && deck.buffer.length > 0) {
      deck.buffer.push(aligned);
      out = deck.buffer.pull(aligned.length);
    }
    const outFrames = out.length >> 2;

    // Retener en historyBuffer para permitir crossfade real cuando entra Live RTMP/SRT
    deck.historyBuffer.push(out);

    // Si este deck es el primario (conductor del reloj de ingesta):
    if (!state.isBroadcasting) {
      if (transitionStarted) {
        deck.state = "CROSSFADING";
        state.deckState[deck.id] = deck.state;
        const progress = sampleClock
          ? Math.min(1.0, (crossfadeFramesDone + outFrames) / Math.max(1, crossfadeTotalFrames))
          : Math.min(1.0, (Date.now() - crossfadeStartTime) / (config.crossfadeSeconds * 1000));

        // Equal-power crossfade (cosine)
        const volOut = Math.cos(progress * Math.PI * 0.5);
        const volIn = Math.cos((1 - progress) * Math.PI * 0.5);

        const nextDeck = deck.id === "A" ? deckB : deckA;
        const avail = Math.min(out.length, nextDeck.buffer.length);
        const otherChunk = nextDeck.buffer.pull(out.length);
        nextDeck.framesOut += avail >> 2;
        // Solo cuenta el hueco audible (el entrante tarda ~50-100 ms en arrancar, con volumen ≈0)
        if (progress >= 0.1) state.crossfadeUnderrunBytes += out.length - avail;
        const mixed = mixSamples(out, volOut, otherChunk, volIn);
        crossfadeFramesDone += outFrames;
        deck.framesOut += outFrames;

        writeToMaster(mixed);

        if (progress >= 1.0) {
          transitionStarted = false;
          state.crossfadesCompleted++;
          state.handoverDrainedBytes += nextDeck.buffer.length;
          const oldDeck = deck;
          oldDeck.state = "DRAINING";
          state.deckState[oldDeck.id] = oldDeck.state;

          activeDeck = nextDeck.id; // El nuevo deck pasa a ser el primario
          nextDeck.state = "PLAYING";
          state.deckState[nextDeck.id] = nextDeck.state;

          // Sincronizar metadatos de la nueva canción justo al completar el relevo
          activateTrackMeta(nextDeck);

          setTimeout(() => {
            if (oldDeck.process && oldDeck.sessionId === session) {
              try { oldDeck.process.kill(); } catch {}
              oldDeck.process = null;
              oldDeck.currentTrackFile = null;
              oldDeck.buffer.clear();
              oldDeck.state = "STOPPED";
              state.deckState[oldDeck.id] = oldDeck.state;
            }
          }, 50);
        }
      } else if (isFallbackFadeInActive) {
        // Fundido de entrada suave (después de desconexión de OBS)
        const fadeSec = config.lowLatency ? config.crossfadeLiveSeconds : config.crossfadeSeconds;
        const elapsed = Date.now() - fallbackFadeInStartTime;
        const progress = Math.min(1.0, elapsed / (fadeSec * 1000));

        const faded = applyVolume(out, progress);
        deck.framesOut += outFrames;
        writeToMaster(faded);

        if (progress >= 1.0) {
          isFallbackFadeInActive = false;
        }
      } else {
        // Reproducción normal al 100% de volumen (o completando la rampa de
        // entrada si el deck anterior terminó a mitad del crossfade)
        if (tailFadeIn) {
          const p = Math.min(1.0, (tailFadeIn.done + outFrames) / Math.max(1, tailFadeIn.total));
          const volIn = Math.sin(p * Math.PI * 0.5);
          const left = tailFadeIn.leftover;
          if (left && left.length > 0) {
            writeToMaster(mixSamples(out, volIn, left.pull(out.length), Math.cos(p * Math.PI * 0.5)));
          } else {
            writeToMaster(applyVolume(out, volIn));
          }
          tailFadeIn.done += outFrames;
          if (p >= 1.0) tailFadeIn = null;
        } else {
          writeToMaster(out);
        }
        deck.framesOut += outFrames;

        // Monitorear final de tema para disparar crossfade
        const metaDuration = state.currentTrack?.duration ?? 0;
        const endSec = sampleClock ? deckEndSec(deck, metaDuration) : (deck.plan?.endSec ?? metaDuration);
        if (state.currentTrack && endSec > 0) {
          const elapsed = sampleClock ? deck.framesOut / SAMPLE_RATE : (Date.now() - state.currentTrack.startedAt) / 1000;
          const remaining = endSec - elapsed;

          if (remaining <= config.crossfadeSeconds && !transitionStarted) {
            transitionStarted = true;
            crossfadeStartTime = Date.now();
            crossfadeFramesDone = 0;
            crossfadeTotalFrames = Math.max(1, Math.round(Math.min(config.crossfadeSeconds, Math.max(remaining, 0.05)) * SAMPLE_RATE));
            tailFadeIn = null;
            rtmpLog.ok(Event.crossfadeStarted, `Crossfade desde deck ${deck.id}`, { deck: deck.id, atSec: Math.round(elapsed * 100) / 100, endSec: Math.round(endSec * 100) / 100, clock: sampleClock ? "samples" : "wall" });

            // Iniciar el siguiente en el deck inactivo
            startFallback();
          }
        }
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // EOF: con el relevo FIFO el deck activo aún guarda audio precargado (~0.5 s).
        // En pleno crossfade se cede al deck entrante (ver tailFadeIn); fuera de él se
        // emite. Antes ese audio se perdía y el crossfade se truncaba.
        if (config.crossfadeSampleClock && deck.sessionId === session && activeDeck === deck.id && !state.isBroadcasting && deck.buffer.length > 0) {
          if (transitionStarted) {
            eofLeftover = new AudioStreamBuffer(0);
            eofLeftover.push(deck.buffer.pull(deck.buffer.length));
          } else {
            while (deck.buffer.length > 0 && deck.sessionId === session && activeDeck === deck.id) {
              handleChunk(deck.buffer.pull(Math.min(deck.buffer.length, 19200)), true);
            }
          }
        }
        break;
      }

      // Si la sesión fue sustituida o descartada, detener consumo
      if (deck.sessionId !== session) break;

      // Ensamblador de residuos PCM: garantiza frames completos de 4 bytes estéreo
      const aligned = deck.residueAcc.feed(value);
      if (aligned.length === 0) continue;

      handleChunk(aligned, false);
    }
  } catch (err) {
    if (!isStoppingFallback && deck.sessionId === session) {
      rtmpLog.fail(ErrorCode.deckDecode, `Error leyendo el stream del deck ${deck.id}`, { error: (err as Error).message });
    }
  } finally {
    if (deck.sessionId === session) {
      const wasIntentionallyStopped = deck.process === null;
      deck.process = null;
      deck.currentTrackFile = null;
      deck.buffer.clear();
      deck.state = "STOPPED";
      state.deckState[deck.id] = deck.state;

      if (!state.isBroadcasting && !state.shuttingDown && !wasIntentionallyStopped) {
        if (activeDeck === deck.id && !transitionStarted) {
          // Caso normal: deck terminó sin crossfade activo
          activeDeck = activeDeck === "A" ? "B" : "A";
          startFallback();
        } else if (activeDeck === deck.id && transitionStarted) {
          // Deck terminó durante un crossfade — completar la transición
          const leftoverFrames = (eofLeftover?.length ?? 0) >> 2;
          const doneFrac = crossfadeTotalFrames > 0 ? Math.min(1, (crossfadeFramesDone + leftoverFrames) / crossfadeTotalFrames) : 0;
          // ≥95 %: el saliente tenía audio para (casi) todo el fundido (p. ej. ffprobe
          // sobreestima la duración en el relleno del MP3); por debajo, fundido truncado.
          if (config.crossfadeSampleClock && doneFrac >= 0.95) state.crossfadesCompleted++;
          else state.crossfadesTruncated++;
          rtmpLog.event("info", Event.trackEnded, `Deck ${deck.id} terminó; completando transición`, { deck: deck.id, crossfadeProgress: Math.round(doneFrac * 100) / 100 });
          transitionStarted = false;
          activeDeck = deck.id === "A" ? "B" : "A";
          const newDeck = activeDeck === "A" ? deckA : deckB;
          if (config.crossfadeSampleClock) {
            // Sin descartar el audio precargado; el entrante termina su rampa de volumen
            state.handoverDrainedBytes += newDeck.buffer.length;
            tailFadeIn = { done: crossfadeFramesDone, total: crossfadeTotalFrames, leftover: eofLeftover };
          } else {
            newDeck.buffer.clear();
          }
          if (!newDeck.process) {
            startFallback();
          }
        }
      }
    }
  }
}

export function stopFallback() {
  isStoppingFallback = true;
  tailFadeIn = null;
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
  deckA.historyBuffer.clear();
  deckB.historyBuffer.clear();
  deckA.state = "STOPPED";
  deckB.state = "STOPPED";
  state.deckState.A = "STOPPED";
  state.deckState.B = "STOPPED";
  deckA.currentTrackFile = null;
  deckB.currentTrackFile = null;
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
  const rtmpResidueAccumulator = new PcmResidueAccumulator();

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
      rtmpLog.event("warn", Event.sourceCooldown, "RTMP en cooldown por flaps; ignorando conexiones", { until: new Date(rtmpCooldownUntil).toISOString() });
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
      drainProcessStderr(state.sourceProcess, "RTMP-Source");

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
        const { done, value: rawValue } = await reader.read();
        if (done) break;

        const value = rtmpResidueAccumulator.feed(rawValue);
        if (value.byteLength === 0) continue;

        state.lastSourceAudioTimeMs = Date.now();
        state.totalBytesReceived += value.byteLength;
        if (firstAudioAt === 0) firstAudioAt = Date.now();
        const sustained = config.lowLatency ? true : (Date.now() - firstAudioAt) >= config.rtmpMinLiveSeconds * 1000;

        if (!state.isBroadcasting && sustained) {
          state.isBroadcasting = true;
          stopSilence();
          liveTransitionStartTime = Date.now();
          isLiveTransitionActive = config.crossfadeLiveSeconds > 0;
          const rtmpLiveMsg = config.lowLatency ? "RTMP LIVE! (low-latency instant)" : `RTMP connection established and live (after ${config.rtmpMinLiveSeconds}s sustained audio)`;
          rtmpLog.ok(Event.sourceConnected, rtmpLiveMsg, { source: "rtmp", lowLatency: config.lowLatency });

          state.currentTrack = null;
        }

        if (state.isBroadcasting) {
          if (isLiveTransitionActive) {
            // Fundido cruzado de entrada (Música de fondo -> En Vivo) - lowLatency 0.2s
            const elapsed = Date.now() - liveTransitionStartTime;
            const progress = Math.min(1.0, elapsed / (config.crossfadeLiveSeconds * 1000));

            const currentMusicDeck = activeDeck === "A" ? deckA : deckB;
            const fallbackChunk = currentMusicDeck.buffer.length > 0
              ? currentMusicDeck.buffer.pull(value.length)
              : (currentMusicDeck.historyBuffer.length > 0
                  ? currentMusicDeck.historyBuffer.pull(value.length)
                  : new Uint8Array(value.length));

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
      rtmpLog.fail(ErrorCode.source, "Error en el proceso RTMP", { error: (err as Error).message });
    } finally {
      const wasBroadcasting = state.isBroadcasting;
      rtmpLog.ok(Event.sourceDisconnected, "Fuente RTMP desconectada; limpiando", { source: "rtmp" });
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
        rtmpLog.event("warn", Event.sourceCooldown, "Demasiadas desconexiones RTMP; entrando en cooldown", { count: disconnectTimestamps.length, windowSec: flapWindowMs / 1000, cooldownSec: flapCooldownMs / 1000 });
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
  const srtResidueAccumulator = new PcmResidueAccumulator();

  const flapWindowMs = config.lowLatency ? 10000 : 30000;
  const flapMaxCount = config.lowLatency ? 5 : 3;
  const flapCooldownMs = config.lowLatency ? 5000 : 60000;
  let disconnectTimestamps: number[] = [];
  let srtCooldownUntil = 0;

  while (true) {
    if (state.shuttingDown) break;

    if (Date.now() < srtCooldownUntil) {
      rtmpLog.event("debug", Event.sourceCooldown, "SRT en cooldown", { until: new Date(srtCooldownUntil).toISOString() });
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    // SRT ready is debug only (TUI shows status via side panel, not log spam)
    rtmpLog.ok(Event.sourceListening, `Escuchando SRT en el puerto ${config.srtPort}`, { port: config.srtPort, host: config.host, protocol: "srt" });

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
      drainProcessStderr(state.sourceProcess, "SRT-Source");

      state.sourceConnected = true;
      const reader = state.sourceProcess.stdout.getReader();
      const proc = state.sourceProcess;
      proc.exited.then((code: number) => {
        if (state.sourceProcess === proc) {
          rtmpLog.event("info", Event.sourceStopped, `Receptor SRT terminó (exit ${code})`, { exitCode: code });
          try { reader.cancel(); } catch {}
        }
      }).catch(()=>{});

      rtmpLog.event("debug", Event.sourceListening, "SRT receptor activo, esperando audio");

      let firstAudioAt = 0;
      while (true) {
        const { done, value: rawValue } = await reader.read();
        if (done) break;

        const value = srtResidueAccumulator.feed(rawValue);
        if (value.byteLength === 0) continue;

        state.lastSourceAudioTimeMs = Date.now();
        state.totalBytesReceived += value.byteLength;
        if (firstAudioAt === 0) {
          firstAudioAt = Date.now();
          rtmpLog.event("debug", Event.sourceListening, "SRT: primer audio recibido", { bytes: value.byteLength });
        }
        const sustained = config.lowLatency ? true : (Date.now() - firstAudioAt) >= config.rtmpMinLiveSeconds * 1000;
        if (!state.isBroadcasting && sustained) {
          state.isBroadcasting = true;
          stopSilence();
          liveTransitionStartTime = Date.now();
          isLiveTransitionActive = config.crossfadeLiveSeconds > 0;
          const liveMsg = config.lowLatency ? "🔴 LIVE — you're on air!" : `🔴 LIVE (after ${config.rtmpMinLiveSeconds}s)`;
          rtmpLog.ok(Event.sourceConnected, liveMsg, { source: "srt" });
          state.currentTrack = null;
        }

        if (state.isBroadcasting) {
          if (isLiveTransitionActive) {
            const elapsed = Date.now() - liveTransitionStartTime;
            const progress = Math.min(1.0, elapsed / (config.crossfadeLiveSeconds * 1000));
            const curDeck = activeDeck === "A" ? deckA : deckB;
            const fbChunk = curDeck.buffer.length > 0
              ? curDeck.buffer.pull(value.length)
              : (curDeck.historyBuffer.length > 0
                  ? curDeck.historyBuffer.pull(value.length)
                  : new Uint8Array(value.length));
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
      rtmpLog.fail(missingBinaryCode(err) ?? ErrorCode.source, "Error en la fuente SRT", { error: (err as Error).message });
      await new Promise((r) => setTimeout(r, 2000));
    } finally {
      const wasBroadcasting = state.isBroadcasting;
      rtmpLog.ok(Event.sourceDisconnected, "Fuente SRT desconectada; limpiando", { source: "srt" });
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
        rtmpLog.event("warn", Event.sourceCooldown, "SRT: demasiados flaps; entrando en cooldown", { count: disconnectTimestamps.length, cooldownSec: flapCooldownMs / 1000 });
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
