import { describe, expect, it } from "bun:test";
import { chunkWithIcy, createIcyState } from "../src/icy-metadata";

describe("ICY Prebuffer Cadence & Alignment", () => {
  it("encapsulates multiple prebuffer chunks preserving exact metadata interval", () => {
    const icyState = createIcyState();
    icyState.metaInterval = 1000; // 1000 bytes per interval
    icyState.bytesSinceMeta = 0;

    // Simulate 3 prebuffer chunks of 600 bytes each (total 1800 bytes)
    const chunk1 = new Uint8Array(600);
    chunk1.fill(1);
    const chunk2 = new Uint8Array(600);
    chunk2.fill(2);
    const chunk3 = new Uint8Array(600);
    chunk3.fill(3);

    const title = "Artist - Test Song";

    // Chunk 1: 600 bytes audio, bytesSinceMeta becomes 600
    const pieces1 = chunkWithIcy(chunk1, icyState, title);
    expect(pieces1.length).toBe(1);
    expect(pieces1[0].byteLength).toBe(600);
    expect(icyState.bytesSinceMeta).toBe(600);

    // Chunk 2: 400 bytes audio, metadata block, 200 bytes audio
    const pieces2 = chunkWithIcy(chunk2, icyState, title);
    expect(pieces2.length).toBe(3);
    expect(pieces2[0].byteLength).toBe(400);
    // pieces2[1] is metadata block
    expect(pieces2[1].byteLength).toBeGreaterThan(0);
    expect(pieces2[1][0]).toBeGreaterThan(0); // length indicator
    expect(pieces2[2].byteLength).toBe(200);
    expect(icyState.bytesSinceMeta).toBe(200);

    // Chunk 3: 600 bytes audio, bytesSinceMeta becomes 800
    const pieces3 = chunkWithIcy(chunk3, icyState, title);
    expect(pieces3.length).toBe(1);
    expect(pieces3[0].byteLength).toBe(600);
    expect(icyState.bytesSinceMeta).toBe(800);
  });
});
