import Foundation
import AppKit
import ApplicationServices
import AXKit
import SpeakerCore

// Minimal AX driver for the LIVE native-Zoom QA rig (qa/zoom-live/
// run-zoom-live-qa.mjs) — the TeamsDrive analog plus what Zoom needs: menu-bar
// item selection (View → Speaker/Gallery, Meeting → Mute Audio…), window
// minimize/restore, meeting/PIP window classification (via the SHIPPING
// SpeakerCore extractor, so the rig and the detector can never disagree about
// what a window is), and invite-URL harvest. Read-only except AXPress /
// AXMinimized on the matched element. One parseable line per action; exit 0
// only on success.
//
//   swift run ZoomDrive windows
//   swift run ZoomDrive raise
//   swift run ZoomDrive find  "computer audio" [--role AXImage] [--exact] [--window "Zoom Meeting"]
//   swift run ZoomDrive press "New meeting"    [--role AXButton] [--exact] [--window <titleSubstr>]
//   swift run ZoomDrive menu  View "Gallery View"      (or: menu --list)
//   swift run ZoomDrive minimize [--window <t>] / restore [--window <t>]
//   swift run ZoomDrive harvest-url

let zoomBundleID = "us.zoom.xos"

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
    exit(1)
}

guard CommandLine.arguments.count >= 2 else {
    fail("usage: ZoomDrive windows|raise|find|press|menu|minimize|restore|harvest-url …")
}
let cmd = CommandLine.arguments[1]
var args = Array(CommandLine.arguments.dropFirst(2))
var roleFilter: String? = nil
var windowFilter: String? = nil
var exact = false
if let i = args.firstIndex(of: "--role"), i + 1 < args.count {
    roleFilter = args[i + 1]
    args.removeSubrange(i...(i + 1))
}
if let i = args.firstIndex(of: "--window"), i + 1 < args.count {
    windowFilter = args[i + 1].lowercased()
    args.removeSubrange(i...(i + 1))
}
if let i = args.firstIndex(of: "--exact") { exact = true; args.remove(at: i) }

guard AXIsProcessTrusted() else { fail("NOT_TRUSTED: grant Accessibility to this terminal") }

guard let app = NSWorkspace.shared.runningApplications.first(where: {
    $0.bundleIdentifier == zoomBundleID
}) else { fail("NOT_RUNNING: Zoom (us.zoom.xos) is not running") }

let axApp = AXUIElementCreateApplication(app.processIdentifier)
AXKit.forceFullAXTree(pid: app.processIdentifier)
let rules = ZoomSpeakerRules.resolved()

func axBool(_ el: AXUIElement, _ attr: String) -> Bool? {
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &ref) == .success,
          let b = ref as? Bool else { return nil }
    return b
}

/// Bounded AX → platform-free node conversion (the detector's windowNode twin)
/// so classification runs the SAME zoomExtractWindow the scanner ships.
func windowNode(_ window: AXUIElement) -> ZoomAXNode {
    var visited = 0
    func rec(_ el: AXUIElement, _ depth: Int) -> ZoomAXNode {
        visited += 1
        let frame = AXKit.axFrame(el)
        var children: [ZoomAXNode] = []
        if visited < 20_000 && depth < 90 {
            for c in AXKit.axArray(el, "AXChildren") {
                if visited >= 20_000 { break }
                children.append(rec(c, depth + 1))
            }
        }
        return ZoomAXNode(
            role: AXKit.axString(el, "AXRole"), subrole: AXKit.axString(el, "AXSubrole"),
            roleDescription: AXKit.axString(el, "AXRoleDescription"),
            desc: AXKit.axString(el, "AXDescription"), title: AXKit.axString(el, "AXTitle"),
            value: AXKit.axString(el, "AXValue"), help: AXKit.axString(el, "AXHelp"),
            x: frame.map { Double($0.minX) }, y: frame.map { Double($0.minY) },
            w: frame.map { Double($0.width) }, h: frame.map { Double($0.height) },
            children: children)
    }
    return rec(window, 0)
}

func windowsMatchingFilter() -> [AXUIElement] {
    AXKit.axArray(axApp, "AXWindows").filter { w in
        guard let f = windowFilter else { return true }
        return (AXKit.axString(w, "AXTitle") ?? "").lowercased().contains(f)
    }
}

struct Match {
    let el: AXUIElement
    let role: String
    let text: String
    let window: String
}

/// Every element whose AXDescription/AXTitle contains (or equals) `needle`,
/// optionally scoped by --role / --window.
func findAll(_ needle: String) -> [Match] {
    let want = needle.lowercased()
    var out: [Match] = []
    for window in windowsMatchingFilter() {
        let winTitle = AXKit.axString(window, "AXTitle") ?? ""
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if n >= 20_000 || depth > 90 { return }
            n += 1
            let role = AXKit.axString(el, "AXRole") ?? ""
            if roleFilter == nil || role == roleFilter {
                for attr in ["AXDescription", "AXTitle", "AXValue"] {
                    guard let s = AXKit.axString(el, attr), !s.isEmpty else { continue }
                    let low = s.lowercased()
                    if exact ? low == want : low.contains(want) {
                        out.append(Match(el: el, role: role, text: s, window: winTitle))
                        break
                    }
                }
            }
            for c in AXKit.axArray(el, "AXChildren") { rec(c, depth + 1) }
        }
        rec(window, 0)
    }
    return out
}

/// The app's menu bar as (bar item, its AXMenu) pairs.
func menuBarItems() -> [(title: String, item: AXUIElement)] {
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, "AXMenuBar" as CFString, &ref) == .success,
          let bar = ref, CFGetTypeID(bar as CFTypeRef) == AXUIElementGetTypeID() else { return [] }
    let barEl = bar as! AXUIElement
    return AXKit.axArray(barEl, "AXChildren").map {
        (AXKit.axString($0, "AXTitle") ?? "", $0)
    }
}

func menuChildren(_ item: AXUIElement) -> [AXUIElement] {
    // A menu-bar item's single AXMenu child holds the AXMenuItems.
    AXKit.axArray(item, "AXChildren").flatMap { AXKit.axArray($0, "AXChildren") }
}

switch cmd {
case "raise":
    AXKit.forceActivateForCapture(pid: app.processIdentifier)
    print("RAISED pid=\(app.processIdentifier)")

case "windows":
    // Classify each window with the SHIPPING extractor: meeting evidence,
    // roster visibility ("computer audio" text), PIP, minimized.
    for window in AXKit.axArray(axApp, "AXWindows") {
        let t = AXKit.axString(window, "AXTitle") ?? ""
        let f = AXKit.axFrame(window) ?? .zero
        let ex = zoomExtractWindow(windowNode(window), rules: rules)
        let meeting = ex.titleIsMeeting || ex.callActive || !ex.roster.isEmpty || ex.isPip
        let minimized = axBool(window, "AXMinimized") ?? false
        print("WINDOW title=\"\(t)\" w=\(Int(f.width)) h=\(Int(f.height))"
            + " minimized=\(minimized ? 1 : 0)"
            + " meeting=\(meeting ? "YES" : "no")"
            + " computerAudio=\(ex.roster.isEmpty ? "no" : "YES")"
            + " roster=\(ex.roster.count)"
            + " pip=\(ex.isPip ? "YES" : "no")")
    }

case "find":
    guard let needle = args.first else { fail("usage: ZoomDrive find <substring>") }
    let matches = findAll(needle)
    for m in matches {
        print("MATCH role=\(m.role) text=\"\(m.text)\" window=\"\(m.window)\"")
    }
    if matches.isEmpty { print("NOT_FOUND \"\(needle)\""); exit(1) }

case "press":
    guard let needle = args.first else { fail("usage: ZoomDrive press <substring>") }
    // Activate first so the control is pressable, then press the best match
    // (exact text beats substring; earlier window beats later).
    AXKit.forceActivateForCapture(pid: app.processIdentifier)
    usleep(400_000)
    let matches = findAll(needle)
    guard let m = matches.first(where: { $0.text.lowercased() == needle.lowercased() }) ?? matches.first else {
        print("NOT_FOUND \"\(needle)\"")
        exit(1)
    }
    let err = AXUIElementPerformAction(m.el, kAXPressAction as CFString)
    guard err == .success else { fail("PRESS_FAILED role=\(m.role) text=\"\(m.text)\" err=\(err.rawValue)") }
    print("PRESSED role=\(m.role) text=\"\(m.text)\" window=\"\(m.window)\"")

case "menu":
    // menu --list  → dump the whole tree (runtime label discovery for the rig).
    // menu <top> <item> [<subitem>] → press it (substring match per level).
    if args.first == "--list" {
        for (title, item) in menuBarItems() {
            print("MENU \(title)")
            for mi in menuChildren(item) {
                let t = AXKit.axString(mi, "AXTitle") ?? ""
                if t.isEmpty { continue }
                print("  ITEM \(t)")
                for sub in menuChildren(mi) {
                    let st = AXKit.axString(sub, "AXTitle") ?? ""
                    if !st.isEmpty { print("    SUB \(st)") }
                }
            }
        }
        exit(0)
    }
    guard args.count >= 2 else { fail("usage: ZoomDrive menu <top> <item> [<subitem>] | menu --list") }
    let wantTop = args[0].lowercased()
    let wantItem = args[1].lowercased()
    let wantSub = args.count >= 3 ? args[2].lowercased() : nil
    // Menu items act on the FRONTMOST Zoom window — raise first.
    AXKit.forceActivateForCapture(pid: app.processIdentifier)
    usleep(400_000)
    guard let (_, top) = menuBarItems().first(where: { $0.title.lowercased().contains(wantTop) }) else {
        print("MENU_NOT_FOUND top=\"\(args[0])\"")
        exit(1)
    }
    guard let item = menuChildren(top).first(where: {
        (AXKit.axString($0, "AXTitle") ?? "").lowercased().contains(wantItem)
    }) else {
        print("MENU_NOT_FOUND item=\"\(args[1])\" in \"\(args[0])\"")
        exit(1)
    }
    var target = item
    if let wantSub {
        guard let sub = menuChildren(item).first(where: {
            (AXKit.axString($0, "AXTitle") ?? "").lowercased().contains(wantSub)
        }) else {
            print("MENU_NOT_FOUND sub=\"\(args[2])\" in \"\(args[0])/\(args[1])\"")
            exit(1)
        }
        target = sub
    }
    let err = AXUIElementPerformAction(target, kAXPressAction as CFString)
    guard err == .success else { fail("MENU_PRESS_FAILED \(args.joined(separator: "/")) err=\(err.rawValue)") }
    print("MENU_PRESSED \(args.joined(separator: "/"))")

case "minimize", "restore":
    let wantMin = (cmd == "minimize")
    // Default to the meeting window (never the home shell) when no --window.
    let candidates = windowsMatchingFilter()
    let target = windowFilter != nil ? candidates.first
        : candidates.first(where: {
            let ex = zoomExtractWindow(windowNode($0), rules: rules)
            return ex.titleIsMeeting || ex.callActive || !ex.roster.isEmpty
        }) ?? candidates.first
    guard let window = target else { fail("NOT_FOUND: no matching window") }
    let err = AXUIElementSetAttributeValue(window, "AXMinimized" as CFString,
                                           (wantMin ? kCFBooleanTrue : kCFBooleanFalse) as CFTypeRef)
    guard err == .success else { fail("\(cmd.uppercased())_FAILED err=\(err.rawValue)") }
    print("\(cmd.uppercased())D title=\"\(AXKit.axString(window, "AXTitle") ?? "")\"")

case "harvest-url":
    // The invite dialog / meeting-info popover carry the join URL as literal
    // text — the web-guest rig converts it to the app.zoom.us/wc client URL.
    let pattern = #"https://[a-z0-9.-]*zoom\.us/j/\d+\?pwd=[A-Za-z0-9._-]+"#
    var found: String?
    for window in AXKit.axArray(axApp, "AXWindows") {
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if found != nil || n >= 20_000 || depth > 90 { return }
            n += 1
            for attr in ["AXValue", "AXDescription", "AXTitle", "AXHelp"] {
                guard let s = AXKit.axString(el, attr), !s.isEmpty else { continue }
                if let r = s.range(of: pattern, options: [.regularExpression, .caseInsensitive]) {
                    found = String(s[r])
                    return
                }
            }
            for c in AXKit.axArray(el, "AXChildren") { rec(c, depth + 1) }
        }
        rec(window, 0)
        if found != nil { break }
    }
    guard let url = found else { print("URL_NOT_FOUND"); exit(1) }
    print("URL \(url)")

default:
    fail("unknown command \(cmd)")
}
