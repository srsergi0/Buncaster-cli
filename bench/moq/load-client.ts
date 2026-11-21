// N oyentes MoQ reales (WebTransport) desde una página de Chromium, sin decodificar:
// cada uno abre su sesión, se suscribe al catálogo y al audio y cuenta tramas.
// Lo usa load.mjs; se compila con `bun build bench/moq/load-client.ts --target=browser`.
import * as Moq from "@moq/net";

const st = { started: 0, connected: 0, failed: 0, frames: 0, bytes: 0, errors: [] as string[], conns: [] as any[] };
(window as any).loadStats = () => ({ ...st, conns: undefined, errors: st.errors.slice(0, 5) });

async function one(session: any) {
  st.started++;
  try {
    const origin = new Moq.Origin.Producer();
    const conn = await Moq.Connection.connect({
      url: new URL(session.url), consume: origin, websocket: { enabled: false },
      webtransport: { serverCertificateHashes: session.serverCertificateHashes.map((h: any) => ({ algorithm: "sha-256", value: h.value })) },
    });
    st.conns.push(conn);
    const bc = origin.request(Moq.Path.from(session.broadcast));
    let active = bc.active.peek();
    while (!active) { await bc.active.changed(); active = bc.active.peek(); }
    st.connected++;
    const t = active.track(session.audioTrack).subscribe({ priority: 255, maxAge: Moq.Time.Milli(500) }).ordered();
    for (;;) { const f = await t.readFrame(); if (!f) break; st.frames++; st.bytes += f.payload.byteLength; }
  } catch (e) { st.failed++; st.errors.push(String((e as Error)?.message ?? e)); }
}

(window as any).runLoad = async (n: number, staggerMs = 25) => {
  const session = await (await fetch("/moq/session", { cache: "no-store" })).json();
  for (let i = 0; i < n; i++) { void one(session); await new Promise((r) => setTimeout(r, staggerMs)); }
};
(window as any).stopLoad = () => { for (const c of st.conns) try { c.close(); } catch {} };
