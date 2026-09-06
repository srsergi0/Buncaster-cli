export interface RingSlot {
  seqId: number;
  timestampMs: number;
  generation: number;
  data: Uint8Array;
}

export class AudioRingBuffer {
  private slots: RingSlot[] = [];
  private totalBytes = 0;
  private seqCounter = 0;
  private readonly maxBytes: number;

  constructor(maxBytes = 256 * 1024) {
    this.maxBytes = maxBytes;
  }

  /**
   * Pushes a chunk into the ring buffer. Creates an immutable copy so
   * underlying scratch buffers (e.g. LAME FFI) cannot overwrite active audio.
   */
  push(chunk: Uint8Array, generation = 0): RingSlot {
    if (chunk.byteLength === 0) {
      throw new Error("Cannot push empty chunk");
    }

    const immutableData = new Uint8Array(chunk);
    this.seqCounter++;
    const slot: RingSlot = {
      seqId: this.seqCounter,
      timestampMs: Date.now(),
      generation,
      data: immutableData,
    };

    this.slots.push(slot);
    this.totalBytes += immutableData.byteLength;

    // Evict older slots when exceeding maxBytes capacity
    while (this.totalBytes > this.maxBytes && this.slots.length > 1) {
      const evicted = this.slots.shift()!;
      this.totalBytes -= evicted.data.byteLength;
    }

    return slot;
  }

  get length(): number {
    return this.slots.length;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get latestSeq(): number {
    return this.seqCounter;
  }

  get oldestSeq(): number {
    return this.slots.length > 0 ? this.slots[0]!.seqId : 0;
  }

  /**
   * Returns a snapshot of recent chunks up to requested bytes for instant prebuffering.
   */
  getSnapshot(requestedBytes: number): Uint8Array[] {
    if (this.slots.length === 0 || requestedBytes <= 0) return [];

    const result: Uint8Array[] = [];
    let accumulated = 0;

    for (let i = this.slots.length - 1; i >= 0; i--) {
      const data = this.slots[i]!.data;
      result.unshift(data);
      accumulated += data.byteLength;
      if (accumulated >= requestedBytes) break;
    }

    return result;
  }

  /**
   * Reads all slots starting after fromSeqId.
   * Returns null if client cursor has fallen off the ring buffer (lag exceeded).
   */
  readSince(fromSeqId: number): { slots: RingSlot[]; latestSeq: number } | null {
    if (this.slots.length === 0) {
      return { slots: [], latestSeq: this.seqCounter };
    }

    const oldest = this.slots[0]!.seqId;
    if (fromSeqId < oldest - 1) {
      return null;
    }

    const unread = this.slots.filter(s => s.seqId > fromSeqId);
    return { slots: unread, latestSeq: this.seqCounter };
  }

  reset() {
    this.slots = [];
    this.totalBytes = 0;
  }
}
