import Foundation
import AppKit
import ApplicationServices

// AX tree dumper -- the macOS equivalent of the original's `npm run dump`.
// Prints the accessibility tree of detected meeting windows so we can see what
// (if anything) Zoom / Meet / Teams expose for participant names and speaking
// state, and tune AccessibilityScanner accordingly.
//
//   swift run AXDump            # all meeting windows
//   swift run AXDump zoom       # only windows whose app/title matches "zoom"
//   swift run AXDump --all      # every app's windows (very noisy)

let args = Array(CommandLine.arguments.dropFirst())
let dumpAll = args.contains("--all")
let filter = args.first(where: { !$0.hasPrefix("--") })?.lowercased()

let maxDepth = 70
let nodeBudgetPerWindow = 6000

let nativeApps: [String: String] = [
    "us.zoom.xos": "zoom",
    "com.microsoft.teams2": "teams",
    "com.microsoft.teams": "teams",
]
let browserIDs: Set<String> = [
    "com.google.Chrome", "com.apple.Safari", "com.microsoft.edgemac",
    "com.brave.Browser", "company.thebrowser.Browser", "org.mozilla.firefox",
    "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
]

func axString(_ el: AXUIElement, _ attr: String) -> String? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
    return v as? String
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, "AXChildren" as CFString, &v) == .success else { return [] }
    return (v as? [AXUIElement]) ?? []
}

func dump(_ el: AXUIElement, depth: Int, budget: inout Int) {
    if depth > maxDepth || budget <= 0 { return }
    budget -= 1

    let role = axString(el, "AXRole") ?? "?"
    var parts = [role]
    if let sub = axString(el, "AXSubrole") { parts.append("[\(sub)]") }
    for (label, attr) in [("title", "AXTitle"), ("desc", "AXDescription"),
                          ("value", "AXValue"), ("help", "AXHelp"),
                          ("roleDesc", "AXRoleDescription")] {
        if let s = axString(el, attr), !s.isEmpty {
            parts.append("\(label)=\"\(s.prefix(80))\"")
        }
    }
    print(String(repeating: "  ", count: depth) + parts.joined(separator: " "))

    for child in axChildren(el) {
        dump(child, depth: depth + 1, budget: &budget)
        if budget <= 0 { print(String(repeating: "  ", count: depth + 1) + "... (node budget reached)"); break }
    }
}

// --- main ---

guard AXIsProcessTrusted() else {
    print("Accessibility permission is NOT granted.")
    print("Grant it in System Settings > Privacy & Security > Accessibility for the")
    print("process running this tool (Terminal / your IDE), then re-run.")
    _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    exit(2)
}

var dumped = 0
for app in NSWorkspace.shared.runningApplications {
    guard let bundleID = app.bundleIdentifier, !app.isTerminated else { continue }
    let platform = nativeApps[bundleID]
    let isBrowser = browserIDs.contains(bundleID)
    guard dumpAll || platform != nil || isBrowser else { continue }

    let appName = app.localizedName ?? bundleID
    let axApp = AXUIElementCreateApplication(app.processIdentifier)

    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, "AXWindows" as CFString, &v) == .success,
          let windows = v as? [AXUIElement] else { continue }

    for window in windows {
        let title = axString(window, "AXTitle") ?? ""
        let haystack = "\(appName) \(title) \(platform ?? "")".lowercased()
        if let f = filter, !haystack.contains(f) { continue }
        // For browsers, only bother with windows that look like a meeting.
        if dumpAll == false && platform == nil {
            let t = title.lowercased()
            guard t.contains("meet") || t.contains("zoom") || t.contains("teams") else { continue }
        }

        print("\n========================================================")
        print("APP: \(appName)  [\(bundleID)]")
        print("WINDOW: \"\(title)\"")
        print("========================================================")
        var budget = nodeBudgetPerWindow
        dump(window, depth: 0, budget: &budget)
        print("(scanned \(nodeBudgetPerWindow - budget) nodes)")
        dumped += 1
    }
}

if dumped == 0 {
    print("No matching meeting windows found.")
    print("Open Zoom/Meet/Teams in a meeting and re-run. Filter example: swift run AXDump zoom")
}
