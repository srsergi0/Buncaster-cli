// Requiere load-client.js junto a este archivo: bun build bench/moq/load-client.ts --target=browser --minify --outfile=<dir>/load-client.js
// Carga MoQ: node load.mjs <n> <segundos>. Imprime oyentes conectados y tramas/s.
import { chromium } from "playwright";
import net from "net"; import fs from "fs";
net.createServer((c) => { const u = net.connect(4321, "engine"); c.pipe(u).pipe(c); c.on("error", () => u.destroy()); u.on("error", () => c.destroy()); }).listen(4321, "127.0.0.1");
const n = Number(process.argv[2] ?? 50), secs = Number(process.argv[3] ?? 40);
// Una pestaña de Chromium aguanta ~50 sesiones WebTransport (más y el renderer cae):
// se reparten en pestañas de hasta PER_PAGE, cada una en su propio navegador.
const PER_PAGE = Number(process.env.PER_PAGE ?? 50);
const pages = [];
const browsers = [];
for (let left = n; left > 0; left -= PER_PAGE) {
  const b = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
  browsers.push(b);
  const p = await b.newPage();
  await p.goto("http://localhost:4321/moq/demo");
  await p.addScriptTag({ type: "module", content: fs.readFileSync(new URL("./load-client.js", import.meta.url), "utf8") });
  await p.waitForFunction(() => typeof window.runLoad === "function");
  await p.evaluate((k) => window.runLoad(k), Math.min(PER_PAGE, left));
  pages.push(p);
}
const stats = async () => {
  const all = await Promise.all(pages.map((p) => p.evaluate(() => window.loadStats()).catch(() => ({ connected: 0, failed: 0, frames: 0, errors: ["pestaña caída"] }))));
  return all.reduce((a, s) => ({ connected: a.connected + s.connected, failed: a.failed + s.failed, frames: a.frames + s.frames, errors: a.errors.concat(s.errors) }), { connected: 0, failed: 0, frames: 0, errors: [] });
};
const t0 = Date.now(); let prev = null;
while (Date.now() - t0 < secs * 1000) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = await stats();
  const fps = prev ? Math.round((s.frames - prev.frames) / 5) : null; prev = s;
  console.log(JSON.stringify({ t: Math.round((Date.now() - t0) / 1000), connected: s.connected, failed: s.failed, framesPerSec: fps, perListener: fps && s.connected ? +(fps / s.connected).toFixed(1) : null, errors: s.errors.slice(0, 3) }));
}
for (const p of pages) await p.evaluate(() => window.stopLoad()).catch(() => {});
for (const b of browsers) await b.close(); process.exit(0);
