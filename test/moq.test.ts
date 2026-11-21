// Canal MoQ (docs/ENGINE-MOQ.md). Ningún test arranca el motor ni toca `state`.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { X509Certificate, createHash, createHmac } from "crypto";
import { encodeVarint, decodeVarint, encodeLegacyFrame, buildCatalog, MOQ_EPOCH_UNIX_MS } from "../src/moq/hang";
import { generateCert, CertManager, MAX_VALIDITY_DAYS } from "../src/moq/cert";
import { generateJwk, parseJwk, signPublishToken, ensureJwk } from "../src/moq/jwt";
import { PcmFramer, OpusFrameEncoder, opusAvailable, FRAME_BYTES, frameSamplesFor } from "../src/moq/opus-ffi";
import { injectMarker, PROBE_MS } from "../src/moq/index";
import { opusPacketDurationUs, moqSupport } from "../client/moq-player";
import { config } from "../src/config";

const DAY = 86_400_000;

describe("hang: varint y contenedor legacy", () => {
  test("varint QUIC ida y vuelta en los límites de cada longitud", () => {
    for (const v of [0, 63, 64, 16383, 16384, 2 ** 30 - 1, 2 ** 30, 2 ** 40 + 12345, Number.MAX_SAFE_INTEGER]) {
      const e = encodeVarint(v);
      expect(e.length).toBe(v < 64 ? 1 : v < 16384 ? 2 : v < 2 ** 30 ? 4 : 8);
      const [d, rest] = decodeVarint(e);
      expect(d).toBe(v);
      expect(rest.length).toBe(0);
    }
    expect(() => encodeVarint(-1)).toThrow();
  });

  test("frame legacy = varint(pts µs) ‖ paquete", () => {
    const pkt = Uint8Array.of(0xfc, 1, 2, 3);
    const f = encodeLegacyFrame(1_234_567, pkt);
    const [ts, payload] = decodeVarint(f);
    expect(ts).toBe(1_234_567);
    expect([...payload]).toEqual([...pkt]);
  });

  test("catálogo con forma de AudioDecoderConfig y reloj en µs desde la época moq", () => {
    const wall = Date.UTC(2026, 10, 21, 12);
    const c = buildCatalog({ audioTrack: "audio", bitrateKbps: 128, jitterMs: 100, wallAtPts0Ms: wall, clockTrack: "clk" });
    const r = c.audio.renditions.audio;
    expect(r).toEqual({ codec: "opus", container: { kind: "legacy" }, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000, jitter: 100 });
    expect(c.clock.timescale).toBe(1_000_000);
    expect(c.clock.wall).toBe((wall - MOQ_EPOCH_UNIX_MS) * 1000);
    expect(Number.isSafeInteger(c.clock.wall)).toBe(true);
  });
});

describe("certificados para serverCertificateHashes", () => {
  test("X.509v3 ECDSA P-256, autofirmado, validez ≤ 14 días, hash = SHA-256 del DER", async () => {
    const c = await generateCert({ days: 10, names: ["localhost", "185.139.1.222"] });
    const x = new X509Certificate(c.certPem);
    expect(x.publicKey.asymmetricKeyType).toBe("ec");
    expect((x.publicKey.asymmetricKeyDetails as any).namedCurve).toBe("prime256v1");
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.subjectAltName).toContain("DNS:localhost");
    expect(x.subjectAltName).toContain("IP Address:185.139.1.222");
    const validity = new Date(x.validTo).getTime() - new Date(x.validFrom).getTime();
    expect(validity).toBeLessThanOrEqual(MAX_VALIDITY_DAYS * DAY);
    expect(validity).toBe(10 * DAY);
    expect(c.sha256).toBe(createHash("sha256").update(x.raw).digest("hex"));
    expect(c.keyPem).toContain("BEGIN PRIVATE KEY");
  });

  test("nunca más de 14 días aunque se pidan más", async () => {
    const c = await generateCert({ days: 30 });
    expect(c.notAfter.getTime() - c.notBefore.getTime()).toBe(MAX_VALIDITY_DAYS * DAY);
  });

  test("rotación con solape: el `next` ya anunciado pasa a activo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moqcert-"));
    try {
      const m = new CertManager({ dir, days: 10, rotateAfterDays: 5, overlapMs: 3_600_000, names: ["localhost"] });
      const t0 = new Date();
      expect(await m.ensure(t0)).toBe(true); // crea activo + next
      const [a0, n0] = m.hashes();
      expect(a0!.sha256).not.toBe(n0!.sha256);
      expect(statSync(join(dir, "key.pem")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "next.key")).mode & 0o777).toBe(0o600);
      // A mitad de vida no rota
      expect(await m.ensure(new Date(t0.getTime() + 2 * DAY))).toBe(false);
      expect(m.hashes()[0]!.sha256).toBe(a0!.sha256);
      // Pasada la edad de rotación: el next (anunciado hace > 1 h) pasa a activo y hay otro next
      expect(await m.ensure(new Date(t0.getTime() + 5 * DAY + 60_000))).toBe(true);
      const [a1, n1] = m.hashes();
      expect(a1!.sha256).toBe(n0!.sha256);
      expect(n1!.sha256).not.toBe(n0!.sha256);
      expect(m.rotations).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("JWT de publicación (formato de `moq auth`)", () => {
  test("HS256 con solo root/publish/iat/exp y firma verificable", () => {
    const jwk = generateJwk();
    const tok = signPublishToken(jwk, { root: "bloom", publish: ["radio.hang"], ttlSec: 60, now: 1_800_000_000_000 });
    const [h, p, s] = tok.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ typ: "JWT", alg: "HS256", kid: jwk.kid });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({ root: "bloom", publish: ["radio.hang"], iat: 1_800_000_000, exp: 1_800_000_060 });
    expect(s).toBe(createHmac("sha256", Buffer.from(jwk.k, "base64url")).update(`${h}.${p}`).digest("base64url"));
  });

  test("la clave se guarda como JWK en base64url con permisos 0600 y se relee igual", () => {
    const dir = mkdtempSync(join(tmpdir(), "moqjwk-"));
    try {
      const path = join(dir, "publish.jwk");
      const a = ensureJwk(path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8").startsWith("{")).toBe(false);
      expect(ensureJwk(path)).toEqual(a);
      expect(parseJwk(JSON.stringify(a))).toEqual(a);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PCM → tramas Opus", () => {
  test("PcmFramer da tramas exactas con cualquier troceado y sin perder muestras", () => {
    const total = FRAME_BYTES * 7 + 100;
    const src = new Uint8Array(total);
    for (let i = 0; i < total; i++) src[i] = i & 0xff;
    for (const piece of [1, 7, 4096, 5016, FRAME_BYTES, 19200]) {
      const f = new PcmFramer();
      const out: number[] = [];
      for (let off = 0; off < total; off += piece) {
        f.push(src.subarray(off, Math.min(total, off + piece)), (fr) => out.push(...new Uint8Array(fr.buffer)));
      }
      expect(out.length).toBe(FRAME_BYTES * 7);
      expect(f.pendingBytes).toBe(100);
      expect(out.slice(0, 64)).toEqual([...src.subarray(0, 64)]);
      expect(out[out.length - 1]).toBe(src[FRAME_BYTES * 7 - 1]);
    }
  });

  test("tamaños de trama admitidos: 20, 40 y 60 ms", () => {
    expect(frameSamplesFor(20)).toBe(960);
    expect(frameSamplesFor(60)).toBe(2880);
    expect(() => frameSamplesFor(25)).toThrow();
  });

  test("duración de paquete por TOC (RFC 6716 §3.1)", () => {
    expect(opusPacketDurationUs(Uint8Array.of(0xfc))).toBe(20_000);      // CELT FB 20 ms, 1 trama
    expect(opusPacketDurationUs(Uint8Array.of(0xff, 0x03))).toBe(60_000); // código 3, 3 tramas de 20 ms
    expect(opusPacketDurationUs(Uint8Array.of(0x78))).toBe(20_000);      // híbrido FB 20 ms
    expect(opusPacketDurationUs(Uint8Array.of(0x18))).toBe(60_000);      // SILK NB 60 ms, 1 trama
    expect(opusPacketDurationUs(Uint8Array.of(0xfd))).toBe(40_000);      // CELT 20 ms, código 1 → 2 tramas
  });

  test.skipIf(!opusAvailable())("libopus por FFI: 1 s → 50 paquetes CELT de 20 ms a ~128 kbps", () => {
    const e = new OpusFrameEncoder({ bitrateKbps: 128 });
    try {
      const f = new PcmFramer();
      const pcm = new Int16Array(48000 * 2);
      for (let i = 0; i < 48000; i++) { const v = Math.round(6000 * Math.sin((i * 2 * Math.PI * 440) / 48000) + 2000 * Math.sin(i * 0.37)); pcm[2 * i] = v; pcm[2 * i + 1] = -v; }
      const pkts: Uint8Array[] = [];
      f.push(new Uint8Array(pcm.buffer), (fr) => pkts.push(e.encode(fr)));
      expect(pkts.length).toBe(50);
      for (const p of pkts) { expect(p[0]! >> 3).toBeGreaterThanOrEqual(16); expect(opusPacketDurationUs(p)).toBe(20_000); }
      const kbps = (pkts.reduce((n, p) => n + p.length, 0) * 8) / 1000;
      expect(kbps).toBeGreaterThan(60);
      expect(kbps).toBeLessThan(260);
    } finally { e.close(); }
  });

  test.skipIf(!opusAvailable())("tramas de 60 ms: un paquete cada 60 ms", () => {
    const e = new OpusFrameEncoder({ bitrateKbps: 128, frameMs: 60 });
    try {
      const f = new PcmFramer(e.frameSamples);
      const pkts: Uint8Array[] = [];
      f.push(new Uint8Array(48000 * 4), (fr) => pkts.push(e.encode(fr)));
      expect(pkts.length).toBe(16);
      expect(opusPacketDurationUs(pkts[0]!)).toBe(60_000);
    } finally { e.close(); }
  });
});

describe("sonda de latencia y valores por defecto", () => {
  test("el marcador se escribe en una copia (el trozo del deck no se toca)", () => {
    const chunk = new Uint8Array(4800 * 4);
    const out = injectMarker(chunk);
    expect(chunk.every((b) => b === 0)).toBe(true);
    const s = new Int16Array(out.buffer);
    const frames = Math.round((PROBE_MS / 1000) * 48000);
    let peak = 0;
    for (let i = 0; i < frames * 2; i++) peak = Math.max(peak, Math.abs(s[i]!));
    expect(peak).toBeGreaterThan(15000);
    expect(s[frames * 2 + 10]).toBe(0);
  });

  test("todo el canal MoQ está apagado por defecto", () => {
    if (process.env.MOQ_ENABLED !== undefined) return; // el entorno lo fija a propósito
    expect(config.moqEnabled).toBe(false);
    expect(config.moqLatencyProbe).toBe(false);
    expect(config.moqOpusFec).toBe(false);
    expect(config.moqOpusBitrateKbps).toBe(128);
    expect(config.moqOpusFrameMs).toBe(20);
    expect(config.moqCertDays).toBeLessThanOrEqual(13);
  });

  test("política del cliente: sin WebTransport → HTTP", () => {
    expect(moqSupport().ok).toBe(false); // Bun no tiene WebTransport ni AudioDecoder
  });
});
