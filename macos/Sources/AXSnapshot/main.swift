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
//   chrome  — the meeting browser tab's AXWebArea (Meet / Zoom-web / Teams-web)
//   zoom    — native Zoom (us.zoom.xos), every window
//   teams   — native Teams (com.microsoft.teams2 / .teams), every window
//   all     — every target currently running (default)
//
//   swift run AXSnapshot                         # every running target
//   swift run AXSnapshot chrome                  # just the meeting browser tab
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
// NO depth limit by default — the walk follows the tree to its natural leaves and
// returns ALL nodes. Pass --depth N to cap it. maxNodes is only a runaway backstop
// (against a pathological/cyclic native tree), set far above any real app.
let maxNodes = intFlag("--max-nodes", 1_000_000)
let maxDepth = intFlag("--depth", Int.max)
let alsoPrint = args.contains("--print")

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

let knownTargets: Set<String> = ["all", "chrome", "meet", "browser", "web", "zoom", "teams"]
let rawTarget = args.first(where: { knownTargets.contains($0.lowercased()) })?.lowercased() ?? "all"
let target = (rawTarget == "meet" || rawTarget == "browser" || rawTarget == "web") ? "chrome" : rawTarget

let wantsChrome = (target == "all" || target == "chrome")
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
    AX.setBool(ax, "AXManualAccessibility", true)
    AX.setBool(ax, "AXEnhancedUserInterface", true)
    targetApps.append(TargetApp(kind: kind, name: app.localizedName ?? id, ax: ax))
}

if targetApps.isEmpty {
    print("No matching app is running for target '\(target)'.")
    print("Open the meeting (Chrome tab / native Zoom / native Teams) and re-run.")
    exit(1)
}

print("Forcing full a11y tree on: \(targetApps.map { "\($0.name) [\($0.kind)]" }.joined(separator: ", "))")
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
for t in targetApps {
    switch t.kind {
    case "chrome":
        // Root each dump at a web area (the "Chrome tab" tree), not the whole
        // browser window — skips the browser chrome. Capture EVERY web area in
        // EVERY window, with its owning window title, so the document-PIP window
        // (a separate top-level window whose web area carries NO meet URL) is
        // dumped too — that's where a popped-out meeting's tiles live.
        struct WebRoot { let el: AXUIElement; let url: String; let winTitle: String }
        var found: [WebRoot] = []
        for win in AX.windows(t.ax) {
            let wt = AX.string(win, "AXTitle") ?? ""
            var budget = 8000
            for area in findWebAreas(win, 0, &budget) {
                let url = AX.urlString(area, "AXURL") ?? AX.string(area, "AXValue") ?? ""
                found.append(WebRoot(el: area, url: url, winTitle: wt))
            }
        }
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
                    ? "window: \(a.winTitle.isEmpty ? "(untitled — PIP?)" : a.winTitle)"
                    : a.url
                roots.append(Root(label: "chrome-other\(i + 1)", note: note, el: a.el))
            }
            if meeting.isEmpty {
                print("⚠️  No meeting tab found — dumping \(min(others.count, 8)) other web area(s), incl. any PIP window.")
            }
        }
        if found.isEmpty {
            print("⚠️  \(t.name): no web area found. Open Meet/Zoom-web/Teams-web in a tab.")
        }

    case "zoom", "teams":
        // Native: dump every window in full (the meeting + the Participants panel
        // are often separate windows; the user wants all of it).
        let wins = AX.windows(t.ax)
        if wins.isEmpty {
            print("⚠️  \(t.name): no windows exposed.")
        }
        for (i, win) in wins.enumerated() {
            let title = AX.string(win, "AXTitle") ?? "(untitled)"
            roots.append(Root(label: "\(t.kind)-native-win\(i + 1)", note: title, el: win))
        }

    default: break
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
    var count = 0
    var truncated = false
    init(maxNodes: Int, maxDepth: Int) { self.maxNodes = maxNodes; self.maxDepth = maxDepth }

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

// MARK: - Readable indented text view

func renderText(_ n: [String: Any], _ depth: Int, into out: inout String) {
    let pad = String(repeating: "  ", count: depth)
    var parts = [n["role"] as? String ?? "?"]
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
        for c in kids { if let cd = c as? [String: Any] { renderText(cd, depth + 1, into: &out) } }
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
    let w = Walker(maxNodes: maxNodes, maxDepth: maxDepth)
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

    var txt = "# \(root.label)\n# \(root.note)\n# \(w.count) nodes\(w.truncated ? " (TRUNCATED — raise --max-nodes/--depth)" : "")\n\n"
    renderText(tree, 0, into: &txt)
    let txtURL = outDir.appendingPathComponent("\(root.label).txt")
    try? txt.write(to: txtURL, atomically: true, encoding: .utf8)

    print(String(format: "  • %-22@  %6d nodes%@  %@", root.label, w.count,
                 w.truncated ? " ⚠️trunc" : "       ", root.note.prefix(60).description))
    if alsoPrint { print(txt) }
}

print("\nDone. Open the .json for full per-node attributes (every AXDOMClassList,")
print("AXSelected, geometry, etc.); the .txt for a quick read. Diff two snapshots")
print("across talk/silence to find which per-tile feature moves with speech.")
