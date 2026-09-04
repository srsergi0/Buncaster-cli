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
  httpLog.info(`Listener ${id} disconnected (${reason}). Active: ${state.clients.size}`);
}

function getCurrentTitle(): string {
  return state.currentTrack
    ? `${state.currentTrack.artist} - ${state.currentTrack.title}`
    : "";
}

export function broadcast(chunk: Uint8Array): void {
  preBuffer.push(chunk);

  for (const [id, client] of state.clients) {
    if (client.tier !== "mp3") continue;
    try {
      if (client.icy) {
        const pieces = chunkWithIcy(chunk, client.icy, getCurrentTitle());
        for (const piece of pieces) {
          client.controller.enqueue(piece);
        }
      } else {
        client.controller.enqueue(chunk);
      }
    } catch (err) {
      evictClient(id, `fallo al enviar datos: ${(err as Error).message}`);
      continue;
    }

    client.bytesSent += chunk.byteLength;
    state.totalBytesSent += chunk.byteLength;

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
  preBufferOpus.push(chunk);

  for (const [id, client] of state.clients) {
    if (client.tier !== "opus") continue;
    try {
      // Opus via Ogg no usa icy
      client.controller.enqueue(chunk);
    } catch (err) {
      evictClient(id, `fallo al enviar datos (opus): ${(err as Error).message}`);
      continue;
    }

    client.bytesSent += chunk.byteLength;
    state.totalBytesSentOpus += chunk.byteLength;

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
