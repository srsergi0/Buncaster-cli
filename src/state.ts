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
  /** Análisis BS.1770 aplicado a esta pista (si LOUDNESS_NORMALIZATION / SMART_TRANSITIONS). */
  loudness?: {
    integratedLufs: number;
    truePeakDbtp: number;
    gainDb: number;
    leadSkipSec: number;
    tailStartSec: number | null;
  } | null;
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

  // Engine roundtable: aire muerto, supervisión y latencia
  /** Segundos acumulados en que el encoder no recibió PCM (huecos > 500 ms). */
  deadAirSeconds: 0,
  deadAirEvents: 0,
  /** Segundos de PCM emitido por debajo de -60 dBFS de pico (silencio digital). */
  digitalSilenceSeconds: 0,
  fallbackStallRestarts: 0,
  opusEncoderRestarts: 0,
  opusEncoderGeneration: 0,
  crossfadesCompleted: 0,
  crossfadesTruncated: 0,
  handoverDrainedBytes: 0,
  /** Bytes que el deck entrante no tenía listos durante un crossfade (rellenados con silencio). */
  crossfadeUnderrunBytes: 0,
  /** Backlog (segundos de audio) entregado a cada oyente al conectar: suma y conteo. */
  joinBacklogSecondsSum: 0,
  joinBacklogCount: 0,
  joinBacklogSecondsMax: 0,

  // Bun way (docs/ENGINE-BUN-WAY.md): quién hace el trabajo y cuánto se evita
  /** Pistas decodificadas en proceso (libavcodec FFI) vs con un proceso ffmpeg. */
  deckDecodesNative: 0,
  deckDecodesFfmpeg: 0,
  /** MP3_ON_DEMAND: "live" codifica, "idle" sin oyentes mp3 (no codifica), "warming" codificando historial. */
  mp3EncoderMode: "live" as "live" | "idle" | "warming",
  mp3EncoderWakeups: 0,
  /** SRT_ON_DEMAND: socket UDP de Bun esperando el primer paquete (sin ffmpeg). */
  srtArmed: false,
  srtWakeups: 0,

  fallbackQueue: [] as string[],
  currentTrack: null as ActiveTrackInfo | null,
  fallbackPaused: false,
};


