import { describe, expect, it } from "bun:test";
import { config } from "../src/config";
import { state } from "../src/state";

describe("Live System Integration - Baseline", () => {
  it("loads config with crossfade values", () => {
    expect(config.crossfadeSeconds).toBeGreaterThan(0);
    expect(config.crossfadeLiveSeconds).toBeGreaterThanOrEqual(0);
  });

  it("initializes state correctly", () => {
    expect(state.clients).toBeDefined();
    expect(state.isBroadcasting).toBe(false);
  });
});
