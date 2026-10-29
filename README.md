# Run DJ (phone test app)

Plays your songs to match your running cadence. Same engine and UI as the desktop test page, plus
**Health Connect** step input and a **Manual** slider. Songs can be local files, a **YouTube Music playlist**, or both.

BPM data from [Deezer](https://www.deezer.com/) and [GetSongBPM](https://getsongbpm.com/).

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
- BPM comes from, in order: `tools/yt_overrides.json` (your corrections); the same song in your local library (`dj_live.py`'s
  cache, including beat/section data when it's the same recording); **Deezer** (free, no key), which finds the *same version*
  (title, artist, remix/acoustic/live tags and length must agree, so covers and remixes get their own tempo), reads Deezer's BPM
  and double-checks it by measuring Deezer's 30-second preview with librosa; where Deezer doesn't operate (India), Apple's
  iTunes Search API instead (free, no key): same version-matching, BPM measured from its 30-second preview; then GetSongBPM
  if you pass `--bpm-key`. iTunes allows ~20 lookups a minute, so a first run of a big playlist takes several minutes.
  Install `essentia` (`pip3 install essentia`) for much better tempo on ballads and swing; each preview is measured by up
  to four estimators and songs where they disagree (including triplet 2/3 – 3/2 confusions) are marked **check**.
- Fix any song by ear on the phone: while it plays, tap **Tap the beat** 8+ times and **Save**.
- `bpm_report.csv` lists every song's source, the version it matched and both measurements. Songs where they disagree are
  marked **check** in the report and in the app's song list: listen, then fix with ½ / ×2 or add `{"videoId": 165}` to
  `tools/yt_overrides.json` and rerun. Songs with no BPM at all are listed at the end of the run.
- Songs whose owner turned off embedding are swapped for another upload of the same song when one exists, otherwise listed and left out.
- Private playlists or Liked Music (`LM`): run `ytmusicapi browser` once, then add `--auth browser.json`. Keep that file private.
- Changed the playlist? Rerun and import the new file; it replaces that playlist's songs and keeps your ½ / ×2 / energy edits.

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
