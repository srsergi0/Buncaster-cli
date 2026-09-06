import { config } from "./config";
import type { LogLevel } from "./config";

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function ts(): string {
  return new Date().toISOString();
}

import fs from "fs";

let logQueue: string[] = [];
let isFlushing = false;
const MAX_BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 100;

function flushLogsAsync() {
  if (isFlushing || logQueue.length === 0) return;
  isFlushing = true;
  const batch = logQueue.splice(0, logQueue.length);
  const text = batch.join("");

  // Escribir asíncronamente en ambos archivos
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

// Timer en segundo plano para vaciar logs periódicamente sin bloquear event loop
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

function appendFileLog(scope: string, level: string, args: unknown[]) {
  const line = `[${ts()}] ${level} [${scope}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`;
  logQueue.push(line);
  if (logQueue.length >= MAX_BATCH_SIZE) {
    flushLogsAsync();
  }
}

function makeLogger(scope: string) {
  const enabled = (level: LogLevel) => LOG_LEVELS[level] >= LOG_LEVELS[config.logLevel];
  const isTui = () => process.env.BUNRADIO_TUI === "1";
  return {
    debug: (...args: unknown[]) => {
      if (!enabled("debug")) return;
      if (!isTui()) console.debug(`DEBUG [${scope}]`, ...args);
      appendFileLog(scope, "DEBUG", args);
    },
    info: (...args: unknown[]) => {
      if (!enabled("info")) return;
      if (!isTui()) console.log(`INFO  [${scope}]`, ...args);
      appendFileLog(scope, "INFO", args);
    },
    warn: (...args: unknown[]) => {
      if (!enabled("warn")) return;
      if (!isTui()) console.warn(`WARN  [${scope}]`, ...args);
      appendFileLog(scope, "WARN", args);
    },
    error: (...args: unknown[]) => {
      if (!enabled("error")) return;
      if (!isTui()) console.error(`ERROR [${scope}]`, ...args);
      appendFileLog(scope, "ERROR", args);
    },
  };
}

export const rtmpLog = makeLogger("RTMP");
export const httpLog = makeLogger("HTTP");
export const sysLog = makeLogger("SYS");
