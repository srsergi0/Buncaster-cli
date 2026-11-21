// =============================================================
// Formato "hang" (draft-lcurley-moq-hang) para el audio de Buncaster
// -------------------------------------------------------------
// moq-relay no sabe nada de códecs: reenvía broadcasts → tracks → grupos →
// frames. hang es la capa de medios de Curley encima: un track
// `catalog.json` que describe las renditions con la forma de un
// AudioDecoderConfig de WebCodecs, y un contenedor "legacy" por frame
// (varint QUIC con el timestamp en µs + paquete Opus crudo). Publicar así
// permite que cualquier reproductor hang (@moq/watch, `moq play`) lo abra,
// no solo nuestro cliente.
// Extensión propia (permitida por hang: el catálogo es un objeto abierto):
// `bloom.clock`, un track JSON con pares {pts, wall} para que el cliente
// estime su retraso real respecto a la entrada del motor.
// =============================================================

/** Época de hang/moq para `clock.wall` (2020-01-01T00:00:00Z). */
export const MOQ_EPOCH_UNIX_MS = Date.UTC(2020, 0, 1);

/** Varint QUIC (RFC 9000 §16), hasta 2^53. */
export function encodeVarint(v: number): Uint8Array {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`varint fuera de rango: ${v}`);
  if (v < 0x40) return Uint8Array.of(v);
  if (v < 0x4000) return Uint8Array.of(0x40 | (v >> 8), v & 0xff);
  if (v < 0x40000000) {
    return Uint8Array.of(0x80 | (v >>> 24), (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
  const out = new Uint8Array(8);
  const hi = Math.floor(v / 2 ** 32);
  const lo = v >>> 0;
  new DataView(out.buffer).setUint32(0, (0xc0000000 | hi) >>> 0);
  new DataView(out.buffer).setUint32(4, lo);
  return out;
}

export function decodeVarint(b: Uint8Array): [number, Uint8Array] {
  const tag = b[0]! >> 6;
  const len = 1 << tag;
  if (b.length < len) throw new RangeError("varint truncado");
  let v = b[0]! & 0x3f;
  for (let i = 1; i < len; i++) v = v * 256 + b[i]!;
  return [v, b.subarray(len)];
}

/** Frame del contenedor legacy: varint(timestamp µs) ‖ paquete del códec. */
export function encodeLegacyFrame(timestampUs: number, payload: Uint8Array): Uint8Array {
  const ts = encodeVarint(timestampUs);
  const out = new Uint8Array(ts.length + payload.length);
  out.set(ts, 0);
  out.set(payload, ts.length);
  return out;
}

export interface CatalogOptions {
  audioTrack: string;
  bitrateKbps: number;
  /** Retraso máximo del publicador entre trama lista y envío (ms). */
  jitterMs: number;
  /** Tiempo de pared del PTS 0 (ms Unix). */
  wallAtPts0Ms: number;
  clockTrack: string;
}

export function buildCatalog(o: CatalogOptions) {
  return {
    audio: {
      renditions: {
        [o.audioTrack]: {
          codec: "opus",
          container: { kind: "legacy" },
          sampleRate: 48000,
          numberOfChannels: 2,
          bitrate: Math.round(o.bitrateKbps * 1000),
          jitter: Math.max(1, Math.ceil(o.jitterMs)),
        },
      },
    },
    clock: {
      wall: Math.round((o.wallAtPts0Ms - MOQ_EPOCH_UNIX_MS) * 1000),
      timescale: 1_000_000,
    },
    // Extensión de aplicación (los lectores hang ignoran secciones desconocidas)
    "bloom.clock": { track: o.clockTrack, mode: "snapshot", format: "json" },
  };
}
