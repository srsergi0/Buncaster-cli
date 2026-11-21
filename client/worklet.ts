// =============================================================
// AudioWorklet del reproductor MoQ (se carga desde un Blob: el módulo
// cliente es un único archivo).
//
// "bloom-moq-player": jitter buffer con retraso objetivo y control de ritmo.
//   - Arranca cuando hay `target` muestras; si se vacía, cuenta un rebuffer y
//     vuelve a esperar `target` (con fundido para no chasquear).
//   - El motor produce ~0,1 % más rápido que tiempo real y suelta ráfagas de
//     hasta 0,5 s en cada relevo de pista (ENGINE-BUN-WAY §5.2): por encima del
//     objetivo se reproduce hasta un 0,5 % más rápido (≈ 9 cents, interpolación
//     lineal); por debajo, hasta un 0,5 % más lento. Si se acumula más de
//     `max`, se salta al objetivo con fundido (pestaña en segundo plano, etc.).
//   - Sabe qué PTS suena en cada bloque, para estimar el retraso respecto a la
//     entrada del motor.
// "bloom-marker-detector": paso directo que detecta el inicio de un tono
//   marcador (sonda de latencia) sobre silencio. Se usa igual en modo MoQ y en
//   modo HTTP, para que las dos medidas pasen por el mismo detector.
// =============================================================
export const WORKLET_SOURCE = String.raw`
const SR = sampleRate;
class Player extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = (opts && opts.processorOptions) || {};
    this.cap = Math.ceil(SR * (o.capacitySec || 8));
    this.L = new Float32Array(this.cap);
    this.R = new Float32Array(this.cap);
    this.w = 0;            // muestras escritas (absoluto)
    this.r = 0;            // posición de lectura (absoluta, fraccionaria)
    this.target = Math.round(SR * (o.targetMs || 250) / 1000);
    this.max = Math.round(SR * (o.maxMs || 1500) / 1000);
    this.maxRate = o.maxRate || 0.005;
    this.playing = false;
    this.fade = 0;         // 0..1 ganancia actual
    this.underruns = 0; this.rebufferFrames = 0; this.skips = 0; this.skippedFrames = 0;
    this.played = 0; this.gapFrames = 0; this.rate = 1; this.started = false;
    this.skipTo = null; this.playStart = 0; this.trimmed = false; this.fadeInNext = 0;
    this.marks = [];       // [wAbs, ptsUs]
    this.lastReport = 0;
    this.port.onmessage = (e) => this.onMsg(e.data);
  }
  onMsg(m) {
    if (m.type === 'pcm') this.write(m.l, m.r, m.pts);
    else if (m.type === 'gap') {
      // Hueco (grupo perdido): fundido de 5 ms al final de lo ya escrito y no reproducido,
      // silencio del mismo largo y fundido de entrada en lo siguiente (sin chasquidos).
      const k = Math.min(240, Math.floor(this.w - this.r) - 1);
      for (let i = 0; i < k; i++) { const p = (this.w - 1 - i) % this.cap; const g = i / 240; this.L[p] *= g; this.R[p] *= g; }
      this.gapFrames += m.frames; const z = new Float32Array(Math.min(m.frames, SR)); this.write(z, z, m.pts);
      this.fadeInNext = 240;
    }
    else if (m.type === 'target') { this.target = Math.round(SR * m.targetMs / 1000); }
    else if (m.type === 'reset') { this.w = 0; this.r = 0; this.playing = false; this.marks = []; }
  }
  write(l, r, pts) {
    const n = l.length;
    if (this.w - this.r + n > this.cap) { const drop = this.w - this.r + n - this.cap; this.r += drop; this.skippedFrames += drop; this.fade = 0; }
    if (pts !== undefined) { this.marks.push([this.w, pts]); if (this.marks.length > 512) this.marks.splice(0, 256); }
    let p = this.w % this.cap;
    for (let i = 0; i < n; i++) {
      let g = 1;
      if (this.fadeInNext > 0) { g = 1 - this.fadeInNext / 240; this.fadeInNext--; }
      this.L[p] = l[i] * g; this.R[p] = r[i] * g; if (++p === this.cap) p = 0;
    }
    this.w += n;
  }
  ptsAt(pos) {
    const m = this.marks; let lo = -1;
    for (let i = m.length - 1; i >= 0; i--) if (m[i][0] <= pos) { lo = i; break; }
    if (lo < 0) return null;
    return m[lo][1] + (pos - m[lo][0]) / SR * 1e6;
  }
  process(inputs, outputs) {
    const out = outputs[0]; const oL = out[0]; const oR = out[1] || out[0]; const N = oL.length;
    let fill = this.w - this.r;
    if (!this.playing) {
      if (fill >= this.target) { this.playing = true; this.started = true; this.playStart = currentFrame; this.trimmed = false; }
      else { oL.fill(0); oR.fill(0); if (this.started) this.rebufferFrames += N; this.report(fill, null); return true; }
    }
    // Al arrancar llega de golpe el resto del grupo en curso: se recorta una vez al objetivo
    // (con fundido) en el primer medio segundo, en vez de arrastrar ese exceso durante minutos.
    if (!this.trimmed && this.skipTo === null && currentFrame - this.playStart < SR / 2 && fill > this.target + SR * 0.03) {
      this.skipTo = this.w - this.target; this.trimmed = true;
    }
    if (this.skipTo === null && fill > this.max) { this.skipTo = this.w - this.target; this.skips++; }
    const excess = (fill - this.target) / this.target;
    const dead = 0.08;
    let rate = 1;
    if (excess > dead) rate = 1 + Math.min(1, excess - dead) * this.maxRate;
    else if (excess < -dead) rate = 1 - Math.min(1, -excess - dead) * this.maxRate;
    this.rate = rate;
    const pts0 = this.ptsAt(this.r);
    const FADE = 1 / 240; // 5 ms
    for (let i = 0; i < N; i++) {
      const avail = this.w - this.r;
      if (avail < 2) {
        for (let j = i; j < N; j++) { oL[j] = 0; oR[j] = 0; }
        this.playing = false; this.underruns++; this.rebufferFrames += N - i; this.fade = 0; this.skipTo = null;
        break;
      }
      if (this.skipTo !== null) {
        this.fade -= FADE;
        if (this.fade <= 0) {
          this.fade = 0;
          const to = Math.min(this.skipTo, this.w - 2);
          if (to > this.r) { this.skippedFrames += to - this.r; this.r = to; }
          this.skipTo = null;
        }
      } else if (avail < 480) {
        this.fade = Math.max(0, this.fade - FADE); // a punto de vaciarse: fundido de salida
      } else if (this.fade < 1) {
        this.fade = Math.min(1, this.fade + FADE);
      }
      const ip = Math.floor(this.r); const f = this.r - ip; const a = ip % this.cap; const b = (ip + 1) % this.cap;
      oL[i] = (this.L[a] + (this.L[b] - this.L[a]) * f) * this.fade;
      oR[i] = (this.R[a] + (this.R[b] - this.R[a]) * f) * this.fade;
      this.r += rate; this.played++;
    }
    this.report(this.w - this.r, pts0);
    return true;
  }
  report(fill, pts) {
    if (currentFrame - this.lastReport < SR / 8) return;
    this.lastReport = currentFrame;
    this.port.postMessage({ type: 'stats', t: currentTime, fill, pts, playing: this.playing, underruns: this.underruns,
      rebufferFrames: this.rebufferFrames, skips: this.skips, skippedFrames: this.skippedFrames, played: this.played,
      gapFrames: this.gapFrames, rate: this.rate });
  }
}
registerProcessor('bloom-moq-player', Player);

class Detector extends AudioWorkletProcessor {
  constructor() { super(); this.quiet = 0; this.armed = false; this.threshold = 0.02; this.hold = SR * 0.3; }
  process(inputs, outputs) {
    const inp = inputs[0]; const out = outputs[0];
    if (!inp || inp.length === 0) { for (const c of out) c.fill(0); return true; }
    const N = inp[0].length;
    for (let c = 0; c < out.length; c++) out[c].set(inp[Math.min(c, inp.length - 1)]);
    const x = inp[0];
    for (let i = 0; i < N; i++) {
      const v = Math.abs(x[i]);
      if (v < this.threshold) { if (++this.quiet >= this.hold) this.armed = true; continue; }
      if (this.armed) { this.armed = false; this.port.postMessage({ type: 'marker', t: currentTime + i / SR, frame: currentFrame + i }); }
      this.quiet = 0;
    }
    return true;
  }
}
registerProcessor('bloom-marker-detector', Detector);
`;
