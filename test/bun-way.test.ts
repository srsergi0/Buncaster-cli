import { describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { config } from "../src/config";
import { state } from "../src/state";
import { PcmHistory, waitForSrtKnock } from "../src/audio-router";
import { LameEncoder, isNativeLameAvailable } from "../src/lame-ffi";
import { NativeDecoder, decodeFileToPcm, isNativeDecodeAvailable } from "../src/decode-ffi";

// docs/ENGINE-BUN-WAY.md — pruebas de las garantías en las que se apoyan las
// optimizaciones. Las que necesitan libmp3lame / libavformat 60 / ffmpeg se
// saltan si el entorno no las tiene (imágenes oven/bun); en el runner de CI
// (Ubuntu con ffmpeg 6.1) sí corren. Ninguna arranca el motor ni toca `state`
// salvo para leer contadores.

/** PCM estéreo s16le determinista (tono + ruido pseudoaleatorio), `frames` frames. */
function syntheticPcm(frames: number, seed = 1): Uint8Array {
  const out = new Int16Array(frames * 2);
  let x = seed;
  for (let i = 0; i < frames; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    const noise = ((x >>> 16) & 0x7fff) - 16384;
    const tone = Math.sin((2 * Math.PI * 440 * i) / 48000) * 12000;
    out[2 * i] = Math.max(-32768, Math.min(32767, Math.round(tone + noise * 0.2)));
    out[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(tone * 0.7 - noise * 0.2)));
  }
  return new Uint8Array(out.buffer);
}

function sha(parts: Uint8Array[]): string {
  const h = new Bun.CryptoHasher("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
}

describe("PcmHistory (historial PCM de MP3_ON_DEMAND)", () => {
  it("guarda los últimos N bytes y los lee contiguos a través del borde del anillo", () => {
    const h = new PcmHistory(16);
    const all: number[] = [];
    for (let i = 0; i < 7; i++) {
      const chunk = new Uint8Array([4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 3]);
      h.write(chunk);
      all.push(...chunk);
    }
    expect(h.total).toBe(28);
    expect(h.oldest).toBe(12);
    expect([...h.read(h.oldest, 16)]).toEqual(all.slice(12, 28));
    expect([...h.read(20, 8)]).toEqual(all.slice(20, 28));
  });

  it("una escritura mayor que la capacidad conserva solo la cola", () => {
    const h = new PcmHistory(8);
    const big = new Uint8Array(20).map((_, i) => i);
    h.write(big);
    expect(h.total).toBe(20);
    expect([...h.read(h.oldest, 8)]).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
  });
});

describe("ENCODER_BATCH_MS: LAME produce los mismos bytes con cualquier troceado", () => {
  const lame = isNativeLameAvailable();
  it.skipIf(!lame)("26 ms (frame MP3 de un deck) vs 100 ms (lote) → MP3 idéntico", () => {
    const pcm = syntheticPcm(48000 * 3);
    const encodeIn = (chunkBytes: number) => {
      const enc = new LameEncoder(48000, 2, 320, 2);
      const out: Uint8Array[] = [];
      for (let off = 0; off < pcm.length; off += chunkBytes) {
        const end = Math.min(pcm.length, off + chunkBytes);
        const r = enc.encode(new Int16Array(pcm.buffer, off, (end - off) >> 1));
        if (r.length) out.push(r.slice());
      }
      const f = enc.flush();
      if (f.length) out.push(f.slice());
      enc.close();
      return out;
    };
    const perFrame = encodeIn(5016);
    const batched = encodeIn(19200);
    expect(batched.length).toBeLessThan(perFrame.length); // menos broadcasts
    expect(sha(batched)).toBe(sha(perFrame));
  });
});

/** WAV PCM 44,1 kHz estéreo (fuerza remuestreo a 48 kHz en el decoder). */
function writeWav(file: string, frames: number): void {
  const data = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 997 * i) / 44100) * 10000);
    data[2 * i] = v;
    data[2 * i + 1] = -v;
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(44100, 24);
  header.writeUInt32LE(44100 * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.byteLength, 40);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from(data.buffer)]));
}

describe("USE_NATIVE_DECODE: decode en proceso (libavcodec FFI)", () => {
  const native = isNativeDecodeAvailable();
  const ffmpeg = Bun.which("ffmpeg");
  const tmp = path.join(os.tmpdir(), `bunway-${process.pid}.wav`);

  it.skipIf(!native || !ffmpeg)("PCM byte a byte igual que `ffmpeg -f s16le -ar 48000 -ac 2` (incluida la cola de swresample)", () => {
    writeWav(tmp, 44100 * 2 + 123);
    try {
      const nat = decodeFileToPcm(tmp);
      const cli = Bun.spawnSync([ffmpeg!, "-loglevel", "error", "-i", tmp, "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "-"], { maxBuffer: 1 << 26 });
      const ref = new Uint8Array(cli.stdout as unknown as ArrayBuffer);
      expect(nat.length).toBe(ref.length);
      expect(sha([nat])).toBe(sha([ref]));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it.skipIf(!native)("ritmo de `-re`: ráfaga inicial de 0,5 s y luego tiempo real, en chunks de ≤4 KiB", async () => {
    writeWav(tmp, 44100 * 5);
    try {
      const dec = new NativeDecoder(tmp);
      const reader = dec.stdout.getReader();
      let bytes = 0;
      let maxChunk = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 400) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        maxChunk = Math.max(maxChunk, value.byteLength);
      }
      const elapsed = performance.now() - t0;
      dec.kill();
      await reader.cancel();
      expect(await dec.exited).toBe(143);
      expect(maxChunk).toBeLessThanOrEqual(4096);
      // 0,5 s de ráfaga + 1× durante lo transcurrido (margen de un chunk + tick)
      expect(bytes).toBeGreaterThanOrEqual(96_000);
      expect(bytes).toBeLessThanOrEqual(96_000 + Math.ceil(elapsed * 192) + 4096 * 2);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("archivo inexistente → lanza (startFallback cae a ffmpeg CLI)", () => {
    if (!native) return;
    expect(() => new NativeDecoder("/no/existe.mp3")).toThrow();
  });
});

describe("SRT_ON_DEMAND: el socket UDP de Bun despierta con el primer paquete", () => {
  it("resuelve true al llegar un datagrama y libera el puerto", async () => {
    const prevPort = config.srtPort;
    const prevHost = config.host;
    const port = 40000 + Math.floor(Math.random() * 20000);
    (config as { srtPort: number }).srtPort = port;
    (config as { host: string }).host = "127.0.0.1";
    const wakeupsBefore = state.srtWakeups;
    try {
      const woke = waitForSrtKnock();
      // dar tiempo a que el socket quede armado
      for (let i = 0; i < 50 && !state.srtArmed; i++) await Bun.sleep(10);
      expect(state.srtArmed).toBe(true);
      const sender = await Bun.udpSocket({});
      sender.send(new Uint8Array([0x80, 0, 0, 0]), port, "127.0.0.1");
      expect(await woke).toBe(true);
      sender.close();
      expect(state.srtArmed).toBe(false);
      expect(state.srtWakeups).toBe(wakeupsBefore + 1);
      // El puerto queda libre para el listener ffmpeg
      const again = await Bun.udpSocket({ port, hostname: "127.0.0.1" });
      again.close();
    } finally {
      (config as { srtPort: number }).srtPort = prevPort;
      (config as { host: string }).host = prevHost;
      state.srtWakeups = wakeupsBefore;
    }
  });
});
