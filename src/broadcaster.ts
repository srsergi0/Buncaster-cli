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

  httpLog.info(`Listener ${id} disconnected (${reason}). Active: ${state.clients.size} (mp3:${state.listenersMp3}, opus:${state.listenersOpus})`);
}

function getCurrentTitle(): string {
  return state.currentTrack
    ? `${state.currentTrack.artist} - ${state.currentTrack.title}`
    : "";
}

export function broadcast(chunk: Uint8Array): void {
  if (chunk.byteLength === 0) return;

  // Copia inmutable única al publicar (copy-on-publish)
  // Aísla la memoria de trabajo de LAME FFI y el ring buffer
  const data = new Uint8Array(chunk);
  preBuffer.push(data);

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

  // Copia inmutable única al publicar para la rendition Opus
  const data = new Uint8Array(chunk);
  preBufferOpus.push(data);

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

