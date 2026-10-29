package dev.krish.rundj.bg;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Random;

/**
 * The Run DJ song-choosing rules (tools/dj_live.py's engine), for background mode where the YouTube Music app plays.
 * One player, so a switch is a cut (softened by a short volume dip) instead of a crossfade; everything else follows
 * the app: tempo matching with half-time, energy weighting, hold a fitting song until its last chorus, swap at a
 * section boundary when your pace changes, enter the next song at its first chorus (tempo same/up) or at a calmer
 * phrase (tempo down).
 */
public class Engine {
    public static class Song {
        public String yt, title, artist, src;
        public double bpm, energy = 0.5, dur, firstBar = -1;
        public double[] alts = new double[0], altConf = new double[0];
        public double[][] bars;              // [time, exitScore, phraseStart, energy]
        public boolean bad;
        List<double[]> hr;                   // high-energy runs (choruses / drops), [start, end]
    }

    public static class Settings {
        public double tol = 6, min = 30, mar = 3, spread = 4, ew = 3, htpen = 4, conf = 0.5, wait = 20, lead = 1.2;
        public boolean half = true, alt = true, hold = true, rotate = true, push = true;
        public double pushMax = 8;
    }

    public static class Match { public double cost, diff, tempo, eff; public String mode; Song s; boolean push; }

    public static class Action {
        public Song song; public double entry; public String why;
        Action(Song s, double e, String w) { song = s; entry = e; why = w; }
    }

    static class Plan { Song target; boolean rot; double T; }

    public final List<Song> songs;
    public final Settings st;
    final Random rng = new Random();
    final HashMap<String, Integer> played = new HashMap<>();   // song → when it last started (this run)
    int playSeq = 0;
    final java.util.ArrayDeque<Double> cadHist = new java.util.ArrayDeque<>();   // one reading per tick (~1 s)
    Song pushSong; double pushBase;
    public Song cur;
    double curEff = 0, entryPos = 0;
    Plan plan;
    public String status = "";

    public Engine(List<Song> songs, Settings st) { this.songs = songs; this.st = st; }

    // ---------------------------------------------------------------- matching
    public Match match(Song s, double c) {
        if (s.bad) return null;
        Match r = null;
        List<double[]> cands = new ArrayList<>();
        cands.add(new double[]{s.bpm, 0});
        if (st.alt) for (int i = 0; i < s.alts.length; i++) if (s.altConf[i] >= st.conf) cands.add(new double[]{s.alts[i], 1});
        double[][] modes = st.half ? new double[][]{{1, 0}, {2, st.htpen}} : new double[][]{{1, 0}};
        for (double[] k : cands) for (double[] m : modes) {
            double diff = Math.abs(k[0] * m[0] - c);
            if (diff <= st.tol) {
                double cost = diff + k[1] + m[1] - st.ew * s.energy;
                if (r == null || cost < r.cost) {
                    r = new Match(); r.cost = cost; r.diff = diff; r.tempo = k[0]; r.eff = k[0] * m[0]; r.s = s;
                    r.mode = (m[0] == 2 ? "half-time" : "1:1") + (k[1] > 0 ? ", alt tempo" : "");
                }
            }
        }
        return r;
    }

    List<Match> candidates(double c, Song excl) {
        List<Match> out = new ArrayList<>();
        for (Song s : songs) if (s != excl) { Match m = match(s, c); if (m != null) out.add(m); }
        return out;
    }

    static Match bestOf(List<Match> a) { Match b = null; for (Match m : a) if (b == null || m.cost < b.cost) b = m; return b; }

    int lastPlayed(Song s) { Integer v = played.get(s.yt); return v == null ? -1 : v; }

    /** Songs not yet played this run first, then the one played longest ago; among those, a near-best match. */
    Match choose(List<Match> cands) {
        if (cands == null || cands.isEmpty()) return null;
        int oldest = Integer.MAX_VALUE;
        for (Match m : cands) oldest = Math.min(oldest, lastPlayed(m.s));
        List<Match> fresh = new ArrayList<>();
        for (Match m : cands) if (lastPlayed(m.s) == oldest) fresh.add(m);
        Match b = bestOf(fresh);
        List<Match> near = new ArrayList<>();
        for (Match m : fresh) if (m.cost <= b.cost + st.spread) near.add(m);
        return near.get(rng.nextInt(near.size()));
    }

    /** Not-yet-played songs a little faster than c (just above the tolerance, up to +pushMax): the smallest step up. */
    Match nudge(double c, Song excl) {
        List<Match> out = new ArrayList<>();
        for (Song s : songs) {
            if (s == excl || s.bad || lastPlayed(s) >= 0) continue;
            Match best = null;
            List<double[]> ks = new ArrayList<>(); ks.add(new double[]{s.bpm, 0});
            if (st.alt) for (int i = 0; i < s.alts.length; i++) if (s.altConf[i] >= st.conf) ks.add(new double[]{s.alts[i], 1});
            double[][] modes = st.half ? new double[][]{{1, 0}, {2, st.htpen}} : new double[][]{{1, 0}};
            for (double[] k : ks) for (double[] m : modes) {
                double e = k[0] * m[0], up = e - c;
                if (up > st.tol && up <= st.tol + st.pushMax) {
                    double cost = up + k[1] + m[1] - st.ew * s.energy;
                    if (best == null || cost < best.cost) { best = new Match(); best.cost = cost; best.diff = up; best.tempo = k[0]; best.eff = e; best.s = s; best.push = true; best.mode = (m[0] == 2 ? "half-time" : "1:1") + ", tempo nudge"; }
                }
            }
            if (best != null) out.add(best);
        }
        if (out.isEmpty()) return null;
        double lo = Double.MAX_VALUE; for (Match m : out) lo = Math.min(lo, m.diff);
        Match pick = null; for (Match m : out) if (m.diff <= lo + 1.5 && (pick == null || m.cost < pick.cost)) pick = m;
        return pick;
    }

    /** {steady, slowing} over the last minute of readings. */
    boolean[] trend() {
        Double[] v = cadHist.toArray(new Double[0]);
        int n = Math.min(v.length, 60);
        if (n < 20) return new boolean[]{false, false};
        double mn = 1e9, mx = -1e9, a = 0, b = 0;
        for (int i = v.length - n; i < v.length; i++) { mn = Math.min(mn, v[i]); mx = Math.max(mx, v[i]); }
        for (int i = v.length - n; i < v.length - n + 15; i++) a += v[i];
        for (int i = v.length - 15; i < v.length; i++) b += v[i];
        boolean slowing = b / 15 - a / 15 < -1.5;
        return new boolean[]{mx - mn <= 5 && !slowing, slowing};
    }

    // ---------------------------------------------------------------- structure
    static double lv(double[] b) { return b[3]; }

    static List<double[]> highRuns(Song s) {
        if (s.hr != null) return s.hr;
        List<double[]> runs = new ArrayList<>();
        if (s.bars != null) {
            int start = -1;
            for (int i = 0; i < s.bars.length; i++) {
                if (lv(s.bars[i]) >= 0.75) { if (start < 0) start = i; }
                else if (start >= 0) { if (i - start >= 3) runs.add(new double[]{s.bars[start][0], s.bars[i][0]}); start = -1; }
            }
            int last = s.bars.length - 1;
            if (start >= 0 && last - start >= 3) runs.add(new double[]{s.bars[start][0], s.bars[last][0]});
        }
        return s.hr = runs;
    }

    static double[] barAt(Song s, double t) {
        double[] r = s.bars[0];
        for (double[] b : s.bars) { if (b[0] <= t) r = b; else break; }
        return r;
    }

    String dirOf(Match x) {
        if (curEff <= 0) return "same";
        double r = x.eff / curEff;
        return r > 1.03 ? "up" : r < 0.97 ? "down" : "same";
    }

    /** Where the next song comes in. */
    public static double[] pickEntry(Song s, double lo, String dir) {     // {time, reasonCode}
        double t = s.firstBar >= 0 ? s.firstBar : 0; int why = 0;           // 0 first bar, 1 chorus, 2 calmer, 3 quarter
        if (s.bars != null && s.bars.length > 0) {
            if (dir.equals("down")) {
                double tg = Math.max(0.2, lo - 0.25); double[] best = null;
                for (double[] b : s.bars) if (b[2] == 1 && b[0] <= 0.7 * (s.dur > 0 ? s.dur : 1e9))
                    if (best == null || Math.abs(lv(b) - tg) < Math.abs(lv(best) - tg) - 1e-9) best = b;
                if (best != null) { t = best[0]; why = 2; }
            } else {
                List<double[]> h = highRuns(s);
                if (!h.isEmpty()) { t = h.get(0)[0]; why = 1; }
            }
        } else if (!dir.equals("down") && s.dur > 90) {
            double bar = 240 / (s.bpm > 0 ? s.bpm : 120);
            t = Math.round(Math.min(45, 0.25 * s.dur) / bar) * bar; why = 3;
        }
        return new double[]{t, why};
    }

    /** Where the current song is left: the end of its last chorus (steady pace) or the next section boundary. */
    double pickExit(double pos, String dir, boolean rot) {
        Song s = cur;
        double tmin = Math.max(entryPos + st.min, pos + 1);
        if (rot) {
            List<double[]> hr = highRuns(s);
            if (!hr.isEmpty()) {
                double end = hr.get(hr.size() - 1)[1];
                if (end >= tmin) return end;
                if (s.bars != null) for (double[] b : s.bars) if (b[0] >= tmin) return b[0];
                return tmin;
            }
            return Math.max(tmin, 0.75 * s.dur);
        }
        if (s.bars == null || s.bars.length == 0) return tmin;
        List<double[]> c = new ArrayList<>();
        for (double[] b : s.bars) if (b[0] >= tmin) c.add(b);
        if (c.isEmpty()) return tmin;
        List<double[]> hr = highRuns(s);
        double[] b = pickIn(c, st.wait, dir, hr);
        if (!dir.equals("down") && lv(b) < 0.55) b = pickIn(c, 3 * st.wait, dir, hr);
        return b[0];
    }

    private static double[] pickIn(List<double[]> c, double w, String dir, List<double[]> hr) {
        double[] best = null; double bv = -1e9, t0 = c.get(0)[0];
        for (double[] b : c) {
            if (b[0] > t0 + w) break;
            boolean after = false; for (double[] r : hr) if (Math.abs(r[1] - b[0]) < 0.02) after = true;
            double v = 0.4 * b[1] + 0.6 * (dir.equals("down") ? 1 - lv(b) : lv(b)) + (!dir.equals("down") && after ? 0.35 : 0);
            if (best == null || v > bv + 1e-9) { best = b; bv = v; }
        }
        return best;
    }

    // ---------------------------------------------------------------- the loop
    /**
     * Called about once a second. c: cadence (steps/min, 0 = standing, <0 unknown). pos: seconds into the current
     * song as YouTube Music reports it. ended: YouTube Music finished it or moved on by itself.
     * Returns a song to start now, or null.
     */
    public Action tick(double c, double pos, boolean ended) {
        if (songs.isEmpty()) { status = "No YouTube Music songs in the library."; return null; }
        if (cur == null) {
            if (c < 40) { status = c < 0 ? "Reading your pace…" : "Start running: waiting for steps"; return null; }
            List<Match> cs = candidates(c, null);
            Match b = bestOf(cs);
            if (b == null) { status = "Nothing fits " + Math.round(c) + " steps/min"; return null; }
            return begin(choose(cs), 0, 0, "start");
        }
        if (c < 40) { plan = null; status = c < 0 ? "Reading your pace…" : "Standing: keeping the song"; return null; }
        cadHist.addLast(c); while (cadHist.size() > 90) cadHist.pollFirst();
        boolean[] tr = trend();
        Match mc = match(cur, c);
        if (mc == null && cur == pushSong && !tr[1] && c >= pushBase - 2) {     // a nudged song fits while you adapt
            mc = new Match(); mc.s = cur; mc.eff = curEff; mc.tempo = cur.bpm; mc.diff = Math.abs(curEff - c); mc.cost = mc.diff; mc.mode = "tempo nudge";
        }
        boolean ok = mc != null;
        List<Match> cs = candidates(c, cur);
        Match best = bestOf(cs);
        boolean needSwap = best != null && (!ok || (!st.hold && best.cost + st.mar <= mc.cost));
        List<Match> pool = null; boolean rot = false;
        if (needSwap) pool = cs;                                         // pace changed: any song that fits
        else if (st.rotate && ok && best != null) { pool = cs; rot = true; } // steady pace: after the last chorus
        boolean allPlayed = true; for (Match m : cs) if (lastPlayed(m.s) < 0) allPlayed = false;
        if (!needSwap && st.rotate && ok && st.push && tr[0] && allPlayed) {  // nothing new at this pace: a little faster
            Match nu = nudge(c, cur);
            if (nu != null) { pool = new ArrayList<>(); pool.add(nu); rot = true; }
        }
        if (pool == null || pool.isEmpty()) plan = null;
        else {
            boolean stillIn = false;
            if (plan != null) for (Match m : pool) if (m.s == plan.target) stillIn = true;
            if (plan == null || plan.rot != rot || !stillIn) {
                Match x = choose(pool);
                plan = new Plan(); plan.target = x.s; plan.rot = rot; plan.T = pickExit(pos, dirOf(x), rot);
            }
        }
        double dur = cur.dur;
        if (ended || (dur > 0 && pos >= dur - 1.5)) {
            Match nx = null;
            if (plan != null) { nx = match(plan.target, c); if (nx == null) nx = nudgeMatch(plan.target, c); }
            if (nx == null) nx = choose(cs);
            if (nx == null && ok) nx = mc;                                  // repeat only if nothing else fits
            if (nx == null) { status = "Song ended; nothing fits " + Math.round(c) + " steps/min"; cur = null; return null; }
            return next(nx, pos, "song ended");
        }
        if (plan != null && pos >= plan.T - st.lead) {
            Match x = match(plan.target, c);
            if (x == null) x = nudgeMatch(plan.target, c);
            if (x != null) return next(x, pos, x.push ? "every song at your pace has played: a little faster" : plan.rot ? "after its last chorus" : "your pace changed");
            plan = null;
        }
        status = (ok ? "" : "Pace " + Math.round(c) + " is outside this song's range. ")
                + (plan != null ? "Next: " + plan.target.title + " at " + fmt(plan.T) : ok ? "Holding this song" : "Nothing else fits yet");
        return null;
    }

    private Action next(Match x, double pos, String reason) {
        String dir = dirOf(x);
        double lo = cur.bars != null && cur.bars.length > 0 ? lv(barAt(cur, pos)) : 0.5;
        double[] e = pickEntry(x.s, lo, dir);
        String[] whyTxt = {"its start", "its first chorus", "a calmer section", "about a quarter in"};
        return begin(x, e[0], (int) e[1], reason + " · " + dir + " tempo · enters at " + whyTxt[(int) e[1]]);
    }

    Match nudgeMatch(Song s, double c) { Match n = nudge(c, cur); return n != null && n.s == s ? n : null; }

    private Action begin(Match x, double entry, int why, String reason) {
        cur = x.s; curEff = x.eff; entryPos = entry; plan = null;
        if (x.push) { pushSong = x.s; pushBase = cadHist.isEmpty() ? 0 : cadHist.peekLast(); } else pushSong = null;
        played.put(x.s.yt, ++playSeq);
        status = "Playing " + x.s.title;
        return new Action(x.s, entry, reason + " (" + x.mode + ", off by " + Math.round(x.diff) + ")");
    }

    /** YouTube Music could not play the song: skip it for this run. */
    public void failed(Song s) { s.bad = true; if (cur == s) { cur = null; plan = null; } }

    static String fmt(double t) { int s = (int) Math.max(0, t); return (s / 60) + ":" + String.format("%02d", s % 60); }
}
