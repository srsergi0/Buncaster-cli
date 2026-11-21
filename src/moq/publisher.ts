// =============================================================
// Publicador MoQ en proceso (@moq/net → moq-relay por WebSocket/qmux)
// -------------------------------------------------------------
// Bun 1.4.5 no tiene WebTransport ni HTTP/3 (solo un `node:quic` experimental
// sin capa HTTP/3), así que el motor no habla QUIC: publica al relay de la
// misma máquina por WebSocket (qmux, el polyfill de streams QUIC de Curley) en
// la red interna de docker. El relay (Rust, quinn) es quien da QUIC/WebTransport
// a los oyentes, con su caché, prioridades y descarte de grupos viejos.
//
// El broadcast y sus tracks viven en un Origin propio que sobrevive a las
// reconexiones: si el relay se reinicia, se vuelve a anunciar lo mismo.
// =============================================================
import { encodeLegacyFrame } from "./hang";

export interface MoqPublisherOptions {
  /** Base del relay para publicar, p. ej. http://moq-relay:4434 (http→ws). */
  relayUrl: string;
  /** Ruta raíz (= root del JWT), p. ej. "bloom". */
  path: string;
  broadcast: string;
  audioTrack: string;
  clockTrack: string;
  catalog: unknown;
  /** Duración mínima de audio por grupo (ms). */
  groupMs: number;
  /** Edad máxima de un grupo no-último antes de descartarlo (ms). */
  maxAgeMs: number;
  /** Token de publicación (se pide uno nuevo en cada conexión). */
  token: () => string;
  log: (level: "info" | "warn" | "debug", msg: string, data?: Record<string, unknown>) => void;
}

export interface MoqPublisherStatus {
  connected: boolean;
  connects: number;
  failures: number;
  lastError: string;
  framesPublished: number;
  groupsPublished: number;
  bytesPublished: number;
  transport: string;
  version: string;
}

const BACKOFF_MIN_MS = 1000;

function errText(e: any): string {
  if (e?.errors?.length) return e.errors.map(errText).join("; ");
  return String(e?.message || e?.name || e || "error");
}
const BACKOFF_MAX_MS = 30_000;

export class MoqPublisher {
  readonly status: MoqPublisherStatus = {
    connected: false, connects: 0, failures: 0, lastError: "",
    framesPublished: 0, groupsPublished: 0, bytesPublished: 0, transport: "", version: "",
  };
  private Moq: any = null;
  private origin: any = null;
  private bc: any = null;
  private audio: any = null;
  private clock: any = null;
  private group: any = null;
  private groupStartUs = -Infinity;
  private conn: any = null;
  private stopped = false;
  private backoffMs = BACKOFF_MIN_MS;
  private wake: (() => void) | null = null;

  constructor(private readonly o: MoqPublisherOptions) {}

  async start(): Promise<void> {
    this.Moq = await import("@moq/net");
    const Moq = this.Moq;
    this.origin = new Moq.Origin.Producer();
    this.bc = this.origin.createBroadcast(Moq.Path.from(this.o.broadcast));
    this.bc.announce();
    // Un único snapshot cerrado que debe seguir siendo servible horas después
    // (como hace @moq/publish): maxAge "infinito" para el catálogo.
    const catalog = this.bc.createTrack("catalog.json", { maxAge: Number.MAX_SAFE_INTEGER, priority: 255 });
    const g = catalog.appendGroup();
    g.writeJson(this.o.catalog);
    g.close();
    this.audio = this.bc.createTrack(this.o.audioTrack, { timescale: Moq.Time.Timescale.MICRO, maxAge: this.o.maxAgeMs, priority: 255 });
    this.clock = this.bc.createTrack(this.o.clockTrack, { priority: 64 });
    void this.loop();
  }

  private async loop(): Promise<void> {
    const Moq = this.Moq;
    while (!this.stopped) {
      const url = new URL(`${this.o.relayUrl.replace(/\/+$/, "")}/${this.o.path}`);
      url.searchParams.set("jwt", this.o.token());
      try {
        this.conn = await Moq.Connection.connect({ url, publish: this.origin.consume(), signal: AbortSignal.timeout(10_000) });
        this.status.connected = true;
        this.status.connects++;
        this.status.transport = String(this.conn.transport ?? "");
        this.status.version = String(this.conn.version ?? "");
        this.backoffMs = BACKOFF_MIN_MS;
        this.o.log("info", `MoQ: publicando ${this.o.path}/${this.o.broadcast} en el relay`, { transport: this.status.transport, version: this.status.version });
        const err = await this.conn.closed;
        if (this.stopped) break;
        this.status.lastError = err ? errText(err) : "cerrada";
        this.o.log("warn", `MoQ: conexión con el relay cerrada (${this.status.lastError})`);
      } catch (e) {
        this.status.failures++;
        this.status.lastError = errText(e);
        this.o.log(this.status.failures <= 3 ? "warn" : "debug", `MoQ: no se pudo conectar al relay (${this.status.lastError}); reintento en ${this.backoffMs} ms`);
      }
      this.status.connected = false;
      this.conn = null;
      if (this.stopped) break;
      await new Promise<void>((r) => { const t = setTimeout(r, this.backoffMs); this.wake = () => { clearTimeout(t); r(); }; });
      this.wake = null;
      this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
    }
  }

  /** ¿Hay alguien (el relay, en nombre de algún oyente) suscrito al audio? */
  hasDemand(): boolean {
    try { return !!this.audio?.used?.peek(); } catch { return true; }
  }

  /** Un paquete Opus de 20 ms con su PTS (µs desde el arranque del encoder). */
  writeAudio(ptsUs: number, packet: Uint8Array): void {
    if (!this.audio) return;
    const Moq = this.Moq;
    if (!this.group || ptsUs - this.groupStartUs >= this.o.groupMs * 1000) {
      if (this.group) { this.group.close(); this.status.groupsPublished++; }
      this.group = this.audio.appendGroup();
      this.groupStartUs = ptsUs;
    }
    const frame = encodeLegacyFrame(ptsUs, packet);
    this.group.writeFrame({ payload: frame, timestamp: Moq.Time.Timestamp.fromMicros(ptsUs) });
    this.status.framesPublished++;
    this.status.bytesPublished += frame.byteLength;
  }

  /** Correspondencia PTS → hora de pared de la entrada al motor (para medir retraso en el cliente). */
  writeClock(ptsUs: number, wallMs: number): void {
    if (!this.clock) return;
    const g = this.clock.appendGroup();
    g.writeJson({ pts: ptsUs, wall: wallMs });
    g.close();
  }

  stop(): void {
    this.stopped = true;
    try { this.group?.close(); } catch { /* noop */ }
    try { this.conn?.close(); } catch { /* noop */ }
    try { this.bc?.close(); } catch { /* noop */ }
    this.wake?.();
  }
}
