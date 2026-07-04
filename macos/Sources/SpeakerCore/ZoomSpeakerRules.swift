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
    /// Gallery-view tile class prefix (NEW — the gallery layout, previously
    /// unhandled; the `--active` modifier marks the speaker here too).
    public var webGalleryFramePrefix: String
    /// The active-speaker modifier class on the filmstrip tile. LEGACY exact
    /// class (equals `webFilmstripFramePrefix + webActiveModifier`) — kept so old
    /// zoom-rules.json overrides that set it still work; active detection now
    /// generalizes across the three prefix families via `webActiveModifier`.
    public var webActiveClass: String
    /// The active-speaker modifier SUFFIX (NEW). A tile is the active speaker when
    /// its classList carries `<prefix>--active` for ANY of {filmstrip, big/speaker,
    /// gallery}. Generalizes the single legacy `webActiveClass`.
    public var webActiveModifier: String
    /// Classes anchoring a tile's display-name node (avatar img alt / title).
    public var webAvatarNameClasses: [String]
    /// Per-tile name-span container class (NEW — the `video-avatar__avatar-footer`
    /// label, always present when the camera is on). Appended to the name sources.
    public var webAvatarFooterClass: String
    /// Per-tile MUTE class (NEW — `video-avatar__avatar-footer--view-mute-computer`
    /// present when that tile's mic is muted).
    public var webMuteFooterClass: String
    /// Local self-mute BUTTON markers (NEW — the toolbar mic control reads "mute my
    /// microphone" when unmuted, "unmute my microphone" when muted). Used to
    /// cross-validate the self tile's mute state for self-exclusion.
    public var webSelfMuteButtonMarkers: [String]
    /// In-call gate, web: EXACT AXButton descriptions ("end", "leave").
    public var webCallExactButtonLabels: [String]
    /// In-call gate, web: AXButton description substrings (participants-list
    /// controls).
    public var webCallButtonMarkers: [String]
    /// In-call gate, web: AXList description substring.
    public var webCallListToken: String

    /// Optional locale-override table (NEW — B5). Maps a locale code ("de", "es",
    /// …) to a PARTIAL rules override applied over `builtin` by `resolved(locale:)`.
    /// A Zoom UI in another language becomes a config drop, not a code change.
    /// Absent in older zoom-rules.json (defaulted [:]).
    public var locales: [String: PartialZoomRules]

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
                webGalleryFramePrefix: String,
                webActiveClass: String,
                webActiveModifier: String,
                webAvatarNameClasses: [String],
                webAvatarFooterClass: String,
                webMuteFooterClass: String,
                webSelfMuteButtonMarkers: [String],
                webCallExactButtonLabels: [String],
                webCallButtonMarkers: [String],
                webCallListToken: String,
                locales: [String: PartialZoomRules] = [:],
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
        self.webGalleryFramePrefix = webGalleryFramePrefix
        self.webActiveClass = webActiveClass
        self.webActiveModifier = webActiveModifier
        self.webAvatarNameClasses = webAvatarNameClasses
        self.webAvatarFooterClass = webAvatarFooterClass
        self.webMuteFooterClass = webMuteFooterClass
        self.webSelfMuteButtonMarkers = webSelfMuteButtonMarkers
        self.webCallExactButtonLabels = webCallExactButtonLabels
        self.webCallButtonMarkers = webCallButtonMarkers
        self.webCallListToken = webCallListToken
        self.locales = locales
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
        webGalleryFramePrefix: "gallery-video-container__video-frame",
        webActiveClass: "speaker-bar-container__video-frame--active",
        webActiveModifier: "--active",
        webAvatarNameClasses: ["video-avatar__avatar-img", "video-avatar__avatar-title"],
        webAvatarFooterClass: "video-avatar__avatar-footer",
        webMuteFooterClass: "video-avatar__avatar-footer--view-mute-computer",
        webSelfMuteButtonMarkers: ["mute my microphone", "unmute my microphone"],
        webCallExactButtonLabels: ["end", "leave"],
        webCallButtonMarkers: ["manage participants list", "participants list pane",
                               "the participants list"],
        webCallListToken: "participants list",
        locales: [:],
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
        webGalleryFramePrefix = try c.decodeIfPresent(String.self, forKey: .webGalleryFramePrefix) ?? b.webGalleryFramePrefix
        webActiveClass = try c.decodeIfPresent(String.self, forKey: .webActiveClass) ?? b.webActiveClass
        webActiveModifier = try c.decodeIfPresent(String.self, forKey: .webActiveModifier) ?? b.webActiveModifier
        webAvatarNameClasses = try c.decodeIfPresent([String].self, forKey: .webAvatarNameClasses) ?? b.webAvatarNameClasses
        webAvatarFooterClass = try c.decodeIfPresent(String.self, forKey: .webAvatarFooterClass) ?? b.webAvatarFooterClass
        webMuteFooterClass = try c.decodeIfPresent(String.self, forKey: .webMuteFooterClass) ?? b.webMuteFooterClass
        webSelfMuteButtonMarkers = try c.decodeIfPresent([String].self, forKey: .webSelfMuteButtonMarkers) ?? b.webSelfMuteButtonMarkers
        webCallExactButtonLabels = try c.decodeIfPresent([String].self, forKey: .webCallExactButtonLabels) ?? b.webCallExactButtonLabels
        webCallButtonMarkers = try c.decodeIfPresent([String].self, forKey: .webCallButtonMarkers) ?? b.webCallButtonMarkers
        webCallListToken = try c.decodeIfPresent(String.self, forKey: .webCallListToken) ?? b.webCallListToken
        locales = try c.decodeIfPresent([String: PartialZoomRules].self, forKey: .locales) ?? b.locales
        version = try c.decodeIfPresent(String.self, forKey: .version) ?? b.version
    }
}

/// A PARTIAL native-Zoom rules override used by the locale table (B5): only the
/// fields a translated Zoom UI changes need to be set; everything else inherits
/// the resolving base. Every field optional so a locale entry stays a minimal
/// config drop (e.g. just `unmutedToken` + `mutedToken` in German). Codable — it
/// is stored inline in zoom-rules.json's `locales` map.
public struct PartialZoomRules: Codable, Sendable, Equatable {
    public var audioStatusMarker: String?
    public var unmutedToken: String?
    public var mutedToken: String?
    public var selfTokens: [String]?
    public var participantsPanelToken: String?
    public var accountPresenceTokens: [String]?
    public var accountSuffixToken: String?
    public var meetingTitleTokens: [String]?
    public var leaveButtonTokens: [String]?
    public var pipTalkingPrefix: String?
    public var pipContentMarkers: [String]?

    public init(audioStatusMarker: String? = nil, unmutedToken: String? = nil,
                mutedToken: String? = nil, selfTokens: [String]? = nil,
                participantsPanelToken: String? = nil,
                accountPresenceTokens: [String]? = nil, accountSuffixToken: String? = nil,
                meetingTitleTokens: [String]? = nil, leaveButtonTokens: [String]? = nil,
                pipTalkingPrefix: String? = nil, pipContentMarkers: [String]? = nil) {
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

    /// Resolve rules for a given locale (B5): merge the locale's PARTIAL override
    /// (from the `locales` table) over this base, field by field (an unset partial
    /// field inherits the base). An unknown / nil locale returns the base
    /// unchanged. Prefer role/structure anchors over text wherever possible; this
    /// is the escape hatch for the text that genuinely IS localized.
    public func resolved(locale: String?) -> ZoomSpeakerRules {
        guard let locale, let p = locales[locale] else { return self }
        var r = self
        if let v = p.audioStatusMarker { r.audioStatusMarker = v }
        if let v = p.unmutedToken { r.unmutedToken = v }
        if let v = p.mutedToken { r.mutedToken = v }
        if let v = p.selfTokens { r.selfTokens = v }
        if let v = p.participantsPanelToken { r.participantsPanelToken = v }
        if let v = p.accountPresenceTokens { r.accountPresenceTokens = v }
        if let v = p.accountSuffixToken { r.accountSuffixToken = v }
        if let v = p.meetingTitleTokens { r.meetingTitleTokens = v }
        if let v = p.leaveButtonTokens { r.leaveButtonTokens = v }
        if let v = p.pipTalkingPrefix { r.pipTalkingPrefix = v }
        if let v = p.pipContentMarkers { r.pipContentMarkers = v }
        return r
    }

    /// The three tile-container class prefixes (filmstrip / speaker / gallery)
    /// whose `<prefix>--active` marks the active speaker on the web surface.
    public var webFramePrefixes: [String] {
        [webFilmstripFramePrefix, webBigFramePrefix, webGalleryFramePrefix]
    }

    /// True when a tile's classList marks it as the ACTIVE speaker: it carries the
    /// legacy exact `webActiveClass` OR `<prefix>--active` for ANY frame family.
    /// Generalizes the single hardcoded filmstrip class to speaker + gallery views.
    public func webTileIsActive(classList: [String]) -> Bool {
        if classList.contains(webActiveClass) { return true }
        let set = Set(classList)
        for prefix in webFramePrefixes where !prefix.isEmpty {
            if set.contains(prefix + webActiveModifier) { return true }
        }
        return false
    }

    /// The tile-container surface family a classList belongs to ("filmstrip" /
    /// "speaker" / "gallery"), or nil if it is not a tile container. Telemetry
    /// (per-view accuracy) — the active read never depends on it.
    public func webTileSurface(classList: [String]) -> String? {
        if classList.contains(where: { $0.hasPrefix(webFilmstripFramePrefix) }) { return "filmstrip" }
        if classList.contains(where: { $0.hasPrefix(webBigFramePrefix) }) { return "speaker" }
        if !webGalleryFramePrefix.isEmpty,
           classList.contains(where: { $0.hasPrefix(webGalleryFramePrefix) }) { return "gallery" }
        return nil
    }

    /// True when a tile's classList carries the per-tile computer-mute class.
    public func webTileMuted(classList: [String]) -> Bool {
        !webMuteFooterClass.isEmpty && classList.contains(webMuteFooterClass)
    }

    /// Interpret the local mic-control label for self-mute cross-validation: the
    /// button reads "unmute my microphone" when you ARE muted, "mute my
    /// microphone" when you are unmuted. Returns true=unmuted / false=muted / nil
    /// when the text isn't the self mic control.
    public func webSelfUnmuted(_ lowercased: String) -> Bool? {
        // Order matters: "unmute" contains "mute", so test the unmute phrasing
        // (⇒ muted) first, then the mute phrasing (⇒ unmuted).
        for m in webSelfMuteButtonMarkers where !m.isEmpty {
            let low = m.lowercased()
            if low.contains("unmute"), lowercased.contains(low) { return false }
        }
        for m in webSelfMuteButtonMarkers where !m.isEmpty {
            let low = m.lowercased()
            if !low.contains("unmute"), lowercased.contains(low) { return true }
        }
        return nil
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
