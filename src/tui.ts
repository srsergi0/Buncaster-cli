#!/usr/bin/env bun
// =============================================================
// BunRadio TUI — Console app with mouse buttons (blessed)
// =============================================================
import blessed from "blessed";
import { config } from "./config";
import { state } from "./state";
import { rtmpLog } from "./logger";

let screen: blessed.Widgets.Screen | null = null;
let tuiActive = false;
const logLines: string[] = [];
const MAX_LOG_LINES = 100;

export function isTuiActive() { return tuiActive; }

export function pushTuiLog(line: string) {
  logLines.push(line);
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
  // if TUI log box exists, update it (will be set via closure)
}

export function startTui() {
  tuiActive = true;

  screen = blessed.screen({
    smartCSR: true,
    title: "BunRadio",
    mouse: true,
    autoPadding: true,
    dockBorders: true,
  });

  // Quit keys
  screen.key(["escape", "q", "C-c"], () => {
    screen?.destroy();
    process.exit(0);
  });

  // Layout
  const header = blessed.box({
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    content: "  🎙️  B U N R A D I O  — Console  (mouse + keyboard)",
    tags: true,
    style: {
      fg: "white",
      bg: "blue",
      bold: true,
    },
    border: { type: "line" },
  });

  const main = blessed.box({
    top: 3,
    left: 0,
    width: "70%",
    height: "60%",
    label: " Radio ",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "cyan" } },
    scrollable: true,
    alwaysScroll: true,
  });

  const side = blessed.box({
    top: 3,
    left: "70%",
    width: "30%",
    height: "60%",
    label: " Status ",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "green" } },
  });

  const logBox = blessed.log({
    top: "63%",
    left: 0,
    width: "100%",
    height: "30%",
    label: " Logs (file: bunradio.log) ",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "yellow" } },
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    scrollbar: { ch: " ", style: { bg: "yellow" } },
  });

  const help = blessed.box({
    bottom: 0,
    left: 0,
    width: "100%",
    height: 3,
    content: "  {bold}Mouse:{/} click buttons  •  {bold}Keys:{/} q/Esc quit  •  Tab navigate",
    tags: true,
    style: { fg: "white", bg: "blue" },
    border: { type: "line" },
  });

  // Buttons row inside header or main
  const btnMP3 = blessed.button({
    parent: main,
    mouse: true,
    keys: true,
    shrink: true,
    padding: { left: 2, right: 2 },
    top: 1,
    left: 2,
    name: "mp3",
    content: " ▶ MP3 ",
    style: {
      bg: "green",
      fg: "black",
      focus: { bg: "yellow" },
      hover: { bg: "yellow" },
    },
    border: { type: "line" },
  });

  const btnOpus = blessed.button({
    parent: main,
    mouse: true,
    keys: true,
    shrink: true,
    padding: { left: 2, right: 2 },
    top: 1,
    left: 14,
    name: "opus",
    content: " ♫ OPUS ",
    style: {
      bg: "magenta",
      fg: "white",
      focus: { bg: "yellow", fg: "black" },
      hover: { bg: "yellow", fg: "black" },
    },
    border: { type: "line" },
  });

  const btnHealth = blessed.button({
    parent: main,
    mouse: true,
    keys: true,
    shrink: true,
    padding: { left: 1, right: 1 },
    top: 1,
    left: 27,
    name: "health",
    content: " Health ",
    style: {
      bg: "blue",
      fg: "white",
      focus: { bg: "yellow", fg: "black" },
      hover: { bg: "yellow", fg: "black" },
    },
    border: { type: "line" },
  });

  const btnStop = blessed.button({
    parent: main,
    mouse: true,
    keys: true,
    shrink: true,
    padding: { left: 1, right: 1 },
    top: 1,
    left: 38,
    name: "stop",
    content: " Stop ",
    style: {
      bg: "red",
      fg: "white",
      focus: { bg: "yellow", fg: "black" },
      hover: { bg: "yellow", fg: "black" },
    },
    border: { type: "line" },
  });

  // Append
  screen!.append(header);
  screen!.append(main);
  screen!.append(side);
  screen!.append(logBox);
  screen!.append(help);

  // Focus
  btnMP3.focus();
  screen!.render();

  // Mouse + key handlers
  btnMP3.on("press", () => {
    const url = `http://localhost:${config.httpPort}/mp3`;
    logBox.log(`{green-fg}▶ Opening MP3: ${url}{/}`);
    // Try to open via xdg-open if available, else just copy to log
    try { Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" }); } catch {}
    screen!.render();
  });

  btnOpus.on("press", () => {
    const url = `http://localhost:${config.httpPort}/opus`;
    logBox.log(`{magenta-fg}♫ Opening OPUS: ${url}{/}`);
    try { Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" }); } catch {}
    screen!.render();
  });

  btnHealth.on("press", async () => {
    try {
      const res = await fetch(`http://localhost:${config.httpPort}/health`);
      const j = await res.json();
      logBox.log(`{cyan-fg}Health: ${JSON.stringify(j).slice(0,120)}...{/}`);
    } catch (e) {
      logBox.log(`{red-fg}Health failed: ${(e as Error).message}{/}`);
    }
    screen!.render();
  });

  btnStop.on("press", () => {
    logBox.log("{red-fg}Stopping radio...{/}");
    screen!.render();
    setTimeout(() => process.exit(0), 300);
  });

  // Update main/side every 1s with live state
  const update = () => {
    const mp3Count = [...state.clients.values()].filter(c => c.tier === "opus").length;
    // Actually opus count is opus tier
    const opusCount = [...state.clients.values()].filter(c => c.tier === "opus").length;
    const mp3Listeners = state.clients.size - opusCount;
    const statusColor = state.isBroadcasting ? "{red-fg}● LIVE{/}" : "{yellow-fg}○ Silence{/}";
    const musicInfo = state.currentTrack
      ? `🎵 ${state.currentTrack.title || state.currentTrack.file.split("/").pop()}`
      : config.fallbackSource
        ? `🎵 ${config.fallbackSource}`
        : "🔇 live-only";

    main.setContent(
      `  {bold}Streams:{/}\n` +
      `  MP3  → http://localhost:${config.httpPort}/mp3\n` +
      `  OPUS → http://localhost:${config.httpPort}/opus\n` +
      `\n` +
      `  {bold}SRT Ingest:{/} srt://localhost:${config.srtPort}?streamid=live/{cyan-fg}${config.rtmpStreamKey}{/}\n` +
      `  Use OBS → Service: Custom → Server: above\n` +
      `\n` +
      `  {bold}Buttons:{/} click with mouse or Tab+Enter\n`
    );

    side.setContent(
      ` {bold}Status:{/} ${statusColor}\n` +
      ` Listeners: {bold}${state.clients.size}{/} (mp3:${mp3Listeners} opus:${opusCount})\n` +
      ` Max: ${config.maxListeners}\n` +
      `\n` +
      ` {bold}Music:{/}\n` +
      ` ${musicInfo}\n` +
      `\n` +
      ` {bold}Uptime:{/} ${Math.floor((Date.now() - state.startTime.getTime())/1000)}s\n` +
      `\n` +
      ` {bold}Press q{/} to quit`
    );

    screen!.render();
  };

  // Hook logger to TUI logBox as well (instead of console)
  const origInfo = rtmpLog.info;
  const origWarn = rtmpLog.warn;
  const origError = rtmpLog.error;
  const origDebug = rtmpLog.debug;

  // Patch to also push to logBox (keep console for file, but also UI)
  (rtmpLog as any).info = (...args: unknown[]) => {
    origInfo(...args);
    try { logBox.log(`INFO  ${args.join(" ")}`); screen!.render(); } catch {}
  };
  (rtmpLog as any).warn = (...args: unknown[]) => {
    origWarn(...args);
    try { logBox.log(`{yellow-fg}WARN  ${args.join(" ")}{/}`); screen!.render(); } catch {}
  };
  (rtmpLog as any).error = (...args: unknown[]) => {
    origError(...args);
    try { logBox.log(`{red-fg}ERROR ${args.join(" ")}{/}`); screen!.render(); } catch {}
  };
  (rtmpLog as any).debug = (...args: unknown[]) => {
    origDebug(...args);
    // debug not shown in TUI unless needed
  };

  // Initial update + interval
  update();
  const iv = setInterval(update, 1000);

  screen!.on("destroy", () => clearInterval(iv));

  // Handle resize
  screen!.on("resize", () => {
    screen!.render();
  });

  return screen;
}

// If run directly: bun run src/tui.ts
if (import.meta.main) {
  // For standalone test, start TUI without radio (or with)
  startTui();
  // Keep alive
  setInterval(() => {}, 1000);
}
