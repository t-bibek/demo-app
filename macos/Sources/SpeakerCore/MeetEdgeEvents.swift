import Foundation

// MeetEdgeEvents — the discrete Meet transition edges (ring-moved / focus-moved /
// equalizer-onset) and the pure snapshot-diff that derives them. Shared by BOTH the
// AXObserver callback coalescing and the reconciliation sweep, so both synthesize
// edges through ONE tested code path (no AX needed to test it).
//
// SELF-EXCLUSION (review invariant INV-5): `meetEdgesFromDiff` NEVER emits an edge
// whose `to` is the local user's tile (`isMe`). A self ring/focus/equalizer is not a
// remote-speaker signal — self is mic-attributed separately — so a self-focus edge
// must yield no name (there is a dedicated self-focus-edge self-test).

/// One discrete Meet transition, emitted the instant a signal moves between tiles.
public struct MeetEdgeEvent: Equatable, Sendable {
    public enum Kind: String, Sendable, Equatable {
        case ringMoved       // the kssMZb active-speaker ring moved to a new tile
        case focusMoved      // AXFocused moved (cheap; NOT elevated above its chain slot)
        case equalizerOnset  // a tile's equalizer went silent→speaking (per-utterance)
    }
    public var kind: Kind
    /// The prior holder (nil when the signal appeared from nothing).
    public var from: String?
    /// The new holder — always a non-self tile (self edges are suppressed).
    public var to: String
    /// Monotonic ms the edge was observed (decay origin for confidence).
    public var atMs: Int

    public init(kind: Kind, from: String?, to: String, atMs: Int) {
        self.kind = kind
        self.from = from
        self.to = to
        self.atMs = atMs
    }

    /// NDJSON `kind` token used in the `meet_edge` instrumentation line.
    public var kindToken: String {
        switch kind {
        case .ringMoved: return "ring-moved"
        case .focusMoved: return "focus-moved"
        case .equalizerOnset: return "equalizer-onset"
        }
    }
}

/// The minimal per-tick snapshot the diff needs — derived from a bounded subtree
/// read (observer refresh or reconcile). Deliberately tiny + AX-free so the diff is
/// unit-testable. Each channel names the CURRENT non-self holder (nil = none).
public struct MeetTileSnapshot: Equatable, Sendable {
    /// Non-self tile currently carrying the kssMZb ring (nil = no ring / self only).
    public var ringHolder: String?
    /// Non-self tile currently carrying AXFocused (nil = none / self only).
    public var focusHolder: String?
    /// Non-self tiles whose equalizer is currently speaking (absence-of-gjg47c).
    public var equalizerSpeakers: [String]

    public init(ringHolder: String? = nil, focusHolder: String? = nil,
                equalizerSpeakers: [String] = []) {
        self.ringHolder = ringHolder
        self.focusHolder = focusHolder
        self.equalizerSpeakers = equalizerSpeakers
    }

    /// Build a snapshot from raw tile observations, applying self-exclusion once so
    /// every downstream holder/speaker is guaranteed non-self (INV-5). The ring/focus
    /// holder is the FIRST non-self tile carrying that signal (matches the resolver's
    /// `first(where:)` selection); equalizer speakers are all non-self speaking tiles.
    public static func from(tiles: [MeetTileObservation]) -> MeetTileSnapshot {
        let ring = tiles.first(where: { $0.classSpeaking && !$0.isMe })?.name
        let focus = tiles.first(where: { $0.isFocused && !$0.isMe })?.name
        let eq = tiles.filter { $0.equalizerSpeaking && !$0.isMe }.map { $0.name }
        return MeetTileSnapshot(ringHolder: ring, focusHolder: focus, equalizerSpeakers: eq)
    }
}

/// Diff two Meet snapshots → the edges that fired between them, stamped `at` (a
/// monotonic ms). PURE: no AX, no clock. Rules (self already excluded upstream):
///  - `ringMoved`  when `ringHolder` changed to a NEW non-nil name.
///  - `focusMoved` when `focusHolder` changed to a NEW non-nil name.
///  - `equalizerOnset` for each name that is speaking in `next` but was NOT in `prev`
///    (a fresh silent→speaking transition — the per-utterance signal).
/// No change ⇒ []. A holder going to nil ⇒ no edge (a "lost" signal isn't a move).
public func meetEdgesFromDiff(prev: MeetTileSnapshot?, next: MeetTileSnapshot, at atMs: Int) -> [MeetEdgeEvent] {
    var edges: [MeetEdgeEvent] = []
    let p = prev ?? MeetTileSnapshot()

    if let to = next.ringHolder, to != p.ringHolder {
        edges.append(MeetEdgeEvent(kind: .ringMoved, from: p.ringHolder, to: to, atMs: atMs))
    }
    if let to = next.focusHolder, to != p.focusHolder {
        edges.append(MeetEdgeEvent(kind: .focusMoved, from: p.focusHolder, to: to, atMs: atMs))
    }
    let prevSpeaking = Set(p.equalizerSpeakers)
    for to in next.equalizerSpeakers where !prevSpeaking.contains(to) {
        edges.append(MeetEdgeEvent(kind: .equalizerOnset, from: nil, to: to, atMs: atMs))
    }
    return edges
}
