import Foundation

// TeamsEdgeEvents — the discrete Teams ring-onset edges + the pure snapshot-diff that
// derives them, and the transition-state the resolver consumes. Mirrors
// MeetEdgeEvents, but Teams has ONE signal: the `vdi-frame-occlusion` ring (overlap-
// capable, self-excluded). There is NO AXObserver half — a live 74s / 9-handoff probe
// (`--observe`, docs §10) proved Teams' WebView2 emits ZERO AX notifications on a ring
// flip (Chromium marks class-token changes dirty-only — memory chromium-ax-class-changes-
// silent), so the engine's existing 500ms poll drives a bounded read + THIS diff
// synchronously; no observer thread is warranted. What DOES transfer from Meet is the
// rapid-swap disambiguation: §9.1 measured ring linger-L ≈ 1270ms, so during a fast
// handoff the just-ended speaker's ring overlaps the fresh one and the plain overlap
// set names both — TransitionConfidence prefers the freshly-edged holder.
//
// SELF-EXCLUSION (mirrors INV-5 for Meet): snapshots are built from non-self tiles
// only, so no edge/holder is ever the local user (self is mic-attributed separately).

/// One discrete Teams ring onset — a non-self tile's ring went silent→speaking.
public struct TeamsEdgeEvent: Equatable, Sendable {
    public enum Kind: String, Sendable, Equatable {
        case ringGained   // a non-self tile lit the vdi-frame-occlusion ring (per-utterance onset)
    }
    public var kind: Kind
    /// The newly-ringing non-self tile.
    public var to: String
    /// Monotonic ms the edge was observed (decay origin for confidence).
    public var atMs: Int

    public init(kind: Kind, to: String, atMs: Int) {
        self.kind = kind
        self.to = to
        self.atMs = atMs
    }

    /// NDJSON token for the `teams_edge` instrumentation line.
    public var kindToken: String { "ring-gained" }
}

/// The minimal per-tick Teams snapshot the diff needs — the non-self ring holders in
/// reading order. Deliberately tiny + AX-free so the diff is unit-testable.
public struct TeamsTileSnapshot: Equatable, Sendable {
    /// Non-self tiles currently carrying the ring, in reading order.
    public var ringHolders: [String]

    public init(ringHolders: [String] = []) {
        self.ringHolders = ringHolders
    }

    /// Build a snapshot from raw tile observations, applying self-exclusion once so
    /// every downstream holder is guaranteed non-self.
    public static func from(tiles: [TeamsTileObservation]) -> TeamsTileSnapshot {
        TeamsTileSnapshot(ringHolders: tiles.filter { $0.isSpeaking && !$0.isMe }.map { $0.name })
    }
}

/// Diff two Teams snapshots → the ring-onset edges between them, stamped `at` (a
/// monotonic ms). PURE: no AX, no clock. A ring GOING OUT emits no edge (a "lost"
/// ring isn't a move); each name newly ringing in `next` (not in `prev`) is a fresh
/// onset — the per-utterance signal that re-spikes its transition confidence.
public func teamsEdgesFromDiff(prev: TeamsTileSnapshot?, next: TeamsTileSnapshot, at atMs: Int) -> [TeamsEdgeEvent] {
    let prevSet = Set((prev ?? TeamsTileSnapshot()).ringHolders)
    return next.ringHolders
        .filter { !prevSet.contains($0) }
        .map { TeamsEdgeEvent(kind: .ringGained, to: $0, atMs: atMs) }
}

/// Snapshot of the transition state `teamsActiveSpeaker` needs: the freshly-edged
/// holder + its decayed confidence + the monotonic clock. Passed via the additive
/// `transition:` param; `nil` ⇒ byte-for-byte legacy (overlap-set) behavior. Mirrors
/// `MeetTransitionState`; the underlying `TransitionConfidence` state machine is shared.
public struct TeamsTransitionState: Equatable, Sendable {
    /// The name the most recent ring onset promoted (nil when no edge has fired).
    public var holder: String?
    /// `holder`'s decayed confidence at `nowMs` (see `TransitionConfidence`).
    public var confidence: Double
    /// Monotonic ms the state was sampled — telemetry/debug only.
    public var nowMs: Int

    public init(holder: String?, confidence: Double, nowMs: Int) {
        self.holder = holder
        self.confidence = confidence
        self.nowMs = nowMs
    }
}
