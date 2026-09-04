import { config } from "./config";
import { state } from "./state";
import { preBuffer, preBufferOpus } from "./pre-buffer";
import { httpLog } from "./logger";
import {
  corsHeaders,
  checkStreamKey,
  unauthorized,
  getClientIp,
} from "./http-helpers";
import {
  deckA,
  deckB,
  activeDeck,
  transitionStarted,
  isStoppingFallback,
} from "./audio-router";

import { StreamableHttpTransport, InMemorySessionAdapter } from "mcp-lite";
import { mcpServer } from "./mcp-server";
import { FORMAT_CONFIG } from "./format-config";
import { type IcyClientState, createIcyState } from "./icy-metadata";

const mcpSessionAdapter = new InMemorySessionAdapter({ maxEventBufferSize: 100 });
const mcpTransport = new StreamableHttpTransport({
  sessionAdapter: mcpSessionAdapter,
});
const handleMcpRequest = mcpTransport.bind(mcpServer);

function generateClientId(): string {
  return crypto.randomUUID();
}

export const httpServer = Bun.serve({
  hostname: config.host,
  port: config.httpPort,
  idleTimeout: 0,

  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (path.startsWith("/mcp")) {
      if (!checkStreamKey(req)) return unauthorized();
      const response = await handleMcpRequest(req);
      // Expose CORS headers on response
      const headers = new Headers(response.headers);
      for (const [key, val] of Object.entries(corsHeaders())) {
        headers.set(key, val);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    // ---- Stream de audio (dual-tier mp3 + opus) ----
    if ((path === "/stream" || path === "/" || path === "/opus" || path === "/stream/opus") && (req.method === "GET" || req.method === "HEAD")) {
      if (state.clients.size >= config.maxListeners) {
        return new Response("Servidor al máximo de oyentes", { status: 503, headers: corsHeaders() });
      }

      const opusRequested = config.opusTierEnabled && (
        url.searchParams.get("format") === "opus" ||
        url.searchParams.get("tier") === "opus" ||
        path === "/opus" || path === "/stream/opus" ||
        (req.headers.get("accept") || "").includes("audio/ogg; codecs=opus")
      );
      const tier: "mp3" | "opus" = opusRequested ? "opus" : "mp3";
      const isOpus = tier === "opus";

      if (isOpus && !config.opusTierEnabled) {
        return new Response("Opus tier deshabilitado", { status: 404, headers: corsHeaders() });
      }

      const streamHeaders: Record<string, string> = {
        "Content-Type": isOpus ? FORMAT_CONFIG["opus"].mime : FORMAT_CONFIG[config.streamFormat].mime,
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        ...corsHeaders(),
      };

      // Icy solo para mp3
      const icyMetaRequested = !isOpus && req.headers.get("icy-metadata") === "1";
      let icyState: IcyClientState | undefined;

      if (icyMetaRequested) {
        icyState = createIcyState();
        streamHeaders["icy-metaint"] = String(icyState.metaInterval);
        streamHeaders["icy-name"] = "BunRadio";
        streamHeaders["icy-genre"] = "Various";
        streamHeaders["icy-br"] = String(config.fallbackBitrateKbps);
        streamHeaders["icy-url"] = "";
        streamHeaders["icy-pub"] = "0";
      }
      if (isOpus) {
        streamHeaders["icy-br"] = String(config.opusTierBitrateKbps);
      }

      if (req.method === "HEAD") {
        return new Response(null, { headers: streamHeaders });
      }

      const clientId = generateClientId();
      const ip = getClientIp(req, server);
      const userAgent = req.headers.get("user-agent") || "unknown";
      const chosenPreBuffer = isOpus ? preBufferOpus : preBuffer;

      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            for (const chunk of chosenPreBuffer.snapshot()) {
              try {
                controller.enqueue(chunk);
              } catch {
                /* noop */
              }
            }

            state.clients.set(clientId, {
              id: clientId,
              controller,
              connectedAt: new Date(),
              ip,
              userAgent,
              bytesSent: 0,
              slowStrikes: 0,
              icy: icyState,
              tier,
            });
            state.totalListenersServed++;
            const opusCount = [...state.clients.values()].filter(c=>c.tier==="opus").length;
            const mp3Count = state.clients.size - opusCount;
            httpLog.info(`Oyente conectado: ${clientId} tier=${tier} desde ${ip} (${state.clients.size} activos mp3:${mp3Count} opus:${opusCount})`);
          },
          cancel() {
            state.clients.delete(clientId);
            httpLog.info(`Oyente desconectado: ${clientId} tier=${tier} (${state.clients.size} activos)`);
          },
        },
        { highWaterMark: 256 * 1024 }
      );

      req.signal.addEventListener("abort", () => {
        state.clients.delete(clientId);
      });

      return new Response(stream, { headers: streamHeaders });
    }

    // ---- Salud ----
    if (path === "/health") {
      const uptimeSeconds = Math.floor((Date.now() - state.startTime.getTime()) / 1000);
      const mem = process.memoryUsage();
      const fallbackActive = !state.isBroadcasting && state.currentTrack !== null;
      const masterAlive = state.masterProcess !== null;
      const opusAlive = state.opusProcess !== null;
      const sourceAlive = state.sourceProcess !== null;
      const opusCount = [...state.clients.values()].filter(c=>c.tier==="opus").length;
      const mp3Count = state.clients.size - opusCount;

      const health = {
        status: "ok",
        uptime: uptimeSeconds,
        memory: {
          rss: Math.round(mem.rss / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          external: Math.round(mem.external / 1024 / 1024),
        },
        processes: {
          masterEncoder: masterAlive,
          opusTier: opusAlive,
          rtmpSource: sourceAlive,
        },
        broadcasting: state.isBroadcasting,
        sourceConnected: state.sourceConnected,
        fallback: {
          active: fallbackActive,
          paused: state.fallbackPaused,
          currentTrack: state.currentTrack?.title || null,
        },
        listeners: state.clients.size,
        listenersMp3: mp3Count,
        listenersOpus: opusCount,
        maxListeners: config.maxListeners,
        totalListenersServed: state.totalListenersServed,
        totalBytesReceived: state.totalBytesReceived,
        totalBytesSent: state.totalBytesSent,
        totalBytesSentOpus: state.totalBytesSentOpus,
        detectedBitrateKbps: state.detectedBitrateKbps,
        detectedSampleRate: state.detectedSampleRate,
        tiers: {
          mp3: { bitrate: config.fallbackBitrateKbps, mime: FORMAT_CONFIG[config.streamFormat].mime },
          opus: config.opusTierEnabled ? { bitrate: config.opusTierBitrateKbps, mime: FORMAT_CONFIG["opus"].mime } : null,
        },
      };

      return Response.json(health, { headers: corsHeaders() });
    }

    // ---- Estado Debug ----
    if (path === "/debug-state") {
      return Response.json({
        activeDeck,
        transitionStarted,
        isStoppingFallback,
        deckA: {
          hasProcess: deckA.process !== null,
          currentTrackFile: deckA.currentTrackFile,
          bufferLength: deckA.buffer.length,
        },
        deckB: {
          hasProcess: deckB.process !== null,
          currentTrackFile: deckB.currentTrackFile,
          bufferLength: deckB.buffer.length,
        },
      }, { headers: corsHeaders() });
    }

    // ---- Estado ----
    if (path === "/status") {
      const uptimeSeconds = Math.floor((Date.now() - state.startTime.getTime()) / 1000);
      const opusCount = [...state.clients.values()].filter(c=>c.tier==="opus").length;
      return Response.json(
        {
          broadcasting: state.isBroadcasting,
          sourceConnected: state.sourceConnected,
          listeners: state.clients.size,
          listenersMp3: state.clients.size - opusCount,
          listenersOpus: opusCount,
          maxListeners: config.maxListeners,
          totalListenersServed: state.totalListenersServed,
          totalBytesReceived: state.totalBytesReceived,
          totalBytesSent: state.totalBytesSent,
          totalBytesSentOpus: state.totalBytesSentOpus,
          uptimeSeconds,
          stationName: "BunRadio",
          detectedBitrateKbps: state.detectedBitrateKbps,
          detectedSampleRate: state.detectedSampleRate,
          fallbackBitrateKbps: config.fallbackBitrateKbps,
          opusTierBitrateKbps: config.opusTierBitrateKbps,
          opusTierEnabled: config.opusTierEnabled,
          fallbackActive: !state.isBroadcasting && state.currentTrack !== null,
        },
        { headers: corsHeaders() }
      );
    }

    // ---- Métricas Prometheus ----
    if (path === "/metrics") {
      const opusCount = [...state.clients.values()].filter(c=>c.tier==="opus").length;
      const mp3Count = state.clients.size - opusCount;
      const lines = [
        "# HELP radio_listeners Oyentes conectados actualmente",
        "# TYPE radio_listeners gauge",
        `radio_listeners ${state.clients.size}`,
        "# HELP radio_listeners_mp3 Oyentes mp3",
        "# TYPE radio_listeners_mp3 gauge",
        `radio_listeners_mp3 ${mp3Count}`,
        "# HELP radio_listeners_opus Oyentes opus tier",
        "# TYPE radio_listeners_opus gauge",
        `radio_listeners_opus ${opusCount}`,
        "# HELP radio_broadcasting 1 si hay una fuente transmitiendo, 0 si no",
        "# TYPE radio_broadcasting gauge",
        `radio_broadcasting ${state.isBroadcasting ? 1 : 0}`,
        "# HELP radio_bytes_received_total Bytes totales recibidos de la fuente",
        "# TYPE radio_bytes_received_total counter",
        `radio_bytes_received_total ${state.totalBytesReceived}`,
        "# HELP radio_bytes_sent_total Bytes totales enviados a oyentes mp3",
        "# TYPE radio_bytes_sent_total counter",
        `radio_bytes_sent_total ${state.totalBytesSent}`,
        "# HELP radio_bytes_sent_opus_total Bytes totales enviados opus tier",
        "# TYPE radio_bytes_sent_opus_total counter",
        `radio_bytes_sent_opus_total ${state.totalBytesSentOpus}`,
        "# HELP radio_fallback_active 1 si el audio de respaldo está sonando, 0 si no",
        "# TYPE radio_fallback_active gauge",
        `radio_fallback_active ${(!state.isBroadcasting && state.currentTrack !== null) ? 1 : 0}`,
        "# HELP radio_opus_tier_enabled 1 si opus tier habilitado",
        "# TYPE radio_opus_tier_enabled gauge",
        `radio_opus_tier_enabled ${config.opusTierEnabled ? 1 : 0}`,
      ];
      return new Response(lines.join("\n") + "\n", {
        headers: { "Content-Type": "text/plain; version=0.0.4", ...corsHeaders() },
      });
    }

    return Response.json({ error: "Not Found" }, { status: 404, headers: corsHeaders() });
  },

  error(err) {
    httpLog.error("Error no controlado en el servidor HTTP:", err);
    return new Response("Internal Server Error", { status: 500 });
  },
});
