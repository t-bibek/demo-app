import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
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
                guard var platform = Self.platform(forNative: bundleID, windowTitle: title) else { continue }

                var collector = TreeCollector()
                walk(window, depth: 0, into: &collector)

                // The page URL (from the address bar) is the most reliable
                // signal; let it override the title-based guess.
                if let urlPlatform = platformForURL(collector.url) { platform = urlPlatform }

                // A browser/WebView tree that came back empty means names are
                // unavailable (audio detection still works); native Zoom's tiny
                // tree is normal and reports OK.
                let treeOk = isNative ? true : collector.nodeCount > 8

                // Google Meet exposes the active speaker as a per-tile CSS class
                // (kssMZb) via AXDOMClassList — not as a text marker the generic
                // walk catches — so run a dedicated per-tile pass for Meet.
                var speakers = dedup(collector.speakers)
                var participants = dedup(collector.participants)
                if platform == .meet {
                    let m = meetSpeakingNames(in: window)
                    speakers = m.speakers
                    participants = dedup(participants + m.participants)
                }

                results.append(ScannedWindow(
                    platform: platform,
                    title: title.isEmpty ? platform.label : title,
                    nodeCount: collector.nodeCount,
                    treeOk: treeOk,
                    speakers: speakers,
                    participants: participants,
                    localUserUnmuted: collector.localUserUnmuted
                ))
            }
        }
        return results
    }

    // MARK: Platform resolution

    private static func platform(forNative bundleID: String, windowTitle: String) -> Platform? {
        if let native = nativeApps[bundleID] { return native }
        // Browser: infer from the tab/window title (URL confirms it later).
        return platformForBrowserTitle(windowTitle)
    }

    // MARK: Tree walk

    private struct TreeCollector {
        var nodeCount = 0
        var speakers: [String] = []
        var participants: [String] = []
        var localUserUnmuted: Bool?
        var url: String?
    }

    private func walk(_ element: AXUIElement, depth: Int, into c: inout TreeCollector) {
        if c.nodeCount >= maxNodesPerWindow || depth > maxDepth { return }
        c.nodeCount += 1

        let title = axString(element, "AXTitle")
        let desc = axString(element, "AXDescription")
        let value = axString(element, "AXValue")
        let combined = [title, desc, value].compactMap { $0 }.joined(separator: " ")
        if !combined.isEmpty {
            // Capture the page URL (browser address bar) for reliable platform ID.
            if c.url == nil {
                for s in [value, desc, title].compactMap({ $0 }) {
                    if s.contains("meet.google.com") || s.contains("zoom.us")
                        || s.contains("teams.microsoft.com") || s.contains("teams.live.com") {
                        c.url = s
                        break
                    }
                }
            }
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
        // while you are muted, "mute my microphone" while unmuted. Google Meet
        // uses "Turn on microphone" (muted) / "Turn off microphone" (unmuted).
        if lower.contains("unmute my") || lower.contains("unmute (") || lower == "unmute"
            || lower.contains("turn on microphone") {
            c.localUserUnmuted = false
        } else if lower.contains("mute my") || lower.contains("mute (") || lower == "mute"
            || lower.contains("turn off microphone") {
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

    private func axClassList(_ el: AXUIElement) -> [String] {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, "AXDOMClassList" as CFString, &v) == .success else { return [] }
        return (v as? [String]) ?? []
    }

    private func axParent(_ el: AXUIElement) -> AXUIElement? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, "AXParent" as CFString, &v) == .success, let v,
              CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    private func axFrame(_ el: AXUIElement) -> CGRect? {
        var v: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, "AXFrame" as CFString, &v) == .success,
           let v, CFGetTypeID(v) == AXValueGetTypeID() {
            var r = CGRect.zero
            if AXValueGetValue(v as! AXValue, .cgRect, &r) { return r }
        }
        var sv: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, "AXSize" as CFString, &sv) == .success,
           let sv, CFGetTypeID(sv) == AXValueGetTypeID() {
            var s = CGSize.zero
            if AXValueGetValue(sv as! AXValue, .cgSize, &s) { return CGRect(origin: .zero, size: s) }
        }
        return nil
    }

    // MARK: Google Meet per-tile active-speaker scan

    /// Finds participant tiles in a Meet window and returns the names whose tile
    /// carries the active-speaker class (see SpeakerCore.meetTileIsSpeaking).
    /// Verified mechanism: Meet adds `kssMZb` to the speaking tile's DOM classes,
    /// surfaced via AXDOMClassList. Names are obfuscated-class-driven, so the rule
    /// is remote-config'd in MeetSpeakerRules.
    private func meetSpeakingNames(in window: AXUIElement) -> (speakers: [String], participants: [String]) {
        var nameNodes: [(AXUIElement, String)] = []
        var scanned = 0
        func collect(_ el: AXUIElement, _ depth: Int) {
            if scanned >= maxNodesPerWindow || depth > maxDepth { return }
            scanned += 1
            if axString(el, "AXRole") == "AXStaticText",
               let raw = axString(el, "AXValue") ?? axString(el, "AXTitle"),
               let name = cleanParticipantName(raw) {
                nameNodes.append((el, name))
            }
            for c in axArray(el, "AXChildren") { collect(c, depth + 1) }
        }
        collect(window, 0)

        var speakers = Set<String>()
        var participants = Set<String>()
        for (node, name) in nameNodes {
            guard let tile = meetTileAncestor(of: node) else { continue }
            participants.insert(name)
            if meetTileIsSpeaking(classTokens: tileClassTokens(tile)) { speakers.insert(name) }
        }
        return (Array(speakers), Array(participants))
    }

    /// Climb from a name node to the nearest participant-tile-sized ancestor.
    private func meetTileAncestor(of node: AXUIElement) -> AXUIElement? {
        var cur: AXUIElement? = node
        var steps = 0
        var fallback: AXUIElement?
        while let el = cur, steps < 14 {
            if let f = axFrame(el) {
                let area = f.width * f.height
                let aspect = f.height > 0 ? f.width / f.height : 99
                if area >= 8_000 && area <= 1_800_000 {
                    if fallback == nil { fallback = el }
                    if aspect <= 4.0 { return el }
                }
            }
            cur = axParent(el)
            steps += 1
        }
        return fallback
    }

    /// Union of AXDOMClassList tokens across a tile's subtree (bounded).
    private func tileClassTokens(_ tile: AXUIElement) -> Set<String> {
        var tokens = Set<String>()
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if n >= 800 || depth > 40 { return }
            n += 1
            for t in axClassList(el) { tokens.insert(t) }
            for c in axArray(el, "AXChildren") { rec(c, depth + 1) }
        }
        rec(tile, 0)
        return tokens
    }
}
