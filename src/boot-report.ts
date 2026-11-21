import fs from "fs";
import path from "path";
import { config } from "./config";
import { FORMAT_CONFIG, isCodecAvailable, type StreamFormat } from "./format-config";
import { sysLog } from "./logger";
import { Event } from "./events";

// =============================================================
// Boot report — volcado de configuración y capacidades al arrancar
// -------------------------------------------------------------
// Todo lo que un agente/LLM necesita saber para operar la radio:
// valores resueltos, de dónde vienen, binarios/libs, códecs, puertos,
// carpeta fallback y logging. Se emite como evento "config.loaded".
// =============================================================

const AUDIO_EXT = /\.(mp3|flac|wav|m4a|aac|ogg|opus)$/i;

function mask(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function readVersion(): string | null {
  try {
    const pkgPath = path.resolve(process.cwd(), "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      return pkg.version ?? null;
    }
  } catch {}
  return null;
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function countAudioFiles(dir: string): { exists: boolean; isDir: boolean; files: number } {
  if (!dir) return { exists: false, isDir: false, files: 0 };
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return { exists: true, isDir: false, files: 1 };
    let files = 0;
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (AUDIO_EXT.test(entry.name)) files++;
      }
    };
    walk(dir);
    return { exists: true, isDir: true, files };
  } catch {
    return { exists: false, isDir: false, files: 0 };
  }
}

export interface BootReport {
  version: string | null;
  runtime: { bun: string; platform: string; arch: string; pid: number };
  ports: { dashboard: number; output: number; srt: number; rtmp: number };
  logging: { level: string; format: string };
  stream: {
    format: string;
    mp3BitrateKbps: number;
    opusTierEnabled: boolean;
    opusBitrateKbps: number;
    lowLatency: boolean;
    crossfadeSeconds: number;
    crossfadeLiveSeconds: number;
    maxListeners: number;
    preBufferBytes: number;
  };
  native: { useNativeLame: string; useNativeDecode: string };
  security: { adminUser: string; adminPasswordSet: boolean; streamKey: string | null; corsOrigin: string };
  fallback: { source: string; exists: boolean; isDir: boolean; audioFiles: number };
  dependencies: {
    ffmpeg: string | null;
    libs: Record<string, boolean>;
    codecs: Record<string, boolean>;
  };
}

export function buildBootReport(): BootReport {
  const codecs: Record<string, boolean> = {};
  for (const fmt of Object.keys(FORMAT_CONFIG) as StreamFormat[]) {
    codecs[fmt] = isCodecAvailable(fmt);
  }

  const fallback = countAudioFiles(config.fallbackSource);

  return {
    version: readVersion(),
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    },
    ports: {
      dashboard: config.dashboardPort,
      output: config.outputPort,
      srt: config.srtPort,
      rtmp: config.rtmpPort,
    },
    logging: { level: config.logLevel, format: config.logFormat },
    stream: {
      format: config.streamFormat,
      mp3BitrateKbps: config.fallbackBitrateKbps,
      opusTierEnabled: config.opusTierEnabled,
      opusBitrateKbps: config.opusTierBitrateKbps,
      lowLatency: config.lowLatency,
      crossfadeSeconds: config.crossfadeSeconds,
      crossfadeLiveSeconds: config.crossfadeLiveSeconds,
      maxListeners: config.maxListeners,
      preBufferBytes: config.preBufferBytes,
    },
    native: {
      useNativeLame: config.useNativeLame,
      useNativeDecode: config.useNativeDecode,
    },
    security: {
      adminUser: config.adminUser,
      adminPasswordSet: !!config.adminPassword,
      streamKey: mask(config.rtmpStreamKey),
      corsOrigin: config.corsOrigin,
    },
    fallback: {
      source: config.fallbackSource || "(vacío → live-only)",
      exists: fallback.exists,
      isDir: fallback.isDir,
      audioFiles: fallback.files,
    },
    dependencies: {
      ffmpeg: Bun.which("ffmpeg"),
      libs: {
        libmp3lame: exists("/usr/lib/libmp3lame.so.0"),
        libopus: exists("/usr/lib/libopus.so.0"),
        libogg: exists("/usr/lib/libogg.so.0"),
        libavformat: exists("/usr/lib/libavformat.so.60") || exists("/usr/lib/libavformat.so"),
        libavcodec: exists("/usr/lib/libavcodec.so.60") || exists("/usr/lib/libavcodec.so"),
        libswresample: exists("/usr/lib/libswresample.so.4") || exists("/usr/lib/libswresample.so"),
      },
      codecs,
    },
  };
}

export function logBootReport(): BootReport {
  const report = buildBootReport();
  sysLog.ok(Event.configLoaded, "Configuración cargada", report);
  return report;
}

export function logReady(ports: { dashboard: number; output: number; srt: number; streamKey: string | null }): void {
  sysLog.ok(Event.serverReady, "Servidor listo", {
    pid: process.pid,
    ports: { dashboard: ports.dashboard, output: ports.output, srt: ports.srt },
    dashboard: `http://localhost:${ports.dashboard}/`,
    streams: {
      mp3: `http://localhost:${ports.output}/mp3`,
      opus: `http://localhost:${ports.output}/opus`,
    },
    srt: `srt://0.0.0.0:${ports.srt}?streamid=live/${mask(ports.streamKey) ?? "??"}`,
  });
}
