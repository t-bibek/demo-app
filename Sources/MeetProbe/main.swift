import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import SpeakerCore

// MeetProbe — per-tile speaker probe for Meet / Zoom / Teams (web).
//
// Detects "who is speaking" per tile via BOTH signals and reports which fired:
//   • marker  — Zoom-style text in AXDescription ("…, active speaker")
//   • class   — Meet-style AXDOMClassList token (MeetSpeakerRules: kssMZb, …)
// Plus the §4 structural analysis (intermittent class tokens + on-windows) so a
// narrated run reveals/​verifies the signal on any platform.
//
//   swift run MeetProbe [meet|zoom|teams] [durationSeconds] [intervalMs]
//   swift run MeetProbe zoom 45 250
//   swift run MeetProbe 45 250          # auto-detect platform
//
// Best signal: GALLERY view, 2-3 cameras on, narrate turns, DON'T hover tiles.

setbuf(stdout, nil)

let args = Array(CommandLine.arguments.dropFirst())
let knownPlatforms = ["meet", "zoom", "teams"]
let platformArg = args.first(where: { knownPlatforms.contains($0.lowercased()) })?.lowercased()
let nums = args.filter { Double($0) != nil }
let duration = Double(nums.first ?? "") ?? 45.0
let intervalMs = Int(nums.dropFirst().first ?? "") ?? 250

// Optional MANUAL speaking-truth windows, for platforms with no auto-marker
// (Teams). Pass `oracle=0-10,30-40` → those seconds count as "speaking", the
// rest as "silent", so the per-tile oracle-diff can run against YOUR narration
// and test EVERY captured surface (classes + all AX attributes + role-shape) —
// including the camera-off case where no class toggles.
let oracleWindows: [(Double, Double)] = (args.first(where: { $0.hasPrefix("oracle=") }) ?? "")
    .replacingOccurrences(of: "oracle=", with: "")
    .split(separator: ",").compactMap { seg -> (Double, Double)? in
        let p = seg.split(separator: "-")
        guard p.count == 2, let a = Double(p[0]), let b = Double(p[1]) else { return nil }
        return (a, b)
    }
func oracleSpeaking(_ t: Double) -> Bool { oracleWindows.contains { t >= $0.0 && t <= $0.1 } }

guard AX.isTrusted else {
    print("Accessibility permission is NOT granted. Grant it in System Settings >")
    print("Privacy & Security > Accessibility for Terminal/your IDE, then re-run.")
    AX.requestTrust()
    exit(2)
}

// ============================================================================
// ANNOUNCEMENT-LISTENER MODE  (swift run MeetProbe teams listen 60)
// Registers an AXObserver for AXAnnouncementRequested (+ live-region) on the
// meeting app and logs every screen-reader / aria-live event. This is the ONE
// capture method the snapshot probe can't do: announcements are transient EVENTS,
// not tree state. If Teams fires "<name> is active speaker" here in sync with who
// talks, that's a real-time, camera-independent AX speaking signal that maps to a
// name (the string Recall's TeamsScraper matches). See docs/teams-probe.md.
// ============================================================================
var axAnnouncements: [(t: Double, notif: String, text: String)] = []
var axListenT0 = Date()
var axObservers: [AXObserver] = []   // strong refs — keep observers alive during the run loop

func axAnnouncementCallback(_ observer: AXObserver, _ element: AXUIElement,
                            _ notification: CFString, _ info: CFDictionary,
                            _ refcon: UnsafeMutableRawPointer?) {
    let t = Date().timeIntervalSince(axListenT0)
    let notif = notification as String
    let dict = info as NSDictionary
    let text = (dict["AXAnnouncementKey"] as? String)
        ?? (dict["AXValueChangeValue"] as? String)
        ?? (dict["AXUIElementsKey"] as? String)
        ?? ((dict["AXUIElementKey"]).flatMap { ($0 as! AXUIElement) as AXUIElement }
                .flatMap { AX.string($0, "AXValue") ?? AX.string($0, "AXDescription") })
        ?? ""
    axAnnouncements.append((t, notif, text))
    print(String(format: "t=%6.1fs  📢 %@  \"%@\"", t, notif, text))
}

if args.contains("roster") {
    // LIVE roster watch — OPEN the Participants/People panel, then toggle anyone's
    // mic and watch it update. Uses parseTeamsRosterRow (the SAME parser the app's
    // engine uses), so this directly validates remote mute/unmute detection.
    MeetTiles.enableEnhancedAccessibility()
    print("ROSTER-WATCH mode — OPEN the Participants/People panel, then toggle mute on")
    print("any participant (esp. a REMOTE one). Changes print live below. Watching \(Int(duration))s…\n")
    Thread.sleep(forTimeInterval: 1.2)
    let t0 = Date()
    var prev: [String: Bool] = [:]
    var everSawRoster = false
    while Date().timeIntervalSince(t0) < duration {
        let elapsed = Date().timeIntervalSince(t0)
        let states = MeetTiles.findMeetingWebAreas(platform: platformArg).first
            .map { MeetTiles.rosterStates(in: $0.web) } ?? [:]
        if !states.isEmpty { everSawRoster = true }
        // Diff against the previous tick: joins / leaves / mute toggles.
        var changes: [String] = []
        for name in Set(prev.keys).union(states.keys).sorted() {
            let old = prev[name], new = states[name]
            if old == nil, let new { changes.append("\(name) [\(new ? "unmuted" : "MUTED")]") }
            else if new == nil, old != nil { changes.append("\(name) left/closed") }
            else if let old, let new, old != new { changes.append("\(name): \(old ? "unmuted" : "MUTED") → \(new ? "unmuted" : "MUTED")") }
        }
        if !changes.isEmpty {
            print(String(format: "t=%5.1fs  %@", elapsed, changes.joined(separator: "  |  ")))
        }
        prev = states
        Thread.sleep(forTimeInterval: Double(intervalMs) / 1000.0)
    }
    print("")
    if !everSawRoster {
        print("→ No roster rows seen the whole run. Open the Participants panel (People button)")
        print("  BEFORE/at start and keep it open — remote mute only exists while it's open.")
    } else {
        print("→ Each line above is a real mute/unmute change read via parseTeamsRosterRow —")
        print("  the exact path the app uses to name a single unmuted remote.")
    }
    exit(0)
}

if args.contains("listen") {
    MeetTiles.enableEnhancedAccessibility()
    print("ANNOUNCEMENT-LISTENER mode — enabled enhanced AX; registering AXAnnouncementRequested + live-region notifications.")
    print("Narrate clear turns out loud. Any active-speaker announcement prints live below. Listening \(Int(duration))s…\n")
    Thread.sleep(forTimeInterval: 1.0)
    axListenT0 = Date()

    let notifs = ["AXAnnouncementRequested", "AXLiveRegionChanged", "AXLiveRegionCreated"]
    var registered = 0
    for app in NSWorkspace.shared.runningApplications {
        guard let bid = app.bundleIdentifier, !app.isTerminated,
              MeetTiles.browserBundleIDs.contains(bid) || MeetTiles.nativeWebviewApps[bid] != nil else { continue }
        if let plat = platformArg, !(MeetTiles.nativeWebviewApps[bid] == plat || MeetTiles.browserBundleIDs.contains(bid)) { continue }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        var observer: AXObserver?
        guard AXObserverCreateWithInfoCallback(app.processIdentifier, axAnnouncementCallback, &observer) == .success,
              let observer else { continue }
        var targets: [AXUIElement] = [axApp]                          // announcements post on the app element
        for w in AX.windows(axApp) { targets.append(w) }              // live-region changes may post on windows
        if let web = MeetTiles.largestWebArea(in: axApp) { targets.append(web) }
        for el in targets { for n in notifs { AXObserverAddNotification(observer, el, n as CFString, nil) } }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)
        axObservers.append(observer)
        registered += 1
        print("  • observing \(app.localizedName ?? bid) (pid \(app.processIdentifier))")
    }
    if registered == 0 {
        print("  No meeting app found to observe. Join the call first, then re-run.")
        exit(1)
    }
    print("")
    CFRunLoopRunInMode(.defaultMode, duration, false)

    print("\n================ ANNOUNCEMENT SUMMARY ================")
    if axAnnouncements.isEmpty {
        print("NONE — no AXAnnouncementRequested / live-region events during the call.")
        print("→ Teams emits NO active-speaker announcement to the AX channel on this build.")
        print("  Combined with the empty needle/oracle hunts, the speaking signal is genuinely")
        print("  not in AX (state OR events) → who-is-speaking must come from VAD + mute-gate,")
        print("  with names bound by participant-state correlation (Recall's WeightedMapper).")
    } else {
        var byText: [String: Int] = [:]
        for a in axAnnouncements { byText[a.text, default: 0] += 1 }
        print("\(axAnnouncements.count) event(s); distinct texts:")
        for (text, c) in byText.sorted(by: { $0.value > $1.value }).prefix(40) {
            print("  [\(c)×] \"\(text)\"")
        }
        print("→ If a \"<name> is active speaker\" text tracks who actually spoke, that's the live")
        print("  AX speaking signal — we map it straight to a name (Recall's mechanism).")
    }
    exit(0)
}

// Force Chromium/WebView2 meeting apps (Teams, Meet, Electron) to build their
// FULL a11y tree before sampling — without this they serve a degraded, static
// tree to passive readers and dynamic state (active-speaker) may never appear.
MeetTiles.enableEnhancedAccessibility()
print("Enabled AXEnhancedUserInterface + AXManualAccessibility on meeting apps; waiting 1.2s for the tree to populate…")
Thread.sleep(forTimeInterval: 1.2)

let stamp = Int(Date().timeIntervalSince1970)
let outDir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("meet-probe-\(stamp)")
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let jsonlURL = outDir.appendingPathComponent("timeline.jsonl")
FileManager.default.createFile(atPath: jsonlURL.path, contents: nil)
let jsonl = try? FileHandle(forWritingTo: jsonlURL)

// Per-tile session history (gallery view keeps tiles persistent).
struct Sample { var t: Double; var pill: Set<String>; var full: Set<String>; var roles: Set<String>; var structure: Set<String>; var facts: Set<String>; var hovered: Bool; var width: CGFloat; var order: Int; var micOff: Bool; var speaking: Bool }
var history: [String: [Sample]] = [:]
var firstPill: [String: Set<String>] = [:]
// Whole web-area sample: class tokens + the page-level structural fact set +
// who occupied the largest "active-speaker container" tile + was anyone speaking.
struct GlobalSample { var t: Double; var tokens: Set<String>; var facts: Set<String>; var spotName: String; var spotArea: CGFloat; var speakingAny: Bool }
var globalHistory: [GlobalSample] = []
// Targeted hunt for the EXACT string Recall's TeamsScraper matches (" is active
// speaker") + related speaking phrases, anywhere in the full enhanced AX tree.
var needleTimeline: [(t: Double, hits: Set<String>)] = []
let speakingNeedles = ["active speaker", "is speaking", "is talking", "voice level", "speaking"]
var sampleCount = 0
var sawAnyTile = false

let t0 = Date()

var detectedPlatform = "?"

func tick() {
    let elapsed = Date().timeIntervalSince(t0)
    guard let hit = MeetTiles.findMeetingWebAreas(platform: platformArg).first else {
        if sampleCount == 0 {
            print(String(format: "t=%5.1fs  (no %@ web area found) — diagnostic:", elapsed, platformArg ?? "meeting"))
            print(MeetTiles.debugSummary()); print("")
        }
        sampleCount += 1
        return
    }
    detectedPlatform = hit.platform
    let rows = MeetTiles.tiles(in: hit.web)
    sampleCount += 1
    if !rows.isEmpty { sawAnyTile = true }

    // Active-speaker CONTAINER tracking: the largest tile this tick. In Speaker
    // view Meet promotes the talker into one big tile — if its occupant switches
    // in sync with the speaker, reading that name is rotation-proof structural
    // attribution (Recall's "container → indicator"). In gallery view tiles are
    // ~equal so this is a no-op (reported as such).
    var spotName = "", spotArea: CGFloat = 0
    var speakingAny = false

    var tilesJson: [[String: Any]] = []
    var line = String(format: "t=%5.1fs ", elapsed)
    for r in rows {
        let f = r.features
        let pill = Set(f.pillTokens.split(separator: ",").map(String.init))
        let full = Set(f.classTokens.split(separator: ",").map(String.init))
        // Phase-4 probe: the tile's child-role signature ("AXImage:2|AXGroup:5"),
        // tokenized so a role:count that toggles with speech = an indicator-child
        // node (a speaking signal independent of the CSS class).
        let roles = Set(f.roleCounts.split(separator: "|").map(String.init))
        // Recall-style structural selector surface (subrole / DOM id / description).
        let structure = Set(f.structureTokens.split(separator: "\u{1f}").map(String.init))
        // Full non-class AX surface (attr names + bucketed state values) for the
        // kssMZb oracle-diff in the post-run analysis.
        let facts = Set(f.stateFacts.split(separator: "\u{1f}").map(String.init))
        // The `eT1oJ` self-cluster is the self tile's HOVER/focus highlight, NOT
        // speech — verified live: it lights up on hover-anywhere and stays on a
        // muted, silent self tile. Only `kssMZb` is the real cross-tile
        // active-speaker class. So treat ONLY kssMZb (+ the Zoom marker) as
        // speaking, and surface the self-cluster as a separate highlight tag so
        // a hover no longer reads as SPEAKING.
        let selfHighlightCluster: Set<String> = ["eT1oJ", "hk9qKe", "nn1vQb", "s4hFTd", "tWDL4c", "yHy1rc"]
        let kssSpk = full.contains("kssMZb")
        let markerSpk = f.markerSpeaking                          // Zoom "…, active speaker"
        let speaking = kssSpk || markerSpk
        let highlightOnly = !speaking && !full.isDisjoint(with: selfHighlightCluster)
        if speaking { speakingAny = true }
        let area = f.frame.width * f.frame.height
        if area > spotArea { spotArea = area; spotName = f.name }
        history[f.name, default: []].append(Sample(t: elapsed, pill: pill, full: full, roles: roles, structure: structure, facts: facts, hovered: f.hovered, width: f.frame.width, order: f.orderIndex, micOff: f.micOff, speaking: speaking))
        tilesJson.append([
            "name": f.name, "order": f.orderIndex,
            "w": Int(f.frame.width), "h": Int(f.frame.height),
            "pillTokens": f.pillTokens, "classTokens": f.classTokens,
            "micOff": f.micOff, "speaking": speaking,
            "markerSpeaking": markerSpk, "classSpeaking": kssSpk,
            "selfHighlight": highlightOnly,
        ])
        let tag: String
        if speaking { tag = "🔊SPEAKING(\(markerSpk ? "mark" : "")\(markerSpk && kssSpk ? "+" : "")\(kssSpk ? "cls" : ""))" }
        else if highlightOnly { tag = "✋hl(self/hover, not speech)" }
        else { tag = "·" }
        line += "| \(f.name) \(tag) "
    }
    globalHistory.append(GlobalSample(
        t: elapsed, tokens: MeetTiles.allClassTokens(in: hit.web),
        facts: MeetTiles.pageFacts(in: hit.web),
        spotName: spotName, spotArea: spotArea, speakingAny: speakingAny))
    needleTimeline.append((elapsed, MeetTiles.needleScan(in: hit.web, needles: speakingNeedles)))
    if let data = try? JSONSerialization.data(withJSONObject: ["t": elapsed, "platform": detectedPlatform, "tiles": tilesJson]), let jsonl {
        jsonl.write(data); jsonl.write(Data([0x0a]))
    }
    print(line)
}

print("MeetProbe — per-tile speaker probe (\(platformArg ?? "auto-detect"))")
print("duration=\(Int(duration))s interval=\(intervalMs)ms  output=\(outDir.path)")
print("Per tile: 🔊SPEAKING(mark=Zoom text marker / cls=Meet class rule)")
print("GALLERY view, 2-3 cameras on. Narrate turns out loud; DON'T hover tiles/open settings.\n")

var ticksRemaining = Int(duration * 1000.0 / Double(intervalMs))
let timer = Timer(timeInterval: Double(intervalMs) / 1000.0, repeats: true) { t in
    tick()
    ticksRemaining -= 1
    if ticksRemaining <= 0 { t.invalidate(); CFRunLoopStop(CFRunLoopGetCurrent()) }
}
RunLoop.current.add(timer, forMode: .common)
timer.fire()
CFRunLoopRun()

// ---------------- Session analysis ----------------
try? jsonl?.close()

func windows(_ samples: [Sample], on: (Sample) -> Bool, gap: Int = 1) -> [(Double, Double)] {
    var out: [(Double, Double)] = []
    var start: Double? = nil, last: Double? = nil, miss = 0
    for s in samples {
        if on(s) {
            if start == nil { start = s.t }
            last = s.t; miss = 0
        } else if start != nil {
            miss += 1
            if miss > gap { out.append((start!, last!)); start = nil }
        }
    }
    if let st = start, let lt = last { out.append((st, lt)) }
    return out
}
func fmtWindows(_ ws: [(Double, Double)]) -> String {
    ws.map { String(format: "%.1f-%.1f", $0.0, $0.1) }.joined(separator: ", ")
}

print("\n================ SESSION ANALYSIS  (platform: \(detectedPlatform)) ================")
if !sawAnyTile {
    print("No tiles detected. Use GALLERY view, the meeting tab FOREGROUND, cameras on.")
    print("samples: \(sampleCount)")
    exit(0)
}

// Meet's hover/control chrome (button styles) — appear when the cursor is over a
// tile, not when someone speaks. Strip them so they don't drown the signal.
func isChrome(_ t: String) -> Bool {
    t.contains("Bz112c") || t.contains("LgbsSe") || t.contains("OWXEXe")
        || t.contains("Jh9lGc") || t == "MSqqjf" || t == "S5GDme"
}

// Collect, per tile, intermittent NON-chrome full-class tokens + their windows;
// and record which tiles each token toggles on (to separate per-tile vs global).
var tileTokenWindows: [String: [String: [(Double, Double)]]] = [:]
var tokenTiles: [String: Set<String>] = [:]
var sawChrome = false
for (name, samples) in history {
    let n = samples.count
    var tc: [String: Int] = [:]
    for s in samples {
        for tok in s.full {
            if isChrome(tok) { sawChrome = true; continue }
            tc[tok, default: 0] += 1
        }
    }
    for (tok, c) in tc where c >= max(1, n / 10) && c <= n * 9 / 10 {
        tileTokenWindows[name, default: [:]][tok] = windows(samples) { $0.full.contains(tok) }
        tokenTiles[tok, default: []].insert(name)
    }
}

let perTileTokens = tokenTiles.filter { $0.value.count == 1 }   // candidate speaker signal
let sharedTokens = tokenTiles.filter { $0.value.count >= 2 }    // likely global / UI

for (name, samples) in history.sorted(by: { $0.key < $1.key }) {
    let n = samples.count
    let medianW = samples.map { $0.width }.sorted()[n / 2]
    print("\n● \(name)  (present \(n)/\(sampleCount), medianWidth=\(Int(medianW)))")
    // SPEAKING = Zoom marker OR Meet `kssMZb` (the self-hover cluster is EXCLUDED,
    // so a hover no longer counts) — compare to your narration.
    let spkWin = windows(samples) { $0.speaking }
    print("   🔊 SPEAKING (marker OR kssMZb; self/hover cluster excluded) windows: \(spkWin.isEmpty ? "(never)" : fmtWindows(spkWin))")
    // All other per-tile intermittent tokens (to catch a separate MUTE class etc.)
    let cand = (tileTokenWindows[name] ?? [:]).filter { perTileTokens[$0.key] != nil }
    for (tok, ws) in cand.sorted(by: { $0.value.count > $1.value.count }) {
        print("   token \(tok)  windows: \(fmtWindows(ws))")
    }
    // Phase-4 verification: does the tile's CHILD STRUCTURE (role-shape) toggle
    // with speech, independent of the CSS class? A role:count whose windows match
    // who spoke = an indicator-child node -> class-free gallery attribution.
    var rc: [String: Int] = [:]
    for s in samples { for tok in s.roles { rc[tok, default: 0] += 1 } }
    let interRoles = rc.filter { $0.value >= max(1, n / 10) && $0.value <= n * 9 / 10 }
    if interRoles.isEmpty {
        print("   role-shape: FLAT (no indicator-child — the class is the only gallery signal)")
    } else {
        for (tok, c) in interRoles.sorted(by: { $0.value > $1.value }).prefix(8) {
            print("   role-shape \(tok)  [\(c)/\(n)]  \(fmtWindows(windows(samples) { $0.roles.contains(tok) }))")
        }
    }

    // Recall-style STRUCTURAL indicator hunt: which subrole / DOM-identifier /
    // description tokens toggle with speech, EXCLUDING hovered samples (so a hover
    // can't masquerade as the signal). A token whose windows match who you
    // narrated speaking = the "active speaker indicator" node Recall keys on.
    let hoveredCount = samples.filter { $0.hovered }.count
    let cleanN = n - hoveredCount
    if hoveredCount > 0 { print("   (\(hoveredCount)/\(n) samples were hovered — excluded from the structure hunt)") }
    var sc: [String: Int] = [:]
    for s in samples where !s.hovered { for tok in s.structure { sc[tok, default: 0] += 1 } }
    let interStruct = sc.filter { $0.value >= max(1, cleanN / 10) && $0.value <= cleanN * 9 / 10 }
    if cleanN == 0 {
        print("   structure: (every sample hovered — keep the mouse OFF the meet window)")
    } else if interStruct.isEmpty {
        print("   structure: no indicator-node toggles (mouse-off) — no structural speaking signal on this build")
    } else {
        for (tok, c) in interStruct.sorted(by: { $0.value > $1.value }).prefix(12) {
            print("   indicator? \(tok)  [\(c)/\(cleanN)]  \(fmtWindows(windows(samples) { !$0.hovered && $0.structure.contains(tok) }))")
        }
    }

    // ORACLE-DIFF — split this tile's NON-hovered samples into speaking vs silent
    // and find ANY captured surface that co-varies ≥60%. Ground truth is either
    // the auto `speaking` flag (Meet's kssMZb) OR manual `oracle=` windows (Teams,
    // which has no auto-marker). The diff spans EVERY surface — class tokens
    // (`cls:`), every AX attribute name+value (`n:`/`v:`), and role-shape
    // (`role:`) — so an active-tile BORDER shows up if it's reflected as ANY
    // AX-readable state (AXSelected, aria-selected, a value, a child node).
    // Nothing co-varying ⇒ the border is pure CSS / a pruned decorative node,
    // which the AX tree cannot expose (→ audio VAD + mute is the only path).
    let clean = samples.filter { !$0.hovered }
    let useOracle = !oracleWindows.isEmpty
    let onS = clean.filter { useOracle ? oracleSpeaking($0.t) : $0.speaking }
    let offS = clean.filter { useOracle ? !oracleSpeaking($0.t) : !$0.speaking }
    func signals(_ s: Sample) -> Set<String> {
        var sig = s.facts
        for c in s.full { sig.insert("cls:\(c)") }
        for r in s.roles { sig.insert("role:\(r)") }
        // GEOMETRY — active-speaker may be tile PROMOTION (the speaker's tile
        // enlarges / moves to the main stage), an AXFrame change the class/attr
        // diff would miss. Bucket width (40px) + reading-order slot so a size or
        // position change co-varies with speech if that's the mechanism.
        sig.insert("geo:w\(Int((s.width / 40).rounded()) * 40)")
        sig.insert("geo:ord\(s.order)")
        return sig
    }
    let src = useOracle ? "oracle=\(oracleWindows.map { "\(Int($0.0))-\(Int($0.1))" }.joined(separator: ","))" : "kssMZb"
    if onS.count >= 3 && offS.count >= 3 {
        var onC: [String: Int] = [:], offC: [String: Int] = [:]
        for s in onS { for f in signals(s) { onC[f, default: 0] += 1 } }
        for s in offS { for f in signals(s) { offC[f, default: 0] += 1 } }
        var hits: [(f: String, onR: Double, offR: Double)] = []
        for f in Set(onC.keys).union(offC.keys) {
            let onR = Double(onC[f] ?? 0) / Double(onS.count)
            let offR = Double(offC[f] ?? 0) / Double(offS.count)
            if abs(onR - offR) >= 0.6 { hits.append((f, onR, offR)) }
        }
        if hits.isEmpty {
            print("   oracle-diff [\(src)]: NOTHING (class/attr/role) co-varies with speech (spk=\(onS.count)/sil=\(offS.count)) → the active-tile state is NOT in the AX tree (pure-CSS border / pruned node) → audio VAD + mute only")
        } else {
            print("   oracle-diff [\(src)]: surfaces co-varying with speech (spk=\(onS.count)/sil=\(offS.count)) — candidate active-speaker handles:")
            for h in hits.sorted(by: { abs($0.onR - $0.offR) > abs($1.onR - $1.offR) }).prefix(15) {
                print(String(format: "     %@  spk=%.0f%% sil=%.0f%%", h.f, h.onR * 100, h.offR * 100))
            }
        }
    } else {
        print("   oracle-diff [\(src)]: need ≥3 speaking AND ≥3 silent samples on this tile (have spk=\(onS.count)/sil=\(offS.count))")
    }
}

// WHOLE-WEB-AREA token timeline — catches a speaking signal that lives OUTSIDE the
// video tiles (e.g. Zoom's audio-* classes in the footer / participants panel).
// Compare the windows below to who you narrated speaking.
if !globalHistory.isEmpty {
    let N = globalHistory.count
    var cnt: [String: Int] = [:]
    for g in globalHistory { for t in g.tokens where !isChrome(t) { cnt[t, default: 0] += 1 } }
    let inter = cnt.filter { $0.value >= max(1, N / 10) && $0.value <= N * 9 / 10 }
    print("\nWHOLE-PAGE intermittent tokens (anywhere in the web area — the Zoom signal likely hides here):")
    if inter.isEmpty {
        print("   (none toggled — no readable speaking signal anywhere in AX on this build)")
    } else {
        for (tok, c) in inter.sorted(by: { $0.value > $1.value }).prefix(30) {
            var out: [(Double, Double)] = []
            var st: Double? = nil, last: Double? = nil, miss = 0
            for g in globalHistory {
                if g.tokens.contains(tok) { if st == nil { st = g.t }; last = g.t; miss = 0 }
                else if st != nil { miss += 1; if miss > 1 { out.append((st!, last!)); st = nil } }
            }
            if let s = st, let l = last { out.append((s, l)) }
            print("   \(tok)  on \(c)/\(N)  \(fmtWindows(out))")
        }
    }

    // ── ACTIVE-SPEAKER CONTAINER (Speaker-view structural test) ──────────────
    // Timeline of who occupied the largest tile. If the occupant SWITCHES in sync
    // with who's speaking, the container follows the speaker → read the name =
    // rotation-proof structural attribution. If it never switches (one fixed big
    // tile, or all tiles equal in gallery), this route doesn't apply on this view.
    let spotSamples = globalHistory.filter { !$0.spotName.isEmpty }
    print("\nACTIVE-SPEAKER CONTAINER — occupant of the largest tile over time:")
    if spotSamples.isEmpty {
        print("   (no tiles sized — N/A)")
    } else {
        var segs: [(name: String, start: Double, end: Double)] = []
        for g in spotSamples {
            if var last = segs.last, last.name == g.spotName { last.end = g.t; segs[segs.count - 1] = last }
            else { segs.append((g.spotName, g.t, g.t)) }
        }
        let occupants = Set(segs.map { $0.name })
        for s in segs { print(String(format: "   %5.1f–%5.1fs  %@", s.start, s.end, s.name)) }
        if occupants.count <= 1 {
            print("   → ONE fixed occupant (pinned / gallery) — container does NOT follow the speaker on this view. Try Speaker view.")
        } else {
            print("   → container occupant SWITCHES (\(occupants.count) distinct) — compare the windows above to who spoke; if they match, this is the structural handle.")
        }
    }

    // ── PAGE-LEVEL STRUCTURAL HUNT (container/indicator outside the tiles) ────
    // Full-surface diff over the WHOLE web area (page facts + class tokens),
    // split by speech — manual `oracle=` windows when given, else "was anyone
    // speaking". Catches an active-speaker indicator/border element living
    // OUTSIDE the tiles (a page-level overlay).
    let usePageOracle = !oracleWindows.isEmpty
    let gOn = globalHistory.filter { usePageOracle ? oracleSpeaking($0.t) : $0.speakingAny }
    let gOff = globalHistory.filter { usePageOracle ? !oracleSpeaking($0.t) : !$0.speakingAny }
    let pageSrc = usePageOracle ? "oracle" : "auto"
    print("\nPAGE-LEVEL structural hunt (indicator/container outside the tiles) [\(pageSrc)]:")
    if gOn.count >= 3 && gOff.count >= 3 {
        var onC: [String: Int] = [:], offC: [String: Int] = [:]
        for g in gOn { for f in g.facts { onC[f, default: 0] += 1 }; for c in g.tokens { onC["cls:\(c)", default: 0] += 1 } }
        for g in gOff { for f in g.facts { offC[f, default: 0] += 1 }; for c in g.tokens { offC["cls:\(c)", default: 0] += 1 } }
        var hits: [(f: String, onR: Double, offR: Double)] = []
        for f in Set(onC.keys).union(offC.keys) {
            let onR = Double(onC[f] ?? 0) / Double(gOn.count)
            let offR = Double(offC[f] ?? 0) / Double(gOff.count)
            if abs(onR - offR) >= 0.6 { hits.append((f, onR, offR)) }
        }
        if hits.isEmpty {
            print("   NOTHING page-level (class/attr) toggles with speech (spk=\(gOn.count)/sil=\(gOff.count)) → no indicator/border element outside the tiles either")
        } else {
            print("   page-level surfaces toggling with speech (spk=\(gOn.count)/sil=\(gOff.count)) — candidate container/indicator:")
            for h in hits.sorted(by: { abs($0.onR - $0.offR) > abs($1.onR - $1.offR) }).prefix(15) {
                print(String(format: "     %@  spk=%.0f%% sil=%.0f%%", h.f, h.onR * 100, h.offR * 100))
            }
        }
    } else {
        print("   need ≥3 speaking AND ≥3 silent ticks (have spk=\(gOn.count)/sil=\(gOff.count)) — give the oracle= windows, or pause between turns")
    }
}

// ── SPEAKING-STRING NEEDLE HUNT ───────────────────────────────────────────────
// The exact string Recall's TeamsScraper matches (" is active speaker") + related
// phrases, anywhere in the full enhanced AX tree, with the windows they appear in.
// If a "<name> is active speaker" label shows up in sync with who's talking →
// that's the readable AX speaking signal (map straight to a name). If it NEVER
// appears, Recall's check is inert on this build → speaking comes from VAD.
if !needleTimeline.isEmpty {
    let N = needleTimeline.count
    var cnt: [String: Int] = [:]
    for s in needleTimeline { for h in s.hits { cnt[h, default: 0] += 1 } }
    print("\nSPEAKING-STRING NEEDLE HUNT (\"is active speaker\"/\"speaking\"/… across the whole AX tree):")
    if cnt.isEmpty {
        print("   NONE — no speaking phrase appears in ANY AX attribute on this build (Recall's \" is active speaker\" check is inert here → speaking is VAD-derived)")
    } else {
        for (hit, c) in cnt.sorted(by: { $0.value > $1.value }).prefix(30) {
            var out: [(Double, Double)] = []
            var st: Double? = nil, last: Double? = nil, miss = 0
            for s in needleTimeline {
                if s.hits.contains(hit) { if st == nil { st = s.t }; last = s.t; miss = 0 }
                else if st != nil { miss += 1; if miss > 1 { out.append((st!, last!)); st = nil } }
            }
            if let s0 = st, let l = last { out.append((s0, l)) }
            print("   [\(c)/\(N)] \(hit)  \(fmtWindows(out))")
        }
        print("   → compare these windows to who actually spoke. A match = the readable AX speaking label.")
    }
}

if !sharedTokens.isEmpty {
    print("\nper-tile tokens shared across >1 tile (likely UI state): \(sharedTokens.keys.sorted().joined(separator: ", "))")
}
if sawChrome {
    print("⚠️  Hover-control chrome detected (Bz112c/LgbsSe/MSqqjf). KEEP THE MOUSE STILL and off the tiles next run — those classes are cursor-driven noise.")
}

print("""

HOW TO READ:
  • A CANDIDATE token whose windows match who you narrated speaking = Meet's
    active-speaker class -> Phase 4 (MeetSpeakerTracker, remote-config'd).
  • If there are NO candidate tokens across a clean talk/silence cycle (mouse
    still, narrated), Meet's active speaker is NOT in the AX tree on this build
    -> Phase 5 (audio VAD).
  • Full timeline (JSONL): \(jsonlURL.path)
""")
print("samples: \(sampleCount)")
