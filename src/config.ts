import crypto from "crypto";
import { type StreamFormat, validateFormat } from "./format-config";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  httpPort: number;
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
  const httpPort = envInt("PORT", 8080);
  const rtmpPort = envInt("RTMP_PORT", findFreePort(1935, [httpPort]));
  const srtPort = envInt("SRT_PORT", findFreePort(1936, [httpPort, rtmpPort]));
  const host = process.env.HOST || "0.0.0.0";

  if (httpPort === rtmpPort || httpPort === srtPort || rtmpPort === srtPort) {
    throw new Error("PORT, RTMP_PORT y SRT_PORT deben ser distintos");
  }

  const lowLatency = envBool("LOW_LATENCY", true);
  const cfg: Config = {
    httpPort,
    rtmpPort,
    srtPort,
    host,
    maxListeners: envInt("MAX_LISTENERS", 500),
    preBufferBytes: envInt("PREBUFFER_BYTES", lowLatency ? 8192 : 65536),
    corsOrigin: process.env.CORS_ORIGIN || "*",
    logLevel: (process.env.LOG_LEVEL as LogLevel) || "info",
    fallbackBitrateKbps: envInt("STREAM_BITRATE_KBPS", 320),
    fallbackSource: process.env.FALLBACK_SOURCE || process.cwd(),
    audioProcessing: envBool("AUDIO_PROCESSING", false),
    crossfadeSeconds: envInt("CROSSFADE_SECONDS", lowLatency ? 1 : 2),
    crossfadeLiveSeconds: envInt("CROSSFADE_LIVE_SECONDS", lowLatency ? 0.2 : 2),
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
  };

  return cfg;
}

export const config = loadConfig();
