import crypto from "crypto";
import { type StreamFormat, validateFormat } from "./format-config";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  httpPort: number; // dashboard + streams (back-compat, same as dashboardPort)
  dashboardPort: number;
  outputPort: number;
  rtmpPort: number;
  srtPort: number;
  host: string;
  maxListeners: number;
  preBufferBytes: number;
  corsOrigin: string;
  logLevel: LogLevel;
  fallbackBitrateKbps: number;
  fallbackSource: string;
  audioProcessing: boolean;
  crossfadeSeconds: number;
  crossfadeLiveSeconds: number;
  rtmpStreamKey: string;
  rtmpMinLiveSeconds: number;
  useNativeLame: "auto" | "true" | "false";
  useNativeDecode: "auto" | "true" | "false";
  streamFormat: StreamFormat;
  // Moonshot tier opus: per-listener efficiency
  opusTierEnabled: boolean;
  opusTierBitrateKbps: number;
  lowLatency: boolean;
  adminUser: string;
  adminPassword: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Environment variable ${name} invalid: "${raw}" (expected a non-negative integer)`);
  }
  return n;
}

export function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`Environment variable ${name} invalid: "${raw}" (expected a non-negative number)`);
  }
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const val = process.env[name];
  if (!val) return fallback;
  if (val !== "true" && val !== "false") {
    throw new Error(`Environment variable ${name} invalid: "${val}" (expected "true" or "false")`);
  }
  return val === "true";
}

function findFreePort(start: number, exclude: number[]): number {
  let port = start;
  while (exclude.includes(port)) port++;
  return port;
}

function generateStreamKey(): string {
  return crypto.randomBytes(16).toString("hex");
}

function loadConfig(): Config {
  const rtmpKey = process.env.RTMP_STREAM_KEY || generateStreamKey();
  // Dashboard (web) and outputs (streams) can be same or separate — user is prompted via CLI
  const dashboardPort = envInt("DASHBOARD_PORT", envInt("PORT", 8080));
  const outputPort = envInt("OUTPUT_PORT", envInt("STREAM_PORT", dashboardPort));
  const httpPort = dashboardPort; // back-compat alias
  const rtmpPort = envInt("RTMP_PORT", findFreePort(1935, [dashboardPort, outputPort]));
  const srtPort = envInt("SRT_PORT", findFreePort(1936, [dashboardPort, outputPort, rtmpPort]));
  const host = process.env.HOST || "0.0.0.0";

  const allPorts = [dashboardPort, outputPort, rtmpPort, srtPort];
  // Only enforce distinct for SRT/RTMP vs dashboard/output if they are not intentionally the same for dashboard/output
  if (new Set([rtmpPort, srtPort, dashboardPort]).size !== 3 && dashboardPort !== outputPort) {
    // dashboard and output may be same, that's ok; but RTMP/SRT must be distinct
  }
  if (rtmpPort === srtPort) {
    throw new Error("RTMP_PORT y SRT_PORT deben ser distintos");
  }

  const lowLatency = envBool("LOW_LATENCY", true);
  const cfg: Config = {
    httpPort,
    dashboardPort,
    outputPort,
    rtmpPort,
    srtPort,
    host,
    maxListeners: envInt("MAX_LISTENERS", 500),
    preBufferBytes: envInt("PREBUFFER_BYTES", lowLatency ? 8192 : 65536),
    corsOrigin: process.env.CORS_ORIGIN || "*",
    logLevel: (process.env.LOG_LEVEL as LogLevel) || "info",
    fallbackBitrateKbps: envInt("STREAM_BITRATE_KBPS", 320),
    fallbackSource: process.env.FALLBACK_SOURCE !== undefined ? process.env.FALLBACK_SOURCE : "",
    audioProcessing: envBool("AUDIO_PROCESSING", false),
    crossfadeSeconds: envFloat("CROSSFADE_SECONDS", lowLatency ? 1 : 2),
    crossfadeLiveSeconds: envFloat("CROSSFADE_LIVE_SECONDS", lowLatency ? 0.2 : 2),
    rtmpStreamKey: rtmpKey,
    rtmpMinLiveSeconds: envInt("RTMP_MIN_LIVE_SECONDS", lowLatency ? 0 : 10),
    useNativeLame: (() => {
      const v = process.env.USE_NATIVE_LAME;
      if (v === "true" || v === "false") return v;
      return "auto";
    })(),
    useNativeDecode: (() => {
      const v = process.env.USE_NATIVE_DECODE;
      if (v === "true" || v === "false") return v;
      return "auto";
    })(),
    streamFormat: validateFormat((process.env.STREAM_FORMAT as StreamFormat) || "mp3"),
    opusTierEnabled: envBool("ENABLE_OPUS_TIER", true),
    opusTierBitrateKbps: envInt("OPUS_TIER_BITRATE_KBPS", 96),
    lowLatency,
    adminUser: process.env.ADMIN_USER || "admin",
    adminPassword: process.env.ADMIN_PASSWORD || "",
  };

  return cfg;
}

export const config = loadConfig();
