// =============================================================
// Reproductor MoQ de Bloom (módulo cliente autocontenido)
// -------------------------------------------------------------
// conecta (WebTransport + serverCertificateHashes, @moq/net de Curley)
//   → catálogo hang → track Opus (contenedor legacy)
//   → WebCodecs AudioDecoder → AudioWorklet (jitter buffer + control de ritmo)
//   → mide su retraso → y si algo falla, <audio src="/opus"> como siempre.
//
// Uso:
//   import { MoqPlayer } from "./moq-player.js";
//   const p = new MoqPlayer({ sessionUrl: "https://radio/moq/session" });
//   button.onclick = () => p.play();          // dentro del gesto del usuario
//   p.onstats = (s) => console.log(s.mode, s.latencyMs);
//
// Política: si el navegador no tiene WebTransport + AudioDecoder(opus) +
// AudioWorklet, o es Safari (WebKit atasca sesiones largas según el propio
// @moq/net; además Web Audio se suspende con la pantalla bloqueada en iOS),
// se va directo y de forma síncrona al stream HTTP. Nadie se queda sin radio.
// =============================================================
import * as Moq from "@moq/net";
import { WORKLET_SOURCE } from "./worklet";

export type PlayerMode = "idle" | "connecting" | "moq" | "http" | "stopped";

export interface MoqPlayerOptions {
  /** Endpoint JSON con url, hashes y fallback (GET /moq/session del motor). */
  sessionUrl: string;
  /** Fuerza la URL del stream HTTP de respaldo (por defecto, la de la sesión). */
  fallbackUrl?: string;
  /** <audio> a usar para el respaldo (si no, se crea uno). */
  audio?: HTMLAudioElement;
  /** Retraso objetivo del jitter buffer (por defecto, el de la sesión). */
  targetLatencyMs?: number;
  /** Tiempo máximo para sesión + conexión + primer audio antes de caer a HTTP. */
  startTimeoutMs?: number;
  /** Sin tramas durante este tiempo en modo MoQ → HTTP. */
  stallTimeoutMs?: number;
  /** Probar MoQ también en Safari (por defecto no). */
  allowSafari?: boolean;
  /** No intentar MoQ (útil para A/B). */
  forceHttp?: boolean;
  /** Pasa el audio (MoQ o HTTP) por el detector de la sonda de latencia. */
  probe?: boolean;
  /** Ganancia de salida (0..1). */
  volume?: number;
}

export interface MoqPlayerStats {
  mode: PlayerMode;
  reason: string;
  transport: string;
  protocol: string;
  targetMs: number;
  bufferedMs: number;
  /** Estimación del retraso entrada-del-motor → altavoz (usa el track de reloj y el offset de reloj servidor). */
  latencyMs: number | null;
  outputLatencyMs: number;
  underruns: number;
  rebufferMs: number;
  skippedMs: number;
  concealedMs: number;
  framesReceived: number;
  framesDecoded: number;
  lateFrames: number;
  rate: number;
  connectMs: number | null;
  firstAudioMs: number | null;
  /** Detecciones del marcador: hora de pared (ms, reloj del cliente) en que sonó. */
  markers: number[];
}

interface Session {
  enabled: boolean;
  url?: string;
  broadcast?: string;
  catalogTrack?: string;
  audioTrack?: string;
  clockTrack?: string;
  serverCertificateHashes?: { algorithm: "sha-256"; value: string }[];
  fallbackUrl: string;
  targetLatencyMs?: number;
  serverTimeMs: number;
}

/** Duración de un paquete Opus según su TOC (RFC 6716 §3.1), en µs. */
export function opusPacketDurationUs(p: Uint8Array): number {
  if (p.length === 0) return 0;
  const toc = p[0]!;
  const cfg = toc >> 3;
  const frameUs = cfg < 12 ? [10_000, 20_000, 40_000, 60_000][cfg & 3]!
    : cfg < 16 ? [10_000, 20_000][cfg & 1]!
    : [2_500, 5_000, 10_000, 20_000][cfg & 3]!;
  const code = toc & 3;
  const count = code === 0 ? 1 : code < 3 ? 2 : (p[1] ?? 0) & 0x3f;
  return frameUs * count;
}

/** ¿Puede este navegador intentar MoQ? Síncrono: se decide dentro del gesto. */
export function moqSupport(opts: { allowSafari?: boolean } = {}): { ok: boolean; reason: string } {
  const g = globalThis as any;
  if (typeof g.WebTransport !== "function") return { ok: false, reason: "sin WebTransport" };
  if (typeof g.AudioDecoder !== "function") return { ok: false, reason: "sin WebCodecs AudioDecoder" };
  if (typeof g.AudioWorkletNode !== "function") return { ok: false, reason: "sin AudioWorklet" };
  const ua = String(g.navigator?.userAgent ?? "");
  const safari = /Safari\//.test(ua) && !/Chrome\/|Chromium\/|CriOS\/|Edg\/|Firefox\/|FxiOS\//.test(ua);
  if (safari && !opts.allowSafari) return { ok: false, reason: "Safari: HTTP por política" };
  return { ok: true, reason: "" };
}

export class MoqPlayer {
  mode: PlayerMode = "idle";
  onstats: ((s: MoqPlayerStats) => void) | null = null;
  onmode: ((mode: PlayerMode, reason: string) => void) | null = null;

  private readonly o: MoqPlayerOptions;
  private audio: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private detector: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private decoder: AudioDecoder | null = null;
  private conn: any = null;
  private origin: any = null;
  private session: Session | null = null;
  private clockOffsetMs = 0; // servidor − cliente
  private clockPair: { pts: number; wall: number } | null = null;
  private nextPts: number | null = null;
  private lastFrameAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private t0 = 0;
  private worklet: Promise<void> | null = null;
  private alive = 0; // generación: invalida bucles al parar
  private s: MoqPlayerStats;

  constructor(opts: MoqPlayerOptions) {
    this.o = { startTimeoutMs: 6000, stallTimeoutMs: 2000, ...opts };
    this.audio = opts.audio ?? document.createElement("audio");
    this.s = {
      mode: "idle", reason: "", transport: "", protocol: "", targetMs: opts.targetLatencyMs ?? 250, bufferedMs: 0,
      latencyMs: null, outputLatencyMs: 0, underruns: 0, rebufferMs: 0, skippedMs: 0, concealedMs: 0,
      framesReceived: 0, framesDecoded: 0, lateFrames: 0, rate: 1, connectMs: null, firstAudioMs: null, markers: [],
    };
  }

  get stats(): MoqPlayerStats { return { ...this.s, markers: [...this.s.markers] }; }

  /** Llamar desde el gesto del usuario. Resuelve con el modo final ("moq" o "http"). */
  async play(): Promise<PlayerMode> {
    this.stop();
    const gen = ++this.alive;
    this.t0 = performance.now();
    const support = this.o.forceHttp ? { ok: false, reason: "forceHttp" } : moqSupport(this.o);
    // El AudioContext se crea y reanuda dentro del gesto (también para la sonda en HTTP).
    if (support.ok || this.o.probe) {
      this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
      void this.ctx.resume();
    }
    if (!support.ok) { this.startHttp(support.reason, this.o.fallbackUrl ?? "/opus"); return this.mode; }

    this.setMode("connecting", "");
    try {
      await withTimeout(this.startMoq(gen), this.o.startTimeoutMs!, "arranque MoQ");
      if (gen !== this.alive) return this.mode;
      this.setMode("moq", "");
      this.watchdog = setInterval(() => {
        if (this.mode === "moq" && performance.now() - this.lastFrameAt > this.o.stallTimeoutMs!) this.fallback("sin tramas MoQ");
      }, 500);
    } catch (e) {
      if (gen === this.alive) this.fallback(String((e as Error)?.message ?? e));
    }
    return this.mode;
  }

  stop(): void {
    this.alive++;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    this.teardownMoq();
    try { this.audio.pause(); this.audio.removeAttribute("src"); this.audio.load(); } catch { /* noop */ }
    try { void this.ctx?.close(); } catch { /* noop */ }
    this.ctx = null; this.node = null; this.detector = null; this.gain = null; this.worklet = null;
    if (this.mode !== "idle") this.setMode("stopped", "");
  }

  setVolume(v: number): void {
    this.o.volume = v;
    if (this.gain) this.gain.gain.value = v;
    this.audio.volume = v;
  }

  // ---------------------------------------------------------------- MoQ
  private async startMoq(gen: number): Promise<void> {
    const tFetch = performance.now();
    const res = await fetch(this.o.sessionUrl, { cache: "no-store" });
    const tReq = performance.now();
    const session = (await res.json()) as Session;
    this.session = session;
    // Offset de reloj servidor−cliente (precisión ≈ RTT/2), para estimar el retraso.
    this.clockOffsetMs = session.serverTimeMs - (performance.timeOrigin + (tFetch + tReq) / 2);
    if (!session.enabled || !session.url || !session.serverCertificateHashes?.length) throw new Error("MoQ desactivado en el servidor");
    const target = this.o.targetLatencyMs ?? session.targetLatencyMs ?? 250;
    this.s.targetMs = target;

    // Audio: worklet + (detector) + ganancia
    const ctx = this.ctx!;
    await this.ensureWorklet();
    if (gen !== this.alive) return;
    this.node = new AudioWorkletNode(ctx, "bloom-moq-player", {
      numberOfInputs: 0, outputChannelCount: [2],
      processorOptions: { targetMs: target, maxMs: Math.max(1500, target * 4), capacitySec: 8 },
    });
    this.node.port.onmessage = (e) => this.onWorklet(e.data);
    this.gain = new GainNode(ctx, { gain: this.o.volume ?? 1 });
    if (this.o.probe) {
      this.detector = new AudioWorkletNode(ctx, "bloom-marker-detector", { outputChannelCount: [2] });
      this.detector.port.onmessage = (e) => this.onMarker(e.data);
      this.node.connect(this.detector).connect(this.gain);
    } else {
      this.node.connect(this.gain);
    }
    this.gain.connect(ctx.destination);

    // Decoder
    const cfg: AudioDecoderConfig = { codec: "opus", sampleRate: 48000, numberOfChannels: 2 };
    const sup = await AudioDecoder.isConfigSupported(cfg);
    if (!sup.supported) throw new Error("AudioDecoder sin Opus");
    this.decoder = new AudioDecoder({
      output: (d) => this.onDecoded(d),
      error: (e) => { if (gen === this.alive && this.mode === "moq") this.fallback(`decoder: ${e.message}`); },
    });
    this.decoder.configure(cfg);

    // Conexión
    const tConn = performance.now();
    this.origin = new Moq.Origin.Producer();
    this.conn = await Moq.Connection.connect({
      url: new URL(session.url),
      consume: this.origin,
      websocket: { enabled: false },
      webtransport: { serverCertificateHashes: session.serverCertificateHashes.map((h) => ({ algorithm: "sha-256" as const, value: h.value })) },
    });
    if (gen !== this.alive) { this.conn.close(); return; }
    this.s.connectMs = Math.round(performance.now() - tConn);
    this.s.transport = String(this.conn.transport ?? "");
    this.s.protocol = String(this.conn.version ?? "");
    this.conn.closed.then((err: any) => {
      if (gen === this.alive && (this.mode === "moq" || this.mode === "connecting")) this.fallback(`conexión cerrada${err ? `: ${err.message ?? err}` : ""}`);
    });

    const bc = this.origin.request(Moq.Path.from(session.broadcast!));
    let active = bc.active.peek();
    while (!active) { await bc.active.changed(); active = bc.active.peek(); if (gen !== this.alive) return; }

    const catalogTrack = active.track(session.catalogTrack ?? "catalog.json").subscribe({ priority: 1 });
    const catalog = (await (await catalogTrack.recvGroup())?.readJson()) as any;
    const renditions = catalog?.audio?.renditions ?? {};
    const name = Object.keys(renditions).find((k) => renditions[k]?.codec === "opus") ?? session.audioTrack!;

    const firstFrame = new Promise<void>((resolve, reject) => {
      const audioTrack = active.track(name).subscribe({ priority: 255, maxAge: Moq.Time.Milli(Math.max(500, target * 2)) }).ordered();
      void (async () => {
        try {
          for (;;) {
            const f = await audioTrack.readFrame();
            if (!f || gen !== this.alive) break;
            this.onFrame(f.payload);
            resolve();
          }
        } catch (e) { reject(e); if (gen === this.alive && this.mode === "moq") this.fallback(`track: ${(e as Error).message}`); }
      })();
    });
    if (session.clockTrack) {
      const clock = active.track(session.clockTrack).subscribe({ priority: 0 });
      void (async () => {
        try {
          for (;;) {
            const g = await clock.recvGroup();
            if (!g || gen !== this.alive) break;
            const j = (await g.readJson()) as any;
            if (j && typeof j.pts === "number") this.clockPair = j;
          }
        } catch { /* el reloj es opcional */ }
      })();
    }
    await firstFrame;
  }

  private onFrame(payload: Uint8Array): void {
    this.lastFrameAt = performance.now();
    this.s.framesReceived++;
    const [pts, data] = Moq.Varint.decode(payload) as unknown as [number, Uint8Array];
    const durUs = opusPacketDurationUs(data) || 20_000;
    if (this.nextPts !== null) {
      const gapUs = pts - this.nextPts;
      if (gapUs < -durUs / 2) { this.s.lateFrames++; return; } // repetida o vieja
      if (gapUs > durUs / 2) {
        // Grupo perdido/saltado: silencio del mismo largo para no comprimir el tiempo
        const frames = Math.round((Math.min(gapUs, 500_000) / 1e6) * 48000);
        this.s.concealedMs += Math.round(frames / 48);
        this.node?.port.postMessage({ type: "gap", frames, pts: this.nextPts });
      }
    }
    this.nextPts = pts + durUs;
    if (this.decoder?.state === "configured") this.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: pts, data }));
  }

  private onDecoded(d: AudioData): void {
    try {
      this.s.framesDecoded++;
      const n = d.numberOfFrames;
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      d.copyTo(l, { planeIndex: 0, format: "f32-planar" });
      if (d.numberOfChannels > 1) d.copyTo(r, { planeIndex: 1, format: "f32-planar" }); else r.set(l);
      this.node?.port.postMessage({ type: "pcm", l, r, pts: d.timestamp }, [l.buffer, r.buffer]);
    } finally {
      d.close();
    }
  }

  private onWorklet(m: any): void {
    if (m.type !== "stats" || !this.ctx) return;
    const ctx = this.ctx;
    this.s.bufferedMs = Math.round(m.fill / 48);
    this.s.underruns = m.underruns;
    this.s.rebufferMs = Math.round(m.rebufferFrames / 48);
    this.s.skippedMs = Math.round(m.skippedFrames / 48);
    this.s.rate = Math.round(m.rate * 10000) / 10000;
    this.s.outputLatencyMs = Math.round(((ctx as any).outputLatency ?? 0) * 1000 + ctx.baseLatency * 1000);
    if (m.playing && this.s.firstAudioMs === null) this.s.firstAudioMs = Math.round(performance.now() - this.t0);
    if (m.pts !== null && this.clockPair) {
      // pared del instante en que este bloque llega al altavoz (reloj del servidor)
      const wallOut = this.contextTimeToWall(m.t) + this.s.outputLatencyMs + this.clockOffsetMs;
      const wallIn = this.clockPair.wall + (m.pts - this.clockPair.pts) / 1000;
      this.s.latencyMs = Math.round(wallOut - wallIn);
    }
    this.onstats?.(this.stats);
  }

  private onMarker(m: any): void {
    // marca en hora de pared del cliente (incluye la latencia de salida)
    const wall = this.contextTimeToWall(m.t) + this.s.outputLatencyMs;
    this.s.markers.push(Math.round(wall));
    this.onstats?.(this.stats);
  }

  private contextTimeToWall(t: number): number {
    const ctx = this.ctx!;
    const ts = ctx.getOutputTimestamp();
    if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      return performance.timeOrigin + ts.performanceTime + (t - ts.contextTime) * 1000;
    }
    return performance.timeOrigin + performance.now() + (t - ctx.currentTime) * 1000;
  }

  private teardownMoq(): void {
    try { this.conn?.close(); } catch { /* noop */ }
    try { this.origin?.close?.(); } catch { /* noop */ }
    try { if (this.decoder && this.decoder.state !== "closed") this.decoder.close(); } catch { /* noop */ }
    try { this.node?.disconnect(); } catch { /* noop */ }
    this.conn = null; this.origin = null; this.decoder = null; this.nextPts = null; this.clockPair = null;
  }

  // ---------------------------------------------------------------- HTTP
  private fallback(reason: string): void {
    if (this.mode === "http" || this.mode === "stopped") return;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    this.teardownMoq();
    const fb = this.o.fallbackUrl ?? this.session?.fallbackUrl ?? "/opus";
    this.startHttp(reason, new URL(fb, new URL(this.o.sessionUrl, location.href)).toString());
  }

  private startHttp(reason: string, src: string): void {
    const a = this.audio;
    a.preload = "none";
    if (this.o.probe && this.ctx) {
      // Misma ruta de medida que en MoQ: <audio> → detector → salida
      a.crossOrigin = "anonymous";
      const ctx = this.ctx;
      const srcNode = ctx.createMediaElementSource(a);
      void this.ensureWorklet().then(() => {
        this.detector = new AudioWorkletNode(ctx, "bloom-marker-detector", { outputChannelCount: [2] });
        this.detector.port.onmessage = (e) => this.onMarker(e.data);
        srcNode.connect(this.detector).connect(ctx.destination);
      }).catch(() => srcNode.connect(ctx.destination));
    }
    a.src = src;
    a.volume = this.o.volume ?? 1;
    const p = a.play();
    this.setMode("http", reason);
    p?.then(() => { if (this.s.firstAudioMs === null) this.s.firstAudioMs = Math.round(performance.now() - this.t0); this.onstats?.(this.stats); })
      .catch((e) => { this.s.reason = `${reason}; <audio>: ${e?.message ?? e}`; this.onstats?.(this.stats); });
  }

  private ensureWorklet(): Promise<void> {
    if (!this.worklet) {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
      this.worklet = this.ctx!.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    }
    return this.worklet;
  }

  private setMode(mode: PlayerMode, reason: string): void {
    this.mode = mode;
    this.s.mode = mode;
    this.s.reason = reason;
    this.onmode?.(mode, reason);
    this.onstats?.(this.stats);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: más de ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// Para la página de demo y para integraciones sin bundler (<script type="module">).
(globalThis as any).BloomMoqPlayer = { MoqPlayer, moqSupport };
