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
  3. Deezer (free, no key)     finds the SAME version on Deezer (title, artist, remix/acoustic/live tags and length must
                               agree), reads Deezer's BPM for it, and double-checks it by measuring Deezer's public
                               30-second preview of that version with librosa. Covers and remixes get their own tempo.
  4. GetSongBPM API            optional fallback: --bpm-key KEY or the GETSONGBPM_KEY environment variable
Songs with no BPM from any of these are left out and listed at the end, so you can add them to yt_overrides.json.
Every song's source, matched version and both measurements go to bpm_report.csv; doubtful ones are marked "check"
there and in the app's song list, so you know which to listen to and fix with ½ / ×2 or yt_overrides.json.

Private playlists and Liked Music ("LM") need you signed in:   ytmusicapi browser   (follow its prompts, then pass
--auth browser.json). Public and unlisted playlists work without it.
BPM data from Deezer (https://www.deezer.com) and GetSongBPM (https://getsongbpm.com).
"""
import argparse, csv, json, os, re, ssl, sys, tempfile, time, unicodedata, urllib.error, urllib.parse, urllib.request
from pathlib import Path

HERE = Path(__file__).parent
OVERRIDES = HERE / "yt_overrides.json"
LOCAL_CACHE = HERE / "rundj_cache.json"
BPM_CACHE = HERE / "yt_bpm_cache.json"
UA = {"User-Agent": "RunDJ/0.1 (personal test app)"}
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


# ------------------------------------------------------------ Deezer: the exact version's tempo
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
    ck = f"it2|{vid}"
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
            out = dict(bpm=bpm, alts=[], src="itunes-preview", match=why, dz_bpm=None, pv_bpm=bpm, ests=m["ests"],
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


def deezer_available():
    """Deezer's search is empty in countries where Deezer doesn't operate (India included)."""
    try:
        d = get_json("https://api.deezer.com/search?" + urllib.parse.urlencode({"q": "adele hello", "limit": 1}))
        return bool(d.get("data"))
    except Exception:
        return False


def deezer_match(title, artist, dur, is_video):
    """Best Deezer track for this exact version, or None. Returns (track dict, why)."""
    want_tags, want_a, want_t = version_tags(title), first_artist(artist), base_title(title)
    raw_t = re.sub(r"[\(\[][^\)\]]*[\)\]]|\s-\s.*$", " ", title).strip().strip(".").replace('"', "") or title
    q = f'track:"{raw_t}" artist:"{re.split(r",|&", artist)[0].strip()}"'
    res = get_json("https://api.deezer.com/search?" + urllib.parse.urlencode({"q": q, "limit": 25})).get("data") or []
    if not res:   # looser query: the advanced one is strict about punctuation
        res = get_json("https://api.deezer.com/search?" + urllib.parse.urlencode({"q": f"{want_t} {want_a}", "limit": 25})).get("data") or []
    best, why = None, "no Deezer track with this title and artist"
    for x in res:
        if base_title(x.get("title_short") or x.get("title")) != want_t:
            continue
        a = norm((x.get("artist") or {}).get("name"))
        if not (want_a and (want_a in a or a in want_a)):
            continue
        tags = version_tags((x.get("title") or "") + " " + (x.get("title_version") or ""))
        names = want_tags - CORE - {"unplugged"}           # the remixer's name must appear too
        if (tags & CORE) != (want_tags & CORE) or not names <= tags:
            why = f"Deezer has it, but not this version ({', '.join(sorted(want_tags)) or 'original'})"
            continue
        dd = abs(float(x.get("duration") or 0) - dur) if dur else 0
        # official music videos run long (intros, outros); audio uploads should be within a few seconds
        if dd > (60 if is_video else 20):
            why = f"Deezer's closest version is {dd:.0f}s longer/shorter"
            continue
        if best is None or dd < best[1]:
            best = (x, dd)
    return (best[0], f"Δlength {best[1]:.0f}s") if best else (None, why)


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
        return dict(bpm=rep[1], steady=round(steady, 2), agree=len(g), n=len(ests), octave=octave, alt=alt,
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


def deezer_bpm(vid, title, artist, dur, is_video, cache, use_preview):
    """dict(bpm, alts, src, flag, match, dz_bpm, pv_bpm) or dict(bpm=None, why=...). Cached per video."""
    ck = f"dz3|{vid}"
    if ck in cache:
        return cache[ck]
    try:
        x, why = deezer_match(title, artist, dur, is_video)
        time.sleep(0.15)
        if not x:
            out = dict(bpm=None, why=why)
        else:
            tr = get_json(f"https://api.deezer.com/track/{x['id']}")
            time.sleep(0.15)
            dz = float(tr.get("bpm") or 0) or None
            pv = preview_bpm(tr.get("preview") or x.get("preview")) if use_preview and (tr.get("preview") or x.get("preview")) else None
            match = f"{tr.get('title') or x.get('title')} — {(x.get('artist') or {}).get('name')} ({why})"
            out = dict(bpm=None, alts=[], src="deezer", flag="", match=match, dz_bpm=dz, pv_bpm=pv)
            if dz and pv:
                r = related(dz, pv)
                out["bpm"] = dz
                if r == "same":
                    out["flag"] = "confirmed by preview"
                elif r in ("double", "half"):
                    out["alts"] = [dict(bpm=round(dz * 2, 1), conf=0.6)] if r == "double" and dz * 2 <= 220 else []
                    out["flag"] = f"preview hears it {r}-time"
                else:
                    out.update(src="check", flag=f"Deezer {dz:.0f} vs preview {pv:.0f}: listen and fix")
            elif dz:
                out.update(bpm=dz, flag="Deezer only (no preview check)")
            elif pv:
                out.update(bpm=pv, src="deezer-preview", flag="measured from 30 s preview only")
            else:
                out = dict(bpm=None, why="Deezer has this version but no BPM, and the preview couldn't be measured")
    except urllib.error.HTTPError as e:
        return dict(bpm=None, why=f"Deezer HTTP {e.code}")          # not cached: try again next run
    except Exception as e:
        return dict(bpm=None, why=f"Deezer error: {e}")
    cache[ck] = out
    return out


# ------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("playlist", help="playlist URL or ID (LM = your Liked Music, needs --auth)")
    ap.add_argument("--out", default="yt_library.json")
    ap.add_argument("--auth", help="ytmusicapi auth file (browser.json) for private playlists")
    ap.add_argument("--bpm-key", default=os.environ.get("GETSONGBPM_KEY"), help="GetSongBPM API key")
    ap.add_argument("--no-embed-check", action="store_true", help="skip checking that each video can play embedded")
    ap.add_argument("--no-deezer", action="store_true", help="don't look songs up on Deezer")
    ap.add_argument("--no-preview", action="store_true", help="don't measure Deezer's 30 s previews with librosa")
    ap.add_argument("--recheck", action="store_true", help="ignore cached Deezer/GetSongBPM results")
    args = ap.parse_args()

    try:
        from ytmusicapi import YTMusic
    except ImportError:
        sys.exit("Install ytmusicapi first:  pip3 install ytmusicapi")
    yt = YTMusic(args.auth) if args.auth else YTMusic()
    pid = playlist_id(args.playlist)
    try:
        pl = yt.get_playlist(pid, limit=None)
    except Exception as e:
        sys.exit(f"Could not read playlist {pid}: {e}\n"
                 "If it's private (or Liked Music), sign in with `ytmusicapi browser` and pass --auth browser.json.")
    tracks = [t for t in pl.get("tracks", []) if t.get("videoId")]
    print(f"Playlist “{pl.get('title', pid)}”: {len(tracks)} tracks")
    if not args.no_deezer and not args.no_preview:
        try:
            import librosa  # noqa: F401
        except ImportError:
            print("librosa isn't installed, so Deezer BPMs won't be double-checked against the previews "
                  "(pip3 install librosa).")

    use_dz = not args.no_deezer and deezer_available()
    if not args.no_deezer and not use_dz:
        print("Deezer returns no search results from your network (it doesn't operate in India), so BPMs will be "
              "measured from Apple's 30 s iTunes previews of the same version instead.")
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

        entry = dict(file=f"yt:{play_id}", yt=play_id, yt_orig=vid, title=title, artist=artist, dur=dur,
                     bpm=None, src=None, alts=[], energy=0.5, bars=None, wave=None, first_bar=None)
        ov = overrides.get(vid, overrides.get(play_id))
        loc = local.get((norm(title), first_artist(artist)))
        if ov is not None:
            ov = ov if isinstance(ov, dict) else {"bpm": ov}
            entry.update(bpm=float(ov["bpm"]), src="edited")
            if "energy" in ov:
                entry["energy"] = float(ov["energy"])
        elif loc:
            entry.update(bpm=loc["bpm"], src=loc.get("src") or "detected", alts=loc.get("alts") or [])
        rep = dict(video=play_id, title=title, artist=artist, length=round(dur), bpm="", source="", flag="",
                   matched="", deezer_bpm="", preview_bpm="")
        if ov is not None:
            rep.update(source="yt_overrides.json")
        elif loc:
            rep.update(source="your local file", matched=f"{loc.get('title')} — {loc.get('artist')}")
        dzr = None
        if ov is None and not loc:
            is_video = "OMV" in str(t.get("videoType") or "") or "UGC" in str(t.get("videoType") or "")
            dzr = deezer_bpm(play_id, title, artist, dur, is_video, bpmcache, not args.no_preview) if use_dz else dict(bpm=None)
            if not dzr.get("bpm"):
                itr = itunes_bpm(play_id, title, artist, dur, is_video, bpmcache, not args.no_preview)
                if itr.get("bpm") or not use_dz:
                    dzr = dict(itr, why=itr.get("why") or dzr.get("why"))
            if dzr.get("bpm") and args.bpm_key and not dzr.get("dz_bpm"):
                # second opinion from GetSongBPM's database for preview-only measurements
                g = getsongbpm(title, artist, args.bpm_key, bpmcache)
                if g:
                    r = related(dzr["bpm"], g["bpm"]) or related(g["bpm"], dzr["bpm"])
                    if r:
                        dzr = dict(dzr, src="itunes-preview" if dzr["src"] == "check" and "estimators" in dzr["flag"] else dzr["src"],
                                   flag=dzr["flag"] + f"; GetSongBPM agrees ({g['bpm']:.0f})")
                    else:
                        dzr = dict(dzr, src="check", flag=f"preview {dzr['bpm']:.0f} vs GetSongBPM {g['bpm']:.0f} "
                                   f"({dzr.get('ests', '')}): listen and fix")
            if dzr.get("bpm"):
                entry.update(bpm=dzr["bpm"], src=dzr["src"], alts=dzr.get("alts") or [])
                rep.update(source="Deezer" if dzr["src"] in ("deezer", "deezer-preview") or dzr.get("dz_bpm") else "iTunes preview", flag=dzr.get("flag", ""), matched=dzr.get("match", ""),
                           deezer_bpm=dzr.get("dz_bpm") or "", preview_bpm=dzr.get("pv_bpm") or "")
            print(f"    {'%.0f BPM' % dzr['bpm'] if dzr.get('bpm') else 'no BPM'} · {dzr.get('flag') or dzr.get('why', '')}")
        if entry["bpm"] is None and ov is None and not loc and args.bpm_key:
            g = getsongbpm(title, artist, args.bpm_key, bpmcache)
            if g:
                vt = version_tags(title)
                entry.update(bpm=g["bpm"], src="check" if vt else "getsongbpm")
                rep.update(source="GetSongBPM", flag=f"GetSongBPM matched the title only, may be the original not the {'/'.join(sorted(vt))}" if vt else "")
                if g.get("dance") is not None:
                    entry["energy"] = round(min(1, max(0, g["dance"] / 100)), 2)
        if loc and not (ov and "energy" in ov):
            e = loc.get("energy_edit") if loc.get("energy_edit") is not None else loc.get("energy")
            if e is not None:
                entry["energy"] = e
            # Beat/section data only lines up when it's the same recording (same length, no video intro)
            if loc.get("bars") and dur and abs(float(loc.get("dur") or 0) - dur) <= 2:
                entry.update(bars=loc["bars"], wave=loc.get("wave"), first_bar=loc["bars"][0][0])
        rep["bpm"] = entry["bpm"] or ""
        if entry["bpm"] is None:
            rep["flag"] = (dzr or {}).get("why", "no BPM found")
            missing.append((play_id, title, artist))
        else:
            songs.append(entry)
        report.append(rep)
        BPM_CACHE.write_text(json.dumps(bpmcache, indent=1))      # save as we go: a long run can be resumed

    BPM_CACHE.write_text(json.dumps(bpmcache, indent=1))
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
    chk = [r for r in report if r["bpm"] and ("listen" in r["flag"] or "may be" in r["flag"])]
    print(f"Details for every song: {rpath}")
    if chk:
        print(f"\n{len(chk)} to listen to (marked 'check' in the app's song list):")
        for r in chk:
            print(f"  - {r['video']}  {r['title']} — {r['artist']}: {r['flag']}")
    print(f"{sum(1 for s in songs if s['bars'])} have beat/section data from your local analysis "
          "(smarter swap points); the rest swap at the min-play time or ~3/4 through when rotating.")
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
