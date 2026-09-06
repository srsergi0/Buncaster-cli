import { describe, expect, it } from "bun:test";
import { deckA, deckB, PcmResidueAccumulator } from "../src/audio-router";
import { state } from "../src/state";
import { envFloat } from "../src/config";
import { flushLogsSync } from "../src/logger";

describe("Phase 1 System Tests - End-to-End Verification", () => {
  it("verifies deck state machine and session initialization on decks", () => {
    expect(deckA.id).toBe("A");
    expect(deckB.id).toBe("B");
    expect(deckA.state).toBe("IDLE");
    expect(deckB.state).toBe("IDLE");
    expect(deckA.historyBuffer).toBeDefined();
    expect(deckB.historyBuffer).toBeDefined();
    expect(deckA.residueAcc).toBeInstanceOf(PcmResidueAccumulator);
    expect(deckB.residueAcc).toBeInstanceOf(PcmResidueAccumulator);
  });

  it("verifies state metrics for audio clock and deck generations", () => {
    expect(state.deckState.A).toBe("IDLE");
    expect(state.deckState.B).toBe("IDLE");
    expect(typeof state.deckGenerations.A).toBe("number");
    expect(typeof state.deckGenerations.B).toBe("number");
    expect(typeof state.audioClockSamples).toBe("number");
    expect(typeof state.audioSamplesProduced).toBe("number");
  });

  it("verifies PcmResidueAccumulator preserves remainder across partial reads", () => {
    const acc = new PcmResidueAccumulator();
    // 6 bytes input: 4 bytes output + 2 bytes remainder
    const out1 = acc.feed(new Uint8Array([10, 20, 30, 40, 50, 60]));
    expect(out1.length).toBe(4);
    expect(Array.from(out1)).toEqual([10, 20, 30, 40]);

    // 2 bytes input: combined with 2 remainder -> 4 bytes output
    const out2 = acc.feed(new Uint8Array([70, 80]));
    expect(out2.length).toBe(4);
    expect(Array.from(out2)).toEqual([50, 60, 70, 80]);

    // Reset clears remainder
    acc.feed(new Uint8Array([1, 2, 3]));
    acc.reset();
    const out3 = acc.feed(new Uint8Array([4, 5, 6, 7]));
    expect(out3.length).toBe(4);
    expect(Array.from(out3)).toEqual([4, 5, 6, 7]);
  });

  it("verifies envFloat accepts valid decimal strings", () => {
    process.env.TEST_FLOAT_VAR = "0.2";
    expect(envFloat("TEST_FLOAT_VAR", 1.0)).toBe(0.2);
    delete process.env.TEST_FLOAT_VAR;
    expect(envFloat("NON_EXISTENT_VAR", 1.5)).toBe(1.5);
  });

  it("verifies flushLogsSync completes without throwing", () => {
    expect(() => flushLogsSync()).not.toThrow();
  });
});
