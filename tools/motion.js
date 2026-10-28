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
if (typeof module !== 'undefined') module.exports = { MotionCadence };
