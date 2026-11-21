export interface RingSlot {
  seqId: number;
  timestampMs: number;
  generation: number;
  data: Uint8Array;
}

export class AudioRingBuffer {
  // Los slots vivos son slots[head..]. Desalojar avanza `head` (O(1)) en vez de
  // Array.shift() (O(n)); el array se compacta de vez en cuando.
  private slots: RingSlot[] = [];
  private head = 0;
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
    while (this.totalBytes > this.maxBytes && this.slots.length - this.head > 1) {
      const evicted = this.slots[this.head]!;
      this.slots[this.head] = undefined as unknown as RingSlot; // liberar referencia
      this.head++;
      this.totalBytes -= evicted.data.byteLength;
    }
    if (this.head > 1024 && this.head * 2 > this.slots.length) {
      this.slots = this.slots.slice(this.head);
      this.head = 0;
    }

    return slot;
  }

  get length(): number {
    return this.slots.length - this.head;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get latestSeq(): number {
    return this.seqCounter;
  }

  get oldestSeq(): number {
    return this.length > 0 ? this.slots[this.head]!.seqId : 0;
  }

  /**
   * Returns a snapshot of recent chunks up to requested bytes for instant prebuffering.
   * O(k) en el número de slots devueltos (antes era O(k²) por Array.unshift).
   */
  getSnapshot(requestedBytes: number): Uint8Array[] {
    if (this.length === 0 || requestedBytes <= 0) return [];

    let accumulated = 0;
    let start = this.slots.length - 1;
    for (; start >= this.head; start--) {
      accumulated += this.slots[start]!.data.byteLength;
      if (accumulated >= requestedBytes) break;
    }
    if (start < this.head) start = this.head;

    const result: Uint8Array[] = new Array(this.slots.length - start);
    for (let i = start; i < this.slots.length; i++) result[i - start] = this.slots[i]!.data;
    return result;
  }

  /**
   * Reads all slots starting after fromSeqId.
   * Returns null if client cursor has fallen off the ring buffer (lag exceeded).
   */
  readSince(fromSeqId: number): { slots: RingSlot[]; latestSeq: number } | null {
    if (this.length === 0) {
      return { slots: [], latestSeq: this.seqCounter };
    }

    const oldest = this.slots[this.head]!.seqId;
    if (fromSeqId < oldest - 1) {
      return null;
    }

    const startIndex = this.head + Math.max(0, fromSeqId + 1 - oldest);
    const unread = this.slots.slice(startIndex);
    return { slots: unread, latestSeq: this.seqCounter };
  }

  clear() {
    this.reset();
  }

  reset() {
    this.slots = [];
    this.head = 0;
    this.totalBytes = 0;
  }
}
