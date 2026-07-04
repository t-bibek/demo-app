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

    // CALIBRATION (physics from RECORDED RAW DATA — plan: "threshold calibration
    // legitimate ONLY with physics justification from recorded raw data"):
    //
    // The gate this replaces fired on the instantaneous SAMPLE PEAK: remote
    // `systemPeak > 0.02`, mic `micPeak > 0.04` (max|sample| in a buffer). RMS
    // (root-mean-square energy over a 50ms frame) is ALWAYS well below the sample
    // peak of the same signal. The FIRST estimate (enter 0.006) was derived from a
    // crest-factor GUESS (RMS ≈ 0.3 × peak ⇒ 0.02 × 0.3 ≈ 0.006). That guess was
    // WRONG for this signal path, and the vad-quality-live run recorded the raw data
    // that proves it.
    //
    // MEASURED (qa/zoom-live vad-quality-live, iteration 1, Guest Bravo speaking via
    // the ScreenCaptureKit system tap — 40 per-tick vad_frame samples, each the
    // LOUDEST 50ms frame of that ~250-500ms poll tick):
    //   remote (guest speech) per-tick-max RMS: min 0.00002, median 0.0039, max 0.0074
    //   remote SILENCE ticks (natural pauses / muted):        0.00002 – 0.0006
    //   mic (local room, guest muted this test)  per-tick-max: median 0.0107, max 0.0428
    // With enter=0.006, remote cleared enter on only 5/40 ticks (and those were the
    // tick-MAX — the per-frame values feeding the state machine are strictly lower),
    // so `remoteVad` NEVER strung together 3 consecutive over-enter frames and
    // remote_active stayed FALSE for the entire speaking block. Guest Bravo, the
    // mute-gate guest, and the pip degraded-coverage speaker all went unnamed — the
    // three iteration-1 failures share this one root cause. 0.006 sat at the TOP of
    // the measured speech band, not between speech and silence: a scale error.
    //
    // RE-FIT to the measured distribution: put enter cleanly BETWEEN the ~0.0006
    // silence ceiling and the 0.0039 median speech tick-max, LEANING LOW because the
    // vad_frame samples are per-tick MAXima — the per-FRAME RMS the state machine
    // actually gates on is strictly below them, and enterFrames=3 needs THREE
    // consecutive frames over enter, so the threshold must clear the per-frame dips.
    // enter = 0.0018 (= 3× the loudest silence tick-max 0.0006; ≈ 0.46× the median
    // speech tick-max) — speech frames sit above it through an utterance, silence
    // (< 0.0006) never does. exit = 0.0009 (= 0.5× enter) is the hysteresis floor,
    // still 1.5× the silence ceiling so a genuine pause closes. To ground the next
    // re-fit, the trace now emits per-tick min + frame count (not just the max) so the
    // real per-frame floor is recorded. Env `MSD_VAD_ENTER/EXIT` override live.
    //
    // Why the pre-fix 0.006 broke 3-consecutive-frame opening but 0.0018 does NOT:
    // 0.006 sat at the TOP of the measured speech band (median tick-max 0.0039, peak
    // 0.0074), so most 50ms speech frames were BELOW it and the enterRun kept resetting
    // — three CONSECUTIVE over-enter frames essentially never happened, remote_active
    // stayed false, and Guest Bravo / the mute-gate guest / the pip degraded speaker
    // all went unnamed. At 0.0018, typical speech frames sit above the threshold so a
    // normal utterance clears 3 consecutive frames within its first ~150ms. The opening
    // problem was the LEVEL scale error, not the enterFrames debounce.
    //
    // enterFrames = 3 is KEPT (NOT lowered): the vad-quality-live tone-rejection guard
    // depends on it AND lowering the LEVEL does not weaken that guard at all — the tone
    // pulses are gain-driven and loud, so they clear ANY enter level; their rejection
    // comes SOLELY from the frame-count debounce. Each ~40ms pulse spans at most TWO
    // 50ms frames (one full + a boundary sliver); requiring THREE consecutive over-enter
    // frames rejects the straddling 2-frame transient (ding/click/tone burst) while a
    // real utterance — hundreds of ms of continuous voicing — clears 3 frames trivially.
    // Dropping to 2 would OPEN on those tone pulses and name the guest on energy-without-
    // voice — the exact false positive the scenario falsifies. Opening latency: ~150ms.
    public init(frameMs: Int = 50,
                enterLevel: Double = 0.0018,
                exitLevel: Double = 0.0009,
                enterFrames: Int = 3,
                hangoverMs: Int = 400) {
        self.frameMs = frameMs
        self.enterLevel = enterLevel
        self.exitLevel = exitLevel
        self.enterFrames = enterFrames
        self.hangoverMs = hangoverMs
    }

    /// Config for the LOCAL MIC stream. The default (above) is tuned for the REMOTE
    /// system-tap stream, which is attenuated/mixed and quiet. The mic is close-mic'd
    /// local voice and reads much hotter, so it must NOT share the remote's low enter
    /// or it names the local user on room noise / speaker bleed.
    //
    // MEASURED (same vad-quality-live run; the guest was MUTED and there was NO
    // deliberate local speech, so these mic levels are the ambient/bleed FLOOR the
    // gate must stay CLOSED on): mic per-tick-max RMS median 0.0107, max 0.0428. The
    // pre-B4 mic peak gate was `micPeak > 0.04`; the max mic RMS (0.0428) sat right at
    // that peak number, confirming the ambient floor tops out near ~0.011 typical with
    // rare ~0.04 spikes. enter = 0.02 sits ABOVE the 0.0107 ambient median (so ambient
    // never opens self) yet well below real close-mic local SPEECH RMS (crest factor
    // on a 0.04+ peak voice ⇒ ~0.012+ RMS sustained, and actual talking is louder).
    // exit = 0.01 gives the hysteresis band just under the ambient median. This
    // preserves the pre-B4 intent (mic bar ≈ 2× the remote bar) instead of collapsing
    // both streams onto the remote-scale enter. Env `MSD_VAD_MIC_ENTER/EXIT` override.
    public static func mic(hangoverMs: Int = 400) -> VadConfig {
        VadConfig(frameMs: 50, enterLevel: 0.02, exitLevel: 0.01, enterFrames: 3, hangoverMs: hangoverMs)
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
