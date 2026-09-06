import { config } from "./config";
import { AudioRingBuffer } from "./ring-buffer";

export class PreBuffer {
  public readonly ring: AudioRingBuffer;

  constructor(private readonly maxBytes: number) {
    this.ring = new AudioRingBuffer(maxBytes);
  }

  push(chunk: Uint8Array, generation = 0): void {
    if (this.maxBytes <= 0 || chunk.byteLength === 0) return;
    this.ring.push(chunk, generation);
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
}

export const preBuffer = new PreBuffer(config.preBufferBytes);
export const preBufferOpus = new PreBuffer(config.preBufferBytes);

