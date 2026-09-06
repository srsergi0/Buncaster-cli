import { describe, expect, it } from "bun:test";
import { state } from "../src/state";

describe("Queue Management API & State", () => {
  it("manages playback priority queue correctly", () => {
    state.fallbackQueue = [];

    // Add items
    state.fallbackQueue.push("song1.mp3");
    state.fallbackQueue.push("song2.mp3");
    state.fallbackQueue.push("song3.mp3");
    expect(state.fallbackQueue.length).toBe(3);

    // Move item (from 2 to 0)
    const [moved] = state.fallbackQueue.splice(2, 1);
    state.fallbackQueue.splice(0, 0, moved);
    expect(state.fallbackQueue[0]).toBe("song3.mp3");
    expect(state.fallbackQueue[1]).toBe("song1.mp3");

    // Remove item by index
    state.fallbackQueue.splice(1, 1); // remove song1.mp3
    expect(state.fallbackQueue).toEqual(["song3.mp3", "song2.mp3"]);

    // Clear queue
    state.fallbackQueue = [];
    expect(state.fallbackQueue.length).toBe(0);
  });
});
