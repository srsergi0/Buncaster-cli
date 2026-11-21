import { dlopen, ptr } from "bun:ffi";
import { rtmpLog } from "./logger";
import { Event, ErrorCode } from "./events";

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
// Solo se carga libavformat 60 (VERIFIED_MAJORS): con otra versión estos offsets
// leerían campos equivocados. Majors relacionados: avcodec = avformat, avutil = -2,
// swresample = -56. Si nada carga (o Bun < 1.3), los decks usan ffmpeg CLI.

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
const AVERROR_EOF = -541478725; // FFERRTAG('E','O','F',' ')
const MAX_CONSECUTIVE_DECODE_ERRORS = 100;

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
  av_log_set_level: (level: number) => void;
  swr_alloc_set_opts: (s: number | null, outLayout: number, outFmt: number, outRate: number, inLayout: number, inFmt: number, inRate: number, logOff: number, logCtx: number | null) => number;
  swr_convert: (s: number, out: number, outCount: number, input: number | null, inCount: number) => number;
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

// Los offsets de arriba solo se verificaron contra libavformat 60 (ffmpeg 6.x).
// Con otra versión mayor se leerían campos equivocados (crash o basura), así
// que solo se carga la 60; cualquier otra → decks con ffmpeg CLI.
const VERIFIED_MAJORS = ["60"];

function loadLibs(): Symbols | null {
  const majors = VERIFIED_MAJORS;
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
          av_log_set_level: { args: ["i32"] as const, returns: "void" as const },
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
        // En proceso, av_log escribiría avisos por frame en el stderr del motor (el ffmpeg
        // del deck los dejaba en su propio stderr, que solo se muestra si falla). AV_LOG_FATAL.
        all.av_log_set_level(8);
        rtmpLog.ok(Event.nativeDecodeLoaded, `libavformat ${major} cargada; decks sin ffmpeg`, { version: major, path: paths.avformat });
        return all;
      } catch {
        // probar siguiente versión
      }
    }
  }
  rtmpLog.event("info", Event.nativeFallback, `libavformat ${VERIFIED_MAJORS.join("/")} no disponible; decks con ffmpeg CLI`);
  return null;
}

let loadAttempted = false;

/** Carga perezosa: solo se abre libavformat si alguien va a decodificar en proceso. */
export function isNativeDecodeAvailable(): boolean {
  if (!loadAttempted) {
    loadAttempted = true;
    // Medido (ENGINE-BUN-WAY.md): Bun 1.2 (glibc) revienta dentro de
    // avformat_find_stream_info vía FFI; 1.2 musl, 1.3 y 1.4 funcionan. Por debajo
    // de 1.3 no se arriesga el proceso entero: decks con ffmpeg CLI.
    if (Bun.semver.order(Bun.version, "1.3.0") < 0) {
      rtmpLog.event("info", Event.nativeFallback, `Bun ${Bun.version} < 1.3: decode nativo desactivado; decks con ffmpeg CLI`);
      return false;
    }
    if (!loadMemcpy()) {
      rtmpLog.event("warn", Event.nativeFallback, "No se pudo cargar memcpy de libc; decks con ffmpeg CLI");
    } else {
      symbols = loadLibs();
    }
  }
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
  const ctxBuf = new Uint8Array(8);
  const swrBuf = new Uint8Array(8);
  const frameBuf = new Uint8Array(8);
  const pktBuf = new Uint8Array(8);

  let fmtCtx = 0;
  let avctx = 0;
  let swr = 0;
  let frame = 0;
  let pkt = 0;

  const cleanupPartial = () => {
    if (swr) { writePtr(swrBuf, swr); try { S.swr_free(ptr(swrBuf)); } catch {} }
    if (frame) { writePtr(frameBuf, frame); try { S.av_frame_free(ptr(frameBuf)); } catch {} }
    if (pkt) { writePtr(pktBuf, pkt); try { S.av_packet_free(ptr(pktBuf)); } catch {} }
    if (avctx) { writePtr(ctxBuf, avctx); try { S.avcodec_free_context(ptr(ctxBuf)); } catch {} }
    if (fmtCtx) { writePtr(fmtBuf, fmtCtx); try { S.avformat_close_input(ptr(fmtBuf)); } catch {} }
  };

  try {
    // Bun 1.3 no acepta strings en args FFI: ruta NUL-terminada como buffer
    const pathBuf = new TextEncoder().encode(path + "\0");
    let r = S.avformat_open_input(ptr(fmtBuf), ptr(pathBuf), null, null);
    if (r < 0) throw new Error(`avformat_open_input falló (${r})`);
    fmtCtx = readPtr(ptr(fmtBuf));

    r = S.avformat_find_stream_info(fmtCtx, null);
    if (r < 0) throw new Error(`avformat_find_stream_info falló (${r})`);

    const streams = readPtr(fmtCtx + AVFORMAT_STREAMS);
    const decBuf = new Uint8Array(8);
    const streamIdx = S.av_find_best_stream(fmtCtx, AVMEDIA_TYPE_AUDIO, -1, -1, ptr(decBuf), null);
    if (streamIdx < 0) throw new Error("archivo sin flujo de audio");
    const decoder = readPtr(ptr(decBuf));

    avctx = S.avcodec_alloc_context3(decoder);
    if (!avctx) throw new Error("avcodec_alloc_context3 falló");

    const streamPtr = readPtr(streams + streamIdx * 8);
    const codecpar = readPtr(streamPtr + AVSTREAM_CODECPAR);
    r = S.avcodec_parameters_to_context(avctx, codecpar);
    if (r < 0) throw new Error(`avcodec_parameters_to_context falló (${r})`);
    r = S.avcodec_open2(avctx, decoder, null);
    if (r < 0) throw new Error(`avcodec_open2 falló (${r})`);

    const inFmt = readI32(codecpar, CODEPAR_FORMAT);
    const inRate = readI32(codecpar, CODEPAR_SAMPLE_RATE);
    let inLayout = readI64(codecpar, CODEPAR_CHANNEL_LAYOUT);
    const inChannels = readI32(codecpar, CODEPAR_CHANNELS);
    // Cordura: si un offset no corresponde a la lib cargada, estos valores salen
    // absurdos. Mejor rechazar la pista (→ ffmpeg CLI) que alimentar swr con basura.
    if (!(inRate >= 1000 && inRate <= 768_000) || !(inFmt >= 0 && inFmt <= 11) || !(inChannels >= 1 && inChannels <= 64)) {
      throw new Error(`parámetros de audio no plausibles (rate=${inRate} fmt=${inFmt} ch=${inChannels})`);
    }
    if (!inLayout) {
      inLayout = inChannels === 1 ? AV_CH_LAYOUT_MONO : AV_CH_LAYOUT_STEREO;
    }

    swr = S.swr_alloc_set_opts(null, AV_CH_LAYOUT_STEREO, AV_SAMPLE_FMT_S16, 48000, inLayout, inFmt, inRate, 0, null);
    if (!swr) throw new Error("swr_alloc_set_opts falló");
    if (S.swr_init(swr) < 0) throw new Error("swr_init falló");

    frame = S.av_frame_alloc();
    pkt = S.av_packet_alloc();
    if (!frame || !pkt) throw new Error("av_frame_alloc/av_packet_alloc falló");

    writePtr(ctxBuf, avctx);
    writePtr(swrBuf, swr);
    writePtr(frameBuf, frame);
    writePtr(pktBuf, pkt);

    return { fmtCtx, avctx, swr, frame, pkt, streamIdx, fmtBuf, ctxBuf, swrBuf, frameBuf, pktBuf, swrOutPtr: new Uint8Array(8) };
  } catch (err) {
    cleanupPartial();
    throw err;
  }
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
// DECODE: llena `out` con PCM s16le 48 kHz estéreo hasta `limit` bytes.
// Al llegar al EOF del demuxer: paquete nulo → drena el decoder → drena
// swresample (las muestras retenidas por el filtro de remuestreo). Antes
// se devolvía en cuanto se enviaba el paquete nulo y se perdía la cola.
// =============================================================
interface DrainState { sentFlush: boolean; decoderDone: boolean; done: boolean; errors: number }

function decodeInto(st: TrackState, out: Uint8Array, limit: number, ds: DrainState): number {
  const S = symbols!;
  let written = 0;
  while (written < limit && !ds.done) {
    if (ds.decoderDone) {
      // Vaciar el remuestreador: swr_convert con entrada nula
      const room = Math.floor((out.length - written) / 4);
      if (room <= 0) break;
      writePtr(st.swrOutPtr, ptr(out) + written);
      const n = S.swr_convert(st.swr, ptr(st.swrOutPtr), room, null, 0);
      if (n <= 0) { ds.done = true; break; }
      written += n * 4;
      continue;
    }
    const r = S.avcodec_receive_frame(st.avctx, st.frame);
    if (r === AVERROR_EAGAIN) {
      if (ds.sentFlush) { ds.decoderDone = true; continue; }
      const pr = S.av_read_frame(st.fmtCtx, st.pkt);
      if (pr < 0) {
        // Fin del archivo: paquete nulo y seguir drenando frames retenidos
        ds.sentFlush = true;
        S.avcodec_send_packet(st.avctx, null);
        continue;
      }
      if (readI32(st.pkt, AVPACKET_STREAM_INDEX) !== st.streamIdx) {
        S.av_packet_unref(st.pkt);
        continue;
      }
      const sr = S.avcodec_send_packet(st.avctx, st.pkt);
      // avcodec_send_packet NO libera el paquete: sin av_packet_unref,
      // cada paquete (~192KB/s de audio comprimido) se fuga para siempre
      // (~11MB/min de RSS). Mismo criterio con av_frame_unref tras swr.
      S.av_packet_unref(st.pkt);
      if (sr < 0 && sr !== AVERROR_EAGAIN) {
        // Paquete corrupto: ffmpeg CLI lo descarta y sigue; aquí igual
        continue;
      }
      continue;
    }
    if (r === AVERROR_EOF) { ds.decoderDone = true; continue; } // decoder vacío tras el flush
    if (r < 0) {
      // Error de decodificación de un frame: ffmpeg CLI lo registra y sigue
      if (++ds.errors > MAX_CONSECUTIVE_DECODE_ERRORS) ds.decoderDone = true;
      continue;
    }
    ds.errors = 0;

    const nbSamples = readI32(st.frame, AVFRAME_NB_SAMPLES);
    if (nbSamples <= 0) { S.av_frame_unref(st.frame); continue; }
    const room = Math.floor((out.length - written) / 4);
    writePtr(st.swrOutPtr, ptr(out) + written);
    // `room` incluye margen para el frame más grande; si no cabe todo, swr retiene
    // el resto internamente y sale en la siguiente llamada (no se pierde).
    const outCount = S.swr_convert(st.swr, ptr(st.swrOutPtr), room, st.frame, nbSamples);
    S.av_frame_unref(st.frame); // liberar el búfer del frame decodificado
    if (outCount > 0) written += outCount * 4;
  }
  return written;
}

/**
 * Decodifica un archivo entero en proceso, sin pacing (tests, verificación de
 * PCM contra ffmpeg CLI y, en el futuro, análisis de pista sin spawn).
 */
export function decodeFileToPcm(path: string, maxBytes = Number.MAX_SAFE_INTEGER): Uint8Array {
  if (!isNativeDecodeAvailable()) throw new Error("decode nativo no disponible");
  const st = openTrack(path);
  const parts: Uint8Array[] = [];
  let total = 0;
  const ds: DrainState = { sentFlush: false, decoderDone: false, done: false, errors: 0 };
  try {
    while (!ds.done && total < maxBytes) {
      const block = new Uint8Array(ACCUM_CAPACITY);
      const n = decodeInto(st, block, PCM_BYTES_PER_SECOND, ds);
      if (n > 0) { parts.push(block.subarray(0, n)); total += n; }
    }
  } finally {
    closeTrack(st);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

// =============================================================
// NATIVE DECODER — misma interfaz que un proceso ffmpeg:
//   .stdout.getReader() → chunks PCM s16le 48k estéreo  .kill()  .exited
// Pacing equivalente a `ffmpeg -re` (ffmpeg 6.1: readrate 1 con
// readrate_initial_burst 0.5 s): ráfaga inicial de 0.5 s y luego 1× por
// reloj de pared, autocorregido. Esa ráfaga es la que llena el buffer del
// deck entrante antes del crossfade; sin ella habría huecos al cruzar.
//
// Memoria (mimalloc / Drepper): swr escribe en un scratch reutilizado; cada
// ~1 s se copia a un bloque del tamaño exacto (1 asignación/s) y se encolan
// VISTAS de 4 KiB (≈21 ms) de ese bloque, sin más copias. Los consumidores
// (buffer del deck, historial) guardan referencias: un bloque nunca se reutiliza.
// =============================================================
const CHUNK_BYTES = 4096; // 1024 frames ≈ 21,3 ms: granularidad del crossfade (ffmpeg: 26-93 ms)
const INITIAL_BURST_BYTES = 96_000; // 0,5 s
const TICK_MAX_MS = 50;

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
            .then(() => resolve(this.cancelled ? 143 : 0))
            .catch((err) => {
              rtmpLog.fail(ErrorCode.decode, "Error en bucle de decode nativo", { error: err instanceof Error ? err.message : String(err) });
              try { controller.error(err); } catch { /* noop */ }
              resolve(1);
            });
        },
        cancel: () => { this.cancelled = true; },
      });
    });
  }

  /** Igual que Subprocess.kill(): la señal se ignora, el bucle para en el siguiente tick. */
  kill(_signal?: number | string) {
    this.cancelled = true;
  }

  private async run(st: TrackState, controller: ReadableStreamDefaultController<Uint8Array>) {
    const ds: DrainState = { sentFlush: false, decoderDone: false, done: false, errors: 0 };
    const scratch = new Uint8Array(ACCUM_CAPACITY); // destino de swr, reutilizado
    let block = new Uint8Array(0);
    let blockOff = 0;
    let blockLen = 0;
    let emitted = 0;
    const t0 = performance.now();

    try {
      while (!this.cancelled) {
        if (controller.desiredSize !== null && controller.desiredSize < -PCM_BYTES_PER_SECOND) {
          await Bun.sleep(100); // consumidor lento: backoff simple
          continue;
        }
        const allowed = INITIAL_BURST_BYTES + (performance.now() - t0) * 192;
        let ended = false;
        while (emitted + CHUNK_BYTES <= allowed) {
          if (blockOff >= blockLen) {
            if (ds.done) { ended = true; break; }
            const n = decodeInto(st, scratch, PCM_BYTES_PER_SECOND, ds);
            if (n === 0) { ended = true; break; }
            // Copia al tamaño exacto: el scratch lleva ~98 KB de margen para el frame
            // más grande; reservar el bloque con margen asignaba un 50 % de más (medido).
            block = scratch.slice(0, n);
            blockLen = n;
            blockOff = 0;
          }
          const n = Math.min(CHUNK_BYTES, blockLen - blockOff);
          try {
            controller.enqueue(block.subarray(blockOff, blockOff + n));
          } catch {
            ended = true; // stream cancelado
            break;
          }
          blockOff += n;
          emitted += n;
        }
        if (ended) break;
        const dueInMs = (emitted + CHUNK_BYTES - INITIAL_BURST_BYTES) / 192 - (performance.now() - t0);
        await Bun.sleep(Math.max(1, Math.min(TICK_MAX_MS, dueInMs)));
      }
    } finally {
      try { controller.close(); } catch { /* noop */ }
      closeTrack(st);
    }
  }
}
