import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import SpeakerCore
import AXKit

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
    /// The owning application's process id — tracked per window so the engine's
    /// TeamsMeetingMemory can key a throttled meeting to its process (and a future
    /// targeted re-read can re-reach it by pid). nil when unavailable.
    var pid: Int32? = nil
}

/// The macOS equivalent of the original's Windows UI Automation engine.
///
/// Walks the Accessibility (AX) tree of running meeting apps / browser meeting
/// tabs to find who is speaking. Like the original this is platform-specific
/// and best-effort: when names can't be read it still reports the window so the
/// audio path can log a "Someone" session. Requires Accessibility permission.
final class AccessibilityScanner {

    /// The signed-in local user's display name, set by DetectionEngine from config.
    /// Used to identify the SELF tile by name — necessary because the `(You)` label
    /// was removed from the current-build Meet AX tree (2026-07-03), so the legacy
    /// `meetTileIsSelf` "(You)" scan no longer matches. Default "You" is a no-op.
    var meetLocalUserName: String = "You"

    /// Teams meetingIds seen READABLE recently (set by DetectionEngine each tick from
    /// `TeamsMeetingMemory`). A Teams meeting window whose WebView2 tree is throttled
    /// (backgrounded / on another Teams section) but whose title still resolves to one
    /// of these ids is kept alive instead of dropped — so the call survives being
    /// unreadable and resumes the live ring once reachable. Empty ⇒ legacy behavior.
    var teamsActiveMeetingIds: Set<String> = []

    /// Stage-2 CPU win (plan step 8): when the event-driven observer is live, skip the
    /// EXPENSIVE Meet per-tile sub-walk (`meetTileObservations` + panel roster) inside
    /// `scan()` — the observer's bounded subtree reads supply Meet tiles instead. The
    /// Meet window is still detected + call-gated (so the meeting stays alive) but comes
    /// back with EMPTY `meetTiles`, which the engine's event branch ignores in favor of
    /// the observer snapshot. Teams/Zoom sub-walks are untouched. Default false =
    /// legacy full walk (so `full_walks` counts per scan for the A/B baseline).
    var skipMeetSubWalk: Bool = false

    /// Zoom-web analog of `skipMeetSubWalk` (plan A4): when the Zoom-web event
    /// observer is live, skip the expensive per-tick `zoomWebSpeakerBar` sub-walk —
    /// the observer's bounded reads supply the active speaker instead. The window is
    /// still detected + call-gated (meeting stays alive) but `zoomWebSpeaker` comes
    /// back nil, which the engine's event branch ignores in favor of the observer
    /// snapshot. Default false = legacy full read (so zoomweb full_walks counts).
    var skipZoomWebSubWalk: Bool = false

    /// A tile's name identifies self when it equals the configured local user name
    /// (case-insensitive). No-op when the name is the placeholder "You".
    private func meetNameIsSelf(_ name: String) -> Bool {
        let n = meetLocalUserName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty, n.lowercased() != "you" else { return false }
        return name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == n.lowercased()
    }

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

    /// CAPTURE FIX (2026-07-03) — force-activate the target process by PID before the
    /// AX read so Chrome materializes the LIVE equalizer state.
    ///
    /// NOTE: the user asked for this "in MeetActiveSpeaker.swift", but that file is
    /// PURE logic (Foundation only, unit-testable, no AppKit) — the correct home for
    /// an activation side-effect is here in the scanner, which already owns every AX
    /// I/O call. MeetActiveSpeaker.swift carries a one-line pointer back to this.
    ///
    /// The AXManualAccessibility / AXEnhancedUserInterface flags alone are NOT
    /// sufficient: Chrome only publishes the animating equalizer classes when its
    /// window is genuinely frontmost, and System Events' set-frontmost snaps back to a
    /// different same-bundle background Chrome. `NSRunningApplication.activate` targets
    /// THIS exact PID. AppKit-guarded so the SpeakerCore logic stays platform-portable.
    static func forceActivateForCapture(pid: pid_t) {
        AXKit.forceActivateForCapture(pid: pid)
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
            // Force the FULL a11y tree on Chromium/Electron apps (parity with the
            // AXSnapshot / MeetProbe diagnostic tools). Without these two flags a
            // Chromium/WebView2/Electron app serves a degraded, mostly-static tree
            // to passive readers, so dynamic roster/mute/geometry state can be stale
            // or missing. Idempotent + cheap; gate to browser/native meeting apps so
            // we don't poke unrelated processes.
            if isBrowser || isNative {
                AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
                AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
                // CAPTURE FIX (2026-07-03): the AXManual/AXEnhanced flags alone are NOT
                // enough to read the LIVE equalizer state — Chrome only materializes it
                // when the window is genuinely frontmost. Force-activate the target PID
                // directly (System Events "set frontmost" snaps back to a same-bundle
                // background Chrome). See `forceActivateForCapture`.
                //
                // EVENT MODE (skipMeetSubWalk): the MeetTileObserver owns Meet
                // materialization — it activates AROUND reconcile and on a stale read, not
                // every tick (handoff §6 / plan step 6: "event mode should reduce
                // activation frequency … activate around reconcile/settle, not every
                // tick"). Force-activating EVERY 500ms scan here on top of that was a
                // per-tick CPU tax (window-server + AX re-serialize churn) AND the known
                // frontmost-pinning UX blocker, and it double-activated with the observer.
                // So in event mode `scan()` does NOT pin Chrome frontmost each tick; the
                // AXManual/AXEnhanced flags (idempotent, cheap) still get set. Legacy mode
                // (skipMeetSubWalk == false) is byte-for-byte unchanged.
                //
                // NATIVE TEAMS is EXCLUDED from the per-tick force-activate: its speaker
                // ring (vdi-frame-occlusion) is readable whenever the meeting view is
                // foreground, so pulling Teams frontmost every 500ms would just steal the
                // user's focus for no gain. Instead we LET Teams background — the meeting
                // survives via TeamsMeetingMemory (kept alive by title/pid) and the live
                // ring resumes the instant the user returns to it. The AXManual/AXEnhanced
                // flags are still set so the tree is full when it IS foreground.
                let isTeams = Self.nativeApps[bundleID] == .teams
                if !skipMeetSubWalk && !isTeams {
                    Self.forceActivateForCapture(pid: app.processIdentifier)
                }
            }
            // Native Zoom: ALL the app's windows fuse into ONE ScannedWindow —
            // main meeting window + detached Participants panel + PIP + the
            // app-wide "(me)" self hint — via the PURE SpeakerCore extractor
            // (zoomExtractWindow/zoomFuseWindows, the same code the fixture
            // replay exercises). Emitting one window per app is what stops a
            // detached panel / PIP from double-attributing into zoom::meeting.
            if Self.nativeApps[bundleID] == .zoom {
                if let fused = scanZoomNative(axApp) { results.append(fused) }
                continue
            }
            // Native Teams: the signed-in user's name from the "Profile picture of
            // <Name>." label (home window), resolved ONCE — the self signal for
            // layouts with no "Myself video" tile (solo call / roster-only panel).
            let teamsSelfHint: String? = (Self.nativeApps[bundleID] == .teams)
                ? teamsSelfHintAcrossWindows(axApp) : nil
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
                // Stage-2 CPU win (plan step 8): the ~6000-node deep `walk()` is the walk
                // that dominates the poll cost. In EVENT mode (skipMeetSubWalk) the observer
                // supplies ALL Meet tile/speaker data, and the Meet branch throws away
                // everything the deep walk would produce for a Meet window anyway (meetTiles
                // / participants are cleared below). So when the pre-walk AXURL already
                // classifies this window as Meet, SKIP the deep walk entirely — the window
                // is still detected + call-gated via `meetCallActive` (a targeted, early-
                // terminating search that keeps the meeting alive). Only the full-scan Meet
                // walk is skipped; Teams/Zoom and legacy mode are byte-for-byte unchanged
                // (they still do the deep walk). This is what makes eventCpu << pollingCpu:
                // skipping the sub-tile pass alone (as before) left the dominant walk intact.
                let skipMeetDeepWalk = skipMeetSubWalk && platformForURL(webURL) == .meet
                if !skipMeetDeepWalk {
                    walk(window, depth: 0, into: &collector)
                }

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
                    speakers = []   // engine resolves Meet speakers from meetTiles (kssMZb) / observer edges
                    if skipMeetSubWalk {
                        // Stage-2 CPU win (plan step 8): the event-driven observer is
                        // live, so SKIP the expensive per-tile sub-walk + panel roster.
                        // The window is still detected + call-gated (meeting stays
                        // alive); `meetTiles` stays empty and the engine's event branch
                        // attributes from the observer snapshot instead. This is the
                        // walk that dominated the poll cost — eliminating it is the whole
                        // point of event mode.
                        meetTiles = []
                        participants = []
                    } else {
                        // Meet's active speaker is fused (geometry + class + VAD) in the
                        // engine — the scanner supplies per-tile observations + presentation.
                        let m = meetTileObservations(in: window)
                        meetTiles = m.tiles
                        presentationActive = meetPresentationActive(in: window)
                        // Roster: the People panel when it's open (authoritative), else the
                        // tile-anchored names. Speaking detection is unchanged.
                        let panel = meetPanelRoster(in: window)
                        participants = panel.isEmpty ? dedup(m.participants) : dedup(panel)
                    }
                } else if platform == .teams {
                    // ONE bounded AX→TeamsAXNode conversion, then the PURE extractor
                    // (SpeakerCore.teamsExtractWindow) — the same code the fixture
                    // replay in SpeakerCoreSelfTest exercises, so the deterministic
                    // harness tests EXACTLY the shipping extraction (no drift).
                    let ex = teamsExtractWindow(windowNode(window), rules: teamsRules,
                                                selfHint: teamsSelfHint)
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
                        if let sp = ex.speakingNote {
                            pipSpeaker = sp
                            participants = [sp]
                        } else {
                            participants = []
                            keepAliveOnly = true
                        }
                    } else if ex.callActive || !ex.roster.isEmpty
                                || ex.tiles.contains(where: { $0.isMe }) {
                        // ACTIVE-CALL gate (product parity): a "Leave" button, a "Shared
                        // content" main landmark, or an "Attendees" outline — covers native
                        // AND web Teams. The meeting URL alone is NOT enough (…/light-
                        // meetings/launch is the launcher page before joining); the chat /
                        // home window lacks these too. Roster / self tile corroborate.
                        teamsTiles = ex.tiles
                        // Remote mute from the People-panel roster (panel open only —
                        // the one dependable source); the tile rows carry it otherwise.
                        teamsRoster = ex.roster
                        speakers = []   // engine resolves Teams speakers from teamsTiles + audio
                        participants = ex.participants
                        // Main window: the engine names the speaker from the per-tile
                        // RING (vdi-frame-occlusion) — overlap-capable and always
                        // present when foreground. The transient "<name> is speaking"
                        // note is NOT used here (it names only one and is usually
                        // absent); it stays the compact-window signal above.
                        pipSpeaker = nil
                    } else if teamsActiveMeetingIds.contains(
                                meetingId(platform: .teams, url: nil, title: title)) {
                        // THROTTLED but KNOWN-ACTIVE: the WebView2 tree came back empty
                        // (Teams is backgrounded / on another section), but this window's
                        // title still resolves to a meetingId we saw READABLE recently, so
                        // the call is still up — keep it alive (empty tiles/roster; the
                        // engine holds the last-known roster from TeamsMeetingMemory) so it
                        // doesn't age out, and resume the live ring the instant it's
                        // reachable again. Without this, minimising Teams ended the meeting.
                        speakers = []
                        participants = []
                        keepAliveOnly = true
                    } else {
                        continue
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
                    if skipZoomWebSubWalk {
                        // Event mode (plan A4): the Zoom-web observer's bounded reads
                        // supply the active speaker + roster, so SKIP the expensive
                        // per-tick speaker-bar sub-walk. The window is still detected +
                        // call-gated (meeting stays alive); `zoomWebSpeaker` stays nil
                        // and the engine attributes from the observer snapshot instead.
                        zoomWebSpeaker = nil
                        participants = []
                    } else {
                        // Active speaker + roster from the speaker-bar tiles: the
                        // `…__video-frame--active` tile is whoever is talking; the plain
                        // `…__video-frame` tiles are the idle participants.
                        let bar = zoomWebSpeakerBar(in: window)
                        zoomWebSpeaker = bar.active
                        participants = dedup(bar.names + speakers)
                    }
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
                    keepAliveOnly: keepAliveOnly,
                    pid: app.processIdentifier
                ))
            }
        }
        return results
    }

    // MARK: Bounded Meet subtree scan (event-driven refresh + reconciliation)

    /// Result of `meetStageSubtreeScan(pid:)` — the SAME per-tile facts a full
    /// `scan()` produces for Meet, but for ONE Chrome pid and WITHOUT the multi-window,
    /// multi-platform sweep. `callActive == false` means the tab is a landing/post-call
    /// screen or backgrounded (no "Leave call" / call-controls landmark) — the observer
    /// treats that like a dead read and lets the reconcile sweep clear its snapshot.
    struct MeetSubtreeScan: Equatable {
        var tiles: [MeetTileObservation]
        var participants: [String]
        var presentationActive: Bool
        var callActive: Bool
        var url: String?
        /// Nodes visited resolving the stage root — a cheap "did we actually read a
        /// live tree" sanity signal (a backgrounded tab yields a near-empty walk).
        var reachable: Bool
    }

    /// Read ONLY Google Meet's video-stage subtree for a single Chrome pid — the
    /// cheap replacement for the full `scan()` used by the event-driven path
    /// (observer refresh + the reconciliation sweep). Reuses the exact same
    /// `meetStageRoot` / `meetTileObservations` / `meetPresentationActive` /
    /// `meetCallActive` code the polling path uses, so event mode reads IDENTICAL
    /// per-tile facts — no second, drift-prone extractor.
    ///
    /// Materialization (handoff §5): forces the full AX tree + activates the pid so
    /// the equalizer/ring state is live. Callers drive activate→settle→read cadence
    /// (they call this AFTER a settle, not in the same instant they activate).
    func meetStageSubtreeScan(pid: pid_t) -> MeetSubtreeScan? {
        guard AXIsProcessTrusted() else { return nil }
        let axApp = AXUIElementCreateApplication(pid)
        AXKit.forceFullAXTree(pid: pid)

        // Find the Chrome window hosting the Meet call. Classify by AXWebArea AXURL
        // (address-bar-independent — works for the PWA), exactly like `scan()`.
        for window in axArray(axApp, "AXWindows") {
            guard let webURL = webAreaMeetingURL(in: window),
                  platformForURL(webURL) == .meet else { continue }
            let callActive = meetCallActive(in: window)
            let m = meetTileObservations(in: window)
            let panel = meetPanelRoster(in: window)
            let participants = panel.isEmpty ? m.participants : dedup(panel)
            return MeetSubtreeScan(
                tiles: m.tiles,
                participants: participants,
                presentationActive: meetPresentationActive(in: window),
                callActive: callActive,
                url: webURL,
                reachable: true)
        }
        return nil
    }

    /// The Meet video-stage root AX element for a single Chrome pid — the subscription
    /// anchor the observer walks to find tiles + equalizer-anchor nodes. Returns the
    /// window too so the observer can subscribe app-level notifications. nil when no
    /// Meet window is present for this pid.
    func meetStageElements(pid: pid_t) -> (app: AXUIElement, window: AXUIElement, stage: AXUIElement)? {
        guard AXIsProcessTrusted() else { return nil }
        let axApp = AXUIElementCreateApplication(pid)
        AXKit.forceFullAXTree(pid: pid)
        for window in axArray(axApp, "AXWindows") {
            guard let webURL = webAreaMeetingURL(in: window),
                  platformForURL(webURL) == .meet else { continue }
            return (axApp, window, meetStageRoot(in: window))
        }
        return nil
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
                if zoomRules.webAvatarNameClasses.contains(where: { classes.contains($0) }) {
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
            let isBar = classes.contains { $0.hasPrefix(zoomRules.webFilmstripFramePrefix) }
            let isBig = classes.contains { $0.hasPrefix(zoomRules.webBigFramePrefix) }
            if isBar || isBig {
                if let name = tileName(el) {
                    names.append(name)
                    if classes.contains(zoomRules.webActiveClass) { barActive = name }
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

    // MARK: Zoom WEB event-driven bounded reads (mirror the Meet stage scan)

    /// The result of one bounded Zoom-web tile subtree read for a single Chrome pid
    /// — the SAME per-tile facts a full `scan()` produces for Zoom web, but WITHOUT
    /// the multi-window / multi-platform sweep. `callActive == false` means the tab
    /// is a landing / post-call / backgrounded surface, so the observer treats it
    /// like a dead read and lets the reconcile sweep clear its snapshot.
    struct ZoomWebSubtreeScan: Equatable {
        var tiles: [ZoomWebTileObservation]
        var participants: [String]
        var callActive: Bool
        var url: String?
        /// Diagnostics for the stale-selector forensic dump: per-family container
        /// counts + the raw class chains of tile-shaped candidate groups. Only
        /// populated when NO tile matched (the observer rate-limits the emit).
        var selectorCounts: [String: Int]
        var candidateClassChains: [[String]]
    }

    /// Locate the Chrome window hosting a Zoom WEB call for a single pid — the
    /// subscription anchor + call-gate anchor for `ZoomWebTileObserver`. Classifies
    /// by AXWebArea AXURL (address-bar-independent), exactly like `scan()`. nil when
    /// no Zoom-web window is present for this pid.
    func zoomWebElements(pid: pid_t) -> (app: AXUIElement, window: AXUIElement)? {
        guard AXIsProcessTrusted() else { return nil }
        let axApp = AXUIElementCreateApplication(pid)
        AXKit.forceFullAXTree(pid: pid)
        for window in axArray(axApp, "AXWindows") {
            guard let webURL = webAreaMeetingURL(in: window),
                  platformForURL(webURL) == .zoom else { continue }
            return (axApp, window)
        }
        return nil
    }

    /// Read ONLY the Zoom-web tile subtree for a single Chrome pid — the cheap
    /// replacement for the full `scan()` used by the event-driven path (observer
    /// refresh + reconcile sweep). Reuses the SAME tile-family / active / name /
    /// mute grammar (`ZoomSpeakerRules`) the polling `zoomWebSpeakerBar` uses, so
    /// event mode reads identical per-tile facts — no second, drift-prone extractor.
    func zoomWebTileScan(pid: pid_t, selfName: String?) -> ZoomWebSubtreeScan? {
        guard AXIsProcessTrusted() else { return nil }
        let axApp = AXUIElementCreateApplication(pid)
        AXKit.forceFullAXTree(pid: pid)
        for window in axArray(axApp, "AXWindows") {
            guard let webURL = webAreaMeetingURL(in: window),
                  platformForURL(webURL) == .zoom else { continue }
            let callActive = zoomWebCallActive(in: window)
            let selfUnmuted = zoomWebSelfUnmuted(in: window)
            let read = zoomWebTileObservations(in: window, selfName: selfName,
                                               selfUnmuted: selfUnmuted)
            return ZoomWebSubtreeScan(
                tiles: read.tiles,
                participants: read.tiles.map { $0.name },
                callActive: callActive,
                url: webURL,
                selectorCounts: read.selectorCounts,
                candidateClassChains: read.candidateClassChains)
        }
        return nil
    }

    /// Read the local self-mute state from the Zoom-web toolbar mic control
    /// ("mute my microphone" = unmuted, "unmute my microphone" = muted) — the
    /// cross-validation signal for self-exclusion (A4). nil when not found.
    private func zoomWebSelfUnmuted(in window: AXUIElement) -> Bool? {
        var result: Bool?
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if result != nil || n >= maxNodesPerWindow || d > maxDepth { return }
            n += 1
            for attr in ["AXDescription", "AXTitle", "AXValue"] {
                if let raw = axString(el, attr),
                   let u = zoomRules.webSelfUnmuted(raw.lowercased()) { result = u; return }
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1); if result != nil { return } }
        }
        rec(window, 0)
        return result
    }

    /// Build the per-tile `ZoomWebTileObservation`s the event path diffs — name +
    /// active-class + per-tile mute + self flag + surface family — plus the
    /// stale-selector forensics (per-family container counts + candidate class
    /// chains) so a class rotation is diagnosable rather than a silent null.
    ///
    /// Self-exclusion is cross-validated at BUILD level: a tile is `isMe` when its
    /// name matches the resolved local self name (learned from "(me)" / the footer)
    /// — the snapshot layer then drops it, and it can never be an edge holder.
    private func zoomWebTileObservations(in window: AXUIElement, selfName: String?,
                                         selfUnmuted: Bool?)
        -> (tiles: [ZoomWebTileObservation], selectorCounts: [String: Int],
            candidateClassChains: [[String]]) {
        var tiles: [ZoomWebTileObservation] = []
        var seen = Set<String>()
        var counts: [String: Int] = ["filmstrip": 0, "speaker": 0, "gallery": 0]
        var chains: [[String]] = []
        var n = 0

        func rec(_ el: AXUIElement, _ d: Int) {
            if n >= maxNodesPerWindow || d > maxDepth { return }
            n += 1
            let classes = axClassList(el)
            if let surface = zoomRules.webTileSurface(classList: classes) {
                counts[surface, default: 0] += 1
                if chains.count < 12 { chains.append(classes) }
                if let name = zoomWebTileName(el), seen.insert(name).inserted {
                    let active = zoomRules.webTileIsActive(classList: classes)
                    let muted = zoomRules.webTileMuted(classList: classes)
                    let isMe = zoomWebNameIsSelf(name, selfName: selfName)
                    tiles.append(ZoomWebTileObservation(
                        name: name, active: active, isMe: isMe,
                        muted: muted, surface: surface))
                }
                return   // a tile is a leaf for our purposes; don't descend
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1) }
        }
        rec(window, 0)
        _ = selfUnmuted   // reserved: cross-validate the self tile's mute vs the toolbar (telemetry)
        return (tiles, counts, chains)
    }

    /// A tile's display name: prefer the avatar image alt (real name, camera off),
    /// fall back to the footer / static-text label (always present, camera on).
    /// Mirrors `zoomWebSpeakerBar.tileName` so both paths read the same names.
    private func zoomWebTileName(_ frame: AXUIElement) -> String? {
        var imgName: String?
        var footerName: String?
        func rec(_ el: AXUIElement, _ d: Int) {
            if imgName != nil || d > maxDepth { return }
            let classes = axClassList(el)
            if zoomRules.webAvatarNameClasses.contains(where: { classes.contains($0) }) {
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

    /// Case-insensitive self-name match (no-op when self isn't resolved yet).
    private func zoomWebNameIsSelf(_ name: String, selfName: String?) -> Bool {
        guard let s = selfName, !s.isEmpty else { return false }
        return name.caseInsensitiveCompare(s) == .orderedSame
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
        // Teams' toolbar reads "Unmute mic" (muted) / "Mute mic" (unmuted) —
        // an independent local-mute signal that survives a hidden self tile.
        if lower.contains("unmute my") || lower.contains("unmute (") || lower == "unmute"
            || lower.contains("unmute mic") || lower.contains("turn on microphone") {
            c.localUserUnmuted = false
        } else if lower.contains("mute my") || lower.contains("mute (") || lower == "mute"
            || lower.contains("mute mic") || lower.contains("turn off microphone") {
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

    // AX I/O is hoisted to the shared `AXKit` target (Step 1) so the scanner and the
    // event-driven MeetTileObserver read the tree through ONE implementation. These
    // stay as thin private forwarders so every existing call site is unchanged.
    private func axString(_ el: AXUIElement, _ attr: String) -> String? { AXKit.axString(el, attr) }

    private func axArray(_ el: AXUIElement, _ attr: String) -> [AXUIElement] { AXKit.axArray(el, attr) }

    private func axClassList(_ el: AXUIElement) -> [String] { AXKit.axClassList(el) }

    /// Read a boolean AX attribute (e.g. AXFocused). Meet marks the promoted/spotlit
    /// tile with AXFocused:true (live-verified 2026-07-03) — a token-free speaker
    /// signal for Auto/spotlight layouts.
    private func axBool(_ el: AXUIElement, _ attr: String) -> Bool { AXKit.axBool(el, attr) }
    /// True if THIS tile, or any descendant, carries AXFocused (Meet puts it on a
    /// child of the promoted tile). Bounded shallow walk.
    private func meetTileFocused(_ tile: AXUIElement) -> Bool {
        if axBool(tile, "AXFocused") { return true }
        var found = false, n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if found || n >= 400 || d > 20 { return }
            n += 1
            if axBool(el, "AXFocused") { found = true; return }
            for c in axArray(el, "AXChildren") { rec(c, d + 1); if found { return } }
        }
        rec(tile, 0)
        return found
    }

    /// The AXURL of an element as a string (comes back as URL / NSURL / String).
    /// Used for meeting-URL classification independent of the address bar.
    private func axURL(_ el: AXUIElement) -> String? { AXKit.axURL(el) }

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

    private func axParent(_ el: AXUIElement) -> AXUIElement? { AXKit.axParent(el) }

    private func axFrame(_ el: AXUIElement) -> CGRect? { AXKit.axFrame(el) }

    // MARK: Native Zoom scan (extraction is pure — SpeakerCore)

    /// Config-loaded Zoom rules (roster/self/PIP text grammar + the web CSS
    /// tokens): a Zoom release that rewords a phrase is a config drop, not a
    /// rebuild. Loaded once per scanner.
    private let zoomRules = ZoomSpeakerRules.resolved()

    /// Scans ALL of native Zoom's windows and fuses them into at most ONE
    /// ScannedWindow: the roster is UNIONED across the main meeting window and
    /// a detached Participants panel, "(me)" resolves app-wide, and the PIP's
    /// "Talking: <name>" note only surfaces when no roster is readable — the
    /// ladder full roster → PIP note → audio-only "Someone" (B2) unchanged.
    /// All parsing decisions live in SpeakerCore (zoomExtractWindow /
    /// zoomFuseWindows), so the fixture replay tests the shipping logic
    /// byte-for-byte. Returns nil for the Zoom Workplace home shell / no call
    /// (post-call the gate fails → the window drops → meeting_ended).
    private func scanZoomNative(_ axApp: AXUIElement) -> ScannedWindow? {
        let windows = axArray(axApp, "AXWindows")
        guard !windows.isEmpty else { return nil }
        let extractions = windows.map { zoomExtractWindow(windowNode($0), rules: zoomRules) }
        let fusion = zoomFuseWindows(extractions, rules: zoomRules)

        // The generic collector corroborates the in-call gate (the mic control
        // → localUserUnmuted, product parity) and supplies nodeCount. Run it on
        // the fused carrier; when fusion found no meeting evidence, probe each
        // window for the mic control before giving up (mid-title-change ticks).
        var collector = TreeCollector()
        var carrierIdx = fusion.carrierIndex
        if let i = carrierIdx {
            walk(windows[i], depth: 0, into: &collector)
        } else {
            for (i, window) in windows.enumerated() {
                var c = TreeCollector()
                walk(window, depth: 0, into: &c)
                if c.localUserUnmuted != nil { collector = c; carrierIdx = i; break }
            }
        }
        guard let idx = carrierIdx else { return nil }

        // PIP-only mode: no roster anywhere → the "Talking:" note names the
        // speaker and supplies the participant; otherwise the fused roster does.
        let participants = fusion.pipSpeaker != nil
            ? dedup(fusion.pipNames + fusion.pipSpeaker.map { [$0] }!)
            : dedup(fusion.roster.map { $0.name })

        let title = axString(windows[idx], "AXTitle") ?? ""
        return ScannedWindow(
            platform: .zoom,
            title: title.isEmpty ? Platform.zoom.label : title,
            url: nil,
            nodeCount: collector.nodeCount,
            treeOk: true,   // native Zoom's tiny tree is normal and reports OK
            speakers: [],   // no direct speaking read on native Zoom
            participants: participants,
            localUserUnmuted: collector.localUserUnmuted,
            directSpeakerRead: false,
            zoomRoster: fusion.roster,
            meetTiles: [],
            presentationActive: false,
            teamsTiles: [],
            teamsRoster: [],
            pipSpeaker: fusion.pipSpeaker,
            zoomWebSpeaker: nil,
            keepAliveOnly: false
        )
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
        struct Acc { var area: Double; var speaking: Bool; var equalizer: Bool; var focused: Bool; var isMe: Bool; var minY: CGFloat; var minX: CGFloat }
        var byName: [String: Acc] = [:]
        var captionFrames: [CGRect] = []
        func consider(_ tile: AXUIElement, _ name: String) {
            let frame = axFrame(tile) ?? .zero
            let area = Double(frame.width * frame.height)
            let speaking = meetTileIsSpeaking(classTokens: tileClassTokens(tile), rules: meetRules)
            let equalizer = meetTileEqualizerSpeaking(tile)
            let focused = meetTileFocused(tile)
            // Self: prefer the account name-match (the `(You)` label was removed from
            // the current-build AX tree, 2026-07-03); fall back to the legacy check.
            let isMe = meetTileIsSelf(tile) || meetNameIsSelf(name)
            if let ex = byName[name], ex.area >= area { return }
            byName[name] = Acc(area: area, speaking: speaking, equalizer: equalizer, focused: focused, isMe: isMe, minY: frame.minY, minX: frame.minX)
        }

        // MULTI-PATTERN STRUCTURAL ALLOWLIST (class-free + geometry-free): a name is a
        // real participant only if corroborated by a structural signal, so browser
        // chrome / toasts / the "More actions" overflow / "Camera is off" overlay can't
        // be harvested even when they slip past the name blocklist. Signals (union):
        //   P1 — the People-panel roster (viewer-independent when the panel is open).
        //   P2 — the caption's TILE contains a per-tile mic/audio indicator or a
        //        name-embedding control (meetTileHasParticipantEvidence).
        //   (a control label is itself P2 evidence.)
        // Tiles are resolved by TREE POSITION (meetTileBlock), never absolute pixels.
        // GRACEFUL FALLBACK: if no structural signal exists anywhere (empty roster AND
        // no tile shows evidence — e.g. a partial tree that pruned the indicators), we
        // accept the legacy way so we never regress to zero participants.
        let roster = Set(meetPanelRoster(in: window).map { $0.lowercased() })
        struct Cand { let tile: AXUIElement; let name: String; let isControl: Bool; let frame: CGRect; let evidence: Bool; let inRoster: Bool }
        var cands: [Cand] = []
        for (isControl, list) in [(false, captionNodes), (true, controlNodes)] {
            for (node, name) in list {
                guard let tile = meetTileAncestor(of: node) else { continue }
                let ev = isControl ? true : meetTileHasParticipantEvidence(tile)
                cands.append(Cand(tile: tile, name: name, isControl: isControl,
                                  frame: axFrame(tile) ?? .zero, evidence: ev,
                                  inRoster: roster.contains(name.lowercased())))
            }
        }
        let anyStructural = !roster.isEmpty || cands.contains { $0.evidence }
        func accept(_ c: Cand) -> Bool { !anyStructural || c.inRoster || c.evidence }
        // Captions first — the authoritative display name.
        for c in cands where !c.isControl && accept(c) {
            captionFrames.append(c.frame)
            consider(c.tile, c.name)
        }
        // Control labels ONLY for a tile that produced no caption (nameless PIP tile).
        for c in cands where c.isControl && accept(c) {
            if captionFrames.contains(where: { $0 == c.frame }) { continue }
            consider(c.tile, c.name)
        }

        let ordered = byName.sorted { ($0.value.minY, $0.value.minX) < ($1.value.minY, $1.value.minX) }
        let tiles = ordered.enumerated().map { i, kv in
            MeetTileObservation(name: kv.key, area: kv.value.area, orderIndex: i,
                                classSpeaking: kv.value.speaking, isFocused: kv.value.focused,
                                isMe: kv.value.isMe, equalizerSpeaking: kv.value.equalizer)
        }
        return (tiles, ordered.map { $0.key })
    }

    /// Per-tile STRUCTURAL evidence that this is a REAL participant tile (class-free):
    ///  (a) it holds a per-tile audio/mic INDICATOR — an equalizer-anchor node
    ///      (`rules.equalizerAnchorClasses` = {DYfzY,IisKdb,QgSmzd}); OR
    ///  (b) it holds a per-participant CONTROL whose AXDescription embeds a name
    ///      ("More options for <Name>" / "Pin <Name>…" / "Mute <Name>'s microphone").
    /// Browser chrome, toasts, the "More actions" overflow and the "Camera is off"
    /// overlay have NEITHER, so their name-like text is rejected as a participant.
    /// Bounded shallow walk (mirrors `meetTileEqualizerSpeaking`).
    private func meetTileHasParticipantEvidence(_ tile: AXUIElement) -> Bool {
        var found = false, n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if found || n >= 800 || d > 40 { return }
            n += 1
            let cl = Set(axClassList(el))
            if meetRules.equalizerAnchorClasses.contains(where: { cl.contains($0) }) { found = true; return }
            for attr in ["AXDescription", "AXTitle"] {
                if let raw = axString(el, attr), meetParticipantNameFromControl(raw, rules: meetRules) != nil {
                    found = true; return
                }
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1); if found { return } }
        }
        rec(tile, 0)
        return found
    }

    /// PROTOTYPE (fresh-capture 2026-07-03): true if ANY descendant of this tile is a
    /// SPEAKING equalizer node — a node whose `AXDOMClassList` satisfies
    /// `meetNodeIsSpeakingEqualizer` (anchor {DYfzY,IisKdb,QgSmzd} present, silence
    /// class `gjg47c` ABSENT). Per-NODE (not the tile's unioned tokens) because the
    /// speaking/silence classes co-live on the SAME equalizer node — unioning the
    /// whole tile would mask the silence class when a sibling caption node lacks it.
    /// Bounded shallow walk, mirrors `meetTileFocused`.
    private func meetTileEqualizerSpeaking(_ tile: AXUIElement) -> Bool {
        var found = false, n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if found || n >= 800 || d > 40 { return }
            n += 1
            if meetNodeIsSpeakingEqualizer(classList: axClassList(el), rules: meetRules) {
                found = true; return
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1); if found { return } }
        }
        rec(tile, 0)
        return found
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
                    if zoomRules.webCallExactButtonLabels.contains(desc)
                        || zoomRules.webCallButtonMarkers.contains(where: { desc.contains($0) }) {
                        active = true; return
                    }
                }
                if role == "AXList", let desc = axString(el, "AXDescription")?.lowercased(),
                   desc.contains(zoomRules.webCallListToken) {
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

    // MARK: Microsoft Teams window conversion (extraction is pure — SpeakerCore)

    /// Config-loaded Teams rules (stable `aria_*`/`calling_*` tokens; speaking
    /// stays a config-only hook — class-free by §7); a token change is a config
    /// drop, not a rebuild. Loaded once.
    private let teamsRules = TeamsSpeakerRules.resolved()

    /// The Teams self-name hint across ALL the app's windows: the meeting window
    /// often lacks the profile button (it lives on the home window), so scan each
    /// window until the "Profile picture of <Name>." label resolves. Cheap direct
    /// walk (desc/title only), pure parse in SpeakerCore.
    private func teamsSelfHintAcrossWindows(_ app: AXUIElement) -> String? {
        var found: String?
        var n = 0
        func rec(_ el: AXUIElement, _ d: Int) {
            if found != nil || n >= maxNodesPerWindow || d > maxDepth { return }
            n += 1
            for attr in ["AXDescription", "AXTitle"] {
                if let s = axString(el, attr), let name = teamsSelfNameFromProfileLabel(s) {
                    found = name; return
                }
            }
            for c in axArray(el, "AXChildren") { rec(c, d + 1); if found != nil { return } }
        }
        // Per-WINDOW budget: the label lives on the home window, and a large
        // meeting-window tree must not exhaust a shared cap before we reach it.
        for window in axArray(app, "AXWindows") {
            n = 0
            rec(window, 0)
            if found != nil { break }
        }
        return found
    }

    /// Converts a window's AX subtree into the platform-free node tree the PURE
    /// SpeakerCore extractors consume (`teamsExtractWindow`, `zoomExtractWindow`)
    /// — the ONLY AX read on those paths. All tile/self/mute/roster/call-gate
    /// decisions live in the pure extractors so the fixture replay in
    /// SpeakerCoreSelfTest exercises the shipping logic byte-for-byte. Bounded
    /// like every other window walk.
    private func windowNode(_ window: AXUIElement) -> TeamsAXNode {
        var visited = 0
        func rec(_ el: AXUIElement, _ depth: Int) -> TeamsAXNode {
            visited += 1
            let frame = axFrame(el)
            var children: [TeamsAXNode] = []
            if visited < maxNodesPerWindow && depth < maxDepth {
                for c in axArray(el, "AXChildren") {
                    if visited >= maxNodesPerWindow { break }
                    children.append(rec(c, depth + 1))
                }
            }
            return TeamsAXNode(
                role: axString(el, "AXRole"), subrole: axString(el, "AXSubrole"),
                roleDescription: axString(el, "AXRoleDescription"),
                desc: axString(el, "AXDescription"), title: axString(el, "AXTitle"),
                value: axString(el, "AXValue"), help: axString(el, "AXHelp"),
                classes: axClassList(el),
                x: frame.map { Double($0.minX) }, y: frame.map { Double($0.minY) },
                w: frame.map { Double($0.width) }, h: frame.map { Double($0.height) },
                children: children)
        }
        return rec(window, 0)
    }
}
