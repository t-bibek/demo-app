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
    /// Provenance of this ruleset (date or remote-config version).
    public var version: String

    public init(speakingClasses: [String], silentClasses: [String] = [], version: String) {
        self.speakingClasses = speakingClasses
        self.silentClasses = silentClasses
        self.version = version
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
