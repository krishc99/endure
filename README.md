# Run DJ (phone test app)

Plays your songs to match your running cadence. Same engine and UI as the desktop test page, plus
**Health Connect** step input and a **Manual** slider. Songs can be local files, a **YouTube Music playlist**, or both.

BPM data from Apple iTunes previews and [GetSongBPM](https://getsongbpm.com/). Synced lyrics from [LRCLIB](https://lrclib.net/).

## 1. Prepare your songs (on the Mac)
```
pip3 install mutagen librosa essentia        # essentia is optional but gives sharper tempo
python3 tools/dj_live.py "/Users/krish/Music/Songs" --export library.json
```
Copy `library.json` **and the audio files** to the phone (USB, Drive, AirDrop-alternative, `adb push`, anything).

### 1b. YouTube Music playlist (optional)
Pick the songs in a YouTube Music playlist; Run DJ plays them in an embedded YouTube player, in the order its engine picks.
```
pip3 install ytmusicapi librosa
python3 tools/yt_library.py "https://music.youtube.com/playlist?list=PL..." --out yt_library.json
```
- BPM is decided by **voting** (see *BPM voting* below). Votes come from, in priority order: `tools/yt_overrides.json` (your
  corrections); the same song in your local library (`dj_live.py`'s cache, including beat/section data when it's the same
  recording); Apple's **iTunes Search API** (free, no key), which finds the *same version* (title, artist,
  remix/acoustic/live tags and length must agree, so covers and remixes get their own tempo) and measures its 30-second
  preview with librosa; **AcousticBrainz** (best effort, see below); then GetSongBPM if you pass `--bpm-key`. iTunes allows
  ~20 lookups a minute, so a first run of a big playlist takes several minutes.
  Install `essentia` (`pip3 install essentia`) for much better tempo on ballads and swing; each preview is measured by up
  to four estimators and songs where they disagree (including triplet 2/3 – 3/2 confusions) are marked **check**.
- Song sections come from **LRCLIB's timed lyrics** (YouTube Music's own timed lyrics are an extra in debug builds): repeated lines mark the choruses. Songs with no matching lyrics enter about a quarter in and swap ~3/4 through. A song plays to the end of
  its last chorus before rotating at a steady cadence, and the next one comes in at its first chorus. Music videos are
  switched to their audio version (no intro or skits; `--keep-videos` to turn that off). Energy is ranked from each
  preview's loudness, onset rate and brightness within the playlist, like the local analysis.
- **Hold a song while it still fits** (Settings, on by default): at a steady cadence the song isn't swapped for a
  slightly better match; it only changes after its last chorus, or sooner if your cadence moves out of its range.
- Fix any song by ear on the phone: while it plays, tap **Tap the beat** 8+ times and **Save**.
- `bpm_report.csv` lists every song's winning source, the version it matched, every vote (`votes` column), whether it feels
  half/normal/double-time and a `check` column. Songs where sources disagree are
  marked **check** in the report and in the app's song list: listen, then fix with ½ / ×2 or add `{"videoId": 165}` to
  `tools/yt_overrides.json` and rerun. Songs with no BPM at all are listed at the end of the run.
- Songs whose owner turned off embedding are swapped for another upload of the same song when one exists, otherwise listed and left out.
- Private playlists or Liked Music (`LM`): run `ytmusicapi browser` once, then add `--auth browser.json`. Keep that file private.
- Changed the playlist? Rerun and import the new file; it replaces that playlist's songs and keeps your ½ / ×2 / energy edits.

### 1c. Or add playlists right in the app (no Mac needed)
Paste a **Spotify** playlist link into *Library → Add* (**YouTube Music** and **Apple Music** playlist links work in debug builds only, see *devSources* below). The phone does the whole analysis
itself, and the first songs start playing within about a minute while the rest are analysed:
- each song is matched to its YouTube Music audio version (that's what plays); BPM is measured from Apple's 30 s iTunes
  preview of the same version with Essentia; chorus sections come from LRCLIB's timed lyrics; energy is ranked from the
  preview's loudness, onset rate and brightness;
- Apple allows ~20 lookups a minute, so a 100-song playlist takes about 5–6 minutes; songs already in your library are reused;
- add as many playlists as you like: they all live in one library (*Play from* can pick one), and the whole library is saved
  to `RunDJ/rundj_library.json`, in Documents where the phone allows it. Android 11+ usually does **not** let an app write to
  Documents, so the file then stays inside the app's own storage, which is **deleted when you uninstall**. *Save library file*
  therefore also opens the share sheet: save a copy to Files or Drive, and after a reinstall use *Import songs…* and pick that
  file. *Refresh* re-syncs a playlist;
- **Spotify** needs a free client ID and secret (developer.spotify.com → Create app), pasted in Settings. Only public playlists
  made by users can be read; Spotify-made mixes are blocked for new apps. **YouTube Music** import (YouTube's internal youtubei API) and
  **Apple Music** import (the public playlist page) are unofficial, so they sit behind the `devSources` flag (below);
- tempo analysis uses [Essentia.js](https://mtg.github.io/essentia.js/) (AGPL-3.0).

### 1d. Background mode (app closed, screen locked) — Android
*Cadence → Background mode*. A native service keeps reading your pace (phone motion, or the step counter) with the screen
off and has the **YouTube Music app** play the songs (background play there needs YouTube Premium): it opens the chosen
song in YouTube Music, then jumps to the entry point (first chorus when the tempo goes up) with Android's media controls.
Same rules as the app: tempo matching, hold a fitting song until its last chorus, swap at a section boundary when your
pace changes. No repeats: songs not yet played this run come first (then the one played longest ago); when every
song at a steady pace has played, the next one is a little faster (up to +8 BPM, *Settings*) instead of a repeat. One player, so a switch is a short volume dip instead of a crossfade.
Set-up (the *Set up* button walks through it): Physical activity + notifications, **Notification access** for Run DJ (to
control YouTube Music), **Display over other apps** (Android only lets an app start a song in another app from the
background with it), and ideally battery use *Unrestricted*. Experimental: how YouTube Music reacts can vary by version.
Code: `plugins/rundj-background` (a local Capacitor plugin, built into the APK automatically).

### iPhone
GitHub also builds an unsigned iPhone app (*Actions → Build iPhone app (unsigned)* → `run-dj-iphone-ipa`). Install it from
your Mac with [Sideloadly](https://sideloadly.io) and your Apple ID; with a free Apple ID it has to be re-installed every
7 days. On the iPhone: Settings → Privacy & Security → Developer Mode on, and after installing, Settings → General →
VPN & Device Management → trust your Apple ID. Differences from Android: YouTube songs switch with a cut (iOS doesn't let
pages change YouTube's volume), local files still crossfade; no background mode (iPhones don't let one app drive another);
no Health Connect. Phone motion, step counter, Manual and adding playlists by link all work; the library file is in
Files → On My iPhone → Run DJ.

### BPM voting
Each song collects *votes* for its tempo, `{value, source, confidence}`: your own edit (`override`, ½ / ×2 / tap the beat /
`yt_overrides.json`) > your local-file analysis of the same recording (`local`) > the iTunes preview measured with Essentia
(`preview`) > AcousticBrainz > GetSongBPM (optional key, in Settings). The highest-priority vote is the tempo; the others only
decide the flag: **agree**, or **check** when a source disagrees (including a vote that is exactly double or half), when the
winning vote is itself doubtful (estimators disagree, maybe the wrong version), or when it is the only, unchecked source.
The vote logic is `src/bpm.js` (mirrored in `tools/bpm_resolve.py`).

*Feel.* A high-energy song detected slow is probably half-time of the real tempo, and a low-energy song detected fast the
reverse. Energy is only known once the playlist is ranked, so after ranking: energy ≥ 0.7 and BPM < 100 becomes **double**
(`bpmFeel: double`), energy ≤ 0.3 and BPM > 150 becomes **half**. Those four numbers are in *Settings* (changing one
re-decides every song that has votes). If another source backs the change the song stays **agree**; if energy is the only
evidence it is marked **check**. Your own edits are never touched. In the app a **check** song shows each source's vote and
the reason under its title.

*AcousticBrainz.* Looked up through MusicBrainz (artist + title + length, 1 request a second, with a User-Agent that names
this repo). The project stopped accepting submissions in 2022 and its API is frozen but, as far as I could tell, still up, so
many songs have no data and that is normal; after 3 failures in a row it is skipped for the rest of the session. Only the
tempo and danceability are read for now (mood is not).

*Songs analysed before voting* have no votes and keep their tempo until they are analysed again. Tests: `npm test`
(the resolver, the AcousticBrainz/GetSongBPM lookups with a fake network, and the energy re-check) and
`python3 -m unittest tools/test_bpm_resolve.py`.

### devSources: debug vs release
Unofficial sources (YouTube Music's internal youtubei API, `tools/yt_library.py`'s ytmusicapi, Apple Music's public playlist
page, YouTube Music's timed lyrics) are behind a `devSources` flag: **on in debug builds, off in release builds**.
`npm run bundle` / `npm run build` build with it on (this is what the GitHub debug-APK workflow uses);
`npm run bundle:release` / `npm run build:release` build with it off, where YouTube Music and Apple Music links are refused.
For `tools/yt_library.py` set `RUNDJ_DEV_SOURCES=0` to disable it. Removed outright: the YouTube "Most replayed" heatmap and Deezer.
Sections now come from LRCLIB first, then the plain fallback (enters about a quarter in, swaps ~3/4 through).

## 2. Build the app (pick one)
**A. Cloud build, no Android Studio:** push this folder to a GitHub repo → *Actions* → "Build Android debug APK" →
open the run → download `run-dj-debug-apk` → unzip → open `app-debug.apk` on the phone (allow "install unknown apps").

**B. Android Studio:** needs Node 22+, JDK 21, Android Studio. Phone: enable Developer options → USB debugging.
```
npm install
npm run build        # bundles the bridge, regenerates www/index.html, syncs the Android project
npm run open         # opens Android Studio; press Run with the phone connected
```

## 3. On the phone
1. **Import songs…** → select `library.json` and the audio files *together* in the picker. They are copied into the app, so you only do this once.
   For YouTube Music, import `yt_library.json` on its own (no audio files). **Play from** chooses all songs, YouTube only or local only.
2. Pick where your cadence comes from:
   - **Phone motion** (best for running): live from the accelerometer, reads a change in pace within a few seconds. Carry the phone in a pocket, armband or hand.
   - **Step counter**: the phone's hardware step counter (asks for the Physical activity permission).
   - **Manual**: drag the slider.
   - **Health Connect**: steps another app wrote; lags by minutes. Tap *Connect*, then *Test read*.
4. Keep the screen on while running (the app does this itself while playing).

## Important
- Health Connect is a store, not a step counter. Something must write steps into it (Google Fit, Samsung Health, Fitbit, Garmin, …).
  Check Health Connect → App permissions → that app has Steps.
- Those apps sync in batches, so expect the cadence to lag real time by anywhere from seconds to a few minutes.
- YouTube songs need internet while running and stream through the official embedded player, which stays visible in *Now playing*.
  Without YouTube Premium the embedded player can show ads, which interrupt the timing. The app has to stay in front with the screen on (it keeps it on).
  Swaps for YouTube songs without local beat data happen at the min-play time or about 3/4 through, not at a detected chorus.
- Debugging: with USB debugging on, open `chrome://inspect` in Chrome on the Mac to see the app's console.
- Changing the engine: edit `tools/dj_live.py`, then `npm run build`. `www/index.html` is generated from it.
