import { describe, expect, it } from "bun:test";

// Class representing the proposed PcmResidueAccumulator
export class PcmResidueAccumulator {
  private residue: Uint8Array = new Uint8Array(0);

  /**
   * Appends incoming chunk and returns only complete 4-byte frames (stereo 16-bit).
   * Retains any leftover 1-3 bytes in memory for the next call.
   */
  feed(chunk: Uint8Array): Uint8Array {
    let combined: Uint8Array;
    if (this.residue.length > 0) {
      combined = new Uint8Array(this.residue.length + chunk.length);
      combined.set(this.residue, 0);
      combined.set(chunk, this.residue.length);
    } else {
      combined = chunk;
    }

    const frameBytes = 4; // 2 channels * 2 bytes (16-bit)
    const alignedLength = Math.floor(combined.length / frameBytes) * frameBytes;
    const remainder = combined.length - alignedLength;

    if (remainder > 0) {
      this.residue = combined.slice(alignedLength);
    } else {
      this.residue = new Uint8Array(0);
    }

    if (alignedLength === 0) {
      return new Uint8Array(0);
    }

    return combined.subarray(0, alignedLength);
  }

  get pendingResidueBytes(): number {
    return this.residue.length;
  }

  reset() {
    this.residue = new Uint8Array(0);
  }
}

/**
 * Soft limiter mixer: uses soft-knee saturation when signals exceed nominal threshold
 * to prevent harsh digital clipping.
 */
export function mixSamplesWithLimiter(
  chunkA: Uint8Array,
  volA: number,
  chunkB: Uint8Array,
  volB: number,
  sampleRate = 48000
): Uint8Array {
  const samplesA = new Int16Array(chunkA.buffer, chunkA.byteOffset, chunkA.byteLength / 2);
  const samplesB = new Int16Array(chunkB.buffer, chunkB.byteOffset, chunkB.byteLength / 2);

  const length = Math.max(samplesA.length, samplesB.length);
  const out = new Uint8Array(length * 2);
  const outSamples = new Int16Array(out.buffer, 0, length);
  const minLen = Math.min(samplesA.length, samplesB.length);

  const THRESHOLD = 28000;
  const CEILING = 32767;

  for (let i = 0; i < minLen; i++) {
    const mixed = (samplesA[i]! * volA) + (samplesB[i]! * volB);
    const abs = Math.abs(mixed);
    let sampleVal: number;

    if (abs <= THRESHOLD) {
      sampleVal = mixed;
    } else {
      // Soft-knee compression beyond threshold: y = T + (C - T) * tanh((x - T) / (C - T))
      const range = CEILING - THRESHOLD;
      const over = abs - THRESHOLD;
      const compressed = THRESHOLD + range * Math.tanh(over / range);
      sampleVal = Math.sign(mixed) * compressed;
    }

    outSamples[i] = Math.max(-32768, Math.min(32767, Math.round(sampleVal)));
  }

  for (let i = minLen; i < samplesA.length; i++) {
    outSamples[i] = Math.max(-32768, Math.min(32767, Math.round(samplesA[i]! * volA)));
  }
  for (let i = minLen; i < samplesB.length; i++) {
    outSamples[i] = Math.max(-32768, Math.min(32767, Math.round(samplesB[i]! * volB)));
  }

  return out;
}

describe("PCM Clock & Residue Handling", () => {
  it("accumulates unaligned bytes and yields strictly 4-byte aligned frames", () => {
    const acc = new PcmResidueAccumulator();

    // Send 5 bytes (1 frame of 4 bytes + 1 leftover byte)
    const chunk1 = new Uint8Array([1, 2, 3, 4, 5]);
    const out1 = acc.feed(chunk1);
    expect(out1.length).toBe(4);
    expect(acc.pendingResidueBytes).toBe(1);
    expect(Array.from(out1)).toEqual([1, 2, 3, 4]);

    // Send 7 bytes (1 leftover + 7 = 8 bytes = 2 frames of 4 bytes, 0 leftover)
    const chunk2 = new Uint8Array([6, 7, 8, 9, 10, 11, 12]);
    const out2 = acc.feed(chunk2);
    expect(out2.length).toBe(8);
    expect(acc.pendingResidueBytes).toBe(0);
    expect(Array.from(out2)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);

    // Send 2 bytes (2 bytes < 4 bytes -> returns 0 bytes, 2 leftover)
    const chunk3 = new Uint8Array([13, 14]);
    const out3 = acc.feed(chunk3);
    expect(out3.length).toBe(0);
    expect(acc.pendingResidueBytes).toBe(2);

    // Send 2 bytes (2 + 2 = 4 bytes -> returns 1 frame of 4 bytes)
    const chunk4 = new Uint8Array([15, 16]);
    const out4 = acc.feed(chunk4);
    expect(out4.length).toBe(4);
    expect(acc.pendingResidueBytes).toBe(0);
    expect(Array.from(out4)).toEqual([13, 14, 15, 16]);
  });

  it("soft limiter avoids harsh digital wrap-around when signals sum above 32767", () => {
    // Two signals with value 25000 and 25000 at volume 1.0 -> sum = 50000 (exceeds 32767)
    const bufA = new Int16Array([25000, -25000]);
    const bufB = new Int16Array([25000, -25000]);

    const mixedBytes = mixSamplesWithLimiter(
      new Uint8Array(bufA.buffer),
      1.0,
      new Uint8Array(bufB.buffer),
      1.0
    );

    const mixedSamples = new Int16Array(mixedBytes.buffer);
    expect(mixedSamples[0]).toBeGreaterThan(28000);
    expect(mixedSamples[0]).toBeLessThanOrEqual(32767);
    expect(mixedSamples[1]).toBeLessThan(-28000);
    expect(mixedSamples[1]).toBeGreaterThanOrEqual(-32768);
  });
});
