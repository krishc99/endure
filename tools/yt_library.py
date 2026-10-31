#!/usr/bin/env python3
"""Turn a YouTube Music playlist into a Run DJ library file for the phone app.

The phone app plays these songs from YouTube in an embedded player, in the order the Run DJ engine picks.
Nothing is downloaded: this only collects video IDs, titles, durations and BPMs.

Setup (once):   pip3 install ytmusicapi
Run:            python3 tools/yt_library.py "https://music.youtube.com/playlist?list=PL..." --out yt_library.json

Where each song's BPM comes from, in this order:
  1. tools/yt_overrides.json   your hand corrections, e.g. {"dQw4w9WgXcQ": 113} or {"dQw4w9WgXcQ": {"bpm": 113, "energy": 0.7}}
  2. tools/rundj_cache.json    the same song in your local library (analysed by dj_live.py): BPM, energy,
                               and beat/section data too when the durations match
  3. iTunes preview            finds the SAME version in Apple's iTunes Search (title, artist, remix/acoustic/live tags and
                               length must agree) and measures its public 30-second preview with librosa.
                               Covers and remixes get their own tempo.
  4. AcousticBrainz            tempo of the same recording via MusicBrainz (best effort: the project stopped taking
                               submissions in 2022, so many songs have no data). --no-acousticbrainz turns it off.
  5. GetSongBPM API            optional: --bpm-key KEY or the GETSONGBPM_KEY environment variable
These are votes: the highest in this list is the tempo, the others only decide whether the song is marked "check" (they
disagree). A high-energy song detected slow becomes double-time, a low-energy one detected fast becomes half-time
(--energy-hi / --bpm-low / --energy-lo / --bpm-high). Your own edits are never changed. Every vote goes to bpm_report.csv.
Songs with no BPM from any of these are left out and listed at the end, so you can add them to yt_overrides.json.
Every song's source, matched version and both measurements go to bpm_report.csv; doubtful ones are marked "check"
there and in the app's song list, so you know which to listen to and fix with ½ / ×2 or yt_overrides.json.

This tool reads YouTube Music through ytmusicapi, an unofficial source, so it is a dev tool: it only runs while
RUNDJ_DEV_SOURCES is not "0" (default on; the release app never uses it).

Private playlists and Liked Music ("LM") need you signed in:   ytmusicapi browser   (follow its prompts, then pass
--auth browser.json). Public and unlisted playlists work without it.
BPM data from Apple iTunes previews and GetSongBPM (https://getsongbpm.com).
"""
import argparse, csv, json, os, re, ssl, sys, tempfile, time, unicodedata, urllib.error, urllib.parse, urllib.request
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from bpm_resolve import resolve_bpm, votes_text, LABEL as SRC_LABEL
DEV_SOURCES = os.environ.get("RUNDJ_DEV_SOURCES", "1") != "0"      # unofficial sources (ytmusicapi): on in debug, off in release
OVERRIDES = HERE / "yt_overrides.json"
LOCAL_CACHE = HERE / "rundj_cache.json"
BPM_CACHE = HERE / "yt_bpm_cache.json"
UA = {"User-Agent": "RunDJ/0.2 (https://github.com/krishc99/endure)"}   # app name + contact URL, as LRCLIB asks
# python.org's macOS Python ships without CA certificates, so urllib can't verify HTTPS. Use certifi's (installed with
# ytmusicapi's requests) when it's there.
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    SSL_CTX = ssl.create_default_context()


# ------------------------------------------------------------ helpers
def norm(s):
    """Lowercase, no accents, no '(feat. x)', '- Remastered 2011', '[Official Video]' and the like, no punctuation."""
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[\(\[][^\)\]]*(feat|ft\.|with |remaster|official|video|audio|lyric|version|edit|mix|live)[^\)\]]*[\)\]]", " ", s)
    s = re.sub(r"\s-\s.*(remaster|version|edit|mix|live|mono|stereo).*$", " ", s)
    s = re.sub(r"\b(feat|ft)\..*$", " ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def first_artist(a):
    return re.sub(r"^the ", "", norm(re.split(r",|&| x | and |feat\.|ft\.", a or "")[0]))


def playlist_id(s):
    q = urllib.parse.urlparse(s).query
    return urllib.parse.parse_qs(q).get("list", [s])[0] if q else s


def get_json(url, headers=None, timeout=15):
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
        return json.loads(r.read().decode())


def embeddable(video_id):
    """True if YouTube lets this video play in an embedded player (oEmbed answers 401/403 when embedding is off)."""
    try:
        get_json("https://www.youtube.com/oembed?format=json&url=" +
                 urllib.parse.quote(f"https://www.youtube.com/watch?v={video_id}"))
        return True
    except urllib.error.HTTPError as e:
        return False if e.code in (401, 403, 404) else None
    except Exception:
        return None          # network hiccup: don't know, keep the original


def load(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


# ------------------------------------------------------------ BPM sources
def rank01(vals):
    n = len(vals)
    out = [0.5] * n
    for pos, i in enumerate(sorted(range(n), key=lambda i: vals[i])):
        out[i] = pos / (n - 1) if n > 1 else 0.5
    return out


def local_index():
    """(title, first artist) → cache entry from dj_live.py's analysis of your local files."""
    idx = {}
    for e in load(LOCAL_CACHE, {}).values():
        if e.get("bpm"):
            idx[(norm(e.get("title")), first_artist(e.get("artist")))] = e
    return idx


def getsongbpm(title, artist, key, cache):
    """Tempo from GetSongBPM, cached on disk (also caches misses, so reruns are fast and polite)."""
    ck = f"{norm(title)}|{first_artist(artist)}"
    if ck in cache:
        return cache[ck]
    out = None
    try:
        q = f"song:{norm(title)} artist:{first_artist(artist)}"
        d = get_json("https://api.getsongbpm.com/search/?" + urllib.parse.urlencode(
            {"api_key": key, "type": "both", "lookup": q, "limit": 10}))
        hits = d.get("search") if isinstance(d, dict) else None
        if isinstance(hits, list):
            want_t, want_a = norm(title), first_artist(artist)
            def score(h):
                ht = norm(h.get("title"))
                ha = norm((h.get("artist") or {}).get("name") if isinstance(h.get("artist"), dict) else "")
                return (ht == want_t) * 2 + bool(want_a and ha and (want_a in ha or ha in want_a))
            best = max(hits, key=score, default=None)
            if best and score(best) >= 2 and str(best.get("tempo") or "").strip():
                bpm = float(best["tempo"])
                if 40 <= bpm <= 250:
                    out = dict(bpm=bpm, id=best.get("id"),
                               dance=float(best["danceability"]) if str(best.get("danceability") or "").strip() else None)
        time.sleep(0.4)       # be gentle with the free API
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            sys.exit("GetSongBPM rejected the API key (HTTP %d). Check --bpm-key / GETSONGBPM_KEY." % e.code)
        print(f"    GetSongBPM error for {title}: HTTP {e.code}")
        return None           # don't cache errors
    except Exception as e:
        print(f"    GetSongBPM error for {title}: {e}")
        return None
    cache[ck] = out
    return out


# ------------------------------------------------------------ version tags
# Words that change the tempo or the recording. "Radio edit", "remaster", "single version" don't change tempo, so ignored.
VTAGS = ("remix", "acoustic", "live", "slowed", "sped up", "speed up", "nightcore", "unplugged", "piano", "orchestral",
         "cover", "reverb", "rework", "vip", "bootleg", "flip")
CORE = {"remix", "acoustic", "live", "slowed", "sped up", "nightcore", "piano", "orchestral", "cover", "reverb"}


def version_tags(title):
    """Tempo-relevant version markers in a title, e.g. 'Cold Heart (PNAU Remix)' → {'remix', 'pnau'}."""
    t = unicodedata.normalize("NFKD", title or "").encode("ascii", "ignore").decode().lower()
    tags = set()
    for part in re.findall(r"[\(\[]([^\)\]]*)[\)\]]", t) + re.findall(r"\s-\s(.*)$", t):
        words = re.sub(r"[^a-z0-9 ]+", " ", part).split()
        hit = [v for v in VTAGS if re.search(r"\b" + v + r"\b", part)]
        if re.search(r"\bmix\b", part) and not re.search(r"\b(radio|album|original|single|extended)\s+mix\b", part):
            hit.append("remix")
        if hit:
            tags.update("remix" if h in ("rework", "vip", "bootleg", "flip") else h.replace("speed", "sped") for h in hit)
            if "unplugged" in hit:
                tags.update(("acoustic", "live"))
            if "remix" in tags:     # the remixer's name: 'pnau remix' → 'pnau'
                tags.update(w for w in words if w not in ("remix", "mix", "edit", "radio", "extended", "version", "feat", "ft")
                            and len(w) > 2)
    return tags


def base_title(title):
    return norm(re.sub(r"[\(\[][^\)\]]*[\)\]]|\s-\s.*$", " ", title or "")) or norm(title)


JUNK = ("karaoke", "tribute", "made famous", "originally performed", "in the style of", "instrumental", "lullaby",
        "8 bit", "8-bit", "backing track", "workout", "cover version", "piano version", "music box", "renditions")
PLAIN = {"feat", "ft", "featuring", "with", "remaster", "remastered", "digital", "radio", "edit", "single", "album",
         "explicit", "clean", "mono", "stereo", "version", "original", "deluxe", "bonus", "track", "from", "the", "and",
         "of", "a", "edition", "mix", "soundtrack", "motion", "picture", "film", "movie"}


def artist_names(a):
    return {re.sub(r"^the ", "", norm(x)) for x in re.split(r",|&| x | and |feat\.?|ft\.?|featuring|/|\bwith\b", a or "", flags=re.I) if norm(x)}


def pick_version(cands, title, artist, dur, is_video):
    """cands: list of (title_with_version, artist, duration_s, payload).
    Returns (payload, why, extra): the best same-version candidate. Prefers the exact artist (not 'Hello I'm Adele'),
    no karaoke/tribute/instrumental, no unexplained extras like '(Wedding Version)', then the closest length.
    extra names leftover version words when the best match still has some, so it can be flagged."""
    want_tags, want_a, want_t = version_tags(title), first_artist(artist), base_title(title)
    names = want_tags - CORE - {"unplugged"}
    words = lambda x: set(re.findall(r"[a-z0-9]+", unicodedata.normalize("NFKD", x).encode("ascii", "ignore").decode().lower()))
    my_words = words(title + " " + artist)
    my_artists = artist_names(artist)
    best, why = None, "no track with this title and artist"
    for ct, ca, cd, payload in cands:
        if base_title(ct) != want_t:
            continue
        low = (ct + " " + ca).lower()
        if any(j in low and j not in title.lower() for j in JUNK):
            why = "only karaoke/tribute/instrumental versions found"
            continue
        their = artist_names(ca)
        if want_a in their:
            ascore = 2
        elif re.search(r"\b" + re.escape(want_a) + r"\b", norm(ca)) and not (their - my_artists - artist_names(ct)):
            ascore = 1
        else:
            continue
        tags = version_tags(ct)
        if (tags & CORE) != (want_tags & CORE) or not names <= tags:
            why = f"found the song, but not this version ({', '.join(sorted(want_tags & CORE)) or 'original'})"
            continue
        dd = abs(cd - dur) if dur and cd else 0
        if dd > (60 if is_video else 20):
            why = f"closest version is {dd:.0f}s longer/shorter"
            continue
        paren = " ".join(re.findall(r"[\(\[]([^\)\]]*)[\)\]]", ct)) + " " + " ".join(re.findall(r"\s-\s(.*)$", ct))
        extra = [w for w in words(paren) if w not in PLAIN and w not in my_words and not w.isdigit()
                 and not any(w in n.split() for n in their | my_artists)]
        title_words = set(norm(title).split())
        guests = [n for n in their - my_artists if not set(n.split()) <= title_words]   # e.g. a duet partner you don't have
        score = ascore * 10 - len(extra) * 3 - len(guests) * 2 - dd / 10
        if best is None or score > best[0]:
            best = (score, payload, dd, f"{ct} — {ca}", extra)
    if not best:
        return None, why, ""
    _, payload, dd, label, extra = best
    return payload, f"{label} (Δlength {dd:.0f}s)", (f"“{label}”" if extra else "")


ITUNES_COUNTRY = "IN"
_last_itunes = [0.0]


def itunes_get(params):
    """Apple's iTunes Search API: free, no key, ~20 requests a minute, so calls are spaced 3 s apart."""
    wait = 3.1 - (time.time() - _last_itunes[0])
    if wait > 0:
        time.sleep(wait)
    _last_itunes[0] = time.time()
    return get_json("https://itunes.apple.com/search?" + urllib.parse.urlencode(params)).get("results") or []


def itunes_bpm(vid, title, artist, dur, is_video, cache, use_preview):
    """Finds the same version on Apple Music/iTunes and measures its 30 s preview. Cached per video."""
    ck = f"it3|{vid}"
    if ck in cache:
        return cache[ck]
    if not use_preview:
        return dict(bpm=None, why="iTunes gives no BPM, only a preview to measure (and --no-preview is set)")
    try:
        raw_t = re.sub(r"[\(\[][^\)\]]*[\)\]]|\s-\s.*$", " ", title).strip().strip(".") or title
        res = cache.get(f"its|{vid}")
        if res is None:                       # search results are cached too: reruns don't hit Apple's rate limit
            res = [{k: r.get(k) for k in ("trackName", "artistName", "trackTimeMillis", "previewUrl")} for r in itunes_get(
                {"term": f"{raw_t} {re.split(r',|&', artist)[0].strip()}", "media": "music", "entity": "song",
                 "limit": 25, "country": ITUNES_COUNTRY})]
            cache[f"its|{vid}"] = res
        cands = [(r.get("trackName") or "", r.get("artistName") or "", (r.get("trackTimeMillis") or 0) / 1000, r)
                 for r in res if r.get("previewUrl")]
        x, why, extra = pick_version(cands, title, artist, dur, is_video)
        if not x:
            out = dict(bpm=None, why="iTunes: " + why)
        else:
            m = preview_measure(x["previewUrl"], ".m4a")
            if not m:
                return dict(bpm=None, why="iTunes preview couldn't be measured")
            bpm = m["bpm"]
            out = dict(bpm=bpm, alts=[], src="itunes-preview", match=why, pv_bpm=bpm, ests=m["ests"], feats=m["feats"],
                       flag=f"{m['agree']} of {m['n']} estimators agree ({m['ests']})")
            if m["n"] >= 3 and m["agree"] < 3 or m["n"] == 2 and m["agree"] < 2:
                out.update(src="check", flag=f"estimators disagree ({m['ests']}): listen and fix")
            elif m["alt"]:
                out.update(src="check", flag=f"most estimators say {bpm:.0f} but {m['alt'][0]} says {m['alt'][1]:.0f} "
                                             f"(triplet/swing feel?) ({m['ests']}): listen and fix")
            elif m["n"] == 2 and m["steady"] < 0.6:
                out.update(src="check", flag=f"irregular beat ({m['ests']}, steadiness {m['steady']:.2f}): listen and fix")
            if bpm < 110 and bpm * 2 <= 220:
                out["alts"] = [dict(bpm=round(bpm * 2, 1), conf=0.5)]   # slow reading: could be double-time
            if extra:
                out.update(src="check", flag=f"matched {extra}, which may be a different version: listen and fix")
    except urllib.error.HTTPError as e:
        return dict(bpm=None, why=f"iTunes HTTP {e.code}" + (" (rate limited, rerun later)" if e.code in (403, 429) else ""))
    except Exception as e:
        return dict(bpm=None, why=f"iTunes error: {e}")
    cache[ck] = out
    return out


MB_UA = {"User-Agent": "RunDJ/0.2 ( https://github.com/krishc99/endure )"}
_last_mb, _ab_fails = [0.0], [0]


def acousticbrainz_vote(title, artist, dur, cache):
    """Vote from AcousticBrainz (via MusicBrainz, 1 request a second), or None. Misses are cached; an unreachable
    service is given up on after 3 failures in a row. Missing data is normal."""
    ck = f"ab1|{norm(title)}|{first_artist(artist)}|{round(dur)}"
    if ck in cache:
        return cache[ck] or None
    if _ab_fails[0] >= 3:
        return None
    out = None
    try:
        raw_t = re.sub(r"[\(\[][^\)\]]*[\)\]]|\s-\s.*$", " ", title).replace('"', " ").strip() or title
        q = f'recording:"{raw_t}" AND artist:"{re.split(r",|&", artist)[0].replace(chr(34), " ").strip()}"'
        wait = 1.1 - (time.time() - _last_mb[0])
        if wait > 0:
            time.sleep(wait)
        _last_mb[0] = time.time()
        recs = get_json("https://musicbrainz.org/ws/2/recording?" + urllib.parse.urlencode({"query": q, "fmt": "json", "limit": 10}),
                        headers=MB_UA).get("recordings") or []
        cands = [(r.get("title") or "", ", ".join((c.get("name") or "") for c in r.get("artist-credit") or []),
                  (r.get("length") or 0) / 1000, r) for r in recs]
        for _ in range(3):
            x, why, extra = pick_version(cands, title, artist, dur, False)
            if not x:
                break
            cands = [c for c in cands if c[3] is not x]
            try:
                d = get_json(f"https://acousticbrainz.org/api/v1/{x['id']}/low-level", headers=MB_UA, timeout=30)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    continue                       # no analysis for this recording: normal
                raise
            rh = d.get("rhythm") or {}
            bpm = float(rh.get("bpm") or 0)
            if 40 <= bpm <= 250:
                out = dict(value=round(bpm, 1), source="acousticbrainz", confidence=0.6, mbid=x["id"])
                break
        _ab_fails[0] = 0
    except Exception as e:
        _ab_fails[0] += 1
        print(f"    AcousticBrainz unavailable ({e})" + (" - not trying again this run" if _ab_fails[0] >= 3 else ""))
        return None
    cache[ck] = out or {}
    return out


def preview_vote(r):
    """The iTunes preview measurement as a vote: confidence = share of estimators that agree; its own doubts travel with it."""
    m = re.search(r"(\d+) of (\d+) estimators agree", r.get("flag") or "")
    v = dict(value=r["bpm"], source="preview", confidence=round(int(m.group(1)) / int(m.group(2)), 2) if m else 0.4)
    if r.get("src") == "check":
        v["doubt"] = r.get("flag") or "the preview measurement is doubtful"
    return v


def apply_resolution(entry, res):
    """Write the resolver's decision into the library entry (the same fields src/analyzer.js resolveMeta sets)."""
    entry["bpmFlag"], entry["bpmFeel"], entry["bpmWhy"] = res["flag"], res["feel"], res["why"]
    if res["source"] == "override":
        return
    entry["bpm"] = res["bpm"]
    entry["src"] = "check" if res["flag"] == "check" else SRC_LABEL[res["source"]]
    entry["flag"] = res["why"]
    if res["source"] != "local":                      # the other reading of the song, for the matcher
        if res["feel"] != "normal":
            entry["alts"] = [dict(bpm=round(res["detected"], 1), conf=0.5)]
        else:
            entry["alts"] = [dict(bpm=round(res["bpm"] * 2, 1), conf=0.5)] if res["bpm"] < 110 and res["bpm"] * 2 <= 220 else []


def load_audio(path, librosa):
    """Decode a preview. .m4a (iTunes) needs a converter: macOS's built-in afconvert, else ffmpeg, else librosa itself."""
    import shutil, subprocess
    if not path.endswith(".m4a"):
        return librosa.load(path, sr=22050, mono=True)
    wav = path[:-4] + ".wav"
    try:
        for cmd in (["afconvert", "-f", "WAVE", "-d", "LEI16", path, wav],
                    ["ffmpeg", "-loglevel", "error", "-y", "-i", path, wav]):
            if shutil.which(cmd[0]) and subprocess.run(cmd, capture_output=True).returncode == 0:
                return librosa.load(wav, sr=22050, mono=True)
        return librosa.load(path, sr=22050, mono=True)
    finally:
        if os.path.exists(wav):
            os.unlink(wav)


PREVIEWS = HERE / ".previews"          # downloaded 30 s previews, kept so a rerun can re-measure without downloading


def fetch_preview(url, suffix):
    import hashlib
    PREVIEWS.mkdir(exist_ok=True)
    path = PREVIEWS / (hashlib.sha1(url.split("?")[0].encode()).hexdigest()[:16] + suffix)
    if not path.exists() or path.stat().st_size < 1000:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=20, context=SSL_CTX) as r:
            path.write_bytes(r.read())
    return str(path)


def librosa_tempo(y, sr, librosa, np):
    """Tempo with a FLAT prior (librosa's default pulls everything toward 120), then refined from the beat spacing,
    so results aren't stuck on librosa's coarse tempo bins (…117.5, 123.0, 129.2…)."""
    import scipy.stats
    oenv = librosa.onset.onset_strength(y=y, sr=sr)
    t0 = float(np.atleast_1d(librosa.feature.tempo(onset_envelope=oenv, sr=sr, prior=scipy.stats.uniform(55, 165)))[0])
    _, beats = librosa.beat.beat_track(onset_envelope=oenv, sr=sr, bpm=t0)
    bt = librosa.frames_to_time(beats, sr=sr)
    if len(bt) > 8:
        d = np.diff(bt)
        ref = 60 / float(np.median(d))
        if abs(ref - t0) / t0 < 0.08:
            t0 = ref
        return t0, max(0.0, 1 - float(np.std(d) / np.mean(d)) * 5)
    return t0, 0.0


def essentia_tempos(path):
    """Essentia's two best estimators, if installed (pip3 install essentia). Much better on ballads than librosa."""
    try:
        import essentia, essentia.standard as es
    except ImportError:
        return []
    try:
        essentia.log.infoActive = False
        essentia.log.warningActive = False
        a = es.MonoLoader(filename=path, sampleRate=44100)()
        bpm, _, conf, _, _ = es.RhythmExtractor2013(method="multifeature")(a)
        out = [("essentia", float(bpm), float(conf))]
        out.append(("percival", float(es.PercivalBpmEstimator()(a)), None))
        return out
    except Exception:
        return []


def preview_measure(url, suffix=".mp3"):
    """Several independent tempo estimates of a 30 s preview, and how well they agree.
    Returns dict(bpm, steady, agree, n, ests, octave) or None. Two estimates 'agree' when equal or exactly 2× apart."""
    try:
        import librosa, numpy as np
    except ImportError:
        return None
    import warnings
    warnings.filterwarnings("ignore")
    try:
        path = fetch_preview(url, suffix)
        ests = []
        for name, bpm, conf in essentia_tempos(path) if not path.endswith(".m4a") else []:
            ests.append((name, bpm))
        y, sr = load_audio(path, librosa)
        if path.endswith(".m4a") and not ests:          # essentia can't read .m4a: give it a decoded copy
            import soundfile as sf
            wav = path[:-4] + ".tmp.wav"
            try:
                sf.write(wav, y, sr)
                ests += [(n, b) for n, b, _ in essentia_tempos(wav)]
            except Exception:
                pass
            finally:
                if os.path.exists(wav):
                    os.unlink(wav)
        feats = dict(loud=float(20 * np.log10(librosa.feature.rms(y=y).mean() + 1e-9)),
                     rate=len(librosa.onset.onset_detect(y=y, sr=sr)) / (len(y) / sr),
                     bright=float(librosa.feature.spectral_centroid(y=y, sr=sr).mean()))
        t, steady = librosa_tempo(y, sr, librosa, np)
        ests.append(("librosa", t))
        yp = librosa.effects.percussive(y)
        tp, _ = librosa_tempo(yp, sr, librosa, np)
        ests.append(("librosa-drums", tp))
        ests = [(n, round(b, 1)) for n, b in ests if 40 <= b <= 250]
        if not ests:
            return None
        # biggest group of estimates that agree (same tempo or one octave apart)
        groups = [[e for e in ests if related(e[1], f[1]) or related(f[1], e[1])] for f in ests]
        g = max(groups, key=len)
        rep = next((e for e in g if e[0] == "essentia"), g[0])
        octave = len({round(e[1] / rep[1]) for e in g if related(rep[1], e[1]) != "same"}) > 0
        # an estimate at 2/3 or 3/2 of the pick is the classic triplet / swing confusion: worth a listen
        alt = next((e for e in ests if e not in g and any(abs(e[1] / rep[1] - r) / r < 0.04 for r in (2 / 3, 1.5, 4 / 3, 0.75))), None)
        return dict(bpm=rep[1], steady=round(steady, 2), agree=len(g), n=len(ests), octave=octave, alt=alt, feats=feats,
                    ests=", ".join(f"{n} {b:.0f}" for n, b in ests))
    except Exception:
        return None


def preview_bpm(url):
    m = preview_measure(url)
    return m["bpm"] if m else None


def related(a, b, tol=0.04):
    """'same', 'double' (b ≈ 2a), 'half' (b ≈ a/2) or None."""
    for k, m in (("same", 1), ("double", 2), ("half", 0.5)):
        if abs(b - a * m) / (a * m) <= tol:
            return k
    return None


# ------------------------------------------------------------ song structure from YouTube Music's timed lyrics
# Without the audio we can't analyse sections, but YouTube Music has time-stamped lyrics for most songs. Lines that
# come back again and again are the chorus, and the gaps between lyric blocks are the section boundaries. From that,
# plus the BPM, we build the same per-bar data dj_live.py makes from audio: [time, exit score, phrase start, energy].
# The engine then leaves a song after its LAST chorus, brings the next one in at its FIRST chorus, and keeps
# swaps on section boundaries.
def secs(length):
    try:
        p = [int(x) for x in str(length).split(":")]
        return float(sum(v * 60 ** i for i, v in enumerate(reversed(p))))
    except Exception:
        return 0.0


def watch_info(yt, vid, cache):
    """videoType, length, the audio-only counterpart and the lyrics id for a video. Cached."""
    ck = f"wt1|{vid}"
    if ck in cache:
        return cache[ck]
    w, err = None, ""
    for attempt in range(3):                  # YouTube sometimes refuses bursts of requests: back off and retry
        try:
            w = yt.get_watch_playlist(videoId=vid, limit=1)
            break
        except Exception as e:
            err = f"{type(e).__name__}: {e}"[:160]
            time.sleep(2 + 4 * attempt)
    if w is None:
        return dict(type="", length=0, lyrics=None, cp_id=None, cp_type="", cp_length=0, err=err)
    try:
        t = (w.get("tracks") or [{}])[0]
        cp = t.get("counterpart") or {}
        out = dict(type=t.get("videoType") or "", length=secs(t.get("length")), lyrics=w.get("lyrics"),
                   cp_id=cp.get("videoId"), cp_type=cp.get("videoType") or "", cp_length=secs(cp.get("length")))
    except Exception as e:
        return dict(type="", length=0, lyrics=None, cp_id=None, cp_type="", cp_length=0, err=f"{type(e).__name__}: {e}"[:160])
    cache[ck] = out
    return out


_lyrics_warned = [False]


def patch_ytmusicapi():
    """ytmusicapi 1.10.x (the newest that runs on Python 3.9) crashes with KeyError 'endpoint' in get_watch_playlist
    when a tab has no link. Replace its tab lookup with the newer, tolerant one (find the lyrics tab by its type)."""
    try:
        import ytmusicapi.mixins.watch as mw
    except Exception:
        return
    if not hasattr(mw, "get_tab_browse_id"):
        return                                  # newer ytmusicapi: already fixed

    def tab_browse_id(wnr, tab_id):
        want = "MUSIC_PAGE_TYPE_TRACK_LYRICS" if tab_id == 1 else "MUSIC_PAGE_TYPE_TRACK_RELATED"
        for tab in (wnr or {}).get("tabs", []):
            be = ((tab.get("tabRenderer") or {}).get("endpoint") or {}).get("browseEndpoint") or {}
            pt = ((be.get("browseEndpointContextSupportedConfigs") or {}).get("browseEndpointContextMusicConfig") or {}).get("pageType")
            if pt == want and be.get("browseId"):
                return be["browseId"]
        return None
    mw.get_tab_browse_id = tab_browse_id


def lrclib_lyrics(title, artist, dur, cache):
    """Synced lyrics from LRCLIB (free, open, no key), matched by title, artist and length (±2 s, so the timing fits
    this recording). [[start_s, end_s, text], ...] or None. Cached."""
    ck = f"lrc1|{norm(title)}|{first_artist(artist)}|{round(dur)}"
    if ck in cache:
        return cache[ck]
    out = None
    try:
        raw_t = re.sub(r"[\(\[][^\)\]]*[\)\]]|\s-\s.*$", " ", title).strip() or title
        res = get_json("https://lrclib.net/api/search?" + urllib.parse.urlencode(
            {"track_name": raw_t, "artist_name": re.split(r",|&", artist)[0].strip()}))
        best = None
        for r in res if isinstance(res, list) else []:
            if not r.get("syncedLyrics") or not dur or abs(float(r.get("duration") or 0) - dur) > 2:
                continue
            if base_title(r.get("trackName") or "") != base_title(title):
                continue
            if best is None or abs(r["duration"] - dur) < abs(best["duration"] - dur):
                best = r
        if best:
            pts = []
            for ln in best["syncedLyrics"].splitlines():
                m = re.match(r"\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)", ln)
                if m:
                    pts.append((int(m.group(1)) * 60 + float(m.group(2)), m.group(3)))
            out = [[a, (pts[i + 1][0] if i + 1 < len(pts) else a + 4), t] for i, (a, t) in enumerate(pts) if t.strip()]
            out = out or None
    except Exception:
        return None                               # network trouble: don't cache, try again next run
    cache[ck] = out
    return out


def timed_lyrics(yt, browse_id, cache):
    """[[start_s, end_s, text], ...] or None (no lyrics, or no timestamps for this song). Cached."""
    if not browse_id:
        return None
    ck = f"ly1|{browse_id}"
    if ck in cache:
        return cache[ck]
    try:
        r = yt.get_lyrics(browse_id, timestamps=True)
    except TypeError:
        if not _lyrics_warned[0]:
            print("    (your ytmusicapi is too old for timed lyrics: pip3 install -U ytmusicapi)")
            _lyrics_warned[0] = True
        return None
    except Exception:
        r = None
    out = None
    if r and r.get("hasTimestamps"):
        out = []
        for ln in r.get("lyrics") or []:
            g = (lambda k: getattr(ln, k, None) if not isinstance(ln, dict) else ln.get(k))
            if g("text") is not None and g("start_time") is not None:
                out.append([g("start_time") / 1000, (g("end_time") or g("start_time")) / 1000, g("text")])
    cache[ck] = out
    return out


def structure_from_lyrics(lines, bpm, dur):
    """Per-bar structure, or None if the lyrics don't show a repeating chorus."""
    from collections import Counter
    key = lambda t: re.sub(r"[^a-z0-9 ]+", "", unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode().lower()).strip()
    L = [(a, b, key(t)) for a, b, t in lines if key(t) and key(t) not in ("", "music", "instrumental")]
    if len(L) < 8 or not bpm or not dur:
        return None
    bar = 240.0 / bpm
    while bar < 1.6:            # a fast reading (e.g. 170) gives 1.4 s bars: phrases are still ~2-3 s
        bar *= 2
    cnt = Counter(k for _, _, k in L)
    rep = [cnt[k] >= 2 and len(k.split()) >= 2 for _, _, k in L]
    # chorus = a run of >= 3 repeated lines (one stray line allowed) lasting >= 2 bars
    runs, i = [], 0
    while i < len(L):
        if not rep[i]:
            i += 1
            continue
        j, miss = i, 0
        while j + 1 < len(L) and L[j + 1][0] - L[j][1] < 2 * bar and (rep[j + 1] or (miss == 0 and j + 2 < len(L) and rep[j + 2])):
            miss += 0 if rep[j + 1] else 1
            j += 1
        if j - i + 1 >= 3 and L[j][1] - L[i][0] >= 2 * bar:
            runs.append([L[i][0] - 0.25 * bar, L[j][1]])
        i = j + 1
    if not runs:
        return None
    # snap chorus ends up to the bar grid, anchored on the first chorus (choruses start on a downbeat)
    anchor = runs[0][0]
    k0 = -int(anchor // bar)
    grid = [anchor + k * bar for k in range(k0, int((dur - anchor) // bar) + 1) if 0 <= anchor + k * bar < dur - 0.5]
    if len(grid) < 16:
        return None
    first_line, last_line = L[0][0], L[-1][1]
    starts = {round(L[i][0], 2) for i in range(len(L)) if i == 0 or L[i][0] - L[i - 1][1] > 1.5 * bar}  # new lyric blocks
    in_ch = lambda t: any(a - 0.1 <= t < b for a, b in runs)
    sung = lambda a, b: any(x < b and y > a for x, y, _ in L)
    bars = []
    for n, t in enumerate(grid):
        k = round((t - anchor) / bar)
        if in_ch(t):
            e = 0.9
        elif t + bar <= first_line:
            e = 0.35                                    # intro
        elif t >= last_line + bar:
            e = 0.3                                     # outro
        elif not sung(t, t + 2 * bar):
            e = 0.55                                    # instrumental break
        else:
            e = 0.6                                     # verse / bridge
        ex = 0.0
        if n and in_ch(grid[n - 1]) and not in_ch(t):
            ex = 1.0                                    # the bar right after a chorus ends
        elif any(t - 0.5 * bar <= s0 < t + 0.5 * bar for s0 in starts):
            ex = 0.6                                    # a new lyric block starts here
        ph = 1 if k % 8 == 0 else 0
        bars.append([round(t, 2), round(min(1.0, ex + 0.25 * ph), 2), ph, e])
    wave = [int(100 * (bars[min(len(bars) - 1, max(0, int(i / 240 * dur / bar)))][3])) for i in range(240)]
    return dict(bars=bars, wave=wave, first_bar=bars[0][0], choruses=len(runs),
                last_chorus_end=round(runs[-1][1], 1))


# ------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("playlist", help="playlist URL or ID (LM = your Liked Music, needs --auth)")
    ap.add_argument("--out", default="yt_library.json")
    ap.add_argument("--auth", help="ytmusicapi auth file (browser.json) for private playlists")
    ap.add_argument("--bpm-key", default=os.environ.get("GETSONGBPM_KEY"), help="GetSongBPM API key")
    ap.add_argument("--no-embed-check", action="store_true", help="skip checking that each video can play embedded")
    ap.add_argument("--no-preview", action="store_true", help="don't measure the iTunes 30 s previews with librosa")
    ap.add_argument("--no-acousticbrainz", action="store_true", help="don't ask AcousticBrainz for a second tempo vote")
    ap.add_argument("--energy-hi", type=float, default=0.7, help="double-time if energy is at least this ... (default 0.7)")
    ap.add_argument("--bpm-low", type=float, default=100, help="... and the detected BPM is below this (default 100)")
    ap.add_argument("--energy-lo", type=float, default=0.3, help="half-time if energy is at most this ... (default 0.3)")
    ap.add_argument("--bpm-high", type=float, default=150, help="... and the detected BPM is above this (default 150)")
    ap.add_argument("--recheck", action="store_true", help="ignore cached iTunes/GetSongBPM results")
    ap.add_argument("--keep-videos", action="store_true",
                    help="play music videos as listed (default: switch to the song's audio version, which has no "
                         "video intro/skits and lines up with the lyrics timing)")
    args = ap.parse_args()
    rsettings = dict(energyHi=args.energy_hi, bpmLow=args.bpm_low, energyLo=args.energy_lo, bpmHigh=args.bpm_high)

    if not DEV_SOURCES:
        sys.exit("yt_library.py reads YouTube Music through ytmusicapi (an unofficial source) and is disabled while RUNDJ_DEV_SOURCES=0.")
    try:
        from ytmusicapi import YTMusic
    except ImportError:
        sys.exit("Install ytmusicapi first:  pip3 install ytmusicapi")
    patch_ytmusicapi()
    yt = YTMusic(args.auth) if args.auth else YTMusic()
    pid = playlist_id(args.playlist)
    try:
        pl = yt.get_playlist(pid, limit=None)
    except Exception as e:
        sys.exit(f"Could not read playlist {pid}: {e}\n"
                 "If it's private (or Liked Music), sign in with `ytmusicapi browser` and pass --auth browser.json.")
    tracks = [t for t in pl.get("tracks", []) if t.get("videoId")]
    print(f"Playlist “{pl.get('title', pid)}”: {len(tracks)} tracks")
    if not args.no_preview:
        try:
            import librosa  # noqa: F401
        except ImportError:
            print("librosa isn't installed, so iTunes previews can't be measured (pip3 install librosa).")
    overrides, local, bpmcache = load(OVERRIDES, {}), local_index(), ({} if args.recheck else load(BPM_CACHE, {}))
    songs, missing, blocked, report = [], [], [], []
    for i, t in enumerate(tracks, 1):
        vid, title = t["videoId"], t.get("title") or "?"
        artist = ", ".join(a["name"] for a in t.get("artists") or [] if a.get("name"))
        dur = float(t.get("duration_seconds") or 0)
        print(f"  [{i}/{len(tracks)}] {title} — {artist}")
        if t.get("isAvailable") is False:
            blocked.append(f"{title} — {artist} (unavailable in your region / removed)")
            continue

        # Can it play in an embedded player? If not, look for another upload of the same song that can.
        play_id = vid
        if not args.no_embed_check and embeddable(vid) is False:
            play_id = None
            try:
                for filt in ("songs", "videos"):
                    for r in yt.search(f"{title} {artist}", filter=filt, limit=5)[:5]:
                        rid = r.get("videoId")
                        ra = ", ".join(a["name"] for a in r.get("artists") or [] if a.get("name"))
                        rd = float(r.get("duration_seconds") or 0)
                        same = norm(r.get("title")) == norm(title) and first_artist(ra) == first_artist(artist)
                        if rid and rid != vid and same and (filt == "videos" or not dur or abs(rd - dur) <= 5) \
                                and embeddable(rid):
                            play_id, dur = rid, rd or dur
                            print(f"    embedding is off for {vid}; using {rid} ({filt[:-1]}) instead")
                            break
                    if play_id:
                        break
            except Exception as e:
                print(f"    search failed: {e}")
            if not play_id:
                blocked.append(f"{title} — {artist} (embedding disabled, no playable alternative found)")
                continue

        # Prefer the audio-only version of a music video: no intro or skits, and the lyric timings match it
        wi = watch_info(yt, play_id, bpmcache)
        vtype = wi.get("type") or str(t.get("videoType") or "")
        if not args.keep_videos and "ATV" not in vtype and wi.get("cp_id") and "ATV" in wi.get("cp_type", "")                 and (args.no_embed_check or embeddable(wi["cp_id"]) is not False):
            play_id, vtype = wi["cp_id"], wi["cp_type"]
            dur = wi.get("cp_length") or dur
            wi = watch_info(yt, play_id, bpmcache)
        entry = dict(file=f"yt:{play_id}", yt=play_id, yt_orig=vid, title=title, artist=artist, dur=dur,
                     bpm=None, src=None, alts=[], energy=0.5, bars=None, wave=None, first_bar=None)
        ov = overrides.get(vid, overrides.get(play_id))
        loc = local.get((norm(title), first_artist(artist)))
        rep = dict(video=play_id, title=title, artist=artist, length=round(dur), bpm="", source="", flag="",
                   matched="", preview_bpm="", votes="", feel="", check="")
        votes, dzr = [], None
        if ov is not None:
            ov = ov if isinstance(ov, dict) else {"bpm": ov}
            votes.append(dict(source="override", value=float(ov["bpm"]), confidence=1.0))
            entry.update(bpm=float(ov["bpm"]), src="edited")
            if "energy" in ov:
                entry["energy"] = float(ov["energy"])
        elif loc:
            votes.append(dict(source="local", value=float(loc["bpm"]), confidence=1.0))
            entry.update(bpm=loc["bpm"], src=loc.get("src") or "detected", alts=loc.get("alts") or [])
            rep.update(matched=f"{loc.get('title')} — {loc.get('artist')}")
        else:
            is_video = "OMV" in vtype or "UGC" in vtype
            dzr = itunes_bpm(vid, title, artist, dur, is_video, bpmcache, not args.no_preview)
            if dzr.get("bpm"):
                votes.append(preview_vote(dzr))
                entry["_feats"] = dzr.get("feats")
                rep.update(flag=dzr.get("flag", ""), matched=dzr.get("match", ""), preview_bpm=dzr.get("pv_bpm") or "")
            if not args.no_acousticbrainz:
                ab = acousticbrainz_vote(title, artist, dur, bpmcache)
                if ab:
                    votes.append(ab)
            if args.bpm_key:
                g = getsongbpm(title, artist, args.bpm_key, bpmcache)
                if g:
                    vt = version_tags(title)
                    votes.append(dict(source="getsongbpm", value=g["bpm"], confidence=0.5,
                                      **({"doubt": f"GetSongBPM matched the title only, may be the original not the {'/'.join(sorted(vt))}"} if vt else {})))
                    if g.get("dance") is not None and not dzr.get("bpm"):
                        entry["energy"] = round(min(1, max(0, g["dance"] / 100)), 2)
            if len(votes) == 1 and votes[0]["source"] != "preview":
                votes[0]["doubt"] = votes[0].get("doubt") or f"no iTunes preview to check {votes[0]['source']} against"
        entry["votes"] = votes
        res0 = resolve_bpm(votes, None, rsettings)         # energy isn't known until the whole playlist is ranked
        if res0:
            apply_resolution(entry, res0)
            if dzr is not None:
                print(f"    {entry['bpm']:.0f} BPM · {res0['why']}")
        elif dzr is not None:
            print(f"    no BPM · {dzr.get('why', '')}")
        rep["_dzr_why"] = (dzr or {}).get("why", "")
        if loc and not (ov and "energy" in ov):
            e = loc.get("energy_edit") if loc.get("energy_edit") is not None else loc.get("energy")
            if e is not None:
                entry["energy"] = e
            # Beat/section data only lines up when it's the same recording (same length, no video intro)
            if loc.get("bars") and dur and abs(float(loc.get("dur") or 0) - dur) <= 2:
                entry.update(bars=loc["bars"], wave=loc.get("wave"), first_bar=loc["bars"][0][0])
        # Sections from timed lyrics (only when the lyrics belong to exactly this recording)
        rep["sections"] = ""
        if entry["bpm"] and not entry["bars"]:
            # LRCLIB first, matched on this recording's exact length; YouTube Music's own timed lyrics are a dev-only extra
            lines = lrclib_lyrics(title, artist, dur, bpmcache)
            if not lines and DEV_SOURCES and ("ATV" in vtype or not vtype):
                lines = timed_lyrics(yt, wi.get("lyrics"), bpmcache)
            st = structure_from_lyrics(lines, entry["bpm"], dur) if lines else None
            if st:
                entry.update(bars=st["bars"], wave=st["wave"], first_bar=st["first_bar"])
                rep["sections"] = f"{st['choruses']} choruses, last ends {int(st['last_chorus_end'] // 60)}:{int(st['last_chorus_end'] % 60):02d}"
            else:
                rep["sections"] = ("no repeating chorus in the lyrics" if lines else
                                   "no lyrics for this recording: enters about a quarter in" +
                                   (f" (YouTube lookup failed: {wi['err']})" if wi.get("err") else ""))
            print(f"    sections: {rep['sections']}")
        rep["bpm"] = entry["bpm"] or ""
        if entry["bpm"] is None:
            rep["flag"] = rep.pop("_dzr_why", "") or "no BPM found"
            missing.append((play_id, title, artist))
        else:
            entry["_rep"] = rep
            songs.append(entry)
        rep.pop("_dzr_why", None)
        report.append(rep)
        BPM_CACHE.write_text(json.dumps(bpmcache, indent=1))      # save as we go: a long run can be resumed

    BPM_CACHE.write_text(json.dumps(bpmcache, indent=1))
    # Energy = average percentile rank of loudness, onset rate and brightness of each preview within this playlist
    # (same recipe as dj_live.py uses for local files). Overrides and local-file energies are kept.
    fs = [s for s in songs if s.get("_feats")]
    if len(fs) > 1:
        rk = {f: rank01([s["_feats"][f] for s in fs]) for f in ("loud", "rate", "bright")}
        for j, s in enumerate(fs):
            s["energy"] = round(sum(rk[f][j] for f in rk) / 3, 2)
    for s in songs:
        s.pop("_feats", None)
    # Final decision per song, now that energy is known (high energy + slow reading -> double-time, and so on)
    names = {"override": "yt_overrides.json", "local": "your local file", "preview": "iTunes preview",
             "acousticbrainz": "AcousticBrainz", "getsongbpm": "GetSongBPM"}
    for s in songs:
        r, res = s.pop("_rep"), resolve_bpm(s["votes"], s["energy"], rsettings)
        apply_resolution(s, res)
        r.update(bpm=s["bpm"], source=names[res["source"]], votes=votes_text(s["votes"]), feel=res["feel"],
                 check="check" if res["flag"] == "check" else "",
                 flag="; ".join(x for x in (r["flag"] if res["source"] == "preview" else "", res["why"]) if x))
    Path(args.out).write_text(json.dumps({"version": 1, "source": "youtube", "playlist": pl.get("title", pid),
                                          "playlistId": pid, "songs": songs}))
    by = {}
    for s in songs:
        by[s["src"]] = by.get(s["src"], 0) + 1
    print(f"\nWrote {len(songs)} songs to {args.out}  (BPM from: " +
          ", ".join(f"{v} {k}" for k, v in sorted(by.items())) + ")")
    rpath = Path(args.out).with_name("bpm_report.csv")
    with open(rpath, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(report[0].keys()) if report else ["video"])
        w.writeheader()
        w.writerows(report)
    chk = [r for r in report if r["check"]]
    print(f"Details for every song: {rpath}")
    if chk:
        print(f"\n{len(chk)} to listen to (marked 'check' in the app's song list):")
        for r in chk:
            print(f"  - {r['video']}  {r['title']} — {r['artist']}: {r['flag']}")
    nb = sum(1 for s in songs if s["bars"])
    print(f"{nb} of {len(songs)} have section data (from timed lyrics or your local files): they play to the end of "
          "their last chorus and enter at their first chorus. The rest swap ~3/4 through.")
    if blocked:
        print(f"\nLeft out, can't play embedded ({len(blocked)}):")
        for b in blocked:
            print("  - " + b)
    if missing:
        print(f"\nLeft out, no BPM found ({len(missing)}). Add them to {OVERRIDES.name} and rerun, e.g.:")
        print("  {" + ", ".join(f'"{v}": 120' for v, _, _ in missing[:3]) + "}")
        why = {r["video"]: r["flag"] for r in report}
        for v, t, a in missing:
            print(f"  - {v}  {t} — {a}" + (f"  ({why.get(v)})" if why.get(v) else ""))
    print("\nOn the phone: Import songs… → pick this file (no audio files needed for YouTube songs).")


if __name__ == "__main__":
    main()
