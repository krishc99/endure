#!/usr/bin/env python3
"""Run DJ live: scan a folder of songs, find each BPM, play them by cadence in your browser.

Setup (once):   pip3 install mutagen librosa      (optional, sharper tempo: pip3 install essentia)
Run:            python3 dj_live.py "/Users/krish/Music/Songs"
Options:        --port 8765   --rescan (ignore cache and re-detect every BPM)
                --export library.json   (write the analysed library for the phone app and exit)
"""
import argparse, json, mimetypes, re, sys, threading, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

EXTS = {".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aac"}
MIME = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
        ".flac": "audio/flac", ".wav": "audio/wav", ".ogg": "audio/ogg"}
CACHE = Path(__file__).with_name("rundj_cache.json")
SONGS = []          # filled by scan(); index == song id
try:
    import essentia.standard  # noqa: F401
    HAVE_ESSENTIA = True
except Exception:
    HAVE_ESSENTIA = False
LOCK = threading.Lock()


# ------------------------------------------------------------ scanning
def read_tags(path):
    """Return title, artist, duration, bpm-from-tag (any may be None)."""
    title, artist, dur, bpm = path.stem, "", 0.0, None
    try:
        import mutagen
        easy = mutagen.File(path, easy=True)
        if easy is not None:
            dur = float(easy.info.length or 0)
            title = (easy.get("title") or [title])[0]
            artist = (easy.get("artist") or [""])[0]
        raw = mutagen.File(path)
        tags = getattr(raw, "tags", None) or {}
        for key in ("TBPM", "tmpo", "bpm"):
            if key in tags:
                v = tags[key]
                v = getattr(v, "text", v)
                v = v[0] if isinstance(v, (list, tuple)) else v
                if 40 <= float(str(v)) <= 250:
                    bpm = float(str(v))
                break
    except Exception:
        pass
    return str(title), str(artist), dur, bpm


def rank01(vals):
    """Percentile rank 0..1 of each value within the list."""
    n = len(vals)
    out = [0.5] * n
    if n > 1:
        for pos, i in enumerate(sorted(range(n), key=lambda i: vals[i])):
            out[i] = pos / (n - 1)
    return out


def structure(y, sr, hop, beat_frames):
    """Downbeat-aligned bars with an 'exit score' each, plus a loudness envelope for display.
    exit score = 0.5 timbre change (section boundary) + 0.25 energy drop + 0.25 8-bar phrase start."""
    import numpy as np, librosa
    if len(beat_frames) < 24:
        return None
    # Beat trackers often miss quiet intros/outros: extend the grid to the whole song at the median spacing
    per = float(np.median(np.diff(beat_frames)))
    first, last = float(beat_frames[0]), float(beat_frames[-1])
    total = len(y) / hop
    head = np.arange(first - per, -1, -per)[::-1]
    tail = np.arange(last + per, total - per, per)
    beat_frames = np.concatenate([head, beat_frames.astype(float), tail]).round().astype(int)
    beat_frames = beat_frames[(beat_frames >= 0) & (beat_frames < len(y) // hop - 2)]
    # Bar phase: which of the 4 beat positions carries the most low-frequency (kick) onset energy
    low = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, fmax=200)
    st = low[np.clip(beat_frames, 0, len(low) - 1)]
    phase = int(np.argmax([st[p::4].sum() for p in range(4)]))
    bf = beat_frames[phase::4]
    if len(bf) < 8:
        return None
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    mf = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=hop)
    mf = (mf - mf.mean(axis=1, keepdims=True)) / (mf.std(axis=1, keepdims=True) + 1e-9)
    ends = np.append(bf[1:], bf[-1] + int(np.median(np.diff(bf))))
    loud = np.array([rms[a:max(b, a + 1)].mean() for a, b in zip(bf, ends)])
    timb = np.array([mf[:, a:max(b, a + 1)].mean(axis=1) for a, b in zip(bf, ends)])
    n, w = len(bf), 4
    nov, drop = np.zeros(n), np.zeros(n)
    for k in range(w, n - w + 1):
        nov[k] = np.linalg.norm(timb[k - w:k].mean(0) - timb[k:k + w].mean(0))
        drop[k] = (loud[k - 2:k].mean() - loud[k:k + 2].mean()) / (loud.max() + 1e-9)
    nn = nov / (np.percentile(nov[nov > 0], 95) + 1e-9) if (nov > 0).any() else nov
    dd = np.clip(drop, 0, None)
    dd = dd / (np.percentile(dd[dd > 0], 90) + 1e-9) if (dd > 0).any() else dd
    ph = (np.arange(n) % 8 == 0).astype(int)
    score = np.clip(0.5 * np.clip(nn, 0, 1) + 0.25 * np.clip(dd, 0, 1) + 0.25 * ph, 0, 1)
    # Per-bar energy level 0..1 (loudness + onset density, lightly smoothed): the "shape of the wave"
    oe = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    ons = np.array([oe[a:max(b, a + 1)].mean() for a, b in zip(bf, ends)])
    p95 = lambda v: np.percentile(v, 95) + 1e-9
    lvl = np.clip(0.6 * loud / p95(loud) + 0.4 * ons / p95(ons), 0, None)
    lvl = np.convolve(np.pad(lvl, 1, mode="edge"), [0.25, 0.5, 0.25], mode="valid")
    lvl = np.clip(lvl / p95(lvl), 0, 1)
    times = librosa.frames_to_time(bf, sr=sr, hop_length=hop)
    bars = [[round(float(t), 2), round(float(s), 2), int(p), round(float(l), 2)]
            for t, s, p, l in zip(times, score, ph, lvl)]
    idx = np.linspace(0, len(rms), 241).astype(int)
    wave = np.array([rms[a:max(b, a + 1)].mean() for a, b in zip(idx[:-1], idx[1:])])
    wave = np.clip(wave / (np.percentile(wave, 98) + 1e-9), 0, 1)
    return dict(bars=bars, wave=[int(round(v * 100)) for v in wave])


def essentia_tempo(path):
    """Essentia's tempo estimates + integrated loudness. None if Essentia is missing or fails.
    conf is RhythmExtractor2013's own confidence (0..5.3; above ~3.5 is very reliable, below ~1.5 is a guess)."""
    try:
        import essentia, essentia.standard as es
        essentia.log.infoActive = False
        a = es.EasyLoader(filename=str(path), sampleRate=44100, endTime=600, replayGain=0)()
        bpm, _, conf, _, _ = es.RhythmExtractor2013(method="multifeature")(a)
        pc = es.PercivalBpmEstimator()(a)
        try:
            _, _, lufs, _ = es.LoudnessEBUR128(sampleRate=44100)(es.StereoMuxer()(a, a))
            lufs = float(lufs) if lufs > -70 else -70.0
        except Exception:
            lufs = None
        return dict(bpm=float(bpm), conf=float(conf), pc=float(pc), lufs=lufs)
    except ImportError:
        return None
    except Exception as e:
        print(f"    essentia failed on {path.name}: {e}")
        return None


def analyse(path):
    """Tempo, alt tempos, energy features, bar structure. None if librosa missing / decode fails."""
    try:
        import librosa, numpy as np
    except ImportError:
        return None
    try:
        y, sr = librosa.load(path, sr=22050, mono=True, duration=600)
        hop = 512
        oenv = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
        tempo, bfr = librosa.beat.beat_track(onset_envelope=oenv, sr=sr, hop_length=hop)
        bpm = float(np.atleast_1d(tempo)[0])
        bt = librosa.frames_to_time(bfr, sr=sr, hop_length=hop)
        if len(bt) > 8:                       # real beat spacing is more precise than the tempo bin
            ref = 60 / float(np.median(np.diff(bt)))
            if abs(ref - bpm) / bpm < 0.05:
                bpm = ref
        # Second opinion from Essentia. Use its tempo only when it is confident; otherwise keep librosa's.
        et = essentia_tempo(path)
        tempo_src, tconf, agree, dbl = "librosa", None, None, False
        if et:
            tconf = round(min(1.0, et["conf"] / 5.32), 2)
            lb = bpm
            if et["conf"] >= 3.0:
                bpm, tempo_src = et["bpm"], "essentia"
            agree = sum(abs(e - bpm) / bpm < 0.03 for e in (lb, et["bpm"], et["pc"]))
            dbl = any(abs(e - 2 * bpm) / (2 * bpm) < 0.03 for e in (lb, et["bpm"], et["pc"]))   # someone hears it double-time
        tg = librosa.feature.tempogram(onset_envelope=oenv, sr=sr, hop_length=hop).mean(axis=1)
        freqs = librosa.tempo_frequencies(len(tg), sr=sr, hop_length=hop)[1:][::-1]
        tg = tg[1:][::-1]
        strength = lambda b: float(np.interp(b, freqs, tg))
        base = max(strength(bpm), 1e-9)
        alts = [dict(bpm=round(b, 1), conf=round(min(1.0, strength(b) / base), 2))
                for b in (bpm * 2,) if 55 <= b <= 220]   # only 2x: autocorrelation always supports bpm/2
        if dbl:                                    # another estimator independently says 2x: trust that alt tempo more
            for al in alts:
                al["conf"] = max(al["conf"], 0.8)
        onsets = librosa.onset.onset_detect(onset_envelope=oenv, sr=sr, hop_length=hop)
        feats = dict(
            loud=(et["lufs"] if et and et["lufs"] is not None else float(20 * np.log10(librosa.feature.rms(y=y).mean() + 1e-9))),
            rate=len(onsets) / (len(y) / sr),
            bright=float(librosa.feature.spectral_centroid(y=y, sr=sr).mean()))
        out = dict(bpm=round(bpm, 1), alts=alts, feats=feats, bars=None, wave=None,
                   tempo_src=tempo_src, tempo_conf=tconf, tempo_agree=agree)
        try:
            out.update(structure(y, sr, hop, bfr) or {})
        except Exception as e:
            print(f"    no bar structure for {path.name}: {e}")
        return out
    except Exception as e:
        print(f"    could not analyse {path.name}: {e}")
        return None


def scan(folder, rescan=False):
    cache = {}
    if CACHE.exists() and not rescan:
        try:
            cache = json.loads(CACHE.read_text())
        except Exception:
            cache = {}
    files = sorted(p for p in folder.rglob("*")
                   if p.suffix.lower() in EXTS and not p.name.startswith("."))
    print(f"Found {len(files)} audio files in {folder}")
    for i, p in enumerate(files, 1):
        mtime, key = p.stat().st_mtime, str(p)
        e = cache.get(key)
        if not e or e.get("mtime") != mtime or e.get("v") != 4 or (HAVE_ESSENTIA and "tempo_src" not in e):
            old = e if e and e.get("mtime") == mtime else {}
            title, artist, dur, tagbpm = read_tags(p)
            print(f"  [{i}/{len(files)}] analysing {p.name} ...")
            a = analyse(p)
            bpm, src, alts = None, "tag", []
            if old.get("src") == "edited":
                bpm, src = old["bpm"], "edited"          # keep hand corrections
            elif tagbpm:
                bpm = tagbpm                              # tags are trusted: no alt tempos
            elif a:
                bpm, src, alts = a["bpm"], "detected", a["alts"]
            e = dict(v=4, mtime=mtime, title=title, artist=artist, dur=dur, bpm=bpm, src=src,
                     alts=alts, feats=a["feats"] if a else None,
                     bars=(a or {}).get("bars"), wave=(a or {}).get("wave"),
                     tempo_src=(a or {}).get("tempo_src"), tempo_conf=(a or {}).get("tempo_conf"),
                     tempo_agree=(a or {}).get("tempo_agree"),
                     energy_edit=old.get("energy_edit"))
        cache[key] = e
    # Energy = average percentile rank of loudness, onset rate and brightness within YOUR library
    with_f = [k for k in cache if cache[k].get("feats") and Path(k) in set(files)]
    ranks = {f: rank01([cache[k]["feats"][f] for k in with_f]) for f in ("loud", "rate", "bright")}
    for j, k in enumerate(with_f):
        cache[k]["energy"] = round(sum(ranks[f][j] for f in ranks) / 3, 2)
    CACHE.write_text(json.dumps(cache, indent=1))
    skipped = 0
    for p in files:
        e = cache[str(p)]
        if e["bpm"] is None:
            skipped += 1
            continue
        energy = e["energy_edit"] if e.get("energy_edit") is not None else e.get("energy", 0.5)
        SONGS.append(dict(id=len(SONGS), path=str(p), title=e["title"], artist=e["artist"],
                          dur=e["dur"], bpm=e["bpm"], src=e["src"], alts=e["alts"], energy=energy,
                          bars=e.get("bars"), wave=e.get("wave"), tempo_src=e.get("tempo_src"),
                          tempo_conf=e.get("tempo_conf"), tempo_agree=e.get("tempo_agree"),
                          first_bar=e["bars"][0][0] if e.get("bars") else None))
    by = {s: sum(1 for x in SONGS if x["src"] == s) for s in ("tag", "detected", "edited")}
    ess = sum(1 for x in SONGS if x.get("tempo_src") == "essentia")
    print(f"Essentia: {'available' if HAVE_ESSENTIA else 'not installed (pip3 install essentia for sharper tempo)'}"
          + (f"; its tempo used for {ess} songs, librosa's for the rest" if HAVE_ESSENTIA else ""))
    print(f"{len(SONGS)} songs ready ({by['tag']} BPM from tags, {by['detected']} detected, "
          f"{by['edited']} hand-edited); {skipped} skipped (no BPM)")
    if skipped:
        print("  Skipped files need `pip3 install librosa` (and `brew install ffmpeg` for some .m4a).")


# ------------------------------------------------------------ server
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/":
            self._send(200, PAGE.encode(), "text/html; charset=utf-8")
        elif self.path == "/api/songs":
            out = [{k: v for k, v in s.items() if k != "path"} for s in SONGS]
            self._send(200, json.dumps(out).encode(), "application/json")
        elif m := re.fullmatch(r"/song/(\d+)", self.path):
            i = int(m.group(1))
            if i < len(SONGS):
                return self.send_audio(Path(SONGS[i]["path"]))
            self._send(404, b"no such song", "text/plain")
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        if self.path not in ("/api/bpm", "/api/energy"):
            return self._send(404, b"not found", "text/plain")
        data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        with LOCK:
            s = SONGS[int(data["id"])]
            cache = json.loads(CACHE.read_text())
            c = cache[s["path"]]
            if self.path == "/api/bpm":      # a hand edit is authoritative: drop alt tempos
                s.update(bpm=round(float(data["bpm"]), 1), src="edited", alts=[])
                c.update(bpm=s["bpm"], src="edited", alts=[])
            else:
                s["energy"] = round(min(1, max(0, float(data["energy"]))), 2)
                c["energy_edit"] = s["energy"]
            CACHE.write_text(json.dumps(cache, indent=1))
        self._send(200, b"{}", "application/json")

    def send_audio(self, path):
        """File response with HTTP Range support (Safari needs it for audio)."""
        size = path.stat().st_size
        start, end, code = 0, size - 1, 200
        m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                if m.group(2): end = min(int(m.group(2)), size - 1)
            else:
                start = max(0, size - int(m.group(2)))
            code = 206
        self.send_response(code)
        self.send_header("Content-Type", MIME.get(path.suffix.lower(), "application/octet-stream"))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = f.read(min(65536, left))
                    if not chunk: break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


# ------------------------------------------------------------ page
PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Run DJ live</title>
<style>
:root{--bg:#fafaf7;--fg:#1c1c1a;--mut:#6b6b66;--card:#fff;--bd:#e2e2dc;--acc:#e8590c;--ok:#2b8a3e;--q:#b7791f;--track:#ecebe5;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#f0efe9;--mut:#9a9a92;--card:#201f1d;--bd:#33322e;--acc:#ff8a4c;--ok:#69db7c;--q:#ffd166;--track:#2c2b28}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:820px;margin:0 auto;padding:16px;display:grid;gap:14px}
h1{font-size:20px;margin:4px 0 0}.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px}
.lbl{font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.big{font-size:40px;font-weight:700;color:var(--acc);line-height:1;font-variant-numeric:tabular-nums}
input[type=range]{width:100%;accent-color:var(--acc)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between}
button,input[type=number]{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:7px 12px}
button{cursor:pointer}button.p{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
button.s{padding:1px 7px;font-size:12px}
.set input[type=number]{width:100%}.en{width:58px;padding:2px 4px;font-size:12px}
.np{font-size:18px;font-weight:600;margin:6px 0 2px}
.bar{position:relative;height:10px;background:var(--track);border-radius:6px;margin:12px 0 6px}
.fill{height:100%;background:var(--acc);border-radius:6px;width:0}
.mk{position:absolute;top:-4px;width:2px;height:18px;background:var(--mut)}.mk.b{background:var(--q);width:3px}
canvas#wave{width:100%;height:90px;display:block;margin-top:10px}
.small{font-size:12px;color:var(--mut)}.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;border:1px solid var(--bd)}
.q{color:var(--q);border-color:var(--q)}.ok{color:var(--ok);border-color:var(--ok)}
ul{list-style:none;margin:0;padding:0;max-height:360px;overflow-y:auto}
li{display:flex;justify-content:space-between;gap:8px;padding:5px 8px;border-radius:8px;opacity:.4;align-items:center}
li.in{opacity:1}li.cur{background:var(--track);font-weight:600}
#log{max-height:200px;overflow:auto;font-size:13px}#log div{padding:3px 0;border-bottom:1px solid var(--bd);white-space:nowrap}
.set{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:8px}.set label{display:grid;gap:3px;font-size:12px;color:var(--mut)}
.set label.ck{grid-template-columns:auto 1fr;align-items:center;align-self:end}
</style></head><body><main>
<div><h1>🏃 Run DJ live</h1><div class="small" id="count"></div></div>
<section class="card">
  <div class="lbl">Cadence (your fake step sensor)</div>
  <div class="row"><span class="big" id="bpmv">150</span><span class="small">steps / BPM</span></div>
  <input type="range" id="bpm" min="60" max="190" value="150">
  <div style="margin-top:10px"><button class="p" id="go">▶ Start</button></div>
</section>
<section class="card">
  <div class="lbl">Now playing</div><div class="np" id="np">Press Start</div><div class="small" id="sub"></div>
  <div class="bar"><div class="fill" id="fill"></div><div class="mk" id="mkmin"></div><div class="mk b" id="mkb" style="display:none"></div></div>
  <div class="row"><span class="small" id="el"></span><span class="small">grey = min play time · amber = swap point</span></div>
  <div id="pend" style="margin-top:8px"></div>
  <canvas id="wave" width="800" height="90"></canvas>
  <div class="small">waveform · green ticks = good exit points · grey = min play · amber = fade, which ends on the exit point</div>
</section>
<section class="card"><div class="lbl">Settings</div><div class="set">
  <label>Tolerance ± BPM<input type="number" id="tol" value="6"></label>
  <label>Min play (s)<input type="number" id="min" value="30"></label>
  <label>Switch margin<input type="number" id="mar" value="3"></label>
  <label>Shuffle range (cost)<input type="number" id="spread" value="4"></label>
  <label>Crossfade (s)<input type="number" id="xf" value="4"></label>
  <label>Swap timing<select id="swap"><option value="section">Section-aware</option><option value="bar">Phrase bars (beat-aligned)</option></select></label>
  <label>Max wait for good exit (s)<input type="number" id="wait" value="20"></label>
  <label>Energy weight (BPM)<input type="number" id="ew" value="3" step="0.5"></label>
  <label>Half-time penalty<input type="number" id="htpen" value="4"></label>
  <label>Alt-tempo min conf<input type="number" id="conf" value="0.5" step="0.1"></label>
  <label class="ck"><input type="checkbox" id="hold" checked> Hold a song while it still fits</label>
  <label class="ck"><input type="checkbox" id="push" checked> When every song at your pace has played, nudge the tempo up</label>
  <label>Nudge up by at most (BPM)<input type="number" id="pushmax" value="8"></label>
  <label class="ck"><input type="checkbox" id="rotate" checked> Rotate songs at steady tempo</label>
  <label class="ck"><input type="checkbox" id="half" checked> Half-time matching</label>
  <label class="ck"><input type="checkbox" id="alt" checked> Use alt tempos</label>
  <label class="ck"><input type="checkbox" id="edir" checked> Follow your pace with energy: a rising pace picks a higher-energy song, a falling pace a lower one</label>
  <label>Min energy gap for that<input type="number" id="egap" value="0.05" step="0.05" min="0" max="1"></label></div></section>
<section class="card"><div class="lbl">Your songs · bright = fits current cadence · ⚡ = energy 0–1 (editable) · ½ / ×2 fix a wrong BPM</div><ul id="list"></ul></section>
<section class="card"><div class="lbl">Event log</div><div id="log"></div></section>
</main>
<script>
const $=id=>document.getElementById(id);
const SILENT='data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const AU=[new Audio(),new Audio()];
let ai=0,songs=[],cur=null,pend=null,boundary=null,lastEl=0,timer=null,fadeT=null,lastKey='',listKey='',ver=0,base=0,plan=null,armT=null,fading=false,fadeStart=0,fadeLen=0,fadeNew=null,fadeOld=null,prepId=null,prepSp=0,curEff=0,keep=null,rng=Math.random,played=new Map(),playSeq=0,cadHist=[],pushSong=null,pushBase=0,nudgeLog=null;
const S=()=>({tol:+$('tol').value,min:+$('min').value,mar:+$('mar').value,spread:+$('spread').value,rotate:$('rotate').checked,hold:$('hold').checked,push:$('push').checked,pushMax:+$('pushmax').value,xf:+$('xf').value,
  ew:+$('ew').value,swap:$('swap').value,wait:+$('wait').value,htpen:+$('htpen').value,conf:+$('conf').value,half:$('half').checked,alt:$('alt').checked,edir:$('edir').checked,egap:+$('egap').value||0});
const fmt=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
const log=m=>{const d=document.createElement('div');d.textContent=m;$('log').prepend(d)};
const logOnce=(k,m)=>{if(k!==lastKey){lastKey=k;log(m)}};
const name=s=>s.artist?`${s.title} — ${s.artist}`:s.title;

// How can this song fit cadence c? Tries 1:1 first; half-time (runner takes 2 steps per beat) costs a penalty.
// cost = distance + penalties - energy bonus. null if nothing is within tolerance.
function match(s,c){
  const st=S();let r=null;
  const cands=[{b:s.bpm,pen:0,alt:false}];
  if(st.alt)for(const a of s.alts||[])if(a.conf>=st.conf)cands.push({b:a.bpm,pen:1,alt:true});
  const modes=[[1,0,'1:1']];if(st.half)modes.push([2,st.htpen,'half-time']);
  for(const k of cands)for(const [mult,pen,mode] of modes){
    const diff=Math.abs(k.b*mult-c);
    if(diff<=st.tol){const cost=diff+k.pen+pen-st.ew*s.energy;
      if(!r||cost<r.cost)r={cost,diff,tempo:k.b,mode:mode+(k.alt?', alt tempo':'')}}
  }
  return r;
}
// Nudge: songs NOT yet played that are a little faster than your pace (just above the tolerance, up to +pushMax).
function nudgeCandidates(c,excl){
  const st=S(),out=[];
  for(const s of songs){
    if(s===excl||s.bad||lastPlayed(s)>=0)continue;
    const ks=[{b:s.bpm,pen:0}];if(st.alt)for(const a of s.alts||[])if(a.conf>=st.conf)ks.push({b:a.bpm,pen:1});
    let best=null;
    for(const k of ks)for(const [mult,pen,mode] of (st.half?[[1,0,'1:1'],[2,st.htpen,'half-time']]:[[1,0,'1:1']])){
      const e=k.b*mult,up=e-c;
      if(up>st.tol&&up<=st.tol+st.pushMax){const m={cost:up+k.pen+pen-st.ew*s.energy,diff:up,tempo:k.b,mode:mode+', tempo nudge',push:true};if(!best||m.cost<best.cost)best=m}
    }
    if(best)out.push({s,m:best});
  }
  if(!out.length)return null;
  const lo=Math.min(...out.map(x=>x.m.diff)),near=out.filter(x=>x.m.diff<=lo+1.5);   // the smallest step up
  return near.reduce((a,b)=>b.m.cost<a.m.cost?b:a);
}
// Your pace over the last minute: steady (range within 5) and not drifting down
function paceTrend(){
  const now=performance.now(),w=cadHist.filter(x=>now-x[0]<=60000);
  if(w.length<20)return {steady:false,slowing:false,rising:false};
  const v=w.map(x=>x[1]),first=v.slice(0,15),last=v.slice(-15),avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
  const slowing=avg(last)-avg(first)<-1.5,rising=avg(last)-avg(first)>1.5;
  return {steady:Math.max(...v)-Math.min(...v)<=5&&!slowing,slowing,rising};
}
const bestMatch=c=>{let r=null;for(const s of songs){const m=match(s,c);if(m&&(!r||m.cost<r.m.cost))r={s,m}}return r};
const desc=m=>`${m.mode}, off by ${m.diff.toFixed(0)}`;

const eff=m=>m.tempo*(m.mode.startsWith('half')?2:1);          // effective steps/min this match is for
const gain=f=>[Math.sin(f*Math.PI/2),Math.cos(f*Math.PI/2)];    // [incoming, outgoing]: equal-power fade
const lv=b=>b[3]==null?0.5:b[3];                                // bar = [time, exitScore, phraseStart, energy 0..1]
const barAt=(s,t)=>{let r=s.bars[0];for(const b of s.bars){if(b[0]<=t)r=b;else break}return r};
function highRuns(s){   // stretches of ≥3 bars with energy ≥0.75: the choruses / drops
  if(s._hr)return s._hr;const runs=[];let st=null;
  s.bars.forEach((b,i)=>{if(lv(b)>=.75){if(st===null)st=i}else if(st!==null){runs.push([st,i]);st=null}});
  if(st!==null)runs.push([st,s.bars.length-1]);
  return s._hr=runs.filter(r=>r[1]-r[0]>=3).map(r=>({start:s.bars[r[0]][0],end:s.bars[r[1]][0]}));
}
const dirOf=x=>{const r=eff(x.m)/curEff;return r>1.03?'up':r<.97?'down':'same'};

// ---- choosing the next song: every song that fits your pace is a candidate. Songs not yet played this run come first,
// then the one played longest ago, so you hear every fitting song before any repeats. Among equals: the near-best match.
const candidates=(c,excl)=>{const r=[];for(const s of songs){if(s===excl)continue;const m=match(s,c);if(m)r.push({s,m})}return r};
const bestOf=a=>a.reduce((x,y)=>!x||y.m.cost<x.m.cost?y:x,null);
const songKey=s=>s.file||s.yt||s.id;
const lastPlayed=s=>played.has(songKey(s))?played.get(songKey(s)):-1;
// Pace rising: prefer a song with more energy than the one playing; pace falling: less. This never changes which songs fit
// your tempo: it only narrows songs that already fit (and are next in the no-repeat order). If none is far enough in the wanted
// direction, it takes the one whose energy is closest to the current song.
function energyPref(fresh){
  const st=S();if(!st.edir||!cur||fresh.length<2)return fresh;
  const tr=paceTrend(),dir=tr.rising?1:tr.slowing?-1:0;if(!dir)return fresh;
  const f=fresh.filter(x=>dir*(x.s.energy-cur.energy)>=st.egap);
  if(f.length)return f;
  // nothing is far enough in the wanted direction: take the fitting song(s) whose energy is closest to the current one
  const o=fresh.filter(x=>x.s!==cur);if(!o.length)return fresh;
  const d=x=>Math.abs(x.s.energy-cur.energy),m=Math.min(...o.map(d));
  return o.filter(x=>d(x)<=m+1e-9);
}
function choose(cands){
  if(!cands||!cands.length)return null;
  const oldest=Math.min(...cands.map(x=>lastPlayed(x.s))),fresh0=cands.filter(x=>lastPlayed(x.s)===oldest),fresh=energyPref(fresh0);
  const b=bestOf(fresh),near=fresh.filter(x=>x.m.cost<=b.m.cost+S().spread);
  return near[Math.floor(rng()*near.length)];
}

// ---- where in the NEW song does the fade-in land on the exit point?
//  same/up tempo: its first high-energy section (the high carries straight into a chorus/drop)
//  down tempo:   a phrase start whose energy is a bit below the outgoing song's
function pickEntry(s,Lo,dir,xf){
  let t=s.first_bar!=null?s.first_bar:0,why='its first bar';
  if(s.bars&&s.bars.length){
    if(dir==='down'){
      const tg=Math.max(.2,Lo-.25),c=s.bars.filter(b=>b[2]===1&&b[0]<=.7*(s.dur||1e9));
      if(c.length){t=c.reduce((a,b)=>Math.abs(lv(b)-tg)<Math.abs(lv(a)-tg)-1e-9?b:a)[0];why='a calmer section'}
    }else{const h=highRuns(s)[0];if(h){t=h.start;why='its first chorus'}}
  }else if(dir!=='down'&&(s.dur||0)>90){   // no section data: skip the intro and first verse instead of starting cold
    const bar=240/(s.bpm||120);t=Math.round(Math.min(45,.25*s.dur)/bar)*bar;why='about a quarter in (no section data)'}
  const sp=t-xf;return {tAlign:t,startPos:Math.max(0,sp),delay:Math.max(0,-sp),why};
}
// ---- where in the CURRENT song does the fade END?  The fade runs [T−xf, T].
//  rot (steady tempo, another song fits): leave right after the LAST chorus ends, don't sit through the outro.
//  'bar': first 8-bar phrase start.  'section': structure score + energy (high for same/up, lower for down),
//  bonus for the bar right after a chorus ends; looks further ahead if the next stretch is a lull.
function pickExit(s,el,st,dir,rot){
  const tmin=Math.max(base+st.min,el+st.xf+0.3),c=s.bars.filter(b=>b[0]>=tmin);
  if(!c.length)return null;
  if(rot){
    const hr=highRuns(s),last=hr[hr.length-1];
    if(last)return last.end>=tmin?last.end:c[0][0];          // already past the last chorus → leave at the first chance
    const len=AU[ai].duration||s.dur||0,tg=Math.max(tmin,.75*len),f=c.find(b=>b[0]>=tg&&b[2]===1)||c.find(b=>b[0]>=tg);
    return f?f[0]:null;                                      // no chorus info: leave around 3/4 of the way through
  }
  if(st.swap==='bar')return (c.find(b=>b[2]===1)||c[0])[0];
  const ends=highRuns(s).map(r=>r.end),afterChorus=b=>ends.some(e=>Math.abs(e-b[0])<0.02);
  const val=b=>0.4*b[1]+0.6*(dir==='down'?1-lv(b):lv(b))+(dir!=='down'&&afterChorus(b)?0.35:0);
  const pick=w=>c.filter(b=>b[0]<=c[0][0]+w).reduce((a,b)=>val(b)>val(a)+1e-9?b:a);
  let b=pick(st.wait);
  if(dir!=='down'&&b[3]!=null&&b[3]<.55)b=pick(st.wait*3);
  return b[0];
}
// songs with no beat/section data: leave at the earliest allowed moment (rotation: about 3/4 through)
const plainExit=(el,st,rot)=>{const tmin=Math.max(base+st.min,el+st.xf+0.3);return rot?Math.max(tmin,.75*(AU[ai].duration||cur.dur||0)):tmin};
function makePlan(x,el,st){
  const dir=dirOf(x),hasBars=cur.bars&&cur.bars.length;
  const T=hasBars?pickExit(cur,el,st,dir,x.rot):plainExit(el,st,x.rot);
  if(T==null||T>=(AU[ai].duration||cur.dur||1e9)-st.xf-1)return null;
  return {T,fadeAt:T-st.xf,x,dir,rot:!!x.rot,entry:pickEntry(x.s,hasBars?lv(barAt(cur,T)):.5,dir,st.xf)};
}

// Pre-load the next song on the idle player so the fade doesn't wait on the network/decoder
function prep(x,entry){
  const n=AU[1-ai];n.src='/song/'+x.s.id;n.preload='auto';n.volume=0;prepId=x.s.id;prepSp=entry.startPos;
  if(entry.startPos>0.05)n.addEventListener('loadedmetadata',()=>{n.currentTime=entry.startPos},{once:true});
}
function fadeStep(){   // time-based, so the fade ends exactly xf seconds after it starts
  const f=Math.min(1,(performance.now()-fadeStart)/(fadeLen*1000)),[gi,go]=gain(f);
  fadeNew.volume=gi;fadeOld.volume=go;
  if(f>=1){clearInterval(fadeT);fading=false;fadeOld.pause()}
}
function crossfade(x,entry){
  const xf=cur?S().xf:0,old=AU[ai];ai=1-ai;const n=AU[ai],e=entry||{startPos:0,delay:0};   // first song starts at full volume
  if(!(prepId===x.s.id&&prepSp===e.startPos)){
    n.src='/song/'+x.s.id;
    if(e.startPos>0.05)n.addEventListener('loadedmetadata',()=>{n.currentTime=e.startPos},{once:true});
  }
  prepId=null;n.volume=xf>0?0:1;
  const go=()=>n.play().catch(err=>log('⚠ playback blocked: '+err.message));
  e.delay>0?setTimeout(go,e.delay*1000):go();
  clearInterval(fadeT);fading=false;
  if(xf>0){fadeNew=n;fadeOld=old;fadeLen=xf;fadeStart=performance.now();fading=true;fadeT=setInterval(fadeStep,40)}else old.pause();
  cur=x.s;played.set(songKey(x.s),++playSeq);curEff=eff(x.m);if(x.m.push){pushSong=x.s;pushBase=+$('bpm').value}else pushSong=null;
  pend=null;keep=null;boundary=null;plan=null;disarm();base=e.startPos;lastEl=e.startPos;lastKey='';
}
function disarm(){clearInterval(armT);armT=null}
function armCheck(){   // 25 ms poll while a swap is planned, so the fade starts on time
  if(!plan||!cur){disarm();return}
  if(fading)return;
  if(AU[ai].currentTime>=plan.fadeAt){const p=plan;log(`🔀 fading to ${name(p.x.s)} (${desc(p.x.m)}), fade ends at ${fmt(p.T)}; it enters at ${p.entry.why}`);crossfade(p.x,p.entry);render()}
}
function arm(){if(!armT)armT=setInterval(armCheck,25)}
const dirTxt={same:'same tempo',up:'tempo up',down:'tempo down'};

function loop(){
  const b=+$('bpm').value,st=S();
  cadHist.push([performance.now(),b]);while(cadHist.length&&performance.now()-cadHist[0][0]>90000)cadHist.shift();
  if(!cur){
    const cs=candidates(b,null),bc=bestOf(cs);
    if(bc){const x=choose(cs);log(`▶ start: ${name(x.s)} (${desc(x.m)})`);crossfade(x)}
    else logOnce('hole',`⏹ silence: nothing fits ${b} BPM`);
    return render();
  }
  const a=AU[ai],el=a.currentTime,len=a.duration||cur.dur||1e9;
  if(fading){lastEl=el;return render()}   // never start a second fade on top of a running one
  const tr=paceTrend();
  let mc=match(cur,b);
  // a nudged (faster) song stays "fitting" while you adapt to it, unless you slow down
  if(!mc&&cur===pushSong&&!tr.slowing&&b>=pushBase-2){const e=pushSong.bpm;mc={cost:Math.abs(e-b),diff:Math.abs(e-b),tempo:e,mode:'tempo nudge'}}
  const ok=!!mc,cs=candidates(b,cur),bc=bestOf(cs);
  // hold: while the playing song still fits your cadence, don't jump to a 'slightly better' one; it plays to its last chorus
  const needSwap=bc&&(!ok||(!st.hold&&bc.m.cost+st.mar<=mc.cost));
  let pool=null,rot=false;
  if(needSwap)pool=cs;                                  // current no longer fits (or, with Hold off, another fits clearly better)
  else if(st.rotate&&ok&&bc){pool=cs;rot=true}          // steady tempo: after the last chorus, on to another fitting song
  // every song at this pace has played and you're running steadily: the next one is a little faster instead of a repeat
  if(!needSwap&&st.rotate&&ok&&st.push&&tr.steady&&cs.every(x=>lastPlayed(x.s)>=0)){
    const nu=nudgeCandidates(b,cur);
    if(nu){pool=[nu];rot=true;if(nudgeLog!==songKey(nu.s)){nudgeLog=songKey(nu.s);log(`⏫ every song at ${Math.round(b)} has played: next is a little faster, ${name(nu.s)} (${Math.round(nu.m.tempo*(nu.m.mode.startsWith('half')?2:1))})`)}}
  }
  if(pool&&pool.length){
    if(!(keep&&keep.cur===cur&&keep.rot===rot&&pool.some(x=>x.s===keep.s)))keep={cur,rot,s:choose(pool).s};   // pick once, stay stable
    pend=pool.find(x=>x.s===keep.s);pend.rot=rot;
  }else{pend=null;keep=null}
  if(a.ended||el>=len-st.xf-0.5){   // song is about to end anyway: fade so it finishes with the file
    let nx=pend;plan=null;disarm();
    if(!nx)nx=choose(cs)||(ok?{s:cur,m:mc}:null);         // repeat the same song only if nothing else fits
    if(nx){const dir=dirOf(nx),en=pickEntry(nx.s,cur.bars&&cur.bars.length?lv(barAt(cur,el)):.5,dir,st.xf);
      log(`⏭ song ending → ${name(nx.s)} (${desc(nx.m)}, ${dirTxt[dir]}), enters at ${en.why}`);crossfade(nx,en)}
    else{log(`⏹ song ended, nothing fits ${b} BPM`);a.pause();cur=null}
    return render();
  }
  if(!pend){plan=null;disarm();boundary=null;if(!ok)logOnce('out',`⚠ nothing fits ${b} BPM, playing out ${cur.title}`);lastEl=el;return render()}
  if(!plan||plan.x.s!==pend.s||plan.rot!==!!pend.rot){plan=makePlan(pend,el,st);if(plan)prep(plan.x,plan.entry)}else plan.x=pend;
  if(plan){
    boundary=plan.T;arm();
    logOnce('p'+pend.s.id+'|'+Math.round(plan.T),`⏳ ${plan.rot?'rotating to':'queued'} ${name(pend.s)} (${desc(pend.m)}, ${dirTxt[plan.dir]}): fade ${fmt(plan.fadeAt)}→${fmt(plan.T)}, enters at ${plan.entry.why} (${fmt(plan.entry.tAlign)})`);
    if(el>=plan.fadeAt)armCheck();
  }else{boundary=null;logOnce('n'+pend.s.id,`⏳ ${name(pend.s)} waiting: no exit point before the song ends`)}
  lastEl=el;render();
}

function draw(){
  const c=$('wave'),g=c.getContext&&c.getContext('2d');if(!g)return;
  const W=c.width,H=c.height,cs=getComputedStyle(document.documentElement),col=v=>cs.getPropertyValue(v).trim();
  g.clearRect(0,0,W,H);if(!cur||!cur.wave)return;
  const a=AU[ai],len=a.duration||cur.dur||1,x=t=>t/len*W,n=cur.wave.length,el=a.currentTime;
  for(let i=0;i<n;i++){const done=i/n*len<el,h=Math.max(1,cur.wave[i]/100*H*0.9);g.globalAlpha=done?1:.4;g.fillStyle=done?col('--acc'):col('--mut');g.fillRect(i/n*W,(H-h)/2,Math.max(1,W/n-1),h)}
  g.globalAlpha=.7;g.fillStyle=col('--ok');(cur.bars||[]).forEach(b=>{if(b[1]>=.6)g.fillRect(x(b[0]),0,2,10)});
  g.globalAlpha=1;g.fillStyle=col('--mut');g.fillRect(x(base+S().min),0,2,H);
  if(plan){g.fillStyle=col('--q');g.globalAlpha=.25;g.fillRect(x(plan.fadeAt),0,x(plan.T)-x(plan.fadeAt),H);g.globalAlpha=1;g.fillRect(x(plan.T),0,3,H)}
  g.fillStyle=col('--fg');g.fillRect(x(el),0,2,H);
}

function render(){
  const st=S(),b=+$('bpm').value,a=AU[ai],len=cur?(a.duration||cur.dur||0):0,el=cur?a.currentTime:0;
  $('bpmv').textContent=b;
  const mc=cur&&match(cur,b);
  $('np').textContent=cur?name(cur):(timer?'Silence':'Press Start');
  $('sub').textContent=cur?`${cur.bpm} BPM (${cur.src}) · ⚡${cur.energy.toFixed(2)} · `+(mc?desc(mc):'out of range'):'';
  $('fill').style.width=len?Math.min(100,el/len*100)+'%':'0';
  $('mkmin').style.left=len?Math.min(100,(base+st.min)/len*100)+'%':'0';
  const mb=$('mkb');if(cur&&boundary&&len){mb.style.display='block';mb.style.left=Math.min(100,boundary/len*100)+'%'}else mb.style.display='none';
  $('el').textContent=cur?`${fmt(el)} / ${fmt(len)}`:'';
  $('pend').innerHTML=pend?`<span class="pill q">Queued next</span> ${name(pend.s)} <span class="small">${desc(pend.m)}</span>`:(cur?'<span class="pill ok">No swap pending</span>':'');
  // rebuild the list only when something relevant changed, so typing in an energy box isn't interrupted
  const k=[b,cur&&cur.id,ver,JSON.stringify(st)].join('|');
  if(k!==listKey){listKey=k;
    $('list').innerHTML=songs.map(t=>{const m=match(t,b),alts=(t.alts||[]).map(x=>`${x.bpm}@${x.conf}`).join(', ');
      return `<li class="${m?'in':''} ${t===cur?'cur':''}"><span>${t===cur?'▶ ':''}${t.title} <span class="small">${t.artist}${m&&m.mode!=='1:1'?' · '+m.mode:''}</span></span>
      <span title="${[alts?'alt tempos: '+alts:'',t.tempo_src?'tempo: '+t.tempo_src+(t.tempo_conf!=null?' (conf '+t.tempo_conf+', '+t.tempo_agree+'/3 estimators agree)':''):''].filter(Boolean).join(' · ')}">${t.bpm} <span class="small">${t.src}</span> ⚡<input class="en" type="number" step="0.1" min="0" max="1" value="${t.energy.toFixed(2)}" onchange="setEn(${t.id},this.value)">
      <button class="s" onclick="adj(${t.id},0.5)">½</button><button class="s" onclick="adj(${t.id},2)">×2</button></span></li>`}).join('')}
}
const post=(p,o)=>fetch(p,{method:'POST',body:JSON.stringify(o)});
async function adj(id,f){const t=songs[id];t.bpm=Math.round(t.bpm*f*10)/10;t.src='edited';t.alts=[];ver++;await post('/api/bpm',{id,bpm:t.bpm});render()}
async function setEn(id,v){const t=songs[id];t.energy=Math.min(1,Math.max(0,+v||0));ver++;await post('/api/energy',{id,energy:t.energy})}
$('go').onclick=()=>{
  if(timer){clearInterval(timer);timer=null;AU.forEach(a=>a.pause());cur=null;plan=null;disarm();$('go').textContent='▶ Start';return render()}
  AU.forEach(a=>{a.src=SILENT;a.play().catch(()=>{})});   // unlock playback inside the click
  played=new Map();playSeq=0;cadHist=[];pushSong=null;$('go').textContent='⏹ Stop';log('— started —');loop();timer=setInterval(loop,1000);
};
['bpm','tol','min','mar','spread','xf','ew','htpen','conf','half','alt','wait','swap','rotate','hold','push','pushmax','edir','egap'].forEach(id=>{$(id).oninput=render;$(id).onchange=render});
setInterval(draw,100);
fetch('/api/songs').then(r=>r.json()).then(d=>{songs=d;$('count').textContent=`${d.length} songs loaded`;render()});
</script></body></html>
"""


# ------------------------------------------------------------ main
if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--rescan", action="store_true")
    ap.add_argument("--export", metavar="FILE", help="write library.json for the phone app, then exit")
    args = ap.parse_args()
    folder = Path(args.folder).expanduser()
    if not folder.is_dir():
        sys.exit(f"Not a folder: {folder}")
    scan(folder, args.rescan)
    if not SONGS:
        sys.exit("No playable songs with a BPM. Install librosa: pip3 install librosa mutagen")
    if args.export:
        names = [Path(x["path"]).name for x in SONGS]
        dups = sorted({n for n in names if names.count(n) > 1})
        if dups:
            print(f"WARNING: duplicate file names (the phone matches songs by file name, so only one of each works): {dups[:5]}")
        out = [dict({k: v for k, v in x.items() if k not in ("path", "id", "mtime")}, file=Path(x["path"]).name) for x in SONGS]
        Path(args.export).write_text(json.dumps({"version": 1, "songs": out}))
        print(f"Wrote {len(out)} songs to {args.export}. Copy it to your phone along with the audio files listed in it.")
        sys.exit(0)
    url = f"http://localhost:{args.port}"
    print(f"\nOpen {url}  (Ctrl+C to stop)")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    ThreadingHTTPServer(("127.0.0.1", args.port), H).serve_forever()
