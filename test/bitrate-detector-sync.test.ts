import { describe, expect, it } from "bun:test";
import { BitrateDetector } from "../src/bitrate-detector";
import { state } from "../src/state";

describe("BitrateDetector State Synchronization", () => {
  it("updates global state with detected bitrate and sample rate", () => {
    state.detectedBitrateKbps = undefined;
    state.detectedSampleRate = undefined;

    let detectedCalled = false;
    const detector = new BitrateDetector((info) => {
      detectedCalled = true;
      state.detectedBitrateKbps = info.bitrateKbps;
      state.detectedSampleRate = info.sampleRate;
    });

    // Construct a standard MPEG-1 Layer 3 frame header:
    // Sync word: 0xFF, 0xFB (MPEG Version 1, Layer III, no CRC)
    // Bitrate & Sample Rate:
    // 128 kbps (index 9 = 0b1001 = 0x90) + 44100 Hz (index 0 = 0b00 << 2 = 0x00) -> 0x90
    // Channel mode: stereo (0x00)
    // Frame size for 128kbps, 44.1kHz: 144 * 128000 / 44100 = 417 bytes
    const frameSize = 417;
    const frame = new Uint8Array(frameSize);
    frame[0] = 0xff;
    frame[1] = 0xfb;
    frame[2] = 0x90;
    frame[3] = 0x00;

    // Push frame to detector
    detector.feed(frame);

    expect(detectedCalled).toBe(true);
    expect(state.detectedBitrateKbps).toBe(128);
    expect(state.detectedSampleRate).toBe(44100);
  });
});
