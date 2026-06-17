import Foundation
import AppKit
import ApplicationServices
import SpeakerCore

/// One meeting window observed during a scan.
struct ScannedWindow {
    var platform: Platform
    var title: String
    var nodeCount: Int
    var treeOk: Bool
    /// Names whose tile/element carried a "speaking" marker this scan.
    var speakers: [String]
    /// All candidate participant names seen in the window.
    var participants: [String]
    /// Best-effort local mute read: true = unmuted, false = muted, nil = unknown.
    var localUserUnmuted: Bool?
}

/// The macOS equivalent of the original's Windows UI Automation engine.
///
/// Walks the Accessibility (AX) tree of running meeting apps / browser meeting
/// tabs to find who is speaking. Like the original this is platform-specific
/// and best-effort: when names can't be read it still reports the window so the
/// audio path can log a "Someone" session. Requires Accessibility permission.
final class AccessibilityScanner {

    // Native meeting apps keyed by bundle id.
    private static let nativeApps: [String: Platform] = [
        "us.zoom.xos": .zoom,
        "com.microsoft.teams2": .teams,
        "com.microsoft.teams": .teams,
        "com.microsoft.teams2.helper": .teams,
    ]

    // Browsers whose window titles we inspect to detect a web meeting.
    private static let browserBundleIDs: Set<String> = [
        "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary",
        "com.apple.Safari", "com.apple.SafariTechnologyPreview",
        "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser",
        "org.mozilla.firefox", "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
    ]

    private let maxNodesPerWindow = 6000
    private let maxDepth = 80

    // MARK: Permission

    static var isTrusted: Bool { AXIsProcessTrusted() }

    /// Prompts (once) for Accessibility permission if not yet granted.
    static func requestAccessIfNeeded() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    // MARK: Scan

    func scan() -> [ScannedWindow] {
        guard AXIsProcessTrusted() else { return [] }
        var results: [ScannedWindow] = []

        for app in NSWorkspace.shared.runningApplications {
            guard let bundleID = app.bundleIdentifier, !app.isTerminated else { continue }
            let isNative = Self.nativeApps[bundleID] != nil
            let isBrowser = Self.browserBundleIDs.contains(bundleID)
            guard isNative || isBrowser else { continue }

            let axApp = AXUIElementCreateApplication(app.processIdentifier)
            for window in axArray(axApp, "AXWindows") {
                let title = axString(window, "AXTitle") ?? ""
                guard let platform = Self.platform(forNative: bundleID, windowTitle: title) else { continue }

                var collector = TreeCollector()
                walk(window, depth: 0, into: &collector)

                // A browser/WebView tree that came back empty means names are
                // unavailable (audio detection still works); native Zoom's tiny
                // tree is normal and reports OK.
                let treeOk = isNative ? true : collector.nodeCount > 8

                results.append(ScannedWindow(
                    platform: platform,
                    title: title.isEmpty ? platform.label : title,
                    nodeCount: collector.nodeCount,
                    treeOk: treeOk,
                    speakers: dedup(collector.speakers),
                    participants: dedup(collector.participants),
                    localUserUnmuted: collector.localUserUnmuted
                ))
            }
        }
        return results
    }

    // MARK: Platform resolution

    private static func platform(forNative bundleID: String, windowTitle: String) -> Platform? {
        if let native = nativeApps[bundleID] { return native }
        // Browser: infer from the tab/window title.
        let t = windowTitle.lowercased()
        if t.contains("google meet") || t.contains("meet.google") || t.contains("- meet") { return .meet }
        if t.contains("zoom") { return .zoom }
        if t.contains("microsoft teams") || t.contains("| teams") || t.contains("- teams") { return .teams }
        return nil
    }

    // MARK: Tree walk

    private struct TreeCollector {
        var nodeCount = 0
        var speakers: [String] = []
        var participants: [String] = []
        var localUserUnmuted: Bool?
    }

    private func walk(_ element: AXUIElement, depth: Int, into c: inout TreeCollector) {
        if c.nodeCount >= maxNodesPerWindow || depth > maxDepth { return }
        c.nodeCount += 1

        let title = axString(element, "AXTitle")
        let desc = axString(element, "AXDescription")
        let value = axString(element, "AXValue")
        let combined = [title, desc, value].compactMap { $0 }.joined(separator: " ")
        if !combined.isEmpty {
            classify(title: title, desc: desc, value: value, combined: combined, into: &c)
        }

        for child in axArray(element, "AXChildren") {
            walk(child, depth: depth + 1, into: &c)
            if c.nodeCount >= maxNodesPerWindow { break }
        }
    }

    /// Turns one element's accessibility text into participant/speaker signals,
    /// using the real platform formats discovered via `swift run AXDump` — e.g.
    /// Zoom web exposes the active speaker as an AXDescription like
    /// "Bidheyak Thapa, Computer audio unmuted, active speaker". Name parsing
    /// lives in SpeakerCore so it can be unit-tested.
    private func classify(title: String?, desc: String?, value: String?, combined: String, into c: inout TreeCollector) {
        let lower = combined.lowercased()

        // Local mute state. Zoom web's control reads "unmute my microphone"
        // while you are muted, "mute my microphone" while unmuted.
        if lower.contains("unmute my") || lower.contains("unmute (") || lower == "unmute" {
            c.localUserUnmuted = false
        } else if lower.contains("mute my") || lower.contains("mute (") || lower == "mute" {
            c.localUserUnmuted = true
        }

        let speaking = isSpeakingMarker(combined)

        var name: String?
        for text in [desc, title, value] {
            if let raw = text, let clean = cleanParticipantName(raw) {
                name = clean
                break
            }
        }

        if let name {
            c.participants.append(name)
            if speaking { c.speakers.append(name) }
        }
        // A speaking marker with no readable name is intentionally NOT recorded
        // here. The engine only falls back to "Someone" when the whole tree is
        // unreadable (audio-only), so we never fabricate it when names exist.
    }

    private func dedup(_ xs: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for x in xs {
            let t = x.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty || seen.contains(t) { continue }
            seen.insert(t)
            out.append(t)
        }
        return out
    }

    // MARK: AX helpers

    private func axString(_ el: AXUIElement, _ attr: String) -> String? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
        return v as? String
    }

    private func axArray(_ el: AXUIElement, _ attr: String) -> [AXUIElement] {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return [] }
        return (v as? [AXUIElement]) ?? []
    }
}
