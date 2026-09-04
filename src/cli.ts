#!/usr/bin/env bun
// =============================================================
// BunRadio — TUI only (mouse)
// Entry for `bun build --compile --outfile=bunradio src/cli.ts`
// =============================================================
const { startTui } = await import("./tui.ts");
try {
  await startTui();
} catch (e) {
  // If TUI fails (no TTY, no blessed), fallback to plain (but user wants TUI only, so just log)
  console.error("TUI failed, falling back to plain logs:", e);
  process.env.BUNRADIO_TUI = "0";
}
await import("./index-rtmp.ts");
