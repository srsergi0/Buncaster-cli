#!/usr/bin/env bun
// =============================================================
// Radio Server — Ingesta RTMP + Streaming HTTP + Fallback
// -------------------------------------------------------------
// Coordinador principal del servidor.
// =============================================================

import { config } from "./config";
import { sysLog, httpLog } from "./logger";
import { state } from "./state";
import { startFallback, stopFallback, stopMasterEncoder, stopPlaylistWatcher, runRtmpListener } from "./audio-router";
import "./http-server"; // Levanta el servidor HTTP automáticamente al importar

// =============================================================
// 1. INICIALIZACIÓN DE FUENTES
// =============================================================

// Imprimir instrucciones de conexión en la consola
console.log("");
console.log("  ╔══════════════════════════════════════════════════╗");
console.log("  ║           🎙️  B U N R A D I O                  ║");
console.log("  ║          Tu radio está lista.                   ║");
console.log("  ╚══════════════════════════════════════════════════╝");
console.log("");
console.log("  ▸ STREAM (Escuchar):");
console.log(`    http://localhost:${config.httpPort}/stream`);
console.log("");
console.log("");
console.log("  ▸ ENVIAR DESDE OBS STUDIO:");
console.log("    Servicio:   Custom");
console.log(`    Servidor:   rtmp://localhost:${config.rtmpPort}/live`);
console.log(`    Stream Key: ${config.rtmpStreamKey}`);
console.log("");
if (config.fallbackSource) {
  console.log(`  ▸ MÚSICA: ${config.fallbackSource}`);
} else {
  console.log("  ▸ MÚSICA: No detectada. Coloca una carpeta 'musica' o 'music' junto al binario.");
}
console.log("");

// Arrancar audio de respaldo (fallback) inmediatamente
startFallback();

// Arrancar el receptor de OBS en segundo plano
runRtmpListener();

// =============================================================
// 2. APAGADO ORDENADO
// =============================================================

function shutdown(signal: string): void {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  sysLog.info(`Señal ${signal} recibida, cerrando servidor...`);

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
  stopMasterEncoder();

  if (state.sourceProcess) {
    sysLog.info("Deteniendo receptor RTMP...");
    try {
      state.sourceProcess.kill();
    } catch {
      /* noop */
    }
  }

  sysLog.info("Servidor cerrado correctamente.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  sysLog.error("Excepción no capturada:", err);
});

process.on("unhandledRejection", (reason) => {
  sysLog.error("Promesa rechazada sin manejar:", reason);
});
