package dev.krish.rundj.bg;

import java.util.ArrayList;
import java.util.List;

/**
 * Tests the "follow your pace with energy" rule in Engine.choose (background mode). No framework needed:
 *   javac -d /tmp/rundj-java plugins/rundj-background/android/src/main/java/dev/krish/rundj/bg/Engine.java test/java/dev/krish/rundj/bg/EngineEnergyTest.java
 *   java -cp /tmp/rundj-java dev.krish.rundj.bg.EngineEnergyTest
 */
public class EngineEnergyTest {
    static int failures = 0;
    static void check(boolean ok, String what) { System.out.println((ok ? "ok   " : "FAIL ") + what); if (!ok) failures++; }

    static Engine.Song song(String id, double bpm, double energy) {
        Engine.Song s = new Engine.Song(); s.yt = id; s.title = id; s.bpm = bpm; s.energy = energy; return s;
    }
    static Engine engine(Engine.Settings st, Engine.Song... songs) {
        List<Engine.Song> l = new ArrayList<>(); for (Engine.Song s : songs) l.add(s);
        return new Engine(l, st);
    }
    static void pace(Engine e, double from, double to) {            // one reading per second for 40 s, linear drift
        e.cadHist.clear(); for (int i = 0; i < 40; i++) e.cadHist.addLast(from + (to - from) * i / 39.0);
    }
    /** Energies chosen over many picks. */
    static double[] picks(Engine e, double c, int n) {
        double min = 9, max = -9;
        for (int i = 0; i < n; i++) { Engine.Match m = e.choose(e.candidates(c, e.cur)); min = Math.min(min, m.s.energy); max = Math.max(max, m.s.energy); }
        return new double[]{min, max};
    }

    public static void main(String[] a) {
        // five songs that all fit 160 steps/min, plus one very energetic song that does NOT fit the tempo
        Engine.Song lo = song("lo", 160, 0.2), mid1 = song("mid1", 160, 0.4), cur = song("cur", 160, 0.5), hi1 = song("hi1", 160, 0.7), hi2 = song("hi2", 160, 0.9);
        Engine.Song wrongTempo = song("fast", 120, 1.0);
        Engine e = engine(new Engine.Settings(), lo, mid1, cur, hi1, hi2, wrongTempo); e.cur = cur;

        pace(e, 150, 160);                                           // pace rising
        double[] r = picks(e, 160, 300);
        check(r[0] > 0.55, "rising pace: only songs with more energy than the current one (lowest pick " + r[0] + ")");

        pace(e, 170, 160);                                           // pace falling
        r = picks(e, 160, 300);
        check(r[1] < 0.45, "falling pace: only songs with less energy (highest pick " + r[1] + ")");

        pace(e, 160, 160);                                           // steady: no preference
        r = picks(e, 160, 300);
        check(r[0] < 0.45 && r[1] > 0.55, "steady pace: no energy preference (range " + r[0] + " to " + r[1] + ")");

        pace(e, 150, 160);
        boolean sawFast = false; for (int i = 0; i < 300; i++) if (e.choose(e.candidates(160, e.cur)).s == wrongTempo) sawFast = true;
        check(!sawFast, "tempo match is untouched: a song that doesn't fit the tempo is never chosen, however energetic");

        // no-repeat order comes first: higher-energy songs already played, so the unplayed lower-energy ones are still taken
        e.played.put("hi1", 1); e.played.put("hi2", 2);
        r = picks(e, 160, 200);
        check(r[1] < 0.45, "no-repeat order beats the energy preference (rising, but only lower-energy songs are unplayed)");
        e.played.clear();

        // nothing qualifies in the wanted direction: falls back to all fitting songs
        Engine e2 = engine(new Engine.Settings(), song("a", 160, 0.1), song("b", 160, 0.2), song("c", 160, 0.3)); e2.cur = song("cur", 160, 0.9);
        pace(e2, 150, 160);
        r = picks(e2, 160, 100);
        check(r[0] > 0.29 && r[1] < 0.31, "rising but every song has lower energy: picks the closest one, 0.3 (range " + r[0] + " to " + r[1] + ")");

        // falling, only higher-energy songs fit: the closest one again
        Engine e2b = engine(new Engine.Settings(), song("a", 160, 0.6), song("b", 160, 0.8), song("c", 160, 0.95)); e2b.cur = song("cur", 160, 0.5);
        pace(e2b, 170, 160);
        r = picks(e2b, 160, 100);
        check(r[0] > 0.59 && r[1] < 0.61, "falling but every song has higher energy: picks the closest one, 0.6 (range " + r[0] + " to " + r[1] + ")");

        // a gap smaller than the minimum doesn't count
        Engine.Settings st = new Engine.Settings(); st.egap = 0.3;
        Engine e3 = engine(st, song("x", 160, 0.55), song("y", 160, 0.95), song("z", 160, 0.1)); e3.cur = song("cur", 160, 0.5);
        pace(e3, 150, 160);
        r = picks(e3, 160, 200);
        check(r[0] > 0.9, "min energy gap 0.3: only the 0.95 song is 'higher' enough (lowest pick " + r[0] + ")");

        // switched off
        st = new Engine.Settings(); st.edir = false;
        Engine e4 = engine(st, lo, mid1, cur, hi1, hi2); e4.cur = cur;
        pace(e4, 150, 160);
        r = picks(e4, 160, 300);
        check(r[0] < 0.45, "setting off: rising pace no longer narrows the choice");

        // the very start of a run has no current song
        Engine e5 = engine(new Engine.Settings(), lo, hi2);
        check(e5.choose(e5.candidates(160, null)) != null, "no current song yet: picks normally");

        System.out.println(failures == 0 ? "ALL PASSED" : failures + " FAILED");
        System.exit(failures == 0 ? 0 : 1);
    }
}
