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
    /// Whether the tile's AXDOMClassList matched `MeetSpeakerRules` (strict
    /// `kssMZb`). Measured vs Recall's VAD ground truth: ~83% precision / 89% recall
    /// for a remote, but ~14% recall for self (your own tile gets no ring) — so it's
    /// a corroborating signal for remotes only, never the speaking source for self.
    /// See docs/meet-active-speaker-no-hardcoded-css.md.
    public var classSpeaking: Bool
    /// Whether this is the local user's tile (a "(You)" label in its subtree) —
    /// so audio-direction attribution can separate self from remotes.
    public var isMe: Bool

    public init(name: String, area: Double, orderIndex: Int, classSpeaking: Bool,
                isMe: Bool = false) {
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
    case geometry      // a clearly promoted/spotlit tile — durable, class-free
    case cssClass      // the rotating AXDOMClassList class — brittle, remote-only corroboration
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
///  1. **VAD gate** — no speech ⇒ no speaker. (Soft when audio capture is
///     unavailable, so Meet still works Accessibility-only.)
///  2. **Geometry** — a clearly dominant tile (auto speaker/spotlight/sidebar),
///     class-free. SUPPRESSED when `presentationActive`: a shared screen fills the
///     same stage and would be mistaken for the speaker's promoted tile.
///  3. **CSS class** — strict `kssMZb`; remote-only corroboration (≈14% recall on
///     self, so never the self source), used when geometry can't decide (gallery).
///  4. **Someone floor** — speech but nobody attributable.
///
/// NOTE: a structural AX indicator was hunted for and PROVEN ABSENT on Meet
/// (no subrole/DOM-id/description/role-shape co-varies with speech; the active-tile
/// border is pure CSS / a pruned node). So who-is-speaking comes from audio VAD +
/// roster (DetectionEngine), exactly as Recall does — this resolver is the
/// Accessibility-only fallback. See docs/meet-active-speaker-no-hardcoded-css.md.
public func meetActiveSpeaker(
    tiles: [MeetTileObservation],
    prevAreas: [String: Double],
    vadSpeechActive: Bool,
    presentationActive: Bool = false,
    someoneLabel: String = "Someone"
) -> MeetSpeakerResult {
    guard vadSpeechActive else { return MeetSpeakerResult(names: [], via: .none) }

    // 2) Geometry — a clearly dominant tile (speaker/spotlight view), BUT only when
    //    no presentation dominates: a shared screen ALSO fills the main stage, so
    //    the largest tile would be the screen, not the speaker. The caller passes
    //    `presentationActive` when a screen-share is detected.
    if !presentationActive, let promoted = meetPromotedTile(tiles) {
        return MeetSpeakerResult(names: [promoted], via: .geometry)
    }

    // 3) Strict `kssMZb` class — remote-only corroboration, used when geometry can't
    //    decide (gallery). Low recall, so it's a fallback, not the primary path.
    let classNames = tiles.filter { $0.classSpeaking }.map { $0.name }
    if !classNames.isEmpty {
        return MeetSpeakerResult(names: classNames, via: .cssClass)
    }

    // 4) VAD floor — speech, but nobody attributable (gallery / class gap).
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
