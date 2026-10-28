# Run DJ (phone test app)

Plays your songs to match your running cadence. Same engine and UI as the desktop test page, plus
**Health Connect** step input and a **Manual** slider.

## 1. Prepare your songs (on the Mac)
```
pip3 install mutagen librosa essentia        # essentia is optional but gives sharper tempo
python3 tools/dj_live.py "/Users/krish/Music/Songs" --export library.json
```
Copy `library.json` **and the audio files** to the phone (USB, Drive, AirDrop-alternative, `adb push`, anything).

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
- Debugging: with USB debugging on, open `chrome://inspect` in Chrome on the Mac to see the app's console.
- Changing the engine: edit `tools/dj_live.py`, then `npm run build`. `www/index.html` is generated from it.
