import { describe, expect, it } from "bun:test";

export type DeckState = "IDLE" | "PRELOADING" | "READY" | "PLAYING" | "CROSSFADING" | "DRAINING" | "STOPPED";

export interface DeckSession {
  id: "A" | "B";
  state: DeckState;
  sessionId: string;
  generation: number;
  currentTrackFile: string | null;
}

export class ManagedDeck {
  public id: "A" | "B";
  public state: DeckState = "IDLE";
  public sessionId: string = "";
  public generation: number = 0;
  public currentTrackFile: string | null = null;

  constructor(id: "A" | "B") {
    this.id = id;
  }

  startSession(file: string): string {
    this.generation++;
    this.sessionId = `${this.id}-${this.generation}-${Date.now()}`;
    this.state = "PRELOADING";
    this.currentTrackFile = file;
    return this.sessionId;
  }

  markReady(sessionId: string): boolean {
    if (this.sessionId !== sessionId) return false; // Stale session
    this.state = "READY";
    return true;
  }

  markPlaying(sessionId: string): boolean {
    if (this.sessionId !== sessionId) return false;
    this.state = "PLAYING";
    return true;
  }

  startCrossfade(sessionId: string): boolean {
    if (this.sessionId !== sessionId) return false;
    this.state = "CROSSFADING";
    return true;
  }

  stop(sessionId?: string): boolean {
    if (sessionId && this.sessionId !== sessionId) {
      // Ignore stop from old session
      return false;
    }
    this.state = "STOPPED";
    this.currentTrackFile = null;
    return true;
  }
}

describe("Deck State Machine & Session Identity", () => {
  it("rejects delayed events from stale sessions", () => {
    const deck = new ManagedDeck("A");

    // Session 1 starts
    const session1 = deck.startSession("/music/track1.mp3");
    expect(deck.state).toBe("PRELOADING");

    // Session 2 is triggered (e.g. user skips quickly)
    const session2 = deck.startSession("/music/track2.mp3");
    expect(deck.state).toBe("PRELOADING");
    expect(deck.sessionId).toBe(session2);

    // Delayed callback from session 1 arrives
    const readyResult1 = deck.markReady(session1);
    expect(readyResult1).toBe(false);
    expect(deck.state).toBe("PRELOADING"); // Remains PRELOADING for session 2

    // Stop from session 1 arrives
    const stopResult1 = deck.stop(session1);
    expect(stopResult1).toBe(false);
    expect(deck.currentTrackFile).toBe("/music/track2.mp3");

    // Valid callback from session 2 arrives
    const readyResult2 = deck.markReady(session2);
    expect(readyResult2).toBe(true);
    expect(deck.state).toBe("READY");

    deck.markPlaying(session2);
    expect(deck.state).toBe("PLAYING");
  });

  it("advances through valid state transitions", () => {
    const deck = new ManagedDeck("B");
    const session = deck.startSession("/music/song.flac");
    expect(deck.state).toBe("PRELOADING");

    deck.markReady(session);
    expect(deck.state).toBe("READY");

    deck.markPlaying(session);
    expect(deck.state).toBe("PLAYING");

    deck.startCrossfade(session);
    expect(deck.state).toBe("CROSSFADING");

    deck.stop(session);
    expect(deck.state).toBe("STOPPED");
    expect(deck.currentTrackFile).toBeNull();
  });
});
