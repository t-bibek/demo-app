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

    @Published private(set) var active: [ActiveSpeaker] = []
    @Published private(set) var sessions: [SessionRow] = []
    @Published private(set) var windows: [EngineWindowInfo] = []
    @Published private(set) var statusMessages: [EngineStatus] = []
    @Published private(set) var running = false

    @Published var micAuthorized = MicMeter.isAuthorized
    @Published var axTrusted = AccessibilityScanner.isTrusted
    @Published var screenAuthorized = CGPreflightScreenCaptureAccess()
    /// True once a permission was granted that only takes effect after a
    /// relaunch (Screen Recording and, usually, Accessibility). macOS does not
    /// expose a newly-granted permission to the already-running process.
    @Published private(set) var needsRelaunch = false

    private static let maxSessions = 500
    private static let maxStatus = 200

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
        }
    }

    private func handleTracker(_ event: TrackerEvent) {
        switch event {
        case let .start(platform, name, startTs):
            let key = "\(platform.rawValue)::\(name)"
            if !active.contains(where: { $0.id == key }) {
                active.append(ActiveSpeaker(platform: platform, name: name, startTs: startTs, durationMs: 0))
            }

        case let .tick(platform, name, startTs, durationMs):
            let key = "\(platform.rawValue)::\(name)"
            if let i = active.firstIndex(where: { $0.id == key }) {
                active[i].durationMs = durationMs
                active[i].startTs = startTs
            } else {
                active.append(ActiveSpeaker(platform: platform, name: name, startTs: startTs, durationMs: durationMs))
            }

        case let .end(platform, name, startTs, endTs, durationMs):
            let key = "\(platform.rawValue)::\(name)"
            active.removeAll { $0.id == key }
            sessions.insert(SessionRow(platform: platform, name: name,
                                       startTs: startTs, endTs: endTs, durationMs: durationMs),
                            at: 0)
            if sessions.count > Self.maxSessions {
                sessions.removeLast(sessions.count - Self.maxSessions)
            }
        }
    }
}
