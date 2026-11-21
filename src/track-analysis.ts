// =============================================================
// Análisis de pistas: sonoridad (ITU-R BS.1770 / EBU R128) y silencios
// -------------------------------------------------------------
// Una sola pasada de ffmpeg por pista (`ebur128=peak=true` +
// `silencedetect`) a baja prioridad (`nice`), en serie, cacheada en
// disco por ruta+mtime. Con el resultado:
//   • LOUDNESS_NORMALIZATION → ganancia estática hacia LOUDNESS_TARGET_LUFS,
//     limitada por el true-peak (techo LOUDNESS_TRUE_PEAK_DBTP) y por
//     LOUDNESS_MAX_GAIN_DB. No comprime ni limita: es ReplayGain-style.
//   • SMART_TRANSITIONS → salta el silencio inicial y adelanta el
//     crossfade al punto donde empieza el silencio final.
// Si una pista aún no está analizada se reproduce tal cual (gain 0) y se
// encola su análisis; las 2 siguientes de la cola/playlist se analizan
// por adelantado mientras suena la actual.
// =============================================================
import fs from "fs";
import { config, type Config } from "./config";
import { rtmpLog } from "./logger";
import { Event } from "./events";
import { state } from "./state";

export const ANALYSIS_VERSION = 1;

export interface TrackAnalysis {
  version: number;
  mtime: number;
  durationSec: number;
  integratedLufs: number;
  truePeakDbtp: number;
  /** Fin del silencio inicial (s); 0 si la pista arranca con señal. */
  leadSilenceEndSec: number;
  /** Inicio del silencio que dura hasta el final (s); null si no hay. */
  tailSilenceStartSec: number | null;
  analysisMs: number;
}

export interface TrackPlan {
  analyzed: boolean;
  gainDb: number;
  leadSkipSec: number;
  /** Fin efectivo en tiempo del deck (ya descontado leadSkip); null = usar duración. */
  endSec: number | null;
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  tailStartSec: number | null;
}

type PlanConfig = Pick<Config, "loudnessNormalization" | "loudnessTargetLufs" | "loudnessTruePeakDbtp" | "loudnessMaxGainDb" | "smartTransitions">;

export function analysisEnabled(cfg: PlanConfig = config): boolean {
  return cfg.loudnessNormalization || cfg.smartTransitions;
}

/** Ganancia estática (dB) hacia el objetivo, sin superar el techo de true-peak. */
export function computeGainDb(a: Pick<TrackAnalysis, "integratedLufs" | "truePeakDbtp">, cfg: PlanConfig = config): number {
  if (!Number.isFinite(a.integratedLufs) || a.integratedLufs <= -69) return 0; // pista muda o sin medir
  let g = cfg.loudnessTargetLufs - a.integratedLufs;
  g = Math.min(g, cfg.loudnessMaxGainDb);
  if (Number.isFinite(a.truePeakDbtp)) g = Math.min(g, cfg.loudnessTruePeakDbtp - a.truePeakDbtp);
  const r = Math.round(g * 10) / 10;
  return Math.abs(r) < 0.1 ? 0 : r;
}

const MIN_BODY_SEC = 5;
const MAX_LEAD_SKIP_SEC = 10;

export function planTrack(a: TrackAnalysis | null, cfg: PlanConfig = config): TrackPlan {
  if (!a) {
    return { analyzed: false, gainDb: 0, leadSkipSec: 0, endSec: null, integratedLufs: null, truePeakDbtp: null, tailStartSec: null };
  }
  const gainDb = cfg.loudnessNormalization ? computeGainDb(a, cfg) : 0;
  let leadSkipSec = 0;
  let endSec: number | null = null;
  if (cfg.smartTransitions) {
    const tail = a.tailSilenceStartSec ?? a.durationSec;
    if (a.leadSilenceEndSec >= 0.05 && a.leadSilenceEndSec <= MAX_LEAD_SKIP_SEC && tail - a.leadSilenceEndSec >= MIN_BODY_SEC) {
      leadSkipSec = Math.round(a.leadSilenceEndSec * 1000) / 1000;
    }
    if (a.tailSilenceStartSec !== null && a.tailSilenceStartSec - leadSkipSec >= MIN_BODY_SEC) {
      endSec = Math.round((a.tailSilenceStartSec - leadSkipSec) * 1000) / 1000;
    }
  }
  return { analyzed: true, gainDb, leadSkipSec, endSec, integratedLufs: a.integratedLufs, truePeakDbtp: a.truePeakDbtp, tailStartSec: a.tailSilenceStartSec };
}

/** Parser del stderr de `ffmpeg -af ebur128=peak=true,silencedetect=... -f null -`. */
export function parseAnalysisOutput(stderr: string): Omit<TrackAnalysis, "version" | "mtime" | "analysisMs"> | null {
  const iMatches = [...stderr.matchAll(/^\s*I:\s+(-?[\d.]+|-inf) LUFS/gm)];
  if (iMatches.length === 0) return null;
  const integratedLufs = Number(iMatches[iMatches.length - 1]![1] === "-inf" ? -70 : iMatches[iMatches.length - 1]![1]);
  const peaks = [...stderr.matchAll(/^\s*Peak:\s+(-?[\d.]+|-inf) dBFS/gm)];
  const truePeakDbtp = peaks.length > 0 ? (peaks[peaks.length - 1]![1] === "-inf" ? -Infinity : Number(peaks[peaks.length - 1]![1])) : NaN;

  // Duración: la mayor entre la cabecera del contenedor y el último time= de silencedetect
  let durationSec = 0;
  const d = stderr.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (d) durationSec = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);

  const events: { kind: "start" | "end"; t: number }[] = [];
  for (const m of stderr.matchAll(/silence_(start|end):\s+(-?[\d.]+)/g)) {
    events.push({ kind: m[1] as "start" | "end", t: Number(m[2]) });
  }
  let leadSilenceEndSec = 0;
  if (events.length >= 2 && events[0]!.kind === "start" && events[0]!.t <= 0.05 && events[1]!.kind === "end") {
    leadSilenceEndSec = events[1]!.t;
  }
  let tailSilenceStartSec: number | null = null;
  const last = events[events.length - 1];
  if (last) {
    if (last.kind === "start") {
      tailSilenceStartSec = last.t; // silencio sin fin: llega hasta EOF
    } else if (events.length >= 2 && durationSec > 0 && Math.abs(last.t - durationSec) <= 0.25) {
      const prev = events[events.length - 2]!;
      if (prev.kind === "start" && prev.t > 0.05) tailSilenceStartSec = prev.t;
    }
  }
  if (tailSilenceStartSec !== null && tailSilenceStartSec <= leadSilenceEndSec) tailSilenceStartSec = null;
  return { durationSec, integratedLufs, truePeakDbtp, leadSilenceEndSec, tailSilenceStartSec };
}

// ---------------- caché persistente ----------------
const cache = new Map<string, TrackAnalysis>();
let cacheLoaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const data = JSON.parse(fs.readFileSync(config.analysisCacheFile, "utf8"));
    for (const [k, v] of Object.entries(data ?? {})) {
      const a = v as TrackAnalysis;
      if (a && a.version === ANALYSIS_VERSION && typeof a.mtime === "number") cache.set(k, a);
    }
    rtmpLog.debug(`[Analysis] ${cache.size} análisis cargados de ${config.analysisCacheFile}`);
  } catch {
    // no existe / inválido
  }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const obj: Record<string, TrackAnalysis> = {};
    for (const [k, v] of cache) obj[k] = v;
    fs.promises.writeFile(config.analysisCacheFile, JSON.stringify(obj)).catch(() => {});
  }, 2000);
}

function mtimeOf(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return -1; }
}

export function getCachedAnalysis(file: string): TrackAnalysis | null {
  if (!analysisEnabled() || /^(https?|rtmp|srt):\/\//i.test(file)) return null;
  loadCache();
  const a = cache.get(file);
  if (!a) return null;
  return a.mtime === mtimeOf(file) ? a : null;
}

/** Inyección para tests. */
export function _setCachedAnalysis(file: string, a: TrackAnalysis): void {
  cacheLoaded = true;
  cache.set(file, a);
}

// ---------------- cola de análisis (1 a la vez) ----------------
const queue: string[] = [];
const queued = new Set<string>();
let running = false;
let niceAvailable: boolean | null = null;

/**
 * Encola análisis. `priority` (pista actual y siguientes) se adelanta al barrido
 * de fondo de la biblioteca (ANALYSIS_PRESCAN).
 */
export function requestAnalysis(files: (string | undefined)[], opts: { priority?: boolean } = {}): void {
  if (!analysisEnabled()) return;
  const fresh: string[] = [];
  for (const f of files) {
    if (!f || /^(https?|rtmp|srt):\/\//i.test(f)) continue;
    if (getCachedAnalysis(f)) continue;
    if (queued.has(f)) {
      if (opts.priority) { const i = queue.indexOf(f); if (i > 0) { queue.splice(i, 1); fresh.push(f); } }
      continue;
    }
    queued.add(f);
    fresh.push(f);
  }
  if (opts.priority) queue.unshift(...fresh);
  else queue.push(...fresh);
  void runQueue();
}

async function runQueue() {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0 && !state.shuttingDown) {
      const file = queue.shift()!;
      try {
        await analyzeFile(file);
      } catch (err) {
        rtmpLog.debug(`[Analysis] Falló ${file}: ${(err as Error).message}`);
      } finally {
        queued.delete(file);
      }
    }
  } finally {
    running = false;
  }
}

async function analyzeFile(file: string): Promise<TrackAnalysis | null> {
  const mtime = mtimeOf(file);
  if (mtime < 0) return null;
  const filter = `ebur128=peak=true:framelog=quiet,silencedetect=n=${config.silenceThresholdDb}dB:d=0.5`;
  const ff = ["ffmpeg", "-nostats", "-hide_banner", "-threads", "1", "-i", file, "-vn", "-af", filter, "-f", "null", "-"];
  const t0 = Date.now();
  let proc: any;
  if (niceAvailable !== false) {
    try {
      proc = Bun.spawn(["nice", "-n", "10", ...ff], { stdout: "ignore", stderr: "pipe" });
      niceAvailable = true;
    } catch {
      niceAvailable = false;
    }
  }
  if (!proc) proc = Bun.spawn(ff, { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  const parsed = parseAnalysisOutput(stderr);
  if (!parsed) return null;
  const a: TrackAnalysis = { version: ANALYSIS_VERSION, mtime, analysisMs: Date.now() - t0, ...parsed };
  loadCache();
  cache.set(file, a);
  schedulePersist();
  const plan = planTrack(a);
  rtmpLog.event("debug", Event.trackAnalyzed, `Analizada: ${file.split("/").pop()} I=${a.integratedLufs} LUFS TP=${a.truePeakDbtp} dBTP → gain ${plan.gainDb} dB`, {
    file, integratedLufs: a.integratedLufs, truePeakDbtp: a.truePeakDbtp, gainDb: plan.gainDb,
    leadSilenceEndSec: a.leadSilenceEndSec, tailSilenceStartSec: a.tailSilenceStartSec, analysisMs: a.analysisMs,
  });
  return a;
}

export function analysisQueueStats() {
  return { cached: cache.size, pending: queue.length, running };
}
