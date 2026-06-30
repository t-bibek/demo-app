import Foundation
import SpeakerCore

/// Engine tuning, mirroring the original's adjustable parameters:
/// poll interval 500 ms, remote audio threshold 0.02, mic threshold 0.04.
struct EngineConfig {
    var pollIntervalMs: Int = 500
    var remoteThreshold: Float = 0.02
    var micThreshold: Float = 0.04
    var localUserName: String = "You"
}

/// Drives the whole detection pipeline. Every poll it merges two independent
/// signals — audio meters (IS someone speaking) and the accessibility scan
/// (WHO is speaking) — into `SessionTracker` pulses, exactly like the original
/// hybrid WASAPI + UI Automation engine.
final class DetectionEngine {
    private let config: EngineConfig
    private let onEvent: (AppEvent) -> Void

    private let queue = DispatchQueue(label: "msd.engine")
    private var timer: DispatchSourceTimer?

    private let mic = MicMeter()
    private let scanner = AccessibilityScanner()
    private var systemMeter: AnyObject?   // SystemAudioMeter (macOS 13+)
    private let logger: NdjsonSessionLogger?

    private var tracker: SessionTracker!
    private var lastStatusKey = ""

    // Meet fused-resolver state: last tick's tile areas (geometry history) and
    // telemetry counters (a class rotation shows up as floors with no class hits).
    private var meetPrevAreas: [String: Double] = [:]
    private var meetNamed = 0        // ticks a remote/active tile was named via AX (geometry/class)
    private var meetSomeone = 0      // ticks attributed to anonymous "Someone" (speech, no AX attribution)
    private var meetClassFired = 0   // ticks the strict kssMZb class matched (rotation monitor)

    // Teams fused-resolver state (mirrors Meet): last tile areas + telemetry.
    private var teamsPrevAreas: [String: Double] = [:]
    private var teamsStructural = 0  // ticks named via the AX is-speaking token (Recall-style)
    private var teamsNamed = 0       // ticks named via audio-direction fallback
    private var teamsSomeone = 0     // ticks attributed to anonymous "Someone"

    /// Where completed-session NDJSON is written.
    let logURL: URL

    init(config: EngineConfig = EngineConfig(), onEvent: @escaping (AppEvent) -> Void) {
        self.config = config
        self.onEvent = onEvent

        let logsDir = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("MeetSpeakerDetector", isDirectory: true)
        self.logURL = logsDir.appendingPathComponent("sessions.ndjson")
        self.logger = NdjsonSessionLogger(url: logURL)

        self.tracker = SessionTracker(opts: TrackerOptions(endSilenceMs: 2000, pulseWidthMs: 500)) { [weak self] event in
            self?.handleTrackerEvent(event)
        }
    }

    // MARK: Lifecycle

    func start() {
        mic.start()
        if #available(macOS 13.0, *) {
            let meter = SystemAudioMeter()
            systemMeter = meter
            Task { await meter.start() }
        }
        status(.info, "Detection started — polling every \(config.pollIntervalMs) ms.")

        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + .milliseconds(config.pollIntervalMs),
                   repeating: .milliseconds(config.pollIntervalMs),
                   leeway: .milliseconds(50))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    func stop() {
        timer?.cancel()
        timer = nil
        queue.async { [weak self] in self?.tracker.endAll() }
        mic.stop()
        if #available(macOS 13.0, *) {
            (systemMeter as? SystemAudioMeter)?.stop()
        }
        systemMeter = nil

        // Meet attribution telemetry. `class fired` monitors the strict kssMZb
        // match so a rotation shows up as named/someone accruing while class-fired
        // drops to 0. (kssMZb measured ~83% prec / 89% recall for remotes, ~14%
        // recall for self vs Recall's VAD truth — corroboration, not the source.)
        if meetNamed + meetSomeone + meetClassFired > 0 {
            status(.info, "Meet attribution — named: \(meetNamed), someone: \(meetSomeone); kssMZb fired \(meetClassFired)×.")
        }
        // Teams attribution. `structural` = the AX is-speaking token named a tile
        // (Recall-style); if it stays 0 while `named`/`someone` accrue, the token
        // needs re-deriving (a Teams probe run) — see TeamsSpeakerRules.
        if teamsStructural + teamsNamed + teamsSomeone > 0 {
            status(.info, "Teams attribution — structural: \(teamsStructural), audio-named: \(teamsNamed), someone: \(teamsSomeone).")
        }
        status(.info, "Detection stopped.")
    }

    // MARK: Poll

    private func tick() {
        let now = nowMs()
        let micPeak = mic.currentPeak
        var systemPeak: Float = 0
        if #available(macOS 13.0, *) {
            systemPeak = (systemMeter as? SystemAudioMeter)?.currentPeak ?? 0
        }

        let micActive = micPeak > config.micThreshold
        let remoteActive = systemPeak > config.remoteThreshold

        // The VAD gate is SOFT: only trustworthy when system-audio capture is
        // actually running. Without Screen Recording permission systemPeak is
        // always 0, so gating Meet on it would drop every remote speaker — so when
        // audio isn't reliable we don't gate (Meet falls back to class-only).
        var audioReliable = false
        if #available(macOS 13.0, *) {
            audioReliable = (systemMeter as? SystemAudioMeter)?.running ?? false
        }

        let scanned = scanner.scan()

        if scanned.isEmpty {
            // No meeting visible — just age out any open sessions.
            tracker.update(now)
            emitWindows([], systemPeak: systemPeak, ts: now)
            maybeStatusForPermissions()
            return
        }

        var windowInfos: [EngineWindowInfo] = []
        for w in scanned {
            // WHO is speaking — resolved per platform from the right signal.
            var who = Set(w.speakers)

            if w.platform == .meet {
                // Remote/active naming comes ONLY from the AX tree now (structural →
                // geometry → strict kssMZb), VAD-gated. Corrected understanding:
                // kssMZb IS a real per-tile active-speaker class — the self-CLUSTER
                // that confounded it with hover/self-view was removed. Audio
                // direction is NO LONGER used to name remotes; the mic only names the
                // LOCAL user, whose own tile never carries the speaking ring.
                if w.meetTiles.contains(where: { $0.classSpeaking }) { meetClassFired += 1 }

                // Soft VAD gate (trustworthy only when system-audio capture runs).
                let vad = audioReliable ? (micActive || remoteActive) : true
                let r = meetActiveSpeaker(tiles: w.meetTiles, prevAreas: meetPrevAreas,
                                          vadSpeechActive: vad, presentationActive: w.presentationActive)
                if r.via != .none && r.via != .someoneFloor {
                    who.formUnion(r.names)            // structural / geometry / class
                    meetNamed += 1
                }

                // SELF via mic only — name the local user when the mic is active and
                // you're unmuted (your tile gets no speaking ring to read).
                if audioReliable && micActive && (w.localUserUnmuted ?? false) {
                    let me = w.meetTiles.first(where: { $0.isMe })
                    who.insert(me?.name ?? config.localUserName)
                }

                // Confirmed speech but AX attributed nobody and self wasn't added →
                // anonymous floor. Only when audio confirms speech (no Someone spam
                // when we can't even tell anyone is talking).
                if r.via == .someoneFloor && who.isEmpty && audioReliable {
                    who.insert("Someone")
                    meetSomeone += 1
                }
                meetPrevAreas = Dictionary(w.meetTiles.map { ($0.name, $0.area) }, uniquingKeysWith: { a, _ in a })
            } else if w.platform == .teams {
                // Teams (new client) exposes NO AX is-speaking signal — proven live
                // (state/geometry/announcements all empty) and in Recall's binary
                // (its " is active speaker" check is inert; it uses VAD). So attribute
                // by AUDIO DIRECTION + MUTE, exactly like native Zoom: mic = you,
                // system audio = a remote, gated by per-participant mute. Remote mute
                // comes from the People-panel ROSTER (the only reliable source —
                // requires the panel open); local mute from the self tile/roster.
                // `teamsActiveSpeaker` stays as a config-driven hook (speakingClasses
                // is empty today) but never fires, so this is the live path.
                // See docs/teams-active-speaker-detection.md §7.
                let vad = audioReliable ? (micActive || remoteActive) : true
                let r = teamsActiveSpeaker(tiles: w.teamsTiles, prevAreas: teamsPrevAreas, vadSpeechActive: vad)
                if r.via == .structural {
                    who.formUnion(r.names)            // only if a config'd class ever matches
                    teamsStructural += 1
                } else if audioReliable {
                    // Prefer the People-panel ROSTER for mute (reliable per-remote,
                    // panel-open); fall back to per-tile mute when the panel is closed.
                    let roster = w.teamsRoster
                    let meRoster = roster.first(where: { $0.isMe })
                    let meTile = w.teamsTiles.first(where: { $0.isMe })
                    let localUnmuted = meRoster?.unmuted ?? meTile?.unmuted ?? (w.localUserUnmuted ?? false)
                    let localName = meRoster?.name ?? meTile?.name ?? config.localUserName
                    let remotes = roster.isEmpty
                        ? w.teamsTiles.filter { !$0.isMe && ($0.unmuted ?? true) }.map { $0.name }
                        : roster.filter { !$0.isMe && $0.unmuted }.map { $0.name }
                    let names = zoomMuteGateSpeakers(
                        micActive: micActive, localUnmuted: localUnmuted, localName: localName,
                        remoteActive: remoteActive, remoteUnmutedNames: remotes)
                    who.formUnion(names)
                    if names.contains("Someone") { teamsSomeone += 1 } else if !names.isEmpty { teamsNamed += 1 }
                }
                // else: no audio capture and no class → emit nothing (don't spam
                // "Someone" when we can't even confirm there's speech).
                teamsPrevAreas = Dictionary(w.teamsTiles.map { ($0.name, $0.area) }, uniquingKeysWith: { a, _ in a })
            } else if w.directSpeakerRead {
                // Meet (kssMZb class) / Zoom web ("active speaker" marker): the UI
                // names the speaker, including your own tile. Trust it; only fall
                // back to the anonymous "Someone" when the tree itself is
                // unreadable (e.g. a backgrounded tab). No "You" — your tile is
                // already named, so adding it would double-log.
                if remoteActive && who.isEmpty && !w.treeOk {
                    who.insert("Someone")
                }
            } else if !w.zoomRoster.isEmpty {
                // B1 — native Zoom has NO AX speaking signal, so mute-gate: fuse
                // audio direction with the roster's per-participant mute. The
                // local mic = your voice; the system tap = remote voices, so a
                // 1:1 where both stay unmuted still resolves. (See SpeakerCore
                // zoomMuteGateSpeakers + docs/zoom-native-detection.md.)
                let me = w.zoomRoster.first(where: { $0.isMe })
                let localUnmuted = me?.unmuted ?? (w.localUserUnmuted ?? false)
                let localName = me?.name ?? config.localUserName
                let remoteUnmuted = w.zoomRoster.filter { !$0.isMe && $0.unmuted }.map { $0.name }
                for name in zoomMuteGateSpeakers(
                    micActive: micActive, localUnmuted: localUnmuted, localName: localName,
                    remoteActive: remoteActive, remoteUnmutedNames: remoteUnmuted
                ) {
                    who.insert(name)
                }
            } else {
                // B2 — Teams, or native Zoom with the panel closed / unreadable:
                // audio-only. Without this branch native Zoom logged NOTHING
                // (it was wrongly treated as a direct-read platform).
                if remoteActive && who.isEmpty {
                    who.insert("Someone")
                }
                // YOU: only when the mic is active AND the UI positively confirms
                // you're unmuted (Zoom's app-mute doesn't silence the macOS mic,
                // so echo/room noise must not log a muted user).
                if micActive && w.localUserUnmuted == true {
                    who.insert(config.localUserName)
                }
            }

            for name in who {
                tracker.pulse(w.platform, name, now)
            }

            windowInfos.append(EngineWindowInfo(
                platform: w.platform,
                title: w.title,
                nodeCount: w.nodeCount,
                treeOk: w.treeOk,
                audioPeak: Double(systemPeak)
            ))
        }

        tracker.update(now)
        emitWindows(windowInfos, systemPeak: systemPeak, ts: now)
    }

    // MARK: Emit

    private func handleTrackerEvent(_ event: TrackerEvent) {
        if case let .end(platform, name, startTs, endTs, durationMs) = event {
            logger?.logEnd(platform: platform, name: name, startTs: startTs, endTs: endTs, durationMs: durationMs)
        }
        onEvent(.tracker(event))
    }

    private func emitWindows(_ windows: [EngineWindowInfo], systemPeak: Float, ts: Int) {
        onEvent(.windows(EngineWindows(windows: windows, ts: ts)))
    }

    private func status(_ level: StatusLevel, _ message: String) {
        onEvent(.status(EngineStatus(level: level, message: message, ts: nowMs())))
    }

    /// Surface a single, de-duplicated diagnostic when nothing is detected and
    /// a likely cause is a missing permission.
    private func maybeStatusForPermissions() {
        var key = "ok"
        var level: StatusLevel = .info
        var message = "No meeting window detected. Open Google Meet, Zoom, or Teams."

        if !AccessibilityScanner.isTrusted {
            key = "ax"; level = .warn
            message = "Accessibility permission not granted — speaker names can't be read. Grant it in System Settings ▸ Privacy & Security ▸ Accessibility."
        } else if !MicMeter.isAuthorized {
            key = "mic"; level = .warn
            message = "Microphone permission not granted — your own speech won't be logged."
        }

        if key != lastStatusKey {
            lastStatusKey = key
            status(level, message)
        }
    }
}
