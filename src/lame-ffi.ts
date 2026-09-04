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
      rtmpLog.info(`[LAME-FFI] libmp3lame loaded from ${path}`);
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
