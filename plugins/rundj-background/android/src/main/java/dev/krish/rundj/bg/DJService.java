package dev.krish.rundj.bg;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.PixelFormat;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Background mode: runs with the app closed and the screen off. Reads your cadence from the accelerometer (or the
 * step detector), picks songs with {@link Engine}, and has the YouTube Music app play them (your Premium allows
 * background play there): it opens the song in YouTube Music, then jumps to the chosen entry point with the
 * standard Android media controls. Shown as a notification with a Stop button.
 */
public class DJService extends Service implements SensorEventListener {
    public static final String ACTION_STOP = "dev.krish.rundj.bg.STOP";
    public static final String YTM = "com.google.android.apps.youtube.music";
    static final String CHANNEL = "rundj_background";
    static final int NOTIF_ID = 4711;

    public interface Listener { void on(JSONObject state); }
    public static volatile Listener listener;
    public static volatile boolean running = false;
    public static volatile JSONObject lastState;

    private final Handler main = new Handler(Looper.getMainLooper());
    private HandlerThread sensorThread;
    private SensorManager sm;
    private PowerManager.WakeLock wake;
    private View pixel;
    private MotionCadence motion;
    private final ArrayList<Long> steps = new ArrayList<>();
    private boolean useSteps = false;
    private long lastSensorMs = 0;

    private Engine engine;
    private Engine.Song pending;           // waiting for YouTube Music to start it
    private double pendingEntry;
    private long pendingSince;
    private boolean triedSearch;
    private String prevKey = "", curKey = null;   // YouTube Music's title before the switch / for the song we started
    private boolean dip = true;
    private int savedVolume = -1;
    private long lastNotif = 0;
    private final ArrayList<String> logs = new ArrayList<>();

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        if (running) return START_NOT_STICKY;
        running = true;
        startInForeground("Starting…");
        try { load(); } catch (Exception e) { log("Could not read the library: " + e.getMessage()); stopSelf(); return START_NOT_STICKY; }
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RunDJ:background");
        wake.acquire(4 * 60 * 60 * 1000L);     // at most 4 hours
        startSensors();
        showPixel();
        log("Background mode on: " + engine.songs.size() + " songs, cadence from " + (useSteps ? "the step detector" : "phone motion"));
        if (ytm() == null) log("YouTube Music isn't visible to Run DJ yet. Is notification access on?");
        main.post(tick);
        return START_NOT_STICKY;
    }

    // ------------------------------------------------------------------ library + settings from the app
    private void load() throws Exception {
        File f = new File(getFilesDir(), "rundj_background.json");
        byte[] buf = new byte[(int) f.length()];
        try (FileInputStream in = new FileInputStream(f)) { int off = 0; while (off < buf.length) { int n = in.read(buf, off, buf.length - off); if (n < 0) break; off += n; } }
        JSONObject root = new JSONObject(new String(buf, StandardCharsets.UTF_8));
        JSONObject s = root.optJSONObject("settings");
        if (s == null) s = new JSONObject();
        Engine.Settings st = new Engine.Settings();
        st.tol = s.optDouble("tol", st.tol); st.min = s.optDouble("min", st.min); st.mar = s.optDouble("mar", st.mar);
        st.spread = s.optDouble("spread", st.spread); st.ew = s.optDouble("ew", st.ew); st.htpen = s.optDouble("htpen", st.htpen);
        st.conf = s.optDouble("conf", st.conf); st.wait = s.optDouble("wait", st.wait);
        st.push = s.optBoolean("push", true); st.pushMax = s.optDouble("pushMax", 8);
        st.half = s.optBoolean("half", true); st.alt = s.optBoolean("alt", true); st.hold = s.optBoolean("hold", true); st.rotate = s.optBoolean("rotate", true);
        st.edir = s.optBoolean("edir", true); st.egap = s.optDouble("egap", st.egap);
        dip = s.optBoolean("dip", true);
        st.lead = dip ? 1.2 : 0.3;
        useSteps = "ped".equals(s.optString("source", "motion"));
        motion = new MotionCadence(s.optDouble("minStd", 0.5));
        List<Engine.Song> songs = new ArrayList<>();
        JSONArray arr = root.optJSONArray("songs");
        for (int i = 0; arr != null && i < arr.length(); i++) {
            JSONObject o = arr.getJSONObject(i);
            if (o.optString("yt", "").isEmpty() || o.optDouble("bpm", 0) <= 0) continue;
            Engine.Song g = new Engine.Song();
            g.yt = o.getString("yt"); g.title = o.optString("title", "?"); g.artist = o.optString("artist", "");
            g.bpm = o.getDouble("bpm"); g.energy = o.optDouble("energy", 0.5); g.dur = o.optDouble("dur", 0);
            g.firstBar = o.isNull("first_bar") ? -1 : o.optDouble("first_bar", -1); g.src = o.optString("src", "");
            JSONArray al = o.optJSONArray("alts");
            if (al != null) {
                g.alts = new double[al.length()]; g.altConf = new double[al.length()];
                for (int k = 0; k < al.length(); k++) { JSONObject a = al.getJSONObject(k); g.alts[k] = a.optDouble("bpm"); g.altConf[k] = a.optDouble("conf", 0); }
            }
            JSONArray bs = o.optJSONArray("bars");
            if (bs != null && bs.length() > 0) {
                g.bars = new double[bs.length()][];
                for (int k = 0; k < bs.length(); k++) { JSONArray b = bs.getJSONArray(k); g.bars[k] = new double[]{b.getDouble(0), b.getDouble(1), b.getDouble(2), b.isNull(3) ? 0.5 : b.getDouble(3)}; }
            }
            songs.add(g);
        }
        engine = new Engine(songs, st);
    }

    // ------------------------------------------------------------------ cadence sensors (keep running with the screen off)
    private void startSensors() {
        sm = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        sensorThread = new HandlerThread("rundj-sensors");
        sensorThread.start();
        Handler h = new Handler(sensorThread.getLooper());
        Sensor s = useSteps ? sm.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR) : sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        if (s == null && useSteps) { useSteps = false; s = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER); log("No step detector on this phone: using phone motion"); }
        if (s == null) { log("This phone has no accelerometer"); return; }
        sm.registerListener(this, s, useSteps ? SensorManager.SENSOR_DELAY_NORMAL : SensorManager.SENSOR_DELAY_GAME, h);
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        long ms = e.timestamp / 1_000_000L;
        lastSensorMs = SystemClock.elapsedRealtime();
        if (e.sensor.getType() == Sensor.TYPE_STEP_DETECTOR) {
            synchronized (steps) { steps.add(ms); while (steps.size() > 60) steps.remove(0); }
        } else {
            motion.push(ms, e.values[0], e.values[1], e.values[2]);
        }
    }
    @Override public void onAccuracyChanged(Sensor s, int a) { }

    private double cadence() {
        if (SystemClock.elapsedRealtime() - lastSensorMs > 3000 && !useSteps) return -1;
        if (!useSteps) return motion.cadence();
        long now = SystemClock.elapsedRealtimeNanos() / 1_000_000L;
        synchronized (steps) {
            if (steps.isEmpty()) return -1;
            if (now - steps.get(steps.size() - 1) > 4000) return 0;
            int n = 0; long first = now;
            for (long t : steps) if (t >= now - 10000) { n++; first = Math.min(first, t); }
            return n < 3 ? -1 : (n - 1) * 60000.0 / Math.max(3000, now - first);
        }
    }

    // ------------------------------------------------------------------ YouTube Music
    private MediaController ytm() {
        try {
            MediaSessionManager msm = (MediaSessionManager) getSystemService(Context.MEDIA_SESSION_SERVICE);
            for (MediaController c : msm.getActiveSessions(new ComponentName(this, NotifListener.class)))
                if (YTM.equals(c.getPackageName())) return c;
        } catch (SecurityException e) { /* notification access not granted */ }
        return null;
    }

    static String key(String t) {
        return t == null ? "" : t.toLowerCase().replaceAll("[\\(\\[][^\\)\\]]*[\\)\\]]", " ").replaceAll("[^a-z0-9]+", "");
    }

    private static boolean sameSong(MediaController c, Engine.Song s) {
        MediaMetadata md = c.getMetadata();
        if (md == null || s == null) return false;
        String a = key(md.getString(MediaMetadata.METADATA_KEY_TITLE)), b = key(s.title);
        if (a.isEmpty() || b.isEmpty()) return false;
        return a.equals(b) || a.contains(b) || b.contains(a) || (a.length() > 10 && b.length() > 10 && a.substring(0, 10).equals(b.substring(0, 10)));
    }

    private static String titleKey(MediaController c) {
        MediaMetadata md = c.getMetadata();
        return md == null ? "" : key(md.getString(MediaMetadata.METADATA_KEY_TITLE));
    }

    private static double position(MediaController c) {
        PlaybackState ps = c.getPlaybackState();
        if (ps == null) return -1;
        double p = ps.getPosition();
        if (ps.getState() == PlaybackState.STATE_PLAYING)
            p += (SystemClock.elapsedRealtime() - ps.getLastPositionUpdateTime()) * ps.getPlaybackSpeed();
        return p / 1000.0;
    }

    /** Ask YouTube Music to play this exact song (by its video ID). */
    private void open(Engine.Song s) {
        Uri uri = Uri.parse("https://music.youtube.com/watch?v=" + s.yt);
        MediaController c = ytm();
        PlaybackState ps = c != null ? c.getPlaybackState() : null;
        if (ps != null && (ps.getActions() & PlaybackState.ACTION_PLAY_FROM_URI) != 0) {
            c.getTransportControls().playFromUri(uri, null);
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, uri).setPackage(YTM).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            log("Could not open YouTube Music: " + e.getMessage());
        }
    }

    /** Fallback when Android blocked opening the song: YouTube Music's own search ("play X"). */
    private void searchPlay(Engine.Song s) {
        MediaController c = ytm();
        if (c == null) return;
        Bundle b = new Bundle();
        b.putString(MediaStore.EXTRA_MEDIA_TITLE, s.title);
        b.putString(MediaStore.EXTRA_MEDIA_ARTIST, s.artist);
        b.putString(MediaStore.EXTRA_MEDIA_FOCUS, MediaStore.Audio.Media.ENTRY_CONTENT_TYPE);
        c.getTransportControls().playFromSearch(s.title + " " + s.artist, b);
    }

    // ------------------------------------------------------------------ volume dip instead of a crossfade
    private void ramp(int from, int to, long ms, Runnable then) {
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        int steps = Math.max(1, Math.abs(to - from));
        for (int i = 1; i <= steps; i++) {
            final int v = from + (to - from) * i / steps;
            main.postDelayed(() -> { try { am.setStreamVolume(AudioManager.STREAM_MUSIC, v, 0); } catch (Exception ignored) { } }, ms * i / steps);
        }
        if (then != null) main.postDelayed(then, ms + 30);
    }
    private void dipDown(Runnable then) {
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (!dip) { then.run(); return; }
        if (savedVolume < 0) savedVolume = am.getStreamVolume(AudioManager.STREAM_MUSIC);
        ramp(savedVolume, Math.max(1, savedVolume / 5), 1000, then);
    }
    private void dipUp() {
        if (!dip || savedVolume < 0) return;
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        int now = am.getStreamVolume(AudioManager.STREAM_MUSIC), to = savedVolume;
        savedVolume = -1;
        ramp(now, to, 1200, null);
    }

    // ------------------------------------------------------------------ the loop (once a second)
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!running) return;
            try { step(); } catch (Exception e) { log("Error: " + e.getMessage()); }
            main.postDelayed(this, 1000);
        }
    };

    private void step() {
        double cad = cadence();
        MediaController c = ytm();
        long now = SystemClock.elapsedRealtime();
        if (pending != null) {                           // waiting for YouTube Music to switch to our song
            boolean playing = c != null && c.getPlaybackState() != null && c.getPlaybackState().getState() == PlaybackState.STATE_PLAYING;
            String nowKey = c != null ? titleKey(c) : "";
            // ours: the title matches, or (titles can differ by language/edition) YouTube Music switched track after we asked
            if (playing && (sameSong(c, pending) || (now - pendingSince > 1500 && !nowKey.isEmpty() && !nowKey.equals(prevKey)))) {
                curKey = nowKey;
                if (pendingEntry > 0.5) c.getTransportControls().seekTo((long) (pendingEntry * 1000));
                pending = null;
                main.postDelayed(this::dipUp, 400);
            } else if (now - pendingSince > 4500 && !triedSearch) {
                triedSearch = true;
                log("YouTube Music didn't open the song; trying its search");
                searchPlay(pending);
            } else if (now - pendingSince > 12000) {
                log("YouTube Music couldn't play " + pending.title + "; skipping it");
                engine.failed(pending);
                pending = null;
                dipUp();
            }
            publish(cad, -1);
            return;
        }
        double pos = -1; boolean ended = false;
        if (engine.cur != null) {
            if (c == null) ended = false;
            else if (curKey != null && curKey.equals(titleKey(c))) {
                pos = position(c);
                PlaybackState ps = c.getPlaybackState();
                ended = ps != null && (ps.getState() == PlaybackState.STATE_STOPPED || ps.getState() == PlaybackState.STATE_NONE);
            } else {
                ended = true;                              // YouTube Music moved on by itself (autoplay) or you skipped
            }
        }
        Engine.Action a = engine.tick(cad, Math.max(0, pos), ended);
        if (a != null) {
            log("▶ " + a.song.title + " — " + a.why + (a.entry > 0.5 ? " (" + Engine.fmt(a.entry) + ")" : ""));
            pending = a.song; pendingEntry = a.entry; pendingSince = now; triedSearch = false;
            prevKey = c != null ? titleKey(c) : ""; curKey = null;
            final Engine.Song s = a.song;
            if (c != null && engine.cur != null) dipDown(() -> open(s)); else open(s);
        }
        publish(cad, pos);
    }

    // ------------------------------------------------------------------ UI: notification + events for the app
    private void publish(double cad, double pos) {
        String c = cad < 0 ? "reading pace…" : Math.round(cad) + " steps/min";
        String song = engine.cur != null ? engine.cur.title + (engine.cur.artist.isEmpty() ? "" : " — " + engine.cur.artist) : "—";
        try {
            JSONObject o = new JSONObject();
            o.put("running", true); o.put("cadence", cad); o.put("song", song); o.put("pos", pos);
            o.put("status", engine.status); o.put("pending", pending != null);
            JSONArray l = new JSONArray(); for (String s : logs) l.put(s); o.put("log", l);
            lastState = o;
            Listener li = listener; if (li != null) li.on(o);
        } catch (Exception ignored) { }
        long now = SystemClock.elapsedRealtime();
        if (now - lastNotif > 3000) {
            lastNotif = now;
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            nm.notify(NOTIF_ID, notification(c + " · " + song, engine.status));
        }
    }

    private void log(String s) {
        logs.add(s); while (logs.size() > 30) logs.remove(0);
        try { JSONObject o = new JSONObject(); o.put("logLine", s); Listener li = listener; if (li != null) li.on(o); } catch (Exception ignored) { }
    }

    private Notification notification(String title, String text) {
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent openPi = open != null ? PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT) : null;
        PendingIntent stopPi = PendingIntent.getService(this, 1, new Intent(this, DJService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(title)
                .setContentText(text == null ? "" : text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .addAction(new Notification.Action.Builder(null, "Stop", stopPi).build());
        if (openPi != null) b.setContentIntent(openPi);
        return b.build();
    }

    private void startInForeground(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Run DJ background mode", NotificationManager.IMPORTANCE_LOW));
        Notification n = notification("Run DJ", text);
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH);
        else startForeground(NOTIF_ID, n);
    }

    /** A 1-pixel invisible overlay: Android 15 only lets an app with "Display over other apps" open another app
     *  from the background while one of its overlay windows is showing. */
    private void showPixel() {
        if (!Settings.canDrawOverlays(this)) { log("\"Display over other apps\" is off: songs may not change while the screen is locked"); return; }
        try {
            WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(1, 1, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                    PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.START;
            pixel = new View(this);
            wm.addView(pixel, lp);
        } catch (Exception e) { log("Overlay failed: " + e.getMessage()); }
    }

    @Override
    public void onDestroy() {
        running = false;
        main.removeCallbacksAndMessages(null);
        if (savedVolume >= 0) {
            try { ((AudioManager) getSystemService(Context.AUDIO_SERVICE)).setStreamVolume(AudioManager.STREAM_MUSIC, savedVolume, 0); } catch (Exception ignored) { }
        }
        if (sm != null) sm.unregisterListener(this);
        if (sensorThread != null) sensorThread.quitSafely();
        if (wake != null && wake.isHeld()) wake.release();
        if (pixel != null) try { ((WindowManager) getSystemService(Context.WINDOW_SERVICE)).removeView(pixel); } catch (Exception ignored) { }
        try { JSONObject o = new JSONObject(); o.put("running", false); lastState = o; Listener li = listener; if (li != null) li.on(o); } catch (Exception ignored) { }
        super.onDestroy();
    }
}
