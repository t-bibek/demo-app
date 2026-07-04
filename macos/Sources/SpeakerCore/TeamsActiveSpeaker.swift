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
    case none           // no speech (VAD gate closed)
    case ringTransition // rapid-swap disambiguation: a fresh onset overrode a stale lingering ring
    case structural     // a tile's AX is-speaking token matched (mirrors Recall's scan)
    case geometry       // a clearly promoted/spotlit overlay tile (durable, token-free)
    case someoneFloor   // speech, but no tile attributable
}

public struct TeamsSpeakerResult: Equatable, Sendable {
    public var names: [String]
    public var via: TeamsSpeakerSignal
    /// Transition confidence that decided a `.ringTransition` attribution (nil for
    /// every other path). Surfaced so telemetry shows WHY a fresh onset overrode a
    /// stale ring during rapid turn-taking. Additive/defaulted — `transition: nil`
    /// callers get nil, so all existing results compare equal.
    public var confidence: Double?
    public init(names: [String], via: TeamsSpeakerSignal, confidence: Double? = nil) {
        self.names = names
        self.via = via
        self.confidence = confidence
    }
}

/// Fused Teams active-speaker resolution. The primary signal is the STRUCTURAL
/// per-tile speaker ring (`vdi-frame-occlusion`, read inside each resolved tile
/// by `teamsExtractWindow`) — Teams' OWN VAD output, live-verified 2026-07-04 to
/// track exactly the audible remote(s). See docs/teams-active-speaker-detection.md.
///
/// Order:
///  1. **Structural ring** — every NON-SELF tile whose subtree carries the
///     speaker-ring token. Trusted DIRECTLY, ahead of our own audio gate: the
///     ring IS Teams' VAD, so it names the speaker(s) — including simultaneous
///     overlap — even when our peak meter is quiet. Self-excluded (self is
///     mic-attributed, and its ring token differs anyway).
///  2. **VAD gate** — below here we need our own audio to justify a guess; no
///     speech ⇒ no speaker. Soft (passed `true` when capture is unavailable).
///  3. **Geometry** — a clearly dominant overlay tile (speaker view) when the
///     ring wasn't readable. Opt-in (`useGeometry`).
///  4. **Someone floor** — speech but nobody attributable. The engine only lets
///     this surface when the tree is UNREADABLE (backgrounded/throttled); when
///     the tiles are foreground-readable the ring names the speaker, so a
///     foreground "Someone" is treated as a bug.
public func teamsActiveSpeaker(
    tiles: [TeamsTileObservation],
    prevAreas: [String: Double],
    vadSpeechActive: Bool,
    useGeometry: Bool = false,
    someoneLabel: String = "Someone",
    transition: TeamsTransitionState? = nil
) -> TeamsSpeakerResult {
    // 1) Structural ring — Teams' own VAD; trusted regardless of our audio meter.
    //    SELF-EXCLUDED, like the Meet ring path.
    let speaking = tiles.filter { $0.isSpeaking && !$0.isMe }.map { $0.name }
    if !speaking.isEmpty {
        // 1a) RAPID-SWAP DISAMBIGUATION (event mode, additive — mirrors Meet's
        //     `.ringTransition`). During a fast handoff the just-ended speaker's ring
        //     LINGERS (~1270ms measured, docs §9.1) and overlaps the fresh one, so the
        //     plain overlap set below would name BOTH. If a fresh ring onset (the
        //     transition holder) is among the currently-lit tiles, that holder alone
        //     wins — the stale linger is suppressed. `transition == nil` (every legacy
        //     caller/self-test) SKIPS this, so behavior is byte-for-byte unchanged; and
        //     when the holder ISN'T among the lit tiles (it already went silent), we
        //     fall through to the overlap set, preserving GENUINE simultaneous talk.
        if let t = transition, let holder = t.holder, speaking.contains(holder) {
            return TeamsSpeakerResult(names: [holder], via: .ringTransition, confidence: t.confidence)
        }
        return TeamsSpeakerResult(names: speaking, via: .structural)
    }

    // 2) No ring lit — now require our own audio to justify a fallback guess.
    guard vadSpeechActive else { return TeamsSpeakerResult(names: [], via: .none) }

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
