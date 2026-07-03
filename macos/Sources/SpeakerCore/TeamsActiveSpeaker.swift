import Foundation

/// One Microsoft Teams participant tile observed this tick — the inputs to the
/// VAD-gated active-speaker fusion. Mirrors `MeetTileObservation`; see
/// docs/teams-active-speaker-detection.md. Recall reads the equivalent set in
/// `TeamsScraper.scrapeMeetingParticipants -> [(participant, isSpeaking)]`.
public struct TeamsTileObservation: Equatable, Sendable {
    public var name: String
    /// AXFrame area (width*height) — geometry signal for the main-stage / PIP
    /// overlay (durable; survives a token rotation in speaker view).
    public var area: Double
    /// DOM/reading order among tiles.
    public var orderIndex: Int
    /// Whether the tile's AX text/classes matched `TeamsSpeakerRules` as the
    /// active speaker. The is-speaking token is OPAQUE in Recall's binary, so this
    /// is best-guess + config-loadable — verify with a Teams probe run.
    public var isSpeaking: Bool
    /// Whether this is the local user's tile (`calling_is_me_video` / "(you)").
    public var isMe: Bool
    /// Per-participant mute, when readable: true = unmuted, false = muted, nil = unknown.
    public var unmuted: Bool?

    public init(name: String, area: Double, orderIndex: Int,
                isSpeaking: Bool, isMe: Bool = false, unmuted: Bool? = nil) {
        self.name = name
        self.area = area
        self.orderIndex = orderIndex
        self.isSpeaking = isSpeaking
        self.isMe = isMe
        self.unmuted = unmuted
    }
}

/// Which signal decided the Teams active speaker — for telemetry (a token
/// rotation shows up as speech with no `.structural` hits + `.someoneFloor` gaps).
public enum TeamsSpeakerSignal: String, Sendable, Equatable {
    case none          // no speech (VAD gate closed)
    case structural    // a tile's AX is-speaking token matched (mirrors Recall's scan)
    case geometry      // a clearly promoted/spotlit overlay tile (durable, token-free)
    case someoneFloor  // speech, but no tile attributable
}

public struct TeamsSpeakerResult: Equatable, Sendable {
    public var names: [String]
    public var via: TeamsSpeakerSignal
    public init(names: [String], via: TeamsSpeakerSignal) {
        self.names = names
        self.via = via
    }
}

/// Fused, VAD-gated Teams active-speaker resolution — mirrors Recall's
/// `lastAxActiveSpeakerSet` (structural AX scan) ⊕ VAD, with the opaque
/// is-speaking token demoted to a telemetered, config-loadable signal and audio
/// as the floor. See docs/teams-active-speaker-detection.md.
///
/// Order:
///  1. **VAD gate** — no speech ⇒ no speaker (kills stale-token false positives).
///     `vadSpeechActive` is passed `true` when audio capture is unavailable, so
///     the gate is *soft* and Teams still works Accessibility-only.
///  2. **Structural** — every tile whose AX text/classes mark it speaking (the
///     mirror of Recall's PIP / main-overlay scan; handles multi-tile).
///  3. **Geometry** — if nothing matched, a clearly dominant overlay tile
///     (speaker view). Off by default (`useGeometry`) until the indicator is
///     probe-verified, so Teams never *guesses* a name on an unverified build.
///  4. **Someone floor** — speech, nobody attributable (today's safe behavior).
public func teamsActiveSpeaker(
    tiles: [TeamsTileObservation],
    prevAreas: [String: Double],
    vadSpeechActive: Bool,
    useGeometry: Bool = false,
    someoneLabel: String = "Someone"
) -> TeamsSpeakerResult {
    guard vadSpeechActive else { return TeamsSpeakerResult(names: [], via: .none) }

    // 2) Structural is-speaking (mirrors Recall's scan; supports multiple tiles).
    //    SELF-EXCLUDED, like the Meet ring path: a config'd rule matching the self
    //    tile must never name the local user — self is mic-attributed separately.
    let speaking = tiles.filter { $0.isSpeaking && !$0.isMe }.map { $0.name }
    if !speaking.isEmpty {
        return TeamsSpeakerResult(names: speaking, via: .structural)
    }

    // 3) Geometry fallback — a clearly dominant overlay tile (opt-in). Never
    //    returns the SELF tile (mirrors meetActiveSpeaker): a big pinned
    //    self-view is not evidence you're speaking.
    if useGeometry, let promoted = teamsPromotedTile(tiles),
       tiles.first(where: { $0.name == promoted })?.isMe != true {
        return TeamsSpeakerResult(names: [promoted], via: .geometry)
    }

    // 4) VAD floor — speech, but no attributable tile (token rotation / gallery).
    return TeamsSpeakerResult(names: [someoneLabel], via: .someoneFloor)
}

/// The single clearly-dominant tile (≥1.5× the next), or nil for an equal-sized
/// gallery — so geometry never guesses when tiles are uniform. Mirrors
/// `meetPromotedTile`.
func teamsPromotedTile(_ tiles: [TeamsTileObservation]) -> String? {
    guard !tiles.isEmpty else { return nil }
    if tiles.count == 1 { return tiles[0].name }
    let sorted = tiles.sorted { $0.area > $1.area }
    guard sorted[1].area > 0, sorted[0].area >= sorted[1].area * 1.5 else { return nil }
    return sorted[0].name
}
