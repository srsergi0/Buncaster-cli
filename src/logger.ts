import { config } from "./config";
import type { LogLevel } from "./config";

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function ts(): string {
  return new Date().toISOString();
}

function appendFileLog(scope: string, level: string, args: unknown[]) {
  try {
    const line = `[${ts()}] ${level} [${scope}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`;
    // No reinicia terminal -- escribe a archivo persistente
    require("fs").appendFileSync("opus-debug.log", line);
    require("fs").appendFileSync("bunradio.log", line);
  } catch {}
}

function makeLogger(scope: string) {
  const enabled = (level: LogLevel) => LOG_LEVELS[level] >= LOG_LEVELS[config.logLevel];
  return {
    debug: (...args: unknown[]) => {
      if (!enabled("debug")) return;
      console.debug(`[${ts()}] DEBUG [${scope}]`, ...args);
      appendFileLog(scope, "DEBUG", args);
    },
    info: (...args: unknown[]) => {
      if (!enabled("info")) return;
      console.log(`[${ts()}] INFO  [${scope}]`, ...args);
      appendFileLog(scope, "INFO", args);
    },
    warn: (...args: unknown[]) => {
      if (!enabled("warn")) return;
      console.warn(`[${ts()}] WARN  [${scope}]`, ...args);
      appendFileLog(scope, "WARN", args);
    },
    error: (...args: unknown[]) => {
      if (!enabled("error")) return;
      console.error(`[${ts()}] ERROR [${scope}]`, ...args);
      appendFileLog(scope, "ERROR", args);
    },
  };
}

export const rtmpLog = makeLogger("RTMP");
export const httpLog = makeLogger("HTTP");
export const sysLog = makeLogger("SYS");
