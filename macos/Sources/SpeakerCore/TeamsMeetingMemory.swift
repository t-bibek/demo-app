import Foundation

/// Per-Teams-meeting memory so a call SURVIVES its window becoming unreadable.
///
/// When Teams is backgrounded — or the user navigates to Chat/another Teams
/// section — the meeting's Chromium WebView2 THROTTLES: the deep AX tree comes
/// back empty (no tiles, no roster, no "Leave" button), so a naive scan would
/// drop the window and the meeting would age out, losing the roster and the
/// speaker timeline. But the WINDOW itself still exists and its TITLE
/// ("Meeting with … | Microsoft Teams") stays readable, which yields a STABLE
/// `meetingId`. So we remember, per meetingId, the last time it was READABLE plus
/// its last-known roster/participants (and the owning pid, for telemetry). While a
/// window is throttled we keep the meeting alive from this memory; the instant it
/// is reachable again the live ring/roster take over.
///
/// Pure + time-injected (INV-6 style) so it is unit-testable without AppKit/AX.
public struct TeamsMeetingMemory: Sendable {
    public struct Entry: Sendable, Equatable {
        public var roster: [ZoomRosterEntry]
        public var participants: [String]
        public var lastReadableMs: Int
        public var pid: Int32?
        public init(roster: [ZoomRosterEntry], participants: [String], lastReadableMs: Int, pid: Int32?) {
            self.roster = roster
            self.participants = participants
            self.lastReadableMs = lastReadableMs
            self.pid = pid
        }
    }

    private var entries: [String: Entry] = [:]
    public init() {}

    /// Record a READABLE observation of a meeting (has tiles/roster this tick).
    public mutating func observeReadable(meetingId: String, roster: [ZoomRosterEntry],
                                         participants: [String], pid: Int32?, nowMs: Int) {
        entries[meetingId] = Entry(roster: roster, participants: participants,
                                   lastReadableMs: nowMs, pid: pid)
    }

    public func entry(_ meetingId: String) -> Entry? { entries[meetingId] }

    /// The meetingIds seen readable within `ttlMs` — the set the scanner keeps
    /// alive while their windows are throttled (their titles still resolve to
    /// these ids). Bounded by the TTL so a call that genuinely ended (window
    /// closed, never seen again) eventually clears instead of persisting forever.
    public func activeIds(nowMs: Int, ttlMs: Int) -> Set<String> {
        Set(entries.filter { nowMs - $0.value.lastReadableMs <= ttlMs }.keys)
    }

    /// Drop entries whose last readable observation is older than `maxAgeMs`, so
    /// memory can't grow unbounded across a long session.
    public mutating func prune(nowMs: Int, maxAgeMs: Int) {
        entries = entries.filter { nowMs - $0.value.lastReadableMs <= maxAgeMs }
    }

    public var count: Int { entries.count }
}
