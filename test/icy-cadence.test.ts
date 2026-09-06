import { describe, expect, it } from "bun:test";

export interface IcyState {
  bytesSinceMeta: number;
  metaInterval: number;
}

const metaBlockCache = new Map<string, Uint8Array>();

export function getCachedMetadataBlock(title: string): Uint8Array {
  if (!title) {
    // 0x00 indicates a metadata block of length 0 * 16 = 0
    return new Uint8Array([0]);
  }
  const cached = metaBlockCache.get(title);
  if (cached) return cached;

  const trimmed = title.slice(0, 400).replace(/'/g, "\\'");
  const encoded = new TextEncoder().encode(`StreamTitle='${trimmed}';StreamUrl='';`);
  const blockSize = Math.ceil((encoded.length + 1) / 16) * 16;
  const buf = new Uint8Array(blockSize + 1);
  buf[0] = blockSize / 16;
  buf.set(encoded, 1);

  metaBlockCache.set(title, buf);
  return buf;
}

export function chunkWithIcyRobust(
  chunk: Uint8Array,
  state: IcyState,
  title: string
): Uint8Array[] {
  const result: Uint8Array[] = [];
  let offset = 0;

  while (offset < chunk.length) {
    const remaining = chunk.length - offset;
    const space = state.metaInterval - state.bytesSinceMeta;

    if (remaining < space) {
      const piece = offset === 0 && remaining === chunk.length ? chunk : chunk.subarray(offset);
      result.push(piece);
      state.bytesSinceMeta += remaining;
      offset = chunk.length;
    } else {
      // Audio chunk up to the metadata interval
      result.push(chunk.subarray(offset, offset + space));
      state.bytesSinceMeta += space;
      offset += space;

      // Emit metadata block (0x00 if title is empty, or formatted block)
      const metaBlock = getCachedMetadataBlock(title);
      result.push(metaBlock);
      state.bytesSinceMeta = 0;
    }
  }

  return result;
}

describe("ICY Cadence & Metadata Robustness", () => {
  it("emits 0x00 byte when title is empty to preserve exact metaInterval cadence", () => {
    const state: IcyState = { bytesSinceMeta: 0, metaInterval: 100 };

    // Send 120 bytes with empty title
    const chunk = new Uint8Array(120);
    const pieces = chunkWithIcyRobust(chunk, state, "");

    // Should have:
    // piece 0: 100 bytes of audio
    // piece 1: 1 byte of metadata [0x00]
    // piece 2: 20 bytes of audio
    expect(pieces.length).toBe(3);
    expect(pieces[0]!.length).toBe(100);
    expect(pieces[1]!.length).toBe(1);
    expect(pieces[1]![0]).toBe(0); // 0x00 = empty metadata block
    expect(pieces[2]!.length).toBe(20);
    expect(state.bytesSinceMeta).toBe(20);
  });

  it("caches metadata blocks for performance", () => {
    const title = "Artist - Song Title";
    const block1 = getCachedMetadataBlock(title);
    const block2 = getCachedMetadataBlock(title);
    expect(block1).toBe(block2); // Same cached instance!
    expect(block1[0]).toBeGreaterThan(0);
  });
});
