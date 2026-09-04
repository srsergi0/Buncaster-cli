import { dlopen, ptr } from "bun:ffi";
import { rtmpLog } from "./logger";

// =============================================================
// Wrapper Bun.FFI sobre libmp3lame.so — encoding MP3 sin ffmpeg
// =============================================================
// Llama directamente a la librería C compartida del sistema,
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
      rtmpLog.info(`[LAME-FFI] libmp3lame cargada desde ${path}`);
      return true;
    } catch {
      // intentar siguiente ruta
    }
  }
  rtmpLog.warn(
    "[LAME-FFI] No se pudo cargar libmp3lame. Usando fallback ffmpeg para encoding MP3.",
  );
  return false;
}

export class LameEncoder {
  private lame = 0;
  private mp3buf: Uint8Array;
  private mp3bufSize: number;
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
    if (!this.lame) throw new Error("lame_init() devolvió NULL");

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
      throw new Error(`lame_init_params() falló (código ${ret})`);
    }

    // Buffer de salida MP3 pre-asignado y reutilizable.
    // LAME recomienda: 1.25 * numSamples + 7200 bytes.
    // Para chunks de hasta 192KB PCM (48K frames) → ~67KB + 7200 = ~74KB.
    // Usamos 256KB para margen absoluto.
    this.mp3bufSize = 256 * 1024;
    this.mp3buf = new Uint8Array(this.mp3bufSize);
  }

  /**
   * Encodea PCM interleaved stereo (Int16Array) a MP3.
   * Devuelve un Uint8Array nuevo (copia) seguro para broadcast.
   */
  encode(pcm: Int16Array): Uint8Array {
    if (this.closed || !this.lame || !symbols) return new Uint8Array(0);

    const numSamples = pcm.length / 2; // frames (stereo interleaved)
    if (numSamples === 0) return new Uint8Array(0);

    // Crecer buffer si es necesario (caso raro: chunk enorme)
    const needed = Math.floor(1.25 * numSamples + 7200);
    if (needed > this.mp3bufSize) {
      this.mp3bufSize = needed;
      this.mp3buf = new Uint8Array(this.mp3bufSize);
    }

    const written = symbols.lame_encode_buffer_interleaved(
      this.lame,
      ptr(pcm),
      numSamples,
      ptr(this.mp3buf),
      this.mp3bufSize,
    );

    if (written < 0) {
      rtmpLog.error(`[LAME-FFI] error de encoding: ${written}`);
      return new Uint8Array(0);
    }

    // Copia: broadcast() encola el mismo Uint8Array en múltiples listeners.
    // Si reutilizáramos el buffer en el siguiente encode(), se corrompería.
    // La copia es pequeña (~4-16KB de MP3 por chunk).
    return this.mp3buf.slice(0, written);
  }

  /**
   * Flush final: devuelve los últimos frames MP3 pendientes.
   */
  flush(): Uint8Array {
    if (this.closed || !this.lame || !symbols) return new Uint8Array(0);

    const written = symbols.lame_encode_flush(
      this.lame,
      ptr(this.mp3buf),
      this.mp3bufSize,
    );

    if (written < 0) return new Uint8Array(0);
    return this.mp3buf.slice(0, written);
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
