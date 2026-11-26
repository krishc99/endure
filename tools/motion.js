// Cadence (steps/min) straight from the phone's accelerometer: no step counting, no sync lag.
// Orientation-independent (uses the magnitude of acceleration), then finds the repeat period of the motion by
// autocorrelation over the last few seconds. Of the strong repeat periods it takes the shortest, i.e. the step
// rate rather than the stride rate (two steps).
class MotionCadence {
  constructor(o = {}) {
    this.win = o.win || 4000;          // ms of motion analysed
    this.minStd = o.minStd || 0.5;     // m/s²: below this the phone is treated as still / not moving with steps
    this.rate = 100;                   // resample rate (Hz)
    this.buf = []; this.hist = []; this.lastT = 0; this.lastCalc = 0;
  }
  push(t, ax, ay, az) {                // t: ms, monotonic. a*: m/s², gravity included
    this.buf.push([t, Math.sqrt(ax * ax + ay * ay + az * az)]); this.lastT = t;
    const cut = t - this.win - 600; while (this.buf.length && this.buf[0][0] < cut) this.buf.shift();
    if (t - this.lastCalc >= 500 && this.buf.length > 30 && t - this.buf[0][0] >= this.win) { this.lastCalc = t; this._calc(t); }
  }
  _calc(t) {
    const n = Math.round(this.win / 1000 * this.rate), t0 = t - this.win, b = this.buf;
    let x = new Float64Array(n), j = 0;
    for (let i = 0; i < n; i++) {                                   // uniform 100 Hz, linear interpolation
      const ti = t0 + i * 1000 / this.rate;
      while (j < b.length - 2 && b[j + 1][0] < ti) j++;
      const a = b[j], c = b[j + 1], f = c[0] > a[0] ? Math.min(1, Math.max(0, (ti - a[0]) / (c[0] - a[0]))) : 0;
      x[i] = a[1] + (c[1] - a[1]) * f;
    }
    const hw = Math.round(this.rate * 0.5), y = new Float64Array(n);  // remove gravity/orientation drift (1 s moving mean)
    let s = 0, cnt = 0, lo = 0, hi = 0;
    for (let i = 0; i < n; i++) {
      while (hi < n && hi <= i + hw) { s += x[hi]; hi++; cnt++; }
      while (lo < i - hw) { s -= x[lo]; lo++; cnt--; }
      y[i] = x[i] - s / cnt;
    }
    for (let i = n - 1; i >= 2; i--) y[i] = (y[i] + y[i - 1] + y[i - 2]) / 3;   // light smoothing
    let e = 0; for (let i = 0; i < n; i++) e += y[i] * y[i];
    const std = Math.sqrt(e / n);
    this.std = std;
    if (std < this.minStd) { this._add(0); return; }
    const raw = this._period(y);                                   // repeat period of the whole motion
    // Foot strikes are sharp transients at EVERY step. Arm/body sway (smooth, often at the stride rate) is not.
    // So also look at the high-passed envelope: it keeps the impacts and drops the sway.
    const hw2 = Math.round(this.rate * 0.1), env = new Float64Array(n);
    let hs = 0;
    for (let i = 0; i < n; i++) {
      let sum = 0, c = 0; for (let k = Math.max(0, i - hw2); k <= Math.min(n - 1, i + hw2); k++) { sum += x[k]; c++; }
      env[i] = Math.abs(x[i] - sum / c); hs += env[i] * env[i];
    }
    this.impactStd = Math.sqrt(hs / n);
    for (let i = n - 1; i >= 4; i--) env[i] = (env[i] + env[i - 1] + env[i - 2] + env[i - 3] + env[i - 4]) / 5;
    let mean = 0; for (let i = 0; i < n; i++) mean += env[i]; mean /= n; for (let i = 0; i < n; i++) env[i] -= mean;
    const imp = this.impactStd >= 0.3 ? this._period(env) : null;
    let pick = raw;
    if (imp && imp.r >= 0.4 && (!raw || Math.abs(imp.cad - raw.cad) / raw.cad < 0.08 || Math.abs(imp.cad - 2 * raw.cad) / (2 * raw.cad) < 0.1)) pick = imp;
    if (!pick) { this._add(0); return; }
    this.quality = pick.r; this._add(pick.cad);
  }
  // Shortest strong repeat period of y, as steps/min. Lags 0.24–1.0 s = 250…60 steps/min.
  _period(y) {
    const n = y.length, L0 = 24, L1 = 100, r = new Float64Array(L1 + 2);
    for (let l = L0 - 1; l <= L1 + 1; l++) {
      let num = 0, a2 = 0, b2 = 0;
      for (let i = 0; i + l < n; i++) { num += y[i] * y[i + l]; a2 += y[i] * y[i]; b2 += y[i + l] * y[i + l]; }
      r[l] = num / Math.sqrt(a2 * b2 + 1e-12);
    }
    const peaks = []; let mx = 0;
    for (let l = L0; l <= L1; l++) if (r[l] > r[l - 1] && r[l] >= r[l + 1] && r[l] > 0.15) { peaks.push(l); mx = Math.max(mx, r[l]); }
    if (!peaks.length) return null;
    const l = peaks.find(p => r[p] >= 0.6 * mx), d = r[l - 1] - 2 * r[l] + r[l + 1];
    const lf = l + (d < 0 ? 0.5 * (r[l - 1] - r[l + 1]) / d : 0);   // sub-sample refinement
    return { cad: 6000 / lf, r: r[l] };
  }
  _add(v) { this.hist.push(v); if (this.hist.length > 5) this.hist.shift(); }
  // Smoothed cadence: median of the last few estimates. 0 = still, null = not enough data yet.
  cadence() {
    if (this.hist.length < 3) return null;
    const h = [...this.hist].sort((a, b) => a - b); return h[h.length >> 1];
  }
}
// Foot landings from the accelerometer: one event per step, with the time the foot hit the ground.
// Each landing is a sharp jolt in the total acceleration (orientation doesn't matter, so pocket, hand and armband all
// work). A landing is a local peak of the lightly smoothed jolt that is (1) tall enough relative to your recent
// steps, (2) far enough after the previous step, and (3) confirmed by ~0.1 s of signal after it.
// The repeat period from MotionCadence (above) is used as a cross-check: in a pocket the far leg's landing is much
// weaker, so if only every other step is found, the missing ones are filled in at the midpoint.
// cadence() is the median of your last few step intervals: it follows a change of pace within 3-4 steps, and only
// says 0 when steps stop for longer than a slow walking step (not when they just get gentler).
class StepTracker {
  constructor(o = {}) {
    this.minAmp = o.minAmp != null ? o.minAmp : 0.5;   // m/s²: smallest jolt that can count as a step
    this.rel = 0.3;              // a step must reach this share of your recent typical step
    this.ac = new MotionCadence({ win: 3000, minStd: 0.25 });
    this.raw = [];               // [t, |a| - g] for the smoothing window
    this.sm = [];                // [t, smoothed jolt] for peak confirmation
    this.base = null;            // slow baseline of |a| (≈ g)
    this.steps = [];             // [t, virtual?] recent steps
    this.heights = [];           // heights of recent real steps
    this.count = 0;              // steps since start
    this.cand = null;            // [t, h] peak being confirmed
    this.minSince = Infinity;    // lowest point since the last step (a real landing comes after a dip)
    this.stride = 0;             // >=3: only every other step is being found (filled in at midpoints)
    this.lastT = 0; this.lastPeak = null;
    this.onStep = null;          // callback(t, virtual)
  }
  push(t, ax, ay, az) {
    const m = Math.sqrt(ax * ax + ay * ay + az * az);
    this.ac.push(t, ax, ay, az);
    const dt = this.lastT ? Math.min(0.1, Math.max(0.001, (t - this.lastT) / 1000)) : 0.016; this.lastT = t;
    this.base = this.base == null ? m : this.base + (m - this.base) * (1 - Math.exp(-dt / 0.5));
    this.raw.push([t, m - this.base]);
    while (this.raw.length && this.raw[0][0] < t - 200) this.raw.shift();
    // centred ±35 ms average, evaluated for the newest sample that has 35 ms of signal after it
    const H = 35;
    for (let k = this.raw.length - 1; k >= 0; k--) {
      const tk = this.raw[k][0];
      if (tk > t - H) continue;
      if (this.sm.length && tk <= this.sm[this.sm.length - 1][0]) break;
      let s = 0, n = 0; for (const [ti, v] of this.raw) if (Math.abs(ti - tk) <= H) { s += v; n++; }
      this._sample(tk, s / n);
      break;
    }
  }
  expected() {                   // expected time between steps (ms), or null
    // The repeat period of the whole motion is the steadier guide (a stray swing doesn't move it), so prefer it when
    // it is clear; your recent step intervals otherwise.
    const ac = this.ac.cadence(), acI = ac && this.ac.quality >= 0.45 ? 60000 / ac : null;
    const iv = this._intervals(), md = iv.length >= 3 ? median(iv) : null;
    if (acI && md && md > 1.7 * acI && md < 2.3 * acI) return acI;   // we're finding every other step: trust the period
    return acI || md;
  }
  _intervals() {                 // the last 6 gaps between steps, leaving out pauses (> 1.8 s)
    const out = []; for (let i = 1; i < this.steps.length; i++) { const d = this.steps[i][0] - this.steps[i - 1][0]; if (d < 1800) out.push(d); }
    return out.slice(-6);
  }
  _sample(t, v) {
    this.sm.push([t, v]); while (this.sm.length && this.sm[0][0] < t - 400) this.sm.shift();
    this.minSince = Math.min(this.minSince, v);
    const exp = this.expected() || 400;
    const refr = Math.max(240, 0.62 * exp);
    const last = this.lastPeak != null ? this.lastPeak : -1e9;
    const typ = this.heights.length >= 3 ? median(this.heights) : 0;
    // sensor noise, learned while no steps are happening, so a still phone never counts steps
    if (t - last > 1500 && this.ac.std != null && this.ac.std < 0.6) this.quiet = (this.quiet || 0) + (v * v - (this.quiet || 0)) * 0.02;
    else if (t - last <= 1500 && this.quiet) this.quiet *= 0.999;   // moving again: let it fade
    const th = Math.max(this.minAmp, this.rel * typ, 5 * Math.sqrt(this.quiet || 0));
    if (this.cand && v > this.cand[1]) this.cand = [t, v];
    else if (!this.cand && v >= th && t - last >= refr) this.cand = [t, v];
    if (this.cand && t - this.cand[0] >= 100) {                       // nothing taller for 0.1 s: it was a peak
      const [pt, ph] = this.cand; this.cand = null;
      const dipped = this.minSince < ph - 0.5 * th;
      if (ph >= th && pt - last >= refr && dipped) this._step(this._landing(pt, ph), ph, pt);
    }
    // getting gentler (slowing down): when a step is overdue, the typical height halves every ~0.2 s, so softer
    // steps count again within a fraction of a second instead of the tracker going quiet
    if (this.heights.length && t - last > 1.3 * exp) {
      const k = Math.exp(-(t - (this._decT || t)) / 290); this.heights = this.heights.map(h => h * k);
    }
    this._decT = t;
  }
  // The peak is the body's hardest push, mid-stance. The foot landed earlier, where the jolt was rising through
  // the middle of its range (from the low point before it up to the peak): that's the time we report.
  _landing(pt, ph) {
    const lo = Math.min(this.minSince, 0), level = lo + 0.45 * (ph - lo), sm = this.sm;
    let i = sm.length - 1; while (i > 0 && sm[i][0] > pt) i--;
    for (; i > 0 && pt - sm[i][0] < 300; i--) {
      const [t1, v1] = sm[i - 1], [t2, v2] = sm[i];
      if (v1 < level && v2 >= level) return t1 + (t2 - t1) * (level - v1) / (v2 - v1 || 1);
    }
    return pt - 40;
  }
  _step(t, h, peakT) {
    if (peakT == null) peakT = t;
    const last = this.steps.length ? this.steps[this.steps.length - 1][0] : null;
    if (last != null && t - last < 200) return;                     // landing time moved too close to the last step
    // stride check: are we finding only every other step? (repeat period says steps come twice as often)
    const ac = this.ac.cadence();
    if (last != null && ac) {
      const acI = 60000 / ac, d = t - last, r = d / acI;
      if (r > 1.7 && r < 2.3 && this.ac.quality > 0.4) this.stride = Math.min(6, this.stride + 1);
      else if (r > 0.75 && r < 1.3) this.stride = Math.max(0, this.stride - 1);
      if (this.stride >= 2 && r > 1.7 && r < 2.3) this._emit((last + t) / 2, true);
    }
    this._emit(t, false);
    this.heights.push(h); if (this.heights.length > 8) this.heights.shift();
    this.minSince = Infinity; this.lastPeak = peakT;
  }
  _emit(t, virt) {
    this.steps.push([t, virt]); if (this.steps.length > 40) this.steps.shift();
    this.count++;
    if (this.onStep) this.onStep(t, virt);
  }
  // steps/min from your last few steps. 0 = stopped, null = not enough steps yet.
  // "Stopped" needs both: no steps for a while AND the phone has gone quiet. While you're still moving (slowing down,
  // a few missed steps) it keeps the last pace instead of dropping to 0.
  cadence(now) {
    if (now == null) now = this.lastT;
    if (!this.steps.length) return this._last0 ? 0 : null;
    const iv = this._intervals(), med = iv.length ? median(iv) : 600, gap = now - this.steps[this.steps.length - 1][0];
    const moving = (this.ac.std || 0) >= 1.0;
    if ((gap > Math.max(2000, 3 * med) && !moving) || gap > 5000) {
      this.steps = []; this.heights = []; this.stride = 0; this.lastPeak = null; this._last0 = true; this._held = null; return 0;
    }
    this._last0 = false;
    if (iv.length < 3) return this._held || null;
    return (this._held = 60000 / med);
  }
  lastStep() { return this.steps.length ? this.steps[this.steps.length - 1][0] : null; }
}
function median(a) { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; }
if (typeof module !== 'undefined') module.exports = { MotionCadence, StepTracker, median };
