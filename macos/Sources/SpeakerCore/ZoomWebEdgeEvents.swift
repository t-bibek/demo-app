import Foundation

// ZoomWebEdgeEvents — the discrete Zoom WEB active-speaker edges + the pure
// snapshot-diff that derives them, plus the transition-state the resolver
// consumes. Mirrors MeetEdgeEvents / TeamsEdgeEvents; Zoom web (a Chromium tab)
// has ONE signal: the tile whose AXDOMClassList carries a `<prefix>--active`
// modifier (`speaker-bar-container__video-frame--active` on the filmstrip, or the
// gallery / speaker-view equivalents). It is Zoom's own VAD — the highlight moves
// to whoever is talking.
//
// CHROMIUM IS AX-SILENT ON CLASS FLIPS (.claude/CHROMIUM-AX-NOTIFICATIONS.md): the
// `--active` class flips post NO AX notification of any kind, so the PRIMARY edge
// source is a fast bounded subtree read diffed via `zoomWebEdgesFromDiff` — the
// AXObserver only supplies opportunistic wake-ups. The active class also LINGERS
// on silence, so during a fast handoff the just-ended speaker's tile can still
// carry `--active` overlapping the fresh one; `TransitionConfidence` prefers the
// freshly-edged holder (the Meet/Teams rapid-swap disambiguation, reused).
//
// SELF-EXCLUSION (review invariant INV-15, mirrors INV-5 for Meet): snapshots are
// built from NON-SELF tiles only (`ZoomWebTileSnapshot.from` drops `isMe`), so no
// edge/holder is ever the local user. A self-active tile is recorded as
// `selfActive` telemetry and is mic-attributed separately — it NEVER becomes an
// edge holder.

/// One participant tile observed on the Zoom web surface this tick — produced by
/// the scanner / observer from the tile's AXDOMClassList + name nodes. Deliberately
/// tiny + AX-free so the snapshot/diff is unit-testable with no AX.
public struct ZoomWebTileObservation: Equatable, Sendable {
    public var name: String
    /// Whether this tile's classList carries the active-speaker modifier
    /// (`<prefix>--active` for ANY of filmstrip / speaker / gallery).
    public var active: Bool
    /// Whether this is the local user's own tile (self-exclusion — never a holder).
    public var isMe: Bool
    /// Per-tile mute, when readable (`video-avatar__avatar-footer--view-mute-computer`):
    /// true = unmuted, false = muted, nil = unknown. Carried for telemetry / a
    /// future mute-gate; the active class alone decides the holder.
    public var muted: Bool?
    /// Which tile family this came from — "filmstrip" / "speaker" / "gallery".
    /// Telemetry only (per-view accuracy in the live report).
    public var surface: String

    public init(name: String, active: Bool, isMe: Bool = false,
                muted: Bool? = nil, surface: String = "") {
        self.name = name
        self.active = active
        self.isMe = isMe
        self.muted = muted
        self.surface = surface
    }
}

/// The minimal per-tick Zoom-web snapshot the diff needs — the NON-SELF active
/// holders in reading order, plus the present-names roster + a self-active
/// telemetry flag. Self-exclusion is applied ONCE here at snapshot-BUILD level so
/// no downstream path can name self (INV-15).
public struct ZoomWebTileSnapshot: Equatable, Sendable {
    /// Non-self tiles currently carrying the active-speaker class, in reading order.
    public var activeHolders: [String]
    /// All present tile names (self INCLUDED) in reading order — the roster source.
    public var presentNames: [String]
    /// Telemetry: a SELF tile carried the active class this tick (mic-attributed,
    /// never an edge holder). Not part of the diff — pure diagnostics.
    public var selfActive: Bool

    public init(activeHolders: [String] = [], presentNames: [String] = [],
                selfActive: Bool = false) {
        self.activeHolders = activeHolders
        self.presentNames = presentNames
        self.selfActive = selfActive
    }

    /// Build a snapshot from raw tile observations, applying self-exclusion once so
    /// every downstream holder is guaranteed non-self. `activeHolders` are the
    /// non-self active tiles in reading order; `selfActive` records whether a self
    /// tile was active (telemetry only).
    public static func from(tiles: [ZoomWebTileObservation]) -> ZoomWebTileSnapshot {
        ZoomWebTileSnapshot(
            activeHolders: tiles.filter { $0.active && !$0.isMe }.map { $0.name },
            presentNames: tiles.map { $0.name },
            selfActive: tiles.contains { $0.active && $0.isMe })
    }
}

/// One discrete Zoom-web active-speaker move — a NON-SELF tile newly lit the
/// active class. Mirrors the Meet/Teams edge shape.
public struct ZoomWebEdgeEvent: Equatable, Sendable {
    public enum Kind: String, Sendable, Equatable {
        case activeMoved   // a non-self tile newly carries the active-speaker class
    }
    public var kind: Kind
    /// The prior holder (nil when the highlight appeared from nothing).
    public var from: String?
    /// The new holder — always a non-self tile (self edges are suppressed).
    public var to: String
    /// Monotonic ms the edge was observed (decay origin for confidence).
    public var atMs: Int

    public init(kind: Kind = .activeMoved, from: String?, to: String, atMs: Int) {
        self.kind = kind
        self.from = from
        self.to = to
        self.atMs = atMs
    }

    /// NDJSON `kind` token used in the `zoomweb_edge` instrumentation line.
    public var kindToken: String { "active-moved" }
}

/// Diff two Zoom-web snapshots → the active-moved edges between them, stamped `at`
/// (a monotonic ms). PURE: no AX, no clock. Mirrors `teamsEdgesFromDiff`:
///  - each name newly carrying the active class in `next` (not active in `prev`)
///    is a fresh onset → one `activeMoved` edge (the per-turn signal that
///    re-spikes its transition confidence).
///  - the active class GOING OUT emits NO edge (a lost highlight isn't a move).
///  - `from` is the SINGLE prior holder when there was exactly one (the common
///    A→B handoff), else nil (ambiguous during a multi-active linger).
///  - first snapshot (`prev == nil`): treated as an empty prior set, so a holder
///    present in the very first read DOES emit an edge — matching Teams'
///    first-snapshot semantics (the observer primes with a read, and a call
///    already in progress must name its current speaker). Self-tested.
public func zoomWebEdgesFromDiff(prev: ZoomWebTileSnapshot?, next: ZoomWebTileSnapshot, at atMs: Int) -> [ZoomWebEdgeEvent] {
    let prevHolders = (prev ?? ZoomWebTileSnapshot()).activeHolders
    let prevSet = Set(prevHolders)
    // Single prior holder ⇒ this is a clean A→B (or nothing→B) handoff; carry it as
    // `from`. Zero or 2+ prior holders ⇒ `from` is ambiguous → nil.
    let singleFrom = prevHolders.count == 1 ? prevHolders.first : nil
    return next.activeHolders
        .filter { !prevSet.contains($0) }
        .map { ZoomWebEdgeEvent(kind: .activeMoved, from: singleFrom, to: $0, atMs: atMs) }
}

/// Snapshot of the transition state the Zoom-web resolver needs: the freshly-edged
/// holder + its decayed confidence + the monotonic clock. Mirrors
/// `MeetTransitionState` / `TeamsTransitionState`; the underlying
/// `TransitionConfidence` state machine is shared. `nil` ⇒ legacy behavior (the
/// plain active-class read).
public struct ZoomWebTransitionState: Equatable, Sendable {
    /// The name the most recent edge promoted (nil when no edge has fired).
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

/// Zoom-web active-speaker resolution given the current non-self active set + the
/// transition state. PURE. When more than one tile carries the active class (a
/// lingering-highlight overlap during a fast handoff), the transition HOLDER alone
/// wins — provided it is actually among the currently-active tiles (a holder that
/// already went silent is ignored, so we never name a phantom). `nil` transition
/// ⇒ the plain first-active read (legacy). Returns the single resolved holder, or
/// nil when nobody is active.
public func zoomWebActiveSpeaker(snapshot: ZoomWebTileSnapshot,
                                 transition: ZoomWebTransitionState?) -> String? {
    let active = snapshot.activeHolders
    guard !active.isEmpty else { return nil }
    if active.count == 1 { return active[0] }
    // Multiple lit tiles: prefer the freshly-edged holder IF it is still lit.
    if let h = transition?.holder, active.contains(h) { return h }
    // No usable transition holder among the lit tiles → the first in reading order
    // (deterministic; matches the legacy `barActive ?? bigActive` first-wins).
    return active[0]
}
