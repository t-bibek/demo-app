import Foundation

/// One Meet participant tile observed this tick — the durable inputs to
/// active-speaker fusion (see docs/meet-active-speaker-no-hardcoded-css.md).
/// Geometry is rotation-proof; the class is the brittle, rotating fallback.
public struct MeetTileObservation: Equatable, Sendable {
    public var name: String
    /// AXFrame area (width*height) — the geometry signal (durable).
    public var area: Double
    /// DOM/reading order among tiles (stable-ish per layout).
    public var orderIndex: Int
    /// Whether the tile's AXDOMClassList matched MeetSpeakerRules. NOTE: on
    /// current Meet builds this class is the tile's HOVER/focus highlight, NOT a
    /// speaking signal (verified: hovering toggles it; actually speaking does
    /// not — a muted, silent self tile still shows it). Telemetry-only now.
    public var classSpeaking: Bool
    /// Whether this is the local user's tile (a "(You)" label in its subtree) —
    /// so audio-direction attribution can separate self from remotes.
    public var isMe: Bool

    public init(name: String, area: Double, orderIndex: Int, classSpeaking: Bool, isMe: Bool = false) {
        self.name = name
        self.area = area
        self.orderIndex = orderIndex
        self.classSpeaking = classSpeaking
        self.isMe = isMe
    }
}

/// Which signal decided the active speaker — for telemetry: a rotation shows up
/// as speech with no `.cssClass` hits (and `.someoneFloor` gaps).
public enum MeetSpeakerSignal: String, Sendable, Equatable {
    case none          // no speech (VAD gate closed)
    case cssClass      // the rotating AXDOMClassList class — brittle
    case geometry      // a clearly promoted/spotlit tile — durable, class-free
    case someoneFloor  // speech, but no tile attributable
}

public struct MeetSpeakerResult: Equatable, Sendable {
    public var names: [String]
    public var via: MeetSpeakerSignal
    public init(names: [String], via: MeetSpeakerSignal) {
        self.names = names
        self.via = via
    }
}

/// Fused, VAD-gated Meet active-speaker resolution — the strategy Recall's binary
/// uses (geometry + AX + VAD → a participant set), with the rotating CSS class
/// demoted to a telemetered fallback. See docs/meet-active-speaker-no-hardcoded-css.md.
///
/// Order:
///  1. **VAD gate** — no speech ⇒ no speaker. Kills false positives from a stale
///     class. (The caller passes `true` when audio capture is unavailable, so the
///     gate is *soft* and Meet still works with Accessibility-only.)
///  2. **CSS class** — the verified-but-rotating per-tile signal (primary today;
///     covers gallery view, where geometry can't decide).
///  3. **Geometry** — if the class names nobody, attribute to a clearly dominant
///     tile (auto speaker/spotlight view), independent of the class → survives a
///     class rotation in that layout.
///  4. **Someone floor** — speech but nobody attributable (like Recall's
///     `exclude_null_active_speaker` handling).
public func meetActiveSpeaker(
    tiles: [MeetTileObservation],
    prevAreas: [String: Double],
    vadSpeechActive: Bool,
    someoneLabel: String = "Someone"
) -> MeetSpeakerResult {
    guard vadSpeechActive else { return MeetSpeakerResult(names: [], via: .none) }

    // 2) CSS class (primary, verified — but rotates).
    let classNames = tiles.filter { $0.classSpeaking }.map { $0.name }
    if !classNames.isEmpty {
        return MeetSpeakerResult(names: classNames, via: .cssClass)
    }

    // 3) Geometry fallback — a clearly dominant tile (speaker/spotlight view).
    if let promoted = meetPromotedTile(tiles) {
        return MeetSpeakerResult(names: [promoted], via: .geometry)
    }

    // 4) VAD floor — speech, but gallery view with no class match (rotation gap).
    return MeetSpeakerResult(names: [someoneLabel], via: .someoneFloor)
}

/// The single clearly-dominant tile, if any — the auto speaker/spotlight view's
/// promoted tile. Returns nil for gallery view (roughly equal tiles), so the
/// caller falls back to the class / Someone floor there.
func meetPromotedTile(_ tiles: [MeetTileObservation]) -> String? {
    guard !tiles.isEmpty else { return nil }
    if tiles.count == 1 { return tiles[0].name }
    let sorted = tiles.sorted { $0.area > $1.area }
    // "Dominant" = clearly larger than the next tile. Equal-sized gallery tiles
    // fail this, so geometry never guesses in gallery view.
    guard sorted[1].area > 0, sorted[0].area >= sorted[1].area * 1.5 else { return nil }
    return sorted[0].name
}
