import Foundation

// ZoomNativeEdgeEvents — the discrete native-Zoom PIP "Talking:" edges + the pure
// snapshot-diff that derives them, plus the transition-state the resolver
// consumes. Mirrors MeetEdgeEvents / TeamsEdgeEvents / ZoomWebEdgeEvents.
//
// Native Zoom (us.zoom.xos) has NO tile speaking signal — the grid is Metal-
// rendered and opaque to Accessibility (triple-confirmed: ZoomProbe, Recall's
// binary, docs/zoom-native-detection.md §3/§5). Do NOT chase one. The ONE place
// native Zoom names the current talker is the PIP thumbnail's "Talking: <name>"
// static text (Zoom's own VAD), parsed by `parseZoomPipTalking`. When that name
// CHANGES between ticks it is a genuine talking-changed edge; those edges feed a
// native `TransitionConfidence` so a fresh PIP-named talker instantly overtakes a
// stale one, exactly like the Chromium ring edges.
//
// This is a REAL AX-event source in a way the Chromium class flips are not: the
// PIP "Talking:" node is an AXStaticText whose value change (and the PIP window's
// creation/destruction) DOES post AX notifications — so `ZoomNativeObserver` can
// wake on `AXTitleChanged` / `AXWindowCreated` / `AXUIElementDestroyed` and re-read
// the bounded PIP subtree, rather than polling a 6000-node full walk every tick.
//
// SELF-EXCLUSION (review invariant INV-15): the snapshot is built with the self
// name excluded — a PIP that reads "Talking: <self>" is recorded as `selfTalking`
// telemetry, NEVER a holder. Self speech is mic-attributed separately.

/// The minimal per-tick native-Zoom snapshot the diff needs — the NON-SELF PIP
/// talker (nil = nobody / self only). Deliberately tiny + AX-free so the diff is
/// unit-testable. Built via `from(pipTalking:selfName:)` so self-exclusion is
/// applied ONCE at snapshot-build level (INV-15).
public struct ZoomNativeSnapshot: Equatable, Sendable {
    /// The PIP "Talking:" name this tick, self EXCLUDED (nil = nobody / self only).
    public var pipTalking: String?
    /// Telemetry: the PIP named the LOCAL user as talking (mic-attributed, never a
    /// holder). Not part of the diff — pure diagnostics.
    public var selfTalking: Bool

    public init(pipTalking: String? = nil, selfTalking: Bool = false) {
        self.pipTalking = pipTalking
        self.selfTalking = selfTalking
    }

    /// Build a snapshot from the raw parsed PIP "Talking:" name, applying self-
    /// exclusion once. `selfName` is the resolved local-user name (from the roster
    /// "(me)" row / account button); a PIP that names self becomes `selfTalking`
    /// telemetry, never `pipTalking`.
    public static func from(pipTalking raw: String?, selfName: String?) -> ZoomNativeSnapshot {
        guard let raw, !raw.isEmpty else { return ZoomNativeSnapshot() }
        if let selfName, raw.caseInsensitiveCompare(selfName) == .orderedSame {
            return ZoomNativeSnapshot(pipTalking: nil, selfTalking: true)
        }
        return ZoomNativeSnapshot(pipTalking: raw, selfTalking: false)
    }
}

/// One discrete native-Zoom talking change — the PIP "Talking:" name moved to a
/// NEW non-self talker. Mirrors the other platforms' edge shape.
public struct ZoomNativeEdgeEvent: Equatable, Sendable {
    public enum Kind: String, Sendable, Equatable {
        case talkingChanged   // the PIP "Talking:" name changed to a new non-self talker
    }
    public var kind: Kind
    /// The prior talker (nil when the PIP named nobody before).
    public var from: String?
    /// The new talker — always a non-self name (self is suppressed at snapshot build).
    public var to: String
    /// Monotonic ms the edge was observed (decay origin for confidence).
    public var atMs: Int

    public init(kind: Kind = .talkingChanged, from: String?, to: String, atMs: Int) {
        self.kind = kind
        self.from = from
        self.to = to
        self.atMs = atMs
    }

    /// NDJSON `kind` token used in the `zoom_edge` instrumentation line.
    public var kindToken: String { "talking-changed" }
}

/// Diff two native-Zoom snapshots → the talking-changed edges between them,
/// stamped `at` (a monotonic ms). PURE: no AX, no clock. Rules (self already
/// excluded upstream):
///  - `talkingChanged` when `pipTalking` changed to a NEW non-nil name.
///  - the talker going to nil ⇒ NO edge (a "lost" talker isn't a move — mirrors
///    every other platform's diff).
///  - first snapshot (`prev == nil`): treated as "nobody talking" prior, so a PIP
///    that already names a talker in the first read DOES emit an edge (a call
///    joined via the PIP must name its current speaker).
public func zoomNativeEdgesFromDiff(prev: ZoomNativeSnapshot?, next: ZoomNativeSnapshot, at atMs: Int) -> [ZoomNativeEdgeEvent] {
    let p = prev ?? ZoomNativeSnapshot()
    guard let to = next.pipTalking, to != p.pipTalking else { return [] }
    return [ZoomNativeEdgeEvent(kind: .talkingChanged, from: p.pipTalking, to: to, atMs: atMs)]
}

/// Snapshot of the transition state the native-Zoom resolver needs: the
/// freshly-edged PIP talker + its decayed confidence + the monotonic clock.
/// Mirrors the other platforms' transition states; the underlying
/// `TransitionConfidence` state machine is shared. `nil` ⇒ legacy behavior (the
/// plain PIP read, source "zoom.pip").
public struct ZoomNativeTransitionState: Equatable, Sendable {
    /// The name the most recent PIP edge promoted (nil when no edge has fired).
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
