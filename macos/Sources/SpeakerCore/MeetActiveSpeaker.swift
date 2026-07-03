import Foundation

// CAPTURE NOTE (2026-07-03): the PROTOTYPE equalizer read needs the target Chrome
// window to be genuinely frontmost or Chrome won't publish the live equalizer classes.
// That force-activation side-effect lives in AccessibilityScanner.forceActivateForCapture
// (this file is pure, AppKit-free logic) — see that method for the full rationale.

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
    /// `kssMZb` — the active-speaker ring). Measured vs Recall's VAD ground truth:
    /// ~83% precision / 89% recall for a remote, ~14% for self (your tile gets no
    /// ring). LIVE-CORRECTED 2026-07-03: `kssMZb` is NOT dead — it is ABSENT in a
    /// 2-person call (Meet draws no ring for 2 people) but PRESENT in AX for 3+
    /// people, on the sticky last-active speaker's tile. So VAD-gate it (this
    /// resolver does): while VAD says speech the ring tile is the current speaker.
    /// See docs/meet-active-speaker-no-hardcoded-css.md + memory meet-ax-speaker-signals-3person.
    public var classSpeaking: Bool
    /// Whether this tile carries `AXFocused`. LIVE-VERIFIED 2026-07-03: Meet marks
    /// the PROMOTED/spotlit tile with `AXFocused:true` (the spotlit tile had it,
    /// self did not). A clean token-free boolean for "which tile is the main one"
    /// = the active speaker in Auto/spotlight layout; complements the geometry
    /// ratio (no threshold needed). Never set on the self tile in practice.
    public var isFocused: Bool
    /// Whether this is the local user's tile. NOTE (2026-07-03): the `(You)` label
    /// is GONE from the current-build AX tree, so the scanner must resolve self by
    /// name-matching the signed-in account, not by "(You)" — see AccessibilityScanner.
    public var isMe: Bool

    /// PROTOTYPE (fresh-capture 2026-07-03): whether a descendant of this tile is a
    /// SPEAKING equalizer node — an equalizer node (`AXDOMClassList` carries an anchor
    /// {DYfzY,IisKdb,QgSmzd}) that is NOT silent (no `gjg47c`). This is a DIRECT
    /// per-utterance read (the equalizer animates while the person talks), unlike the
    /// sticky/layout `kssMZb` ring — so the resolver runs it FIRST after the VAD gate.
    /// See `meetNodeIsSpeakingEqualizer` + AccessibilityScanner's per-tile walk.
    /// Defaults to false so every existing construction/test compiles unchanged.
    public var equalizerSpeaking: Bool

    public init(name: String, area: Double, orderIndex: Int, classSpeaking: Bool,
                isFocused: Bool = false, isMe: Bool = false, equalizerSpeaking: Bool = false) {
        self.name = name
        self.area = area
        self.orderIndex = orderIndex
        self.classSpeaking = classSpeaking
        self.isFocused = isFocused
        self.isMe = isMe
        self.equalizerSpeaking = equalizerSpeaking
    }
}

/// Which signal decided the active speaker — for telemetry: a rotation shows up
/// as speech with no `.cssClass` hits (and `.someoneFloor` gaps).
public enum MeetSpeakerSignal: String, Sendable, Equatable {
    case none           // no speech (VAD gate closed)
    case equalizer      // PROTOTYPE per-tile equalizer node (absence-of-gjg47c) — direct per-utterance read
    case ringTransition // fresh AXObserver edge (confidence-disambiguated ring/focus) — event-driven
    case cssClass       // kssMZb active-speaker ring (present in AX for 3+ people)
    case focused        // AXFocused promoted/spotlit tile — clean token-free boolean
    case geometry       // a clearly promoted/spotlit tile by area ratio — class-free
    case someoneFloor   // speech, but no tile attributable
}

public struct MeetSpeakerResult: Equatable, Sendable {
    public var names: [String]
    public var via: MeetSpeakerSignal
    /// Transition confidence that decided a `.ringTransition` attribution (nil for
    /// every other path). Surfaced so telemetry can show WHY a fresh edge overrode a
    /// stale ring during rapid turn-taking. Additive/defaulted — `transition: nil`
    /// callers get nil, so all existing results compare equal.
    public var confidence: Double?
    public init(names: [String], via: MeetSpeakerSignal, confidence: Double? = nil) {
        self.names = names
        self.via = via
        self.confidence = confidence
    }
}

/// Fused, VAD-gated Meet active-speaker resolution — the strategy Recall's binary
/// uses (geometry + AX + VAD → a participant set), with the rotating CSS class
/// demoted to a telemetered fallback. See docs/meet-active-speaker-no-hardcoded-css.md.
///
/// Order:
///  1. **VAD gate** — no speech ⇒ no speaker. (Soft when audio capture is
///     unavailable, so Meet still works Accessibility-only.)
///  1b. **Equalizer** (PROTOTYPE, 2026-07-03) — a per-tile equalizer node whose
///     `AXDOMClassList` is speaking (anchor present, silence class `gjg47c` ABSENT).
///     A DIRECT per-utterance read (animates while talking), so it leads the sticky
///     `kssMZb` ring. Overlap-capable; excludes self.
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
    someoneLabel: String = "Someone",
    transition: MeetTransitionState? = nil
) -> MeetSpeakerResult {
    guard vadSpeechActive else { return MeetSpeakerResult(names: [], via: .none) }

    // 1b) PROTOTYPE equalizer (fresh-capture 2026-07-03) — runs RIGHT AFTER the VAD
    //     gate and BEFORE the kssMZb ring. The equalizer's level class is a DIRECT
    //     per-UTTERANCE read (it animates only while the person is actually talking),
    //     whereas `kssMZb` is the layout/STICKY last-active ring — so the equalizer
    //     leads. Overlap-capable: names EVERY non-self tile whose equalizer is
    //     speaking (concurrent talkers all surface). `!isMe` excludes self exactly
    //     like the ring/focused/geometry paths (self is mic-attributed separately);
    //     the equalizer is empirically the remote's, but the resolver must not depend
    //     on that. Every existing path below is left intact as a fallback.
    let equalizerNames = tiles.filter { $0.equalizerSpeaking && !$0.isMe }.map { $0.name }
    if !equalizerNames.isEmpty {
        return MeetSpeakerResult(names: equalizerNames, via: .equalizer)
    }

    // 1c) FRESH EDGE (event-driven, additive — plan step 4). During rapid turn-taking
    //     the AX tree leaves MULTIPLE stale rings lit at once (the just-ended speaker's
    //     ring lingers a beat before Meet clears it), so the plain overlap ring set
    //     below would name both. The AXObserver's most-recent ring/focus EDGE, with
    //     transition confidence, disambiguates to the person who ACTUALLY just started:
    //     if a fresh transition names a NON-SELF holder that is among the currently-lit
    //     ring tiles, that holder alone wins via `.ringTransition`. `transition == nil`
    //     (every legacy/self-test caller) SKIPS this entirely, so behavior is
    //     byte-for-byte unchanged. Self-exclusion (`!isMe`): a self holder is ignored so
    //     the resolver falls through to the remote ring (self is mic-attributed).
    if let t = transition, let holder = t.holder,
       tiles.contains(where: { $0.name == holder && $0.classSpeaking && !$0.isMe }) {
        return MeetSpeakerResult(names: [holder], via: .ringTransition, confidence: t.confidence)
    }

    // 2) Active-speaker ring (`kssMZb`) — Meet draws it on the SPEAKING remote's
    //    tile; your own tile never gets it (confirmed live: the ring node is only
    //    ever in the remote's subtree), so a class hit is a DIRECT who-is-speaking
    //    read needing no self-detection. Checked BEFORE geometry because geometry
    //    only guesses from tile SIZE, which is wrong whenever the biggest tile
    //    isn't the speaker — e.g. you pin yourself (large, camera off) while a
    //    remote talks in a small corner tile (the reported spotlight-self layout).
    //    `!isMe` is defense-in-depth (self is mic-attributed separately, like the
    //    focused/geometry paths below): even if a self tile ever carried the ring
    //    — or a remote-config rule matched a self class — we must not name self as
    //    the active speaker. Overlap-safe: a self ring alongside a remote ring
    //    still returns the remote.
    let ringNames = tiles.filter { $0.classSpeaking && !$0.isMe }.map { $0.name }
    if !ringNames.isEmpty {
        return MeetSpeakerResult(names: ringNames, via: .cssClass)
    }

    // 2b) AXFocused promoted tile — Meet marks the spotlit/main tile with AXFocused
    //     (live-verified 2026-07-03). A clean token-free boolean; in Auto/spotlight
    //     the promoted tile is the speaker. Preferred over the geometry RATIO
    //     (which is a heuristic). Suppressed under a presentation (the shared
    //     screen is the focused/biggest surface, not a speaker); never self.
    if !presentationActive,
       let focused = tiles.first(where: { $0.isFocused && !$0.isMe }) {
        return MeetSpeakerResult(names: [focused.name], via: .focused)
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
