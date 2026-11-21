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
import { logBootReport, logReady } from "./boot-report";
import { Event } from "./events";
import "./http-server"; // Levanta el servidor HTTP automáticamente al importar

// =============================================================
// 1. INICIALIZACIÓN DE FUENTES
// =============================================================

// Reporte de arranque: config resuelta + capacidades (para agentes/LLM)
logBootReport();

// Arrancar audio de respaldo (fallback) inmediatamente
startFallback();

// Arrancar receptor SRT en segundo plano (sin RTMP, sin plan B)
runSrtListener();

// Anunciar que el servidor está listo y accesible
logReady({
  dashboard: config.dashboardPort,
  output: config.outputPort,
  srt: config.srtPort,
  streamKey: config.rtmpStreamKey,
});

// =============================================================
// 2. APAGADO ORDENADO
// =============================================================

function shutdown(signal: string): void {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  sysLog.ok(Event.serverShutdown, `Señal ${signal} recibida, apagando servidor...`, { signal });

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

  sysLog.ok(Event.serverShutdown, "Servidor cerrado correctamente");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  sysLog.fail("E_UNKNOWN", "Excepción no capturada", { error: err instanceof Error ? err.stack : String(err) });
});

process.on("unhandledRejection", (reason) => {
  sysLog.fail("E_UNKNOWN", "Promesa rechazada sin manejar", { reason: reason instanceof Error ? reason.stack : String(reason) });
});
