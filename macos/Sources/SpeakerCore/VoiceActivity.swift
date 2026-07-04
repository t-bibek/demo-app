import Foundation

// VoiceActivity — a PURE, time-injected Schmitt-trigger voice-activity detector
// (plan B4). It replaces the engine's instantaneous-peak gates (`micPeak > 0.04`,
// `systemPeak > 0.02`) with real hysteresis so a single-frame transient (a Zoom
// join "ding", a keyboard click, a notification chime) can NOT open a speech
// segment, and a natural pause inside a sentence can NOT prematurely close one.
// The SAME downstream booleans come out (`micActive` / `remoteActive`), so every
// platform's VAD gate — Meet's remote gate, Teams' self-mic path, Zoom's
// `zoomMuteGateSpeakers` — is a drop-in swap.
//
// SHARED across ALL platforms: the meters (`MicMeter` / `SystemAudioMeter`)
// accumulate RMS energy over ~50ms frames instead of reporting a single sample
// peak; the engine feeds each frame's RMS into a `SchmittVad` instance with
// `AXKit.monotonicMs()` and reads its boolean.
//
// PURITY (review invariant INV-16): every method takes an explicit monotonic
// `atMs` — there is NO wall/monotonic clock call anywhere in this file. The clock
// source is `AXKit.monotonicMs()`, injected by the engine. That makes the
// hysteresis math fully deterministic + unit-testable (see SpeakerCoreSelfTest).

/// Tuning for the Schmitt-trigger VAD. Two thresholds (enter > exit) give
/// hysteresis: you must exceed `enterLevel` for `enterFrames` consecutive frames
/// to open, and stay below `exitLevel` for a sustained `hangoverMs` to close.
///
/// Defaults are derived from the intent of the current instantaneous-peak gates
/// (mic 0.04 / system 0.02 |sample| peaks). RMS of steady speech runs BELOW the
/// sample peak, so the enter levels sit a little under those peak numbers and the
/// exit levels a little under the enter levels; they are calibrated live in
/// `vad-quality-live` (raw RMS recorded) and env-overridable so the fix agent can
/// tune without a rebuild.
public struct VadConfig: Equatable, Sendable {
    /// Frame duration the RMS is aggregated over, ms (the accumulation window the
    /// meters use; carried here for documentation + the enterFrames→time relation).
    public var frameMs: Int
    /// RMS above this (for `enterFrames` consecutive frames) OPENS a segment.
    public var enterLevel: Double
    /// RMS must stay below this (sustained `hangoverMs`) to CLOSE a segment.
    public var exitLevel: Double
    /// Consecutive over-`enterLevel` frames required to open (transient rejection: a
    /// short ding/click/chime spanning fewer than `enterFrames` frames never opens —
    /// see the calibration note on `init` for why the default is 3, not 2).
    public var enterFrames: Int
    /// Sustained-quiet time required to close, ms (the hangover — bridges the
    /// natural pauses inside a sentence so one utterance stays one segment).
    public var hangoverMs: Int

    // CALIBRATION (physics, not a fudge — plan: "threshold calibration legitimate
    // ONLY with physics justification from recorded raw data"):
    //
    // The gate this replaces fired on the instantaneous SAMPLE PEAK: remote
    // `systemPeak > 0.02`, mic `micPeak > 0.04` (max|sample| in a buffer). RMS
    // (root-mean-square energy over a 50ms frame) is ALWAYS well below the sample
    // peak of the same signal — for speech the crest factor (peak/RMS) is ~3-4, so
    // RMS ≈ 0.25-0.35 × peak; even a pure sine has RMS = peak/√2 ≈ 0.707 × peak.
    //
    // The first live VAD run named NOBODY (qa/zoom-live: 0 speech_on where the
    // pre-B4 peak gate named Guest Alpha 7×) because the RMS threshold was left at
    // the PEAK-scale number (0.03 > the 0.02 peak gate it replaced). An RMS gate at
    // 0.03 only fires on a signal whose PEAK is ~0.09-0.12 — far louder than the
    // 0.02-peak signals the old gate (correctly) caught, so real remote speech that
    // used to name a speaker fell silent. This is a scale error, not a tuning taste.
    //
    // Re-derive from the peak-gate intent: to catch the same remote speech the
    // 0.02 peak gate caught, RMS-enter ≈ 0.02 × 0.3 (speech crest factor) ≈ 0.006.
    // exit ≈ 0.5 × enter gives the hysteresis band (must fall to ~half to close),
    // which the state machine test still exercises with its own explicit config.
    // Raw per-frame RMS is now emitted (`vad_frame` NDJSON, MSD_VAD_TRACE) so the
    // next live run records the actual distribution and this number can be re-fit
    // to measured speech/tone/noise RMS instead of the crest-factor estimate.
    //
    // enterFrames = 3 (was 2): the debounce window must EXCEED the transient it is
    // meant to reject. A join ding / click / notification chime is ~30-50ms of energy
    // — at 50ms frames that is 1 full frame plus a boundary sliver, i.e. up to TWO
    // consecutive over-enter frames when it straddles a frame boundary (and enterLevel
    // is deliberately tiny at 0.006, so even a sliver of a 0.6-amplitude burst counts).
    // enterFrames=2 would therefore OPEN on a straddling transient — the exact false
    // positive vad-quality-live falsifies. Requiring 3 consecutive over-enter frames
    // ⇒ ≥ ~100-150ms of CONTINUOUS energy to open; a sub-100ms transient can span at
    // most 2 frames and is rejected, while real speech (hundreds of ms of continuous
    // voicing) clears 3 frames trivially. Opening latency cost is one extra 50ms frame
    // (~150ms total) — well inside the live latency bars.
    public init(frameMs: Int = 50,
                enterLevel: Double = 0.006,
                exitLevel: Double = 0.003,
                enterFrames: Int = 3,
                hangoverMs: Int = 400) {
        self.frameMs = frameMs
        self.enterLevel = enterLevel
        self.exitLevel = exitLevel
        self.enterFrames = enterFrames
        self.hangoverMs = hangoverMs
    }
}

/// The Schmitt-trigger VAD state machine. Value type — the engine keeps one
/// instance per stream (mic, system) and mutates it in place per frame. Fully
/// time-injected: `ingest(rms:atMs:)` returns the current speech boolean.
public struct SchmittVad: Equatable, Sendable {
    public let config: VadConfig
    /// Whether a speech segment is currently OPEN.
    public private(set) var active: Bool
    /// Consecutive frames seen over `enterLevel` while NOT yet active (the
    /// enter-debounce counter; reset whenever a frame drops to/under enter).
    private var enterRun: Int
    /// Monotonic ms the RMS first dropped below `exitLevel` in the current
    /// below-exit streak while active (the hangover origin). nil ⇒ not below exit
    /// (a frame at/over exit clears it, so the hangover must be SUSTAINED).
    private var belowExitSinceMs: Int?

    public init(config: VadConfig = VadConfig()) {
        self.config = config
        self.active = false
        self.enterRun = 0
        self.belowExitSinceMs = nil
    }

    /// Feed one frame's RMS (0..1) at monotonic `atMs`; returns whether a speech
    /// segment is active AFTER this frame.
    ///
    /// OPEN: `rms > enterLevel` for `>= enterFrames` consecutive frames. A frame at
    /// or below `enterLevel` resets the run, so a short transient spanning fewer than
    /// `enterFrames` frames (a ding/click, even one straddling a frame boundary) never
    /// opens with the default `enterFrames = 3`.
    ///
    /// CLOSE: while active, `rms < exitLevel` must hold for a SUSTAINED `hangoverMs`
    /// (measured from the first below-exit frame). Any frame at/over `exitLevel`
    /// clears the timer — so a pause shorter than the hangover keeps the segment
    /// open (one utterance stays one segment); re-entry during the hangover is free
    /// (the segment simply never closed).
    @discardableResult
    public mutating func ingest(rms: Double, atMs: Int) -> Bool {
        if active {
            if rms < config.exitLevel {
                let since = belowExitSinceMs ?? atMs
                belowExitSinceMs = since
                if atMs - since >= config.hangoverMs {
                    active = false
                    enterRun = 0
                    belowExitSinceMs = nil
                }
            } else {
                // At/over exit — speech (or its tail) is still present; cancel any
                // pending close so the hangover must be a CONTINUOUS quiet run.
                belowExitSinceMs = nil
            }
        } else {
            if rms > config.enterLevel {
                enterRun += 1
                if enterRun >= config.enterFrames {
                    active = true
                    belowExitSinceMs = nil
                }
            } else {
                enterRun = 0
            }
        }
        return active
    }
}
