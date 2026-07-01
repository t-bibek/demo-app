import Foundation
import SpeakerCore

/// Engine tuning, mirroring the original's adjustable parameters:
/// poll interval 500 ms, remote audio threshold 0.02, mic threshold 0.04.
struct EngineConfig {
    var pollIntervalMs: Int = 500
    var remoteThreshold: Float = 0.02
    var micThreshold: Float = 0.04
    var localUserName: String = "You"
    /// Mirror every emitted event (meeting / participant / speech) to stdout as an
    /// NDJSON line, in addition to the log file. Handy while developing; visible
    /// when the app is launched from a terminal (`swift run MeetSpeakerDetector`).
    var logEventsToTerminal: Bool = true
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
    private var meetingTracker: MeetingStateTracker!
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
        self.meetingTracker = MeetingStateTracker(opts: .init(graceMs: 4000)) { [weak self] event in
            self?.handleMeetingEvent(event)
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
        queue.async { [weak self] in
            self?.tracker.endAll()
            self?.meetingTracker.endAll(nowMs())
        }
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
            // No meeting visible — age out any open sessions AND meetings.
            tracker.update(now)
            meetingTracker.observe([], now)
            emitWindows([], systemPeak: systemPeak, ts: now)
            maybeStatusForPermissions()
            return
        }

        var windowInfos: [EngineWindowInfo] = []
        var snapshots: [MeetingSnapshot] = []
        for w in scanned {
            // WHO is speaking — resolved per platform from the right signal. `who`
            // is the speaker set; `sourceOf` records the attribution that FIRST
            // named each speaker (first-writer-wins, so it can never drop a name
            // that `who` holds).
            var who = Set<String>()
            var sourceOf: [String: String] = [:]
            func add(_ name: String, _ src: String) {
                let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !n.isEmpty else { return }
                who.insert(n)
                if sourceOf[n] == nil { sourceOf[n] = src }
            }
            // Web direct-read names (Zoom web "active speaker" marker) already on
            // the window — empty for Meet / Teams / native Zoom.
            for name in w.speakers { add(name, "web.direct") }

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
                // Resolve the local user's REAL name — never the generic "You". Prefer
                // the "(You)"-tagged tile; if that missed but there's a single tile and
                // the mic is live, that lone tile is self. If it can't be resolved yet
                // (e.g. the very first tick, before tiles parse), we DON'T name self
                // this tick rather than logging a throwaway "You" that then splits into
                // two speakers ("You" + the real name).
                let selfTile = w.meetTiles.first(where: { $0.isMe })
                let meetSelfName: String? = selfTile?.name
                    ?? (micActive && (w.localUserUnmuted ?? false) && w.meetTiles.count == 1
                        ? w.meetTiles[0].name : nil)

                if r.via != .none && r.via != .someoneFloor {
                    let src = r.via == .cssClass ? "meet.kssMZb" : "meet.geometry"
                    // Never name the self tile as a remote — self is mic-driven below.
                    for n in r.names where n != meetSelfName { add(n, src) }
                    meetNamed += 1
                }

                // SELF via mic only — name the local user (resolved above) when the mic
                // is active and you're unmuted (your tile gets no speaking ring). Skip
                // when the real name isn't known yet.
                if audioReliable && micActive && (w.localUserUnmuted ?? false),
                   let selfName = meetSelfName {
                    add(selfName, "meet.self_mic")
                }

                // Confirmed speech but AX attributed nobody and self wasn't added →
                // anonymous floor. Only when audio confirms speech (no Someone spam
                // when we can't even tell anyone is talking).
                if r.via == .someoneFloor && who.isEmpty && audioReliable {
                    add("Someone", "meet.someone")
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
                    for n in r.names { add(n, "teams.structural") }   // only if a config'd class ever matches
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
                    for n in names { add(n, n == "Someone" ? "teams.someone" : "teams.mute_gate") }
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
                    add("Someone", "web.direct")
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
                    add(name, name == "Someone" ? "audio.someone" : "zoom.mute_gate")
                }
            } else {
                // B2 — Teams, or native Zoom with the panel closed / unreadable:
                // audio-only. Without this branch native Zoom logged NOTHING
                // (it was wrongly treated as a direct-read platform).
                if remoteActive && who.isEmpty {
                    add("Someone", "audio.someone")
                }
                // YOU: only when the mic is active AND the UI positively confirms
                // you're unmuted (Zoom's app-mute doesn't silence the macOS mic,
                // so echo/room noise must not log a muted user).
                if micActive && w.localUserUnmuted == true {
                    add(config.localUserName, "audio.self")
                }
            }

            let mid = meetingId(platform: w.platform, url: w.url, title: w.title)
            for name in who {
                let pid = participantId(meetingId: mid, name: name)
                tracker.pulse(w.platform, name, now,
                              meetingId: mid, participantId: pid, source: sourceOf[name])
            }
            snapshots.append(meetingSnapshot(for: w, meetingId: mid, speaking: who, now: now))

            windowInfos.append(EngineWindowInfo(
                platform: w.platform,
                title: w.title,
                nodeCount: w.nodeCount,
                treeOk: w.treeOk,
                audioPeak: Double(systemPeak)
            ))
        }

        tracker.update(now)
        meetingTracker.observe(snapshots, now)
        emitWindows(windowInfos, systemPeak: systemPeak, ts: now)
    }

    /// Build a roster snapshot for one scanned window. The roster comes ONLY from
    /// real video tiles / panel rosters — NOT the generic tree-walk list, which
    /// leaks UI chrome ("Turn on camera", "Leave call", "Reload"…) as fake people.
    /// Enriched with `isLocal`/`isMuted` from whatever roster the platform exposed
    /// and `isSpeaking` from this tick's resolved speakers.
    private func meetingSnapshot(for w: ScannedWindow, meetingId mid: String,
                                 speaking who: Set<String>, now: Int) -> MeetingSnapshot {
        var mutedByName: [String: Bool] = [:]
        var localNames = Set<String>()

        // Zoom + Teams panel rosters: authoritative per-participant mute + isMe.
        for e in (w.zoomRoster + w.teamsRoster) {
            mutedByName[e.name] = !e.unmuted
            if e.isMe { localNames.insert(e.name) }
        }
        // Teams per-tile mute (less reliable; only when the panel roster lacks it).
        for t in w.teamsTiles {
            if mutedByName[t.name] == nil, let u = t.unmuted { mutedByName[t.name] = !u }
            if t.isMe { localNames.insert(t.name) }
        }
        // Meet self tile (no per-remote mute exposed).
        for t in w.meetTiles where t.isMe { localNames.insert(t.name) }
        // Local mute from the window flag when the roster didn't carry it.
        if let selfName = localNames.first, mutedByName[selfName] == nil,
           let u = w.localUserUnmuted {
            mutedByName[selfName] = !u
        }

        // The scanner already populates `participants` from the clean per-platform
        // source (Meet: People panel / tiles; Teams: tiles + panel roster; Zoom:
        // native roster / web active-speaker tiles) — use it directly.
        var seen = Set<String>()
        let participants = w.participants
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .map { name -> MeetingParticipant in
                MeetingParticipant(
                    id: participantId(meetingId: mid, name: name),
                    name: name,
                    isLocal: localNames.isEmpty ? nil : localNames.contains(name),
                    isMuted: mutedByName[name],
                    isSpeaking: who.contains(name))
            }
        return MeetingSnapshot(id: mid, platform: w.platform, title: w.title, url: w.url,
                               participants: participants, startedAt: now, updatedAt: now)
    }

    // MARK: Emit

    private func handleTrackerEvent(_ event: TrackerEvent) {
        switch event {
        case let .start(platform, name, startTs, ctx):
            record("speech_on", speechFields(platform, name, ctx, [
                "start_ts": startTs,
            ]), ts: startTs)
        case .tick:
            break   // live duration goes to the UI, not the durable log
        case let .end(platform, name, startTs, endTs, durationMs, ctx):
            record("speech_off", speechFields(platform, name, ctx, [
                "start_ts": startTs, "end_ts": endTs, "duration_ms": durationMs,
            ]), ts: endTs)
        }
        onEvent(.tracker(event))
    }

    /// Single event sink: append to the NDJSON log file AND (when enabled) mirror
    /// the same line to stdout for terminal debugging.
    private func record(_ type: String, _ fields: [String: Any], ts: Int) {
        logger?.logEvent(type, fields, ts: ts)
        guard config.logEventsToTerminal else { return }
        var obj = fields
        obj["type"] = type
        obj["ts"] = ts
        if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
           let line = String(data: data, encoding: .utf8) {
            FileHandle.standardOutput.write(Data("[event] \(line)\n".utf8))
        }
    }

    private func speechFields(_ platform: Platform, _ name: String,
                              _ ctx: SpeechContext, _ extra: [String: Any]) -> [String: Any] {
        var f: [String: Any] = [
            "platform": platform.rawValue,
            "name": name,
            "meeting_id": ctx.meetingId,
            "participant_id": ctx.participantId,
        ]
        if let s = ctx.source { f["source"] = s }
        for (k, v) in extra { f[k] = v }
        return f
    }

    private func handleMeetingEvent(_ event: MeetingEvent) {
        logMeetingEvent(event)
        onEvent(.meeting(event))
    }

    private func logMeetingEvent(_ event: MeetingEvent) {
        switch event {
        case let .meetingInitialized(s):
            record("meeting_initialized", meetingFields(s), ts: s.updatedAt)
        case let .meetingUpdated(s):
            record("meeting_updated", meetingFields(s), ts: s.updatedAt)
        case let .meetingEnded(meetingId, ts):
            record("meeting_ended", ["meeting_id": meetingId], ts: ts)
        case let .participantJoined(meetingId, p, ts):
            record("participant_joined", participantFields(meetingId, p), ts: ts)
        case let .participantUpdated(meetingId, p, ts):
            record("participant_updated", participantFields(meetingId, p), ts: ts)
        case let .participantLeft(meetingId, participantId, name, ts):
            record("participant_left", [
                "meeting_id": meetingId, "participant_id": participantId, "name": name,
            ], ts: ts)
        }
    }

    private func meetingFields(_ s: MeetingSnapshot) -> [String: Any] {
        var f: [String: Any] = [
            "meeting_id": s.id, "platform": s.platform.rawValue,
            "title": s.title, "participant_count": s.participants.count,
        ]
        if let url = s.url { f["url"] = url }
        return f
    }

    private func participantFields(_ meetingId: String, _ p: MeetingParticipant) -> [String: Any] {
        var f: [String: Any] = [
            "meeting_id": meetingId, "participant_id": p.id, "name": p.name,
        ]
        if let isLocal = p.isLocal { f["is_local"] = isLocal }
        if let isMuted = p.isMuted { f["is_muted"] = isMuted }
        return f
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
