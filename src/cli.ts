#!/usr/bin/env bun
// =============================================================
// BunRadio CLI — Interactive Inquirer.js + Bundler Bun
// =============================================================
// Entry point for `bun build --compile --outfile=bunradio src/cli.ts`
// Uses Inquirer.js for interactive wizard, util.parseArgs for flags.
// Sets process.env before dynamically importing the server so
// src/config.ts (evaluated at import time) picks up CLI overrides.
// =============================================================

import { parseArgs } from "node:util";
import inquirer from "inquirer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import pkg from "../package.json" with { type: "json" };

// Version bundled via Bun (inliner)
let VERSION = (pkg as any)?.version || "0.0.0";
try {
  // fallback for compiled binary where import may be stubbed
  if (VERSION === "0.0.0") {
    const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8");
    VERSION = JSON.parse(raw).version || VERSION;
  }
} catch { /* ignore */ }

const HELP = `
  ╔══════════════════════════════════════════════════╗
  ║           🎙️  B U N R A D I O  CLI             ║
  ║      Inquirer.js + Bun bundler (single bin)    ║
  ╚══════════════════════════════════════════════════╝

Usage:
  bunradio [command] [options]
  bunradio start [options]          Start radio (default)
  bunradio --help                   Show this help
  bunradio --version                Show version

Commands:
  start                             Start radio (interactive wizard if TTY)
  health [--host URL]               Check /health endpoint (not yet, coming soon)

Options:
  -p, --port <n>                    HTTP port (env PORT, default 8080)
      --srt-port <n>                SRT port UDP (env SRT_PORT, default 1936)
      --rtmp-port <n>               RTMP port (env RTMP_PORT, default 1935, legacy)
      --host <addr>                 Bind host (env HOST, default 0.0.0.0)
      --music <path>                Fallback folder or "" for live-only (env FALLBACK_SOURCE)
      --no-music                    Shorthand for --music="" (live-only silence)
      --opus / --no-opus            Enable opus tier 96k (env ENABLE_OPUS_TIER, default true)
      --opus-bitrate <n>            Opus bitrate kbps (env OPUS_TIER_BITRATE_KBPS, default 96)
      --low-latency / --no-low-latency  Low-latency pipeline (env LOW_LATENCY, default true)
      --crossfade <s>               Crossfade seconds (env CROSSFADE_SECONDS)
      --crossfade-live <s>          Live crossfade (env CROSSFADE_LIVE_SECONDS)
      --stream-key <k>              Stream key (env RTMP_STREAM_KEY, auto if empty)
      --log-level <lvl>             debug|info|warn|error (env LOG_LEVEL)
      --max-listeners <n>           Max listeners (env MAX_LISTENERS, default 500)
  -y, --yes                         Skip wizard, use defaults/env/flags (non-interactive)
      --interactive                 Force wizard even if flags present
  -h, --help                        Show help
  -v, --version                     Show version

Examples:
  bunradio                           # interactive wizard (TTY) or zero-config (non-TTY/Docker)
  bunradio --yes                     # zero-config, no prompts
  bunradio --port 9090 --music ./musica
  bunradio --no-music                # live-only
  FALLBACK_SOURCE="" bunradio --yes  # env still works, CLI overrides env
  bunradio --port 8080 --srt-port 1936 --no-opus

Bundler:
  bun build --compile --outfile=bunradio src/cli.ts  # single binary ~85-95MB, no Node needed
  docker: oven/bun:alpine builder -> alpine:3.20 + ffmpeg
`;

// ---------- parse args (ultra-light, native) ----------
let parsed: any;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    strict: false, // allow commands like "start" as positionals
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p" },
      "srt-port": { type: "string" },
      "rtmp-port": { type: "string" },
      host: { type: "string" },
      music: { type: "string" },
      "no-music": { type: "boolean" },
      opus: { type: "boolean" },
      "opus-bitrate": { type: "string" },
      "low-latency": { type: "boolean" },
      crossfade: { type: "string" },
      "crossfade-live": { type: "string" },
      "stream-key": { type: "string" },
      "log-level": { type: "string" },
      "max-listeners": { type: "string" },
      yes: { type: "boolean", short: "y" },
      interactive: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
} catch (e) {
  console.error(`\n  ✖ ${(e as Error).message}\n`);
  console.log(HELP);
  process.exit(1);
}

const values = (parsed?.values ?? {}) as Record<string, any>;
const positionals: string[] = (parsed?.positionals ?? []) as string[];

// Handle --help / --version early (before wizard)
if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (values.version) {
  console.log(`bunradio v${VERSION}`);
  process.exit(0);
}

// Handle negated flags: yargs-style --no-opus -> parseArgs gives opus=false if --no-opus passed?
// node:util does NOT auto-handle --no-*, so we manually check raw args
const rawArgs = process.argv.slice(2);
const has = (flag: string) => rawArgs.includes(flag);
const hasNoOpus = has("--no-opus");
const hasNoLowLatency = has("--no-low-latency");
const hasNoMusic = has("--no-music") || values["no-music"];

// "start" command is default, ignore it for flag detection
const firstPos: string | undefined = positionals[0];
const command = firstPos === "start" || firstPos === "dev" ? firstPos : null;
if (positionals.length > 0 && !command && firstPos !== "health") {
  // unknown positional -> treat as error unless it's empty
  if (firstPos?.startsWith("-")) {
    // ignore, parseArgs already handled
  } else {
    console.error(`\n  ✖ Unknown command: ${firstPos}\n`);
    console.log(HELP);
    process.exit(1);
  }
}

// Health command stub
if (firstPos === "health") {
  const hostArg = values.host || `http://localhost:${values.port || process.env.PORT || 8080}`;
  console.log(`\n  health check not yet implemented — try: curl ${hostArg}/health\n`);
  process.exit(0);
}

// Determine if we should run wizard
const hasAnyFlag =
  values.port !== undefined ||
  values["srt-port"] !== undefined ||
  values["rtmp-port"] !== undefined ||
  values.host !== undefined ||
  values.music !== undefined ||
  hasNoMusic ||
  values.opus !== undefined ||
  hasNoOpus ||
  values["opus-bitrate"] !== undefined ||
  values["low-latency"] !== undefined ||
  hasNoLowLatency ||
  values.crossfade !== undefined ||
  values["crossfade-live"] !== undefined ||
  values["stream-key"] !== undefined ||
  values["log-level"] !== undefined ||
  values["max-listeners"] !== undefined;

const isTTY = process.stdin.isTTY && process.stdout.isTTY;
const shouldWizard =
  values.interactive ? true : values.yes ? false : !hasAnyFlag && isTTY;

function isValidPort(v: string): boolean {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

// ---------- interactive wizard via Inquirer.js ----------
let wizardAnswers: Record<string, any> = {};

if (shouldWizard) {
  console.log("\n  ╔══════════════════════════════════════════════════╗");
  console.log("  ║           🎙️  B U N R A D I O                  ║");
  console.log("  ║      Your radio in 10 seconds! 🚀               ║");
  console.log("  ╚══════════════════════════════════════════════════╝\n");

  // Detect music folder if exists
  const cwd = process.cwd();
  const musicDefault = process.env.FALLBACK_SOURCE ?? (() => {
    if (fs.existsSync(path.join(cwd, "musica"))) return "musica";
    if (fs.existsSync(path.join(cwd, "music"))) return "music";
    return "musica";
  })();

  try {
    // ULTRA FAST: 1-2 questions, no jargon
    wizardAnswers = await inquirer.prompt([
      {
        type: "select",
        name: "wantFallback",
        message: "Do you want music when you're not live?",
        choices: [
          { name: "✅ Yes — play background music", value: true },
          { name: "🔇 No — silence until you go live", value: false },
        ],
        default: (() => {
          const v = process.env.FALLBACK_SOURCE;
          if (v === "") return false;
          return true;
        })(),
      },
      {
        type: "input",
        name: "music",
        message: "Where is your music? (folder)",
        default: musicDefault,
        when: (answers: any) => answers.wantFallback === true,
        validate: (v: string) => v.trim() !== "" ? true : "Enter a folder, e.g. musica",
      },
    ]);

    // Done — start directly (advanced via flags: --port, --opus, etc.)
    console.log("\n  ✨ Perfect! Starting your radio...\n");
    // pequeño delay para UX ultra rápido
    await new Promise((r) => setTimeout(r, 300));
  } catch (e: any) {
    if (e?.name === "ExitPromptError" || e?.name === "CancelPromptError" || e?.message?.includes("User force closed")) {
      console.log("\n  ✖ Wizard cancelled.\n");
      process.exit(130);
    }
    console.error("\n  ✖ Wizard error:", e?.message || e);
    if (e?.stack) console.error(e.stack);
    process.exit(1);
  }
}

// ---------- merge wizard + flags + env -> process.env ----------
// Priority: CLI flags > wizard answers > existing env > defaults (handled by src/config.ts)
// We only set process.env if user provided a value; otherwise let config.ts use its default.

function setEnv(key: string, val: string | undefined) {
  if (val !== undefined && val !== "") {
    process.env[key] = String(val);
  }
}

if (shouldWizard) {
  // wizard ultra rápido: solo fallback (el resto via flags --port, --opus, etc. para avanzados)
  if (wizardAnswers.wantFallback === false) {
    process.env.FALLBACK_SOURCE = "";
  } else if (wizardAnswers.music !== undefined) {
    process.env.FALLBACK_SOURCE = String(wizardAnswers.music);
  }
  if (wizardAnswers.logLevel) process.env.LOG_LEVEL = String(wizardAnswers.logLevel);
} else {
  // non-interactive: apply flags
  if (values.port !== undefined) setEnv("PORT", String(values.port));
  if (values["srt-port"] !== undefined) setEnv("SRT_PORT", String(values["srt-port"]));
  if (values["rtmp-port"] !== undefined) setEnv("RTMP_PORT", String(values["rtmp-port"]));
  if (values.host !== undefined) setEnv("HOST", String(values.host));
  if (hasNoMusic) {
    process.env.FALLBACK_SOURCE = "";
  } else if (values.music !== undefined) {
    process.env.FALLBACK_SOURCE = String(values.music);
  }
  if (hasNoOpus) {
    process.env.ENABLE_OPUS_TIER = "false";
  } else if (values.opus !== undefined) {
    process.env.ENABLE_OPUS_TIER = values.opus ? "true" : "false";
  }
  if (values["opus-bitrate"] !== undefined) setEnv("OPUS_TIER_BITRATE_KBPS", String(values["opus-bitrate"]));
  if (hasNoLowLatency) {
    process.env.LOW_LATENCY = "false";
  } else if (values["low-latency"] !== undefined) {
    process.env.LOW_LATENCY = values["low-latency"] ? "true" : "false";
  }
  if (values.crossfade !== undefined) setEnv("CROSSFADE_SECONDS", String(values.crossfade));
  if (values["crossfade-live"] !== undefined) setEnv("CROSSFADE_LIVE_SECONDS", String(values["crossfade-live"]));
  if (values["stream-key"] !== undefined) setEnv("RTMP_STREAM_KEY", String(values["stream-key"]));
  if (values["log-level"] !== undefined) setEnv("LOG_LEVEL", String(values["log-level"]));
  if (values["max-listeners"] !== undefined) setEnv("MAX_LISTENERS", String(values["max-listeners"]));
}

// If neither wizard nor flags and non-TTY, we just keep env as is (zero-config)
// Nice log for bundler context
if (process.env.BUNRADIO_CLI !== "0") {
  // avoid noise when imported as lib
}

// ---------- launch server (dynamic import after env is set) ----------
// This must be dynamic so src/config.ts reads the updated process.env
// and src/http-server.ts binds to the correct ports.

try {
  await import("./index-rtmp.ts");
} catch (err) {
  console.error("\n  ✖ Failed to start radio:", err);
  process.exit(1);
}
