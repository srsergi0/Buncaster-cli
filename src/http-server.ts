import { config } from "./config";
import { state } from "./state";
import { preBuffer, preBufferOpus } from "./pre-buffer";
import { httpLog } from "./logger";

// Rutas literales: /mp3 (320k) y /opus (96k) — solo estas
const STREAM_PATHS = new Set(["/mp3", "/opus"]);
import {
  corsHeaders,
  checkStreamKey,
  checkAdminAuth,
  unauthorized,
  getClientIp,
} from "./http-helpers";
import {
  deckA,
  deckB,
  activeDeck,
  transitionStarted,
  isStoppingFallback,
  opusHeaders,
  stopMasterEncoder,
  stopPlaylistWatcher,
  stopAudioWatchdog,
} from "./audio-router";
import { flushLogsSync } from "./logger";

import { StreamableHttpTransport, InMemorySessionAdapter } from "mcp-lite";
import { mcpServer } from "./mcp-server";
import { FORMAT_CONFIG } from "./format-config";
import { type IcyClientState, createIcyState, chunkWithIcy } from "./icy-metadata";

const mcpSessionAdapter = new InMemorySessionAdapter({ maxEventBufferSize: 100 });
const mcpTransport = new StreamableHttpTransport({
  sessionAdapter: mcpSessionAdapter,
});
const handleMcpRequest = mcpTransport.bind(mcpServer);

function generateClientId(): string {
  return crypto.randomUUID();
}

function tryServe(port: number, retries = 5): ReturnType<typeof Bun.serve> {
  for (let p = port; p < port + retries; p++) {
    try {
      const s = Bun.serve({
        hostname: config.host,
        port: p,
        idleTimeout: 0,
        async fetch(req: Request, server: any) { return (globalThis as any).__bunServeFetch(req, server); },
        error(err: any) { httpLog.error("Error in HTTP server:", err); return new Response("Internal Server Error", { status: 500 }); }
      } as any);
      if (p !== port) {
        httpLog.warn(`Port ${port} in use, using ${p} instead`);
        (config as any).httpPort = p;
      }
      return s;
    } catch (e: any) {
      if (e?.code === "EADDRINUSE" || String(e).includes("in use")) {
        httpLog.warn(`Port ${p} in use, trying ${p+1}...`);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to bind HTTP port ${port} after ${retries} tries`);
}

let appJsCache: string | null = null;
let appJsBuilding: Promise<string> | null = null;

async function getOrBuildAppJs(): Promise<string> {
  if (appJsCache) return appJsCache;
  if (appJsBuilding) return appJsBuilding;

  appJsBuilding = (async () => {
    try {
      const build = await Bun.build({ entrypoints: ["src/web/App.tsx"], target: "browser", minify: false });
      if (!build.success || !build.outputs[0]) throw new Error("Build failed");
      const js = await build.outputs[0].text();
      appJsCache = js;
      return js;
    } finally {
      appJsBuilding = null;
    }
  })();

  return appJsBuilding;
}

// Store fetch handler for tryServe wrapper
(globalThis as any).__bunServeFetch = async (req: Request, server: any) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // Aislamiento del puerto de salida: si config.outputPort !== config.dashboardPort y la petición viene por outputServer,
  // restringir estrictamente a streams de audio y endpoints de lectura de estado.
  if (server?.port === config.outputPort && config.outputPort !== config.dashboardPort) {
    if (!STREAM_PATHS.has(path) && path !== "/health" && path !== "/status" && path !== "/metrics") {
      return Response.json({ error: "Not Found on Stream Port" }, { status: 404, headers: corsHeaders() });
    }
  }

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  if (path.startsWith("/mcp")) {
    if (!checkStreamKey(req)) return unauthorized();
    const response = await handleMcpRequest(req);
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

  // ---- Stream (literal /mp3 and /opus) ----
  if (STREAM_PATHS.has(path) && (req.method === "GET" || req.method === "HEAD")) {
    if (state.clients.size >= config.maxListeners) {
      return new Response("Server at max listeners", {
        status: 503,
        headers: {
          "Retry-After": "5",
          ...corsHeaders(),
        },
      });
    }

    const isOpus = path === "/opus";
    const tier: "mp3" | "opus" = isOpus ? "opus" : "mp3";

    if (isOpus && !config.opusTierEnabled) {
      return new Response("Opus tier deshabilitado", { status: 404, headers: corsHeaders() });
    }

    const streamHeaders: Record<string, string> = {
      "Content-Type": isOpus ? FORMAT_CONFIG["opus"].mime : FORMAT_CONFIG[config.streamFormat].mime,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Content-Encoding": "identity",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
      ...corsHeaders(),
    };

    const icyMetaRequested = !isOpus && req.headers.get("icy-metadata") === "1";
    let icyState: any;
    if (icyMetaRequested) {
      icyState = createIcyState();
      streamHeaders["icy-metaint"] = String(icyState.metaInterval);
      streamHeaders["icy-name"] = "BunRadio";
      streamHeaders["icy-genre"] = "Various";
      streamHeaders["icy-br"] = String(config.fallbackBitrateKbps);
      streamHeaders["icy-url"] = "";
      streamHeaders["icy-pub"] = "0";
    }
    if (isOpus) streamHeaders["icy-br"] = String(config.opusTierBitrateKbps);
    if (req.method === "HEAD") return new Response(null, { headers: streamHeaders });

    const clientId = generateClientId();
    const ip = getClientIp(req, server);
    const userAgent = req.headers.get("user-agent") || "unknown";
    const chosenPreBuffer = isOpus ? preBufferOpus : preBuffer;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (isOpus && opusHeaders) { try { controller.enqueue(opusHeaders); } catch {} }
        const shouldSendPreBuffer = !config.lowLatency || !state.isBroadcasting;
        if (shouldSendPreBuffer) {
          const currentTitle = state.currentTrack
            ? `${state.currentTrack.artist} - ${state.currentTrack.title}`
            : "";
          for (const chunk of chosenPreBuffer.snapshot()) {
            try {
              if (icyState) {
                const pieces = chunkWithIcy(chunk, icyState, currentTitle);
                for (const piece of pieces) {
                  controller.enqueue(piece);
                }
              } else {
                controller.enqueue(chunk);
              }
            } catch {}
          }
        } else if (config.lowLatency && state.isBroadcasting) {
          httpLog.debug(`[HTTP] low-latency live: bypass preBuffer`);
        }
        const clientObj = { id: clientId, controller, connectedAt: new Date(), ip, userAgent, bytesSent: 0, slowStrikes: 0, icy: icyState, tier };
        state.clients.set(clientId, clientObj);
        if (tier === "mp3") {
          state.mp3Clients.set(clientId, clientObj);
        } else {
          state.opusClients.set(clientId, clientObj);
        }
        state.listenersMp3 = state.mp3Clients.size;
        state.listenersOpus = state.opusClients.size;
        state.totalListenersServed++;
        httpLog.info(`Listener connected: ${clientId} tier=${tier} desde ${ip} (${state.clients.size} activos mp3:${state.listenersMp3} opus:${state.listenersOpus})`);
      },
      cancel() {
        state.clients.delete(clientId);
        state.mp3Clients.delete(clientId);
        state.opusClients.delete(clientId);
        state.listenersMp3 = state.mp3Clients.size;
        state.listenersOpus = state.opusClients.size;
        httpLog.info(`Listener disconnected: ${clientId} tier=${tier} (${state.clients.size} activos)`);
      },
    }, {
      highWaterMark: config.lowLatency ? 64 * 1024 : config.preBufferBytes + 256 * 1024,
      size(chunk: Uint8Array) {
        return chunk.byteLength;
      },
    });
    req.signal.addEventListener("abort", () => {
      state.clients.delete(clientId);
      state.mp3Clients.delete(clientId);
      state.opusClients.delete(clientId);
      state.listenersMp3 = state.mp3Clients.size;
      state.listenersOpus = state.opusClients.size;
    });
    return new Response(stream, { headers: streamHeaders });
  }

  // ---- Web UI (TSX — Bun compiles) ----
  if (path === "/" || path === "/index.html") {
    try {
      const html = await Bun.file("public/index.html").text();
      return new Response(html, { headers: { "Content-Type": "text/html", ...corsHeaders() } });
    } catch {
      return new Response("<h1>BUNRADIO</h1><p>Web UI not built — run <code>bun run build</code></p><p><a href='/mp3'>/mp3</a> <a href='/opus'>/opus</a></p>", { headers: { "Content-Type": "text/html", ...corsHeaders() } });
    }
  }
  if (path === "/app.js") {
    try {
      const js = await getOrBuildAppJs();
      return new Response(js, { headers: { "Content-Type": "application/javascript", ...corsHeaders() } });
    } catch (e: any) {
      return new Response(`console.error("Web build failed: ${String(e.message).replace(/"/g, "'")}");`, { headers: { "Content-Type": "application/javascript", ...corsHeaders() } });
    }
  }

  // ---- Web API & Admin Endpoints (protected with checkAdminAuth) ----
  if (path.startsWith("/api/") || path.startsWith("/admin/api/")) {
    if (!checkAdminAuth(req)) {
      return unauthorized();
    }
  }

  if (path === "/api/fallback" && req.method === "POST") {
    try {
      const { folder } = await req.json() as any;
      const { setFallbackSource } = await import("./audio-router");
      const f = String(folder ?? "").trim();
      setFallbackSource(f);
      return Response.json({ ok: true, message: f === "" ? "Live-only" : `Folder set to ${f}` }, { headers: corsHeaders() });
    } catch (e: any) { return Response.json({ ok: false, message: String(e.message) }, { status: 500, headers: corsHeaders() }); }
  }

  // ---- Queue Endpoints ----
  if (path === "/api/queue" && req.method === "GET") {
    return Response.json({ ok: true, queue: state.fallbackQueue }, { headers: corsHeaders() });
  }

  if (path === "/api/queue/add" && req.method === "POST") {
    try {
      const { file } = await req.json() as any;
      const f = String(file ?? "").trim();
      if (!f) throw new Error("file required");
      const { startFallback } = await import("./audio-router");
      state.fallbackQueue = state.fallbackQueue || [];
      state.fallbackQueue.push(f);
      try { startFallback(); } catch {}
      return Response.json({ ok: true, message: `Added ${f.split("/").pop()}`, queue: state.fallbackQueue }, { headers: corsHeaders() });
    } catch (e: any) { return Response.json({ ok: false, message: String(e.message) }, { status: 500, headers: corsHeaders() }); }
  }

  if (path === "/api/queue/remove" && req.method === "POST") {
    try {
      const { index, file } = await req.json() as any;
      state.fallbackQueue = state.fallbackQueue || [];
      let removed: string | undefined;
      if (typeof index === "number" && index >= 0 && index < state.fallbackQueue.length) {
        [removed] = state.fallbackQueue.splice(index, 1);
      } else if (file) {
        const idx = state.fallbackQueue.indexOf(String(file));
        if (idx !== -1) [removed] = state.fallbackQueue.splice(idx, 1);
      }
      return Response.json({ ok: true, removed, queue: state.fallbackQueue }, { headers: corsHeaders() });
    } catch (e: any) { return Response.json({ ok: false, message: String(e.message) }, { status: 500, headers: corsHeaders() }); }
  }

  if (path === "/api/queue/clear" && req.method === "POST") {
    state.fallbackQueue = [];
    return Response.json({ ok: true, message: "Queue cleared", queue: [] }, { headers: corsHeaders() });
  }

  if (path === "/api/queue/move" && req.method === "POST") {
    try {
      const { from, to } = await req.json() as any;
      state.fallbackQueue = state.fallbackQueue || [];
      const f = Number(from);
      const t = Number(to);
      if (Number.isNaN(f) || f < 0 || f >= state.fallbackQueue.length || Number.isNaN(t) || t < 0 || t >= state.fallbackQueue.length) {
        throw new Error("Invalid 'from' or 'to' index");
      }
      const [item] = state.fallbackQueue.splice(f, 1);
      if (item) state.fallbackQueue.splice(t, 0, item);
      return Response.json({ ok: true, queue: state.fallbackQueue }, { headers: corsHeaders() });
    } catch (e: any) { return Response.json({ ok: false, message: String(e.message) }, { status: 500, headers: corsHeaders() }); }
  }

  if (path === "/api/skip" && req.method === "POST") {
    try {
      const { actionSkipFallback } = await import("./audio-router");
      actionSkipFallback();
      return Response.json({ ok: true, message: "Skipped" }, { headers: corsHeaders() });
    } catch (e: any) { return Response.json({ ok: false, message: String(e.message) }, { status: 500, headers: corsHeaders() }); }
  }
  if (path === "/api/stop" && req.method === "POST") {
    setTimeout(() => gracefulShutdown(0), 50);
    return Response.json({ ok: true, message: "Stopping gracefully..." }, { headers: corsHeaders() });
  }

  // ---- Health/Status/Metrics ----
  if (path === "/health") {
    const uptimeSeconds = Math.floor((Date.now() - state.startTime.getTime()) / 1000);
    const mem = process.memoryUsage();
    const fallbackActive = !state.isBroadcasting && state.currentTrack !== null;
    const masterAlive = state.masterProcess !== null;
    const opusAlive = state.opusProcess !== null;
    const sourceAlive = state.sourceProcess !== null;
    const opusCount = state.listenersOpus;
    const mp3Count = state.listenersMp3;
    const audioStalled = state.audioClockSamples === 0 && uptimeSeconds > 5 && !state.fallbackPaused;
    const overallStatus = audioStalled ? "degraded" : "ok";
    return Response.json({
      status: overallStatus,
      uptime: uptimeSeconds,
      memory: {
        rss: Math.round(mem.rss/1024/1024),
        heapTotal: Math.round(mem.heapTotal/1024/1024),
        heapUsed: Math.round(mem.heapUsed/1024/1024),
        external: Math.round(mem.external/1024/1024),
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
        queue: state.fallbackQueue || [],
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
      audio: {
        clockSamples: state.audioClockSamples,
        samplesProduced: state.audioSamplesProduced,
        underruns: state.audioUnderruns,
        lastSourceAudioTimeMs: state.lastSourceAudioTimeMs,
        lastPcmSampleTimeMs: state.lastPcmSampleTimeMs,
      },
      evictions: state.evictionsTotal,
      deckState: state.deckState,
      tiers: {
        mp3: { bitrate: config.fallbackBitrateKbps, mime: FORMAT_CONFIG[config.streamFormat].mime },
        opus: config.opusTierEnabled ? { bitrate: config.opusTierBitrateKbps, mime: FORMAT_CONFIG["opus"].mime } : null,
      },
    }, { headers: corsHeaders() });
  }
  if (path === "/debug-state") {
    return Response.json({ activeDeck, transitionStarted, isStoppingFallback, deckA: { hasProcess: deckA.process !== null, currentTrackFile: deckA.currentTrackFile, bufferLength: deckA.buffer.length }, deckB: { hasProcess: deckB.process !== null, currentTrackFile: deckB.currentTrackFile, bufferLength: deckB.buffer.length } }, { headers: corsHeaders() });
  }
  if (path === "/status") {
    const uptimeSeconds = Math.floor((Date.now() - state.startTime.getTime()) / 1000);
    const opusCount = state.listenersOpus;
    const mp3Count = state.listenersMp3;
    return Response.json({ broadcasting: state.isBroadcasting, sourceConnected: state.sourceConnected, listeners: state.clients.size, listenersMp3: mp3Count, listenersOpus: opusCount, maxListeners: config.maxListeners, totalListenersServed: state.totalListenersServed, totalBytesReceived: state.totalBytesReceived, totalBytesSent: state.totalBytesSent, totalBytesSentOpus: state.totalBytesSentOpus, uptimeSeconds, stationName: "BunRadio", detectedBitrateKbps: state.detectedBitrateKbps, detectedSampleRate: state.detectedSampleRate, fallbackBitrateKbps: config.fallbackBitrateKbps, opusTierBitrateKbps: config.opusTierBitrateKbps, opusTierEnabled: config.opusTierEnabled, fallbackActive: !state.isBroadcasting && state.currentTrack !== null }, { headers: corsHeaders() });
  }
  if (path === "/metrics") {
    const opusCount = state.listenersOpus;
    const mp3Count = state.listenersMp3;
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
      "# HELP radio_fallback_active 1 if fallback audio is playing, 0 otherwise",
      "# TYPE radio_fallback_active gauge",
      `radio_fallback_active ${(!state.isBroadcasting && state.currentTrack !== null) ? 1 : 0}`,
      "# HELP radio_opus_tier_enabled 1 si opus tier habilitado",
      "# TYPE radio_opus_tier_enabled gauge",
      `radio_opus_tier_enabled ${config.opusTierEnabled ? 1 : 0}`,
      "# HELP radio_audio_samples_produced_total Muestras de audio producidas",
      "# TYPE radio_audio_samples_produced_total counter",
      `radio_audio_samples_produced_total ${state.audioSamplesProduced}`,
      "# HELP radio_audio_underruns_total Huecos o ausencias de audio",
      "# TYPE radio_audio_underruns_total counter",
      `radio_audio_underruns_total ${state.audioUnderruns}`,
      "# HELP radio_evictions_slow_client Desconexiones por cliente lento",
      "# TYPE radio_evictions_slow_client counter",
      `radio_evictions_slow_client ${state.evictionsTotal.slowClient}`,
      "# HELP radio_evictions_backpressure Desconexiones por saturacion de buffer",
      "# TYPE radio_evictions_backpressure counter",
      `radio_evictions_backpressure ${state.evictionsTotal.backpressure}`,
      "# HELP radio_deck_state_a Estado de deck A",
      "# TYPE radio_deck_state_a gauge",
      `radio_deck_state_a{state="${state.deckState.A}"} 1`,
      "# HELP radio_deck_state_b Estado de deck B",
      "# TYPE radio_deck_state_b gauge",
      `radio_deck_state_b{state="${state.deckState.B}"} 1`,
    ];
    return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "text/plain; version=0.0.4", ...corsHeaders() } });
  }
  return Response.json({ error: "Not Found" }, { status: 404, headers: corsHeaders() });
};

export const httpServer = tryServe(config.dashboardPort);
export const outputServer = config.outputPort !== config.dashboardPort ? tryServe(config.outputPort) : httpServer;

export async function gracefulShutdown(exitCode = 0): Promise<void> {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  httpLog.info("Iniciando apagado ordenado (graceful shutdown)...");

  for (const [id, client] of state.clients) {
    try {
      client.controller.close();
    } catch {
      /* noop */
    }
  }
  state.clients.clear();
  state.mp3Clients.clear();
  state.opusClients.clear();
  state.listenersMp3 = 0;
  state.listenersOpus = 0;

  stopPlaylistWatcher();
  stopAudioWatchdog();
  stopMasterEncoder();

  if (state.sourceProcess) {
    try { state.sourceProcess.kill(); } catch {}
    state.sourceProcess = null;
  }
  if (deckA.process) {
    try { deckA.process.kill(); } catch {}
    deckA.process = null;
  }
  if (deckB.process) {
    try { deckB.process.kill(); } catch {}
    deckB.process = null;
  }

  flushLogsSync();

  try { httpServer?.stop(true); } catch {}
  try { if (outputServer !== httpServer) outputServer?.stop(true); } catch {}

  setTimeout(() => process.exit(exitCode), 100);
}

process.on("SIGINT", () => gracefulShutdown(0));
process.on("SIGTERM", () => gracefulShutdown(0));

