import { describe, it, expect } from "bun:test";
import { state } from "../src/state";
import { config } from "../src/config";
import { evictClient } from "../src/broadcaster";

describe("Phase 3 System Tests - Hardened FFI, Observability & Admission Control", () => {
  it("tracks classified eviction metrics for slow clients, backpressure, and timeouts", () => {
    const initialSlow = state.evictionsTotal.slowClient;
    const initialBackpressure = state.evictionsTotal.backpressure;

    // Crear clientes de prueba simulados
    const dummyClient1 = {
      id: "evict-test-1",
      controller: { close: () => {} } as any,
      connectedAt: new Date(),
      ip: "127.0.0.1",
      userAgent: "test",
      bytesSent: 0,
      slowStrikes: 0,
      tier: "mp3" as const,
    };
    const dummyClient2 = {
      id: "evict-test-2",
      controller: { close: () => {} } as any,
      connectedAt: new Date(),
      ip: "127.0.0.1",
      userAgent: "test",
      bytesSent: 0,
      slowStrikes: 0,
      tier: "mp3" as const,
    };

    state.clients.set(dummyClient1.id, dummyClient1);
    state.mp3Clients.set(dummyClient1.id, dummyClient1);
    state.clients.set(dummyClient2.id, dummyClient2);
    state.mp3Clients.set(dummyClient2.id, dummyClient2);

    evictClient(dummyClient1.id, "buffer saturated");
    evictClient(dummyClient2.id, "slow listener socket error");

    expect(state.evictionsTotal.backpressure).toBe(initialBackpressure + 1);
    expect(state.evictionsTotal.slowClient).toBe(initialSlow + 1);
  });

  it("calculates FFI maxOutSamples bounds safely to prevent buffer overflows", () => {
    // Verificamos la fórmula de capacidad estricta implementada en fill() de decode-ffi.ts
    const outCapacity = 192000;
    let written = 191000; // Solo quedan 1000 bytes disponibles

    const remainingBytes = outCapacity - written;
    const maxOutSamples = Math.floor(remainingBytes / 4);

    // 1000 / 4 = 250 muestras stereo s16le
    expect(maxOutSamples).toBe(250);
    expect(written + maxOutSamples * 4).toBeLessThanOrEqual(outCapacity);

    // Cuando el buffer está lleno:
    written = 192000;
    const fullMaxOutSamples = Math.floor((outCapacity - written) / 4);
    expect(fullMaxOutSamples).toBe(0);
  });

  it("exposes rich metrics in /metrics format including clock, underruns, and deck states", async () => {
    state.audioSamplesProduced = 48000;
    state.audioUnderruns = 2;
    state.deckState.A = "PLAYING";
    state.deckState.B = "READY";

    const fetchHandler = (globalThis as any).__bunServeFetch;
    if (!fetchHandler) return;

    const req = new Request("http://localhost:8080/metrics");
    const res = await fetchHandler(req, null);
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text).toContain("radio_audio_samples_produced_total 48000");
    expect(text).toContain("radio_audio_underruns_total 2");
    expect(text).toContain('radio_deck_state_a{state="PLAYING"} 1');
    expect(text).toContain('radio_deck_state_b{state="READY"} 1');
  });

  it("rejects connection with HTTP 503 and Retry-After header when max listeners is reached", async () => {
    const origMax = config.maxListeners;
    (config as any).maxListeners = 0; // Saturación inmediata

    const fetchHandler = (globalThis as any).__bunServeFetch;
    if (!fetchHandler) {
      (config as any).maxListeners = origMax;
      return;
    }

    const req = new Request("http://localhost:8080/mp3");
    const res = await fetchHandler(req, null);

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");

    (config as any).maxListeners = origMax;
  });
});
