import Foundation

/// Google Meet active-speaker detection rules.
///
/// Discovered and verified empirically (MeetProbe, 2026-06-20): Meet adds a
/// cluster of CSS classes to the SPEAKING participant's tile, which surface in
/// the macOS AX tree via `AXDOMClassList`. Verified against ground truth — the
/// cluster was ON 7–37s while the user spoke 0–35s, and its complement
/// (`FTMc0c`) was ON only while silent, with the mouse parked (so not hover).
///
/// These class names are obfuscated and Google rotates them (~6 weeks), so this
/// is intentionally a *config object* meant to be refreshed from remote config /
/// telemetry — never assume the built-in defaults are permanent. Re-derive with
/// `swift run MeetProbe` against a narrated call when they stop matching.
public struct MeetSpeakerRules: Codable, Sendable, Equatable {
    /// If a tile's class set contains ANY of these, the tile is speaking.
    public var speakingClasses: [String]
    /// Classes that mark the NOT-speaking state (diagnostic / tie-break only).
    public var silentClasses: [String]
    /// PROTOTYPE (fresh-capture 2026-07-03): the anchor tokens that identify Meet's
    /// per-tile EQUALIZER node in `AXDOMClassList`. If a node carries ANY of these
    /// it IS an equalizer node (a candidate speaking-state carrier). Real dumps:
    ///   SILENCE        ["DYfzY","cYKTje","gjg47c"]
    ///   GUEST speaking ["DYfzY","cYKTje","Oaajhc","sxlEM"]
    ///   HOST  speaking ["IisKdb","GF8M7d","HX2H7","KUNJSe","x9nQ6","VeFZv"]
    /// So the durable anchor set is {DYfzY, IisKdb, QgSmzd}. Overridable via config.
    public var equalizerAnchorClasses: [String]
    /// PROTOTYPE (fresh-capture 2026-07-03): the SILENCE token on an equalizer node.
    /// An equalizer node is SPEAKING iff it does NOT carry this class. Durable rule —
    /// the LEVEL tokens (OgVli/HX2H7/Oaajhc/wEsLMd) rotate; absence-of-`gjg47c` does
    /// not. Overridable via config.
    public var equalizerSilenceClass: String
    /// CLASS-FREE + GEOMETRY-FREE participant ANCHOR (panel-open capture 2026-07-03):
    /// Meet labels every real participant's per-tile control with the NAME embedded in
    /// its `AXDescription` — "More options for <Name>" is present on EVERY tile (incl.
    /// self), so it is the durable structural allowlist for a participant. Chrome
    /// (control bar, "Contributors N", search, toasts) has NO such control, so this
    /// REPLACES name-text blocklisting and needs NO tile CSS class and NO pixel size
    /// (tile geometry varies with zoom/window/layout/count). Wording is locale-bound →
    /// config-overridable. The scanner also recognizes "Pin <Name> to your main screen"
    /// and "Mute <Name>'s microphone" as corroborating anchors. See
    /// `meetParticipantNameFromControl`.
    public var participantControlPrefixes: [String]
    /// CLASS-FREE roster container marker (panel-open capture 2026-07-03): the People
    /// panel is the single `AXList`/`AXSubrole=AXContentList` whose `AXDescription`
    /// equals this. Its direct-child rows each carry the participant name in their own
    /// `AXDescription` — the authoritative roster when the panel is open. Locale-bound
    /// → config-overridable. Panel-closed = zero such list (a clean structural signal).
    public var rosterContainerDescription: String
    /// Provenance of this ruleset (date or remote-config version).
    public var version: String

    public init(speakingClasses: [String], silentClasses: [String] = [],
                equalizerAnchorClasses: [String] = ["DYfzY", "IisKdb", "QgSmzd"],
                equalizerSilenceClass: String = "gjg47c",
                participantControlPrefixes: [String] = ["More options for "],
                rosterContainerDescription: String = "Participants",
                version: String) {
        self.speakingClasses = speakingClasses
        self.silentClasses = silentClasses
        self.equalizerAnchorClasses = equalizerAnchorClasses
        self.equalizerSilenceClass = equalizerSilenceClass
        self.participantControlPrefixes = participantControlPrefixes
        self.rosterContainerDescription = rosterContainerDescription
        self.version = version
    }

    // Custom Decodable so a config JSON written before the equalizer fields existed
    // still decodes (the new fields fall back to the built-in defaults). Keeps
    // `MeetSpeakerRules.resolved()` from failing to load an older on-disk override.
    private enum CodingKeys: String, CodingKey {
        case speakingClasses, silentClasses, equalizerAnchorClasses, equalizerSilenceClass,
             participantControlPrefixes, rosterContainerDescription, version
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        speakingClasses = try c.decode([String].self, forKey: .speakingClasses)
        silentClasses = try c.decodeIfPresent([String].self, forKey: .silentClasses) ?? []
        equalizerAnchorClasses = try c.decodeIfPresent([String].self, forKey: .equalizerAnchorClasses)
            ?? ["DYfzY", "IisKdb", "QgSmzd"]
        equalizerSilenceClass = try c.decodeIfPresent(String.self, forKey: .equalizerSilenceClass) ?? "gjg47c"
        participantControlPrefixes = try c.decodeIfPresent([String].self, forKey: .participantControlPrefixes)
            ?? ["More options for "]
        rosterContainerDescription = try c.decodeIfPresent(String.self, forKey: .rosterContainerDescription)
            ?? "Participants"
        version = try c.decode(String.self, forKey: .version)
    }

    /// Built-in default — STRICT, single-class last-resort fallback (2026-06-29).
    ///
    /// `kssMZb` ONLY, and deliberately the LAST signal, not the first. Per the
    /// structural-tile-state plan (Recall's binary ships `active speaker
    /// indicator` / `active speaker container` / `isActiveSpeaker` symbols but
    /// NONE of our class tokens), Meet's durable active-speaker handle is a
    /// STRUCTURAL indicator/container node, not an obfuscated CSS class.
    /// `meetActiveSpeaker()` resolves structure/geometry first and only falls back
    /// to this class when nothing structural attributes a tile.
    ///
    /// The old self/hover cluster (`eT1oJ,hk9qKe,nn1vQb,s4hFTd,tWDL4c,yHy1rc`) was
    /// REMOVED: it is the tile's HOVER/focus highlight, not speech — it lights on
    /// hover-anywhere and stays ON for a muted, silent self tile (verified; see
    /// `MeetTileObservation.classSpeaking`). Shipping it caused hover/self false
    /// positives. `FTMc0c` (the old silent marker) is dropped with it — diagnostic
    /// only and equally rotation-prone.
    ///
    /// `kssMZb` is obfuscated and Google rotates it (~6 wks) — refresh from remote
    /// config; re-derive with `swift run MeetProbe` against a narrated call.
    public static let builtin = MeetSpeakerRules(
        speakingClasses: ["kssMZb"],
        silentClasses: [],
        version: "2026-06-29-strict"
    )
}

extension MeetSpeakerRules {
    /// Phase 3 — load a config'd override so a class rotation is a config drop,
    /// not an app release. Reads a JSON override from Application Support
    /// (`MeetSpeakerDetector/meet-rules.json`); falls back to `builtin`. A remote
    /// URL fetch (ETag-cached to this same file) can layer on top later.
    public static func resolved() -> MeetSpeakerRules {
        guard let url = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("MeetSpeakerDetector/meet-rules.json"),
            let data = try? Data(contentsOf: url),
            let rules = try? JSONDecoder().decode(MeetSpeakerRules.self, from: data)
        else { return .builtin }
        return rules
    }
}

/// True when a Meet tile's class tokens indicate it is the active speaker.
public func meetTileIsSpeaking(classTokens: Set<String>, rules: MeetSpeakerRules = .builtin) -> Bool {
    rules.speakingClasses.contains { classTokens.contains($0) }
}

/// PROTOTYPE — true when a single AX node's `AXDOMClassList` is a SPEAKING equalizer
/// node (fresh-capture finding, 2026-07-03). A node is an equalizer node if its class
/// list contains ANY of `rules.equalizerAnchorClasses` ({DYfzY,IisKdb,QgSmzd}); it is
/// SPEAKING iff it is an equalizer node AND does NOT carry the silence class
/// (`rules.equalizerSilenceClass` = "gjg47c"). Absence-of-`gjg47c` is the DURABLE
/// rule — the level tokens (OgVli/HX2H7/Oaajhc/wEsLMd) rotate, so they only
/// corroborate; they are never required. A non-equalizer node (no anchor) is false.
///
/// This is a per-NODE read (the scanner walks a tile's descendants for a node that
/// satisfies it), distinct from `meetTileIsSpeaking` which unions a whole tile's
/// tokens for the sticky `kssMZb` ring. See MeetActiveSpeaker's `.equalizer` step.
public func meetNodeIsSpeakingEqualizer(classList: [String], rules: MeetSpeakerRules = .builtin) -> Bool {
    let tokens = Set(classList)
    let isEqualizer = rules.equalizerAnchorClasses.contains { tokens.contains($0) }
    guard isEqualizer else { return false }
    return !tokens.contains(rules.equalizerSilenceClass)
}

/// CLASS-FREE + GEOMETRY-FREE participant NAME extractor from a per-tile / roster-row
/// control's accessible label (`AXDescription`) — panel-open capture 2026-07-03. Meet
/// labels each real participant's control with the name embedded; these controls are
/// the structural allowlist for a participant (browser chrome has none), carrying NO
/// obfuscated CSS class and NO pixel geometry (tile size varies with zoom/window/
/// layout). Recognized:
///   "More options for <Name>"        — config `participantControlPrefixes`; the
///                                       durable anchor (on every tile + roster popup).
///                                       VIEWER-INDEPENDENCE (host vs guest) is being
///                                       verified live before the scanner relies on it.
///   "Pin <Name> to your main screen" — corroborating (any participant can pin).
///   "Mute <Name>'s microphone"       — corroborating, but HOST-ONLY in practice
///                                       (guests can't mute others), so never the sole
///                                       anchor.
/// Returns the cleaned display name, or nil when the label is not a participant control
/// ("Leave call", "Contributors 3", "Turn off microphone", the search box → nil).
public func meetParticipantNameFromControl(_ label: String, rules: MeetSpeakerRules = .builtin) -> String? {
    let s = label.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !s.isEmpty else { return nil }
    // Config'd prefixes (default "More options for ") — the durable every-tile anchor.
    for prefix in rules.participantControlPrefixes where s.count > prefix.count {
        if s.lowercased().hasPrefix(prefix.lowercased()) {
            return cleanParticipantName(String(s.dropFirst(prefix.count)))
        }
    }
    let low = s.lowercased()
    // "Pin <Name> to your main screen" / "…'s presentation …"
    if low.hasPrefix("pin ") {
        var rest = String(s.dropFirst(4))
        for tail in [" to your main screen", " to the main screen", "’s presentation",
                     "'s presentation", " to your main", " to your"] {
            if let t = rest.range(of: tail, options: .caseInsensitive) {
                rest = String(rest[..<t.lowerBound]); break
            }
        }
        return cleanParticipantName(rest)
    }
    // "Mute <Name>'s microphone" (host-only control, but a valid name anchor when present)
    if low.hasPrefix("mute "),
       let r = s.range(of: "’s microphone", options: .caseInsensitive)
            ?? s.range(of: "'s microphone", options: .caseInsensitive) {
        let start = s.index(s.startIndex, offsetBy: 5)
        return cleanParticipantName(String(s[start..<r.lowerBound]))
    }
    return nil
}
