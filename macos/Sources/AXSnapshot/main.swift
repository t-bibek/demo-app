import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

// AXSnapshot — full, detailed Accessibility-tree dump for offline analysis.
//
// Unlike AXDump (a quick stdout pretty-printer), this captures the COMPLETE AX
// tree of a target meeting surface — EVERY node and EVERY attribute on it
// (AXDOMClassList, AXDOMIdentifier, AXSubrole, geometry, AXSelected/AXFocused,
// AXValue, …) — to:
//   • <label>.json  full fidelity (every attribute's value); diff two of these
//                   across talk/silence to find which feature moves with speech.
//   • <label>.txt   readable indented tree (role + subrole + #id + .classes +
//                   title/desc/value + frame + the full attribute-name list).
//
// Targets:
//   chrome        — the meeting browser tab's AXWebArea (Meet / Zoom-web / Teams-web)
//   chrome-window — the WHOLE browser WINDOW (browser chrome incl. the tab strip),
//                   one dump per window of every chrome-kind app (for the Meet
//                   tab-away keep-alive measurement; pair with --skip-webarea)
//   zoom          — native Zoom (us.zoom.xos), every window
//   teams         — native Teams (com.microsoft.teams2 / .teams), every window
//   all           — every target currently running (default)
//
// Flags of note:
//   --skip-webarea  record each AXWebArea node but emit children:[] and don't descend
//                   (keeps a window dump to the native chrome, not ~100k web nodes)
//   --no-wake       skip the AXManualAccessibility/AXEnhancedUserInterface force so
//                   the passive-reader (degraded) tree is captured as the control cell
//
//   swift run AXSnapshot                         # every running target
//   swift run AXSnapshot chrome                  # just the meeting browser tab
//   swift run AXSnapshot chrome-window --skip-webarea   # tab strip / browser chrome
//   swift run AXSnapshot zoom --depth 100 --max-nodes 40000
//   swift run AXSnapshot teams --print           # also echo the .txt to stdout
//
// Output dir: ./ax-dumps/<timestamp>/   (gitignored)
//
// NOTE: forces the FULL a11y tree first (AXManualAccessibility +
// AXEnhancedUserInterface) so Chromium/Electron apps (Chrome, Teams) don't serve
// a degraded passive-reader tree — exactly what Recall's recorder does.

setbuf(stdout, nil)

let args = Array(CommandLine.arguments.dropFirst())

func intFlag(_ name: String, _ def: Int) -> Int {
    guard let i = args.firstIndex(of: name), i + 1 < args.count, let v = Int(args[i + 1]) else { return def }
    return v
}
func stringFlag(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}
// --url <substring>: when several Chrome instances are open (e.g. a personal
// Chrome + a separate --user-data-dir meeting Chrome), filter the collected web
// areas to those whose AXURL contains this substring so the caller targets the
// exact meeting (e.g. --url cyv-efne-fgr or --url meet.google.com).
let urlFilter = stringFlag("--url")?.lowercased()
// NO depth limit by default — the walk follows the tree to its natural leaves and
// returns ALL nodes. Pass --depth N to cap it. maxNodes is only a runaway backstop
// (against a pathological/cyclic native tree), set far above any real app.
let maxNodes = intFlag("--max-nodes", 1_000_000)
let maxDepth = intFlag("--depth", Int.max)
let alsoPrint = args.contains("--print")

// --skip-webarea: at every AXWebArea node, RECORD the node (role/title/frame/attrs)
// but emit children:[] and don't descend — keeps a WINDOW-rooted dump to the native
// browser chrome (hundreds of nodes: tab strip, toolbar) instead of the ~100k
// web-content nodes under the page. Used with the chrome-window target for the
// tab-away keep-alive measurement. Default OFF (existing dumps unchanged).
let skipWebArea = args.contains("--skip-webarea")
// --no-wake: skip the AXManualAccessibility / AXEnhancedUserInterface force so we can
// capture one PASSIVE-READER cell (the degraded tree Chromium serves when nobody has
// forced full a11y) — the control condition for the keep-alive measurement. Default
// OFF (the wake force stays on for every existing invocation).
let noWake = args.contains("--no-wake")

// --watch [seconds]: instead of one dump, poll the target every 0.5s and print
// descriptions / class tokens that APPEAR (+) or DISAPPEAR (−) between ticks — so
// a transient speaking marker surfaces the instant someone talks (the dynamic
// signal a single snapshot can't see).
let watchIdx = args.firstIndex(of: "--watch")
let watchMode = watchIdx != nil
let watchSecs: Double = {
    if let i = watchIdx, i + 1 < args.count, let v = Double(args[i + 1]) { return v }
    return 30
}()

let knownTargets: Set<String> = ["all", "chrome", "chrome-window", "meet", "browser", "web", "zoom", "teams"]
let rawTarget = args.first(where: { knownTargets.contains($0.lowercased()) })?.lowercased() ?? "all"
let target = (rawTarget == "meet" || rawTarget == "browser" || rawTarget == "web") ? "chrome" : rawTarget

// chrome-window: WINDOW-rooted chrome dump (browser chrome incl. the tab strip) —
// same per-window Root shape the native zoom/teams branches use — instead of the
// web-area-rooted "chrome" dump. Still a chrome-kind target for app selection.
let wantsChromeWindow = (target == "chrome-window")
let wantsChrome = (target == "all" || target == "chrome" || wantsChromeWindow)
let wantsZoom   = (target == "all" || target == "zoom")
let wantsTeams  = (target == "all" || target == "teams")

// MARK: - App identification

let browserIDs: Set<String> = [
    "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary",
    "com.apple.Safari", "com.apple.SafariTechnologyPreview",
    "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser",
    "org.mozilla.firefox", "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
]
let zoomID = "us.zoom.xos"
let teamsIDs: Set<String> = ["com.microsoft.teams2", "com.microsoft.teams"]

guard AX.isTrusted else {
    print("Accessibility permission is NOT granted. Grant it in System Settings >")
    print("Privacy & Security > Accessibility for Terminal/your IDE, then re-run.")
    AX.requestTrust()
    exit(2)
}

// MARK: - Pick target apps, force their FULL a11y tree, then let it settle

struct TargetApp { let kind: String; let name: String; let ax: AXUIElement }

var targetApps: [TargetApp] = []
for app in NSWorkspace.shared.runningApplications {
    guard let id = app.bundleIdentifier, !app.isTerminated else { continue }
    let kind: String
    if wantsChrome && browserIDs.contains(id) { kind = "chrome" }
    else if wantsZoom && id == zoomID         { kind = "zoom" }
    else if wantsTeams && teamsIDs.contains(id) { kind = "teams" }
    else { continue }

    let ax = AXUIElementCreateApplication(app.processIdentifier)
    // Force the full tree (Chromium/Electron serve a degraded tree otherwise).
    // --no-wake skips this so we can capture the degraded passive-reader tree as
    // the control condition (default OFF — the force stays on otherwise).
    if !noWake {
        AX.setBool(ax, "AXManualAccessibility", true)
        AX.setBool(ax, "AXEnhancedUserInterface", true)
    }
    targetApps.append(TargetApp(kind: kind, name: app.localizedName ?? id, ax: ax))
}

if targetApps.isEmpty {
    print("No matching app is running for target '\(target)'.")
    print("Open the meeting (Chrome tab / native Zoom / native Teams) and re-run.")
    exit(1)
}

print("\(noWake ? "Reading (NO wake — passive-reader tree) " : "Forcing full a11y tree on: ")\(targetApps.map { "\($0.name) [\($0.kind)]" }.joined(separator: ", "))")
// Multiple Chrome PROCESSES share the com.google.Chrome bundle id (a personal
// Chrome + a separate --user-data-dir meeting Chrome). The meeting tab may live
// in ANY of them, so note how many we saw — the web-area search below spans all.
let chromeCount = targetApps.filter { $0.kind == "chrome" }.count
if chromeCount > 1 { print("Saw \(chromeCount) browser/Chrome process(es) — searching web areas across all of them.") }
if let f = urlFilter { print("Filtering web areas by --url substring: \"\(f)\"") }
print("Letting the tree build…")
usleep(600_000)   // give Chromium/Electron time to materialize the dynamic tree

// MARK: - Resolve the roots to dump

struct Root { let label: String; let note: String; let el: AXUIElement }

/// Recursively find every AXWebArea under `el` (keeps descending so meeting
/// iframes nested inside an outer web area are also found).
func findWebAreas(_ el: AXUIElement, _ depth: Int, _ budget: inout Int) -> [AXUIElement] {
    if depth > 60 || budget <= 0 { return [] }
    budget -= 1
    var out: [AXUIElement] = []
    if AX.string(el, "AXRole") == "AXWebArea" { out.append(el) }
    for c in AX.children(el) {
        out += findWebAreas(c, depth + 1, &budget)
        if budget <= 0 { break }
    }
    return out
}

func meetingLabel(_ url: String) -> String? {
    let u = url.lowercased()
    if u.contains("meet.google.com") { return "meet" }
    if u.contains("zoom.us") { return "zoom-web" }
    if u.contains("teams.microsoft.com") || u.contains("teams.live.com") { return "teams-web" }
    return nil
}

var roots: [Root] = []

// Chrome: aggregate web areas across ALL matching Chrome PROCESSES before deciding
// meeting-vs-other. Multiple Chrome instances share the com.google.Chrome bundle id
// (a user's personal Chrome + a separate --user-data-dir meeting Chrome are two
// distinct PIDs → two TargetApps). The meeting tab may live in ANY of them, so a
// per-app decision made the tool dump the FIRST Chrome's personal tabs and print
// "No meeting tab found" while the real meeting sat in a later Chrome process. We
// therefore collect across every Chrome app first, and emit the warning ONCE.
struct WebRoot { let el: AXUIElement; let url: String; let winTitle: String; let appName: String }
var chromeFound: [WebRoot] = []
for t in targetApps where t.kind == "chrome" && !wantsChromeWindow {
    // Root each dump at a web area (the "Chrome tab" tree), not the whole browser
    // window — skips the browser chrome. Capture EVERY web area in EVERY window,
    // with its owning window title, so the document-PIP window (a separate top-
    // level window whose web area carries NO meet URL) is dumped too — that's
    // where a popped-out meeting's tiles live.
    for win in AX.windows(t.ax) {
        let wt = AX.string(win, "AXTitle") ?? ""
        var budget = 8000
        for area in findWebAreas(win, 0, &budget) {
            let url = AX.urlString(area, "AXURL") ?? AX.string(area, "AXValue") ?? ""
            chromeFound.append(WebRoot(el: area, url: url, winTitle: wt, appName: t.name))
        }
    }
}

// chrome-window: root each dump at the WHOLE browser window (browser chrome incl.
// the tab strip), not at a web area — the same per-window Root shape the native
// zoom/teams branches use below. For EVERY chrome-kind app, one Root per window.
// Pair with --skip-webarea so the walk keeps to the native chrome (hundreds of
// nodes) instead of descending the ~100k web-content nodes under the page — the
// setup for the Meet tab-away keep-alive measurement.
if wantsChromeWindow {
    for t in targetApps where t.kind == "chrome" {
        let wins = AX.windows(t.ax)
        if wins.isEmpty { print("⚠️  \(t.name): no windows exposed.") }
        for (i, win) in wins.enumerated() {
            let title = AX.string(win, "AXTitle") ?? "(untitled)"
            let minimized = boolIfPresent(win, "AXMinimized") ?? false
            roots.append(Root(label: "chrome-window-\(t.name)-\(i + 1)",
                              note: "\(title) minimized=\(minimized)", el: win))
        }
    }
}

if targetApps.contains(where: { $0.kind == "chrome" }) && !wantsChromeWindow {
    // Optional --url filter: keep only web areas whose AXURL contains the substring,
    // so the caller can target the exact meeting when several Chrome instances are
    // open. When it filters everything out, fall back to the unfiltered set so the
    // tool still dumps something rather than going silent.
    var found = chromeFound
    if let f = urlFilter {
        let filtered = chromeFound.filter { $0.url.lowercased().contains(f) }
        if filtered.isEmpty {
            print("⚠️  --url \"\(f)\" matched no web area across \(chromeCount) Chrome process(es); ignoring the filter.")
        } else {
            found = filtered
        }
    }

    // Meeting web areas found in ANY Chrome process — the definitive answer to "is a
    // meeting open", so the no-meeting warning below keys off this aggregate, not a
    // single process.
    let meeting = found.filter { meetingLabel($0.url) != nil }
    for (i, m) in meeting.enumerated() {
        let suffix = meeting.count > 1 ? "-\(i + 1)" : ""
        roots.append(Root(label: "chrome-\(meetingLabel(m.url)!)\(suffix)", note: m.url, el: m.el))
    }
    // Non-meeting web areas (incl. the URL-less document-PIP window) when chrome
    // is the explicit target — so the PIP mini-window is captured for diagnosis.
    if target == "chrome" {
        let others = found.filter { meetingLabel($0.url) == nil }
        for (i, a) in others.prefix(8).enumerated() {
            let note = a.url.isEmpty
                ? "window: \(a.winTitle.isEmpty ? "(untitled — PIP?)" : a.winTitle) [\(a.appName)]"
                : a.url
            roots.append(Root(label: "chrome-other\(i + 1)", note: note, el: a.el))
        }
        // Only warn when NO meeting web area exists in ANY Chrome process.
        if meeting.isEmpty {
            print("⚠️  No meeting tab found — dumping \(min(others.count, 8)) other web area(s), incl. any PIP window.")
        }
    }
    if chromeFound.isEmpty {
        print("⚠️  No web area found in any Chrome process. Open Meet/Zoom-web/Teams-web in a tab.")
    }
}

// Native zoom/teams: dump every window in full, per app (the meeting + the
// Participants panel are often separate windows; the user wants all of it).
for t in targetApps where t.kind == "zoom" || t.kind == "teams" {
    let wins = AX.windows(t.ax)
    if wins.isEmpty {
        print("⚠️  \(t.name): no windows exposed.")
    }
    for (i, win) in wins.enumerated() {
        let title = AX.string(win, "AXTitle") ?? "(untitled)"
        roots.append(Root(label: "\(t.kind)-native-win\(i + 1)", note: title, el: win))
    }
}

if roots.isEmpty {
    print("\nNothing to dump. (Apps were found but no usable root — see warnings above.)")
    exit(1)
}

// MARK: - Watch mode (catch the DYNAMIC speaking signal a snapshot can't)

if watchMode {
    func collect(_ el: AXUIElement, _ depth: Int, _ descs: inout Set<String>, _ classes: inout Set<String>) {
        if depth > 300 { return }
        if let d = AX.string(el, "AXDescription"), !d.isEmpty { descs.insert(d) }
        if let v = AX.string(el, "AXValue"), !v.isEmpty, v.count <= 80 { descs.insert("value: " + v) }
        for c in AX.classList(el) { classes.insert(c) }
        for c in AX.allChildren(el) { collect(c, depth + 1, &descs, &classes) }
    }
    print("\nWATCH: polling every 0.5s for \(Int(watchSecs))s. Narrate who speaks; keep the mouse STILL.")
    print("(+) appeared / (−) disappeared between ticks. A speaking token (e.g. a participant")
    print("description gaining \", speaking\") surfaces here the instant someone talks.\n")
    var prevD = Set<String>(), prevC = Set<String>()
    var first = true
    let start = Date()
    while Date().timeIntervalSince(start) < watchSecs {
        var curD = Set<String>(), curC = Set<String>()
        for r in roots { collect(r.el, 0, &curD, &curC) }
        let t = Date().timeIntervalSince(start)
        if first {
            print("baseline: \(curD.count) descriptions, \(curC.count) class tokens")
        } else {
            for a in curD.subtracting(prevD).sorted() { print(String(format: "t=%5.1fs", t) + "  +desc  " + a) }
            for a in prevD.subtracting(curD).sorted() { print(String(format: "t=%5.1fs", t) + "  -desc  " + a) }
            for a in curC.subtracting(prevC).sorted() { print(String(format: "t=%5.1fs", t) + "  +cls   " + a) }
            for a in prevC.subtracting(curC).sorted() { print(String(format: "t=%5.1fs", t) + "  -cls   " + a) }
        }
        prevD = curD; prevC = curC; first = false
        usleep(500_000)
    }
    print("\nDone. If a participant DESCRIPTION gained/lost a token in sync with who talked → that's")
    print("Teams' AX speaking signal (wire it like Zoom's marker). If only mute/video/clock/class")
    print("noise moved across a clean talk/silence cycle → speaking genuinely isn't in AX on this build.")
    exit(0)
}

// MARK: - Generic attribute value → JSON-safe value (captures EVERYTHING)

func jsonValue(_ el: AXUIElement, _ attr: String) -> Any {
    guard let v = AX.copy(el, attr) else { return NSNull() }
    let tid = CFGetTypeID(v)
    if tid == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }
    if let s = v as? String { return s }
    if let arr = v as? [String] { return arr }
    if tid == AXValueGetTypeID() {
        let axv = v as! AXValue
        switch AXValueGetType(axv) {
        case .cgRect:  var r = CGRect.zero;  AXValueGetValue(axv, .cgRect,  &r); return ["x": Double(r.origin.x), "y": Double(r.origin.y), "w": Double(r.size.width), "h": Double(r.size.height)]
        case .cgPoint: var p = CGPoint.zero; AXValueGetValue(axv, .cgPoint, &p); return ["x": Double(p.x), "y": Double(p.y)]
        case .cgSize:  var s = CGSize.zero;  AXValueGetValue(axv, .cgSize,  &s); return ["w": Double(s.width), "h": Double(s.height)]
        case .cfRange: var rg = CFRange();   AXValueGetValue(axv, .cfRange, &rg); return ["location": rg.location, "length": rg.length]
        default: return "<AXValue>"
        }
    }
    if let n = v as? NSNumber { return n }
    if tid == AXUIElementGetTypeID() { return "<AXUIElement>" }
    if let arr = v as? [AXUIElement] { return "<\(arr.count) AXUIElement>" }
    if let u = v as? URL { return u.absoluteString }
    if let u = v as? NSURL { return u.absoluteString ?? u.description }
    if let arr = v as? [Any] { return "<\(arr.count) items>" }
    return String(describing: v)
}

func boolIfPresent(_ el: AXUIElement, _ attr: String) -> Bool? {
    guard let v = AX.copy(el, attr) else { return nil }
    if CFGetTypeID(v) == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }
    if let n = v as? NSNumber { return n.boolValue }
    return nil
}

// MARK: - Walk one tree into a JSON-safe dictionary

final class Walker {
    let maxNodes: Int
    let maxDepth: Int
    let skipWebArea: Bool
    var count = 0
    var truncated = false
    init(maxNodes: Int, maxDepth: Int, skipWebArea: Bool = false) {
        self.maxNodes = maxNodes; self.maxDepth = maxDepth; self.skipWebArea = skipWebArea
    }

    func node(_ el: AXUIElement, _ depth: Int) -> [String: Any] {
        count += 1
        var d: [String: Any] = [:]
        d["role"] = AX.string(el, "AXRole") ?? "?"
        if let s = AX.string(el, "AXSubrole") { d["subrole"] = s }
        if let s = AX.string(el, "AXRoleDescription") { d["roleDescription"] = s }
        for (k, a) in [("title", "AXTitle"), ("description", "AXDescription"),
                       ("value", "AXValue"), ("help", "AXHelp"),
                       ("placeholder", "AXPlaceholderValue")] {
            if let s = AX.string(el, a), !s.isEmpty { d[k] = s }
        }
        let classes = AX.classList(el)
        if !classes.isEmpty { d["domClassList"] = classes }
        if let id = AX.string(el, "AXDOMIdentifier"), !id.isEmpty { d["domIdentifier"] = id }
        if let id = AX.string(el, "AXIdentifier"), !id.isEmpty { d["identifier"] = id }
        if let f = AX.frame(el) {
            d["frame"] = ["x": Double(f.origin.x), "y": Double(f.origin.y),
                          "w": Double(f.size.width), "h": Double(f.size.height)]
        }
        for (k, a) in [("selected", "AXSelected"), ("focused", "AXFocused"), ("enabled", "AXEnabled")] {
            if let b = boolIfPresent(el, a) { d[k] = b }
        }
        if let url = AX.urlString(el, "AXURL") { d["url"] = url }

        // Full attribute map — EVERY attribute this node exposes, with its value.
        // This is the "dump everything" guarantee: nothing is filtered out.
        var attrs: [String: Any] = [:]
        for name in AX.attributeNames(el) where name != "AXChildren" {
            attrs[name] = jsonValue(el, name)
        }
        d["attributes"] = attrs

        let kids = AX.allChildren(el)   // AXChildren ∪ native alternate relationships
        d["childCount"] = kids.count
        // --skip-webarea: at an AXWebArea, KEEP the node (role/title/frame/attrs
        // above) but emit children:[] and do NOT descend — so a WINDOW-rooted chrome
        // dump stays on the native browser chrome (tab strip, toolbar: hundreds of
        // nodes) instead of the ~100k web-content nodes under the page.
        if skipWebArea, (d["role"] as? String) == "AXWebArea" {
            d["children"] = []
            return d
        }
        if depth < maxDepth {
            var arr: [Any] = []
            for c in kids {
                if count >= maxNodes { truncated = true; break }
                arr.append(node(c, depth + 1))
            }
            d["children"] = arr
        } else if !kids.isEmpty {
            truncated = true
            d["children"] = []
        }
        return d
    }
}

// MARK: - Participant ROW / SUB-ROW marking
//
// A participant TILE is a node whose AXDOMClassList carries `oZRSLe` (Meet's
// stable tile class — held across every observed class rotation). The PROMOTED
// slot is any tile with a `kssMZb` ANCESTOR (Meet wraps the spotlit/auto-promoted
// tile in a `kssMZb` container). Sub-rows inside a tile are tagged by role/class
// so the structure of one tile reads at a glance:
//   name  — AXStaticText (the name pill), or the tile's own AXDescription
//   meter — the audio-level widget (jsname=QgSmzd / IisKdb / DYfzY / gjg47c)
//   video — AXImage / AXVideo / the render surface
// This lets a multi-party dump be diffed across speaker turns to see whether the
// speaker's tile changes ORDER, becomes PROMOTED (kssMZb), grows in area, or gains
// focused/selected — the token-free structural pattern the set-diff can't show.
// SPEAKING itself is NOT in AX (the equalizer animation is pruned); pair with the
// DOM capture (research/meet-dom-detector/live/pattern-capture.js) for that.

func classesOf(_ n: [String: Any]) -> [String] { (n["domClassList"] as? [String]) ?? [] }
func isTileNode(_ n: [String: Any]) -> Bool { classesOf(n).contains("oZRSLe") }
func hasAnyClass(_ n: [String: Any], _ toks: [String]) -> Bool {
    let c = Set(classesOf(n)); return toks.contains { c.contains($0) }
}
func subRowKind(_ n: [String: Any]) -> String? {
    let role = n["role"] as? String ?? ""
    if hasAnyClass(n, ["QgSmzd", "IisKdb", "DYfzY", "gjg47c"]) || (n["domIdentifier"] as? String) == "QgSmzd" { return "meter" }
    if role == "AXStaticText", (n["value"] as? String)?.isEmpty == false { return "name" }
    if role == "AXImage" || role == "AXVideo" { return "video" }
    return nil
}

struct TileRow {
    var idx: Int; var name: String
    var x: Double; var y: Double; var w: Double; var h: Double; var area: Double
    var promoted: Bool; var focused: Bool; var selected: Bool
}
/// The tile's participant name: `.oZRSLe`'s own AXDescription (older builds), else
/// the first descendant AXStaticText value (the name-pill — current build moved
/// the name off the tile description into a nested static-text node).
func tileName(_ n: [String: Any]) -> String {
    if let d = n["description"] as? String, !d.isEmpty { return d }
    var found: String?
    func walk(_ x: [String: Any]) {
        if found != nil { return }
        if (x["role"] as? String) == "AXStaticText", let v = x["value"] as? String, !v.isEmpty { found = v; return }
        if let kids = x["children"] as? [Any] { for c in kids { if let cd = c as? [String: Any] { walk(cd) } } }
    }
    walk(n)
    return found ?? "?"
}
func collectTiles(_ n: [String: Any], _ inKss: Bool, _ rows: inout [TileRow]) {
    let nowKss = inKss || classesOf(n).contains("kssMZb")
    if isTileNode(n) {
        let f = (n["frame"] as? [String: Double]) ?? [:]
        let w = f["w"] ?? 0, h = f["h"] ?? 0
        rows.append(TileRow(idx: rows.count, name: tileName(n),
                            x: f["x"] ?? 0, y: f["y"] ?? 0, w: w, h: h, area: w * h,
                            promoted: nowKss, focused: (n["focused"] as? Bool) ?? false,
                            selected: (n["selected"] as? Bool) ?? false))
    }
    if let kids = n["children"] as? [Any] {
        for c in kids { if let cd = c as? [String: Any] { collectTiles(cd, nowKss, &rows) } }
    }
}
func renderTileRows(_ tree: [String: Any]) -> String {
    var rows: [TileRow] = []
    collectTiles(tree, false, &rows)
    if rows.isEmpty { return "" }
    var out = "## PARTICIPANT TILE ROWS (.oZRSLe) — DOM order; ★=promoted(kssMZb ancestor)\n"
    out += "row  name                    x     y     w     h      area   promoted focused selected\n"
    for r in rows {
        out += String(format: "%-4d %-22@ %5.0f %5.0f %5.0f %5.0f %9.0f  %@ %@ %@\n",
                      r.idx, r.name.prefix(22).description, r.x, r.y, r.w, r.h, r.area,
                      (r.promoted ? "  ★YES " : "   -   "),
                      (r.focused ? "  YES  " : "   -   "),
                      (r.selected ? "  YES " : "   -  "))
    }
    let byArea = rows.sorted { $0.area > $1.area }
    if byArea.count >= 2 && byArea[1].area > 0 {
        let ratio = byArea[0].area / byArea[1].area
        out += String(format: "→ largest tile: \"%@\" (%.2fx the next). promoted tiles: %@\n",
                      byArea[0].name, ratio,
                      rows.filter { $0.promoted }.map { $0.name }.joined(separator: ", "))
    }
    return out + "\n"
}

// MARK: - Readable indented text view (with ROW / SUB-ROW markers)

final class RenderCtx { var tileNo = 0; var tileDepth = -1 }

func renderText(_ n: [String: Any], _ depth: Int, _ inKss: Bool, _ ctx: RenderCtx, into out: inout String) {
    let pad = String(repeating: "  ", count: depth)
    let nowKss = inKss || classesOf(n).contains("kssMZb")

    var tag = ""
    if isTileNode(n) {
        ctx.tileNo += 1; ctx.tileDepth = depth
        tag = "⟦TILE #\(ctx.tileNo) \"\(tileName(n))\"\(nowKss ? " ★PROMOTED" : "")⟧ "
    } else if ctx.tileDepth >= 0, depth > ctx.tileDepth, let k = subRowKind(n) {
        tag = "⟦·\(k)⟧ "
    }
    if ctx.tileDepth >= 0, depth <= ctx.tileDepth { ctx.tileDepth = -1 }

    var parts = [tag + (n["role"] as? String ?? "?")]
    if let s = n["subrole"] as? String { parts.append("[\(s)]") }
    if let id = n["domIdentifier"] as? String { parts.append("#\(id)") }
    if let cl = n["domClassList"] as? [String], !cl.isEmpty { parts.append("." + cl.joined(separator: ".")) }
    for k in ["title", "description", "value", "help"] {
        if let s = n[k] as? String { parts.append("\(k)=\"\(s.prefix(80))\"") }
    }
    if let f = n["frame"] as? [String: Double] {
        parts.append(String(format: "@(%.0f,%.0f %.0fx%.0f)", f["x"] ?? 0, f["y"] ?? 0, f["w"] ?? 0, f["h"] ?? 0))
    }
    for k in ["selected", "focused"] { if let b = n[k] as? Bool, b { parts.append(k) } }
    out += pad + parts.joined(separator: " ") + "\n"
    if let attrs = n["attributes"] as? [String: Any], !attrs.isEmpty {
        out += pad + "    all-attrs: " + attrs.keys.sorted().joined(separator: ", ") + "\n"
    }
    if let kids = n["children"] as? [Any] {
        for c in kids { if let cd = c as? [String: Any] { renderText(cd, depth + 1, nowKss, ctx, into: &out) } }
    }
}

// MARK: - Run

let df = DateFormatter()
df.dateFormat = "yyyyMMdd-HHmmss"
let stamp = df.string(from: Date())
let iso = ISO8601DateFormatter().string(from: Date())

let outDir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .appendingPathComponent("ax-dumps").appendingPathComponent(stamp)
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

print("\nDumping \(roots.count) root(s) → \(outDir.path)\n")

for root in roots {
    let w = Walker(maxNodes: maxNodes, maxDepth: maxDepth, skipWebArea: skipWebArea)
    let tree = w.node(root.el, 0)
    let payload: [String: Any] = [
        "meta": [
            "label": root.label, "note": root.note, "capturedAt": iso,
            "nodeCount": w.count, "truncated": w.truncated,
            "maxNodes": maxNodes, "maxDepth": maxDepth,
        ],
        "tree": tree,
    ]

    let jsonURL = outDir.appendingPathComponent("\(root.label).json")
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) {
        try? data.write(to: jsonURL)
    }

    var txt = "# \(root.label)\n# \(root.note)\n# \(w.count) nodes\(w.truncated ? " (TRUNCATED — raise --max-nodes/--depth)" : "")\n"
    txt += "# NOTE: SPEAKING state is NOT in the AX tree (the equalizer animation is pruned from AX).\n"
    txt += "# These rows expose what AX DOES carry: promoted(kssMZb) / focused / selected / geometry.\n"
    txt += "# For live speaking ground-truth, pair with the DOM capture (research/meet-dom-detector/live/pattern-capture.js).\n\n"
    txt += renderTileRows(tree)
    renderText(tree, 0, false, RenderCtx(), into: &txt)
    let txtURL = outDir.appendingPathComponent("\(root.label).txt")
    try? txt.write(to: txtURL, atomically: true, encoding: .utf8)

    print(String(format: "  • %-22@  %6d nodes%@  %@", root.label, w.count,
                 w.truncated ? " ⚠️trunc" : "       ", root.note.prefix(60).description))
    if alsoPrint { print(txt) }
}

print("\nDone. Open the .json for full per-node attributes (every AXDOMClassList,")
print("AXSelected, geometry, etc.); the .txt for a quick read. Diff two snapshots")
print("across talk/silence to find which per-tile feature moves with speech.")
