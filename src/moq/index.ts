// =============================================================
// Canal MoQ de Buncaster (MOQ_ENABLED, desactivado por defecto)
// -------------------------------------------------------------
//   PCM del motor ──tap──▶ PcmFramer (20 ms) ──▶ libopus FFI ──▶ hang/legacy
//        │                                                        │
//        └─ HTTP /opus y /mp3 siguen igual                        ▼
//                                     MoqPublisher (@moq/net, WebSocket interno)
//                                                                 │
//                                     moq-relay (sidecar Rust) ◀──┘ QUIC/WebTransport UDP
//
// Además: certificados efímeros con rotación para `serverCertificateHashes`,
// la clave JWT de publicación, `GET /moq/session` para el cliente y una sonda
// de latencia opcional (MOQ_LATENCY_PROBE) para medir glass-to-glass.
// =============================================================
import { join } from "path";
import { config } from "../config";
import { rtmpLog } from "../logger";
import { Event } from "../events";
import { setPcmHooks } from "../audio-router";
import { CertManager } from "./cert";
import { ensureJwk, signPublishToken } from "./jwt";
import { buildCatalog } from "./hang";
import { MoqPublisher } from "./publisher";
import { OpusFrameEncoder, PcmFramer, opusAvailable, opusLoadError, opusVersion, frameSamplesFor, SAMPLE_RATE } from "./opus-ffi";

const AUDIO_TRACK = "audio";
const CLOCK_TRACK = "bloom.clock.json";
let FRAME_US = 20_000;
let CLOCK_EVERY_FRAMES = 25; // un par PTS→pared cada 0,5 s

export const moqState = {
  enabled: false,
  error: "" as string,
  opusVersion: "",
  framesEncoded: 0,
  encodeErrors: 0,
  encodeMicrosTotal: 0,
  certRotations: 0,
  probesInjected: 0,
  demandWakeups: 0,
  idleSince: 0,
};

let publisher: MoqPublisher | null = null;
let certs: CertManager | null = null;
let encoder: OpusFrameEncoder | null = null;
let certTimer: ReturnType<typeof setInterval> | null = null;
let framer = new PcmFramer();
let ptsUs = 0;
let framesSinceClock = CLOCK_EVERY_FRAMES;

// ---------- Sonda de latencia (solo pruebas) ----------
/** Tono marcador: 40 ms a 2 kHz y −6 dBFS, con rampas de 2 ms. */
export const PROBE_MS = 40;
export const PROBE_HZ = 2000;
const probeWaiters: ((t: { injectedAtMs: number; ptsUs: number | null }) => void)[] = [];

/** Escribe el marcador al principio de una copia del trozo (o del trozo entero si es más corto). */
export function injectMarker(chunk: Uint8Array): Uint8Array {
  const out = new Uint8Array(chunk.byteLength);
  out.set(chunk);
  const s = new Int16Array(out.buffer, 0, out.byteLength >> 1);
  const frames = Math.min(s.length >> 1, Math.round((PROBE_MS / 1000) * SAMPLE_RATE));
  const ramp = Math.round(0.002 * SAMPLE_RATE);
  for (let i = 0; i < frames; i++) {
    const env = Math.min(1, i / ramp, (frames - 1 - i) / ramp);
    const v = Math.round(16384 * env * Math.sin((2 * Math.PI * PROBE_HZ * i) / SAMPLE_RATE));
    s[2 * i] = v;
    s[2 * i + 1] = v;
  }
  return out;
}

export function requestProbe(timeoutMs = 5000): Promise<{ injectedAtMs: number; ptsUs: number | null }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const i = probeWaiters.indexOf(done);
      if (i >= 0) probeWaiters.splice(i, 1);
      reject(new Error("sin PCM entrando al motor"));
    }, timeoutMs);
    const done = (r: { injectedAtMs: number; ptsUs: number | null }) => { clearTimeout(t); resolve(r); };
    probeWaiters.push(done);
  });
}

function pcmTransform(chunk: Uint8Array, nowMs: number): Uint8Array {
  if (probeWaiters.length === 0) return chunk;
  const out = injectMarker(chunk);
  moqState.probesInjected++;
  // PTS de MoQ en que empieza el marcador (para verificar en el cliente)
  const pts = encoder ? ptsUs + (framer.pendingBytes / 4 / SAMPLE_RATE) * 1e6 : null;
  for (const w of probeWaiters.splice(0)) w({ injectedAtMs: nowMs, ptsUs: pts });
  return out;
}

// ---------- PCM → Opus → MoQ ----------
// Sin oyentes MoQ el relay no está suscrito: no se codifica (libopus 128k a complejidad 10
// cuesta ~1,4 % de un núcleo). El PTS sigue avanzando con el PCM para que la línea de
// tiempo sea continua; al volver la demanda se resetea el encoder y se publica el reloj.
let idle = false;
function pcmTap(chunk: Uint8Array, nowMs: number): void {
  if (!encoder || !publisher) return;
  if (!publisher.hasDemand()) {
    if (!idle) { idle = true; moqState.idleSince = nowMs; }
    ptsUs += ((chunk.byteLength >> 2) / SAMPLE_RATE) * 1e6;
    framer.reset();
    return;
  }
  if (idle) {
    idle = false;
    encoder.reset();
    framesSinceClock = CLOCK_EVERY_FRAMES;
    moqState.demandWakeups++;
  }
  framer.push(chunk, (frame) => {
    const t0 = performance.now();
    let packet: Uint8Array;
    try {
      packet = encoder!.encode(frame);
    } catch (e) {
      moqState.encodeErrors++;
      if (moqState.encodeErrors <= 3) rtmpLog.event("warn", Event.moqEncode, `MoQ: fallo de opus_encode (${(e as Error).message})`);
      return;
    }
    moqState.encodeMicrosTotal += (performance.now() - t0) * 1000;
    moqState.framesEncoded++;
    publisher!.writeAudio(Math.round(ptsUs), packet);
    if (++framesSinceClock >= CLOCK_EVERY_FRAMES) {
      framesSinceClock = 0;
      publisher!.writeClock(Math.round(ptsUs), nowMs);
    }
    ptsUs += FRAME_US;
  });
}

export async function startMoq(): Promise<boolean> {
  if (!config.moqEnabled || moqState.enabled) return moqState.enabled;
  try {
    if (!opusAvailable()) throw new Error(opusLoadError() ?? "libopus no disponible");
    moqState.opusVersion = opusVersion();
    certs = new CertManager({
      dir: config.moqCertDir,
      days: config.moqCertDays,
      rotateAfterDays: Math.min(config.moqCertRotateDays, config.moqCertDays - 1),
      overlapMs: 3_600_000,
      names: config.moqCertNames,
      ownerUid: config.moqSecretsUid,
    });
    await certs.ensure();
    const jwk = ensureJwk(join(config.moqCertDir, "publish.jwk"), config.moqSecretsUid);
    certTimer = setInterval(() => {
      certs!.ensure().then((changed) => {
        if (changed) {
          moqState.certRotations++;
          rtmpLog.event("info", Event.moqCertRotated, "MoQ: certificado WebTransport rotado", { hashes: certs!.hashes().map((h) => h.sha256.slice(0, 16)) });
        }
      }).catch((e) => rtmpLog.event("warn", Event.moqCertError, `MoQ: no se pudo rotar el certificado (${(e as Error).message})`));
    }, 10 * 60_000);
    (certTimer as any).unref?.();

    const frameSamples = frameSamplesFor(config.moqOpusFrameMs);
    framer = new PcmFramer(frameSamples);
    FRAME_US = (frameSamples / SAMPLE_RATE) * 1_000_000;
    CLOCK_EVERY_FRAMES = Math.max(1, Math.round(500 / config.moqOpusFrameMs));
    encoder = new OpusFrameEncoder({
      frameMs: config.moqOpusFrameMs,
      bitrateKbps: config.moqOpusBitrateKbps,
      inbandFec: config.moqOpusFec,
      packetLossPerc: config.moqOpusPacketLossPerc,
    });
    const catalog = buildCatalog({
      audioTrack: AUDIO_TRACK,
      bitrateKbps: config.moqOpusBitrateKbps,
      // El PCM llega en trozos de 21-100 ms: el publicador puede retener hasta un trozo
      jitterMs: 100,
      wallAtPts0Ms: Date.now(),
      clockTrack: CLOCK_TRACK,
    });
    publisher = new MoqPublisher({
      relayUrl: config.moqRelayUrl,
      path: config.moqPath,
      broadcast: config.moqBroadcast,
      audioTrack: AUDIO_TRACK,
      clockTrack: CLOCK_TRACK,
      catalog,
      groupMs: config.moqGroupMs,
      maxAgeMs: config.moqMaxAgeMs,
      token: () => signPublishToken(jwk, { root: config.moqPath, publish: [config.moqBroadcast], ttlSec: 24 * 3600 }),
      log: (level, msg, data) => rtmpLog.event(level, Event.moqPublisher, msg, data),
    });
    await publisher.start();
    setPcmHooks({ tap: pcmTap, transform: config.moqLatencyProbe ? pcmTransform : null });
    moqState.enabled = true;
    rtmpLog.ok(Event.moqStarted, `MoQ activo: Opus ${config.moqOpusBitrateKbps} kbps (${moqState.opusVersion}) → ${config.moqRelayUrl}/${config.moqPath}/${config.moqBroadcast}`, {
      lookahead: encoder.lookahead, frameMs: config.moqOpusFrameMs, groupMs: config.moqGroupMs, fec: config.moqOpusFec, probe: config.moqLatencyProbe,
    });
    return true;
  } catch (e) {
    moqState.error = String((e as Error).message ?? e);
    rtmpLog.event("warn", Event.moqDisabled, `MoQ desactivado: ${moqState.error}. El stream HTTP no cambia.`);
    stopMoq();
    return false;
  }
}

export function stopMoq(): void {
  setPcmHooks({ tap: null, transform: null });
  if (certTimer) { clearInterval(certTimer); certTimer = null; }
  publisher?.stop();
  publisher = null;
  encoder?.close();
  encoder = null;
  framer.reset();
  moqState.enabled = false;
}

/** Lo que necesita el cliente web para conectar (sin secretos: solo hashes públicos). */
export function moqSessionInfo(req: Request) {
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost").replace(/:\d+$/, "");
  const base = (config.moqPublicUrl || `https://${host}:4433`).replace(/\/+$/, "");
  return {
    enabled: moqState.enabled,
    url: `${base}/${config.moqPath}`,
    broadcast: config.moqBroadcast,
    catalogTrack: "catalog.json",
    audioTrack: AUDIO_TRACK,
    clockTrack: CLOCK_TRACK,
    serverCertificateHashes: (certs?.hashes() ?? []).map((h) => ({ algorithm: "sha-256", value: h.sha256, notAfter: h.notAfter })),
    fallbackUrl: config.moqFallbackUrl,
    targetLatencyMs: config.moqClientTargetMs,
    bitrateKbps: config.moqOpusBitrateKbps,
    serverTimeMs: Date.now(),
  };
}

export function moqStatus() {
  const p = publisher?.status;
  return {
    enabled: moqState.enabled,
    error: moqState.error || null,
    opus: { version: moqState.opusVersion, bitrateKbps: config.moqOpusBitrateKbps, frameMs: config.moqOpusFrameMs, fec: config.moqOpusFec, framesEncoded: moqState.framesEncoded, encodeErrors: moqState.encodeErrors, encodeMsPerSecond: moqState.framesEncoded ? Math.round((moqState.encodeMicrosTotal / moqState.framesEncoded) * 50) / 1000 : 0 },
    publisher: p ?? null,
    encoding: !idle,
    demandWakeups: moqState.demandWakeups,
    certs: { hashes: certs?.hashes() ?? [], rotations: moqState.certRotations },
    probe: { enabled: config.moqLatencyProbe, injected: moqState.probesInjected },
  };
}
