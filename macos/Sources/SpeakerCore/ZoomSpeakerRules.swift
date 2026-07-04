import Foundation

/// Zoom detection rules — NATIVE app (us.zoom.xos) text grammar + WEB client
/// (browser) CSS tokens.
///
/// Native Zoom's video grid is Metal-rendered and OPAQUE to Accessibility: there
/// is no AXDOMClassList and no speaking signal of any kind (verified live with
/// ZoomProbe and against Recall's shipping binary, which has AX speaking scanners
/// for Meet/Teams but none for Zoom — docs/zoom-native-detection.md §3/§5). What
/// IS readable is TEXT: the roster's "<Name>, Computer audio muted/unmuted" lines
/// (grid-tile overlays + Participants-panel rows), the "(me)" self marker, and
/// the PIP thumbnail's "Talking: <name>" note. Recall ships per-Zoom-release
/// scraping rules for exactly this surface, so every token here is `Codable` +
/// config-overridable (`resolved()` loads an override JSON): a Zoom release that
/// rewords a phrase is a config drop, not an app release. Re-derive with
/// `swift run ZoomProbe` / `swift run AXSnapshot zoom` against a live call.
public struct ZoomSpeakerRules: Codable, Sendable, Equatable {
    // MARK: Native — roster line grammar ("<Name>, Computer audio muted/unmuted")
    /// Substring that gates a roster line: only text carrying the audio-status
    /// clause is a participant row / tile overlay.
    public var audioStatusMarker: String
    /// Audio-status clause meaning UNMUTED. Checked before `mutedToken` — a line
    /// carrying both reads unmuted (doc §8: "audio unmuted" wins).
    public var unmutedToken: String
    /// Audio-status clause meaning MUTED.
    public var mutedToken: String
    /// Local-user markers: Zoom renders the self row "<Name> (me)" — and
    /// "(Host, me)" / "(Co-host, me)" for role-tagged self, which ", me)" covers.
    public var selfTokens: [String]
    /// Label of the Participants-panel container (an AXOutline/AXList titled
    /// "Participants list") whose AXRows split name and mic state across SIBLING
    /// nodes (AXStaticText name + AXImage status) instead of one combined line.
    public var participantsPanelToken: String
    /// Presence words in the home window's profile button — "Zoom, <Name>,
    /// Available, Basic account". They anchor the APP-WIDE self name (the
    /// signed-in account), which — unlike the meeting panel's "(me)" — is
    /// readable even when the Participants panel is closed. The name is the
    /// comma-field immediately BEFORE the presence word.
    public var accountPresenceTokens: [String]
    /// Suffix that confirms a profile-button description ("… Basic account").
    public var accountSuffixToken: String

    // MARK: Native — window classification
    /// Window-title substrings that mark an in-meeting window ("Zoom Meeting",
    /// "Meeting - <topic>"). The "Zoom Workplace" home shell matches none.
    public var meetingTitleTokens: [String]
    /// Button labels that mark an ACTIVE call (all vanish post-call → the gate
    /// fails → meeting_ended).
    public var leaveButtonTokens: [String]

    // MARK: Native — PIP thumbnail (subrole AXSystemDialog)
    /// Prefix of the PIP's active-speaker note "Talking: <name>" (Zoom's own VAD
    /// — the ONE place native Zoom names the current talker).
    public var pipTalkingPrefix: String
    /// Subtree text markers that identify the PIP window's content.
    public var pipContentMarkers: [String]

    // MARK: Web client (browser) — CSS class tokens (AXDOMClassList)
    /// Filmstrip tile class prefix; the `--active` modifier marks the speaker.
    public var webFilmstripFramePrefix: String
    /// Big speaker-view tile class prefix (fallback when no filmstrip).
    public var webBigFramePrefix: String
    /// The active-speaker modifier class on the filmstrip tile.
    public var webActiveClass: String
    /// Classes anchoring a tile's display-name node (avatar img alt / title).
    public var webAvatarNameClasses: [String]
    /// In-call gate, web: EXACT AXButton descriptions ("end", "leave").
    public var webCallExactButtonLabels: [String]
    /// In-call gate, web: AXButton description substrings (participants-list
    /// controls).
    public var webCallButtonMarkers: [String]
    /// In-call gate, web: AXList description substring.
    public var webCallListToken: String

    /// Provenance (date or remote-config version).
    public var version: String

    public init(audioStatusMarker: String,
                unmutedToken: String,
                mutedToken: String,
                selfTokens: [String],
                participantsPanelToken: String,
                accountPresenceTokens: [String],
                accountSuffixToken: String,
                meetingTitleTokens: [String],
                leaveButtonTokens: [String],
                pipTalkingPrefix: String,
                pipContentMarkers: [String],
                webFilmstripFramePrefix: String,
                webBigFramePrefix: String,
                webActiveClass: String,
                webAvatarNameClasses: [String],
                webCallExactButtonLabels: [String],
                webCallButtonMarkers: [String],
                webCallListToken: String,
                version: String) {
        self.audioStatusMarker = audioStatusMarker
        self.unmutedToken = unmutedToken
        self.mutedToken = mutedToken
        self.selfTokens = selfTokens
        self.participantsPanelToken = participantsPanelToken
        self.accountPresenceTokens = accountPresenceTokens
        self.accountSuffixToken = accountSuffixToken
        self.meetingTitleTokens = meetingTitleTokens
        self.leaveButtonTokens = leaveButtonTokens
        self.pipTalkingPrefix = pipTalkingPrefix
        self.pipContentMarkers = pipContentMarkers
        self.webFilmstripFramePrefix = webFilmstripFramePrefix
        self.webBigFramePrefix = webBigFramePrefix
        self.webActiveClass = webActiveClass
        self.webAvatarNameClasses = webAvatarNameClasses
        self.webCallExactButtonLabels = webCallExactButtonLabels
        self.webCallButtonMarkers = webCallButtonMarkers
        self.webCallListToken = webCallListToken
        self.version = version
    }

    /// Built-in defaults — the exact strings live-verified against Zoom 7.0.5
    /// (ax-dump 20260625-200432 + docs/zoom-native-detection.md) and previously
    /// hardcoded in the scanner. All config-overridable (`zoom-rules.json`).
    public static let builtin = ZoomSpeakerRules(
        audioStatusMarker: "computer audio",
        unmutedToken: "audio unmuted",
        mutedToken: "audio muted",
        selfTokens: ["(me)", ", me)"],
        participantsPanelToken: "participants",
        accountPresenceTokens: ["available", "busy", "away", "do not disturb",
                                "offline", "in a meeting", "in a zoom meeting",
                                "presenting", "be right back", "in a calendar event"],
        accountSuffixToken: "account",
        meetingTitleTokens: ["zoom meeting", "meeting -"],
        leaveButtonTokens: ["leave meeting", "end meeting", "leave"],
        pipTalkingPrefix: "talking:",
        pipContentMarkers: ["talking", "video render", "show video"],
        webFilmstripFramePrefix: "speaker-bar-container__video-frame",
        webBigFramePrefix: "speaker-active-container__video-frame",
        webActiveClass: "speaker-bar-container__video-frame--active",
        webAvatarNameClasses: ["video-avatar__avatar-img", "video-avatar__avatar-title"],
        webCallExactButtonLabels: ["end", "leave"],
        webCallButtonMarkers: ["manage participants list", "participants list pane",
                               "the participants list"],
        webCallListToken: "participants list",
        version: "2026-07-04-initial"
    )

    /// PARTIAL overrides decode: a `zoom-rules.json` that sets only the fields
    /// that changed inherits `builtin` for the rest (so a one-token fix stays a
    /// one-line config drop).
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let b = ZoomSpeakerRules.builtin
        audioStatusMarker = try c.decodeIfPresent(String.self, forKey: .audioStatusMarker) ?? b.audioStatusMarker
        unmutedToken = try c.decodeIfPresent(String.self, forKey: .unmutedToken) ?? b.unmutedToken
        mutedToken = try c.decodeIfPresent(String.self, forKey: .mutedToken) ?? b.mutedToken
        selfTokens = try c.decodeIfPresent([String].self, forKey: .selfTokens) ?? b.selfTokens
        participantsPanelToken = try c.decodeIfPresent(String.self, forKey: .participantsPanelToken) ?? b.participantsPanelToken
        accountPresenceTokens = try c.decodeIfPresent([String].self, forKey: .accountPresenceTokens) ?? b.accountPresenceTokens
        accountSuffixToken = try c.decodeIfPresent(String.self, forKey: .accountSuffixToken) ?? b.accountSuffixToken
        meetingTitleTokens = try c.decodeIfPresent([String].self, forKey: .meetingTitleTokens) ?? b.meetingTitleTokens
        leaveButtonTokens = try c.decodeIfPresent([String].self, forKey: .leaveButtonTokens) ?? b.leaveButtonTokens
        pipTalkingPrefix = try c.decodeIfPresent(String.self, forKey: .pipTalkingPrefix) ?? b.pipTalkingPrefix
        pipContentMarkers = try c.decodeIfPresent([String].self, forKey: .pipContentMarkers) ?? b.pipContentMarkers
        webFilmstripFramePrefix = try c.decodeIfPresent(String.self, forKey: .webFilmstripFramePrefix) ?? b.webFilmstripFramePrefix
        webBigFramePrefix = try c.decodeIfPresent(String.self, forKey: .webBigFramePrefix) ?? b.webBigFramePrefix
        webActiveClass = try c.decodeIfPresent(String.self, forKey: .webActiveClass) ?? b.webActiveClass
        webAvatarNameClasses = try c.decodeIfPresent([String].self, forKey: .webAvatarNameClasses) ?? b.webAvatarNameClasses
        webCallExactButtonLabels = try c.decodeIfPresent([String].self, forKey: .webCallExactButtonLabels) ?? b.webCallExactButtonLabels
        webCallButtonMarkers = try c.decodeIfPresent([String].self, forKey: .webCallButtonMarkers) ?? b.webCallButtonMarkers
        webCallListToken = try c.decodeIfPresent(String.self, forKey: .webCallListToken) ?? b.webCallListToken
        version = try c.decodeIfPresent(String.self, forKey: .version) ?? b.version
    }
}

extension ZoomSpeakerRules {
    /// Load a config'd override (a token change is a config drop, not a release):
    /// reads `MeetSpeakerDetector/zoom-rules.json` from Application Support; falls
    /// back to `builtin`. Mirrors `TeamsSpeakerRules.resolved()`.
    public static func resolved() -> ZoomSpeakerRules {
        guard let url = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("MeetSpeakerDetector/zoom-rules.json"),
            let data = try? Data(contentsOf: url),
            let rules = try? JSONDecoder().decode(ZoomSpeakerRules.self, from: data)
        else { return .builtin }
        return rules
    }

    /// True when lowercased text carries a local-user marker ("(me)" — and
    /// "(Host, me)" / "(Co-host, me)" via the ", me)" token).
    public func isSelfMarker(_ lowercased: String) -> Bool {
        selfTokens.contains { !$0.isEmpty && lowercased.contains($0) }
    }

    /// Audio status of a roster line: true = unmuted, false = muted, nil = the
    /// line carries the marker but neither state clause (or no marker at all).
    /// Unmuted is checked FIRST so a stray "muted" substring can't mask it
    /// (engineering-log fix, docs/zoom-native-detection.md §8).
    public func audioStatus(_ lowercased: String) -> Bool? {
        if lowercased.contains(unmutedToken) { return true }
        if lowercased.contains(mutedToken) { return false }
        return nil
    }

    /// True when a window title marks an in-meeting window.
    public func isMeetingTitle(_ lowercasedTitle: String) -> Bool {
        meetingTitleTokens.contains { !$0.isEmpty && lowercasedTitle.contains($0) }
    }

    /// True when a button label marks the in-call Leave/End control.
    public func isLeaveLabel(_ lowercased: String) -> Bool {
        leaveButtonTokens.contains { !$0.isEmpty && lowercased.contains($0) }
    }

    /// True when subtree text identifies the PIP thumbnail's content.
    public func hasPipMarker(_ lowercased: String) -> Bool {
        pipContentMarkers.contains { !$0.isEmpty && lowercased.contains($0) }
    }

    /// The signed-in account's display name from the home window's profile button
    /// ("Zoom, <Name>, Available, Basic account") — the app-wide self signal that
    /// survives a CLOSED Participants panel (where "(me)" is unavailable). The
    /// name is the comma-field immediately before the presence word; nil if the
    /// description isn't a profile button.
    public func accountSelfName(_ raw: String) -> String? {
        let low = raw.lowercased()
        guard low.contains(accountSuffixToken) else { return nil }
        let parts = raw.components(separatedBy: ",").map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        // The presence field CONTAINS a presence token (substring, so "In a Zoom
        // Meeting" matches even when the status shifts mid-call). The name is the
        // comma-field immediately before it.
        guard let pIdx = parts.firstIndex(where: { part in
            let l = part.lowercased()
            return accountPresenceTokens.contains { !$0.isEmpty && l.contains($0) }
        }), pIdx >= 1 else { return nil }
        return parts[pIdx - 1]
    }
}
