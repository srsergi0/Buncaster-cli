// =============================================================
// libopus por FFI para el canal MoQ (RFC 6716)
// -------------------------------------------------------------
// El tier HTTP sigue con su proceso ffmpeg (Ogg, páginas de ~1 s). Para MoQ
// hacen falta paquetes sueltos de 20 ms en cuanto existen: un encoder en
// proceso entrega cada trama al instante y sin contenedor. Mismos ajustes que
// el wrapper de ffmpeg medido con PEAQ (docs/ENGINE-MOQ.md §3): APPLICATION_AUDIO,
// VBR sin restringir, complejidad 10, sin FEC.
//
// `opus_encoder_ctl` es variádica. En x86-64 SysV y AArch64 Linux un entero
// variádico viaja en el mismo registro que uno fijo, así que se declara con
// firma fija; en macOS arm64 (variádicos en pila) se desactiva.
// =============================================================
import { dlopen, FFIType, ptr } from "bun:ffi";

export const OPUS_APPLICATION_AUDIO = 2049;
const OPUS_SET_BITRATE = 4002;
const OPUS_SET_VBR = 4006;
const OPUS_SET_COMPLEXITY = 4010;
const OPUS_SET_INBAND_FEC = 4012;
const OPUS_SET_PACKET_LOSS_PERC = 4014;
const OPUS_SET_VBR_CONSTRAINT = 4020;
const OPUS_GET_LOOKAHEAD = 4027;
const OPUS_SET_DRED_DURATION = 4050;
const OPUS_RESET_STATE = 4028;
export const OPUS_UNIMPLEMENTED = -5;

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
/** Trama por defecto: 20 ms. MOQ_OPUS_FRAME_MS admite 20, 40 o 60 (paquetes de varias tramas CELT). */
export const FRAME_SAMPLES = 960;
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;
export function frameSamplesFor(ms: number): number {
  if (ms !== 20 && ms !== 40 && ms !== 60) throw new Error(`MOQ_OPUS_FRAME_MS=${ms}: usa 20, 40 o 60`);
  return (SAMPLE_RATE / 1000) * ms;
}

const CANDIDATES = [
  "libopus.so.0",
  "/usr/lib/libopus.so.0",
  "/usr/lib/x86_64-linux-gnu/libopus.so.0",
  "/usr/lib/aarch64-linux-gnu/libopus.so.0",
  "/opt/homebrew/lib/libopus.dylib",
  "/usr/local/lib/libopus.dylib",
];

const SYMBOLS = {
  opus_get_version_string: { args: [], returns: FFIType.cstring },
  opus_encoder_create: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
  opus_encoder_ctl: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  opus_encode: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  opus_encoder_destroy: { args: [FFIType.ptr], returns: FFIType.void },
} as const;

type Lib = ReturnType<typeof dlopen<typeof SYMBOLS>>;
let lib: Lib | null = null;
let loadError: string | null = null;
let loadedFrom = "";

function load(): Lib | null {
  if (lib || loadError) return lib;
  if (process.platform === "darwin" && process.arch === "arm64") {
    loadError = "opus_encoder_ctl variádica no soportada por FFI en macOS arm64";
    return null;
  }
  for (const p of CANDIDATES) {
    try {
      lib = dlopen(p, SYMBOLS);
      loadedFrom = p;
      return lib;
    } catch { /* siguiente */ }
  }
  loadError = "libopus no encontrada";
  return null;
}

export function opusAvailable(): boolean {
  return load() !== null;
}
export function opusLoadError(): string | null {
  load();
  return loadError;
}
export function opusVersion(): string {
  const l = load();
  return l ? String(l.symbols.opus_get_version_string()) : "";
}
export function opusLibraryPath(): string {
  load();
  return loadedFrom;
}

export interface OpusEncoderOptions {
  bitrateKbps: number;
  complexity?: number;
  /** FEC en banda (LBRR). Medido: fuerza modo híbrido y hunde la calidad musical (§3). */
  inbandFec?: boolean;
  packetLossPerc?: number;
  /** Duración de DRED en unidades de 10 ms (0 = off). Requiere libopus con --enable-dred. */
  dredDuration?: number;
  /** Duración de cada paquete (20, 40 o 60 ms). */
  frameMs?: number;
}

export class OpusFrameEncoder {
  private st: any;
  readonly frameSamples: number;
  private readonly out = new Uint8Array(4000);
  private readonly outPtr: any;
  readonly lookahead: number;
  /** Resultado de pedir DRED (0 OK, -5 no compilado, null no pedido). */
  readonly dredStatus: number | null;

  constructor(opts: OpusEncoderOptions) {
    const l = load();
    if (!l) throw new Error(`MoQ: ${loadError}`);
    this.frameSamples = frameSamplesFor(opts.frameMs ?? 20);
    const err = new Int32Array(1);
    this.st = l.symbols.opus_encoder_create(SAMPLE_RATE, CHANNELS, OPUS_APPLICATION_AUDIO, ptr(err));
    if (err[0] !== 0 || !this.st) throw new Error(`opus_encoder_create: error ${err[0]}`);
    const ctl = (req: number, v: number) => {
      const r = l.symbols.opus_encoder_ctl(this.st, req, v);
      if (r !== 0) throw new Error(`opus_encoder_ctl(${req}, ${v}) = ${r}`);
    };
    ctl(OPUS_SET_BITRATE, Math.round(opts.bitrateKbps * 1000));
    ctl(OPUS_SET_VBR, 1);
    ctl(OPUS_SET_VBR_CONSTRAINT, 0);
    ctl(OPUS_SET_COMPLEXITY, opts.complexity ?? 10);
    ctl(OPUS_SET_INBAND_FEC, opts.inbandFec ? 1 : 0);
    ctl(OPUS_SET_PACKET_LOSS_PERC, Math.max(0, Math.min(100, opts.packetLossPerc ?? 0)));
    this.dredStatus = opts.dredDuration ? l.symbols.opus_encoder_ctl(this.st, OPUS_SET_DRED_DURATION, opts.dredDuration) : null;
    // GET_LOOKAHEAD toma un int*: misma función con otra firma, en un segundo handle
    // (CFunction sobre `.ptr` no funciona en Bun 1.2).
    const la = new Int32Array(1);
    try {
      const h = dlopen(loadedFrom, { opus_encoder_ctl: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
      h.symbols.opus_encoder_ctl(this.st, OPUS_GET_LOOKAHEAD, ptr(la));
      h.close();
    } catch { la[0] = 312; /* 48 kHz, APPLICATION_AUDIO */ }
    this.lookahead = la[0]!;
    this.outPtr = ptr(this.out);
  }

  /** Codifica una trama (frameSamples × 2 canales s16le). Devuelve una copia. */
  encode(frame: Int16Array): Uint8Array {
    if (!this.st) throw new Error("encoder cerrado");
    if (frame.length !== this.frameSamples * CHANNELS) throw new Error(`trama de ${frame.length} muestras`);
    const n = lib!.symbols.opus_encode(this.st, ptr(frame), this.frameSamples, this.outPtr, this.out.length);
    if (n < 0) throw new Error(`opus_encode: error ${n}`);
    return this.out.slice(0, n);
  }

  /** Olvida el estado (solape MDCT, predicción): tras un rato sin codificar. */
  reset(): void {
    if (this.st) lib!.symbols.opus_encoder_ctl(this.st, OPUS_RESET_STATE, 0);
  }

  close(): void {
    if (this.st) { lib!.symbols.opus_encoder_destroy(this.st); this.st = null; }
  }
}

/**
 * Trocea PCM s16le estéreo de tamaño arbitrario en tramas exactas
 * (sin asignaciones por trozo: un único búfer de trama reutilizado).
 */
export class PcmFramer {
  private readonly frame: Int16Array;
  private readonly frameBytes: Uint8Array;
  private readonly size: number;
  private fill = 0;

  constructor(frameSamples = FRAME_SAMPLES) {
    this.frame = new Int16Array(frameSamples * CHANNELS);
    this.frameBytes = new Uint8Array(this.frame.buffer);
    this.size = this.frameBytes.byteLength;
  }

  /** Llama a `onFrame` por cada trama completa; el Int16Array se reutiliza. */
  push(chunk: Uint8Array, onFrame: (frame: Int16Array) => void): void {
    let off = 0;
    while (off < chunk.byteLength) {
      const n = Math.min(this.size - this.fill, chunk.byteLength - off);
      this.frameBytes.set(chunk.subarray(off, off + n), this.fill);
      this.fill += n;
      off += n;
      if (this.fill === this.size) {
        this.fill = 0;
        onFrame(this.frame);
      }
    }
  }

  get pendingBytes(): number { return this.fill; }
  reset(): void { this.fill = 0; }
}
