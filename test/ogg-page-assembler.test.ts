import { describe, expect, it } from "bun:test";
import { OggPageAssembler, OpusHeaderCollector } from "../src/ogg";
import { handleOpusOutput, opusHeaders } from "../src/audio-router";
import { preBufferOpus } from "../src/pre-buffer";

/** Página Ogg sintética (CRC no se valida en el servidor). */
function page(opts: { payload: Uint8Array | string; headerType?: number; granule?: bigint; serial?: number; seq?: number }): Uint8Array {
  const payload = typeof opts.payload === "string" ? new TextEncoder().encode(opts.payload) : opts.payload;
  const segs: number[] = [];
  let left = payload.length;
  while (left >= 255) { segs.push(255); left -= 255; }
  segs.push(left);
  const out = new Uint8Array(27 + segs.length + payload.length);
  out.set([0x4f, 0x67, 0x67, 0x53], 0);
  out[5] = opts.headerType ?? 0;
  const v = new DataView(out.buffer);
  v.setBigUint64(6, opts.granule ?? 0n, true);
  v.setUint32(14, opts.serial ?? 0x1234, true);
  v.setUint32(18, opts.seq ?? 0, true);
  out[26] = segs.length;
  out.set(segs, 27);
  out.set(payload, 27 + segs.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function audio(n: number, granule: bigint, serial = 0x1234): Uint8Array {
  const p = new Uint8Array(n);
  p.fill(0xfc);
  return page({ payload: p, granule, serial });
}

const head = (serial = 0x1234) => page({ payload: "OpusHead\x01\x02\x38\x01\x80\xbb\x00\x00\x00\x00\x00", headerType: 0x02, serial });
const tags = (serial = 0x1234) => page({ payload: "OpusTags\x08\x00\x00\x00Lavf60.1\x00\x00\x00\x00", serial, seq: 1 });

describe("OggPageAssembler", () => {
  it("reassembles pages split at arbitrary read boundaries (incl. inside the 27-byte header)", () => {
    const stream = concat(head(), tags(), audio(600, 960n), audio(17000, 1920n), audio(30, 2880n));
    for (const cut of [1, 5, 13, 26, 27, 28, 47, 48, 100, 4096]) {
      const asm = new OggPageAssembler();
      const pages = [];
      for (let o = 0; o < stream.length; o += cut) pages.push(...asm.feed(stream.subarray(o, o + cut)));
      expect(pages.length).toBe(5);
      expect(pages[0]!.bos).toBe(true);
      expect(pages[0]!.magic).toBe("OpusHead");
      expect(pages[1]!.magic).toBe("OpusTags");
      expect(pages[3]!.granule).toBe(1920n);
      expect(asm.pending).toBe(0);
      expect(asm.skippedBytes).toBe(0);
      expect(concat(...pages.map((p) => p.data))).toEqual(stream);
    }
  });

  it("resyncs on the next capture pattern after garbage", () => {
    const asm = new OggPageAssembler();
    const pages = asm.feed(concat(new Uint8Array([1, 2, 3, 0x4f, 0x67]), audio(10, 5n)));
    expect(pages.length).toBe(1);
    expect(asm.skippedBytes).toBe(5);
  });
});

describe("OpusHeaderCollector", () => {
  it("collects OpusHead + OpusTags (granule 0) and stops at the first audio page", () => {
    const c = new OpusHeaderCollector();
    const asm = new OggPageAssembler();
    const pages = asm.feed(concat(head(), tags(), audio(100, 960n)));
    expect(c.accept(pages[0]!)).toBe(true);
    expect(c.headers!.length).toBe(pages[0]!.data.length); // parcial: ya sirve a quien conecte ahora
    expect(c.accept(pages[1]!)).toBe(true);
    expect(c.isComplete).toBe(false);
    expect(c.accept(pages[2]!)).toBe(false);
    expect(c.isComplete).toBe(true);
    expect(c.headers!.length).toBe(pages[0]!.data.length + pages[1]!.data.length);
  });
});

describe("Opus tier: headers + page-aligned prebuffer (regresión del bug de OpusTags)", () => {
  it("captures both header pages even when ffmpeg's first pipe read only contains OpusHead", () => {
    preBufferOpus.reset();
    // Lectura 1: solo OpusHead (47 B) — caso observado en el contenedor de prueba
    handleOpusOutput(head());
    // Lectura 2: OpusTags + audio cortado a mitad de página
    const a1 = audio(1200, 960n);
    const a2 = audio(1500, 1920n);
    const rest = concat(tags(), a1, a2);
    handleOpusOutput(rest.subarray(0, tags().length + 700));
    handleOpusOutput(rest.subarray(tags().length + 700));

    expect(opusHeaders).not.toBeNull();
    expect(opusHeaders!.length).toBe(head().length + tags().length);
    const magicTags = new TextDecoder().decode(opusHeaders!.subarray(head().length + 28, head().length + 36));
    expect(magicTags).toBe("OpusTags");

    // El prebuffer contiene solo páginas de audio completas
    const snap = preBufferOpus.snapshot();
    expect(snap.length).toBe(2);
    for (const s of snap) expect(Array.from(s.subarray(0, 4))).toEqual([0x4f, 0x67, 0x67, 0x53]);
    expect(snap[0]).toEqual(a1);
  });

  it("a new BOS (encoder restart) invalidates the previous generation's headers and prebuffer", () => {
    handleOpusOutput(concat(head(0x9999), tags(0x9999)));
    expect(preBufferOpus.snapshot().length).toBe(0);
    const v = new DataView(opusHeaders!.buffer, opusHeaders!.byteOffset);
    expect(v.getUint32(14, true)).toBe(0x9999);
    handleOpusOutput(audio(100, 960n, 0x9999));
    expect(preBufferOpus.snapshot().length).toBe(1);
  });
});
