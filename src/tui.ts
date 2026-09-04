#!/usr/bin/env bun
// =============================================================
// BunRadio TUI — WORLD-CLASS CONSOLE (blessed + mouse)
// "JODER, que maravilla" edition — neon, VU, queue, progress
// =============================================================
import blessed from "blessed";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { state } from "./state";
import { rtmpLog } from "./logger";
import { setFallbackSource, fallbackPlaylist } from "./audio-router";

let screen: blessed.Widgets.Screen | null = null;
let tuiActive = false;
export function isTuiActive() { return tuiActive; }

// ── helpers ──────────────────────────────────────────────────
const NEON = {
  bg: "#0a0e14",
  cyan: "#00f5ff",
  magenta: "#ff00ff",
  yellow: "#ffd60a",
  green: "#00ff88",
  red: "#ff3b30",
  grey: "#8a8f98",
  panelBg: "#11151c",
};

function fmtTime(s: number) {
  if (!isFinite(s) || s <= 0) return "--:--";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export async function startTui(): Promise<void> {
  if (!process.stdout.isTTY) {
    tuiActive = false;
    process.env.BUNRADIO_TUI = "0";
    return;
  }
  tuiActive = true;
  process.env.BUNRADIO_TUI = "1";

  screen = blessed.screen({
    smartCSR: true,
    title: "◉ BUNRADIO — JODER, QUE MARAVILLA",
    mouse: true,
    autoPadding: true,
    dockBorders: true,
    fullUnicode: true,
    style: { bg: NEON.bg },
  });
  screen.key(["escape", "q", "C-c"], () => { screen?.destroy(); process.exit(0); });

  // ── Quick-start modal (mouse) — play vs silence ────────────
  if (process.env.FALLBACK_SOURCE === undefined) {
    const wantsChoice = await new Promise<boolean | null>((resolve) => {
      const modal = blessed.box({
        parent: screen!,
        top: "center",
        left: "center",
        width: 64,
        height: 14,
        label: "  ✦  QUICK START  ",
        tags: true,
        border: { type: "line" },
        style: { fg: "white", bg: NEON.panelBg, border: { fg: NEON.cyan }, label: { fg: NEON.cyan, bold: true } },
        shadow: true,
      });
      blessed.text({
        parent: modal,
        top: 1,
        left: 2,
        width: 58,
        height: 2,
        tags: true,
        content: "  {bold}{white-fg}¿Música cuando no estás en vivo?{/}\n  {grey-fg}Elige cómo suena tu radio en silencio{/}",
      });
      const btnYes = blessed.button({
        parent: modal,
        mouse: true, keys: true, shrink: true,
        top: 4, left: 3,
        padding: { left: 2, right: 2 },
        content: "  ▶  PLAY  —  música de fondo  ",
        style: { bg: NEON.green, fg: "#001210", bold: true, focus: { bg: NEON.yellow, fg: "#1a1200" }, hover: { bg: NEON.yellow, fg: "#1a1200" } },
        border: { type: "line" },
      });
      const btnNo = blessed.button({
        parent: modal,
        mouse: true, keys: true, shrink: true,
        top: 4, left: 33,
        padding: { left: 2, right: 2 },
        content: "  ◐  SILENCE  —  solo vivo  ",
        style: { bg: "#1a1a1a", fg: "white", focus: { bg: NEON.red, fg: "white" }, hover: { bg: NEON.red, fg: "white" } },
        border: { type: "line" },
      });
      blessed.text({
        parent: modal,
        top: 7, left: 2, width: 58, height: 1, tags: true,
        content: "{grey-fg}  ↖ Click con mouse  •  Tab + Enter  •  Esc = por defecto (silence){/}",
      });
      blessed.text({
        parent: modal,
        top: 9, left: 2, width: 58, height: 1, tags: true,
        content: "{grey-fg}  Tip: puedes cambiarlo luego con [M] Music{/}",
      });
      btnYes.on("press", () => { modal.destroy(); screen!.render(); resolve(true); });
      btnNo.on("press", () => { modal.destroy(); screen!.render(); resolve(false); });
      modal.key(["escape"], () => { modal.destroy(); screen!.render(); resolve(null); });
      btnNo.focus();
      screen!.render();
    });
    if (wantsChoice === true) {
      const cwd = process.cwd();
      const musicDefault = fs.existsSync(path.join(cwd, "musica")) ? "musica" : fs.existsSync(path.join(cwd, "music")) ? "music" : "musica";
      const folder = await new Promise<string | null>((resolve) => {
        const p = blessed.prompt({
          parent: screen!, top: "center", left: "center", width: 64, height: 9,
          label: "  ♫  Music folder  ", tags: true,
          border: { type: "line" }, style: { fg: "white", bg: NEON.panelBg, border: { fg: NEON.green } },
        });
        p.input("  Carpeta de música  (vacío = live-only)", musicDefault, (err, v) => {
          p.destroy(); screen!.render();
          if (err || v === undefined) resolve(null); else resolve(v.trim() || musicDefault);
        });
        screen!.render();
      });
      if (folder !== null) { process.env.FALLBACK_SOURCE = folder; (config as any).fallbackSource = folder; }
    } else if (wantsChoice === false) {
      process.env.FALLBACK_SOURCE = ""; (config as any).fallbackSource = "";
    }
  }

  // ── LAYOUT ─────────────────────────────────────────────────
  // Header — neon + live dot + clock
  const header = blessed.box({
    top: 0, left: 0, width: "100%", height: 5,
    tags: true, border: { type: "line" },
    style: { fg: "white", bg: NEON.bg, border: { fg: NEON.cyan } },
  });

  // Now Playing — left 32%
  const nowBox = blessed.box({
    top: 5, left: 0, width: "32%", height: "48%",
    label: "  ♫  NOW PLAYING  ", tags: true,
    border: { type: "line" }, style: { fg: "white", bg: NEON.panelBg, border: { fg: NEON.cyan }, label: { fg: NEON.cyan, bold: true } },
    padding: { left: 1, right: 1 },
  });
  const prog = blessed.progressbar({
    parent: nowBox,
    top: 8, left: 1, width: "98%", height: 1,
    orientation: "horizontal",
    filled: 0,
    pch: "█",
    style: { bar: { bg: NEON.cyan }, bg: "#0f1419", border: { fg: NEON.bg } },
    border: { type: "line" },
  });

  // Streams — center 36%
  const streamBox = blessed.box({
    top: 5, left: "32%", width: "36%", height: "48%",
    label: "  ◉  STREAMS  — click to open  ", tags: true,
    border: { type: "line" }, style: { fg: "white", bg: NEON.panelBg, border: { fg: NEON.magenta }, label: { fg: NEON.magenta, bold: true } },
    padding: { left: 1, right: 1 },
  });

  // Queue — right 32%
  const queueBox = blessed.list({
    top: 5, left: "68%", width: "32%", height: "48%",
    label: "  ≡  QUEUE  ", tags: true,
    border: { type: "line" }, style: { fg: "white", bg: NEON.panelBg, border: { fg: NEON.yellow }, label: { fg: NEON.yellow, bold: true }, selected: { bg: NEON.yellow, fg: "#1a1200", bold: true }, item: { fg: NEON.grey } },
    keys: true, mouse: true, vi: true,
    scrollbar: { ch: "▐", style: { bg: NEON.yellow } },
    noCellBorders: true,
  } as any);

  // Logs — bottom 30%
  const logBox = blessed.log({
    top: "53%", left: 0, width: "100%", height: "40%",
    label: "  ▤  LOGS  —  bunradio.log  (filtered)  ", tags: true,
    border: { type: "line" }, style: { fg: NEON.grey, bg: NEON.panelBg, border: { fg: "#2a2f3a" }, label: { fg: NEON.grey } },
    scrollable: true, alwaysScroll: true, mouse: true,
    scrollbar: { ch: "▐", style: { bg: "#2a2f3a" } },
  });

  // Footer — command bar
  const footer = blessed.box({
    bottom: 0, left: 0, width: "100%", height: 1,
    tags: true,
    content: ` {bold}{${NEON.cyan}-fg}BUNRADIO{/} {grey-fg}•{/} {bold}M{/}usic  {grey-fg}│{/} {bold}H{/}ealth  {grey-fg}│{/} {bold}Q{/}uit  {grey-fg}│{/} {bold}Tab{/} focus  {grey-fg}│{/} {bold}Click{/} buttons  {grey-fg}•  ${new Date().toLocaleTimeString()}{/}`,
    style: { fg: "white", bg: "#0f1419" },
  });

  // Buttons — MP3 + OPUS together (only these in Streams, as requested)
  const mkBtn = (opts: any) => blessed.button({
    parent: streamBox, mouse: true, keys: true, shrink: false,
    height: 3, padding: { left: 1, right: 1 }, border: { type: "line" }, align: "center", ...opts,
  });
  const btnMP3 = mkBtn({
    top: 2, left: "4%", width: "44%", content: "▶  MP3  ·  320k",
    style: { bg: NEON.green, fg: "#001210", bold: true, focus: { bg: NEON.yellow, fg: "#1a1200" }, hover: { bg: NEON.yellow, fg: "#1a1200" } },
  });
  const btnOpus = mkBtn({
    top: 2, left: "52%", width: "44%", content: "♫  OPUS  ·  96k",
    style: { bg: NEON.magenta, fg: "white", bold: true, focus: { bg: NEON.yellow, fg: "#00120a" }, hover: { bg: NEON.yellow, fg: "#00120a" } },
  });

  // Health now as colored circle in header/side, not a button
  // Music controls below Queue — Add Song / Add Folder (requested, below queue)
  const queueActionBox = blessed.box({
    top: "50%", left: "68%", width: "32%", height: 3,
    tags: true,
    style: { bg: NEON.panelBg },
  });
  const btnAddSong = blessed.button({
    parent: queueActionBox, mouse: true, keys: true, shrink: false,
    top: 0, left: "2%", width: "46%", height: 3,
    content: "+ Song", align: "center",
    padding: { left: 1, right: 1 }, border: { type: "line" },
    style: { bg: "#1e2a1e", fg: NEON.green, focus: { bg: NEON.green, fg: "#001210" }, hover: { bg: NEON.green, fg: "#001210" } },
  });
  const btnAddFolder = blessed.button({
    parent: queueActionBox, mouse: true, keys: true, shrink: false,
    top: 0, left: "52%", width: "46%", height: 3,
    content: "+ Folder", align: "center",
    padding: { left: 1, right: 1 }, border: { type: "line" },
    style: { bg: "#1e1e2a", fg: NEON.cyan, focus: { bg: NEON.cyan, fg: "#001210" }, hover: { bg: NEON.cyan, fg: "#001210" } },
  });

  // Stop — keep as requested, now as footer-right large button (not in Streams)
  const btnStop = blessed.button({
    parent: footer, mouse: true, keys: true, shrink: true,
    top: 0, left: "82%", width: 16, height: 1,
    content: " ■ STOP ", align: "center",
    style: { bg: NEON.red, fg: "white", bold: true, focus: { bg: "#ff6b6b" }, hover: { bg: "#ff6b6b" } },
    border: { type: "line" },
  });

  // ── responsive ───────────────────────────────────────────────
  const applyResponsive = () => {
    const w = (screen as any).width as number;
    const narrow = w < 100;
    const tiny = w < 70;
    if (narrow) {
      // Stack vertically — no more cut-off, buttons stay % based
      (nowBox as any).top = 5; (nowBox as any).left = 0; (nowBox as any).width = "100%"; (nowBox as any).height = "20%";
      (streamBox as any).top = "25%"; (streamBox as any).left = 0; (streamBox as any).width = "100%"; (streamBox as any).height = "22%";
      (queueBox as any).top = "47%"; (queueBox as any).left = 0; (queueBox as any).width = "100%"; (queueBox as any).height = "14%";
      (queueActionBox as any).top = "61%"; (queueActionBox as any).left = 0; (queueActionBox as any).width = "100%"; (queueActionBox as any).height = 3; (queueActionBox as any).show();
      (logBox as any).top = "64%"; (logBox as any).height = "30%";
      if (tiny) { (queueBox as any).hide(); (queueActionBox as any).hide(); (logBox as any).top = "47%"; (logBox as any).height = "46%"; }
      else { (queueBox as any).show(); (queueActionBox as any).show(); }
    } else {
      // Wide — 3 columns
      (nowBox as any).top = 5; (nowBox as any).left = 0; (nowBox as any).width = "32%"; (nowBox as any).height = "45%";
      (streamBox as any).top = 5; (streamBox as any).left = "32%"; (streamBox as any).width = "36%"; (streamBox as any).height = "45%";
      (queueBox as any).top = 5; (queueBox as any).left = "68%"; (queueBox as any).width = "32%"; (queueBox as any).height = "45%";
      (queueActionBox as any).top = "50%"; (queueActionBox as any).left = "68%"; (queueActionBox as any).width = "32%"; (queueActionBox as any).height = 3; (queueActionBox as any).show();
      (queueBox as any).show();
      (logBox as any).top = "53%"; (logBox as any).height = "40%";
    }
    screen!.render();
  };

  screen.append(header);
  screen.append(nowBox);
  screen.append(streamBox);
  screen.append(queueBox);
  screen.append(queueActionBox);
  screen.append(logBox);
  screen.append(footer);
  applyResponsive();
  btnMP3.focus();
  screen.render();
  screen.on("resize", applyResponsive);

  // ── interactions ────────────────────────────────────────────
  btnMP3.on("press", () => {
    const url = `http://localhost:${config.httpPort}/mp3`;
    logBox.log(`{${NEON.green}-fg}▶ MP3  ${url}{/}`);
    try { Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" }); } catch {}
    screen!.render();
  });
  btnOpus.on("press", () => {
    const url = `http://localhost:${config.httpPort}/opus`;
    logBox.log(`{${NEON.magenta}-fg}♫ OPUS  ${url}{/}`);
    try { Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" }); } catch {}
    screen!.render();
  });
  // Health now as circle, not button — keep health check via H key
  const doHealthCheck = async () => {
    try {
      const r = await fetch(`http://localhost:${config.httpPort}/health`);
      const j: any = await r.json();
      const ok = j.status === "ok";
      logBox.log(ok ? `{green-fg}● Health OK — ${j.listeners} listeners · ${j.fallback.currentTrack || "silence"} · ${j.uptime}s{/}` : `{red-fg}● Health FAIL{/}`);
    } catch (e) { logBox.log(`{red-fg}● Health failed: ${(e as Error).message}{/}`); }
    screen!.render();
  };

  btnStop.on("press", () => { logBox.log("{red-fg}■ Stopping…{/}"); screen!.render(); setTimeout(() => process.exit(0), 300); });

  const promptMusic = (isFile: boolean) => {
    const cwd = process.cwd();
    const cur = (config as any).fallbackSource || "";
    const def = cur || (fs.existsSync(path.join(cwd, "musica")) ? "musica" : fs.existsSync(path.join(cwd, "music")) ? "music" : "musica");
    const label = isFile ? "  ♫  Add Song  " : "  ♫  Add Folder  ";
    const msg = isFile ? "  File path (mp3/flac/wav)" : "  Folder (empty = live-only)";
    const p = blessed.prompt({
      parent: screen!, top: "center", left: "center", width: 64, height: 9,
      label, tags: true, border: { type: "line" }, style: { bg: NEON.panelBg, fg: "white", border: { fg: isFile ? NEON.green : NEON.cyan } },
    });
    p.input(msg, def, (err: any, v: any) => {
      p.destroy(); screen!.render();
      if (err || v === undefined) { logBox.log("{grey-fg}Cancelled{/}"); screen!.render(); return; }
      const val = String(v).trim();
      if (isFile) {
        // Add single song to queue
        if (!val) { logBox.log("{yellow-fg}No file given{/}"); screen!.render(); return; }
        if (!fs.existsSync(val)) { logBox.log(`{yellow-fg}File "${val}" not found{/}`); screen!.render(); return; }
        try {
          // Use fallback queue: push to queue and trigger start if needed
          const { state: st } = require("./state") as any;
          // lazy import to avoid circular
          st.fallbackQueue = st.fallbackQueue || [];
          st.fallbackQueue.push(val);
          logBox.log(`{green-fg}🎵 Added song → "${val.split("/").pop()}"{/}`);
          // If nothing playing, start
          const { startFallback } = require("./audio-router") as any;
          try { startFallback(); } catch {}
        } catch (e) { logBox.log(`{red-fg}Failed: ${(e as Error).message}{/}`); }
      } else {
        try {
          setFallbackSource(val);
          logBox.log(val === "" ? "{yellow-fg}🔇 Live-only — silence{/}" : fs.existsSync(val) ? `{green-fg}🎵 Folder → "${val}"{/}` : `{yellow-fg}Folder "${val}" not found — silence{/}`);
        } catch (e) { logBox.log(`{red-fg}Failed: ${(e as Error).message}{/}`); }
      }
      screen!.render();
    });
    screen!.render();
  };
  btnAddSong.on("press", () => promptMusic(true));
  btnAddFolder.on("press", () => promptMusic(false));

  // Global keys: M/H/Q
  screen.key(["m", "M"], () => (btnAddFolder as any).emit("press"));
  screen.key(["a", "A"], () => (btnAddSong as any).emit("press"));
  screen.key(["h", "H"], doHealthCheck);

  // ── render loop — world-class polish ────────────────────────
  let tick = 0;
  const update = () => {
    tick++;
    const blink = tick % 2 === 0;
    const dot = state.isBroadcasting ? (blink ? `{${NEON.red}-fg}●{/}` : `{grey-fg}●{/}`) : `{${NEON.yellow}-fg}○{/}`;
    const liveLabel = state.isBroadcasting ? `{${NEON.red}-fg}{bold}●  LIVE{/}` : `{${NEON.yellow}-fg}○  SILENCE{/}`;
    const opusN = [...state.clients.values()].filter(c => (c as any).tier === "opus").length;
    const mp3N = state.clients.size - opusN;
    const ut = Math.floor((Date.now() - state.startTime.getTime()) / 1000);
    const title = state.currentTrack?.title || (state.currentTrack?.file ? String(state.currentTrack.file).split("/").pop()!.replace(/\.[^/.]+$/, "") : "—");
    const artist = state.currentTrack?.artist || (config.fallbackSource ? String(config.fallbackSource) : "live-only");
    const dur = state.currentTrack?.duration || 0;
    const elap = state.currentTrack?.startedAt ? (Date.now() - state.currentTrack.startedAt) / 1000 : 0;
    const pct = dur > 0 ? Math.min(100, Math.max(0, (elap / dur) * 100)) : 0;

    // Header — neon gradient + status
    const now = new Date().toLocaleTimeString();
    header.setContent(
      `  {bold}{${NEON.cyan}-fg}◉  B U N R A D I O{/}  {grey-fg}·{/}  Ultra-Low-Latency Internet Radio  {grey-fg}·{/}  v1.0.0  {grey-fg}│{/}  ${liveLabel}  {grey-fg}│{/}  {bold}${state.clients.size}{/} listeners  {grey-fg}(${mp3N} mp3 · ${opusN} opus){/}  {grey-fg}│{/}  ${now}  {grey-fg}│{/}  {bold}Q{/}uit`
    );

    // Now Playing — progress
    (prog as any).setProgress(pct);
    nowBox.setContent(
      `{bold}{white-fg}${dot}  NOW PLAYING{/}\n` +
      `{grey-fg}────────────────────────────────{/}\n` +
      ` {bold}{white-fg}${title.slice(0, 28)}{/}\n` +
      ` {grey-fg}${artist.slice(0, 30)}{/}\n` +
      `\n` +
      ` {grey-fg}${fmtTime(elap)}  —  ${fmtTime(dur)}   {cyan-fg}${pct.toFixed(0)}%{/}\n`
    );

    // Streams
    streamBox.setContent(
      `{bold}{white-fg}  Streams  {/}{grey-fg}· click to open{/}\n` +
      `{grey-fg}────────────────────────────────{/}\n` +
      `\n` +
      `{grey-fg}  MP3  →{/}  http://localhost:{bold}${config.httpPort}{/}/mp3  {grey-fg}(320k){/}\n` +
      `{grey-fg}  OPUS →{/}  http://localhost:{bold}${config.httpPort}{/}/opus  {grey-fg}(96k eco){/}\n` +
      `\n` +
      `{grey-fg}  SRT ingest{/}  srt://localhost:{bold}${config.srtPort}{/}?streamid=live/{cyan-fg}${String(config.rtmpStreamKey).slice(0,8)}…{/}\n` +
      `  {grey-fg}OBS → Service: Custom → Server: above{/}\n`
    );
    // Buttons are % positioned, no need to re-set top on update

    // Queue
    const items = (fallbackPlaylist as string[]).slice(0, 20).map((f, i) => {
      const name = f.split("/").pop() || f;
      const isCur = state.currentTrack?.file === f;
      return isCur ? `{bold}{black-bg}{${NEON.yellow}-fg} ▶ ${name}{/}` : `   ${name}`;
    });
    if (items.length === 0) {
      (queueBox as any).setItems(["{grey-fg}  (empty — live-only){/}", "{grey-fg}  Press [M] to add music{/}"]);
    } else {
      (queueBox as any).setItems(items);
      if (state.currentTrack?.file) {
        const idx = (fallbackPlaylist as string[]).indexOf(state.currentTrack.file);
        if (idx >= 0) (queueBox as any).select(idx);
      }
    }
    (queueBox as any).setLabel(`  ≡  QUEUE  — ${fallbackPlaylist.length}  `);

    // Footer clock
    footer.setContent(` {bold}{${NEON.cyan}-fg}BUNRADIO{/} {grey-fg}·{/} {bold}M{/}usic  {grey-fg}│{/} {bold}H{/}ealth  {grey-fg}│{/} {bold}Q{/}uit  {grey-fg}│{/} {bold}Tab{/} focus  {grey-fg}│{/} {bold}Click{/} buttons  {grey-fg}·  ${now}  ·  up ${fmtTime(ut)}  ·  ${mp3N} mp3 ${opusN} opus{/}`);

    screen!.render();
  };

  // patch logger → logBox with dedup + neon
  const origInfo = rtmpLog.info, origWarn = rtmpLog.warn, origError = rtmpLog.error, origDebug = rtmpLog.debug;
  let lastLog = "", lastAt = 0, rep = 0;
  const shouldLog = (m: string) => {
    const now = Date.now();
    if (m === lastLog && now - lastAt < 2000) { rep++; return false; }
    if (rep > 0) { try { logBox.log(`{grey-fg}(repeated ${rep}x){/}`); } catch {} rep = 0; }
    lastLog = m; lastAt = now; return true;
  };
  (rtmpLog as any).info = (...a: unknown[]) => { origInfo(...a); const m = `INFO  ${a.join(" ")}`; if (!shouldLog(m)) return; try { logBox.log(m); screen!.render(); } catch {} };
  (rtmpLog as any).warn = (...a: unknown[]) => { origWarn(...a); const m = `WARN  ${a.join(" ")}`; if (!shouldLog(m)) return; try { logBox.log(`{yellow-fg}${m}{/}`); screen!.render(); } catch {} };
  (rtmpLog as any).error = (...a: unknown[]) => { origError(...a); const m = `ERROR ${a.join(" ")}`; if (!shouldLog(m)) return; try { logBox.log(`{red-fg}${m}{/}`); screen!.render(); } catch {} };
  (rtmpLog as any).debug = (...a: unknown[]) => { origDebug(...a); };

  update();
  const iv = setInterval(update, 250); // 4fps for VU + progress — silky
  screen.on("destroy", () => clearInterval(iv));
}

if (import.meta.main) { await startTui(); setInterval(()=>{}, 1000); }
