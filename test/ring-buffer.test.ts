import { describe, expect, it } from "bun:test";

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
      // Client is too slow, audio has already been evicted
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

describe("Audio Ring Buffer", () => {
  it("stores immutable chunks and evicts oldest when capacity is reached", () => {
    // Capacity of 100 bytes
    const ring = new AudioRingBuffer(100);

    const chunk1 = new Uint8Array([1, 2, 3, 4, 5]); // 5 bytes
    ring.push(chunk1, 1);
    expect(ring.length).toBe(1);
    expect(ring.bytes).toBe(5);
    expect(ring.latestSeq).toBe(1);

    // Push 20 chunks of 5 bytes = 100 bytes
    for (let i = 2; i <= 20; i++) {
      ring.push(chunk1, 1);
    }
    expect(ring.bytes).toBe(100);
    expect(ring.latestSeq).toBe(20);
    expect(ring.oldestSeq).toBe(1);

    // Push one more: exceeds 100, evicts chunk 1
    ring.push(chunk1, 1);
    expect(ring.bytes).toBe(100);
    expect(ring.latestSeq).toBe(21);
    expect(ring.oldestSeq).toBe(2);
  });

  it("extracts snapshots for prebuffer up to requested bytes", () => {
    const ring = new AudioRingBuffer(1000);
    ring.push(new Uint8Array(100), 1);
    ring.push(new Uint8Array(200), 1);
    ring.push(new Uint8Array(300), 1);

    const snapshot = ring.getSnapshot(400); // Should get the last two: 300 + 200 = 500
    expect(snapshot.length).toBe(2);
    expect(snapshot[0]!.byteLength).toBe(200);
    expect(snapshot[1]!.byteLength).toBe(300);
  });

  it("detects when a reader has fallen behind the ring buffer horizon", () => {
    const ring = new AudioRingBuffer(50);
    for (let i = 1; i <= 10; i++) {
      ring.push(new Uint8Array(10), 1);
    }
    // Only last 5 chunks retained (seq 6 to 10)
    expect(ring.oldestSeq).toBe(6);

    // Reader asking for seq 2 (too old)
    const resultOld = ring.readSince(2);
    expect(resultOld).toBeNull(); // Client lagged out

    // Reader asking for seq 7 (valid)
    const resultValid = ring.readSince(7);
    expect(resultValid).not.toBeNull();
    expect(resultValid!.slots.length).toBe(3); // 8, 9, 10
  });
});
