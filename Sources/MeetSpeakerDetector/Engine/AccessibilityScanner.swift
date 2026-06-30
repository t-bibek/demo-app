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
    /// True when the window exposes a DIRECT active-speaker read (Meet's kssMZb
    /// class / Zoom-web's "active speaker" marker). False for native Zoom & Teams,
    /// which have no AX speaking signal — the engine then mute-gates or falls back
    /// to the anonymous "Someone". (Per-window so native Zoom ≠ Zoom web.)
    var directSpeakerRead: Bool
    /// Native Zoom roster (name + mute + isMe) for mute-gated attribution; empty
    /// for every other platform.
    var zoomRoster: [ZoomRosterEntry]
    /// Meet per-tile observations (geometry + class + structural facts) for the
    /// fused, VAD-gated active-speaker resolver in the engine; empty for every
    /// other platform.
    var meetTiles: [MeetTileObservation]
    /// True when a presentation / screen-share dominates the meeting stage
    /// (Meet). The resolver SUPPRESSES geometry attribution then, so the shared
    /// screen's large tile isn't mistaken for the speaker. False off Meet.
    var presentationActive: Bool
    /// Teams per-tile observations (geometry + structural is-speaking + mute) for
    /// the fused, VAD-gated resolver in the engine; empty for every other platform.
    var teamsTiles: [TeamsTileObservation]
    /// Teams People-panel roster (name + mute + isMe) — the only reliable
    /// per-participant REMOTE mute source in Teams AX, readable only when the
    /// Participants panel is open. Empty otherwise / for every other platform.
    var teamsRoster: [ZoomRosterEntry]
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
                var zoomRoster: [ZoomRosterEntry] = []
                var meetTiles: [MeetTileObservation] = []
                var teamsTiles: [TeamsTileObservation] = []
                var teamsRoster: [ZoomRosterEntry] = []
                var presentationActive = false

                if platform == .meet {
                    // Meet's active speaker is fused (structural + geometry + class +
                    // VAD) in the engine — the scanner supplies the per-tile
                    // observations and whether a presentation dominates the stage.
                    let m = meetTileObservations(in: window)
                    meetTiles = m.tiles
                    presentationActive = meetPresentationActive(in: window)
                    speakers = []   // engine resolves Meet speakers from meetTiles
                    participants = dedup(participants + m.participants)
                } else if platform == .teams {
                    // Teams (new client) is a Chromium WebView, so its tiles surface
                    // in AX like Meet's — supply per-tile observations (structural
                    // is-speaking via stable aria_*/calling_* tokens + geometry +
                    // mute) for the engine's VAD-gated resolver. See
                    // docs/teams-active-speaker-detection.md.
                    let t = teamsTileObservations(in: window)
                    teamsTiles = t.tiles
                    // Remote mute is NOT reliable on the video tiles — read it from
                    // the People-panel roster rows ("<Name>, …, Muted/Unmuted"),
                    // the one dependable source (requires the panel open). Mark the
                    // row matching the self tile as isMe. See docs/teams-probe.md.
                    let selfName = t.tiles.first(where: { $0.isMe })?.name
                    teamsRoster = teamsRosterEntries(in: window, selfName: selfName)
                    speakers = []   // engine resolves Teams speakers from teamsTiles + audio
                    participants = dedup(participants + t.participants + teamsRoster.map { $0.name })
                } else if platform == .zoom && isNative {
                    // Native Zoom has no AX speaking signal — read the roster +
                    // per-participant mute instead (see zoomNativeRoster), and
                    // skip the Zoom Workplace home/shell window so its nav chrome
                    // can't masquerade as a meeting.
                    zoomRoster = zoomNativeRoster(in: window)
                    let isMeeting = !zoomRoster.isEmpty
                        || collector.localUserUnmuted != nil
                        || title.lowercased().contains("meeting")
                    if !isMeeting { continue }
                    speakers = []   // no direct speaking read on native Zoom
                    participants = dedup(participants + zoomRoster.map { $0.name })
                }

                let directSpeakerRead: Bool
                switch platform {
                case .meet:  directSpeakerRead = true
                case .zoom:  directSpeakerRead = !isNative   // web marker yes; native no
                case .teams: directSpeakerRead = !teamsTiles.isEmpty  // structural read when tiles found
                }

                results.append(ScannedWindow(
                    platform: platform,
                    title: title.isEmpty ? platform.label : title,
                    nodeCount: collector.nodeCount,
                    treeOk: treeOk,
                    speakers: speakers,
                    participants: participants,
                    localUserUnmuted: collector.localUserUnmuted,
                    directSpeakerRead: directSpeakerRead,
                    zoomRoster: zoomRoster,
                    meetTiles: meetTiles,
                    presentationActive: presentationActive,
                    teamsTiles: teamsTiles,
                    teamsRoster: teamsRoster
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

    // MARK: Native Zoom roster (no AX speaking signal — read roster + mute)

    /// Reads native Zoom's Participants-panel rows: each carries text like
    /// "<Name>, Computer audio muted/unmuted" (verified; docs/zoom-native-detection.md).
    /// Returns one entry per participant with mute state + a local-user ("(me)")
    /// flag. Empty when this isn't a meeting window (e.g. the Zoom Workplace home
    /// shell, whose rows never carry mic-state text).
    private func zoomNativeRoster(in window: AXUIElement) -> [ZoomRosterEntry] {
        var byName: [String: ZoomRosterEntry] = [:]
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if n >= maxNodesPerWindow || depth > maxDepth { return }
            n += 1
            for attr in ["AXDescription", "AXValue", "AXTitle"] {
                guard let raw = axString(el, attr) else { continue }
                let low = raw.lowercased()
                guard low.contains("computer audio") else { continue }
                let isMe = low.contains("(me)") || low.contains(", me)")
                let unmuted = low.contains("audio unmuted")
                // Strip a trailing "(Host, me)" role tag, then let cleanParticipantName
                // cut the ", Computer audio …" clause and reject control labels.
                let noParen = raw.replacingOccurrences(
                    of: #"\s*\([^)]*\)"#, with: "", options: .regularExpression)
                if let name = cleanParticipantName(noParen), byName[name] == nil {
                    byName[name] = ZoomRosterEntry(name: name, unmuted: unmuted, isMe: isMe)
                }
                break
            }
            for c in axArray(el, "AXChildren") { rec(c, depth + 1) }
        }
        rec(window, 0)
        return Array(byName.values)
    }

    // MARK: Google Meet per-tile active-speaker scan

    /// Config-loaded Meet class rules (Phase 3): a rotation is a config drop, not
    /// a rebuild. Loaded once per scanner.
    private let meetRules = MeetSpeakerRules.resolved()

    /// Builds the per-tile observations the engine's fused resolver needs: name +
    /// geometry (AXFrame area, the durable signal) + DOM order + whether the
    /// rotating CSS class matched (fallback signal). The engine then fuses these
    /// with audio VAD — see docs/meet-active-speaker-no-hardcoded-css.md.
    private func meetTileObservations(in window: AXUIElement) -> (tiles: [MeetTileObservation], participants: [String]) {
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

        // One entry per name; keep the largest tile (the real video tile, not a
        // tiny duplicate label). Track frame for geometry + reading order.
        struct Acc { var area: Double; var speaking: Bool; var isMe: Bool; var minY: CGFloat; var minX: CGFloat }
        var byName: [String: Acc] = [:]
        for (node, name) in nameNodes {
            guard let tile = meetTileAncestor(of: node) else { continue }
            let frame = axFrame(tile) ?? .zero
            let area = Double(frame.width * frame.height)
            let speaking = meetTileIsSpeaking(classTokens: tileClassTokens(tile), rules: meetRules)
            let isMe = meetTileIsSelf(tile)
            if let ex = byName[name], ex.area >= area { continue }
            byName[name] = Acc(area: area, speaking: speaking, isMe: isMe, minY: frame.minY, minX: frame.minX)
        }

        let ordered = byName.sorted { ($0.value.minY, $0.value.minX) < ($1.value.minY, $1.value.minX) }
        let tiles = ordered.enumerated().map { i, kv in
            MeetTileObservation(name: kv.key, area: kv.value.area, orderIndex: i,
                                classSpeaking: kv.value.speaking, isMe: kv.value.isMe)
        }
        return (tiles, ordered.map { $0.key })
    }

    /// True if a tile is the LOCAL user's — Meet puts a "(You)" label in the self
    /// tile's subtree. Lets audio-direction separate self from remotes (so a
    /// remote speaking is never attributed to your own tile's persistent highlight).
    private func meetTileIsSelf(_ tile: AXUIElement) -> Bool {
        var found = false
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if found || n >= 600 || d > 30 { return }
            n += 1
            for attr in ["AXValue", "AXTitle", "AXDescription"] {
                if let s = axString(el, attr)?.lowercased(), s.contains("(you)") { found = true; return }
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1); if found { return } }
        }
        rec(tile, 0)
        return found
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

    /// Best-effort: is a presentation / screen-share dominating the Meet stage?
    /// Heuristic text scan for a clear "presenting" / "stop sharing" phrase (Meet
    /// labels the share control + a "<name> is presenting" banner). Conservative on
    /// purpose — only a definite presenting phrase counts, so we don't spuriously
    /// suppress the geometry signal. Validated as a matrix axis; replace with a
    /// structural container check if the probe finds a stabler one.
    private func meetPresentationActive(in window: AXUIElement) -> Bool {
        var found = false
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if found || n >= maxNodesPerWindow || depth > maxDepth { return }
            n += 1
            for attr in ["AXDescription", "AXTitle", "AXValue"] {
                guard let s = axString(el, attr)?.lowercased() else { continue }
                if s.contains("is presenting") || s.contains("stop presenting")
                    || s.contains("stop sharing") || s.contains("you are presenting")
                    || s.contains("is sharing their screen") {
                    found = true; return
                }
            }
            for c in axArray(el, "AXChildren") { rec(c, depth + 1) }
        }
        rec(window, 0)
        return found
    }

    // MARK: Microsoft Teams per-tile active-speaker scan

    /// Config-loaded Teams rules (stable `aria_*`/`calling_*` tokens + speaking
    /// markers); a token change is a config drop, not a rebuild. Loaded once.
    private let teamsRules = TeamsSpeakerRules.resolved()

    /// Builds Teams per-tile observations for the engine's VAD-gated resolver —
    /// the analog of `meetTileObservations`. New Teams is a Chromium WebView so
    /// its tiles surface in AX like Meet's: name → tile-sized ancestor, with the
    /// is-speaking / self / mute flags derived from `TeamsSpeakerRules` (verified
    /// via a Teams probe run). See docs/teams-active-speaker-detection.md.
    private func teamsTileObservations(in window: AXUIElement) -> (tiles: [TeamsTileObservation], participants: [String]) {
        var nameNodes: [(AXUIElement, String)] = []
        var scanned = 0
        func collect(_ el: AXUIElement, _ depth: Int) {
            if scanned >= maxNodesPerWindow || depth > maxDepth { return }
            scanned += 1
            for attr in ["AXValue", "AXTitle", "AXDescription"] {
                if let raw = axString(el, attr), let name = cleanParticipantName(raw) {
                    nameNodes.append((el, name))
                    break
                }
            }
            for c in axArray(el, "AXChildren") { collect(c, depth + 1) }
        }
        collect(window, 0)

        struct Acc { var area: Double; var speaking: Bool; var isMe: Bool; var unmuted: Bool?; var minY: CGFloat; var minX: CGFloat }
        var byName: [String: Acc] = [:]
        for (node, name) in nameNodes {
            guard let tile = meetTileAncestor(of: node) else { continue }
            let frame = axFrame(tile) ?? .zero
            let area = Double(frame.width * frame.height)
            let (blob, classes) = tileTextAndClasses(tile)
            let speaking = teamsRules.tileIsSpeaking(textBlob: blob, classTokens: classes)
            let isMe = teamsRules.tileIsSelf(textBlob: blob, classTokens: classes)
            let unmuted = teamsRules.muteState(textBlob: blob, classTokens: classes)
            if let ex = byName[name], ex.area >= area { continue }
            byName[name] = Acc(area: area, speaking: speaking, isMe: isMe, unmuted: unmuted, minY: frame.minY, minX: frame.minX)
        }

        let ordered = byName.sorted { ($0.value.minY, $0.value.minX) < ($1.value.minY, $1.value.minX) }
        let tiles = ordered.enumerated().map { i, kv in
            TeamsTileObservation(name: kv.key, area: kv.value.area, orderIndex: i,
                                 isSpeaking: kv.value.speaking, isMe: kv.value.isMe, unmuted: kv.value.unmuted)
        }
        return (tiles, ordered.map { $0.key })
    }

    /// Reads the Teams People/Participants-panel roster: each row's AXDescription/
    /// AXTitle is `"<Name>, …roles…, Muted/Unmuted"` (see parseTeamsRosterRow).
    /// This is the only reliable per-participant REMOTE mute source — present only
    /// when the panel is open; returns [] otherwise. `selfName` (from the self
    /// tile) flags the local user's row. Mirrors `zoomNativeRoster`.
    private func teamsRosterEntries(in window: AXUIElement, selfName: String?) -> [ZoomRosterEntry] {
        var byName: [String: ZoomRosterEntry] = [:]
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if n >= maxNodesPerWindow || depth > maxDepth { return }
            n += 1
            for attr in ["AXDescription", "AXTitle", "AXValue"] {
                guard let raw = axString(el, attr), let row = parseTeamsRosterRow(raw) else { continue }
                // Keep one entry per name; prefer an explicit unmuted reading.
                if byName[row.name] == nil {
                    let isMe = selfName != nil && row.name == selfName
                    byName[row.name] = ZoomRosterEntry(name: row.name, unmuted: row.unmuted, isMe: isMe)
                }
                break
            }
            for c in axArray(el, "AXChildren") { rec(c, depth + 1) }
        }
        rec(window, 0)
        return Array(byName.values)
    }

    /// Lowercased concatenation of a tile subtree's AX text + the union of its
    /// AXDOMClassList tokens (bounded) — the surface the Teams rules match.
    private func tileTextAndClasses(_ tile: AXUIElement) -> (text: String, classes: Set<String>) {
        var parts: [String] = []
        var classes = Set<String>()
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if n >= 800 || depth > 40 { return }
            n += 1
            for attr in ["AXDescription", "AXValue", "AXTitle"] {
                if let s = axString(el, attr), !s.isEmpty { parts.append(s) }
            }
            for t in axClassList(el) { classes.insert(t) }
            for c in axArray(el, "AXChildren") { rec(c, depth + 1) }
        }
        rec(tile, 0)
        return (parts.joined(separator: " ").lowercased(), classes)
    }
}
