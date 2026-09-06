import { describe, expect, it } from "bun:test";

export class BackpressureTracker {
  public slowStrikes = 0;
  public evicted = false;
  private highWaterMarkBytes: number;
  private queuedBytes = 0;

  constructor(highWaterMarkBytes = 256 * 1024) {
    this.highWaterMarkBytes = highWaterMarkBytes;
  }

  enqueue(chunk: Uint8Array): void {
    this.queuedBytes += chunk.byteLength;
  }

  drain(bytes: number): void {
    this.queuedBytes = Math.max(0, this.queuedBytes - bytes);
  }

  get desiredSize(): number {
    return this.highWaterMarkBytes - this.queuedBytes;
  }

  checkBackpressure(maxStrikes = 5): boolean {
    if (this.desiredSize < 0) {
      this.slowStrikes++;
      if (this.slowStrikes >= maxStrikes) {
        this.evicted = true;
        return false; // Evict
      }
    } else {
      this.slowStrikes = 0;
    }
    return true; // OK
  }
}

describe("Byte Backpressure & Eviction", () => {
  it("tracks backpressure in bytes and triggers eviction after consecutive saturated strikes", () => {
    // 100 KB high watermark
    const tracker = new BackpressureTracker(100 * 1024);

    // Enqueue 80 KB -> desiredSize > 0, no strikes
    tracker.enqueue(new Uint8Array(80 * 1024));
    expect(tracker.desiredSize).toBe(20 * 1024);
    expect(tracker.checkBackpressure(3)).toBe(true);
    expect(tracker.slowStrikes).toBe(0);

    // Enqueue another 30 KB -> total 110 KB (desiredSize = -10 KB)
    tracker.enqueue(new Uint8Array(30 * 1024));
    expect(tracker.desiredSize).toBe(-10 * 1024);

    // Strike 1
    expect(tracker.checkBackpressure(3)).toBe(true);
    expect(tracker.slowStrikes).toBe(1);

    // Strike 2
    expect(tracker.checkBackpressure(3)).toBe(true);
    expect(tracker.slowStrikes).toBe(2);

    // Strike 3 -> Evicted!
    expect(tracker.checkBackpressure(3)).toBe(false);
    expect(tracker.evicted).toBe(true);
  });
});
