import { type IcyClientState } from "./icy-metadata";

export interface RadioClient {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  connectedAt: Date;
  ip: string;
  userAgent: string;
  bytesSent: number;
  slowStrikes: number;
  icy?: IcyClientState;
  tier: "mp3" | "opus";
}

export interface ActiveTrackInfo {
  file: string;
  title: string;
  artist: string;
  duration: number; // en segundos
  startedAt: number; // timestamp ms
}

export type DeckState = "IDLE" | "PRELOADING" | "READY" | "PLAYING" | "CROSSFADING" | "DRAINING" | "STOPPED";

export const state = {
  clients: new Map<string, RadioClient>(),
  mp3Clients: new Map<string, RadioClient>(),
  opusClients: new Map<string, RadioClient>(),
  listenersMp3: 0,
  listenersOpus: 0,
  isBroadcasting: false,
  sourceConnected: false,
  sourceProcess: null as any | null,
  masterProcess: null as any | null,
  opusProcess: null as any | null,
  shuttingDown: false,
  startTime: new Date(),
  totalListenersServed: 0,
  totalBytesReceived: 0,
  totalBytesSent: 0,
  totalBytesSentOpus: 0,
  detectedBitrateKbps: null as number | null,
  detectedSampleRate: null as number | null,

  // Deck Lifecycle & State Machine
  deckState: { A: "IDLE" as DeckState, B: "IDLE" as DeckState },
  deckSessions: { A: "", B: "" },
  deckGenerations: { A: 0, B: 0 },

  // Audio Clock & Precision Metrics
  audioClockSamples: 0,
  audioSamplesProduced: 0,
  audioUnderruns: 0,
  lastSourceAudioTimeMs: 0,
  lastPcmSampleTimeMs: 0,
  evictionsTotal: { slowClient: 0, backpressure: 0, timeout: 0 },

  fallbackQueue: [] as string[],
  currentTrack: null as ActiveTrackInfo | null,
  fallbackPaused: false,
};


