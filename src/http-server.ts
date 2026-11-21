import { config } from "./config";
import { state } from "./state";
import { preBuffer, preBufferOpus } from "./pre-buffer";
import { httpLog } from "./logger";
import { Event, ErrorCode } from "./events";
import { getNowPlayingInfo, getCurrentTitle } from "./broadcaster";

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
  mp3ListenerJoined,
} from "./audio-router";
import { flushLogsSync } from "./logger";
import { audioClockDriftSeconds } from "./audio-router";
import { analysisQueueStats } from "./track-analysis";
import { moqSessionInfo, moqStatus, moqState, requestProbe } from "./moq/index";

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
        error(err: any) { httpLog.fail(ErrorCode.server, "Error en el servidor HTTP", { error: String(err) }); return new Response("Internal Server Error", { status: 500 }); }
      } as any);
      if (p !== port) {
        httpLog.event("warn", Event.serverPortBusy, `Puerto ${port} ocupado; usando ${p}`, { requested: port, used: p });
        (config as any).httpPort = p;
      }
      return s;
    } catch (e: any) {
      if (e?.code === "EADDRINUSE" || String(e).includes("in use")) {
        httpLog.event("warn", Event.serverPortBusy, `Puerto ${p} ocupado; probando ${p + 1}...`, { requested: p, next: p + 1 });
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
      const prebuilt = Bun.file("public/app.js");
      if (await prebuilt.exists()) {
        const text = await prebuilt.text();
        appJsCache = text;
        return text;
      }
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

// Cliente MoQ (client/moq-player.ts): prebuilt en la imagen (public/moq-player.js) o
// compilado al vuelo desde el código fuente en desarrollo.
let moqPlayerJs: Promise<string> | null = null;
function getMoqPlayerJs(): Promise<string> {
  if (!moqPlayerJs) {
    moqPlayerJs = (async () => {
      const prebuilt = Bun.file("public/moq-player.js");
      if (await prebuilt.exists()) return prebuilt.text();
      const build = await Bun.build({ entrypoints: ["client/moq-player.ts"], target: "browser", minify: true });
      if (!build.success || !build.outputs[0]) throw new Error("build de client/moq-player.ts falló");
      return build.outputs[0].text();
    })().catch((e) => { moqPlayerJs = null; throw e; });
  }
  return moqPlayerJs;
}

/** Estado del motor (sonoridad, latencia, aire muerto, supervisión) para /status y /health. */
function engineStatus() {
  const track = state.currentTrack;
  return {
    loudness: {
      normalization: config.loudnessNormalization,
      targetLufs: config.loudnessTargetLufs,
      truePeakCeilingDbtp: config.loudnessTruePeakDbtp,
      smartTransitions: config.smartTransitions,
      currentTrack: !state.isBroadcasting && track?.loudness ? track.loudness : null,
      analysis: analysisQueueStats(),
    },
    latency: {
      prebufferSecondsMp3: Math.round(preBuffer.secondsFor(preBuffer.capacityBytes) * 10) / 10,
      prebufferSecondsOpus: Math.round(preBufferOpus.secondsFor(preBufferOpus.capacityBytes) * 10) / 10,
      prebufferBytesMp3: preBuffer.capacityBytes,
      prebufferBytesOpus: preBufferOpus.capacityBytes,
      joinBacklogSecondsAvg: state.joinBacklogCount > 0 ? Math.round((state.joinBacklogSecondsSum / state.joinBacklogCount) * 10) / 10 : 0,
      joinBacklogSecondsMax: Math.round(state.joinBacklogSecondsMax * 10) / 10,
      audioClockDriftSeconds: Math.round(audioClockDriftSeconds() * 100) / 100,
    },
    air: {
      deadAirSeconds: Math.round(state.deadAirSeconds * 10) / 10,
      deadAirEvents: state.deadAirEvents,
      digitalSilenceSeconds: Math.round(state.digitalSilenceSeconds * 10) / 10,
      fallbackStallRestarts: state.fallbackStallRestarts,
    },
    crossfade: {
      sampleClock: config.crossfadeSampleClock,
      completed: state.crossfadesCompleted,
      truncated: state.crossfadesTruncated,
      handoverBufferedBytes: state.handoverDrainedBytes,
      underrunBytes: state.crossfadeUnderrunBytes,
    },
    bunWay: {
      encoderBatchMs: config.encoderBatchMs,
      nativeDecode: config.useNativeDecode,
      deckDecodesNative: state.deckDecodesNative,
      deckDecodesFfmpeg: state.deckDecodesFfmpeg,
      mp3OnDemand: config.mp3OnDemand,
      mp3EncoderMode: state.mp3EncoderMode,
      mp3EncoderWakeups: state.mp3EncoderWakeups,
      srtOnDemand: config.srtOnDemand,
      srtArmed: state.srtArmed,
      srtWakeups: state.srtWakeups,
    },
    supervision: {
      enabled: config.encoderSupervision,
      opusEncoderRestarts: state.opusEncoderRestarts,
      opusEncoderGeneration: state.opusEncoderGeneration,
    },
  };
}

// Store fetch handler for tryServe wrapper
(globalThis as any).__bunServeFetch = async (req: Request, server: any) => {
  // Base explícita: peticiones sin Host (HTTP/1.0, escáneres) traen req.url relativo
  // y `new URL("/")` lanzaba TypeError → 500 + traza en el log por cada una.
  const url = new URL(req.url, "http://localhost");
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
          const currentTitle = getCurrentTitle();
          const snap = chosenPreBuffer.snapshot();
          let snapBytes = 0;
          for (const c of snap) snapBytes += c.byteLength;
          const backlogSec = chosenPreBuffer.secondsFor(snapBytes);
          state.joinBacklogSecondsSum += backlogSec;
          state.joinBacklogCount++;
          if (backlogSec > state.joinBacklogSecondsMax) state.joinBacklogSecondsMax = backlogSec;
          for (const chunk of snap) {
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
          mp3ListenerJoined(); // MP3_ON_DEMAND: despierta LAME y le manda el historial
        } else {
          state.opusClients.set(clientId, clientObj);
        }
        state.listenersMp3 = state.mp3Clients.size;
        state.listenersOpus = state.opusClients.size;
        state.totalListenersServed++;
        httpLog.ok(Event.listenerConnected, `Listener conectado (tier ${tier})`, { clientId, tier, ip, total: state.clients.size, mp3: state.listenersMp3, opus: state.listenersOpus });
      },
      cancel() {
        state.clients.delete(clientId);
        state.mp3Clients.delete(clientId);
        state.opusClients.delete(clientId);
        state.listenersMp3 = state.mp3Clients.size;
        state.listenersOpus = state.opusClients.size;
        httpLog.ok(Event.listenerDisconnected, `Listener desconectado (tier ${tier})`, { clientId, tier, total: state.clients.size });
      },
    }, {
      // Medido (ENGINE-ROUNDTABLE): subir el HWM al tamaño del prebuffer elevaba el RSS de
      // ~68 MB a ~120 MB con 200 oyentes sin evitar ninguna expulsión; se mantiene 64 KB.
      highWaterMark: config.lowLatency ? 64 * 1024 : chosenPreBuffer.capacityBytes + 256 * 1024,
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

  // ---- MoQ / WebTransport (docs/ENGINE-MOQ.md) ----
  if (path === "/moq/session" && req.method === "GET") {
    const body = config.moqEnabled ? moqSessionInfo(req) : { enabled: false, fallbackUrl: config.moqFallbackUrl, serverTimeMs: Date.now() };
    return Response.json(body, { headers: { "Cache-Control": "no-store", ...corsHeaders() } });
  }
  if (path === "/moq/player.js" && req.method === "GET") {
    try {
      const js = await getMoqPlayerJs();
      return new Response(js, { headers: { "Content-Type": "application/javascript", "Cache-Control": "no-cache", ...corsHeaders() } });
    } catch (e: any) {
      return new Response(`console.error(${JSON.stringify("moq-player.js: " + String(e?.message ?? e))});`, { status: 500, headers: { "Content-Type": "application/javascript", ...corsHeaders() } });
    }
  }
  if (path === "/moq/demo" && req.method === "GET") {
    const demo = Bun.file("public/moq-demo.html");
    const f = (await demo.exists()) ? demo : Bun.file("client/demo.html");
    if (!(await f.exists())) return new Response("demo no incluida", { status: 404, headers: corsHeaders() });
    return new Response(f, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ...corsHeaders() } });
  }

  // ---- Public Now Playing Endpoints ----
  if ((path === "/api/now-playing" || path === "/api/current-track") && req.method === "GET") {
    const nowPlaying = getNowPlayingInfo();
    return Response.json({
      ok: true,
      isLive: state.isBroadcasting,
      nowPlaying,
      currentTrack: nowPlaying.display,
      title: nowPlaying.title,
      artist: nowPlaying.artist,
      duration: nowPlaying.duration,
      elapsed: nowPlaying.elapsed,
      remaining: nowPlaying.remaining,
      progress: nowPlaying.progress,
    }, { headers: corsHeaders() });
  }

  // ---- Web API & Admin Endpoints (protected with checkAdminAuth) ----
  if ((path.startsWith("/api/") || path.startsWith("/admin/api/")) && path !== "/api/now-playing" && path !== "/api/current-track") {
    if (!checkAdminAuth(req)) {
      return unauthorized();
    }
  }

  // Solo pruebas (MOQ_LATENCY_PROBE=true): inyecta un tono marcador en la entrada del motor
  // y devuelve la hora exacta, para medir glass-to-glass en HTTP y en MoQ con el mismo clic.
  if (path === "/admin/api/moq/probe" && req.method === "POST") {
    if (!config.moqLatencyProbe) return Response.json({ error: "MOQ_LATENCY_PROBE=false" }, { status: 404, headers: corsHeaders() });
    try {
      const r = await requestProbe();
      return Response.json({ ok: true, ...r }, { headers: corsHeaders() });
    } catch (e: any) {
      return Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 503, headers: corsHeaders() });
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
    // También "degraded" si hay aire muerto en curso (sin PCM > 2 s fuera de pausa):
    // antes /health seguía en "ok" con un deck colgado y la radio muda.
    const deadAirNow = !state.fallbackPaused && state.lastPcmSampleTimeMs > 0 && Date.now() - state.lastPcmSampleTimeMs > 2000;
    const audioStalled = (state.audioClockSamples === 0 && uptimeSeconds > 5 && !state.fallbackPaused) || deadAirNow;
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
      nowPlaying: getNowPlayingInfo(),
      fallback: {
        active: fallbackActive,
        paused: state.fallbackPaused,
        currentTrack: getNowPlayingInfo().display,
        track: getNowPlayingInfo(),
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
      engine: engineStatus(),
    }, { headers: corsHeaders() });
  }
  if (path === "/debug-state") {
    return Response.json({ activeDeck, transitionStarted, isStoppingFallback, deckA: { hasProcess: deckA.process !== null, currentTrackFile: deckA.currentTrackFile, bufferLength: deckA.buffer.length }, deckB: { hasProcess: deckB.process !== null, currentTrackFile: deckB.currentTrackFile, bufferLength: deckB.buffer.length } }, { headers: corsHeaders() });
  }
  if (path === "/status") {
    const uptimeSeconds = Math.floor((Date.now() - state.startTime.getTime()) / 1000);
    const opusCount = state.listenersOpus;
    const mp3Count = state.listenersMp3;
    const nowPlaying = getNowPlayingInfo();
    return Response.json({
      broadcasting: state.isBroadcasting,
      sourceConnected: state.sourceConnected,
      nowPlaying,
      currentTrack: nowPlaying.display,
      title: nowPlaying.title,
      artist: nowPlaying.artist,
      listeners: state.clients.size,
      listenersMp3: mp3Count,
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
      engine: engineStatus(),
      ...(config.moqEnabled ? { moq: moqStatus() } : {}),
    }, { headers: corsHeaders() });
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
      "# HELP radio_dead_air_seconds_total Segundos sin PCM hacia el encoder (huecos > 500 ms)",
      "# TYPE radio_dead_air_seconds_total counter",
      `radio_dead_air_seconds_total ${state.deadAirSeconds.toFixed(3)}`,
      "# HELP radio_dead_air_events_total Huecos de PCM > 500 ms",
      "# TYPE radio_dead_air_events_total counter",
      `radio_dead_air_events_total ${state.deadAirEvents}`,
      "# HELP radio_digital_silence_seconds_total Segundos emitidos con pico < -60 dBFS",
      "# TYPE radio_digital_silence_seconds_total counter",
      `radio_digital_silence_seconds_total ${state.digitalSilenceSeconds.toFixed(3)}`,
      "# HELP radio_fallback_stall_restarts_total Reinicios del fallback por watchdog de audio",
      "# TYPE radio_fallback_stall_restarts_total counter",
      `radio_fallback_stall_restarts_total ${state.fallbackStallRestarts}`,
      "# HELP radio_opus_encoder_restarts_total Reinicios supervisados del encoder opus",
      "# TYPE radio_opus_encoder_restarts_total counter",
      `radio_opus_encoder_restarts_total ${state.opusEncoderRestarts}`,
      "# HELP radio_crossfades_total Crossfades por resultado",
      "# TYPE radio_crossfades_total counter",
      `radio_crossfades_total{result="completed"} ${state.crossfadesCompleted}`,
      `radio_crossfades_total{result="truncated"} ${state.crossfadesTruncated}`,
      "# HELP radio_deck_handover_buffered_bytes_total PCM precargado en el deck entrante al relevo (drenado con CROSSFADE_SAMPLE_CLOCK, descartado sin él)",
      "# TYPE radio_deck_handover_buffered_bytes_total counter",
      `radio_deck_handover_buffered_bytes_total ${state.handoverDrainedBytes}`,
      "# HELP radio_crossfade_underrun_bytes_total PCM que faltó del deck entrante durante crossfades (relleno con silencio)",
      "# TYPE radio_crossfade_underrun_bytes_total counter",
      `radio_crossfade_underrun_bytes_total ${state.crossfadeUnderrunBytes}`,
      "# HELP radio_prebuffer_seconds Segundos de audio de prebuffer por tier (latencia tras el directo al conectar)",
      "# TYPE radio_prebuffer_seconds gauge",
      `radio_prebuffer_seconds{tier="mp3"} ${preBuffer.secondsFor(preBuffer.capacityBytes).toFixed(2)}`,
      `radio_prebuffer_seconds{tier="opus"} ${preBufferOpus.secondsFor(preBufferOpus.capacityBytes).toFixed(2)}`,
      "# HELP radio_listener_join_backlog_seconds Backlog entregado al conectar (resumen)",
      "# TYPE radio_listener_join_backlog_seconds summary",
      `radio_listener_join_backlog_seconds_sum ${state.joinBacklogSecondsSum.toFixed(3)}`,
      `radio_listener_join_backlog_seconds_count ${state.joinBacklogCount}`,
      "# HELP radio_listener_join_backlog_seconds_max Mayor backlog entregado al conectar",
      "# TYPE radio_listener_join_backlog_seconds_max gauge",
      `radio_listener_join_backlog_seconds_max ${state.joinBacklogSecondsMax.toFixed(3)}`,
      "# HELP radio_audio_clock_drift_seconds Audio emitido menos tiempo de pared (positivo = más rápido que tiempo real)",
      "# TYPE radio_audio_clock_drift_seconds gauge",
      `radio_audio_clock_drift_seconds ${audioClockDriftSeconds().toFixed(3)}`,
      "# HELP radio_deck_decodes_total Pistas iniciadas por motor de decodificación (native = libavcodec FFI en proceso)",
      "# TYPE radio_deck_decodes_total counter",
      `radio_deck_decodes_total{engine="native"} ${state.deckDecodesNative}`,
      `radio_deck_decodes_total{engine="ffmpeg"} ${state.deckDecodesFfmpeg}`,
      "# HELP radio_mp3_encoder_active 1 si LAME está codificando (MP3_ON_DEMAND lo para sin oyentes /mp3)",
      "# TYPE radio_mp3_encoder_active gauge",
      `radio_mp3_encoder_active ${state.mp3EncoderMode === "idle" ? 0 : 1}`,
      "# HELP radio_mp3_encoder_wakeups_total Veces que MP3_ON_DEMAND despertó LAME",
      "# TYPE radio_mp3_encoder_wakeups_total counter",
      `radio_mp3_encoder_wakeups_total ${state.mp3EncoderWakeups}`,
      "# HELP radio_srt_armed 1 si SRT_ON_DEMAND espera al emisor con un socket UDP (sin ffmpeg)",
      "# TYPE radio_srt_armed gauge",
      `radio_srt_armed ${state.srtArmed ? 1 : 0}`,
      "# HELP radio_srt_wakeups_total Paquetes que despertaron el listener SRT bajo demanda",
      "# TYPE radio_srt_wakeups_total counter",
      `radio_srt_wakeups_total ${state.srtWakeups}`,
    ];
    if (config.moqEnabled) {
      const m = moqStatus();
      lines.push(
        "# HELP radio_moq_enabled 1 si el canal MoQ publica al relay",
        "# TYPE radio_moq_enabled gauge",
        `radio_moq_enabled ${m.enabled ? 1 : 0}`,
        "# HELP radio_moq_relay_connected 1 si el publicador está conectado al relay",
        "# TYPE radio_moq_relay_connected gauge",
        `radio_moq_relay_connected ${m.publisher?.connected ? 1 : 0}`,
        "# HELP radio_moq_relay_connects_total Conexiones establecidas con el relay",
        "# TYPE radio_moq_relay_connects_total counter",
        `radio_moq_relay_connects_total ${m.publisher?.connects ?? 0}`,
        "# HELP radio_moq_frames_total Tramas Opus de 20 ms publicadas",
        "# TYPE radio_moq_frames_total counter",
        `radio_moq_frames_total ${m.publisher?.framesPublished ?? 0}`,
        "# HELP radio_moq_bytes_total Bytes de media publicados al relay",
        "# TYPE radio_moq_bytes_total counter",
        `radio_moq_bytes_total ${m.publisher?.bytesPublished ?? 0}`,
        "# HELP radio_moq_encode_errors_total Fallos de opus_encode",
        "# TYPE radio_moq_encode_errors_total counter",
        `radio_moq_encode_errors_total ${moqState.encodeErrors}`,
        "# HELP radio_moq_cert_rotations_total Rotaciones del certificado WebTransport",
        "# TYPE radio_moq_cert_rotations_total counter",
        `radio_moq_cert_rotations_total ${moqState.certRotations}`,
      );
    }
    return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "text/plain; version=0.0.4", ...corsHeaders() } });
  }
  return Response.json({ error: "Not Found" }, { status: 404, headers: corsHeaders() });
};

export const httpServer = tryServe(config.dashboardPort);
export const outputServer = config.outputPort !== config.dashboardPort ? tryServe(config.outputPort) : httpServer;

export async function gracefulShutdown(exitCode = 0): Promise<void> {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  httpLog.ok(Event.serverShutdown, "Iniciando apagado ordenado (graceful shutdown)...");

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

