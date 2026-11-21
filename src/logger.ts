import fs from "fs";
import { hintFor } from "./events";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "text" | "json";

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Se lee el entorno directamente (no config) para evitar ciclos de inicialización:
// format-config puede loguear durante loadConfig() antes de que config exista.
function currentLevel(): LogLevel {
  const v = process.env.LOG_LEVEL as LogLevel | undefined;
  return v && v in LOG_LEVELS ? v : "info";
}

function currentFormat(): LogFormat {
  return process.env.LOG_FORMAT === "json" ? "json" : "text";
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  /** Evento estructurado con nombre estable (p. ej. "encoder.opus.started"). */
  event: (level: LogLevel, event: string, msg: string, data?: Record<string, unknown>) => void;
  /** Atajo info + event. */
  ok: (event: string, msg: string, data?: Record<string, unknown>) => void;
  /** Error con código accionable + hint del catálogo. */
  fail: (code: string, msg: string, data?: Record<string, unknown>) => void;
}

function ts(): string {
  return new Date().toISOString();
}

// =============================================================
// Escritura a archivo (batching async para no bloquear el event loop)
// =============================================================

let logQueue: string[] = [];
let isFlushing = false;
const MAX_BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 100;

function flushLogsAsync() {
  if (isFlushing || logQueue.length === 0) return;
  isFlushing = true;
  const batch = logQueue.splice(0, logQueue.length);
  const text = batch.join("");

  Promise.all([
    fs.promises.appendFile("opus-debug.log", text).catch(() => {}),
    fs.promises.appendFile("bunradio.log", text).catch(() => {}),
  ]).finally(() => {
    isFlushing = false;
    if (logQueue.length >= MAX_BATCH_SIZE) {
      flushLogsAsync();
    }
  });
}

const flushTimer = setInterval(flushLogsAsync, FLUSH_INTERVAL_MS);
if (typeof flushTimer.unref === "function") flushTimer.unref();

export function flushLogsSync() {
  if (logQueue.length === 0) return;
  const batch = logQueue.splice(0, logQueue.length);
  const text = batch.join("");
  try {
    fs.appendFileSync("opus-debug.log", text);
    fs.appendFileSync("bunradio.log", text);
  } catch {}
}

process.on("beforeExit", flushLogsSync);
process.on("exit", flushLogsSync);

function pushFileLine(line: string) {
  logQueue.push(line.endsWith("\n") ? line : line + "\n");
  if (logQueue.length >= MAX_BATCH_SIZE) flushLogsAsync();
}

// =============================================================
// Formateo (text legible / json machine-readable)
// =============================================================

function stringify(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

interface LogRecord {
  level: LogLevel;
  scope: string;
  event?: string;
  msg: string;
  data?: Record<string, unknown>;
  code?: string;
  hint?: string;
}

function formatText(r: LogRecord): string {
  const level = r.level.toUpperCase().padEnd(5);
  const ev = r.event ? ` (${r.event})` : "";
  const code = r.code ? ` [${r.code}]` : "";
  const data = r.data && Object.keys(r.data).length > 0 ? ` ${JSON.stringify(r.data)}` : "";
  const hint = r.hint ? `\n        hint: ${r.hint}` : "";
  return `${level} [${r.scope}]${ev}${code} ${r.msg}${data}${hint}`;
}

function formatJson(r: LogRecord): string {
  const obj: Record<string, unknown> = {
    ts: ts(),
    level: r.level.toUpperCase(),
    scope: r.scope,
    ...(r.event ? { event: r.event } : {}),
    msg: r.msg,
    ...(r.code ? { code: r.code } : {}),
    ...(r.hint ? { hint: r.hint } : {}),
    ...(r.data && Object.keys(r.data).length > 0 ? { data: r.data } : {}),
  };
  return JSON.stringify(obj);
}

function makeLogger(scope: string): Logger {
  const enabled = (level: LogLevel) => LOG_LEVELS[level] >= LOG_LEVELS[currentLevel()];
  const isTui = () => process.env.BUNRADIO_TUI === "1";

  const write = (r: LogRecord) => {
    if (!enabled(r.level)) return;
    const json = currentFormat() === "json";
    const human = formatText(r);
    if (!isTui()) {
      if (json) {
        const line = formatJson(r);
        if (r.level === "error") console.error(line);
        else if (r.level === "warn") console.warn(line);
        else if (r.level === "debug") console.debug(line);
        else console.log(line);
      } else {
        if (r.level === "error") console.error(human);
        else if (r.level === "warn") console.warn(human);
        else if (r.level === "debug") console.debug(human);
        else console.log(human);
      }
    }
    // Archivo: JSON si el formato es json; si no, texto con timestamp (compat)
    pushFileLine(json ? formatJson(r) : `[${ts()}] ${human}`);
  };

  const legacy = (level: LogLevel) => (...args: unknown[]) =>
    write({ level, scope, msg: args.map(stringify).join(" ") });

  return {
    debug: legacy("debug"),
    info: legacy("info"),
    warn: legacy("warn"),
    error: legacy("error"),
    event: (level, event, msg, data) => write({ level, scope, event, msg, data }),
    ok: (event, msg, data) => write({ level: "info", scope, event, msg, data }),
    fail: (code, msg, data) => write({ level: "error", scope, event: "error", msg, code, hint: hintFor(code), data }),
  };
}

export const rtmpLog = makeLogger("RTMP");
export const httpLog = makeLogger("HTTP");
export const sysLog = makeLogger("SYS");
