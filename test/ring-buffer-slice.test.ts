import { describe, expect, it } from "bun:test";
import { AudioRingBuffer } from "../src/ring-buffer";

describe("AudioRingBuffer Direct Slicing & Reset", () => {
  it("slices slots efficiently using readSince without full array filtering", () => {
    const ring = new AudioRingBuffer(1024 * 1024);

    for (let i = 0; i < 10; i++) {
      const chunk = new Uint8Array([i]);
      ring.push(chunk, 1);
    }

    expect(ring.length).toBe(10);
    expect(ring.oldestSeq).toBe(1);
    expect(ring.latestSeq).toBe(10);

    // Read since seq 5
    const result = ring.readSince(5);
    expect(result).not.toBeNull();
    expect(result!.slots.length).toBe(5);
    expect(result!.slots[0].seqId).toBe(6);
    expect(result!.slots[4].seqId).toBe(10);

    // Read since latest seq (10) -> should be empty
    const upToDate = ring.readSince(10);
    expect(upToDate).not.toBeNull();
    expect(upToDate!.slots.length).toBe(0);

    // Read with negative seq or far behind buffer (before oldest - 1)
    const lagged = ring.readSince(-5);
    expect(lagged).toBeNull();

    // Clear buffer
    ring.clear();
    expect(ring.length).toBe(0);
    expect(ring.bytes).toBe(0);
  });
});
