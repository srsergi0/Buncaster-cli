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
