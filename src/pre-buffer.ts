import { config } from "./config";

export class PreBuffer {
  private chunks: Uint8Array[] = [];
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) { }

  push(chunk: Uint8Array): void {
    if (this.maxBytes <= 0) return;
    this.chunks.push(chunk);
    this.totalBytes += chunk.byteLength;
    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      this.totalBytes -= removed.byteLength;
    }
  }

  snapshot(): Uint8Array[] {
    return [...this.chunks];
  }

  reset(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}

export const preBuffer = new PreBuffer(config.preBufferBytes);
export const preBufferOpus = new PreBuffer(config.preBufferBytes);
