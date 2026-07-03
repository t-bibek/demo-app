import Foundation

// TransitionConfidence — the transition-triggered confidence that tightens Meet
// active-speaker attribution during rapid turn-taking (event-driven ring/focus
// plan, 2026-07-03). When an edge (ring-moved / focus-moved / equalizer-onset)
// names a NEW holder, confidence SPIKES to `spike`; between edges it DECAYS toward
// `floor` on a half-life, so the last-named holder stays "sticky" (never drops to
// zero) yet a fresh edge instantly overtakes a stale ring. This disambiguates two
// stale rings the AX tree left lit after a fast swap.
//
// PURITY (review invariant INV-6): every method takes an explicit monotonic
// `nowMs` — there is NO wall/monotonic clock call anywhere in this file. The clock
// source is `AXKit.monotonicMs()`, injected by the engine. That makes decay math
// fully deterministic + unit-testable (see SpeakerCoreSelfTest / TransitionConfidenceTests).

/// Tuning for the transition confidence curve. Defaults are the plan's
/// (spike 1.0, floor 0.25, half-life 1200ms). Env-overridable in the app
/// (`MSD_TRANSITION_SPIKE` / `_FLOOR` / `_HALFLIFE_MS`).
public struct TransitionConfidenceConfig: Equatable, Sendable {
    /// Confidence the instant an edge names a holder (t = 0).
    public var spike: Double
    /// Asymptotic floor as t → ∞ while the holder is unchanged (stickiness — never 0).
    public var floor: Double
    /// Half-life of the decay from `spike` toward `floor`, in milliseconds.
    public var halfLifeMs: Double

    public init(spike: Double = 1.0, floor: Double = 0.25, halfLifeMs: Double = 1200) {
        self.spike = spike
        self.floor = floor
        self.halfLifeMs = halfLifeMs
    }
}

/// The transition-confidence state machine: which name currently holds the floor,
/// when its edge fired, and the decay curve. Value type — cheap to copy; the engine
/// keeps one instance and mutates it in place per tick.
public struct TransitionConfidence: Equatable, Sendable {
    public let config: TransitionConfidenceConfig
    /// The name the most recent edge promoted (nil = no edge yet this call).
    public private(set) var holder: String?
    /// Monotonic ms the current holder's edge fired (the decay origin).
    public private(set) var edgeAtMs: Int

    public init(config: TransitionConfidenceConfig = TransitionConfidenceConfig()) {
        self.config = config
        self.holder = nil
        self.edgeAtMs = 0
    }

    /// Record an edge to `name` at monotonic `nowMs`: swap the holder and re-spike
    /// (decay origin resets to now). A repeat edge to the SAME holder still re-spikes
    /// — a fresh ring/equalizer burst is fresh evidence the same person is talking.
    public mutating func edge(to name: String, at nowMs: Int) {
        holder = name
        edgeAtMs = nowMs
    }

    /// Confidence for `name` at monotonic `nowMs`. The current holder decays
    /// `floor + (spike − floor)·0.5^(elapsed/halfLife)` (t=0 → spike, t=halfLife →
    /// midpoint, t→∞ → floor — sticky, never 0). Every OTHER name is 0.
    public func confidence(of name: String, at nowMs: Int) -> Double {
        guard let holder, holder == name else { return 0 }
        let elapsed = Double(max(0, nowMs - edgeAtMs))
        guard config.halfLifeMs > 0 else { return config.floor }
        let decay = pow(0.5, elapsed / config.halfLifeMs)
        return config.floor + (config.spike - config.floor) * decay
    }

    /// The current holder's own decayed confidence (0 when there's no holder).
    public func holderConfidence(at nowMs: Int) -> Double {
        guard let holder else { return 0 }
        return confidence(of: holder, at: nowMs)
    }
}

/// Snapshot of the transition state the resolver needs: the freshly-edged holder +
/// its decayed confidence + the monotonic clock. Passed to `meetActiveSpeaker` via
/// the additive `transition:` param; `nil` ⇒ byte-for-byte legacy behavior.
public struct MeetTransitionState: Equatable, Sendable {
    /// The name the most recent edge promoted (nil when no edge has fired).
    public var holder: String?
    /// `holder`'s decayed confidence at `nowMs` (see `TransitionConfidence`).
    public var confidence: Double
    /// Monotonic ms the state was sampled — carried for telemetry/debug only.
    public var nowMs: Int

    public init(holder: String?, confidence: Double, nowMs: Int) {
        self.holder = holder
        self.confidence = confidence
        self.nowMs = nowMs
    }
}
