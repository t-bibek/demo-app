import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import SpeakerCore

/// One meeting window observed during a scan.
struct ScannedWindow {
    var platform: Platform
    var title: String
    /// Page URL from the browser address bar when available (nil for native
    /// apps / unreadable trees). Used to derive a STABLE meeting id from the
    /// meeting code rather than the volatile window title.
    var url: String?
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
    /// Active speaker read DIRECTLY off the Zoom PIP thumbnail's "Talking: <name>"
    /// indicator (Zoom's own VAD). nil unless this is the Zoom PIP and someone is
    /// talking. Lets PIP-only mode name the speaker instead of "Someone".
    var pipSpeaker: String?
    /// Zoom WEB active speaker, read from the speaker-bar tile whose
    /// `AXDOMClassList` carries the `speaker-bar-container__video-frame--active`
    /// modifier (Zoom's own VAD; the highlight moves to whoever is talking, idle
    /// tiles keep the base `…__video-frame` class). nil off Zoom-web / on silence.
    /// The engine audio-gates it so a lingering highlight doesn't extend a turn.
    var zoomWebSpeaker: String?
    /// This window keeps the meeting ALIVE but contributes no speakers/roster — a
    /// secondary view that's call-control chrome, not participant tiles (the Teams
    /// "Meeting compact view" window). The main window supplies the roster; this
    /// just prevents meeting_ended while you're minimised to it.
    var keepAliveOnly: Bool = false
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

    /// True for a real browser OR an installed PWA / "Add to Dock" web app, which
    /// run as their OWN app process with a derived bundle id but host the SAME
    /// Chromium/WebKit AX tree. Without this the Google Meet PWA
    /// (`com.google.Chrome.app.<id>`) is skipped and never scanned. Patterns:
    /// Chrome/Edge/Brave `…app.<id>`, Safari `com.apple.Safari.WebApp.<uuid>`.
    private static func isBrowserBundle(_ bid: String) -> Bool {
        if browserBundleIDs.contains(bid) { return true }
        if bid.hasPrefix("com.apple.Safari.WebApp") { return true }
        guard bid.contains(".app.") else { return false }
        return ["com.google.Chrome", "com.microsoft.edgemac", "com.brave.Browser",
                "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
                "company.thebrowser.Browser"].contains(where: bid.hasPrefix)
    }

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
            let isBrowser = Self.isBrowserBundle(bundleID)
            guard isNative || isBrowser else { continue }

            let axApp = AXUIElementCreateApplication(app.processIdentifier)
            // Native Zoom: resolve the local user's "(me)" name ONCE across all the
            // app's windows (the Participants panel may be a separate window from the
            // tiles the roster is read from), then apply it to every roster below.
            let zoomSelfHint: String? = (bundleID == "us.zoom.xos") ? zoomSelfNameHint(axApp) : nil
            for window in axArray(axApp, "AXWindows") {
                let title = axString(window, "AXTitle") ?? ""
                // Classify by the AXWebArea's AXURL FIRST (product parity — see
                // bubbles-meet-detector webAreasFor). The address bar / window title
                // are unreliable: an installed PWA (…?fromPWA=1) has NO address bar
                // and often an empty or custom window title, so title-based
                // classification skipped it entirely. The AXWebArea always carries
                // AXURL, even in a PWA. Fall back to the title / app name for native
                // apps and plain browser tabs.
                let webURL = isBrowser ? webAreaMeetingURL(in: window) : nil
                guard var platform = platformForURL(webURL)
                        ?? Self.platform(forNative: bundleID, windowTitle: title)
                        ?? platformForBrowserTitle(app.localizedName ?? "") else { continue }

                var collector = TreeCollector()
                collector.url = webURL   // authoritative URL for the stable meeting id
                walk(window, depth: 0, into: &collector)

                // If the AXURL wasn't found (older Chromium / odd tree), the walk's
                // text-based capture may still fill it — let it refine the platform.
                if webURL == nil, let urlPlatform = platformForURL(collector.url) { platform = urlPlatform }

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
                var pipSpeaker: String? = nil
                var zoomWebSpeaker: String? = nil
                var keepAliveOnly = false

                if platform == .meet {
                    // Meet's active speaker is fused (geometry + class + VAD) in the
                    // engine — the scanner supplies per-tile observations + presentation.
                    let m = meetTileObservations(in: window)
                    // ACTIVE-CALL gate (product parity): the "Leave call" button /
                    // "Call controls" landmark — with the mic control as a secondary
                    // in-call signal. The URL/title CODE is deliberately NOT sufficient:
                    // it persists on meet.google.com/landing, the pre-join screen, AND
                    // the post-call screen, so gating on it would (a) start a meeting on
                    // the landing page and (b) never emit meeting_ended. All these
                    // signals vanish when the call ends → the window is dropped →
                    // MeetingStateTracker ages it out to meeting_ended.
                    guard meetCallActive(in: window)
                            || collector.localUserUnmuted != nil else { continue }
                    meetTiles = m.tiles
                    presentationActive = meetPresentationActive(in: window)
                    speakers = []   // engine resolves Meet speakers from meetTiles (kssMZb)
                    // Roster: the People panel when it's open (authoritative), else the
                    // tile-anchored names. Speaking detection is unchanged.
                    let panel = meetPanelRoster(in: window)
                    participants = panel.isEmpty ? dedup(m.participants) : dedup(panel)
                } else if platform == .teams {
                    // The Teams "Meeting compact view" window is a secondary PIP-like
                    // view — call-control chrome, not participant tiles. Keep the call
                    // alive from it (so minimising to it doesn't end the meeting) but
                    // DON'T harvest tiles/roster; the main window (same meeting id)
                    // supplies those. This is what stops "Turn camera on" / "Calling
                    // controls" / "Nobody" leaking as participants and speakers.
                    if title.lowercased().contains("meeting compact view") {
                        // Compact/PIP window: no participant tiles, but Teams names the
                        // active speaker in an "<name> is speaking" note. Read it
                        // directly (like the Zoom PIP). When nobody's speaking, just
                        // keep the call alive (the main window supplies the roster).
                        speakers = []
                        if let sp = teamsSpeakingNote(in: window) {
                            pipSpeaker = sp
                            participants = [sp]
                        } else {
                            participants = []
                            keepAliveOnly = true
                        }
                    } else {
                        // Teams (new client) is a Chromium WebView, so its tiles surface
                        // in AX like Meet's — supply per-tile observations for the engine's
                        // VAD-gated resolver. See docs/teams-active-speaker-detection.md.
                        let t = teamsTileObservations(in: window)
                        // Remote mute is read from the People-panel roster rows (the one
                        // dependable source; requires the panel open). Mark the row that
                        // matches the self tile as isMe. See docs/teams-probe.md.
                        let selfName = t.tiles.first(where: { $0.isMe })?.name
                        teamsRoster = teamsRosterEntries(in: window, selfName: selfName)
                        // ACTIVE-CALL gate (product parity): a "Leave" button, a "Shared
                        // content" main landmark, or an "Attendees" outline — covers native
                        // AND web Teams. The meeting URL alone is NOT enough (…/light-
                        // meetings/launch is the launcher page before joining); the chat /
                        // home window lacks these too. Roster / self tile corroborate.
                        guard teamsCallActive(in: window) || !teamsRoster.isEmpty
                                || t.tiles.contains(where: { $0.isMe }) else { continue }
                        teamsTiles = t.tiles
                        speakers = []   // engine resolves Teams speakers from teamsTiles + audio
                        participants = dedup(t.tiles.map { $0.name } + teamsRoster.map { $0.name })
                        // Prefer Teams' OWN active-speaker note ("<name> is speaking")
                        // over the audio mute-gate — it's the same VAD signal shown in
                        // the compact window, and avoids the ambiguous "Someone".
                        pipSpeaker = teamsSpeakingNote(in: window)
                    }
                } else if platform == .zoom && isNative {
                    // Native Zoom has no AX speaking signal — read the roster +
                    // per-participant mute instead (see zoomNativeRoster). ACTIVE call =
                    // the "Zoom Meeting" / "Meeting -" window (product parity); the
                    // "Zoom Workplace"/home window is the dock app, not a call. Roster /
                    // mic control corroborate. Post-call returns to home → gate fails →
                    // meeting_ended.
                    zoomRoster = zoomNativeRoster(in: window, selfHint: zoomSelfHint)
                    let lt = title.lowercased()
                    let isPip = zoomIsPipWindow(window)
                    let isMeeting = zoomNativeCallActive(in: window)
                        || lt.contains("zoom meeting") || lt.contains("meeting -")
                        || !zoomRoster.isEmpty
                        || collector.localUserUnmuted != nil
                        || isPip   // minimised to PIP (any state)
                    if !isMeeting { continue }
                    speakers = []   // no direct speaking read on native Zoom
                    if isPip, zoomRoster.isEmpty {
                        // PIP thumbnail: no roster, but Zoom names the active speaker
                        // in "Talking: <name>". Use it directly + as the participant.
                        let pip = zoomPipContent(in: window)
                        pipSpeaker = pip.speaker
                        participants = dedup(pip.names + (pip.speaker.map { [$0] } ?? []))
                    } else {
                        participants = dedup(zoomRoster.map { $0.name })
                    }
                } else if platform == .zoom {
                    // Zoom WEB Client. ACTIVE call = a "Leave"/"End" / participants-list
                    // control (product's zoomWebCallActive), with mic control as a
                    // secondary signal. Gates out ai.zoom.us marketing, OAuth callbacks,
                    // the /j/ join landing, and post-call screens (all lack these). The
                    // roster is the active-speaker-marked tiles only — the generic walk
                    // on web zoom is page chrome (nav, pricing, footer).
                    guard zoomWebCallActive(in: window)
                            || collector.localUserUnmuted != nil else { continue }
                    // Active speaker + roster from the speaker-bar tiles: the
                    // `…__video-frame--active` tile is whoever is talking; the plain
                    // `…__video-frame` tiles are the idle participants.
                    let bar = zoomWebSpeakerBar(in: window)
                    zoomWebSpeaker = bar.active
                    participants = dedup(bar.names + speakers)
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
                    url: collector.url,
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
                    teamsRoster: teamsRoster,
                    pipSpeaker: pipSpeaker,
                    zoomWebSpeaker: zoomWebSpeaker,
                    keepAliveOnly: keepAliveOnly
                ))
            }
        }
        return results
    }

    /// The active speaker on a Teams window, read from its
    /// `AXDocumentNote desc="<name> is speaking"` indicator — Teams' OWN VAD
    /// (verified via AXDump; present in both the main and compact/PIP windows).
    /// Returns nil for "Nobody is speaking". This is far more reliable than the
    /// audio-direction mute-gate, so the engine prefers it.
    private func teamsSpeakingNote(in window: AXUIElement) -> String? {
        var name: String?
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if name != nil || n >= 2000 || d > maxDepth { return }
            n += 1
            if let desc = axString(el, "AXDescription") {
                let low = desc.lowercased()
                if low.hasSuffix("is speaking"), !low.hasPrefix("nobody") {
                    let base = String(desc.dropLast("is speaking".count))
                        .trimmingCharacters(in: CharacterSet(charactersIn: " ,"))
                    if let clean = cleanParticipantName(base) { name = clean; return }
                }
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1); if name != nil { return } }
        }
        rec(window, 0)
        return name
    }

    /// Zoom WEB active-speaker + roster read from the tile structure.
    ///
    /// Each participant tile is a `speaker-bar-container__video-frame` (filmstrip)
    /// or `speaker-active-container__video-frame` (the big speaker view). The tile
    /// currently talking carries the `…__video-frame--active` modifier — Zoom's own
    /// VAD; the highlight moves to whoever is speaking.
    ///
    /// The display name lives in the tile's title structure: `video-avatar__avatar-
    /// img`'s AXDescription (the `<img alt>`) when the camera is OFF, else the
    /// `video-avatar__avatar-footer` label (an AXStaticText value) which is ALWAYS
    /// present — the only source when the camera is on. Reading only those anchored
    /// nodes avoids false positives from other tile text ("Unable to play media",
    /// mute/role badges, counts).
    private func zoomWebSpeakerBar(in window: AXUIElement) -> (active: String?, names: [String]) {
        var barActive: String?
        var bigActive: String?
        var names: [String] = []
        var n = 0

        // A tile's name: prefer the avatar image alt (real display name, camera off);
        // fall back to the footer label (an AXStaticText inside the tile, always
        // present — the only source when the camera is on).
        func tileName(_ frame: AXUIElement) -> String? {
            var imgName: String?
            var footerName: String?
            func rec(_ el: AXUIElement, _ d: Int) {
                if imgName != nil || d > maxDepth { return }
                let classes = axClassList(el)
                if classes.contains("video-avatar__avatar-img")
                    || classes.contains("video-avatar__avatar-title") {
                    for attr in ["AXDescription", "AXTitle", "AXValue"] {
                        if let raw = axString(el, attr), let clean = cleanParticipantName(raw) { imgName = clean; break }
                    }
                }
                if footerName == nil, axString(el, "AXRole") == "AXStaticText",
                   let raw = axString(el, "AXValue"), let clean = cleanParticipantName(raw) {
                    footerName = clean
                }
                for c in axArray(el, "AXChildren") { rec(c, d + 1); if imgName != nil { return } }
            }
            rec(frame, 0)
            return imgName ?? footerName
        }

        func rec(_ el: AXUIElement, _ d: Int) {
            if n >= maxNodesPerWindow || d > maxDepth { return }
            n += 1
            let classes = axClassList(el)
            let isBar = classes.contains { $0.hasPrefix("speaker-bar-container__video-frame") }
            let isBig = classes.contains { $0.hasPrefix("speaker-active-container__video-frame") }
            if isBar || isBig {
                if let name = tileName(el) {
                    names.append(name)
                    if classes.contains("speaker-bar-container__video-frame--active") { barActive = name }
                    else if isBig { bigActive = name }
                }
                return   // a tile is a leaf for our purposes; don't descend further
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1) }
        }
        rec(window, 0)
        // The filmstrip "--active" tile is the definitive speaker; the big speaker-
        // view tile is the fallback when the filmstrip isn't shown (few participants).
        return (barActive ?? bigActive, dedup(names))
    }

    /// Is this Teams window/tab actually IN a call — not the chat / home / calendar
    /// view or the "…/light-meetings/launch" launcher page (which shares the meeting
    /// URL)? Ported from the product's teamsCallActive/teamsCallWindowOpen: a
    /// "Leave" button, a "Shared content" main landmark, or an "Attendees" outline.
    /// Covers native AND web Teams; all vanish when the call ends.
    private func teamsCallActive(in window: AXUIElement) -> Bool {
        var active = false
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if active || n >= maxNodesPerWindow || d > maxDepth { return }
            n += 1
            if let role = axString(el, "AXRole") {
                if role == "AXButton" {
                    let label = ((axString(el, "AXTitle") ?? "") + " "
                        + (axString(el, "AXDescription") ?? "")).lowercased()
                    if label.contains("leave") { active = true; return }
                }
                if role == "AXGroup", axString(el, "AXSubrole") == "AXLandmarkMain",
                   let d = axString(el, "AXDescription")?.lowercased(), d.contains("shared content") {
                    active = true; return
                }
                if role == "AXOutline", let d = axString(el, "AXDescription")?.lowercased(),
                   d.contains("attendees") {
                    active = true; return
                }
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1); if active { return } }
        }
        rec(window, 0)
        return active
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

    /// The AXURL of an element as a string (comes back as URL / NSURL / String).
    /// Used for meeting-URL classification independent of the address bar.
    private func axURL(_ el: AXUIElement) -> String? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, "AXURL" as CFString, &v) == .success, let v else { return nil }
        if let u = v as? URL { return u.absoluteString }
        if let u = v as? NSURL { return u.absoluteString }
        return v as? String
    }

    /// The meeting URL from the window's AXWebArea AXURL — the address-bar-
    /// independent source that works for installed PWAs (no address bar) and
    /// custom-titled tabs. Mirrors the product's `webAreasFor()`: find the
    /// AXWebArea, read its AXURL. Only AXWebArea nodes are consulted so element
    /// (link) AXURLs never leak in.
    private func webAreaMeetingURL(in window: AXUIElement) -> String? {
        var found: String?
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if found != nil || n >= 4000 || d > maxDepth { return }
            n += 1
            if axString(el, "AXRole") == "AXWebArea", let u = axURL(el), platformForURL(u) != nil {
                found = u; return
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1); if found != nil { return } }
        }
        rec(window, 0)
        return found
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
    /// The local user's name from Zoom's "(me)" marker, searched across ALL of the
    /// app's windows — the Participants panel (which carries "(me)") is often a
    /// DIFFERENT AXWindow than the video-tile window the roster is read from.
    private func zoomSelfNameHint(_ app: AXUIElement) -> String? {
        var found: String?
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if found != nil || n >= maxNodesPerWindow || d > maxDepth { return }
            n += 1
            for attr in ["AXValue", "AXTitle", "AXDescription"] {
                guard let raw = axString(el, attr) else { continue }
                let low = raw.lowercased()
                if low.contains("(me)") || low.contains(", me)") {
                    let noParen = raw.replacingOccurrences(
                        of: #"\s*\([^)]*\)"#, with: "", options: .regularExpression)
                    if let name = cleanParticipantName(noParen) { found = name; return }
                }
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1); if found != nil { return } }
        }
        for window in axArray(app, "AXWindows") { rec(window, 0); if found != nil { break } }
        return found
    }

    private func zoomNativeRoster(in window: AXUIElement, selfHint: String? = nil) -> [ZoomRosterEntry] {
        var byName: [String: ZoomRosterEntry] = [:]
        var selfName: String?
        var n = 0
        func rec(_ el: AXUIElement, _ depth: Int) {
            if n >= maxNodesPerWindow || depth > maxDepth { return }
            n += 1
            for attr in ["AXDescription", "AXValue", "AXTitle"] {
                guard let raw = axString(el, attr) else { continue }
                let low = raw.lowercased()
                // Local-user marker: Zoom labels the self row "<Name> (me)" /
                // "(Host, me)" in the Participants panel — often a DIFFERENT node than
                // the "computer audio" audio-status row, so capture it separately.
                if selfName == nil, low.contains("(me)") || low.contains(", me)") {
                    let noParen = raw.replacingOccurrences(
                        of: #"\s*\([^)]*\)"#, with: "", options: .regularExpression)
                    if let name = cleanParticipantName(noParen) { selfName = name }
                }
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
        // Mark the local user so self speech gets the real roster name (not "You")
        // and the local user isn't miscounted as a remote (which forced "Someone").
        // Prefer the in-window "(me)" match; else the app-wide hint (which covers a
        // detached Participants-panel window).
        if let resolved = selfName ?? selfHint {
            if var e = byName[resolved] {
                e.isMe = true
                byName[resolved] = e
            } else {
                byName[resolved] = ZoomRosterEntry(name: resolved, unmuted: true, isMe: true)
            }
        }
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
    /// Per-tile observations for Meet, extracted STRUCTURALLY (see
    /// `docs/research-ax.md`) — no dependency on obfuscated CSS classes:
    ///   1. Scope to the page's `<main>` landmark (`AXLandmarkMain`) inside the
    ///      meet.google.com web area. Everything outside it — the address bar,
    ///      other tabs, an open DevTools panel — is excluded, so browser chrome
    ///      ("DevTools is docked to right") can no longer be harvested as a fake
    ///      tile that wins the geometry contest and masks the real speaker.
    ///   2. Within it, resolve each tile by GEOMETRY (a tile-sized ancestor of the
    ///      name), NOT by a rotating tile class — a Griffel-hash rotation can't
    ///      break tile detection this way. (`kssMZb` is still read per tile for the
    ///      speaking flag, but only as the engine's last-resort corroboration.)
    private func meetTileObservations(in window: AXUIElement) -> (tiles: [MeetTileObservation], participants: [String]) {
        let root = meetStageRoot(in: window)

        // Two name sources per tile: the visible CAPTION (an AXStaticText, the real
        // display name) and, as a FALLBACK, the per-tile control label ("Pin <Name>
        // to your main screen" / "More options for <Name>"). Normal tiles carry a
        // caption; small / PIP tiles drop it, leaving the control label as the only
        // place the name survives. Captions win — control labels are only consulted
        // for a tile that produced NO caption.
        var captionNodes: [(AXUIElement, String)] = []
        var controlNodes: [(AXUIElement, String)] = []
        var scanned = 0
        func collect(_ el: AXUIElement, _ depth: Int) {
            if scanned >= maxNodesPerWindow || depth > maxDepth { return }
            scanned += 1
            if axString(el, "AXRole") == "AXStaticText",
               let raw = axString(el, "AXValue") ?? axString(el, "AXTitle"),
               let name = cleanParticipantName(raw) {
                captionNodes.append((el, name))
            } else if let raw = axString(el, "AXDescription") ?? axString(el, "AXTitle"),
                      let name = meetNameFromControlLabel(raw) {
                controlNodes.append((el, name))
            }
            for c in axArray(el, "AXChildren") { collect(c, depth + 1) }
        }
        collect(root, 0)

        // One entry per name; keep the largest tile (the real video tile, not a
        // tiny duplicate label). Track frame for geometry + reading order.
        struct Acc { var area: Double; var speaking: Bool; var isMe: Bool; var minY: CGFloat; var minX: CGFloat }
        var byName: [String: Acc] = [:]
        var captionFrames: [CGRect] = []
        func consider(_ tile: AXUIElement, _ name: String) {
            let frame = axFrame(tile) ?? .zero
            let area = Double(frame.width * frame.height)
            let speaking = meetTileIsSpeaking(classTokens: tileClassTokens(tile), rules: meetRules)
            let isMe = meetTileIsSelf(tile)
            if let ex = byName[name], ex.area >= area { return }
            byName[name] = Acc(area: area, speaking: speaking, isMe: isMe, minY: frame.minY, minX: frame.minX)
        }

        // Captions first — the authoritative display name.
        for (node, name) in captionNodes {
            guard let tile = meetTileAncestor(of: node) else { continue }
            captionFrames.append(axFrame(tile) ?? .zero)
            consider(tile, name)
        }
        // Control labels ONLY for a tile that produced no caption (the nameless PIP
        // tile — the reported "Wedding Thapas speaking shows Bibek" case).
        for (node, name) in controlNodes {
            guard let tile = meetTileAncestor(of: node) else { continue }
            let frame = axFrame(tile) ?? .zero
            if captionFrames.contains(where: { $0 == frame }) { continue }
            consider(tile, name)
        }

        let ordered = byName.sorted { ($0.value.minY, $0.value.minX) < ($1.value.minY, $1.value.minX) }
        let tiles = ordered.enumerated().map { i, kv in
            MeetTileObservation(name: kv.key, area: kv.value.area, orderIndex: i,
                                classSpeaking: kv.value.speaking, isMe: kv.value.isMe)
        }
        return (tiles, ordered.map { $0.key })
    }

    /// Extract a participant name from a per-tile control's accessible label. Meet
    /// labels each tile's Pin / More-options button with the participant name, and
    /// in the PIP / small-tile layouts (no visible caption) that label is the ONLY
    /// place the name survives:
    ///   "Pin Wedding Thapas to your main screen"  -> "Wedding Thapas"
    ///   "More options for david Thapa"            -> "david Thapa"
    /// English/localized wording — a structural anchor, not a rotating class.
    private func meetNameFromControlLabel(_ raw: String) -> String? {
        let d = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let low = d.lowercased()
        // "Pin <Name> to your main screen" / "Pin <Name>'s presentation to …"
        if low.hasPrefix("pin ") {
            var rest = String(d.dropFirst(4))
            for tail in [" to your main screen", " to your main", "’s presentation",
                         "'s presentation", " to your", " to the main screen"] {
                if let t = rest.range(of: tail, options: .caseInsensitive) {
                    rest = String(rest[..<t.lowerBound]); break
                }
            }
            return cleanParticipantName(rest)
        }
        // "More options for <Name>"
        if low.hasPrefix("more options for ") {
            return cleanParticipantName(String(d.dropFirst("more options for ".count)))
        }
        return nil
    }

    /// The Meet video-stage scan root: the page's `<main>` landmark
    /// (`AXLandmarkMain`) INSIDE the meet.google.com `AXWebArea`. Scoping here is
    /// the structural fix for browser-chrome pollution — the address bar, other
    /// tabs, and an open DevTools panel (its own `AXWebArea` + a "DOM tree
    /// explorer" `AXLandmarkMain`) all sit OUTSIDE this node, so their text can no
    /// longer be harvested as fake participants. The URL match on the web area is
    /// what distinguishes the Meet `<main>` from DevTools' `<main>`. Falls back to
    /// the meet web area, then the window, for older layouts.
    private func meetStageRoot(in window: AXUIElement) -> AXUIElement {
        var webArea: AXUIElement?
        var n = 0
        func findWeb(_ el: AXUIElement, _ d: Int) {
            if webArea != nil || n >= 4000 || d > maxDepth { return }
            n += 1
            if axString(el, "AXRole") == "AXWebArea", let u = axURL(el), platformForURL(u) == .meet {
                webArea = el; return
            }
            for c in axArray(el, "AXChildren") { findWeb(c, d + 1); if webArea != nil { return } }
        }
        findWeb(window, 0)
        let base = webArea ?? window

        var main: AXUIElement?
        var m = 0
        func findMain(_ el: AXUIElement, _ d: Int) {
            if main != nil || m >= 4000 || d > maxDepth { return }
            m += 1
            if axString(el, "AXSubrole") == "AXLandmarkMain" { main = el; return }
            for c in axArray(el, "AXChildren") { findMain(c, d + 1); if main != nil { return } }
        }
        findMain(base, 0)
        return main ?? base
    }

    /// Is this Meet tab actually IN a call — not the landing / "Ready to join" /
    /// post-call screen, which all share the same meet.google.com/<code> URL?
    /// Ported from the product's `meetCallActive` (bubbles-meet-detector): require a
    /// "Leave call" button OR the "Call controls" landmark region. Both appear on
    /// join and disappear the instant the call ends — so this is what starts a
    /// meeting and (by absence) ends it. See MeetExtractor.swift:20-40.
    private func meetCallActive(in window: AXUIElement) -> Bool {
        var active = false
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if active || n >= maxNodesPerWindow || d > maxDepth { return }
            n += 1
            if let role = axString(el, "AXRole") {
                if role == "AXButton",
                   let desc = axString(el, "AXDescription")?.lowercased(),
                   desc.contains("leave call") {
                    active = true; return
                }
                if role == "AXGroup", axString(el, "AXSubrole") == "AXLandmarkRegion",
                   let desc = axString(el, "AXDescription")?.lowercased(),
                   desc.contains("call controls") {
                    active = true; return
                }
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1); if active { return } }
        }
        rec(window, 0)
        return active
    }

    /// Is this Zoom Web Client tab actually IN a call — not the join/landing page,
    /// an ai.zoom.us marketing page, an OAuth callback, or a post-call screen (all
    /// can carry a zoom.us URL)? Ported from the product's `zoomWebCallActive`
    /// (ZoomExtractor.swift): a "Leave"/"End" button or a "participants list"
    /// control/list. All vanish when the call ends.
    private func zoomWebCallActive(in window: AXUIElement) -> Bool {
        var active = false
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if active || n >= maxNodesPerWindow || d > maxDepth { return }
            n += 1
            if let role = axString(el, "AXRole") {
                if role == "AXButton", let desc = axString(el, "AXDescription")?.lowercased() {
                    if desc == "end" || desc == "leave"
                        || desc.contains("manage participants list")
                        || desc.contains("participants list pane")
                        || desc.contains("the participants list") {
                        active = true; return
                    }
                }
                if role == "AXList", let desc = axString(el, "AXDescription")?.lowercased(),
                   desc.contains("participants list") {
                    active = true; return
                }
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1); if active { return } }
        }
        rec(window, 0)
        return active
    }

    /// Zoom's Picture-in-Picture thumbnail. Verified via AXDump: it's a floating
    /// window with SUBROLE "AXSystemDialog", a "Talking:" active-speaker indicator
    /// and a "Show video render" button. Its title is "Zoom" when expanded but
    /// EMPTY when collapsed, so key on the subrole + that content (not the title) —
    /// both states then keep the call alive, and the meeting ends only once this
    /// window closes. Its AX tree lacks the roster / Leave button / mic control the
    /// main window exposes, so this is the only "still in the call" signal in PIP.
    /// Reads the Zoom PIP thumbnail's content: the active speaker from its
    /// "Talking: <name>" static text (Zoom's own VAD), plus any participant-name
    /// label shown. Static-text only, so the "Show video render" button doesn't leak
    /// in. `speaker` is nil when nobody is talking.
    private func zoomPipContent(in window: AXUIElement) -> (speaker: String?, names: [String]) {
        var speaker: String?
        var names: [String] = []
        var seen = Set<String>()
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if n >= 800 || d > 20 { return }
            n += 1
            if axString(el, "AXRole") == "AXStaticText",
               let raw = axString(el, "AXValue") ?? axString(el, "AXTitle"), !raw.isEmpty {
                if let r = raw.range(of: "talking:", options: .caseInsensitive) {
                    let after = String(raw[r.upperBound...]).trimmingCharacters(in: .whitespaces)
                    if !after.isEmpty, let clean = cleanParticipantName(after) { speaker = clean }
                } else if let clean = cleanParticipantName(raw), seen.insert(clean).inserted {
                    names.append(clean)
                }
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1) }
        }
        rec(window, 0)
        return (speaker ?? names.first, names)
    }

    private func zoomIsPipWindow(_ window: AXUIElement) -> Bool {
        guard axString(window, "AXSubrole") == "AXSystemDialog" else { return false }
        var isPip = false
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if isPip || n >= 800 || d > 20 { return }
            n += 1
            for attr in ["AXValue", "AXDescription", "AXHelp"] {
                if let s = axString(el, attr)?.lowercased(),
                   s.contains("talking") || s.contains("video render") || s.contains("show video") {
                    isPip = true; return
                }
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1); if isPip { return } }
        }
        rec(window, 0)
        return isPip
    }

    /// Native Zoom in-call check: a "Leave"/"End Meeting" button in the meeting
    /// window's controls. Complements the "Zoom Meeting" window-title signal so the
    /// call is recognised as active even mid-title-change, and drops to inactive
    /// (→ meeting_ended) once you leave and Zoom returns to the home window.
    private func zoomNativeCallActive(in window: AXUIElement) -> Bool {
        var active = false
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if active || n >= maxNodesPerWindow || d > maxDepth { return }
            n += 1
            if let role = axString(el, "AXRole"), role == "AXButton" {
                let label = ((axString(el, "AXTitle") ?? "") + " "
                    + (axString(el, "AXDescription") ?? "")).lowercased()
                if label.contains("leave meeting") || label.contains("end meeting")
                    || label.contains("leave") {
                    active = true; return
                }
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1); if active { return } }
        }
        rec(window, 0)
        return active
    }

    /// When the Meet People panel is OPEN, read the roster straight from it — the
    /// authoritative source (one row per participant), so we never guess from tiles
    /// or harvest toasts. Returns [] when the panel isn't found (caller falls back to
    /// tiles). Modeled on the product's `findPeoplePanel` (bubbles-meet-detector).
    private func meetPanelRoster(in window: AXUIElement) -> [String] {
        guard let panel = findPeoplePanel(in: window) else { return [] }
        var names: [String] = []
        var seen = Set<String>()
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if n >= 4000 || d > maxDepth { return }
            n += 1
            for attr in ["AXDescription", "AXTitle", "AXValue"] {
                if let raw = axString(el, attr), let name = cleanParticipantName(raw),
                   seen.insert(name).inserted {
                    names.append(name); break
                }
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1) }
        }
        rec(panel, 0)
        return names
    }

    /// Find the People/Participants panel container: an AXList/AXGroup whose label
    /// says "participant"/"people" and that has children.
    private func findPeoplePanel(in window: AXUIElement) -> AXUIElement? {
        var found: AXUIElement?
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if found != nil || n >= maxNodesPerWindow || d > maxDepth { return }
            n += 1
            if let role = axString(el, "AXRole"), role == "AXList" || role == "AXGroup" {
                let label = (axString(el, "AXDescription") ?? axString(el, "AXTitle") ?? "").lowercased()
                if (label.contains("participant") || label == "people"),
                   !axArray(el, "AXChildren").isEmpty {
                    found = el; return
                }
            }
            for c: AXUIElement in axArray(el, "AXChildren") { rec(c, d + 1); if found != nil { return } }
        }
        rec(window, 0)
        return found
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
    /// True when an AXMenuItem description is a real Teams participant tile:
    /// "<Name>, video is on/off[, muted], Context menu is available" (remote) or
    /// "Myself video, <Name>, Unmuted, Has context menu" (self). Requires BOTH the
    /// context-menu affordance (every tile has it; chrome doesn't) AND a video/self
    /// marker, so lobby/pre-join controls and status toasts never pass.
    private static func isTeamsParticipantTile(_ desc: String) -> Bool {
        let l = desc.lowercased()
        guard l.contains("context menu") || l.contains("has context") else { return false }
        return l.contains("video is") || l.contains("video on") || l.contains("video off")
            || l.contains("myself video")
    }

    private func teamsTileObservations(in window: AXUIElement) -> (tiles: [TeamsTileObservation], participants: [String]) {
        var nameNodes: [(AXUIElement, String)] = []
        var scanned = 0
        func collect(_ el: AXUIElement, _ depth: Int) {
            if scanned >= maxNodesPerWindow || depth > maxDepth { return }
            scanned += 1
            // Only REAL participant tiles: Teams renders each as an AXMenuItem whose
            // AXDescription is "<Name>, video is on/off[, muted], Context menu is
            // available" (self: "Myself video, <Name>, Unmuted, Has context menu").
            // Anchoring on that STRUCTURE — not any text node — drops lobby chrome
            // ("Join now", "Computer audio"), status strings ("On hold", "Your camera
            // is turned on"), and the progressive name-fragment AXStaticTexts
            // ("Bib" → "Bibe" → "Bibek" …) that were leaking in as participants.
            if axString(el, "AXRole") == "AXMenuItem",
               let desc = axString(el, "AXDescription"), Self.isTeamsParticipantTile(desc),
               let name = cleanParticipantName(desc) {
                nameNodes.append((el, name))
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
            // Teams writes an explicit "muted" token on a muted tile but NOTHING
            // when a remote is unmuted (only the self tile says "Unmuted"). So a
            // real participant tile with no muted token is unmuted — otherwise
            // remote unmute never surfaces (is_muted stays unknown for everyone
            // who isn't muted). A tile always has a name here, so treat unknown as
            // unmuted rather than dropping the state.
            let unmuted = teamsRules.muteState(textBlob: blob, classTokens: classes) ?? true
            if let ex = byName[name], ex.area >= area { continue }
            byName[name] = Acc(area: area, speaking: speaking, isMe: isMe, unmuted: unmuted, minY: frame.minY, minX: frame.minX)
        }

        let ordered: [Dictionary<String, Acc>.Element] = byName.sorted { ($0.value.minY, $0.value.minX) < ($1.value.minY, $1.value.minX) }
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
        // Teams packs each participant's mute / self / video state into an
        // AXMenuItem ANCESTOR's AXDescription ("<Name>, video is on, muted, Context
        // menu is available") that sits ABOVE the video-frame tile — OUTSIDE the
        // subtree scanned above. Climb up and fold in ancestor descriptions (+ their
        // classes) up to that menu-item row, else remote mute / self are never read.
        var cur = axParent(tile)
        var up = 0
        while let el = cur, up < 8 {
            if let d = axString(el, "AXDescription"), !d.isEmpty {
                parts.append(d)
                for t in axClassList(el) { classes.insert(t) }
                if d.lowercased().contains("context menu") { break } // the tile's menu-item row
            }
            cur = axParent(el)
            up += 1
        }
        return (parts.joined(separator: " ").lowercased(), classes)
    }
}
