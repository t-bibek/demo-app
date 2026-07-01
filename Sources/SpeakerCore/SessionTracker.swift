import Foundation

/// Tracker tuning. Ported from `TrackerOptions` in src/shared/sessionTracker.ts.
public struct TrackerOptions: Sendable {
    /// How long a speaker can go unseen (no pulses) before their session is
    /// considered finished. A few engine poll intervals so indicator flicker
    /// does not split one utterance into many sessions.
    public var endSilenceMs: Int
    /// Approximate width of one engine poll. A speaker seen in exactly one poll
    /// spoke for roughly this long, so it is added to `lastSeen - start`.
    public var pulseWidthMs: Int

    public init(endSilenceMs: Int = 2000, pulseWidthMs: Int = 500) {
        self.endSilenceMs = endSilenceMs
        self.pulseWidthMs = pulseWidthMs
    }
}

public let defaultTrackerOptions = TrackerOptions()

/// Aggregates "name X is speaking right now" pulses (one per engine poll) into
/// speaking sessions with a start time and duration.
///
/// Time is always passed in explicitly so the class is deterministic and
/// testable; callers drive it with `nowMs()`. Direct port of `SessionTracker`.
public final class SessionTracker {
    private struct ActiveSession {
        var platform: Platform
        var name: String
        var startTs: Int
        var lastSeenTs: Int
        var ctx: SpeechContext
    }

    private var sessions: [String: ActiveSession] = [:]
    private let opts: TrackerOptions
    private let emit: (TrackerEvent) -> Void

    public init(opts: TrackerOptions = TrackerOptions(),
                emit: @escaping (TrackerEvent) -> Void) {
        self.opts = opts
        self.emit = emit
    }

    /// Report that `name` was observed speaking on `platform` at time `ts`.
    ///
    /// `meetingId`/`participantId`/`source` carry the Recall-style identity. They
    /// default empty so existing callers/tests compile unchanged; when omitted the
    /// session key falls back to the legacy `platform::name`.
    public func pulse(_ platform: Platform, _ name: String, _ ts: Int,
                      meetingId: String = "", participantId: String = "", source: String? = nil) {
        let cleaned = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.isEmpty { return }

        let pid = participantId.isEmpty ? "\(platform.rawValue)::\(cleaned)" : participantId
        let ctx = SpeechContext(meetingId: meetingId, participantId: pid, source: source)
        let key = pid
        if var existing = sessions[key] {
            // Guard against clock weirdness; never move lastSeen backwards.
            existing.lastSeenTs = max(existing.lastSeenTs, ts)
            existing.ctx = ctx   // last-seen-wins for the source attribution
            sessions[key] = existing
            return
        }

        sessions[key] = ActiveSession(platform: platform, name: cleaned, startTs: ts, lastSeenTs: ts, ctx: ctx)
        emit(.start(platform: platform, name: cleaned, startTs: ts, ctx: ctx))
    }

    /// Advance the clock: close sessions that have been silent for longer than
    /// `endSilenceMs` and emit a live tick for each session still active.
    public func update(_ now: Int) {
        for (key, s) in Array(sessions) {
            if now - s.lastSeenTs > opts.endSilenceMs {
                sessions.removeValue(forKey: key)
                emit(endEvent(s))
            } else {
                emit(.tick(platform: s.platform, name: s.name, startTs: s.startTs, durationMs: durationOf(s), ctx: s.ctx))
            }
        }
    }

    /// Close every active session immediately (e.g. on shutdown or window lost).
    public func endAll() {
        for (key, s) in Array(sessions) {
            sessions.removeValue(forKey: key)
            emit(endEvent(s))
        }
    }

    public var activeCount: Int { sessions.count }

    private func durationOf(_ s: ActiveSession) -> Int {
        s.lastSeenTs - s.startTs + opts.pulseWidthMs
    }

    private func endEvent(_ s: ActiveSession) -> TrackerEvent {
        let durationMs = durationOf(s)
        return .end(platform: s.platform,
                    name: s.name,
                    startTs: s.startTs,
                    endTs: s.startTs + durationMs,
                    durationMs: durationMs,
                    ctx: s.ctx)
    }
}
