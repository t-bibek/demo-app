import Foundation
import SwiftUI
import AppKit
import CoreGraphics
import Combine
import SpeakerCore

/// View-model that turns engine `AppEvent`s into observable UI state. Mirrors
/// the React state in the original src/renderer/App.tsx (active speakers,
/// completed sessions capped at 500, window status, cumulative talk time).
@MainActor
final class AppModel: ObservableObject {

    struct ActiveSpeaker: Identifiable {
        var platform: Platform
        var name: String
        var startTs: Int
        var durationMs: Int
        var id: String { "\(platform.rawValue)::\(name)" }
    }

    struct SessionRow: Identifiable {
        let id = UUID()
        var platform: Platform
        var name: String
        var startTs: Int
        var endTs: Int
        var durationMs: Int
    }

    struct TalkTimeRow: Identifiable {
        var name: String
        var totalMs: Int
        var id: String { name }
    }

    /// One row in the live Recall-style event stream shown in the app. Rich enough
    /// to drive both the Speaking log (speech_on/off columns) and the Event log.
    struct EventRow: Identifiable {
        enum Kind { case meeting, participant, speech }
        let id = UUID()
        var ts: Int
        var type: String        // "speech_on", "participant_joined", "meeting_initialized"…
        var kind: Kind
        var platform: Platform?
        var name: String?       // speaker / participant name
        var durationMs: Int?    // set on speech_off
        var summary: String     // human label for the full Event log

        var isSpeechOn: Bool { type == "speech_on" }
    }

    @Published private(set) var active: [ActiveSpeaker] = []
    @Published private(set) var sessions: [SessionRow] = []
    @Published private(set) var windows: [EngineWindowInfo] = []
    @Published private(set) var statusMessages: [EngineStatus] = []
    /// Live meetings (Recall-style), kept current from `MeetingEvent`s. The full
    /// event stream is also written to the NDJSON log.
    @Published private(set) var meetings: [MeetingSnapshot] = []
    /// The live event stream shown in the UI (newest first), capped.
    @Published private(set) var eventLog: [EventRow] = []
    @Published private(set) var running = false

    /// Flat roster across all live meetings (for any roster-aware UI).
    var participants: [MeetingParticipant] { meetings.flatMap { $0.participants } }

    @Published var micAuthorized = MicMeter.isAuthorized
    @Published var axTrusted = AccessibilityScanner.isTrusted
    @Published var screenAuthorized = CGPreflightScreenCaptureAccess()
    /// True once a permission was granted that only takes effect after a
    /// relaunch (Screen Recording and, usually, Accessibility). macOS does not
    /// expose a newly-granted permission to the already-running process.
    @Published private(set) var needsRelaunch = false

    private static let maxSessions = 500
    private static let maxStatus = 200
    private static let maxEvents = 300

    private var engine: DetectionEngine?
    private var permissionTimer: Timer?

    var logURL: URL? { engine?.logURL }

    init() {
        permissionTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshPermissions() }
        }
        // macOS posts this when Accessibility settings change — refresh promptly
        // instead of waiting for the next poll.
        DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name("com.apple.accessibility.api"),
            object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.refreshPermissions() }
        }
    }

    // MARK: Cumulative talk time (per person, active + completed), sorted desc.

    var talkTime: [TalkTimeRow] {
        var totals: [String: Int] = [:]
        for s in sessions { totals[s.name, default: 0] += s.durationMs }
        for a in active { totals[a.name, default: 0] += a.durationMs }
        return totals
            .map { TalkTimeRow(name: $0.key, totalMs: $0.value) }
            .sorted { $0.totalMs > $1.totalMs }
    }

    // MARK: Engine control

    func toggle() {
        running ? stopEngine() : startEngine()
    }

    func startEngine() {
        guard engine == nil else { return }
        let eng = DetectionEngine { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
        engine = eng
        eng.start()
        running = true
    }

    func stopEngine() {
        engine?.stop()
        engine = nil
        running = false
        active = []
        meetings = []
        eventLog = []
    }

    // MARK: Permissions

    func requestPermissions() {
        MicMeter.requestAccess { [weak self] _ in self?.refreshPermissions() }
        AccessibilityScanner.requestAccessIfNeeded()
        // Screen Recording: prompts and adds us to the list. The grant only
        // takes effect after a relaunch, so flag it.
        DispatchQueue.global().async { [weak self] in
            let granted = CGRequestScreenCaptureAccess()
            Task { @MainActor in
                self?.refreshPermissions()
                if !granted { self?.needsRelaunch = true }
            }
        }
        refreshPermissions()
    }

    func refreshPermissions() {
        let mic = MicMeter.isAuthorized
        let ax = AccessibilityScanner.isTrusted
        let screen = CGPreflightScreenCaptureAccess()
        // If something we lacked just became granted while we're already
        // running, a relaunch is required for it to take effect.
        if (!micAuthorized && mic) || (!axTrusted && ax) || (!screenAuthorized && screen) {
            needsRelaunch = true
        }
        if mic != micAuthorized { micAuthorized = mic }
        if ax != axTrusted { axTrusted = ax }
        if screen != screenAuthorized { screenAuthorized = screen }
    }

    /// Cleanly restarts the app so freshly-granted permissions take effect.
    /// Waits for this process to exit, then reopens the bundle.
    func relaunch() {
        let path = Bundle.main.bundlePath
        let pid = ProcessInfo.processInfo.processIdentifier
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/sh")
        proc.arguments = ["-c", "while kill -0 \(pid) 2>/dev/null; do sleep 0.1; done; open \"\(path)\""]
        try? proc.run()
        NSApp.terminate(nil)
    }

    // MARK: Event handling (was the window event listener in App.tsx)

    private func handle(_ event: AppEvent) {
        switch event {
        case .tracker(let t):
            handleTracker(t)
        case .windows(let w):
            windows = w.windows
        case .status(let s):
            statusMessages.append(s)
            if statusMessages.count > Self.maxStatus {
                statusMessages.removeFirst(statusMessages.count - Self.maxStatus)
            }
        case .meeting(let m):
            handleMeeting(m)
        }
    }

    private func handleTracker(_ event: TrackerEvent) {
        switch event {
        case let .start(platform, name, startTs, _):
            let key = "\(platform.rawValue)::\(name)"
            if !active.contains(where: { $0.id == key }) {
                active.append(ActiveSpeaker(platform: platform, name: name, startTs: startTs, durationMs: 0))
            }
            logEvent(EventRow(ts: startTs, type: "speech_on", kind: .speech,
                              platform: platform, name: name, summary: name))

        case let .tick(platform, name, startTs, durationMs, _):
            let key = "\(platform.rawValue)::\(name)"
            if let i = active.firstIndex(where: { $0.id == key }) {
                active[i].durationMs = durationMs
                active[i].startTs = startTs
            } else {
                active.append(ActiveSpeaker(platform: platform, name: name, startTs: startTs, durationMs: durationMs))
            }

        case let .end(platform, name, startTs, endTs, durationMs, _):
            let key = "\(platform.rawValue)::\(name)"
            active.removeAll { $0.id == key }
            sessions.insert(SessionRow(platform: platform, name: name,
                                       startTs: startTs, endTs: endTs, durationMs: durationMs),
                            at: 0)
            if sessions.count > Self.maxSessions {
                sessions.removeLast(sessions.count - Self.maxSessions)
            }
            logEvent(EventRow(ts: endTs, type: "speech_off", kind: .speech,
                              platform: platform, name: name, durationMs: durationMs,
                              summary: "\(name) · \(formatDuration(durationMs))"))
        }
    }

    /// Append to the live event stream (newest first), capped.
    private func logEvent(_ row: EventRow) {
        eventLog.insert(row, at: 0)
        if eventLog.count > Self.maxEvents {
            eventLog.removeLast(eventLog.count - Self.maxEvents)
        }
    }

    /// Keep `meetings` current from the lifecycle stream. `meetingInitialized` /
    /// `meetingUpdated` carry the full roster, so the granular participant events
    /// need no separate bookkeeping here.
    private func handleMeeting(_ event: MeetingEvent) {
        switch event {
        case let .meetingInitialized(s):
            upsertMeeting(s)
            logEvent(EventRow(ts: s.updatedAt, type: "meeting_initialized", kind: .meeting,
                              platform: s.platform,
                              summary: "\(s.title) · \(s.participants.count) participant\(s.participants.count == 1 ? "" : "s")"))
        case let .meetingUpdated(s):
            upsertMeeting(s)
        case let .meetingEnded(meetingId, ts):
            let title = meetings.first { $0.id == meetingId }?.title ?? meetingId
            meetings.removeAll { $0.id == meetingId }
            logEvent(EventRow(ts: ts, type: "meeting_ended", kind: .meeting, summary: title))
        case let .participantJoined(_, p, ts):
            logEvent(EventRow(ts: ts, type: "participant_joined", kind: .participant, name: p.name, summary: p.name))
        case let .participantLeft(_, _, name, ts):
            logEvent(EventRow(ts: ts, type: "participant_left", kind: .participant, name: name, summary: name))
        case let .participantUpdated(_, p, ts):
            let mute = p.isMuted == true ? "muted" : (p.isMuted == false ? "unmuted" : "—")
            logEvent(EventRow(ts: ts, type: "participant_updated", kind: .participant, name: p.name,
                              summary: "\(p.name) · \(mute)"))
        }
    }

    private func upsertMeeting(_ s: MeetingSnapshot) {
        if let i = meetings.firstIndex(where: { $0.id == s.id }) {
            meetings[i] = s
        } else {
            meetings.append(s)
        }
    }
}
