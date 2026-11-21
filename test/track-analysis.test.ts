import { describe, expect, it } from "bun:test";
import { computeGainDb, parseAnalysisOutput, planTrack, type TrackAnalysis } from "../src/track-analysis";

// stderr real de `ffmpeg -af ebur128=peak=true:framelog=quiet,silencedetect=n=-50dB:d=0.5`
// sobre una pista sintética "loud master" con 1 s de silencio inicial y 3 s final.
const LOUD_MASTER_STDERR = `Input #0, mp3, from '/m/01 - Loud Master - Synth.mp3':
  Duration: 00:00:18.02, start: 0.023021, bitrate: 192 kb/s
  Stream #0:0: Audio: mp3, 48000 Hz, stereo, fltp, 192 kb/s
[silencedetect @ 0x74d5f9c54c40] silence_start: 0
[silencedetect @ 0x74d5f9c54c40] silence_end: 0.999667 | silence_duration: 0.999667
[silencedetect @ 0x74d5f9c54c40] silence_start: 15.0122
size=N/A time=00:00:17.90 bitrate=N/A speed= 104x
[Parsed_ebur128_0 @ 0x74d5f534eec0] Summary:
  Integrated loudness:
    I:          -9.7 LUFS
    Threshold: -19.8 LUFS
  Loudness range:
    LRA:         3.0 LU
    Threshold: -30.2 LUFS
    LRA low:   -12.6 LUFS
    LRA high:   -9.6 LUFS
  True peak:
    Peak:        0.0 dBFS
[silencedetect @ 0x74d5f9c54c40] silence_end: 18 | silence_duration: 2.98777
`;

const TTS_STDERR = `  Duration: 00:00:14.04, start: 0.023021, bitrate: 192 kb/s
[Parsed_ebur128_0 @ 0x1] Summary:
  Integrated loudness:
    I:         -22.1 LUFS
  True peak:
    Peak:       -9.6 dBFS
`;

const cfg = {
  loudnessNormalization: true,
  loudnessTargetLufs: -16,
  loudnessTruePeakDbtp: -1,
  loudnessMaxGainDb: 12,
  smartTransitions: true,
};

function full(p: ReturnType<typeof parseAnalysisOutput>): TrackAnalysis {
  return { version: 1, mtime: 1, analysisMs: 1, ...p! };
}

describe("Track analysis (BS.1770 + silencios)", () => {
  it("parses integrated loudness, true peak, duration and lead/tail silence", () => {
    const a = parseAnalysisOutput(LOUD_MASTER_STDERR)!;
    expect(a.integratedLufs).toBe(-9.7);
    expect(a.truePeakDbtp).toBe(0);
    expect(a.durationSec).toBeCloseTo(18.02, 2);
    expect(a.leadSilenceEndSec).toBeCloseTo(0.9997, 3);
    expect(a.tailSilenceStartSec).toBeCloseTo(15.0122, 3);
  });

  it("parses a track with no silences", () => {
    const a = parseAnalysisOutput(TTS_STDERR)!;
    expect(a.integratedLufs).toBe(-22.1);
    expect(a.truePeakDbtp).toBe(-9.6);
    expect(a.leadSilenceEndSec).toBe(0);
    expect(a.tailSilenceStartSec).toBeNull();
  });

  it("returns null when ebur128 produced no summary (decode failure)", () => {
    expect(parseAnalysisOutput("Error opening input file x.mp3")).toBeNull();
  });

  it("computes static gain toward target, capped by true-peak ceiling and max gain", () => {
    // Master fuerte: baja 6.3 dB → -16 LUFS
    expect(computeGainDb({ integratedLufs: -9.7, truePeakDbtp: 0 }, cfg)).toBe(-6.3);
    // Locución TTS: sube 6.1 dB (TP -9.6 + 6.1 = -3.5 dBTP < -1)
    expect(computeGainDb({ integratedLufs: -22.1, truePeakDbtp: -9.6 }, cfg)).toBe(6.1);
    // Pista dinámica con picos altos: el techo de true-peak manda (sin limitador)
    expect(computeGainDb({ integratedLufs: -24, truePeakDbtp: -2.5 }, cfg)).toBe(1.5);
    // Nunca más de LOUDNESS_MAX_GAIN_DB
    expect(computeGainDb({ integratedLufs: -40, truePeakDbtp: -30 }, cfg)).toBe(12);
    // Pista muda: no tocar
    expect(computeGainDb({ integratedLufs: -70, truePeakDbtp: -Infinity }, cfg)).toBe(0);
  });

  it("plans lead skip and effective end only with SMART_TRANSITIONS", () => {
    const a = full(parseAnalysisOutput(LOUD_MASTER_STDERR));
    const smart = planTrack(a, cfg);
    expect(smart.gainDb).toBe(-6.3);
    expect(smart.leadSkipSec).toBeCloseTo(1.0, 2);
    expect(smart.endSec).toBeCloseTo(15.0122 - 0.9997, 2); // en tiempo del deck

    const plain = planTrack(a, { ...cfg, smartTransitions: false });
    expect(plain.leadSkipSec).toBe(0);
    expect(plain.endSec).toBeNull();

    const off = planTrack(a, { ...cfg, loudnessNormalization: false });
    expect(off.gainDb).toBe(0);

    expect(planTrack(null, cfg)).toMatchObject({ analyzed: false, gainDb: 0, leadSkipSec: 0, endSec: null });
  });

  it("does not skip the intro when the remaining body would be shorter than 5 s", () => {
    const a: TrackAnalysis = { version: 1, mtime: 1, analysisMs: 1, durationSec: 8, integratedLufs: -30, truePeakDbtp: -20, leadSilenceEndSec: 3, tailSilenceStartSec: 6 };
    const p = planTrack(a, cfg);
    expect(p.leadSkipSec).toBe(0);
    expect(p.endSec).toBe(6); // sí cruza donde empieza el silencio final
  });
});
