import { describe, expect, it } from "bun:test";
import { extractOggOpusHeaders } from "../src/audio-router";

describe("Ogg/Opus Header Parsing & Invalidation", () => {
  function makeOggPage(payloadSize: number, headerType: number): Uint8Array {
    const page = new Uint8Array(27 + 1 + payloadSize);
    // Magic OggS
    page[0] = 0x4f;
    page[1] = 0x67;
    page[2] = 0x67;
    page[3] = 0x73;
    page[4] = 0; // version
    page[5] = headerType; // e.g. 0x02 for BOS
    page[26] = 1; // 1 segment
    page[27] = payloadSize;
    // fill payload with dummy data
    for (let i = 0; i < payloadSize; i++) {
      page[28 + i] = 0xaa;
    }
    return page;
  }

  it("extracts exactly the first two Ogg pages (OpusHead + OpusTags)", () => {
    const page1 = makeOggPage(19, 0x02); // OpusHead page
    const page2 = makeOggPage(24, 0x00); // OpusTags page
    const page3 = makeOggPage(100, 0x00); // Audio data page

    const combined = new Uint8Array(page1.length + page2.length + page3.length);
    combined.set(page1, 0);
    combined.set(page2, page1.length);
    combined.set(page3, page1.length + page2.length);

    const headers = extractOggOpusHeaders(combined);
    expect(headers).not.toBeNull();
    expect(headers!.length).toBe(page1.length + page2.length);
    // Magic check
    expect(headers![0]).toBe(0x4f);
    expect(headers![page1.length]).toBe(0x4f);
  });

  it("returns null when fewer than 2 complete Ogg pages are present", () => {
    const page1 = makeOggPage(19, 0x02);
    // Incomplete stream with only 1 page
    const headers = extractOggOpusHeaders(page1);
    expect(headers).toBeNull();
  });
});
