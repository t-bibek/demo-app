import Foundation
import SpeakerCore
import AXKit

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

    // MARK: Event-driven Meet (plan steps 6–8). ALL default OFF, so with NO env vars
    // set the engine is byte-for-byte the legacy 500ms full-walk poller.

    /// MSD_MODE=event — subscribe the AXObserver path for Meet (edges + confidence)
    /// instead of a full AX walk every tick. false = legacy polling (default).
    var eventDrivenMeet: Bool = false
    /// MSD_TEAMS_MODE=event — Teams rapid-swap disambiguation: per-tick ring
    /// snapshot→diff→TransitionConfidence so a fresh onset overrides a stale lingering
    /// ring during fast handoffs, plus `teams_walk_stats`/`teams_edge` instrumentation.
    /// There is NO AXObserver for Teams — a live probe proved the ring flip fires ZERO
    /// AX notifications (docs §10), so the diff runs synchronously on the existing poll.
    /// false = legacy overlap-set behavior, byte-for-byte (default).
    var eventDrivenTeams: Bool = false
    /// Short-circuit the expensive Meet sub-walks inside `scanner.scan()` when the
    /// observer is live (the Stage-2 CPU win). IMPLIED by event mode unless
    /// MSD_SKIP_MEET_FULLSCAN=0. Legacy mode keeps counting `full_walks` per scan so the
    /// A/B baseline works (INV-8).
    var skipMeetInFullScan: Bool = false
    /// Reconciliation-sweep cadence (bounded re-scan + re-subscribe + death detection).
    var reconcileEveryMs: Int = 4000
    /// AXObserver notification-storm coalescing window.
    var edgeCoalesceMs: Int = 70
    /// Transition-confidence tuning (spike/floor/half-life).
    var transition: TransitionConfidenceConfig = TransitionConfidenceConfig()
    /// MSD_RUN_SECONDS — clean auto-exit after N seconds (required for unattended QA).
    /// 0 = run forever (default).
    var runSeconds: Int = 0
    /// MSD_EDGE_LOG — append `meet_edge` NDJSON to this path too (stdout mirror kept).
    var edgeLogPath: String? = nil
    /// MSD_RING_TRACE=1 — emit a per-tick `[ringtrace]` NDJSON line carrying the RAW
    /// Teams per-tile ring state (`vdi-frame-occlusion`), read straight off the tiles
    /// BEFORE SessionTracker grace/hangover. This is the instrument for the
    /// falsification probe (qa/teams-live: is the ring lit for an unmuted-but-SILENT
    /// remote?) and for measuring ring linger-L. Inert (no output) unless set. The
    /// trace reads the SAME `w.teamsTiles` the resolver uses, so it can't drift from
    /// the real detection path. Default OFF.
    var ringTrace: Bool = false
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
    // someoneGrace debounce: the kssMZb ring lags VAD by its own render/AX-refresh
    // latency, so we DON'T conclude "Someone" the instant AX misses — we hold the
    // floor for `someoneGraceMs` first, so a ring that's about to appear names the
    // real speaker instead of flashing "Someone". `meetSomeoneUnattributedSince` is
    // the ts speech first went unattributed in the current run (nil = attributed/silent).
    private var meetSomeoneUnattributedSince: Int?
    private let someoneGraceMs = 750

    // Teams fused-resolver state (mirrors Meet): last tile areas + telemetry.
    private var teamsPrevAreas: [String: Double] = [:]
    private var teamsStructural = 0  // ticks named via the AX is-speaking token (Recall-style)
    private var teamsNamed = 0       // ticks named via audio-direction fallback
    private var teamsSomeone = 0     // ticks attributed to anonymous "Someone"
    // Teams someoneGrace twin: ts remote speech first went unattributable (0 or
    // 2+ unmuted remotes). Held for someoneGraceMs before the honest "Someone",
    // so Teams' own lagging "<name> is speaking" note can name the speaker first.
    private var teamsSomeoneUnattributedSince: Int?
    // Per-meeting memory so a Teams call SURVIVES its WebView2 tree throttling when
    // backgrounded: readable ticks record the roster + last-readable time keyed by
    // meetingId (title-derived, stable even while throttled); throttled ticks keep
    // the meeting alive from it and the roster persists until the ring resumes.
    private var teamsMemory = TeamsMeetingMemory()
    // Keep a throttled meeting alive for up to this long after its last READABLE
    // read (window existence is the real gate; this just bounds trust in a stale
    // roster so a genuinely-ended call eventually clears). 5 min.
    private let teamsMemoryTtlMs = 300_000

    // Teams event mode (MSD_TEAMS_MODE=event). Per-tick ring snapshot/diff feeds
    // TransitionConfidence for rapid-swap disambiguation (NO AXObserver — docs §10).
    // All inert unless `config.eventDrivenTeams`. Keyed by meetingId so two
    // SIMULTANEOUSLY-readable Teams meetings never cross-contaminate each other's diff
    // origin / holder (pruned each tick to the meetings actually visible).
    private var teamsTransitions: [String: TransitionConfidence] = [:]   // per-meeting confidence
    private var teamsLastSnapshots: [String: TeamsTileSnapshot] = [:]    // per-meeting diff origin
    private var teamsFullWalks = 0     // per-tick Teams window walks (no reduction — Teams can't skip the walk)
    private var teamsEdgeCount = 0     // ring-onset edges fed to the confidence
    private var teamsStatsStartMs = 0
    private var teamsLastStatsMs = 0

    // Event-driven Meet (plan steps 5–8). All inert unless `config.eventDrivenMeet`.
    private var meetObserver: MeetTileObserver?
    private var meetTransition = TransitionConfidence()
    private var meetLastReconcileMs = 0
    // meet_walk_stats counters (emitted per reconcile + on stop, in BOTH modes so the
    // A/B baseline works). `full_walks` counts every Meet sub-walk `scan()` performs
    // in LEGACY mode; event mode drives `subtree_reads`/`edges`/`reconcile_repairs`.
    private var meetFullWalks = 0
    private var meetEdgeCount = 0
    private var meetSubtreeReads = 0
    private var meetReconcileRepairs = 0
    private var meetStatsStartMs = 0
    private var edgeLogHandle: FileHandle?

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

        meetStatsStartMs = nowMs()
        meetLastReconcileMs = nowMs()
        meetTransition = TransitionConfidence(config: config.transition)
        teamsStatsStartMs = nowMs()
        teamsLastStatsMs = nowMs()

        // Open the optional edge-event log (MSD_EDGE_LOG) — meet_edge lines are
        // appended here too, in ADDITION to the stdout/NDJSON mirror in record().
        if let path = config.edgeLogPath {
            let url = URL(fileURLWithPath: path)
            FileManager.default.createFile(atPath: path, contents: nil)
            edgeLogHandle = try? FileHandle(forWritingTo: url)
            edgeLogHandle?.seekToEndOfFile()
        }

        // Event mode: spin up the AXObserver (dedicated CFRunLoop thread). Legacy mode
        // leaves this nil, so `scanner.scan()` does the full Meet walk exactly as before.
        if config.eventDrivenMeet {
            let obs = MeetTileObserver(scanner: scanner, coalesceMs: config.edgeCoalesceMs)
            obs.onLifecycle = { [weak self] state, nodes in
                self?.queue.async { self?.recordObserverLifecycle(state, nodes) }
            }
            meetObserver = obs
            obs.start()
            status(.info, "Detection started — event-driven Meet (MSD_MODE=event), audio poll every \(config.pollIntervalMs) ms.")
        } else {
            status(.info, "Detection started — polling every \(config.pollIntervalMs) ms.")
        }

        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + .milliseconds(config.pollIntervalMs),
                   repeating: .milliseconds(config.pollIntervalMs),
                   leeway: .milliseconds(50))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t

        // MSD_RUN_SECONDS — clean auto-exit for unattended QA. Stop the engine (which
        // flushes the final meet_walk_stats), then terminate the process.
        if config.runSeconds > 0 {
            let deadline = DispatchTime.now() + .seconds(config.runSeconds)
            DispatchQueue.global().asyncAfter(deadline: deadline) { [weak self] in
                self?.stop()
                exit(0)
            }
        }
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

        // Event-driven Meet teardown + FINAL meet_walk_stats (emitted in BOTH modes so
        // the A/B baseline always has a closing sample). Fold in the observer's own
        // counters before it stops.
        if let obs = meetObserver {
            let s = obs.snapshotStats()
            meetSubtreeReads = s.subtreeReads
            meetReconcileRepairs = s.reconcileRepairs
            obs.stop()
            meetObserver = nil
        }
        emitWalkStats(now: nowMs())
        emitTeamsWalkStats(now: nowMs())
        edgeLogHandle?.closeFile()
        edgeLogHandle = nil

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

        scanner.meetLocalUserName = config.localUserName   // for name-based self-tile ID (the AX `(You)` label was removed)
        // Tell the scanner which Teams meetings were readable recently, so it keeps a
        // now-THROTTLED (backgrounded) meeting window alive instead of dropping it.
        teamsMemory.prune(nowMs: now, maxAgeMs: teamsMemoryTtlMs)
        scanner.teamsActiveMeetingIds = teamsMemory.activeIds(nowMs: now, ttlMs: teamsMemoryTtlMs)

        // EVENT-DRIVEN MEET (plan step 7). Drain the observer's edges → feed the
        // transition confidence → build the per-tick transition state the resolver
        // uses to disambiguate stale rings. Also drive the reconciliation sweep and
        // tell the scanner to skip the expensive Meet sub-walk while the observer is
        // live. All inert in legacy mode (meetObserver == nil).
        var meetTransitionState: MeetTransitionState? = nil
        var meetEventSnapshot: MeetTileSnapshot? = nil
        if let obs = meetObserver {
            scanner.skipMeetSubWalk = config.skipMeetInFullScan
            // Reconcile sweep on cadence (bounded re-scan + re-subscribe + death detect).
            // Emit a meet_walk_stats sample at each reconcile so the CPU-compare suite
            // gets periodic counters (also emitted on stop).
            if now - meetLastReconcileMs >= config.reconcileEveryMs {
                meetLastReconcileMs = now
                obs.reconcile()
                let s = obs.snapshotStats()
                meetSubtreeReads = s.subtreeReads
                meetReconcileRepairs = s.reconcileRepairs
                emitWalkStats(now: now)
            } else {
                // PRIMARY edge source (plan step 7 / handoff edge-source #1): a fast
                // bounded subtree re-read every poll tick. Class-token ring moves post NO
                // AX notification, so without this the observer only catches a ring move
                // when an unrelated notification wakes it — up to 4s late, past the 800ms
                // edge-latency bar. Skipped on a reconcile tick (reconcile already re-reads).
                obs.pollRefresh()
            }
            let mono = AXKit.monotonicMs()
            for e in obs.drainEdges() {
                meetTransition.edge(to: e.to, at: e.atMs)
                let conf = meetTransition.confidence(of: e.to, at: mono)
                meetEdgeCount += 1
                recordEdge(e, confidence: conf)
            }
            // Fold the observer's live counters into the engine's meet_walk_stats.
            let s = obs.snapshotStats()
            meetSubtreeReads = s.subtreeReads
            meetReconcileRepairs = s.reconcileRepairs
            meetEventSnapshot = obs.currentSnapshot()
            if let holder = meetTransition.holder {
                meetTransitionState = MeetTransitionState(
                    holder: holder,
                    confidence: meetTransition.confidence(of: holder, at: mono),
                    nowMs: mono)
            }
        } else {
            scanner.skipMeetSubWalk = false
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
        // One status chip per MEETING, not per window — a call can span several
        // windows (Teams main + compact, Zoom main + PIP) that share one meeting id.
        var chipMeetings = Set<String>()
        // Prune Teams event-mode diff state to the meetings visible THIS tick, so the
        // per-meeting dicts can't grow across a session and a genuinely-ended meeting's
        // stale diff origin can't resurface if its id recurs.
        if config.eventDrivenTeams {
            let liveTeamsMids = Set(scanned.filter { $0.platform == .teams }
                .map { meetingId(platform: $0.platform, url: $0.url, title: $0.title) })
            teamsLastSnapshots = teamsLastSnapshots.filter { liveTeamsMids.contains($0.key) }
            teamsTransitions = teamsTransitions.filter { liveTeamsMids.contains($0.key) }
        }
        for var w in scanned {
            let wMid = meetingId(platform: w.platform, url: w.url, title: w.title)
            // Throttle-boundary instrument (MSD_RING_TRACE, plan #3): a per-tick
            // window-level trace for EVERY Teams window — emitted here, BEFORE the
            // keep-alive `continue`, so it captures a THROTTLED window too. Lets the
            // supervised session time exactly when the tree goes empty after
            // backgrounding, and whether the compact/PIP note survives the throttle.
            if config.ringTrace && w.platform == .teams {
                emitTeamsWindowTrace(meetingId: wMid, window: w, ts: now)
            }
            // Keep-alive-only windows (the Teams compact / PIP view, OR a throttled
            // backgrounded meeting) hold the meeting open but contribute no live
            // speakers — snapshot them so the meeting doesn't end, then skip
            // attribution. For a THROTTLED Teams meeting, replay the last-known roster
            // from TeamsMeetingMemory so participants persist (no false leave churn)
            // until the ring resumes.
            if w.keepAliveOnly {
                if w.platform == .teams, w.participants.isEmpty, let mem = teamsMemory.entry(wMid) {
                    w.participants = mem.participants
                    w.teamsRoster = mem.roster
                }
                snapshots.append(meetingSnapshot(for: w, meetingId: wMid, speaking: [], now: now))
                if chipMeetings.insert(wMid).inserted {
                    windowInfos.append(EngineWindowInfo(
                        platform: w.platform, title: w.title, nodeCount: w.nodeCount,
                        treeOk: w.treeOk, audioPeak: Double(systemPeak)))
                }
                continue
            }
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

            if let pip = w.pipSpeaker {
                // Direct active-speaker read off a PIP / compact thumbnail — the app's
                // OWN VAD (Zoom "Talking: <name>", Teams "<name> is speaking"). Trust
                // it over the mute-gate / anonymous floor.
                add(pip, w.platform == .zoom ? "zoom.pip" : "teams.pip")
                // The note named the speaker — the Someone floor is attributed.
                if w.platform == .teams { teamsSomeoneUnattributedSince = nil }
            } else if w.platform == .meet {
                // LEGACY vs EVENT tile source. Legacy: the scanner's full per-tile
                // sub-walk (counted as one `full_walk` per Meet scan for the A/B
                // baseline — INV-8). Event: the scanner skipped that walk, so tiles come
                // from the observer snapshot (synthesized from its ring/focus/equalizer
                // holders). If the observer has no snapshot yet (first ticks / background
                // tab), fall through with empty tiles → VAD-only "Someone" floor.
                let meetTiles: [MeetTileObservation]
                if meetObserver != nil && config.skipMeetInFullScan {
                    meetTiles = Self.meetTilesFromSnapshot(meetEventSnapshot)
                } else {
                    meetFullWalks += 1
                    meetTiles = w.meetTiles
                }

                // Remote/active naming comes ONLY from the AX tree now (structural →
                // geometry → strict kssMZb), VAD-gated. Corrected understanding:
                // kssMZb IS a real per-tile active-speaker class — the self-CLUSTER
                // that confounded it with hover/self-view was removed. Audio
                // direction is NO LONGER used to name remotes; the mic only names the
                // LOCAL user, whose own tile never carries the speaking ring.
                if meetTiles.contains(where: { $0.classSpeaking }) { meetClassFired += 1 }

                // Remote attribution (ring/geometry) is gated on SYSTEM audio ONLY —
                // NOT the local mic. The mic meter moves for the USER'S OWN voice, and
                // a MUTED meeting mic still moves the physical meter, so folding
                // micActive in here pinned your own (muted) speech onto the remote
                // tile. Remotes come only from system-audio speech; self is
                // mic-attributed separately below. Soft-open when capture is
                // unavailable (accessibility-only mode leans on the ring/geometry).
                let remoteVad = audioReliable ? remoteActive : true
                // `transition:` disambiguates stale rings in event mode; nil in legacy
                // mode ⇒ byte-for-byte the same call as before (opt-in non-regression).
                let r = meetActiveSpeaker(tiles: meetTiles, prevAreas: meetPrevAreas,
                                          vadSpeechActive: remoteVad, presentationActive: w.presentationActive,
                                          transition: meetTransitionState)
                // Resolve the local user's REAL name — never the generic "You". Prefer
                // the "(You)"-tagged tile; if that missed but there's a single tile and
                // the mic is live, that lone tile is self. If it can't be resolved yet
                // (e.g. the very first tick, before tiles parse), we DON'T name self
                // this tick rather than logging a throwaway "You" that then splits into
                // two speakers ("You" + the real name).
                let selfTile = meetTiles.first(where: { $0.isMe })
                let meetSelfName: String? = selfTile?.name
                    ?? (micActive && (w.localUserUnmuted ?? false) && meetTiles.count == 1
                        ? meetTiles[0].name : nil)

                if r.via != .none && r.via != .someoneFloor {
                    // Attribution source for telemetry. The event-driven edge path gets
                    // its own `meet.kssMZb.edge` tag so edge-driven naming is visible
                    // end-to-end (plan step 6 SessionTracker source).
                    let src: String
                    switch r.via {
                    case .ringTransition: src = "meet.kssMZb.edge"
                    case .cssClass:       src = "meet.kssMZb"
                    case .equalizer:      src = "meet.equalizer"
                    case .focused:        src = "meet.focused"
                    default:              src = "meet.geometry"
                    }
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
                // anonymous floor, DEBOUNCED. The kssMZb ring lags VAD, so instead of
                // concluding "Someone" the instant AX misses, hold the floor for
                // someoneGraceMs; if a real name is attributed within that window we
                // never emit Someone (the ring caught up). Reset the timer the moment
                // anyone is named this tick or speech stops.
                if !who.isEmpty || r.via == .none {
                    meetSomeoneUnattributedSince = nil
                } else if r.via == .someoneFloor && audioReliable {
                    let since = meetSomeoneUnattributedSince ?? now
                    meetSomeoneUnattributedSince = since
                    if now - since >= someoneGraceMs {
                        add("Someone", "meet.someone")
                        meetSomeone += 1
                    }
                    // else: within grace — hold, don't emit Someone yet.
                }
                meetPrevAreas = Dictionary(meetTiles.map { ($0.name, $0.area) }, uniquingKeysWith: { a, _ in a })

                // Event mode + skipped sub-walk: the scanner returned an empty roster
                // (the walk that would fill it was skipped), so seed the meeting roster
                // from the observer snapshot's holders + this tick's speakers, keeping
                // the meeting alive with a non-empty participant list.
                if meetObserver != nil && config.skipMeetInFullScan && w.participants.isEmpty {
                    var roster = Set(meetTiles.map { $0.name })
                    roster.formUnion(who.filter { $0 != "Someone" })
                    w.participants = Array(roster)
                }
            } else if w.platform == .teams {
                // Teams (new client) DOES expose a per-speaker RING —
                // `vdi-frame-occlusion` on the active remote's tile subtree, Teams'
                // OWN VAD (live-verified 2026-07-04, 3-party co-variance; supersedes
                // the old §7 "no signal" verdict). The pure extractor reads it
                // STRUCTURALLY per tile, so `teamsActiveSpeaker` names the speaking
                // remote(s) directly — overlap-capable, self-excluded. Audio/mute is
                // now only a fallback (camera-off speaker) + the local-user mic path.
                // See docs/teams-active-speaker-detection.md.
                let readable = !w.teamsTiles.isEmpty
                // Every readable Teams tick walks the window (teamsWindowNode) — there is
                // NO walk-skip for Teams: the AXObserver that enables Meet's skip delivers
                // ZERO events on a ring flip here (live probe, docs §10), so `full_walks`
                // counts one per readable Teams window in BOTH modes (the honest CPU story
                // — event mode adds accuracy, not a walk reduction).
                if readable { teamsFullWalks += 1 }

                // EVENT MODE (MSD_TEAMS_MODE=event): ring snapshot → diff → Transition
                // Confidence, so a FRESH onset overrides a STALE lingering ring during a
                // fast handoff (~1270ms ring linger measured, docs §9.1). Inert
                // (teamsTransitionState == nil) in legacy mode ⇒ byte-for-byte overlap set.
                var teamsTransitionState: TeamsTransitionState? = nil
                if config.eventDrivenTeams {
                    let mono = AXKit.monotonicMs()
                    // Per-meeting diff origin + confidence (keyed by wMid) so two live
                    // Teams meetings never cross-contaminate. TransitionConfidence is a
                    // value type: copy out, mutate, store back.
                    var tc = teamsTransitions[wMid] ?? TransitionConfidence(config: config.transition)
                    let next = TeamsTileSnapshot.from(tiles: w.teamsTiles)
                    for e in teamsEdgesFromDiff(prev: teamsLastSnapshots[wMid], next: next, at: mono) {
                        tc.edge(to: e.to, at: e.atMs)
                        teamsEdgeCount += 1
                        recordTeamsEdge(e, confidence: tc.confidence(of: e.to, at: mono))
                    }
                    teamsLastSnapshots[wMid] = next
                    if let holder = tc.holder {
                        teamsTransitionState = TeamsTransitionState(
                            holder: holder,
                            confidence: tc.confidence(of: holder, at: mono),
                            nowMs: mono)
                    }
                    teamsTransitions[wMid] = tc
                    if now - teamsLastStatsMs >= config.reconcileEveryMs {
                        teamsLastStatsMs = now
                        emitTeamsWalkStats(now: now)
                    }
                }

                // Ring is Teams' VAD → trusted directly (vadSpeechActive: true).
                let r = teamsActiveSpeaker(tiles: w.teamsTiles, prevAreas: teamsPrevAreas,
                                           vadSpeechActive: true, transition: teamsTransitionState)
                // Falsification-probe instrument (MSD_RING_TRACE): dump the RAW per-tile
                // ring here, before any tracker grace, so the probe can tell whether the
                // ring lights for an unmuted-but-silent remote and can time linger-L.
                if config.ringTrace {
                    emitRingTrace(meetingId: wMid, tiles: w.teamsTiles,
                                  remoteAudio: audioReliable && remoteActive, ts: now)
                }
                // `.ringTransition` names the disambiguated fresh onset; `.structural` names
                // the overlap set. Both are the ring path — tag the source so telemetry
                // shows when a stale-ring linger was suppressed.
                if r.via == .structural || r.via == .ringTransition {
                    let src = r.via == .ringTransition ? "teams.ring.transition" : "teams.ring"
                    for n in r.names { add(n, src) }
                    teamsStructural += 1
                }
                if audioReliable {
                    // Mute source: the People-panel ROSTER (reliable per-remote,
                    // panel-open) else per-tile mute.
                    let roster = w.teamsRoster
                    let meRoster = roster.first(where: { $0.isMe })
                    let meTile = w.teamsTiles.first(where: { $0.isMe })
                    let localUnmuted = meRoster?.unmuted ?? meTile?.unmuted ?? (w.localUserUnmuted ?? false)
                    // SELF via mic — the self tile carries no speaker ring (it has
                    // vdi-dynamic-occlusion), so the local user is named from the mic
                    // when unmuted, exactly like Meet's self path. Use ONLY the
                    // resolved real name (self tile / roster) — never the "You"
                    // placeholder, which otherwise split self into two speakers
                    // ("You" + the real name) across ticks where the self tile wasn't
                    // readable (mirrors the Meet self-name rule).
                    let localName = meRoster?.name ?? meTile?.name
                    if micActive && localUnmuted, let ln = localName { add(ln, "teams.self_mic") }
                    // Camera-off remote fallback: the ring needs a video frame, so if
                    // it named no remote yet there IS remote audio, mute-gate a SINGLE
                    // unmuted remote (2+ stays ambiguous → we don't guess).
                    if r.via != .structural && remoteActive {
                        let remotes = roster.isEmpty
                            ? w.teamsTiles.filter { !$0.isMe && ($0.unmuted ?? true) }.map { $0.name }
                            : roster.filter { !$0.isMe && $0.unmuted }.map { $0.name }
                        if remotes.count == 1 { add(remotes[0], "teams.mute_gate"); teamsNamed += 1 }
                    }
                }
                // "Someone" ONLY when the tree is UNREADABLE (no tiles —
                // backgrounded/WebView2-throttled) yet remote audio is present.
                // Foreground-readable NEVER yields "Someone": the ring names the
                // speaker, so a foreground "Someone" is a bug by definition. Debounced
                // like Meet so a one-tick read gap can't flash it.
                if !who.isEmpty || readable || !(audioReliable && remoteActive) {
                    teamsSomeoneUnattributedSince = nil
                } else {
                    let since = teamsSomeoneUnattributedSince ?? now
                    teamsSomeoneUnattributedSince = since
                    if now - since >= someoneGraceMs {
                        add("Someone", "teams.someone")
                        teamsSomeone += 1
                    }
                }
                teamsPrevAreas = Dictionary(w.teamsTiles.map { ($0.name, $0.area) }, uniquingKeysWith: { a, _ in a })
            } else if w.directSpeakerRead {
                // Meet (kssMZb class) / Zoom web ("active speaker" marker): the UI
                // names the speaker, including your own tile. Trust it; only fall
                // back to the anonymous "Someone" when the tree itself is
                // unreadable (e.g. a backgrounded tab). No "You" — your tile is
                // already named, so adding it would double-log.
                //
                // Zoom web names the active speaker via the speaker-bar tile's
                // `…__video-frame--active` CSS class (read as zoomWebSpeaker). VAD-
                // gate it: the highlight lingers on the last talker during silence,
                // so only trust it while audio confirms speech (fall back to trusting
                // it when system-audio capture isn't available, like Meet's class).
                if let ws = w.zoomWebSpeaker,
                   audioReliable ? (micActive || remoteActive) : true {
                    add(ws, "zoom.web_active")
                }
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

            let mid = wMid
            // A READABLE Teams meeting (has tiles or roster this tick) refreshes the
            // memory so a later throttled tick keeps it alive with this roster.
            if w.platform == .teams, !(w.teamsTiles.isEmpty && w.teamsRoster.isEmpty) {
                teamsMemory.observeReadable(meetingId: mid, roster: w.teamsRoster,
                                            participants: w.participants, pid: w.pid, nowMs: now)
            }
            for name in who {
                let pid = participantId(meetingId: mid, name: name)
                tracker.pulse(w.platform, name, now,
                              meetingId: mid, participantId: pid, source: sourceOf[name])
            }
            snapshots.append(meetingSnapshot(for: w, meetingId: mid, speaking: who, now: now))

            if chipMeetings.insert(mid).inserted {
                windowInfos.append(EngineWindowInfo(
                    platform: w.platform,
                    title: w.title,
                    nodeCount: w.nodeCount,
                    treeOk: w.treeOk,
                    audioPeak: Double(systemPeak)
                ))
            }
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

    /// Raw Teams ring dump for the falsification probe (MSD_RING_TRACE). Stdout-only
    /// (never touches the durable session log) so the probe harness can sample the
    /// unmodified per-tile ring at the poll cadence. One line per readable Teams
    /// meeting window per tick.
    private func emitRingTrace(meetingId: String, tiles: [TeamsTileObservation],
                              remoteAudio: Bool, ts: Int) {
        let tileObjs: [[String: Any]] = tiles.map {
            ["name": $0.name, "ring": $0.isSpeaking, "is_me": $0.isMe,
             "unmuted": $0.unmuted.map { $0 as Any } ?? NSNull(), "area": $0.area]
        }
        let obj: [String: Any] = [
            "type": "teams_ring_trace", "ts": ts, "meeting_id": meetingId,
            "remote_audio": remoteAudio,
            "ring_names": tiles.filter { $0.isSpeaking && !$0.isMe }.map { $0.name },
            "tiles": tileObjs,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
           let line = String(data: data, encoding: .utf8) {
            FileHandle.standardOutput.write(Data("[ringtrace] \(line)\n".utf8))
        }
    }

    /// Per-tick window-level Teams trace for the throttle-boundary spike (plan #3).
    /// `readable=false` marks a throttled/backgrounded window whose deep tree went
    /// empty; `keep_alive` marks a window the scanner is holding open from memory;
    /// `pip` reports whether the compact "<name> is speaking" note is still live.
    /// Stdout-only, MSD_RING_TRACE-gated.
    private func emitTeamsWindowTrace(meetingId: String, window w: ScannedWindow, ts: Int) {
        let obj: [String: Any] = [
            "type": "teams_window_trace", "ts": ts, "meeting_id": meetingId,
            "readable": !w.teamsTiles.isEmpty, "tile_count": w.teamsTiles.count,
            "participant_count": w.participants.count, "keep_alive": w.keepAliveOnly,
            "node_count": w.nodeCount, "pip": w.pipSpeaker.map { $0 as Any } ?? NSNull(),
            "title": w.title,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
           let line = String(data: data, encoding: .utf8) {
            FileHandle.standardOutput.write(Data("[teamstrace] \(line)\n".utf8))
        }
    }

    /// Reconstruct the minimal `MeetTileObservation`s the resolver needs from an
    /// observer snapshot (event mode, when the scanner skipped the per-tile sub-walk).
    /// The snapshot already excludes self, so every synthesized tile is a non-self
    /// remote: equalizer speakers get `equalizerSpeaking`, the ring holder gets
    /// `classSpeaking`, the focus holder gets `isFocused`. Geometry is unavailable
    /// (area 0) — the resolver leans on the ring/equalizer/transition signals instead,
    /// which is exactly what event mode is for. Empty snapshot ⇒ [] ⇒ VAD "Someone" floor.
    static func meetTilesFromSnapshot(_ snap: MeetTileSnapshot?) -> [MeetTileObservation] {
        guard let snap else { return [] }
        var byName: [String: (ring: Bool, focus: Bool, eq: Bool)] = [:]
        for n in snap.equalizerSpeakers { byName[n, default: (false, false, false)].eq = true }
        if let r = snap.ringHolder { byName[r, default: (false, false, false)].ring = true }
        if let f = snap.focusHolder { byName[f, default: (false, false, false)].focus = true }
        return byName.enumerated().map { i, kv in
            MeetTileObservation(name: kv.key, area: 0, orderIndex: i,
                                classSpeaking: kv.value.ring, isFocused: kv.value.focus,
                                isMe: false, equalizerSpeaking: kv.value.eq)
        }
    }

    // MARK: Event-driven Meet instrumentation (plan step 6 NDJSON)

    /// Emit one `meet_walk_stats` line: full_walks / subtree_reads / edges /
    /// reconcile_repairs / walks_per_min. Called per reconcile AND on stop, counting in
    /// BOTH modes so the CPU-compare suite can diff legacy (full_walks) vs event
    /// (subtree_reads) directly.
    private func emitWalkStats(now: Int) {
        let elapsedMs = max(1, now - meetStatsStartMs)
        let walksPerMin = Double(meetFullWalks) / (Double(elapsedMs) / 60_000.0)
        record("meet_walk_stats", [
            "full_walks": meetFullWalks,
            "subtree_reads": meetSubtreeReads,
            "edges": meetEdgeCount,
            "reconcile_repairs": meetReconcileRepairs,
            "walks_per_min": (walksPerMin * 100).rounded() / 100,
        ], ts: now)
    }

    /// Teams CPU/walk instrumentation (mirrors `meet_walk_stats`). `full_walks` is one
    /// per readable Teams tick in BOTH modes — Teams has no walk-skip (no usable
    /// AXObserver, docs §10), so this honestly shows event mode buys ACCURACY (edges →
    /// rapid-swap disambiguation), not a CPU reduction. `edges` = ring onsets fed to the
    /// confidence. Emitted on the reconcile cadence (event mode) + on stop.
    private func emitTeamsWalkStats(now: Int) {
        let elapsedMs = max(1, now - teamsStatsStartMs)
        let walksPerMin = Double(teamsFullWalks) / (Double(elapsedMs) / 60_000.0)
        record("teams_walk_stats", [
            "full_walks": teamsFullWalks,
            "edges": teamsEdgeCount,
            "event_mode": config.eventDrivenTeams,
            "walks_per_min": (walksPerMin * 100).rounded() / 100,
        ], ts: now)
    }

    /// Emit one `teams_edge` line per ring onset (kind/to/confidence/mono_ts/wall_ts),
    /// mirroring `meet_edge`. `mono_ts` is the decay origin; `wall_ts` correlates with
    /// the live-QA rig's scripted handoff wall-times.
    private func recordTeamsEdge(_ e: TeamsEdgeEvent, confidence: Double) {
        let wall = nowMs()
        record("teams_edge", [
            "kind": e.kindToken,
            "to": e.to,
            "confidence": (confidence * 1000).rounded() / 1000,
            "mono_ts": e.atMs,
            "wall_ts": wall,
        ], ts: wall)
    }

    /// Emit one `meet_edge` line per drained edge (kind/from/to/confidence/mono_ts/wall_ts)
    /// and mirror it to MSD_EDGE_LOG when set (stdout mirror is kept via record()).
    /// `mono_ts` (monotonic uptime ms) is the decay origin; `wall_ts` (epoch ms) is the
    /// correlation key the live-QA edge-latency check matches against the rig's scripted
    /// swap wall-times — the edge-log FILE lines must carry it, not just the stdout mirror.
    private func recordEdge(_ e: MeetEdgeEvent, confidence: Double) {
        let wall = nowMs()
        var f: [String: Any] = [
            "kind": e.kindToken,
            "to": e.to,
            "confidence": (confidence * 1000).rounded() / 1000,
            "mono_ts": e.atMs,
            "wall_ts": wall,
        ]
        if let from = e.from { f["from"] = from }
        record("meet_edge", f, ts: wall)
        if let h = edgeLogHandle {
            var obj = f
            obj["type"] = "meet_edge"
            if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
               let line = String(data: data, encoding: .utf8) {
                h.write(Data("\(line)\n".utf8))
            }
        }
    }

    /// Emit one `meet_observer` lifecycle line (started/resubscribed/dead/background_tab).
    private func recordObserverLifecycle(_ state: MeetObserverState, _ nodes: Int) {
        record("meet_observer", [
            "state": state.rawValue,
            "subscribed_nodes": nodes,
        ], ts: nowMs())
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
