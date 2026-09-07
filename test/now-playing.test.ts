import { describe, expect, it } from "bun:test";
import { state } from "../src/state";
import { getNowPlayingInfo, getCurrentTitle } from "../src/broadcaster";

describe("Now Playing & Track Exposure", () => {
  it("exposes silence state when no music and no live broadcast", () => {
    state.isBroadcasting = false;
    state.currentTrack = null;

    const info = getNowPlayingInfo();
    expect(info.type).toBe("silence");
    expect(info.isLive).toBe(false);
    expect(getCurrentTitle()).toBe("");
  });

  it("exposes live broadcast when OBS is streaming", () => {
    state.isBroadcasting = true;
    state.lastSourceAudioTimeMs = Date.now() - 5000;

    const info = getNowPlayingInfo();
    expect(info.type).toBe("live");
    expect(info.isLive).toBe(true);
    expect(info.display).toContain("LIVE");
    expect(getCurrentTitle()).toContain("LIVE");
  });

  it("exposes clean track metadata, progress and duration when fallback track is playing", () => {
    state.isBroadcasting = false;
    const startedAt = Date.now() - 30000; // 30s ago
    state.currentTrack = {
      file: "musica/Queen - Bohemian Rhapsody.mp3",
      title: "Bohemian Rhapsody",
      artist: "Queen",
      duration: 354,
      startedAt,
    };

    const info = getNowPlayingInfo();
    expect(info.type).toBe("fallback");
    expect(info.isLive).toBe(false);
    expect(info.display).toBe("Queen - Bohemian Rhapsody");
    expect(info.title).toBe("Bohemian Rhapsody");
    expect(info.artist).toBe("Queen");
    expect(info.duration).toBe(354);
    expect(info.elapsed).toBeGreaterThanOrEqual(29);
    expect(info.remaining).toBeLessThanOrEqual(325);
    expect(info.progress).toBeGreaterThan(0.05);
    expect(info.progress).toBeLessThan(0.15);
    expect(getCurrentTitle()).toBe("Queen - Bohemian Rhapsody");
  });

  it("does not prepend Artista Desconocido if artist is unknown", () => {
    state.isBroadcasting = false;
    state.currentTrack = {
      file: "musica/Podcast Episode 1.mp3",
      title: "Podcast Episode 1",
      artist: "Artista Desconocido",
      duration: 1200,
      startedAt: Date.now() - 10000,
    };

    const info = getNowPlayingInfo();
    expect(info.display).toBe("Podcast Episode 1");
    expect(getCurrentTitle()).toBe("Podcast Episode 1");
  });
});
