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

/// Mirrors `SpeakerStart | SpeakerTick | SpeakerEnd`.
public enum TrackerEvent: Sendable {
    case start(platform: Platform, name: String, startTs: Int)
    case tick(platform: Platform, name: String, startTs: Int, durationMs: Int)
    case end(platform: Platform, name: String, startTs: Int, endTs: Int, durationMs: Int)
}

/// Everything the UI layer can receive. Mirrors `AppEvent`.
public enum AppEvent: Sendable {
    case tracker(TrackerEvent)
    case windows(EngineWindows)
    case status(EngineStatus)
}
