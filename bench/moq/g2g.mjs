// Glass-to-glass con sonda: inyecta N tonos marcadores en la ENTRADA del motor
// (POST /admin/api/moq/probe, MOQ_LATENCY_PROBE=true) y los detecta en la SALIDA
// del AudioContext de un Chromium real (AudioWorklet, misma ruta para MoQ y HTTP).
// Mismo host ⇒ mismo reloj de pared en motor y navegador.
// Uso (dentro de mcr.microsoft.com/playwright, en la red del banco de pruebas):
//   node g2g.mjs <moq|http> [n=10] [engine=http://engine:4321] [browser=chromium]
import { chromium, firefox } from "playwright";
import net from "net";
const mode = process.argv[2] ?? "moq";
const n = Number(process.argv[3] ?? 10);
const UPSTREAM = new URL(process.argv[4] ?? "http://engine:4321");
// WebTransport y AudioWorklet exigen contexto seguro: la página se sirve como
// http://localhost:4321 con un proxy TCP al motor (localhost cuenta como seguro).
net.createServer((c) => { const u = net.connect(Number(UPSTREAM.port || 80), UPSTREAM.hostname); c.pipe(u).pipe(c); c.on("error", () => u.destroy()); u.on("error", () => c.destroy()); }).listen(4321, "127.0.0.1");
const ENGINE = "http://localhost:4321";
const which = process.argv[5] ?? "chromium";
const spacingMs = Number(process.env.SPACING_MS ?? 2000);
const maxWaitMs = Number(process.env.MAX_WAIT_MS ?? 95000);
const auth = "Basic " + Buffer.from("admin:test").toString("base64");

const bt = which === "firefox" ? firefox : chromium;
const browser = await bt.launch({
  args: which === "firefox" ? [] : ["--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage"],
  firefoxUserPrefs: { "media.autoplay.default": 0, "media.autoplay.block-webaudio": false },
});
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.error("[page]", m.text().slice(0, 200)); });
await page.goto(`${ENGINE}/moq/demo?probe=1${process.env.TARGET ? "&target=" + process.env.TARGET : ""}`);
await page.evaluate((m) => window.startPlayer(m === "http"), mode);
const t0 = Date.now();
for (;;) {
  const s = await page.evaluate(() => window.player?.stats);
  if (s?.mode === mode && (s.firstAudioMs !== null)) break;
  if (s?.mode === "http" && mode === "moq") { console.log(JSON.stringify({ error: "cayó a HTTP", reason: s.reason })); process.exit(2); }
  if (Date.now() - t0 > 20000) { console.log(JSON.stringify({ error: "sin audio", stats: s })); process.exit(2); }
  await new Promise((r) => setTimeout(r, 200));
}
// HTTP: contar paradas del <audio> (evento waiting → playing) como rebuffering
await page.evaluate(() => {
  const a = window.player.audio; window.__stall = { n: 0, ms: 0, since: 0 };
  a.addEventListener("waiting", () => { if (!window.__stall.since) { window.__stall.n++; window.__stall.since = performance.now(); } });
  a.addEventListener("playing", () => { if (window.__stall.since) { window.__stall.ms += performance.now() - window.__stall.since; window.__stall.since = 0; } });
});
const tStart = Date.now();
await new Promise((r) => setTimeout(r, 3000));
// Desfase entre el reloj de pared del navegador (timeOrigin+now) y el de este proceso
const skew = await page.evaluate(() => performance.timeOrigin + performance.now()) - Date.now();
const injected = [];
for (let i = 0; i < n; i++) {
  const r = await (await fetch(`${ENGINE}/admin/api/moq/probe`, { method: "POST", headers: { Authorization: auth } })).json();
  if (!r.ok) throw new Error(JSON.stringify(r));
  injected.push(r.injectedAtMs);
  await new Promise((r) => setTimeout(r, spacingMs));
}
const tw = Date.now();
let markers = [];
for (;;) {
  markers = (await page.evaluate(() => window.player.stats.markers)).filter((m) => m - skew >= injected[0] - 50);
  if (markers.length >= n || Date.now() - tw > maxWaitMs) break;
  await new Promise((r) => setTimeout(r, 250));
}
const soak = Number(process.env.SOAK_MS ?? 0);
while (Date.now() - tStart < soak) await new Promise((r) => setTimeout(r, 500));
const httpStall = await page.evaluate(() => ({ n: window.__stall.n, ms: Math.round(window.__stall.ms + (window.__stall.since ? performance.now() - window.__stall.since : 0)) }));
const lat = injected.map((t, i) => (markers[i] !== undefined ? Math.round(markers[i] - skew - t) : null));
const ok = lat.filter((x) => x !== null).sort((a, b) => a - b);
const stats = await page.evaluate(() => window.player.stats);
console.log(JSON.stringify({
  mode, browser: `${which} ${browser.version()}`, n, detected: ok.length, playedS: Math.round((Date.now() - tStart) / 1000), httpStall, skewMs: Math.round(skew),
  p50: ok[Math.floor(ok.length / 2)] ?? null, min: ok[0] ?? null, max: ok[ok.length - 1] ?? null, all: lat,
  player: { transport: stats.transport, protocol: stats.protocol, targetMs: stats.targetMs, bufferedMs: stats.bufferedMs, latencyEstimateMs: stats.latencyMs, underruns: stats.underruns, rebufferMs: stats.rebufferMs, concealedMs: stats.concealedMs, skippedMs: stats.skippedMs, connectMs: stats.connectMs, firstAudioMs: stats.firstAudioMs, outputLatencyMs: stats.outputLatencyMs },
}));
await browser.close();
process.exit(0);
