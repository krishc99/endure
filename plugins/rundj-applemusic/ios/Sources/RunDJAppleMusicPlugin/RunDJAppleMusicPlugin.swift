import Foundation
import Capacitor
import MediaPlayer
import StoreKit
import CoreLocation
import AVFoundation

/// P3.0 spike. Plays one Apple Music song by its store ID through the system music player (no MusicKit, no paid developer
/// account), seeks in it, reports state, and can keep the app alive with the screen locked in two ways (location or a
/// silent audio loop) so we can see which one keeps the pace readings going. Nothing here stores or sends location.
@objc(RunDJAppleMusicPlugin)
public class RunDJAppleMusicPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "RunDJAppleMusicPlugin"
    public let jsName = "RunDJAppleMusic"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "findStoreId", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "state", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepAlive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise)
    ]

    // keep-alive bookkeeping
    private var mode = "off"
    private var beats = 0
    private var beatTimer: Timer?
    private var locationManager: CLLocationManager?
    private var locFixes = 0
    private var locAuth = "n/a"
    private var locError = ""
    private var silentPlayer: AVAudioPlayer?
    private var audioError = ""

    public override func load() {
        DispatchQueue.main.async {
            let player = MPMusicPlayerController.systemMusicPlayer
            player.beginGeneratingPlaybackNotifications()
            let nc = NotificationCenter.default
            nc.addObserver(self, selector: #selector(self.playerChanged), name: .MPMusicPlayerControllerPlaybackStateDidChange, object: player)
            nc.addObserver(self, selector: #selector(self.playerChanged), name: .MPMusicPlayerControllerNowPlayingItemDidChange, object: player)
            // a one-second heartbeat in native code: if JS stops but this keeps counting, the app is alive and only the web view slept
            self.beatTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.beats += 1 }
        }
    }

    @objc private func playerChanged() {
        notifyListeners("state", data: stateDict())
    }

    // MARK: - state

    private func stateName(_ s: MPMusicPlaybackState) -> String {
        switch s {
        case .stopped: return "stopped"
        case .playing: return "playing"
        case .paused: return "paused"
        case .interrupted: return "interrupted"
        case .seekingForward: return "seekingForward"
        case .seekingBackward: return "seekingBackward"
        @unknown default: return "unknown"
        }
    }

    private func stateDict() -> [String: Any] {
        let p = MPMusicPlayerController.systemMusicPlayer
        let item = p.nowPlayingItem
        return [
            "playback": stateName(p.playbackState),
            "time": p.currentPlaybackTime,
            "nowPlayingId": item?.playbackStoreID ?? "",
            "title": item?.title ?? "",
            "artist": item?.artist ?? "",
            "duration": item?.playbackDuration ?? 0
        ]
    }

    private func mediaStatusName(_ s: MPMediaLibraryAuthorizationStatus) -> String {
        switch s {
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .authorized: return "authorized"
        @unknown default: return "unknown"
        }
    }

    // MARK: - Apple Music

    /// Asks for media-library access, then reports whether this Apple ID can play catalog songs (needs an Apple Music subscription).
    @objc func authorize(_ call: CAPPluginCall) {
        MPMediaLibrary.requestAuthorization { status in
            SKCloudServiceController.requestAuthorization { _ in
                SKCloudServiceController().requestCapabilities { caps, err in
                    call.resolve([
                        "media": self.mediaStatusName(status),
                        "catalogPlayback": caps.contains(.musicCatalogPlayback),
                        "subscriptionEligible": caps.contains(.musicCatalogSubscriptionEligible),
                        "capabilitiesError": err?.localizedDescription ?? ""
                    ])
                }
            }
        }
    }

    /// iTunes Search for a song name, to get the store ID the system player needs.
    @objc func findStoreId(_ call: CAPPluginCall) {
        guard let term = call.getString("term"), !term.isEmpty else { call.reject("term is required"); return }
        var comps = URLComponents(string: "https://itunes.apple.com/search")!
        comps.queryItems = [
            URLQueryItem(name: "term", value: term),
            URLQueryItem(name: "media", value: "music"),
            URLQueryItem(name: "entity", value: "song"),
            URLQueryItem(name: "limit", value: "1"),
            URLQueryItem(name: "country", value: call.getString("country") ?? "IN")
        ]
        URLSession.shared.dataTask(with: comps.url!) { data, _, err in
            guard err == nil, let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let results = obj["results"] as? [[String: Any]],
                  let r = results.first else {
                call.reject("No iTunes result for \"\(term)\"" + (err.map { ": \($0.localizedDescription)" } ?? ""))
                return
            }
            call.resolve([
                "storeId": (r["trackId"] as? NSNumber)?.stringValue ?? "",
                "title": r["trackName"] as? String ?? "",
                "artist": r["artistName"] as? String ?? "",
                "durationSec": ((r["trackTimeMillis"] as? NSNumber)?.doubleValue ?? 0) / 1000
            ])
        }.resume()
    }

    @objc func play(_ call: CAPPluginCall) {
        guard let id = call.getString("storeId"), !id.isEmpty else { call.reject("storeId is required"); return }
        DispatchQueue.main.async {
            let p = MPMusicPlayerController.systemMusicPlayer
            p.setQueue(with: [id])
            p.prepareToPlay { err in
                DispatchQueue.main.async {
                    if let err = err {
                        let ns = err as NSError
                        call.reject("prepareToPlay failed: \(ns.localizedDescription) [\(ns.domain) \(ns.code)]")
                        return
                    }
                    p.play()
                    call.resolve(self.stateDict())
                }
            }
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        let sec = call.getDouble("sec") ?? 0
        DispatchQueue.main.async {
            MPMusicPlayerController.systemMusicPlayer.currentPlaybackTime = sec
            call.resolve(self.stateDict())
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async { MPMusicPlayerController.systemMusicPlayer.pause(); call.resolve(self.stateDict()) }
    }

    @objc func resume(_ call: CAPPluginCall) {
        DispatchQueue.main.async { MPMusicPlayerController.systemMusicPlayer.play(); call.resolve(self.stateDict()) }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { MPMusicPlayerController.systemMusicPlayer.stop(); call.resolve(self.stateDict()) }
    }

    @objc func state(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(self.stateDict()) }
    }

    // MARK: - keep the app alive with the screen locked (spike: try both)

    /// mode: "off", "location" or "audio". Info.plist must list the matching UIBackgroundModes (the iPhone workflow adds both).
    @objc func keepAlive(_ call: CAPPluginCall) {
        let wanted = call.getString("mode") ?? "off"
        DispatchQueue.main.async {
            self.stopKeepAlive()
            self.mode = wanted
            switch wanted {
            case "location": self.startLocation()
            case "audio": self.startAudio()
            default: break
            }
            call.resolve(self.statusDict())
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(self.statusDict()) }
    }

    private func statusDict() -> [String: Any] {
        return [
            "mode": mode,
            "nativeBeats": beats,
            "locationFixes": locFixes,
            "locationAuth": locAuth,
            "locationError": locError,
            "audioPlaying": silentPlayer?.isPlaying ?? false,
            "audioError": audioError,
            "backgroundModes": (Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String]) ?? []
        ]
    }

    private func hasBackgroundMode(_ name: String) -> Bool {
        return ((Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String]) ?? []).contains(name)
    }

    private func stopKeepAlive() {
        locationManager?.stopUpdatingLocation()
        locationManager?.delegate = nil
        locationManager = nil
        silentPlayer?.stop()
        silentPlayer = nil
        locFixes = 0
        locError = ""
        audioError = ""
        mode = "off"
    }

    private func startLocation() {
        guard hasBackgroundMode("location") else { locError = "UIBackgroundModes has no 'location'"; return }
        let m = CLLocationManager()
        m.delegate = self
        m.desiredAccuracy = kCLLocationAccuracyThreeKilometers      // we only want the app kept alive, not a precise position
        m.distanceFilter = kCLDistanceFilterNone
        m.pausesLocationUpdatesAutomatically = false
        m.allowsBackgroundLocationUpdates = true
        m.showsBackgroundLocationIndicator = true
        m.requestWhenInUseAuthorization()
        m.startUpdatingLocation()
        locationManager = m
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        locFixes += 1                                               // counted only; the coordinates are never read or stored
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        locError = error.localizedDescription
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .notDetermined: locAuth = "notDetermined"
        case .restricted: locAuth = "restricted"
        case .denied: locAuth = "denied"
        case .authorizedAlways: locAuth = "always"
        case .authorizedWhenInUse: locAuth = "whenInUse"
        @unknown default: locAuth = "unknown"
        }
    }

    private func startAudio() {
        guard hasBackgroundMode("audio") else { audioError = "UIBackgroundModes has no 'audio'"; return }
        do {
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playback, mode: .default, options: [.mixWithOthers])    // mix, so Apple Music keeps playing
            try s.setActive(true)
            let p = try AVAudioPlayer(data: RunDJAppleMusicPlugin.silentWav(seconds: 1))
            p.numberOfLoops = -1
            p.volume = 1
            p.prepareToPlay()
            p.play()
            silentPlayer = p
        } catch {
            audioError = error.localizedDescription
        }
    }

    /// One second of 16-bit mono silence as a WAV file in memory.
    static func silentWav(seconds: Int) -> Data {
        let rate = 8000
        let samples = rate * seconds
        var d = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        d.append("RIFF".data(using: .ascii)!)
        u32(UInt32(36 + samples * 2))
        d.append("WAVE".data(using: .ascii)!)
        d.append("fmt ".data(using: .ascii)!)
        u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16)
        d.append("data".data(using: .ascii)!)
        u32(UInt32(samples * 2))
        d.append(Data(count: samples * 2))
        return d
    }
}
