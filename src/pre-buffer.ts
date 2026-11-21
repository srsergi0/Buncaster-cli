import { config, prebufferBytesFor } from "./config";
import { AudioRingBuffer } from "./ring-buffer";

export class PreBuffer {
  public readonly ring: AudioRingBuffer;

  /**
   * @param maxBytes   tamaño del prebuffer que recibe un oyente al conectar
   * @param kbps       bitrate nominal del tier (para traducir bytes ↔ segundos en métricas)
   */
  constructor(private readonly maxBytes: number, public readonly kbps = 0) {
    this.ring = new AudioRingBuffer(maxBytes);
  }

  push(chunk: Uint8Array, generation = 0): import("./ring-buffer").RingSlot | null {
    if (this.maxBytes <= 0 || chunk.byteLength === 0) return null;
    return this.ring.push(chunk, generation);
  }

  snapshot(): Uint8Array[] {
    return this.ring.getSnapshot(this.maxBytes);
  }

  reset(): void {
    this.ring.reset();
  }

  get bytes(): number {
    return this.ring.bytes;
  }

  get capacityBytes(): number {
    return this.maxBytes;
  }

  /** Segundos de audio que representan `bytes` en este tier (0 si se desconoce el bitrate). */
  secondsFor(bytes: number): number {
    return this.kbps > 0 ? bytes / (this.kbps * 125) : 0;
  }
}

export const preBuffer = new PreBuffer(prebufferBytesFor("mp3"), config.fallbackBitrateKbps);
export const preBufferOpus = new PreBuffer(prebufferBytesFor("opus"), config.opusTierBitrateKbps);
