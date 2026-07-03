import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import SpeakerCore
import AXKit

// MeetTileObserver — the event-driven half of the Meet detector (plan step 5).
//
// Instead of a full AX-tree walk every 500ms tick, this subscribes AXObserver
// notifications on the Meet stage (app-level focus/layout/selection + per-tile
// value/destroy) on a DEDICATED CFRunLoop thread, coalesces the resulting
// notification storms into ONE bounded subtree re-read (~70ms debounce), diffs the
// snapshot, and emits `ring-moved`/`focus-moved`/`equalizer-onset` edges. The engine
// drains those edges each tick and feeds them to `TransitionConfidence`.
//
// HARD CONSTRAINTS (verified in code/docs):
//  • AXObserver callbacks arrive on the run loop of the creating thread → this owns a
//    dedicated `Thread` + `CFRunLoop` (DetectionEngine's queue has no run loop).
//  • The C callback captures NOTHING; the observer instance is threaded through
//    `refcon` via `Unmanaged.passUnretained` (a STRONG ref is held in `Shared.instances`
//    for the callback's lifetime — refcon lifetime risk, plan "Implementation risks").
//  • Chrome AX needs AXEnhancedUserInterface + AXManualAccessibility (AXKit.forceFullAXTree)
//    and frontmost materialization; a backgrounded tab kills AX → the reconcile sweep is
//    the mandatory backstop (handoff §5).
//  • Subscriptions capped ≤64 nodes so a huge tree can't explode the hook count.
//
// Equalizer-anchor nodes ARE subscribed (handoff correction 1): the host's own meter
// is NOT nested under a tile, so `meetStageSubtreeScan` attributes it by geometry; the
// observer subscribes those anchor nodes for AXValueChanged so a level-class flip wakes
// the coalescer, and anchors on absence-of-gjg47c (never a specific level token).

/// Live counters the engine folds into the `meet_walk_stats` NDJSON line.
struct MeetObserverStats: Equatable {
    var subtreeReads = 0        // bounded subtree re-reads (coalesced refresh + reconcile)
    var edges = 0              // edges emitted (all kinds)
    var reconcileRepairs = 0   // edges synthesized by the reconcile sweep (missed by the observer)
    var subscribedNodes = 0    // per-node hooks currently registered
    var restarts = 0           // full observer restarts (observer death / pid change)
}

/// Lifecycle state emitted to the `meet_observer` NDJSON line.
enum MeetObserverState: String {
    case started, resubscribed, dead, backgroundTab = "background_tab", stopped
}

final class MeetTileObserver {

    // MARK: Config / dependencies

    private let scanner: AccessibilityScanner
    private let coalesceMs: Int
    private let repeatSuppressMs = 150
    private let maxSubscribedNodes = 64

    /// Emitted on lifecycle transitions (started/resubscribed/dead/background_tab/stopped).
    var onLifecycle: ((MeetObserverState, Int) -> Void)?   // (state, subscribedNodes)

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
    // Re-subscription is EXPENSIVE (unhook + BFS re-walk of the stage + re-hook up to
    // 64×3 AX notifications) and was the measured reconcile-tick CPU spike (4s-period
    // alternation in the CPU-compare samples). It's only load-bearing when the tile set
    // Meet exposes actually CHANGED — a layout switch destroys/recreates tile nodes, and
    // node REMOVAL is the ONE thing Chromium reliably notifies (AXUIElementDestroyed;
    // see .claude/CHROMIUM-AX-NOTIFICATIONS.md). So the C callback flags a destroy, and
    // reconcile re-walks ONLY when a destroy was seen OR the observer died / pid moved OR
    // the snapshot's tile-name set drifted from what we subscribed. A steady call re-uses
    // the existing hooks (they're still valid) and just does the cheap bounded read.
    private var destroyedSinceReconcile = false     // an AXUIElementDestroyed arrived (observer thread)
    private var subscribedTileNames: Set<String> = []  // tile names covered by current hooks (observer thread)
    private var lastReadTileNames: Set<String> = []    // tile names from the most recent bounded read

    // MARK: Shared, lock-guarded results (engine reads via drain/current)

    private let lock = NSLock()
    private var pendingEdges: [MeetEdgeEvent] = []
    private var latestSnapshot: MeetTileSnapshot?
    private var lastSnapshot: MeetTileSnapshot?         // diff origin (observer thread only)
    private var lastEmitByName: [String: Int] = [:]     // repeat-`to` suppression (observer thread)
    private var stats = MeetObserverStats()

    init(scanner: AccessibilityScanner, coalesceMs: Int = 70) {
        self.scanner = scanner
        self.coalesceMs = coalesceMs
    }

    // MARK: Public API (engine side)

    /// Start the observer thread + subscribe. Non-blocking; subscription happens on
    /// the dedicated thread. Returns immediately.
    func start() {
        let t = Thread { [weak self] in self?.threadMain() }
        t.name = "msd.meet-observer"
        t.stackSize = 1 << 20
        thread = t
        t.start()
    }

    /// Drain and clear the edges accumulated since the last call (engine, per tick).
    func drainEdges() -> [MeetEdgeEvent] {
        lock.lock(); defer { lock.unlock() }
        let out = pendingEdges
        pendingEdges.removeAll(keepingCapacity: true)
        return out
    }

    /// The most recent bounded snapshot (engine attributes from this in event mode).
    /// nil ⇒ no live read yet / backgrounded tab (engine falls back to VAD-only floor).
    func currentSnapshot() -> MeetTileSnapshot? {
        lock.lock(); defer { lock.unlock() }
        return latestSnapshot
    }

    /// Copy of the live counters (engine folds them into `meet_walk_stats`).
    func snapshotStats() -> MeetObserverStats {
        lock.lock(); defer { lock.unlock() }
        return stats
    }

    /// Fast bounded re-read (engine, every poll tick — the PRIMARY edge source per the
    /// plan). Class-token (ring) changes post NO AX notification (Chromium marks them
    /// dirty-only), so the observer's notification-driven refresh can miss a pure ring
    /// move until some UNRELATED notification happens to wake the coalescer — up to the
    /// 4s reconcile in the worst case, which blows the 800ms edge-latency bar. A cheap
    /// ~500ms-cadence bounded subtree re-read (NO activation — that's reconcile-only)
    /// diffs the snapshot and catches ring/focus/equalizer moves within one tick, keeping
    /// edge latency well under the QA bar. Idempotent + coalesced with notification wakes:
    /// the diff origin (`lastSnapshot`) means a redundant read on an unchanged tree emits
    /// no edges and adds no work beyond one bounded read.
    func pollRefresh() {
        guard let rl = runLoop else { return }
        CFRunLoopPerformBlock(rl, CFRunLoopMode.commonModes.rawValue) { [weak self] in
            self?.refreshOnThread(isReconcile: false)
        }
        CFRunLoopWakeUp(rl)
    }

    /// Reconciliation sweep (engine, every `reconcileEveryMs`): a bounded subtree
    /// re-scan that (a) repairs edges the observer missed, (b) detects observer death /
    /// pid change and re-subscribes recreated tiles / restarts the observer, and (c)
    /// handles a backgrounded tab (clear the snapshot, DON'T thrash restarts). Runs on
    /// the observer thread so it shares AX subscription state without a data race.
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
        MeetTileObserver.register(self)
        subscribeOnThread(reason: .started)
        // Keep the run loop alive even with no sources yet (a bare run loop returns
        // immediately). A repeating no-op timer holds it open; real work is driven by
        // AX notifications + engine-posted blocks (reconcile/stop).
        let keepAlive = CFRunLoopTimerCreateWithHandler(nil, CFAbsoluteTimeGetCurrent() + 3600, 3600, 0, 0) { _ in }
        CFRunLoopAddTimer(CFRunLoopGetCurrent(), keepAlive, .commonModes)
        while !stopping {
            CFRunLoopRunInMode(.defaultMode, 1.0, false)
        }
        MeetTileObserver.unregister(self)
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

        guard let els = scanner.meetStageElements(pid: currentMeetPid()) else {
            // No Meet window right now — nothing to observe. The engine's reconcile
            // sweep will retry; report background/no-tab so telemetry shows it.
            setSnapshot(nil)
            onLifecycle?(.backgroundTab, 0)
            return
        }
        pid = pidForElement(els.app)
        axApp = els.app

        var obs: AXObserver?
        guard AXObserverCreateWithInfoCallback(pid, meetObserverCallback, &obs) == .success, let obs else {
            onLifecycle?(.dead, 0)
            return
        }
        observer = obs
        let refcon = Unmanaged.passUnretained(self).toOpaque()

        // App-level: focus / layout / live-region / selection moves (cheap; the plan's
        // ask includes focus-moved edges even though AXFocused is not elevated).
        let appLevel = ["AXFocusedUIElementChanged", "AXLayoutChanged",
                        "AXLiveRegionChanged", "AXSelectedChildrenChanged"]
        for nm in appLevel { AXObserverAddNotification(obs, els.app, nm as CFString, refcon) }

        // Per-tile + equalizer-anchor: value / destroy / layout on each subscribable
        // node, capped at `maxSubscribedNodes`. Equalizer-anchor nodes are included so a
        // level-class flip (silent↔speaking) wakes the coalescer.
        var count = 0
        let perNode = ["AXValueChanged", "AXUIElementDestroyed", "AXLayoutChanged"]
        for node in subscribableNodes(stage: els.stage, cap: maxSubscribedNodes) {
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

        // Prime the snapshot on FIRST start only, so the first engine tick has a
        // snapshot. On a resubscribe (reconcile) the caller already did its bounded read
        // (top of the sweep) — priming here too would double-read. The priming read sets
        // `lastReadTileNames`; adopt it as the subscribed set so the first reconcile
        // doesn't see spurious drift against an empty set and re-subscribe needlessly.
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

    /// Collect the tiles + equalizer-anchor nodes under the stage to subscribe. A
    /// bounded BFS so a pathological tree can't blow the walk; returns at most `cap`
    /// nodes (tiles preferred first, then any equalizer-anchor nodes encountered).
    private func subscribableNodes(stage: AXUIElement, cap: Int) -> [AXUIElement] {
        var out: [AXUIElement] = []
        var n = 0
        let rules = MeetSpeakerRules.resolved()
        func rec(_ el: AXUIElement, _ d: Int) {
            if out.count >= cap || n >= 4000 || d > 40 { return }
            n += 1
            // A tile-sized group OR an equalizer-anchor node is worth a hook.
            let cl = Set(AXKit.axClassList(el))
            let isAnchor = rules.equalizerAnchorClasses.contains { cl.contains($0) }
            if isAnchor {
                out.append(el)
            } else if let f = AXKit.axFrame(el) {
                let area = f.width * f.height
                if area >= 8_000 && area <= 1_800_000 { out.append(el) }
            }
            for c in AXKit.axArray(el, "AXChildren") { rec(c, d + 1); if out.count >= cap { return } }
        }
        rec(stage, 0)
        return out
    }

    // MARK: Coalescing + refresh

    /// Called from the C callback (already on the observer thread): (re)arm the
    /// ~coalesceMs debounce so a notification storm collapses into one refresh.
    /// `destroyed` = the notification was AXUIElementDestroyed (a tile node teardown —
    /// the one reliable "the tile set changed, re-subscribe" signal); it flags the next
    /// reconcile to do the expensive BFS re-walk rather than re-hooking blindly.
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
    /// `activate` force-activates the pid BEFORE the read (needed only when the tree is
    /// stale/empty — Chrome only materializes the live equalizer/ring state while
    /// frontmost). It's OFF for the per-tick coalesced/poll refreshes (activating every
    /// 500ms is the known UX blocker AND a per-tick CPU tax); the reconcile sweep decides
    /// whether to pass it based on whether the previous read came back live.
    @discardableResult
    private func refreshOnThread(isReconcile: Bool, activate: Bool = false) -> Bool {
        coalesceTimer = nil
        if activate { AXKit.forceActivateForCapture(pid: pid) }

        guard let scan = scanner.meetStageSubtreeScan(pid: pid) else {
            // Read failed — Meet window gone or backgrounded. Clear the snapshot so the
            // engine falls back to the VAD floor rather than a stale name.
            setSnapshot(nil)
            lastReadTileNames = []
            onLifecycle?(.backgroundTab, currentSubscribedNodes())
            return false
        }
        guard scan.callActive else {
            // Landing / post-call / background: not in a call. Clear + report.
            setSnapshot(nil)
            lastReadTileNames = []
            onLifecycle?(.backgroundTab, currentSubscribedNodes())
            return false
        }

        lastReadTileNames = Set(scan.tiles.map { $0.name })
        let next = MeetTileSnapshot.from(tiles: scan.tiles)
        let now = AXKit.monotonicMs()
        var edges = meetEdgesFromDiff(prev: lastSnapshot, next: next, at: now)
        // Suppress a repeat edge to the SAME `to` within `repeatSuppressMs` (a
        // level-flicker or re-layout must not re-spike the same holder every 70ms).
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
        // Detect genuine observer-death / pid-move (Chrome relaunch / tab moved to
        // another window). currentMeetPid() walks the running browsers — do it ONCE and
        // only when we might actually need to restart (observer already nil, or a destroy
        // was seen), NOT unconditionally: it's an NSWorkspace + per-browser window walk,
        // and paying it every 4s for a steady, healthy call was pure overhead.
        var needResubscribe = destroyedSinceReconcile || observer == nil
        if needResubscribe {
            let livePid = currentMeetPid()
            if observer == nil || livePid == 0 || livePid != pid {
                setStats { $0.restarts += 1 }
            }
        }

        // Bounded read FIRST, WITHOUT activation — a healthy, frontmost-enough call
        // materializes fine and this is the same cheap read the per-tick poll does. Only
        // if it came back empty/stale (backgrounded / occluded tab) do we retry WITH
        // activation to force materialization. This is the load-bearing change: the old
        // reconcile force-activated + re-subscribed EVERY 4s regardless, which was the
        // measured 4s-period CPU spike in the cpu-compare samples.
        let live = refreshOnThread(isReconcile: true, activate: false)
        if !live {
            // Stale/empty read even after this sweep would re-materialize: a backgrounded
            // tab, a dead observer, or a pid move. Retry WITH activation to force
            // materialization; if it STILL doesn't come back live, the observer/pid state
            // genuinely moved → count a restart (unless we already did above) and
            // re-subscribe against the freshly-woken tree.
            let liveAfterActivate = refreshOnThread(isReconcile: true, activate: true)
            if !liveAfterActivate && !needResubscribe {
                let livePid = currentMeetPid()
                if observer == nil || livePid == 0 || livePid != pid {
                    setStats { $0.restarts += 1 }
                }
            }
            needResubscribe = true
        } else if lastReadTileNames != subscribedTileNames {
            // The tile roster drifted (a name joined/left ⇒ tiles were recreated ⇒ our
            // per-node hooks point at torn-down elements). Re-subscribe to re-hook the
            // live nodes. A steady call keeps the same set and skips the BFS re-walk.
            needResubscribe = true
        }

        // Re-subscribe (unhook + BFS re-walk + re-hook up to 64×3 notifications) ONLY
        // when actually needed — observer death, pid move, a seen destroy, a stale read,
        // or roster drift. In a steady call the existing hooks stay valid, so we keep them
        // and this whole expensive block is skipped, collapsing the reconcile spike into
        // one cheap bounded read.
        destroyedSinceReconcile = false
        guard needResubscribe else {
            subscribedTileNames = lastReadTileNames
            return
        }
        subscribeOnThread(reason: .resubscribed)
        // The bounded read at the top of this sweep already produced the current snapshot
        // + edges; re-subscribing only re-hooks nodes, it doesn't change the tree content,
        // so there's no need for a second read here (the old code's redundant reconcile
        // read is what doubled the sweep's cost on top of the unconditional re-subscribe).
        subscribedTileNames = lastReadTileNames
    }

    // MARK: Shared-state helpers (take the lock)

    private func appendEdges(_ edges: [MeetEdgeEvent], snapshot: MeetTileSnapshot) {
        lock.lock()
        pendingEdges.append(contentsOf: edges)
        latestSnapshot = snapshot
        lock.unlock()
    }

    private func setSnapshot(_ s: MeetTileSnapshot?) {
        lock.lock(); latestSnapshot = s; lock.unlock()
        // Reset the diff origin so a re-appear emits fresh edges.
        if s == nil { lastSnapshot = nil }
    }

    private func setStats(_ mutate: (inout MeetObserverStats) -> Void) {
        lock.lock(); mutate(&stats); lock.unlock()
    }

    private func currentSubscribedNodes() -> Int {
        lock.lock(); defer { lock.unlock() }
        return stats.subscribedNodes
    }

    // MARK: pid discovery

    /// The pid of a Chrome-family process currently hosting a Meet window. 0 when none
    /// is visible. Cheap NSWorkspace lookup; the actual Meet-window check is inside the
    /// scanner (which walks that pid's AXWindows).
    private func currentMeetPid() -> pid_t {
        for app in NSWorkspace.shared.runningApplications {
            guard let bid = app.bundleIdentifier, !app.isTerminated else { continue }
            let isBrowser = bid.hasPrefix("com.google.Chrome") || bid.contains(".app.")
                || bid == "com.microsoft.edgemac" || bid == "com.brave.Browser"
                || bid == "company.thebrowser.Browser"
            guard isBrowser else { continue }
            if scanner.meetStageElements(pid: app.processIdentifier) != nil {
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
        static var instances: Set<ObjectIdentifier> = []
        static var byId: [ObjectIdentifier: MeetTileObserver] = [:]
    }
    private static func register(_ o: MeetTileObserver) {
        Shared.lock.lock(); Shared.byId[ObjectIdentifier(o)] = o; Shared.lock.unlock()
    }
    private static func unregister(_ o: MeetTileObserver) {
        Shared.lock.lock(); Shared.byId.removeValue(forKey: ObjectIdentifier(o)); Shared.lock.unlock()
    }
    /// Recover the instance from the refcon pointer, guarding against a stale pointer
    /// (a callback that outlives its observer): only dispatch if the instance is still
    /// registered.
    fileprivate static func resolve(_ ptr: UnsafeMutableRawPointer) -> MeetTileObserver? {
        let o = Unmanaged<MeetTileObserver>.fromOpaque(ptr).takeUnretainedValue()
        Shared.lock.lock(); defer { Shared.lock.unlock() }
        return Shared.byId[ObjectIdentifier(o)] != nil ? o : nil
    }
}

// MARK: - C callback (captures nothing; instance via refcon)

/// AXObserver info callback — C-compatible (a global func capturing nothing). The
/// observer instance is recovered from `refcon`; it only ENQUEUES a coalesced refresh
/// (never reads the tree here — the coalescer debounces storms into one bounded read).
private func meetObserverCallback(_ observer: AXObserver, _ element: AXUIElement,
                                  _ notif: CFString, _ info: CFDictionary,
                                  _ refcon: UnsafeMutableRawPointer?) {
    guard let refcon, let instance = MeetTileObserver.resolve(refcon) else { return }
    let destroyed = (notif as String) == "AXUIElementDestroyed"
    instance.signalPending(destroyed: destroyed)
}
