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
///  2. **CSS ring** — strict `kssMZb`, the active-speaker ring Meet draws on the
///     SPEAKING remote's tile (never self). A direct who-is-speaking read, so it
///     leads: geometry only knows tile SIZE and picks the wrong tile when the
///     biggest one isn't the speaker (you pin yourself while a remote talks).
///  3. **Geometry** — a clearly dominant NON-SELF tile (auto speaker/spotlight),
///     class-free, used when no ring is exposed. SUPPRESSED when
///     `presentationActive`: a shared screen fills the same stage and would be
///     mistaken for the speaker's promoted tile.
///  4. **Someone floor** — speech but nobody attributable.
///
/// NOTE: a structural AX indicator was hunted for and PROVEN ABSENT on Meet
/// (no subrole/DOM-id/description/role-shape co-varies with speech; the active-tile
/// border is pure CSS / a pruned node). So who-is-speaking comes from audio VAD +
/// roster (DetectionEngine), exactly as Recall does — this resolver is the
/// Accessibility-only fallback. See docs/meet-active-speaker-no-hardcoded-css.md.
///
/// CROSS-SURFACE (2026-07-03, re-verified live): a durable, token-free STRUCTURAL
/// speaking signal DOES exist — but only in the RAW DOM, which the AX tree prunes.
/// It is a visible ~28x28 circular equalizer (3 leaf "bar" divs, 4x16) whose bars
/// animate `stripeJiggleAnimation` while speaking; found by shape alone with zero
/// page-wide false positives, and live-confirmed naming turn-wise + overlapping
/// speakers (0.81-0.92) with EVERY Google class/jsname/jscontroller token
/// disabled. It is unreachable from this AX resolver — a content-script / CDP /
/// embedded-webview surface is required to read it. Reference implementation +
/// QA: research/meet-dom-detector/ (Node 23/23, real-browser 31/31). Do NOT
/// re-add a structural rule to the AX path expecting to see it here.
public func meetActiveSpeaker(
    tiles: [MeetTileObservation],
    prevAreas: [String: Double],
    vadSpeechActive: Bool,
    presentationActive: Bool = false,
    someoneLabel: String = "Someone"
) -> MeetSpeakerResult {
    guard vadSpeechActive else { return MeetSpeakerResult(names: [], via: .none) }

    // 2) Active-speaker ring (`kssMZb`) — Meet draws it on the SPEAKING remote's
    //    tile; your own tile never gets it (confirmed live: the ring node is only
    //    ever in the remote's subtree), so a class hit is a DIRECT who-is-speaking
    //    read needing no self-detection. Checked BEFORE geometry because geometry
    //    only guesses from tile SIZE, which is wrong whenever the biggest tile
    //    isn't the speaker — e.g. you pin yourself (large, camera off) while a
    //    remote talks in a small corner tile (the reported spotlight-self layout).
    let ringNames = tiles.filter { $0.classSpeaking }.map { $0.name }
    if !ringNames.isEmpty {
        return MeetSpeakerResult(names: ringNames, via: .cssClass)
    }

    // 3) Geometry — a clearly dominant tile (spotlight/speaker view) when NO ring is
    //    exposed (the ring's recall isn't 100%). Suppressed under a presentation (a
    //    shared screen ALSO fills the stage, so the largest tile is the screen, not
    //    the speaker), and never returns the SELF tile: a big pinned self tile is
    //    not evidence you're speaking — self is mic-attributed separately.
    if !presentationActive, let promoted = meetPromotedTile(tiles),
       tiles.first(where: { $0.name == promoted })?.isMe != true {
        return MeetSpeakerResult(names: [promoted], via: .geometry)
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
