import { describe, expect, it } from "bun:test";

export class AsyncBatchLogger {
  private queue: string[] = [];
  private flushCount = 0;
  private flushedLines: string[] = [];
  private maxBatchSize: number;
  private timer: any = null;

  constructor(maxBatchSize = 10) {
    this.maxBatchSize = maxBatchSize;
  }

  log(message: string) {
    this.queue.push(message);
    if (this.queue.length >= this.maxBatchSize) {
      this.flushSync();
    }
  }

  flushSync(): number {
    if (this.queue.length === 0) return 0;
    const batch = this.queue.splice(0, this.queue.length);
    this.flushedLines.push(...batch);
    this.flushCount++;
    return batch.length;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get totalFlushed(): number {
    return this.flushedLines.length;
  }

  get flushes(): number {
    return this.flushCount;
  }
}

describe("Async Batch Logger", () => {
  it("buffers log messages and flushes in batches to avoid blocking disk writes", () => {
    const logger = new AsyncBatchLogger(5);

    // Add 4 messages - should stay in queue without flushing
    for (let i = 1; i <= 4; i++) {
      logger.log(`msg ${i}`);
    }
    expect(logger.pendingCount).toBe(4);
    expect(logger.totalFlushed).toBe(0);
    expect(logger.flushes).toBe(0);

    // 5th message triggers auto batch flush
    logger.log("msg 5");
    expect(logger.pendingCount).toBe(0);
    expect(logger.totalFlushed).toBe(5);
    expect(logger.flushes).toBe(1);

    // Manual flush empties remaining
    logger.log("msg 6");
    expect(logger.pendingCount).toBe(1);
    const flushed = logger.flushSync();
    expect(flushed).toBe(1);
    expect(logger.pendingCount).toBe(0);
    expect(logger.totalFlushed).toBe(6);
    expect(logger.flushes).toBe(2);
  });
});
