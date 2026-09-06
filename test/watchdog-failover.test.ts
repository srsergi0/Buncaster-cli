import { describe, it, expect } from "bun:test";
import { state } from "../src/state";
import { checkAudioWatchdog } from "../src/audio-router";

describe("Audio Watchdog & Live Failover", () => {
  it("does not trigger failover when not broadcasting", () => {
    state.isBroadcasting = false;
    state.sourceConnected = false;
    state.lastSourceAudioTimeMs = Date.now() - 5000;

    const triggered = checkAudioWatchdog();
    expect(triggered).toBe(false);
  });

  it("does not trigger failover when audio frames are arriving on time", () => {
    state.isBroadcasting = true;
    state.sourceConnected = true;
    state.lastSourceAudioTimeMs = Date.now() - 500; // Recibido hace 500ms

    const triggered = checkAudioWatchdog();
    expect(triggered).toBe(false);
  });

  it("triggers failover and resets source when live input is frozen for >2500ms", () => {
    const initialUnderruns = state.audioUnderruns;
    let mockProcessKilled = false;

    state.isBroadcasting = true;
    state.sourceConnected = true;
    state.lastSourceAudioTimeMs = Date.now() - 3000; // Colgado hace 3 segundos
    state.sourceProcess = {
      kill: () => {
        mockProcessKilled = true;
      },
    };

    const triggered = checkAudioWatchdog();
    expect(triggered).toBe(true);
    expect(state.isBroadcasting).toBe(false);
    expect(state.sourceConnected).toBe(false);
    expect(mockProcessKilled).toBe(true);
    expect(state.audioUnderruns).toBe(initialUnderruns + 1);
  });
});
