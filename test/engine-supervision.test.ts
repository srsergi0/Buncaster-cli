import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { state } from "../src/state";
import { config, prebufferBytesFor } from "../src/config";
import {
  accountAirTime,
  checkFallbackWatchdog,
  checkOpusStall,
  scheduleOpusRestart,
  stopOpusEncoder,
} from "../src/audio-router";
import { AudioRingBuffer } from "../src/ring-buffer";
import { PreBuffer } from "../src/pre-buffer";

// Inyección de fallos (SRE): se simulan deck colgado y encoder opus colgado/caído
// y se verifica que la supervisión actúa, sin depender de ffmpeg en el entorno de test.

// Estos tests mutan el singleton global `state`. Si un valor queda "viejo" (p. ej.
// lastPcmSampleTimeMs), el watchdog real (setInterval arrancado por otros archivos de
// test) cree que hay aire muerto y arranca un deck de verdad → contamina otros tests
// de forma dependiente del tiempo. Guardamos y restauramos todo lo que tocamos.
type Snapshot = Pick<
  typeof state,
  "lastPcmSampleTimeMs" | "isBroadcasting" | "fallbackPaused" | "shuttingDown" | "opusProcess"
> & { deckState: typeof state.deckState };
let snapshot: Snapshot;
beforeEach(() => {
  snapshot = {
    lastPcmSampleTimeMs: state.lastPcmSampleTimeMs,
    isBroadcasting: state.isBroadcasting,
    fallbackPaused: state.fallbackPaused,
    shuttingDown: state.shuttingDown,
    opusProcess: state.opusProcess,
    deckState: { ...state.deckState },
  };
});
afterEach(() => {
  state.lastPcmSampleTimeMs = snapshot.lastPcmSampleTimeMs;
  state.isBroadcasting = snapshot.isBroadcasting;
  state.fallbackPaused = snapshot.fallbackPaused;
  state.shuttingDown = snapshot.shuttingDown;
  state.opusProcess = snapshot.opusProcess;
  state.deckState.A = snapshot.deckState.A;
  state.deckState.B = snapshot.deckState.B;
});

describe("Fallback stall watchdog (FALLBACK_STALL_SECONDS)", () => {
  it("restarts the fallback when no PCM reached the encoder for N seconds", () => {
    const now = 1_000_000_000;
    state.isBroadcasting = false;
    state.fallbackPaused = false;
    state.shuttingDown = false;
    state.lastPcmSampleTimeMs = now - (config.fallbackStallSeconds * 1000 + 100);
    const before = state.fallbackStallRestarts;
    let restarts = 0;
    expect(checkFallbackWatchdog(now, () => restarts++)).toBe(true);
    expect(restarts).toBe(1);
    expect(state.fallbackStallRestarts).toBe(before + 1);
    // Rate-limit: no reintenta en la misma ventana
    expect(checkFallbackWatchdog(now + 1000, () => restarts++)).toBe(false);
    // Pero sí en la siguiente si sigue mudo
    expect(checkFallbackWatchdog(now + config.fallbackStallSeconds * 1000 + 1, () => restarts++)).toBe(true);
    expect(restarts).toBe(2);
  });

  it("does nothing while audio flows, while live, while paused, or before first audio", () => {
    const now = 2_000_000_000;
    const never = () => { throw new Error("should not restart"); };
    state.lastPcmSampleTimeMs = now - 200;
    expect(checkFallbackWatchdog(now, never)).toBe(false);

    state.lastPcmSampleTimeMs = now - 60_000;
    state.isBroadcasting = true;
    expect(checkFallbackWatchdog(now, never)).toBe(false);
    state.isBroadcasting = false;

    state.fallbackPaused = true;
    expect(checkFallbackWatchdog(now, never)).toBe(false);
    state.fallbackPaused = false;

    state.lastPcmSampleTimeMs = 0;
    expect(checkFallbackWatchdog(now, never)).toBe(false);
  });
});

describe("Opus encoder supervision (ENCODER_SUPERVISION)", () => {
  it("kills an opus encoder that stopped emitting pages while PCM keeps flowing", () => {
    const now = Date.now() + 60_000;
    let signal: number | undefined;
    state.opusProcess = { kill: (s?: number) => { signal = s; } };
    state.lastPcmSampleTimeMs = now - 100;
    expect(checkOpusStall(now)).toBe(true);
    expect(signal).toBe(9);
    state.opusProcess = null;
  });

  it("does not flag a stall when no PCM is being written (nothing to encode)", () => {
    const now = Date.now() + 60_000;
    state.opusProcess = { kill: () => { throw new Error("should not kill"); } };
    state.lastPcmSampleTimeMs = now - 10_000;
    expect(checkOpusStall(now)).toBe(false);
    state.opusProcess = null;
  });

  it("schedules restarts with exponential backoff and stopOpusEncoder cancels them", () => {
    state.shuttingDown = false;
    const d1 = scheduleOpusRestart("test crash 1");
    stopOpusEncoder();
    const d2 = scheduleOpusRestart("test crash 2");
    stopOpusEncoder();
    expect(d1).not.toBeNull();
    expect(d2).toBe(d1! * 2);
  });
});

describe("Dead-air & digital-silence accounting", () => {
  it("counts PCM gaps > 500 ms as dead air and near-zero chunks as digital silence", () => {
    const deadBefore = state.deadAirSeconds;
    const silBefore = state.digitalSilenceSeconds;
    const silent = new Uint8Array(4800 * 4); // 100 ms de ceros
    state.lastPcmSampleTimeMs = 5_000;
    accountAirTime(silent, 5_100); // hueco normal
    expect(state.deadAirSeconds).toBe(deadBefore);
    expect(state.digitalSilenceSeconds - silBefore).toBeCloseTo(0.1, 5);

    const loud = new Int16Array(4800 * 2).fill(8000);
    state.lastPcmSampleTimeMs = 5_100;
    accountAirTime(new Uint8Array(loud.buffer), 7_600); // 2.5 s sin PCM
    expect(state.deadAirSeconds - deadBefore).toBeCloseTo(2.5, 5);
    expect(state.digitalSilenceSeconds - silBefore).toBeCloseTo(0.1, 5);
  });
});

describe("Prebuffer measured in seconds (PREBUFFER_SECONDS)", () => {
  it("translates seconds to bytes per tier bitrate, falling back to PREBUFFER_BYTES", () => {
    const base = { preBufferBytes: 1572864, fallbackBitrateKbps: 320, opusTierBitrateKbps: 192 };
    expect(prebufferBytesFor("opus", { ...base, preBufferSeconds: 0 })).toBe(1572864);
    expect(prebufferBytesFor("mp3", { ...base, preBufferSeconds: 0 })).toBe(1572864);
    expect(prebufferBytesFor("opus", { ...base, preBufferSeconds: 10 })).toBe(240_000);
    expect(prebufferBytesFor("mp3", { ...base, preBufferSeconds: 10 })).toBe(400_000);
    // El valor histórico de producción equivale a ~65 s en opus 192k y ~39 s en mp3 320k
    expect(new PreBuffer(1572864, 192).secondsFor(1572864)).toBeCloseTo(65.5, 1);
    expect(new PreBuffer(1572864, 320).secondsFor(1572864)).toBeCloseTo(39.3, 1);
  });

  it("ring snapshot stays ordered and bounded after many evictions (head-index ring)", () => {
    const ring = new AudioRingBuffer(10_000);
    for (let i = 1; i <= 5000; i++) ring.push(new Uint8Array(100).fill(i & 0xff));
    expect(ring.bytes).toBe(10_000);
    expect(ring.length).toBe(100);
    expect(ring.oldestSeq).toBe(4901);
    const snap = ring.getSnapshot(2_500);
    expect(snap.length).toBe(25);
    expect(snap[0]![0]).toBe(4976 & 0xff);
    expect(snap[24]![0]).toBe(5000 & 0xff);
    const since = ring.readSince(4990)!;
    expect(since.slots.map((s) => s.seqId)).toEqual([4991, 4992, 4993, 4994, 4995, 4996, 4997, 4998, 4999, 5000]);
    expect(ring.readSince(10)).toBeNull();
  });
});
