#!/usr/bin/env bun
// =============================================================
// Radio Server — Ingesta RTMP + Streaming HTTP + Fallback
// -------------------------------------------------------------
// Coordinador principal del servidor.
// =============================================================

import { config } from "./config";
import { sysLog, httpLog } from "./logger";
import { state } from "./state";
import { startFallback, stopFallback, stopMasterEncoder, stopPlaylistWatcher, runSrtListener, stopSilence } from "./audio-router";
import "./http-server"; // Levanta el servidor HTTP automáticamente al importar

// =============================================================
// 1. INICIALIZACIÓN DE FUENTES
// =============================================================

// Imprimir instrucciones de conexión en la consola
console.log("");
console.log("  ╔══════════════════════════════════════════════════╗");
console.log("  ║           🎙️  B U N R A D I O                  ║");
console.log("  ║          Your radio is ready.                   ║");
console.log("  ╚══════════════════════════════════════════════════╝");
console.log("");
console.log("  ▸ STREAM (Listen):");
console.log(`    http://localhost:${config.httpPort}/mp3`);
console.log(`    http://localhost:${config.httpPort}/stream  (alias)`);
console.log("");
console.log(`  ▸ STREAM Opus (eco 96k):`);
console.log(`    http://localhost:${config.httpPort}/opus`);
console.log(`    http://localhost:${config.httpPort}/stream?format=opus  (alias)`);
console.log("");
console.log("  ▸ SEND FROM OBS STUDIO (SRT - no plan B):");
console.log("    Service:   Custom");
console.log(`    Server:   srt://localhost:${config.srtPort}?streamid=live/${config.rtmpStreamKey}`);
console.log(`    Stream Key: ${config.rtmpStreamKey} (in streamid)`);
console.log("");
if (config.fallbackSource) {
  console.log(`  ▸ MUSIC: ${config.fallbackSource}`);
  if (config.fallbackSource.trim() === "") console.log("    (live-only mode: silence until live)");
} else {
  console.log("  ▸ MUSIC: Not configured (FALLBACK_SOURCE=\"\" => live-only, silence until live)");
}
console.log("");

// Arrancar audio de respaldo (fallback) inmediatamente
startFallback();

// Arrancar receptor SRT en segundo plano (sin RTMP, sin plan B)
runSrtListener();

// =============================================================
// 2. APAGADO ORDENADO
// =============================================================

function shutdown(signal: string): void {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  sysLog.info(`Signal ${signal} received, shutting down server...`);

  // Detener todos los oyentes de forma limpia
  for (const [, client] of state.clients) {
    try {
      client.controller.close();
    } catch {
      /* noop */
    }
  }
  state.clients.clear();

  // Matar subprocesos de FFmpeg activos
  stopPlaylistWatcher();
  stopFallback();
  stopSilence();
  stopMasterEncoder();

  if (state.sourceProcess) {
    sysLog.info("Stopping SRT receiver...");
    try {
      state.sourceProcess.kill();
    } catch {
      /* noop */
    }
  }

  sysLog.info("Server closed correctly.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  sysLog.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  sysLog.error("Unhandled promise rejection:", reason);
});
