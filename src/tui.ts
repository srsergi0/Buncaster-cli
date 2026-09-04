#!/usr/bin/env bun
// =============================================================
// BunRadio TUI — Console app with mouse buttons (blessed)
// Desde el inicio muestra: Play background music vs Silence
// =============================================================
import blessed from "blessed";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { state } from "./state";
import { rtmpLog } from "./logger";

let screen: blessed.Widgets.Screen | null = null;
let tuiActive = false;

export function isTuiActive() { return tuiActive; }

export async function startTui(): Promise<void> {
  tuiActive = true;

  screen = blessed.screen({
    smartCSR: true,
    title: "BunRadio",
    mouse: true,
    autoPadding: true,
    dockBorders: true,
  });

  screen.key(["escape", "q", "C-c"], () => {
    screen?.destroy();
    process.exit(0);
  });

  // ---- Initial choice from start: Play background music vs Silence (mouse) ----
  // Only if user hasn't already set FALLBACK_SOURCE via flags/env
  if (process.env.FALLBACK_SOURCE === undefined) {
    const wantsChoice = await new Promise<boolean | null>((resolve) => {
      const modal = blessed.box({
        parent: screen!,
        top: "center",
        left: "center",
        width: 60,
        height: 12,
        label: " Quick start ",
        tags: true,
        border: { type: "line" },
        style: { border: { fg: "cyan" }, bg: "black" },
      });

      blessed.text({
        parent: modal,
        top: 1,
        left: 2,
        width: 54,
        height: 2,
        tags: true,
        content: "Do you want music when you're {bold}not live{/}?",
        style: { fg: "white" },
      });

      const btnYes = blessed.button({
        parent: modal,
        mouse: true,
        keys: true,
        shrink: true,
        padding: { left: 2, right: 2 },
        top: 4,
        left: 4,
        content: " ✅ Yes — play background music ",
        style: {
          bg: "green",
          fg: "black",
          focus: { bg: "yellow" },
          hover: { bg: "yellow" },
        },
        border: { type: "line" },
      });

      const btnNo = blessed.button({
        parent: modal,
        mouse: true,
        keys: true,
        shrink: true,
        padding: { left: 2, right: 2 },
        top: 4,
        left: 34,
        content: " 🔇 No — silence until live ",
        style: {
          bg: "red",
          fg: "white",
          focus: { bg: "yellow", fg: "black" },
          hover: { bg: "yellow", fg: "black" },
        },
        border: { type: "line" },
      });

      blessed.text({
        parent: modal,
        top: 7,
        left: 2,
        width: 54,
        height: 1,
        tags: true,
        content: "{grey-fg}Click with mouse or Tab+Enter  •  Esc to keep default{/}",
        style: { fg: "white" },
      });

      btnYes.on("press", () => {
        modal.destroy();
        screen!.render();
        resolve(true);
      });
      btnNo.on("press", () => {
        modal.destroy();
        screen!.render();
        resolve(false);
      });

      // Esc keeps default (silence? or with music if musica exists)
      modal.key(["escape"], () => {
        modal.destroy();
        screen!.render();
        resolve(null);
      });

      btnYes.focus();
      screen!.render();
    });

    if (wantsChoice === true) {
      // Ask folder with blessed.prompt (mouse + keyboard)
      const cwd = process.cwd();
      const musicDefault = (() => {
        if (fs.existsSync(path.join(cwd, "musica"))) return "musica";
        if (fs.existsSync(path.join(cwd, "music"))) return "music";
        return "musica";
      })();

      const folder = await new Promise<string | null>((resolve) => {
        const prompt = blessed.prompt({
          parent: screen!,
          top: "center",
          left: "center",
          width: 60,
          height: 8,
          label: " Music folder ",
          tags: true,
          border: { type: "line" },
          style: { border: { fg: "green" } },
        });
        prompt.input("Where is your music? (folder)", musicDefault, (err, value) => {
          prompt.destroy();
          screen!.render();
          if (err || value === undefined) resolve(null);
          else resolve(value.trim() || musicDefault);
        });
        // blessed.prompt handles mouse via screen
        screen!.render();
      });

      if (folder !== null) {
        process.env.FALLBACK_SOURCE = folder;
        // config is already loaded (singleton) — update it directly so radio uses the chosen folder
        (config as any).fallbackSource = folder;
      }
      // if cancelled, keep default (musica)
    } else if (wantsChoice === false) {
      process.env.FALLBACK_SOURCE = "";
      (config as any).fallbackSource = "";
    } else {
      // null = Esc, keep default (will be musica or cwd via config)
    }
  }

  // ---- Main TUI layout (after initial choice) ----
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

  screen!.append(header);
  screen!.append(main);
  screen!.append(side);
  screen!.append(logBox);
  screen!.append(help);

  btnMP3.focus();
  screen!.render();

  btnMP3.on("press", () => {
    const url = `http://localhost:${config.httpPort}/mp3`;
    logBox.log(`{green-fg}▶ Opening MP3: ${url}{/}`);
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

  const update = () => {
    const opusCount = [...state.clients.values()].filter(c => c.tier === "opus").length;
    const mp3Listeners = state.clients.size - opusCount;
    const statusColor = state.isBroadcasting ? "{red-fg}● LIVE{/}" : "{yellow-fg}○ Silence{/}";
    const musicInfo = state.currentTrack
      ? `🎵 ${state.currentTrack.title || state.currentTrack.file.split("/").pop()}`
      : (process.env.FALLBACK_SOURCE === "" ? "🔇 live-only" : config.fallbackSource ? `🎵 ${config.fallbackSource}` : "🔇 live-only");

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

  const origInfo = rtmpLog.info;
  const origWarn = rtmpLog.warn;
  const origError = rtmpLog.error;
  const origDebug = rtmpLog.debug;

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
  };

  update();
  const iv = setInterval(update, 1000);

  screen!.on("destroy", () => clearInterval(iv));
  screen!.on("resize", () => {
    screen!.render();
  });

  return;
}

// If run directly: bun run src/tui.ts
if (import.meta.main) {
  await startTui();
  setInterval(() => {}, 1000);
}
