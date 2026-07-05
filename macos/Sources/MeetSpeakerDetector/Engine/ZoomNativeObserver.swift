import Foundation
import AppKit
import ApplicationServices
import SpeakerCore
import AXKit

// ZoomNativeObserver — the GENUINELY event-driven tier for native Zoom (plan B2).
// Unlike the Chromium surfaces (Meet / Zoom web), where class flips are AX-silent
// and the diff is the only edge source, native Zoom (us.zoom.xos) is an AppKit app
// whose meeting lifecycle DOES post real AX notifications:
//  • AXTitleChanged        — meeting lifecycle via the window title
//    ("Zoom Meeting" ⇄ "Zoom Workplace"), and the PIP "Talking:" static-text value.
//  • AXWindowCreated       — meeting start / PIP appear (⌘⇧M minimize creates the PIP).
//  • AXUIElementDestroyed  — meeting end / PIP disappear.
// Each is a WAKE-UP: it forces the engine's next tick to do a bounded re-read
// rather than waiting out the poll interval. The roster/mute/PIP data still comes
// from the pure `zoomExtractWindow`/`zoomFuseWindows` extractors — this observer
// never parses; it only says "re-read now".
//
// DEFENSIVE MENU TIER (plan B2 caution): Zoom 7.0.5 showed NO persistent
// View/Meeting menus (`ZoomDrive menu --list`). So the menu tier is OPPORTUNISTIC:
// probe the menu bar at start; IF a "Meeting" menu with a Mute/Unmute Audio item
// is present, note it (a future self-mute read could subscribe it); if ABSENT,
// degrade gracefully to the AXTitleChanged / AXWindowCreated lifecycle tier + the
// existing panel/tile mute reads. EITHER way emit a `zoom_menu_probe` NDJSON note
// so the live report records the real menu state — never fabricate a menu signal.

/// Lifecycle / wake state emitted to the `zoom_observer` NDJSON line.
enum ZoomNativeObserverState: String {
    case started, resubscribed, dead, absent, stopped
}

/// Result of the one-shot menu-bar probe, surfaced as `zoom_menu_probe`.
struct ZoomMenuProbe: Equatable {
    /// A "Meeting" (or localized equivalent) top-level menu was found.
    var meetingMenuPresent: Bool
    /// A Mute/Unmute-Audio item was found under it (the self-mute anchor).
    var muteItemPresent: Bool
    /// The mute item's title when found (for the note; empty otherwise).
    var muteItemTitle: String
}

final class ZoomNativeObserver {

    // MARK: Config / dependencies

    private let coalesceMs: Int
    /// Top-level menu titles that could carry the Mute Audio item (English builtin;
    /// the rig probes live, so this is only the probe's search set).
    private let meetingMenuTitles = ["meeting"]
    private let muteItemMarkers = ["mute audio", "unmute audio"]

    /// Emitted on lifecycle transitions + wake-ups.
    var onLifecycle: ((ZoomNativeObserverState, Int) -> Void)?
    /// Emitted ONCE after the start-time menu probe.
    var onMenuProbe: ((ZoomMenuProbe) -> Void)?

    // MARK: Thread / run-loop

    private var thread: Thread?
    private var runLoop: CFRunLoop?
    private var stopping = false

    // MARK: AX subscription state (observer thread only)

    private var pid: pid_t = 0
    private var axApp: AXUIElement?
    private var observer: AXObserver?
    private var subscribedNodes: [AXUIElement] = []

    // MARK: Shared, lock-guarded wake flag (engine drains it per tick)

    private let lock = NSLock()
    private var wakePending = false
    private var wakeCount = 0

    init(coalesceMs: Int = 70) {
        self.coalesceMs = coalesceMs
    }

    // MARK: Public API (engine side)

    func start() {
        let t = Thread { [weak self] in self?.threadMain() }
        t.name = "msd.zoom-native-observer"
        t.stackSize = 1 << 20
        thread = t
        t.start()
    }

    /// True (and clears the flag) when an AX wake-up (title/window/destroy) arrived
    /// since the last drain — the engine then forces an immediate bounded re-read.
    func drainWake() -> Bool {
        lock.lock(); defer { lock.unlock() }
        let w = wakePending
        wakePending = false
        return w
    }

    /// Re-probe lifecycle on the reconcile cadence: re-subscribe if the observer
    /// died or the Zoom pid moved (relaunch), otherwise a no-op.
    func reconcile() {
        guard let rl = runLoop else { return }
        CFRunLoopPerformBlock(rl, CFRunLoopMode.commonModes.rawValue) { [weak self] in
            self?.reconcileOnThread()
        }
        CFRunLoopWakeUp(rl)
    }

    func stop() {
        guard let rl = runLoop else { stopping = true; return }
        CFRunLoopPerformBlock(rl, CFRunLoopMode.commonModes.rawValue) { [weak self] in
            self?.stopOnThread()
        }
        CFRunLoopWakeUp(rl)
    }

    // MARK: Observer thread

    private func threadMain() {
        runLoop = CFRunLoopGetCurrent()
        ZoomNativeObserver.register(self)
        subscribeOnThread(reason: .started)
        let keepAlive = CFRunLoopTimerCreateWithHandler(nil, CFAbsoluteTimeGetCurrent() + 3600, 3600, 0, 0) { _ in }
        CFRunLoopAddTimer(CFRunLoopGetCurrent(), keepAlive, .commonModes)
        while !stopping {
            CFRunLoopRunInMode(.defaultMode, 1.0, false)
        }
        ZoomNativeObserver.unregister(self)
    }

    private func stopOnThread() {
        stopping = true
        unsubscribeAll()
        onLifecycle?(.stopped, 0)
        if let rl = runLoop { CFRunLoopStop(rl) }
    }

    // MARK: Subscribe / unsubscribe

    private func subscribeOnThread(reason: ZoomNativeObserverState) {
        unsubscribeAll()

        let livePid = currentZoomPid()
        guard livePid != 0 else {
            onLifecycle?(.absent, 0)
            return
        }
        pid = livePid
        let app = AXUIElementCreateApplication(livePid)
        axApp = app

        var obs: AXObserver?
        guard AXObserverCreateWithInfoCallback(livePid, zoomNativeObserverCallback, &obs) == .success, let obs else {
            onLifecycle?(.dead, 0)
            return
        }
        observer = obs
        let refcon = Unmanaged.passUnretained(self).toOpaque()

        // App-level lifecycle notifications — the real event source for native Zoom.
        // AXWindowCreated / AXTitleChanged fire on the app element; per-window
        // AXUIElementDestroyed + AXTitleChanged catch the PIP appear/disappear and
        // its "Talking:" title moves.
        let appLevel = ["AXWindowCreated", "AXTitleChanged", "AXFocusedWindowChanged",
                        "AXUIElementDestroyed"]
        var count = 0
        for nm in appLevel where AXObserverAddNotification(obs, app, nm as CFString, refcon) == .success {
            count += 1
        }
        // Per-window title/destroy so a PIP that appears in its own window still wakes us.
        for window in AXKit.axArray(app, "AXWindows") {
            var hooked = false
            for nm in ["AXTitleChanged", "AXUIElementDestroyed"]
            where AXObserverAddNotification(obs, window, nm as CFString, refcon) == .success {
                hooked = true
            }
            if hooked { subscribedNodes.append(window) }
        }

        CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), .commonModes)
        onLifecycle?(reason == .started ? .started : .resubscribed, count + subscribedNodes.count)

        if reason == .started {
            let probe = probeMenu(app: app)
            onMenuProbe?(probe)
        }
    }

    private func unsubscribeAll() {
        if let obs = observer {
            if let app = axApp {
                for nm in ["AXWindowCreated", "AXTitleChanged", "AXFocusedWindowChanged",
                           "AXUIElementDestroyed"] {
                    AXObserverRemoveNotification(obs, app, nm as CFString)
                }
            }
            for node in subscribedNodes {
                for nm in ["AXTitleChanged", "AXUIElementDestroyed"] {
                    AXObserverRemoveNotification(obs, node, nm as CFString)
                }
            }
            if let rl = runLoop {
                CFRunLoopRemoveSource(rl, AXObserverGetRunLoopSource(obs), .commonModes)
            }
        }
        subscribedNodes.removeAll(keepingCapacity: true)
        observer = nil
        axApp = nil
    }

    // MARK: Defensive menu probe (B2 — subscribe only if present; note either way)

    /// One-shot menu-bar probe: is there a "Meeting" menu with a Mute/Unmute Audio
    /// item? Zoom 7.0.5 showed none, so this DEGRADES gracefully — the result is a
    /// note, not a hard requirement. Never fabricates a menu signal.
    private func probeMenu(app: AXUIElement) -> ZoomMenuProbe {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, "AXMenuBar" as CFString, &ref) == .success,
              let bar = ref, CFGetTypeID(bar as CFTypeRef) == AXUIElementGetTypeID() else {
            return ZoomMenuProbe(meetingMenuPresent: false, muteItemPresent: false, muteItemTitle: "")
        }
        let barEl = bar as! AXUIElement
        for top in AXKit.axArray(barEl, "AXChildren") {
            let title = (AXKit.axString(top, "AXTitle") ?? "").lowercased()
            guard meetingMenuTitles.contains(where: { title.contains($0) }) else { continue }
            // Menu-bar item → its single AXMenu child → the AXMenuItems.
            let items = AXKit.axArray(top, "AXChildren").flatMap { AXKit.axArray($0, "AXChildren") }
            for mi in items {
                let miTitle = (AXKit.axString(mi, "AXTitle") ?? "")
                if muteItemMarkers.contains(where: { miTitle.lowercased().contains($0) }) {
                    return ZoomMenuProbe(meetingMenuPresent: true, muteItemPresent: true,
                                         muteItemTitle: miTitle)
                }
            }
            return ZoomMenuProbe(meetingMenuPresent: true, muteItemPresent: false, muteItemTitle: "")
        }
        return ZoomMenuProbe(meetingMenuPresent: false, muteItemPresent: false, muteItemTitle: "")
    }

    // MARK: Coalesced wake (from the C callback, already on the observer thread)

    fileprivate func signalWake() {
        lock.lock(); wakePending = true; wakeCount += 1; lock.unlock()
        onLifecycle?(.resubscribed, subscribedNodes.count)   // cheap wake telemetry
    }

    // MARK: Reconcile (death / pid-move detection)

    private func reconcileOnThread() {
        guard !stopping else { return }
        let livePid = currentZoomPid()
        if observer == nil || livePid == 0 || livePid != pid {
            subscribeOnThread(reason: .resubscribed)
        }
    }

    // MARK: pid discovery

    private func currentZoomPid() -> pid_t {
        for app in NSWorkspace.shared.runningApplications {
            guard let bid = app.bundleIdentifier, !app.isTerminated else { continue }
            if bid == "us.zoom.xos" { return app.processIdentifier }
        }
        return 0
    }

    // MARK: refcon registry

    private enum Shared {
        static let lock = NSLock()
        static var byId: [ObjectIdentifier: ZoomNativeObserver] = [:]
    }
    private static func register(_ o: ZoomNativeObserver) {
        Shared.lock.lock(); Shared.byId[ObjectIdentifier(o)] = o; Shared.lock.unlock()
    }
    private static func unregister(_ o: ZoomNativeObserver) {
        Shared.lock.lock(); Shared.byId.removeValue(forKey: ObjectIdentifier(o)); Shared.lock.unlock()
    }
    fileprivate static func resolve(_ ptr: UnsafeMutableRawPointer) -> ZoomNativeObserver? {
        let o = Unmanaged<ZoomNativeObserver>.fromOpaque(ptr).takeUnretainedValue()
        Shared.lock.lock(); defer { Shared.lock.unlock() }
        return Shared.byId[ObjectIdentifier(o)] != nil ? o : nil
    }
}

// MARK: - C callback (captures nothing; instance via refcon)

private func zoomNativeObserverCallback(_ observer: AXObserver, _ element: AXUIElement,
                                        _ notif: CFString, _ info: CFDictionary,
                                        _ refcon: UnsafeMutableRawPointer?) {
    guard let refcon, let instance = ZoomNativeObserver.resolve(refcon) else { return }
    instance.signalWake()
}
