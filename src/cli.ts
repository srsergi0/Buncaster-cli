#!/usr/bin/env bun
// =============================================================
// BunRadio — CLI prompts for ports, then opens dashboard
// =============================================================
import fs from "fs";
import path from "path";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`Invalid ${name}=${raw}`);
  return n;
}

async function ask(question: string, def: string): Promise<string> {
  // If we have piped lines (e.g., printf "8082\n" | ), use them
  const piped = getPipedLines();
  if (piped.length > pipedIdx) {
    const v = piped[pipedIdx++]!.trim();
    console.log(`${question} [${def}]: ${v} (piped)`);
    return v === "" ? def : v;
  }
  const isTTY = !!process.stdin.isTTY;
  if (!isTTY) {
    console.log(`${question}: ${def} (non-TTY, using default)`);
    return def;
  }
  try {
    const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
    const ans: string = await new Promise(res => {
      const to = setTimeout(() => { try { rl.close(); } catch {}; res(""); }, 30000);
      rl.question(`${question} [${def}]: `, (a: string) => { clearTimeout(to); rl.close(); res(a); });
    });
    const trimmed = String(ans ?? "").trim();
    return trimmed === "" ? def : trimmed;
  } catch {
    console.log(`${question}: ${def} (no TTY, using default)`);
    return def;
  }
}

function isValidPort(v: string): boolean {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

// Piped input handling (e.g., printf "8082\n8083\n" | bun run)
let pipedLines: string[] | null = null;
let pipedIdx = 0;
function getPipedLines(): string[] {
  if (pipedLines !== null) return pipedLines;
  pipedLines = [];
  if (process.stdin.isTTY) return pipedLines;
  try {
    // Try to read piped data synchronously if available (non-blocking check)
    const stat = fs.fstatSync(0);
    if (stat.isFIFO() || stat.isFile()) {
      const data = fs.readFileSync(0, "utf-8");
      pipedLines = data.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
      // If we consumed stdin, we need to restore it for later readline? For now, just use pipedLines
    }
  } catch {}
  return pipedLines;
}

// Parse CLI arguments
const args = process.argv.slice(2);
let flagDashboard: string | null = null;
let flagOutput: string | null = null;
let flagSrt: string | null = null;
let noPrompt = process.env.NO_PROMPT === "1" || process.env.NO_PROMPT === "true" ||
               process.env.AUTO_START === "1" || process.env.AUTO_START === "true" ||
               process.env.CI === "1" || process.env.CI === "true";

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-y" || arg === "--yes" || arg === "--no-prompt" || arg === "-q" || arg === "--quiet") {
    noPrompt = true;
  } else if (arg === "-p" || arg === "--port") {
    const val = args[++i];
    if (val && isValidPort(val)) {
      flagDashboard = val;
      flagOutput = val;
    }
  } else if (arg === "--dashboard-port" || arg === "-d") {
    const val = args[++i];
    if (val && isValidPort(val)) flagDashboard = val;
  } else if (arg === "--output-port" || arg === "-o") {
    const val = args[++i];
    if (val && isValidPort(val)) flagOutput = val;
  } else if (arg === "--srt-port" || arg === "-s") {
    const val = args[++i];
    if (val && isValidPort(val)) flagSrt = val;
  } else if (arg === "-h" || arg === "--help") {
    console.log(`
Uso: bun run dev [opciones] o bun src/cli.ts [opciones]

Opciones:
  -y, --yes, --no-prompt       Inicia sin preguntas interactivas (usa env o defaults)
  -p, --port <puerto>          Configura el puerto web y de streams
  -d, --dashboard-port <p>     Configura el puerto del Dashboard web (default: 8080)
  -o, --output-port <p>        Configura el puerto de streams /mp3 y /opus (default: 8080)
  -s, --srt-port <p>           Configura el puerto de ingesta SRT para OBS (default: 1936)
  -h, --help                   Muestra esta ayuda

Variables de entorno:
  NO_PROMPT=true               Omite preguntas interactivas
  PORT / DASHBOARD_PORT        Puerto web
  OUTPUT_PORT / STREAM_PORT    Puerto de streams
  SRT_PORT                     Puerto de ingesta SRT
`);
    process.exit(0);
  }
}

// Defaults
const defDashboard = flagDashboard || String(envInt("DASHBOARD_PORT", envInt("PORT", 8080)));
const defOutput = flagOutput || String(envInt("OUTPUT_PORT", envInt("STREAM_PORT", Number(defDashboard))));
const defSrt = flagSrt || String(envInt("SRT_PORT", 1936));

console.log("");
console.log("  ╔══════════════════════════════════════════════════╗");
console.log("  ║           ◉  B U N R A D I O  — Setup          ║");
console.log("  ╚══════════════════════════════════════════════════╝");
console.log("");

// Prompt for ports — dashboard, outputs, SRT
let dashboardPort = defDashboard;
let outputPort = defOutput;
let srtPort = defSrt;

if (!noPrompt) {
  if (!flagDashboard) {
    let v = await ask("Dashboard port (web UI)", defDashboard);
    while (!isValidPort(v)) { console.log("  ✖ Port must be 1-65535"); v = await ask("Dashboard port (web UI)", defDashboard); }
    dashboardPort = v;
  }
  if (!flagOutput) {
    const defOut2 = outputPort === defOutput ? dashboardPort : outputPort;
    let v = await ask("Outputs port (streams /mp3 and /opus)", defOut2);
    while (!isValidPort(v)) { console.log("  ✖ Port must be 1-65535"); v = await ask("Outputs port (streams /mp3 and /opus)", defOut2); }
    outputPort = v;
  }
  if (!flagSrt) {
    let v = await ask("OBS input port (SRT ingest)", defSrt);
    while (!isValidPort(v)) { console.log("  ✖ Port must be 1-65535"); v = await ask("OBS input port (SRT ingest)", defSrt); }
    srtPort = v;
  }
} else {
  console.log("  ⚡ Modo no-interactivo activo (usando configuración de flags/env)");
}
console.log("");

// Set env for config.ts (must be before import)
process.env.DASHBOARD_PORT = dashboardPort;
process.env.OUTPUT_PORT = outputPort;
process.env.STREAM_PORT = outputPort;
process.env.PORT = dashboardPort;
process.env.SRT_PORT = srtPort;

// Also persist to .env if user wants? Not for now, just runtime

// Load config after env is set (dynamic import so it picks up new env)
const { config } = await import("./config");

// Small delay to ensure config is loaded

// Start radio
await import("./index-rtmp.ts");

// Give server a moment to bind, then open browser
const dashUrl = `http://localhost:${config.dashboardPort}/`;
const mp3Url = `http://localhost:${config.outputPort}/mp3`;
const opusUrl = `http://localhost:${config.outputPort}/opus`;
const srtUrl = `srt://127.0.0.1:${config.srtPort}?streamid=live/${config.rtmpStreamKey}`;

console.log("");
console.log(`  ✓ Dashboard: ${dashUrl}`);
console.log(`  ✓ MP3:       ${mp3Url}`);
console.log(`  ✓ OPUS:      ${opusUrl}`);
console.log(`  ✓ SRT:       ${srtUrl}`);
console.log("");

if (process.stdin.isTTY && process.stdout.isTTY) {
  console.log("  Opening dashboard in browser...");
  const url = dashUrl;
  try {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", url] : [url];
    Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore" });
  } catch (e) {
    console.log(`  Could not open browser automatically. Open ${url} manually.`);
  }
  // Also try xdg-open as fallback
  try {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
    }
  } catch {}
}

// Keep alive
setInterval(() => {}, 1000);
