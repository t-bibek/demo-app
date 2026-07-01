import Foundation

/// Meeting platforms supported by the detector. Mirrors `Platform` in the
/// original `src/shared/types.ts`.
public enum Platform: String, Codable, CaseIterable, Sendable {
    case meet
    case zoom
    case teams

    /// Human-facing label (was `PLATFORM_LABELS`).
    public var label: String {
        switch self {
        case .meet: return "Google Meet"
        case .zoom: return "Zoom"
        case .teams: return "Microsoft Teams"
        }
    }
}

/// Epoch milliseconds — the original used JS `Date.now()` (a number of ms),
/// so we keep the same unit throughout to preserve the timing math.
public func nowMs() -> Int {
    Int(Date().timeIntervalSince1970 * 1000.0)
}

// MARK: - Engine events (was the NDJSON emitted by engine/uia-engine.ps1)

/// One poll tick observed a meeting window; `speakers` are the names speaking
/// right now. Mirrors `EnginePulse`.
public struct EnginePulse: Sendable {
    public var platform: Platform
    /// Names currently detected as speaking (may be several at once).
    public var speakers: [String]
    /// Participant names visible in the window, when cheaply available.
    public var participants: [String]?
    /// Title of the meeting window the pulse came from.
    public var windowTitle: String?
    /// Engine-side epoch milliseconds.
    public var ts: Int
    /// Which detection strategy produced this (tile-label, audio, generic...).
    public var source: String?

    public init(platform: Platform,
                speakers: [String],
                participants: [String]? = nil,
                windowTitle: String? = nil,
                ts: Int,
                source: String? = nil) {
        self.platform = platform
        self.speakers = speakers
        self.participants = participants
        self.windowTitle = windowTitle
        self.ts = ts
        self.source = source
    }
}

/// Metadata for one meeting window the engine can see. Mirrors an entry of
/// `EngineWindows.windows`.
public struct EngineWindowInfo: Codable, Sendable, Identifiable, Hashable {
    public var platform: Platform
    public var title: String
    /// Number of accessibility nodes scanned.
    public var nodeCount: Int
    /// False when a browser/WebView window's accessibility tree is empty
    /// (names unavailable; audio-based detection still works). Native Zoom's
    /// tiny tree is normal and reports true.
    public var treeOk: Bool?
    /// Current output audio peak (0..1) attributed to this window.
    public var audioPeak: Double?

    public var id: String { "\(platform.rawValue)::\(title)" }

    public init(platform: Platform,
                title: String,
                nodeCount: Int,
                treeOk: Bool? = nil,
                audioPeak: Double? = nil) {
        self.platform = platform
        self.title = title
        self.nodeCount = nodeCount
        self.treeOk = treeOk
        self.audioPeak = audioPeak
    }
}

/// Periodic snapshot of which meeting windows the engine can see.
public struct EngineWindows: Sendable {
    public var windows: [EngineWindowInfo]
    public var ts: Int
    public init(windows: [EngineWindowInfo], ts: Int) {
        self.windows = windows
        self.ts = ts
    }
}

public enum StatusLevel: String, Codable, Sendable {
    case info, warn, error
}

/// Engine lifecycle / diagnostics. Mirrors `EngineStatus`.
public struct EngineStatus: Sendable, Identifiable {
    public let id = UUID()
    public var level: StatusLevel
    public var message: String
    public var ts: Int
    public init(level: StatusLevel, message: String, ts: Int) {
        self.level = level
        self.message = message
        self.ts = ts
    }
}

// MARK: - Tracker events (produced by SessionTracker)

/// Identity + attribution carried by every speech event. Bundled into one
/// payload so adding fields later does not churn the `TrackerEvent` signature.
public struct SpeechContext: Sendable, Equatable, Hashable {
    /// Stable meeting id this utterance belongs to (see `meetingId(platform:url:title:)`).
    public var meetingId: String
    /// Deterministic participant id (see `participantId(meetingId:name:)`).
    public var participantId: String
    /// How the speaker was attributed this utterance — e.g. `"meet.geometry"`,
    /// `"zoom.mute_gate"`, `"audio.someone"`. Auditable, Recall-style telemetry.
    public var source: String?

    public init(meetingId: String = "", participantId: String = "", source: String? = nil) {
        self.meetingId = meetingId
        self.participantId = participantId
        self.source = source
    }
}

/// Mirrors `SpeakerStart | SpeakerTick | SpeakerEnd`. The trailing `SpeechContext`
/// carries the Recall-style meeting/participant/source identity.
public enum TrackerEvent: Sendable {
    case start(platform: Platform, name: String, startTs: Int, ctx: SpeechContext)
    case tick(platform: Platform, name: String, startTs: Int, durationMs: Int, ctx: SpeechContext)
    case end(platform: Platform, name: String, startTs: Int, endTs: Int, durationMs: Int, ctx: SpeechContext)
}

// MARK: - Meeting & participant model (Recall-style event layer)

/// One participant in a meeting roster. The flags are THREE-STATE: `nil` means
/// "the AX tree didn't expose it this scan". `MeetingStateTracker` keeps the last
/// known value *sticky* across nil reads rather than churning `participantUpdated`.
public struct MeetingParticipant: Codable, Sendable, Identifiable, Hashable {
    /// Deterministic id = `"<meetingId>::<normalized name>"` — no real per-user
    /// DOM id is exposed by AX. See `participantId(meetingId:name:)`.
    public var id: String
    public var name: String
    public var isLocal: Bool?
    public var isMuted: Bool?
    public var isSpeaking: Bool?

    public init(id: String, name: String,
                isLocal: Bool? = nil, isMuted: Bool? = nil, isSpeaking: Bool? = nil) {
        self.id = id
        self.name = name
        self.isLocal = isLocal
        self.isMuted = isMuted
        self.isSpeaking = isSpeaking
    }
}

/// A meeting as seen in one scan tick: its stable id, platform, window title, and
/// current roster. Fed to `MeetingStateTracker`, which diffs it across ticks.
public struct MeetingSnapshot: Codable, Sendable, Identifiable, Hashable {
    public var id: String
    public var platform: Platform
    public var title: String
    /// Meeting URL from the browser address bar when available (nil for PWAs /
    /// native apps, whose AX tree exposes no address bar).
    public var url: String?
    public var participants: [MeetingParticipant]
    public var startedAt: Int
    public var updatedAt: Int

    public init(id: String, platform: Platform, title: String, url: String? = nil,
                participants: [MeetingParticipant], startedAt: Int, updatedAt: Int) {
        self.id = id
        self.platform = platform
        self.title = title
        self.url = url
        self.participants = participants
        self.startedAt = startedAt
        self.updatedAt = updatedAt
    }
}

/// Recall-style meeting + participant lifecycle, produced by `MeetingStateTracker`.
public enum MeetingEvent: Sendable {
    case meetingInitialized(MeetingSnapshot)
    case meetingUpdated(MeetingSnapshot)
    case meetingEnded(meetingId: String, ts: Int)
    case participantJoined(meetingId: String, participant: MeetingParticipant, ts: Int)
    case participantUpdated(meetingId: String, participant: MeetingParticipant, ts: Int)
    case participantLeft(meetingId: String, participantId: String, name: String, ts: Int)
}

/// Everything the UI layer can receive. Mirrors `AppEvent`.
public enum AppEvent: Sendable {
    case tracker(TrackerEvent)
    case windows(EngineWindows)
    case status(EngineStatus)
    case meeting(MeetingEvent)
}
