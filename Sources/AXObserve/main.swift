import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

// AXObserve — LIVE AX observer (event-driven, NOT a snapshot).
//
// Registers AXObserver notifications on a meeting app and prints a timestamped
// change log: aria-live region updates, screen-reader announcements, and
// value/title/selection changes on every node. A transient who-is-speaking signal
// — which a one-shot dump can't catch — surfaces here the instant it fires. This
// is the test that settles "does Teams expose who-is-speaking in AX?":
//
//   • If AXLiveRegionChanged / AXAnnouncementRequested (or a tile AXValueChanged)
//     fires in sync with WHO talks → it's AX-based & main-window-readable.
//   • If nothing AX fires while audio detection still works → it's VAD/audio.
//
//   swift run AXObserve [teams|zoom|meet] [seconds]
//   swift run AXObserve teams 20      # observe Teams for 20s while someone talks

setbuf(stdout, nil)

let args = Array(CommandLine.arguments.dropFirst())
let target = args.first(where: { ["teams", "zoom", "meet", "chrome"].contains($0.lowercased()) })?.lowercased() ?? "teams"
let secs: Double = args.compactMap { Double($0) }.first ?? 20

let browserIDs = ["com.google.Chrome", "com.apple.Safari", "com.microsoft.edgemac",
                  "com.brave.Browser", "company.thebrowser.Browser", "org.mozilla.firefox"]
func targetBundleIDs() -> [String] {
    switch target {
    case "teams": return ["com.microsoft.teams2", "com.microsoft.teams"]
    case "zoom":  return ["us.zoom.xos"]
    default:      return browserIDs
    }
}

guard AX.isTrusted else {
    print("Accessibility permission is NOT granted. Grant it in System Settings >")
    print("Privacy & Security > Accessibility for Terminal/your IDE, then re-run.")
    AX.requestTrust()
    exit(2)
}

guard let app = NSWorkspace.shared.runningApplications.first(where: {
    targetBundleIDs().contains($0.bundleIdentifier ?? "") && !$0.isTerminated
}) else {
    print("Target '\(target)' is not running. Open the meeting and re-run.")
    exit(1)
}

let pid = app.processIdentifier
let axApp = AXUIElementCreateApplication(pid)
AX.setBool(axApp, "AXManualAccessibility", true)        // force the full Chromium a11y tree
AX.setBool(axApp, "AXEnhancedUserInterface", true)
usleep(500_000)

// MARK: - Callback (C-compatible: a global func that captures nothing)

var startTime = Date()
var eventCount = 0

func axCallback(_ observer: AXObserver, _ element: AXUIElement,
                _ notif: CFString, _ info: CFDictionary, _ refcon: UnsafeMutableRawPointer?) {
    let n = notif as String
    let role = AX.string(element, "AXRole") ?? "?"
    var label = AX.string(element, "AXDescription") ?? ""
    if label.isEmpty { label = AX.string(element, "AXValue") ?? "" }
    if label.isEmpty { label = AX.string(element, "AXTitle") ?? "" }

    // Drop the meeting-clock churn — a "MM:SS"/"HH:MM:SS" label ticking every
    // second (fires via AXTitleChanged here, not only AXValueChanged).
    if label.range(of: #"^\d{1,2}:\d{2}(:\d{2})?$"#, options: .regularExpression) != nil { return }

    // Tag the two surfaces we care about.
    let classes = AX.classList(element)
    let live = AX.string(element, "AXARIALive") ?? ""
    var tag = "      "
    if (!live.isEmpty && live != "off") || classes.contains(where: { $0.lowercased().contains("arialive") }) {
        tag = "[LIVE]"
    } else if label.contains("Context menu") || label.contains("(Guest)") || label.lowercased().contains("myself video") {
        tag = "[TILE]"
    }

    // Announcement / live-region payload (the speaking string would be here).
    var extra = ""
    let d = info as NSDictionary
    if d.count > 0 {
        let parts = d.map { "\($0.key)=\(String(describing: $0.value).prefix(70))" }
        extra = "  {" + parts.joined(separator: ", ") + "}"
    }

    eventCount += 1
    let t = Date().timeIntervalSince(startTime)
    print(String(format: "t=%5.1fs %@ %-26@ [%@] %@%@",
                 t, tag, n, role, String(label.prefix(70)), extra))
}

var observer: AXObserver?
guard AXObserverCreateWithInfoCallback(pid, axCallback, &observer) == .success, let obs = observer else {
    print("Failed to create AXObserver.")
    exit(1)
}

// MARK: - Register notifications

// App-level: announcements + live-region lifecycle + focus/layout/selection.
let appLevel = ["AXAnnouncementRequested", "AXLiveRegionChanged", "AXLiveRegionCreated",
                "AXFocusedUIElementChanged", "AXLayoutChanged", "AXSelectedChildrenChanged",
                "AXMenuOpened", "AXMenuItemSelected"]
for nm in appLevel { AXObserverAddNotification(obs, axApp, nm as CFString, nil) }

// Per-node: value/title/live/selection/destroy on EVERY element (a tile description
// or an aria-live region updating fires on its own element, not the app).
let perNode = ["AXValueChanged", "AXTitleChanged", "AXLiveRegionChanged",
               "AXSelectedChildrenChanged", "AXUIElementDestroyed", "AXLayoutChanged"]
var registered = 0
func walk(_ el: AXUIElement, _ depth: Int) {
    if depth > 300 { return }
    for nm in perNode where AXObserverAddNotification(obs, el, nm as CFString, nil) == .success { registered += 1 }
    for c in AX.allChildren(el) { walk(c, depth + 1) }
}
for w in AX.windows(axApp) { walk(w, 0) }

CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), .commonModes)

print("Observing \(app.localizedName ?? target) for \(Int(secs))s — \(registered) node hooks + \(appLevel.count) app hooks.")
print("👉 NARRATE who speaks (e.g. \"David 0-10s, me 10-20s\"). Keep the mouse STILL.")
print("Legend: [LIVE]=aria-live region   [TILE]=participant tile/roster row\n")

startTime = Date()
CFRunLoopRunInMode(.defaultMode, secs, false)

print("\n──────────────────────────────────────────────────────────")
print("Done. \(eventCount) AX events in \(Int(secs))s.")
print("• If [LIVE]/[TILE] lines fired in sync with WHO talked (a name + speaking,")
print("  or an announcement string) → Teams DOES expose speaking in AX → wire it.")
print("• If nothing fired with speech (only clock/focus noise) → it's VAD/audio;")
print("  matching Recall means running VAD, not scraping AX.")
