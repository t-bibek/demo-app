import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import SpeakerCore
import AXKit

// ZoomWebTileObserver — the event-driven half of the Zoom WEB detector (plan A3),
// a direct port of MeetTileObserver. Zoom web is a Chromium tab, so — exactly like
// Meet — the active-speaker class flip (`…__video-frame--active`) posts NO AX
// notification (.claude/CHROMIUM-AX-NOTIFICATIONS.md). Therefore the PRIMARY edge
// source is a fast bounded tile-subtree re-read every poll tick, diffed via
// `zoomWebEdgesFromDiff`; the AXObserver only supplies opportunistic wake-ups
// (destroy / title / focus) that collapse into ONE bounded re-read.
//
// Same thread / refcon / lifecycle architecture as MeetTileObserver:
//  • A dedicated Thread + CFRunLoop (AX callbacks arrive on the creating thread's
//    run loop; the engine's queue has none).
//  • The C callback captures NOTHING; the instance is threaded via `refcon`, with a
//    strong ref held in the shared registry for the callback's lifetime.
//  • Subscriptions capped so a huge tree can't explode the hook count.
//  • Reconcile sweep (4s): bounded re-read + missed-edge synthesis + conditional
//    re-subscribe / death detection / background-tab handling.
//
// STALE-SELECTOR FORENSICS (plan A3): when the call gate says in-call but ZERO
// tiles match any selector family, emit ONE rate-limited `zoomweb_selector_dump`
// with per-selector presence counts + candidate tile class chains — a rotation is
// diagnosable, not a silent null.

/// Live counters the engine folds into the `zoomweb_walk_stats` NDJSON line.
struct ZoomWebObserverStats: Equatable {
    var subtreeReads = 0        // bounded subtree re-reads (coalesced refresh + reconcile)
    var edges = 0              // active-moved edges emitted
    var reconcileRepairs = 0   // edges synthesized by the reconcile sweep (missed by the observer)
    var subscribedNodes = 0    // per-node hooks currently registered
    var restarts = 0           // full observer restarts (observer death / pid change)
}

/// Lifecycle state emitted to the `zoomweb_observer` NDJSON line.
enum ZoomWebObserverState: String {
    case started, resubscribed, dead, backgroundTab = "background_tab", stopped
}

/// One stale-selector forensic dump the engine emits as `zoomweb_selector_dump`.
struct ZoomWebSelectorDump: Equatable {
    var selectorCounts: [String: Int]
    var candidateClassChains: [[String]]
}

final class ZoomWebTileObserver {

    // MARK: Config / dependencies

    private let scanner: AccessibilityScanner
    private let coalesceMs: Int
    private let repeatSuppressMs = 150
    private let maxSubscribedNodes = 64
    /// Stale-selector dump rate limit (ms) — one diagnostic line, not a flood.
    private let selectorDumpMinIntervalMs = 10_000

    /// Emitted on lifecycle transitions (started/resubscribed/dead/background_tab/stopped).
    var onLifecycle: ((ZoomWebObserverState, Int) -> Void)?   // (state, subscribedNodes)
    /// Emitted (rate-limited) when in-call but no tile matched any selector family.
    var onSelectorDump: ((ZoomWebSelectorDump) -> Void)?

    /// The engine sets this each tick so the bounded read can resolve self at BUILD
    /// level (a self-active tile never becomes an edge holder — INV-15).
    private let selfNameLock = NSLock()
    private var selfName: String?
    func setSelfName(_ name: String?) {
        selfNameLock.lock(); selfName = name; selfNameLock.unlock()
    }
    private func currentSelfName() -> String? {
        selfNameLock.lock(); defer { selfNameLock.unlock() }
        return selfName
    }

    // MARK: Thread / run-loop

    private var thread: Thread?
    private var runLoop: CFRunLoop?
    private var stopping = false

    // MARK: AX subscription state (touched only on the observer thread)

    private var pid: pid_t = 0
    private var axApp: AXUIElement?
    private var observer: AXObserver?
    private var subscribedNodes: [AXUIElement] = []
    private var coalesceTimer: CFRunLoopTimer?
    private var destroyedSinceReconcile = false
    private var subscribedTileNames: Set<String> = []
    private var lastReadTileNames: Set<String> = []
    private var lastSelectorDumpMs = 0

    // MARK: Shared, lock-guarded results (engine reads via drain/current)

    private let lock = NSLock()
    private var pendingEdges: [ZoomWebEdgeEvent] = []
    private var latestSnapshot: ZoomWebTileSnapshot?
    private var lastSnapshot: ZoomWebTileSnapshot?         // diff origin (observer thread only)
    private var lastEmitByName: [String: Int] = [:]        // repeat-`to` suppression (observer thread)
    private var stats = ZoomWebObserverStats()

    init(scanner: AccessibilityScanner, coalesceMs: Int = 70) {
        self.scanner = scanner
        self.coalesceMs = coalesceMs
    }

    // MARK: Public API (engine side)

    func start() {
        let t = Thread { [weak self] in self?.threadMain() }
        t.name = "msd.zoomweb-observer"
        t.stackSize = 1 << 20
        thread = t
        t.start()
    }

    /// Drain and clear the edges accumulated since the last call (engine, per tick).
    func drainEdges() -> [ZoomWebEdgeEvent] {
        lock.lock(); defer { lock.unlock() }
        let out = pendingEdges
        pendingEdges.removeAll(keepingCapacity: true)
        return out
    }

    /// The most recent bounded snapshot (engine attributes from this in event mode).
    /// nil ⇒ no live read yet / backgrounded tab.
    func currentSnapshot() -> ZoomWebTileSnapshot? {
        lock.lock(); defer { lock.unlock() }
        return latestSnapshot
    }

    /// Copy of the live counters (engine folds them into `zoomweb_walk_stats`).
    func snapshotStats() -> ZoomWebObserverStats {
        lock.lock(); defer { lock.unlock() }
        return stats
    }

    /// Fast bounded re-read (engine, every poll tick — the PRIMARY edge source).
    func pollRefresh() {
        guard let rl = runLoop else { return }
        CFRunLoopPerformBlock(rl, CFRunLoopMode.commonModes.rawValue) { [weak self] in
            self?.refreshOnThread(isReconcile: false)
        }
        CFRunLoopWakeUp(rl)
    }

    /// Reconciliation sweep (engine, every `reconcileEveryMs`).
    func reconcile() {
        guard let rl = runLoop else { return }
        CFRunLoopPerformBlock(rl, CFRunLoopMode.commonModes.rawValue) { [weak self] in
            self?.reconcileOnThread()
        }
        CFRunLoopWakeUp(rl)
    }

    /// Tear down: stop the run loop + thread, unsubscribe, emit `stopped`.
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
        ZoomWebTileObserver.register(self)
        subscribeOnThread(reason: .started)
        let keepAlive = CFRunLoopTimerCreateWithHandler(nil, CFAbsoluteTimeGetCurrent() + 3600, 3600, 0, 0) { _ in }
        CFRunLoopAddTimer(CFRunLoopGetCurrent(), keepAlive, .commonModes)
        while !stopping {
            CFRunLoopRunInMode(.defaultMode, 1.0, false)
        }
        ZoomWebTileObserver.unregister(self)
    }

    private func stopOnThread() {
        stopping = true
        unsubscribeAll()
        onLifecycle?(.stopped, 0)
        if let rl = runLoop { CFRunLoopStop(rl) }
    }

    // MARK: Subscribe / unsubscribe

    private enum SubscribeReason { case started, resubscribed }

    private func subscribeOnThread(reason: SubscribeReason) {
        unsubscribeAll()

        guard let els = scanner.zoomWebElements(pid: currentZoomWebPid()) else {
            setSnapshot(nil)
            onLifecycle?(.backgroundTab, 0)
            return
        }
        pid = pidForElement(els.app)
        axApp = els.app

        var obs: AXObserver?
        guard AXObserverCreateWithInfoCallback(pid, zoomWebObserverCallback, &obs) == .success, let obs else {
            onLifecycle?(.dead, 0)
            return
        }
        observer = obs
        let refcon = Unmanaged.passUnretained(self).toOpaque()

        // App-level wake-ups (cheap): focus / layout / live-region / selection moves.
        let appLevel = ["AXFocusedUIElementChanged", "AXLayoutChanged",
                        "AXLiveRegionChanged", "AXSelectedChildrenChanged"]
        for nm in appLevel { AXObserverAddNotification(obs, els.app, nm as CFString, refcon) }

        // Per-tile wake-ups: value / destroy / layout on each tile-shaped node.
        var count = 0
        let perNode = ["AXValueChanged", "AXUIElementDestroyed", "AXLayoutChanged"]
        for node in subscribableNodes(window: els.window, cap: maxSubscribedNodes) {
            var hooked = false
            for nm in perNode where AXObserverAddNotification(obs, node, nm as CFString, refcon) == .success {
                hooked = true
            }
            if hooked { subscribedNodes.append(node); count += 1 }
            if count >= maxSubscribedNodes { break }
        }

        CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), .commonModes)
        destroyedSinceReconcile = false
        setStats { $0.subscribedNodes = count }
        onLifecycle?(reason == .started ? .started : .resubscribed, count)

        if reason == .started {
            refreshOnThread(isReconcile: false)
            subscribedTileNames = lastReadTileNames
        }
    }

    private func unsubscribeAll() {
        if let obs = observer {
            if let app = axApp {
                for nm in ["AXFocusedUIElementChanged", "AXLayoutChanged",
                           "AXLiveRegionChanged", "AXSelectedChildrenChanged"] {
                    AXObserverRemoveNotification(obs, app, nm as CFString)
                }
            }
            for node in subscribedNodes {
                for nm in ["AXValueChanged", "AXUIElementDestroyed", "AXLayoutChanged"] {
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

    /// Collect tile-sized group nodes under the window to subscribe. A bounded BFS
    /// so a pathological tree can't blow the walk; at most `cap` nodes.
    private func subscribableNodes(window: AXUIElement, cap: Int) -> [AXUIElement] {
        var out: [AXUIElement] = []
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if out.count >= cap || n >= 4000 || d > 60 { return }
            n += 1
            if let f = AXKit.axFrame(el) {
                let area = f.width * f.height
                if area >= 8_000 && area <= 1_800_000 { out.append(el) }
            }
            for c in AXKit.axArray(el, "AXChildren") { rec(c, d + 1); if out.count >= cap { return } }
        }
        rec(window, 0)
        return out
    }

    // MARK: Coalescing + refresh

    fileprivate func signalPending(destroyed: Bool) {
        if destroyed { destroyedSinceReconcile = true }
        guard !stopping, let rl = runLoop else { return }
        if let existing = coalesceTimer { CFRunLoopTimerInvalidate(existing) }
        let fireAt = CFAbsoluteTimeGetCurrent() + Double(coalesceMs) / 1000.0
        let timer = CFRunLoopTimerCreateWithHandler(nil, fireAt, 0, 0, 0) { [weak self] _ in
            self?.refreshOnThread(isReconcile: false)
        }
        coalesceTimer = timer
        CFRunLoopAddTimer(rl, timer, .commonModes)
    }

    /// One bounded subtree re-read → snapshot diff → edges. Runs on the observer thread.
    @discardableResult
    private func refreshOnThread(isReconcile: Bool, activate: Bool = false) -> Bool {
        coalesceTimer = nil
        if activate { AXKit.forceActivateForCapture(pid: pid) }

        guard let scan = scanner.zoomWebTileScan(pid: pid, selfName: currentSelfName()) else {
            setSnapshot(nil)
            lastReadTileNames = []
            onLifecycle?(.backgroundTab, currentSubscribedNodes())
            return false
        }
        guard scan.callActive else {
            setSnapshot(nil)
            lastReadTileNames = []
            onLifecycle?(.backgroundTab, currentSubscribedNodes())
            return false
        }

        // Stale-selector forensics: in-call but ZERO tiles matched any family →
        // ONE rate-limited dump so a class rotation is diagnosable, not silent.
        if scan.tiles.isEmpty {
            let now = AXKit.monotonicMs()
            if now - lastSelectorDumpMs >= selectorDumpMinIntervalMs {
                lastSelectorDumpMs = now
                onSelectorDump?(ZoomWebSelectorDump(
                    selectorCounts: scan.selectorCounts,
                    candidateClassChains: scan.candidateClassChains))
            }
        }

        lastReadTileNames = Set(scan.tiles.map { $0.name })
        let next = ZoomWebTileSnapshot.from(tiles: scan.tiles)
        let now = AXKit.monotonicMs()
        var edges = zoomWebEdgesFromDiff(prev: lastSnapshot, next: next, at: now)
        edges = edges.filter { e in
            if let last = lastEmitByName[e.to], now - last < repeatSuppressMs { return false }
            lastEmitByName[e.to] = now
            return true
        }
        lastSnapshot = next
        setStats {
            $0.subtreeReads += 1
            $0.edges += edges.count
            if isReconcile { $0.reconcileRepairs += edges.count }
        }
        appendEdges(edges, snapshot: next)
        return true
    }

    // MARK: Reconcile

    private func reconcileOnThread() {
        guard !stopping else { return }
        var needResubscribe = destroyedSinceReconcile || observer == nil
        if needResubscribe {
            let livePid = currentZoomWebPid()
            if observer == nil || livePid == 0 || livePid != pid {
                setStats { $0.restarts += 1 }
            }
        }

        let live = refreshOnThread(isReconcile: true, activate: false)
        if !live {
            let liveAfterActivate = refreshOnThread(isReconcile: true, activate: true)
            if !liveAfterActivate && !needResubscribe {
                let livePid = currentZoomWebPid()
                if observer == nil || livePid == 0 || livePid != pid {
                    setStats { $0.restarts += 1 }
                }
            }
            needResubscribe = true
        } else if lastReadTileNames != subscribedTileNames {
            needResubscribe = true
        }

        destroyedSinceReconcile = false
        guard needResubscribe else {
            subscribedTileNames = lastReadTileNames
            return
        }
        subscribeOnThread(reason: .resubscribed)
        subscribedTileNames = lastReadTileNames
    }

    // MARK: Shared-state helpers (take the lock)

    private func appendEdges(_ edges: [ZoomWebEdgeEvent], snapshot: ZoomWebTileSnapshot) {
        lock.lock()
        pendingEdges.append(contentsOf: edges)
        latestSnapshot = snapshot
        lock.unlock()
    }

    private func setSnapshot(_ s: ZoomWebTileSnapshot?) {
        lock.lock(); latestSnapshot = s; lock.unlock()
        if s == nil { lastSnapshot = nil }
    }

    private func setStats(_ mutate: (inout ZoomWebObserverStats) -> Void) {
        lock.lock(); mutate(&stats); lock.unlock()
    }

    private func currentSubscribedNodes() -> Int {
        lock.lock(); defer { lock.unlock() }
        return stats.subscribedNodes
    }

    // MARK: pid discovery

    /// The pid of a Chrome-family process currently hosting a Zoom-web window. 0
    /// when none is visible.
    private func currentZoomWebPid() -> pid_t {
        for app in NSWorkspace.shared.runningApplications {
            guard let bid = app.bundleIdentifier, !app.isTerminated else { continue }
            let isBrowser = bid.hasPrefix("com.google.Chrome") || bid.contains(".app.")
                || bid == "com.microsoft.edgemac" || bid == "com.brave.Browser"
                || bid == "company.thebrowser.Browser"
            guard isBrowser else { continue }
            if scanner.zoomWebElements(pid: app.processIdentifier) != nil {
                return app.processIdentifier
            }
        }
        return 0
    }

    private func pidForElement(_ app: AXUIElement) -> pid_t {
        var p: pid_t = 0
        AXUIElementGetPid(app, &p)
        return p
    }

    // MARK: refcon registry (keeps a strong ref for the C callback's lifetime)

    private enum Shared {
        static let lock = NSLock()
        static var byId: [ObjectIdentifier: ZoomWebTileObserver] = [:]
    }
    private static func register(_ o: ZoomWebTileObserver) {
        Shared.lock.lock(); Shared.byId[ObjectIdentifier(o)] = o; Shared.lock.unlock()
    }
    private static func unregister(_ o: ZoomWebTileObserver) {
        Shared.lock.lock(); Shared.byId.removeValue(forKey: ObjectIdentifier(o)); Shared.lock.unlock()
    }
    fileprivate static func resolve(_ ptr: UnsafeMutableRawPointer) -> ZoomWebTileObserver? {
        let o = Unmanaged<ZoomWebTileObserver>.fromOpaque(ptr).takeUnretainedValue()
        Shared.lock.lock(); defer { Shared.lock.unlock() }
        return Shared.byId[ObjectIdentifier(o)] != nil ? o : nil
    }
}

// MARK: - C callback (captures nothing; instance via refcon)

private func zoomWebObserverCallback(_ observer: AXObserver, _ element: AXUIElement,
                                     _ notif: CFString, _ info: CFDictionary,
                                     _ refcon: UnsafeMutableRawPointer?) {
    guard let refcon, let instance = ZoomWebTileObserver.resolve(refcon) else { return }
    let destroyed = (notif as String) == "AXUIElementDestroyed"
    instance.signalPending(destroyed: destroyed)
}
