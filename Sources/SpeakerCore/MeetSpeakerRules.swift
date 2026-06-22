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

    /// Built-in defaults from the 2026-06-20 verification runs.
    ///
    /// The Meet active-speaker class is LAYOUT-DEPENDENT — a single token does
    /// not generalize, so we match a UNION (ANY present => speaking):
    /// - `kssMZb`        — active speaker on a THUMBNAIL-strip tile (verified on a
    ///                     self thumbnail spoke 0–35→10–37 AND a remote thumbnail
    ///                     spoke 5–25→8–30; disambiguated from mute via a 4-phase run).
    /// - `eT1oJ`,`hk9qKe`,`nn1vQb`,`s4hFTd`,`tWDL4c`,`yHy1rc` — the cluster Meet
    ///                     adds to your OWN tile while you speak (fired on a self
    ///                     SPOTLIGHT tile 9.8–14 when kssMZb did not).
    /// Still unverified: a REMOTE spotlight tile (different class likely). These
    /// names are obfuscated and rotate (~6 wks) — refresh from remote config.
    /// `FTMc0c` marks the silent/idle state.
    public static let builtin = MeetSpeakerRules(
        speakingClasses: ["kssMZb", "eT1oJ", "hk9qKe", "nn1vQb", "s4hFTd", "tWDL4c", "yHy1rc"],
        silentClasses: ["FTMc0c"],
        version: "2026-06-20"
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
