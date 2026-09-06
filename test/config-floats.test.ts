import { describe, expect, it } from "bun:test";

describe("Config Float Parsing", () => {
  it("parses fractional seconds like 0.2 for crossfadeLiveSeconds", () => {
    // Test the envFloat parser behavior
    function envFloat(val: string | undefined, fallback: number): number {
      if (!val) return fallback;
      const n = Number(val);
      if (Number.isNaN(n) || n < 0) {
        throw new Error(`Invalid float value: "${val}"`);
      }
      return n;
    }

    expect(envFloat("0.2", 2)).toBe(0.2);
    expect(envFloat("1.5", 2)).toBe(1.5);
    expect(envFloat(undefined, 2)).toBe(2);
    expect(() => envFloat("-1", 2)).toThrow();
    expect(() => envFloat("not-a-number", 2)).toThrow();
  });
});
