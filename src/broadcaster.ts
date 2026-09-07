import { state } from "./state";
import { preBuffer, preBufferOpus } from "./pre-buffer";
import { httpLog } from "./logger";
import { chunkWithIcy } from "./icy-metadata";

const MAX_SLOW_STRIKES = 5;

export function evictClient(id: string, reason: string): void {
  const client = state.clients.get(id);
  if (!client) return;

  try {
    client.controller.close();
  } catch {
    /* noop */
  }

  state.clients.delete(id);
  state.mp3Clients.delete(id);
  state.opusClients.delete(id);
  state.listenersMp3 = state.mp3Clients.size;
  state.listenersOpus = state.opusClients.size;

  if (reason.includes("saturated") || reason.includes("backpressure")) {
    state.evictionsTotal.backpressure++;
  } else if (reason.includes("timeout")) {
    state.evictionsTotal.timeout++;
  } else {
    state.evictionsTotal.slowClient++;
  }

  httpLog.info(`Listener ${id} disconnected (${reason}). Active: ${state.clients.size} (mp3:${state.listenersMp3}, opus:${state.listenersOpus})`);
}

export interface NowPlayingInfo {
  type: "live" | "fallback" | "silence";
  isLive: boolean;
  display: string;
  title: string;
  artist: string;
  file: string | null;
  duration: number;
  elapsed: number;
  remaining: number;
  progress: number;
  startedAt: number | null;
}

export function getNowPlayingInfo(): NowPlayingInfo {
  if (state.isBroadcasting) {
    const elapsed = state.lastSourceAudioTimeMs > 0 ? Math.round((Date.now() - state.lastSourceAudioTimeMs) / 1000) : 0;
    return {
      type: "live",
      isLive: true,
      display: "LIVE - Transmisión en Vivo",
      title: "Transmisión en Vivo",
      artist: "OBS Studio",
      file: null,
      duration: 0,
      elapsed,
      remaining: 0,
      progress: 1.0,
      startedAt: state.lastSourceAudioTimeMs || Date.now(),
    };
  }

  const track = state.currentTrack;
  if (!track) {
    return {
      type: "silence",
      isLive: false,
      display: "Silencio (esperando transmisión o música)",
      title: "Silencio",
      artist: "BunRadio",
      file: null,
      duration: 0,
      elapsed: 0,
      remaining: 0,
      progress: 0,
      startedAt: null,
    };
  }

  const now = Date.now();
  const elapsed = Math.max(0, (now - track.startedAt) / 1000);
  const duration = track.duration || 0;
  const remaining = duration > 0 ? Math.max(0, duration - elapsed) : 0;
  const progress = duration > 0 ? Math.min(1.0, elapsed / duration) : 0;

  const artist = (track.artist || "").trim();
  const title = (track.title || "").trim();
  const display = (artist && title && artist !== "Artista Desconocido" && artist !== "Unknown Artist")
    ? `${artist} - ${title}`
    : (title || artist || "Pista Desconocida");

  return {
    type: "fallback",
    isLive: false,
    display,
    title: title || display,
    artist: (artist && artist !== "Artista Desconocido") ? artist : "",
    file: track.file,
    duration: Math.round(duration * 10) / 10,
    elapsed: Math.round(elapsed * 10) / 10,
    remaining: Math.round(remaining * 10) / 10,
    progress: Math.round(progress * 1000) / 1000,
    startedAt: track.startedAt,
  };
}

export function getCurrentTitle(): string {
  const info = getNowPlayingInfo();
  if (info.type === "silence") return "";
  return info.display;
}

export function broadcast(chunk: Uint8Array): void {
  if (chunk.byteLength === 0) return;

  // Una sola copia inmutable administrada por el RingBuffer al publicar
  const slot = preBuffer.push(chunk);
  const data = slot ? slot.data : new Uint8Array(chunk);

  if (state.mp3Clients.size === 0) return;

  // Evaluar título una sola vez por chunk, no en cada cliente
  const currentTitle = getCurrentTitle();

  for (const [id, client] of state.mp3Clients) {
    try {
      if (client.icy) {
        const pieces = chunkWithIcy(data, client.icy, currentTitle);
        for (const piece of pieces) {
          client.controller.enqueue(piece);
        }
      } else {
        client.controller.enqueue(data);
      }
    } catch (err) {
      evictClient(id, `fallo al enviar datos: ${(err as Error).message}`);
      continue;
    }

    client.bytesSent += data.byteLength;
    state.totalBytesSent += data.byteLength;

    // Contrapresión calculada en bytes reales (ByteLengthQueuingStrategy)
    const desiredSize = client.controller.desiredSize;
    if (desiredSize !== null && desiredSize < 0) {
      client.slowStrikes++;
      if (client.slowStrikes >= MAX_SLOW_STRIKES) {
        evictClient(id, "cannot keep up with stream (buffer saturated)");
      }
    } else {
      client.slowStrikes = 0;
    }
  }
}

export function broadcastOpus(chunk: Uint8Array): void {
  if (chunk.byteLength === 0) return;

  // Una sola copia inmutable administrada por el RingBuffer al publicar
  const slot = preBufferOpus.push(chunk);
  const data = slot ? slot.data : new Uint8Array(chunk);

  if (state.opusClients.size === 0) return;

  for (const [id, client] of state.opusClients) {
    try {
      client.controller.enqueue(data);
    } catch (err) {
      evictClient(id, `fallo al enviar datos (opus): ${(err as Error).message}`);
      continue;
    }

    client.bytesSent += data.byteLength;
    state.totalBytesSentOpus += data.byteLength;

    // Contrapresión calculada en bytes reales
    const desiredSize = client.controller.desiredSize;
    if (desiredSize !== null && desiredSize < 0) {
      client.slowStrikes++;
      if (client.slowStrikes >= MAX_SLOW_STRIKES) {
        evictClient(id, "cannot keep up with stream opus (buffer saturated)");
      }
    } else {
      client.slowStrikes = 0;
    }
  }
}

