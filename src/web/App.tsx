import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Status = {
  broadcasting: boolean;
  sourceConnected: boolean;
  listeners: number;
  listenersMp3: number;
  listenersOpus: number;
  fallbackActive: boolean;
  stationName: string;
  detectedBitrateKbps: number | null;
  fallback: { active: boolean; currentTrack: string | null };
  uptimeSeconds: number;
};

const NEON = {
  bg: "#0a0e14",
  panel: "#11151c",
  cyan: "#00f5ff",
  magenta: "#ff00ff",
  yellow: "#ffd60a",
  green: "#00ff88",
  red: "#ff3b30",
  grey: "#8a8f98",
};

function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [health, setHealth] = useState<any>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [fallback, setFallback] = useState("");
  const [newSong, setNewSong] = useState("");
  const [newFolder, setNewFolder] = useState("");

  const refresh = async () => {
    try {
      const [s, h] = await Promise.all([
        fetch("/status").then(r => r.json()) as Promise<Status>,
        fetch("/health").then(r => r.json()) as Promise<any>,
      ]);
      setStatus(s as any);
      setHealth(h as any);
      if ((h as any)?.fallback) {
        setFallback((h as any).fallback?.currentTrack || "");
        setQueue((h as any).fallback?.queue || []);
      }
    } catch {}
  };

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 1000);
    return () => clearInterval(iv);
  }, []);

  const setMusicFolder = async (folder: string) => {
    const res = await fetch("/api/fallback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder }),
    });
    const j: any = await res.json();
    alert(j.message || (folder === "" ? "Live-only" : `Folder set to ${folder}`));
    refresh();
  };

  const addSong = async () => {
    if (!newSong.trim()) return alert("Enter file path");
    const res = await fetch("/api/queue/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: newSong.trim() }),
    });
    const j: any = await res.json();
    alert(j.message || "Added");
    setNewSong("");
    refresh();
  };

  const addFolder = async () => {
    if (!newFolder.trim()) return alert("Enter folder");
    await setMusicFolder(newFolder.trim());
    setNewFolder("");
  };

  const skip = async () => {
    await fetch("/api/skip", { method: "POST" });
    refresh();
  };

  const isLive = status?.broadcasting;
  const dotColor = isLive ? NEON.red : NEON.yellow;
  const dot = isLive ? "● LIVE" : "○ SILENCE";

  return (
    <div style={{ minHeight: "100vh", background: NEON.bg, color: "#e6e8eb", padding: "0" }}>
      {/* Header */}
      <header style={{ background: NEON.panel, borderBottom: `1px solid ${NEON.cyan}`, padding: "16px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 24, fontWeight: 800, color: NEON.cyan, letterSpacing: 1 }}>◉ BUNRADIO</span>
          <span style={{ color: NEON.grey, fontSize: 13 }}>Ultra-Low-Latency • v1.0.0</span>
          <span style={{ background: isLive ? NEON.red : NEON.yellow, color: isLive ? "white" : "#1a1200", padding: "2px 8px", borderRadius: 12, fontSize: 12, fontWeight: 700 }}>{dot}</span>
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 13, color: NEON.grey }}>
          <span><b style={{ color: "#fff" }}>{status?.listeners ?? 0}</b> listeners <span style={{ opacity: 0.6 }}>({status?.listenersMp3 ?? 0} mp3 · {status?.listenersOpus ?? 0} opus)</span></span>
          <span>up {status ? Math.floor(status.uptimeSeconds / 60) + ":" + String(status.uptimeSeconds % 60).padStart(2, "0") : "--:--"}</span>
        </div>
      </header>

      {/* Hero Now Playing */}
      <section style={{ margin: 24, background: NEON.panel, border: `1px solid ${NEON.cyan}`, borderRadius: 12, padding: 24, display: "grid", gridTemplateColumns: "1fr 320px", gap: 24 }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: 1, color: NEON.cyan, fontWeight: 700, marginBottom: 8 }}>♫ NOW PLAYING</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: "white", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {status?.fallbackActive ? (health?.nowPlaying?.display || health?.fallback?.currentTrack || "—") : isLive ? "🔴 LIVE" : "🔇 Silence"}
          </div>
          <div style={{ color: NEON.grey, fontSize: 13, marginTop: 4 }}>
            {isLive
              ? "Live from OBS • SRT Ingest Active"
              : health?.nowPlaying?.duration
                ? `${health.nowPlaying.artist ? `${health.nowPlaying.artist} • ` : ""}${Math.floor((health.nowPlaying.elapsed || 0) / 60)}:${String(Math.floor((health.nowPlaying.elapsed || 0) % 60)).padStart(2, '0')} / ${Math.floor((health.nowPlaying.duration || 0) / 60)}:${String(Math.floor((health.nowPlaying.duration || 0) % 60)).padStart(2, '0')}`
                : health?.fallback?.currentTrack ? `Track • ${health.fallback.currentTrack}` : "Live-only • silence until OBS"}
          </div>
          <div style={{ marginTop: 16, height: 6, background: "#0f1419", borderRadius: 6, overflow: "hidden", border: `1px solid ${NEON.bg}` }}>
            <div style={{ height: "100%", width: `${status?.fallbackActive && health?.nowPlaying ? Math.round((health.nowPlaying.progress || 0) * 100) : isLive ? 100 : 0}%`, background: isLive ? NEON.red : NEON.cyan, transition: "width 0.5s ease" }} />
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 12, fontSize: 12, color: NEON.grey }}>
            <span>MP3 320k</span><span>•</span><span>OPUS 96k eco</span><span>•</span><span style={{ color: dotColor }}>{dot}</span>
          </div>
        </div>
        <div style={{ background: "#0a0e14", borderRadius: 8, padding: 16, border: `1px solid #1a1f2a` }}>
          <div style={{ fontSize: 11, letterSpacing: 1, color: NEON.magenta, fontWeight: 700, marginBottom: 12 }}>◉ STREAMS — click to play</div>
          <a href="/mp3" target="_blank" style={{ display: "block", background: NEON.green, color: "#001210", textAlign: "center", padding: "12px 0", borderRadius: 8, fontWeight: 800, textDecoration: "none", marginBottom: 10 }}>▶  MP3  ·  320k</a>
          <a href="/opus" target="_blank" style={{ display: "block", background: NEON.magenta, color: "white", textAlign: "center", padding: "12px 0", borderRadius: 8, fontWeight: 800, textDecoration: "none" }}>♫  OPUS  ·  96k</a>
          <div style={{ fontSize: 11, color: NEON.grey, marginTop: 12, lineHeight: 1.5 }}>
            SRT ingest<br />
            <code style={{ background: "#0f1419", padding: "2px 6px", borderRadius: 4, color: NEON.cyan, fontSize: 11 }}>srt://127.0.0.1:1936?streamid=live/...</code><br />
            OBS → Service: Custom → Server: above
          </div>
        </div>
      </section>

      {/* Controls */}
      <section style={{ margin: "0 24px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ background: NEON.panel, border: `1px solid ${NEON.yellow}`, borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 11, letterSpacing: 1, color: NEON.yellow, fontWeight: 700, marginBottom: 12 }}>≡  QUEUE  — {queue.length || health?.fallback ? "•" : "empty"}</div>
          <div style={{ maxHeight: 160, overflowY: "auto", fontSize: 13, lineHeight: 1.8, color: NEON.grey }}>
            {queue.length === 0 ? (
              <div style={{ color: NEON.grey, fontStyle: "italic" }}>Empty — live-only<br /><span style={{ fontSize: 11 }}>Add music below</span></div>
            ) : (
              queue.map((f, i) => <div key={i} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: i === 0 ? NEON.yellow : NEON.grey }}>{i === 0 ? "▶ " : "  "}{f.split("/").pop()}</div>)
            )}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={() => { const v = prompt("File path (mp3/flac/wav)", newSong); if (v) { setNewSong(v); setTimeout(addSong, 0); } }} style={{ flex: 1, background: "#1e2a1e", color: NEON.green, border: `1px solid ${NEON.green}`, borderRadius: 8, padding: "8px 0", cursor: "pointer", fontWeight: 700 }}>+ Song</button>
            <button onClick={() => { const v = prompt("Folder (empty = live-only)", newFolder || "musica"); if (v !== null) { setNewFolder(v); setTimeout(addFolder, 0); } }} style={{ flex: 1, background: "#1e1e2a", color: NEON.cyan, border: `1px solid ${NEON.cyan}`, borderRadius: 8, padding: "8px 0", cursor: "pointer", fontWeight: 700 }}>+ Folder</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input value={newSong} onChange={e => setNewSong((e.target as HTMLInputElement).value)} placeholder="File path" style={{ flex: 1, background: "#0a0e14", border: "1px solid #2a2f3a", color: "white", padding: "6px 8px", borderRadius: 6, fontSize: 12 }} />
            <button onClick={addSong} style={{ background: NEON.green, color: "#001210", border: "none", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontWeight: 700 }}>Add</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input value={newFolder} onChange={e => setNewFolder((e.target as HTMLInputElement).value)} placeholder="Folder (e.g. musica)" style={{ flex: 1, background: "#0a0e14", border: "1px solid #2a2f3a", color: "white", padding: "6px 8px", borderRadius: 6, fontSize: 12 }} />
            <button onClick={addFolder} style={{ background: NEON.cyan, color: "#001210", border: "none", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontWeight: 700 }}>Set</button>
          </div>
          <button onClick={skip} style={{ width: "100%", marginTop: 12, background: "transparent", color: NEON.grey, border: `1px solid #2a2f3a`, borderRadius: 8, padding: "8px 0", cursor: "pointer" }}>Skip track →</button>
        </div>

        <div style={{ background: NEON.panel, border: `1px solid #2a2f3a`, borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 11, letterSpacing: 1, color: NEON.grey, fontWeight: 700, marginBottom: 12 }}>●  HEALTH & CONTROL</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: 13 }}>
            <div style={{ background: "#0a0e14", borderRadius: 8, padding: 12, border: `1px solid ${isLive ? NEON.red : "#1a1f2a"}` }}>
              <div style={{ color: NEON.grey, fontSize: 11 }}>STATUS</div>
              <div style={{ fontWeight: 800, color: isLive ? NEON.red : NEON.yellow, marginTop: 4 }}>{isLive ? "● LIVE" : "○ SILENCE"}</div>
              <div style={{ color: NEON.grey, fontSize: 11, marginTop: 4 }}>{status?.sourceConnected ? "SRT connected" : "SRT waiting"}</div>
            </div>
            <div style={{ background: "#0a0e14", borderRadius: 8, padding: 12 }}>
              <div style={{ color: NEON.grey, fontSize: 11 }}>LISTENERS</div>
              <div style={{ fontWeight: 800, fontSize: 20, color: "white" }}>{status?.listeners ?? 0}</div>
              <div style={{ color: NEON.grey, fontSize: 11 }}>{status?.listenersMp3 ?? 0} mp3 · {status?.listenersOpus ?? 0} opus</div>
            </div>
            <div style={{ background: "#0a0e14", borderRadius: 8, padding: 12 }}>
              <div style={{ color: NEON.grey, fontSize: 11 }}>MUSIC</div>
              <div style={{ fontWeight: 700, color: "white", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fallback || "live-only"}</div>
              <div style={{ color: NEON.grey, fontSize: 11 }}>{health?.fallback?.active ? "fallback active" : "silence"}</div>
            </div>
            <div style={{ background: "#0a0e14", borderRadius: 8, padding: 12 }}>
              <div style={{ color: NEON.grey, fontSize: 11 }}>UPTIME</div>
              <div style={{ fontWeight: 800, color: "white" }}>{status ? `${Math.floor(status.uptimeSeconds / 60)}:${String(status.uptimeSeconds % 60).padStart(2, "0")}` : "--:--"}</div>
              <div style={{ color: NEON.grey, fontSize: 11 }}>{health?.memory ? `${health.memory.rss}MB rss` : ""}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <a href="/health" target="_blank" style={{ flex: 1, background: "#1a1a2e", color: "white", textAlign: "center", padding: "8px 0", borderRadius: 8, textDecoration: "none", fontSize: 12, border: `1px solid ${NEON.cyan}` }}>Health JSON</a>
            <a href="/metrics" target="_blank" style={{ flex: 1, background: "#0f1419", color: NEON.grey, textAlign: "center", padding: "8px 0", borderRadius: 8, textDecoration: "none", fontSize: 12, border: "1px solid #2a2f3a" }}>Metrics</a>
          </div>
          <button onClick={async () => { if (confirm("Stop radio?")) { await fetch("/api/stop", { method: "POST" }); alert("Stopping…"); } }} style={{ width: "100%", marginTop: 12, background: NEON.red, color: "white", border: "none", borderRadius: 8, padding: "10px 0", cursor: "pointer", fontWeight: 800 }}>■ STOP RADIO</button>
        </div>
      </section>

      <footer style={{ margin: 24, textAlign: "center", color: NEON.grey, fontSize: 11 }}>
        BUNRADIO • Ultra-Low-Latency • Bun + TSX • <a href="/health" style={{ color: NEON.cyan, textDecoration: "none" }}>/health</a> • <a href="/mp3" style={{ color: NEON.green, textDecoration: "none" }}>/mp3</a> • <a href="/opus" style={{ color: NEON.magenta, textDecoration: "none" }}>/opus</a>
      </footer>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
