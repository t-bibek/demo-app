import Foundation
import AppKit
import ApplicationServices
import AXKit

// Minimal AX driver for the LIVE Teams QA rig (qa/teams-live/run-teams-live-qa.mjs):
// finds an element in the native Teams window by description/title substring and
// presses it, resizes the window, or lists what's visible — so the layout ×
// participant matrix can be driven headlessly, no AppleScript. Read-only except
// for AXPress / AXSize on the one matched element. Output is one parseable line
// per action (PRESSED / NOT_FOUND / WINDOW …); exit 0 only on success.
//
//   swift run TeamsDrive press "Mute mic" [--role AXButton] [--exact]
//   swift run TeamsDrive find  "context menu"
//   swift run TeamsDrive windows
//   swift run TeamsDrive resize 500 400
//   swift run TeamsDrive raise

let bundleIDs = ["com.microsoft.teams2", "com.microsoft.teams"]

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
    exit(1)
}

guard CommandLine.arguments.count >= 2 else {
    fail("usage: TeamsDrive press|find|windows|resize|raise …")
}
let cmd = CommandLine.arguments[1]
var args = Array(CommandLine.arguments.dropFirst(2))
var roleFilter: String? = nil
var exact = false
if let i = args.firstIndex(of: "--role"), i + 1 < args.count {
    roleFilter = args[i + 1]
    args.removeSubrange(i...(i + 1))
}
if let i = args.firstIndex(of: "--exact") { exact = true; args.remove(at: i) }

guard AXIsProcessTrusted() else { fail("NOT_TRUSTED: grant Accessibility to this terminal") }

guard let app = NSWorkspace.shared.runningApplications.first(where: {
    bundleIDs.contains($0.bundleIdentifier ?? "")
}) else { fail("NOT_RUNNING: Teams (com.microsoft.teams2) is not running") }

let axApp = AXUIElementCreateApplication(app.processIdentifier)
AXKit.forceFullAXTree(pid: app.processIdentifier)

struct Match {
    let el: AXUIElement
    let role: String
    let text: String
    let window: String
}

/// Every element whose AXDescription/AXTitle contains (or equals) `needle`.
func findAll(_ needle: String) -> [Match] {
    let want = needle.lowercased()
    var out: [Match] = []
    for window in AXKit.axArray(axApp, "AXWindows") {
        let winTitle = AXKit.axString(window, "AXTitle") ?? ""
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if n >= 20_000 || depth > 90 { return }
            n += 1
            let role = AXKit.axString(el, "AXRole") ?? ""
            if roleFilter == nil || role == roleFilter {
                for attr in ["AXDescription", "AXTitle"] {
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

switch cmd {
case "raise":
    AXKit.forceActivateForCapture(pid: app.processIdentifier)
    print("RAISED pid=\(app.processIdentifier)")

case "windows":
    for window in AXKit.axArray(axApp, "AXWindows") {
        let t = AXKit.axString(window, "AXTitle") ?? ""
        let f = AXKit.axFrame(window) ?? .zero
        print("WINDOW title=\"\(t)\" w=\(Int(f.width)) h=\(Int(f.height))")
    }

case "resize":
    guard args.count >= 2, let w = Double(args[0]), let h = Double(args[1]) else {
        fail("usage: TeamsDrive resize <w> <h>")
    }
    guard let window = AXKit.axArray(axApp, "AXWindows").first else { fail("NOT_FOUND: no window") }
    var size = CGSize(width: w, height: h)
    let value = AXValueCreate(.cgSize, &size)!
    let err = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value)
    guard err == .success else { fail("RESIZE_FAILED: \(err.rawValue)") }
    print("RESIZED \(Int(w))x\(Int(h))")

case "find":
    guard let needle = args.first else { fail("usage: TeamsDrive find <substring>") }
    let matches = findAll(needle)
    for m in matches {
        print("MATCH role=\(m.role) text=\"\(m.text)\" window=\"\(m.window)\"")
    }
    if matches.isEmpty { print("NOT_FOUND \"\(needle)\""); exit(1) }

case "press":
    guard let needle = args.first else { fail("usage: TeamsDrive press <substring>") }
    // Activate first so WebView2 materializes live state, then press the best
    // match (exact text beats substring; earlier window beats later).
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

default:
    fail("unknown command \(cmd)")
}
