// =============================================================
// Catálogo de eventos y códigos de error
// -------------------------------------------------------------
// Los nombres de evento son estables (machine-readable) para que un
// agente/LLM pueda monitorizar el arranque y el estado sin leer código.
// Formato: "<dominio>.<sujeto>.<accion>" en minúsculas.
// =============================================================

export const Event = {
  configLoaded: "config.loaded",
  serverReady: "server.ready",
  serverShutdown: "server.shutdown",
  serverPortBusy: "server.port_busy",

  fallbackScan: "fallback.scan",
  fallbackStarted: "fallback.started",
  fallbackStopped: "fallback.stopped",
  fallbackSilence: "fallback.silence",
  fallbackReshuffle: "fallback.reshuffle",

  trackStarted: "deck.track.started",
  trackEnded: "deck.track.ended",
  crossfadeStarted: "deck.crossfade.started",
  trackAnalyzed: "deck.track.analyzed",
  fallbackStalled: "fallback.stalled",

  encoderMasterStarted: "encoder.master.started",
  encoderMasterStopped: "encoder.master.stopped",
  encoderMasterCrashed: "encoder.master.crashed",
  encoderOpusStarted: "encoder.opus.started",
  encoderOpusStopped: "encoder.opus.stopped",
  encoderOpusCrashed: "encoder.opus.crashed",
  encoderOpusRestart: "encoder.opus.restart",
  encoderOpusStalled: "encoder.opus.stalled",

  sourceConnected: "source.connected",
  sourceDisconnected: "source.disconnected",
  sourceListening: "source.listening",
  sourceStopped: "source.stopped",
  sourceCooldown: "source.cooldown",
  sourceAudioFrozen: "source.audio_frozen",

  listenerConnected: "listener.connected",
  listenerDisconnected: "listener.disconnected",

  nativeLameLoaded: "native.lame.loaded",
  nativeDecodeLoaded: "native.decode.loaded",
  nativeFallback: "native.fallback",

  // MoQ / WebTransport (docs/ENGINE-MOQ.md)
  moqStarted: "moq.started",
  moqDisabled: "moq.disabled",
  moqPublisher: "moq.publisher",
  moqEncode: "moq.encode",
  moqCertRotated: "moq.cert.rotated",
  moqCertError: "moq.cert.error",

  error: "error",
} as const;

export type EventName = (typeof Event)[keyof typeof Event];

export const ErrorCode = {
  ffmpegMissing: "E_FFMPEG_MISSING",
  ffmpegSpawn: "E_FFMPEG_SPAWN",
  codecMissing: "E_CODEC_MISSING",
  fallbackDir: "E_FALLBACK_DIR",
  deckDecode: "E_DECK_DECODE",
  portBusy: "E_PORT_BUSY",
  source: "E_SOURCE",
  server: "E_SERVER",
  encode: "E_ENCODE",
  decode: "E_DECODE",
  unknown: "E_UNKNOWN",
} as const;

export type ErrorCodeName = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ErrorHint: Record<string, string> = {
  [ErrorCode.ffmpegMissing]: "Instala ffmpeg (apk add ffmpeg) o revisa PATH.",
  [ErrorCode.ffmpegSpawn]: "ffmpeg no arrancó: revisa que exista, permisos y argumentos válidos.",
  [ErrorCode.codecMissing]: "El códec no está en 'ffmpeg -encoders'; usa STREAM_FORMAT=mp3 o instala el encoder.",
  [ErrorCode.fallbackDir]: "Crea la carpeta FALLBACK_SOURCE y añade audio, o usa FALLBACK_SOURCE='' (live-only).",
  [ErrorCode.deckDecode]: "Archivo corrupto o formato no soportado; revisa la ruta del track.",
  [ErrorCode.portBusy]: "Otro proceso usa el puerto; cambia PORT/OUTPUT_PORT/SRT_PORT.",
  [ErrorCode.source]: "Revisa la conexión SRT/RTMP del emisor (OBS) y el streamid.",
  [ErrorCode.server]: "Error interno del servidor; revisa el stack y los logs previos.",
  [ErrorCode.encode]: "Fallo del encoder nativo; revisa el estado/parámetros (se usa fallback ffmpeg cuando aplica).",
  [ErrorCode.decode]: "Fallo del decodificador nativo; revisa el archivo o usa decode vía ffmpeg.",
  [ErrorCode.unknown]: "Error no clasificado; revisa el mensaje y los logs previos.",
} as const;

export function hintFor(code: string): string | undefined {
  return ErrorHint[code];
}

/** Devuelve E_FFMPEG_MISSING si el error indica que falta un binario; si no, null. */
export function missingBinaryCode(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  return /not found in \$PATH|ENOENT|Executable not found|command not found/i.test(msg)
    ? ErrorCode.ffmpegMissing
    : null;
}
