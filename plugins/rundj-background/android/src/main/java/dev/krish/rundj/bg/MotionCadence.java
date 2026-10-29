package dev.krish.rundj.bg;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Cadence (steps/min) from the accelerometer: a line-for-line port of tools/motion.js, so the background mode reads
 * your pace exactly like the in-app "Phone motion" source. Orientation-independent (magnitude of acceleration),
 * autocorrelation over the last few seconds, shortest strong repeat period = the step rate.
 */
public class MotionCadence {
    double win = 4000;          // ms of motion analysed
    public double minStd = 0.5; // m/s²: below this the phone is still / not moving with steps
    final double rate = 100;    // resample rate (Hz)
    private final ArrayDeque<double[]> buf = new ArrayDeque<>();
    private final ArrayList<Double> hist = new ArrayList<>();
    private double lastCalc = 0;
    public double quality = 0, std = 0;

    public MotionCadence(double minStd) { this.minStd = minStd; }

    /** t: ms, monotonic; a*: m/s², gravity included */
    public synchronized void push(double t, double ax, double ay, double az) {
        buf.addLast(new double[]{t, Math.sqrt(ax * ax + ay * ay + az * az)});
        double cut = t - win - 600;
        while (!buf.isEmpty() && buf.peekFirst()[0] < cut) buf.pollFirst();
        if (t - lastCalc >= 500 && buf.size() > 30 && t - buf.peekFirst()[0] >= win) { lastCalc = t; calc(t); }
    }

    private void calc(double t) {
        int n = (int) Math.round(win / 1000 * rate);
        double t0 = t - win;
        double[][] b = buf.toArray(new double[0][]);
        double[] x = new double[n];
        int j = 0;
        for (int i = 0; i < n; i++) {                                   // uniform 100 Hz, linear interpolation
            double ti = t0 + i * 1000 / rate;
            while (j < b.length - 2 && b[j + 1][0] < ti) j++;
            double[] a = b[j], c = b[Math.min(j + 1, b.length - 1)];
            double f = c[0] > a[0] ? Math.min(1, Math.max(0, (ti - a[0]) / (c[0] - a[0]))) : 0;
            x[i] = a[1] + (c[1] - a[1]) * f;
        }
        int hw = (int) Math.round(rate * 0.5);                          // remove gravity / orientation drift
        double[] y = new double[n];
        double s = 0; int cnt = 0, lo = 0, hi = 0;
        for (int i = 0; i < n; i++) {
            while (hi < n && hi <= i + hw) { s += x[hi]; hi++; cnt++; }
            while (lo < i - hw) { s -= x[lo]; lo++; cnt--; }
            y[i] = x[i] - s / cnt;
        }
        for (int i = n - 1; i >= 2; i--) y[i] = (y[i] + y[i - 1] + y[i - 2]) / 3;
        double e = 0; for (double v : y) e += v * v;
        std = Math.sqrt(e / n);
        if (std < minStd) { add(0); return; }
        double[] raw = period(y);
        int hw2 = (int) Math.round(rate * 0.1);                         // foot-strike impacts: high-passed envelope
        double[] env = new double[n];
        double hs = 0;
        for (int i = 0; i < n; i++) {
            double sum = 0; int c = 0;
            for (int k = Math.max(0, i - hw2); k <= Math.min(n - 1, i + hw2); k++) { sum += x[k]; c++; }
            env[i] = Math.abs(x[i] - sum / c); hs += env[i] * env[i];
        }
        double impactStd = Math.sqrt(hs / n);
        for (int i = n - 1; i >= 4; i--) env[i] = (env[i] + env[i - 1] + env[i - 2] + env[i - 3] + env[i - 4]) / 5;
        double mean = 0; for (double v : env) mean += v; mean /= n; for (int i = 0; i < n; i++) env[i] -= mean;
        double[] imp = impactStd >= 0.3 ? period(env) : null;
        double[] pick = raw;
        if (imp != null && imp[1] >= 0.4 && (raw == null || Math.abs(imp[0] - raw[0]) / raw[0] < 0.08
                || Math.abs(imp[0] - 2 * raw[0]) / (2 * raw[0]) < 0.1)) pick = imp;
        if (pick == null) { add(0); return; }
        quality = pick[1];
        add(pick[0]);
    }

    /** Shortest strong repeat period of y as {steps/min, correlation}, lags 0.24–1.0 s. */
    private double[] period(double[] y) {
        int n = y.length, L0 = 24, L1 = 100;
        double[] r = new double[L1 + 2];
        for (int l = L0 - 1; l <= L1 + 1; l++) {
            double num = 0, a2 = 0, b2 = 0;
            for (int i = 0; i + l < n; i++) { num += y[i] * y[i + l]; a2 += y[i] * y[i]; b2 += y[i + l] * y[i + l]; }
            r[l] = num / Math.sqrt(a2 * b2 + 1e-12);
        }
        List<Integer> peaks = new ArrayList<>();
        double mx = 0;
        for (int l = L0; l <= L1; l++) if (r[l] > r[l - 1] && r[l] >= r[l + 1] && r[l] > 0.15) { peaks.add(l); mx = Math.max(mx, r[l]); }
        if (peaks.isEmpty()) return null;
        int l = peaks.get(0);
        for (int p : peaks) if (r[p] >= 0.6 * mx) { l = p; break; }
        double d = r[l - 1] - 2 * r[l] + r[l + 1];
        double lf = l + (d < 0 ? 0.5 * (r[l - 1] - r[l + 1]) / d : 0);
        return new double[]{6000 / lf, r[l]};
    }

    private void add(double v) { hist.add(v); if (hist.size() > 5) hist.remove(0); }

    /** Median of the last few estimates. 0 = still, -1 = not enough data yet. */
    public synchronized double cadence() {
        if (hist.size() < 3) return -1;
        Double[] h = hist.toArray(new Double[0]);
        Arrays.sort(h);
        return h[h.length >> 1];
    }
}
