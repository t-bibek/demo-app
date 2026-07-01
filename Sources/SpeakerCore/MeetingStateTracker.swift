import Foundation

/// Turns per-tick `MeetingSnapshot`s into Recall-style meeting + participant
/// lifecycle events (`meetingInitialized/Updated/Ended`,
/// `participantJoined/Updated/Left`).
///
/// Same discipline as `SessionTracker`: pure, deterministic, time is always
/// passed in explicitly, output goes through an `emit` closure — no I/O. A grace
/// period absorbs AX flicker so a participant momentarily missing from one scan
/// does not churn leave/join, and a brief empty/unreadable tree does not end the
/// meeting.
public final class MeetingStateTracker {

    public struct Options: Sendable {
        /// How long a participant/meeting may go unseen before it is considered
        /// gone. A few engine poll intervals, like `SessionTracker.endSilenceMs`.
        public var graceMs: Int
        public init(graceMs: Int = 4000) { self.graceMs = graceMs }
    }

    private struct ParticipantState {
        var participant: MeetingParticipant
        var lastSeenTs: Int
    }

    private struct MeetingState {
        var platform: Platform
        var title: String
        var url: String?
        var participants: [String: ParticipantState]
        var startedAt: Int
        var lastSeenTs: Int
    }

    private var meetings: [String: MeetingState] = [:]
    private let opts: Options
    private let emit: (MeetingEvent) -> Void

    public init(opts: Options = Options(), emit: @escaping (MeetingEvent) -> Void) {
        self.opts = opts
        self.emit = emit
    }

    /// Observe the meetings visible this tick. Pass `[]` when no meeting is
    /// visible so open meetings age out and emit `meetingEnded`.
    public func observe(_ snapshots: [MeetingSnapshot], _ now: Int) {
        let merged = Self.mergeById(snapshots)
        let seenIds = Set(merged.keys)

        for (mid, snap) in merged {
            if meetings[mid] == nil {
                initMeeting(mid, snap, now)
            } else {
                diffMeeting(mid, snap, now)
            }
        }

        // Meetings not seen at all this tick: end them once past the grace window.
        for (mid, st) in meetings where !seenIds.contains(mid) {
            if now - st.lastSeenTs > opts.graceMs {
                endMeeting(mid, now)
            }
        }
    }

    /// Close every open meeting immediately (engine stop / shutdown).
    public func endAll(_ now: Int) {
        for mid in Array(meetings.keys) { endMeeting(mid, now) }
    }

    public var meetingCount: Int { meetings.count }

    // MARK: Lifecycle transitions

    private func initMeeting(_ mid: String, _ snap: MeetingSnapshot, _ now: Int) {
        var st = MeetingState(platform: snap.platform, title: snap.title, url: snap.url,
                              participants: [:], startedAt: now, lastSeenTs: now)
        for p in snap.participants {
            st.participants[p.id] = ParticipantState(participant: p, lastSeenTs: now)
        }
        meetings[mid] = st
        emit(.meetingInitialized(snapshot(of: mid, now: now)))
        for p in snap.participants {
            emit(.participantJoined(meetingId: mid, participant: p, ts: now))
        }
    }

    private func diffMeeting(_ mid: String, _ snap: MeetingSnapshot, _ now: Int) {
        guard var st = meetings[mid] else { return }
        st.lastSeenTs = now

        // Empty/unreadable tree → "no info this tick", NOT "everyone left". Keep
        // the known roster alive and only refresh the title.
        if snap.participants.isEmpty {
            for k in st.participants.keys { st.participants[k]?.lastSeenTs = now }
            var changed = false
            if !snap.title.isEmpty, st.title != snap.title { st.title = snap.title; changed = true }
            if let u = snap.url, st.url != u { st.url = u }   // refresh silently
            meetings[mid] = st
            if changed { emit(.meetingUpdated(snapshot(of: mid, now: now))) }
            return
        }

        var changed = false
        let incomingIds = Set(snap.participants.map { $0.id })

        // Joins + flag updates.
        for p in snap.participants {
            if var existing = st.participants[p.id] {
                existing.lastSeenTs = now
                let merged = Self.mergeSticky(old: existing.participant, new: p)
                if Self.flagsChanged(existing.participant, merged) {
                    emit(.participantUpdated(meetingId: mid, participant: merged, ts: now))
                    changed = true
                }
                existing.participant = merged   // silently refresh isSpeaking etc.
                st.participants[p.id] = existing
            } else {
                st.participants[p.id] = ParticipantState(participant: p, lastSeenTs: now)
                emit(.participantJoined(meetingId: mid, participant: p, ts: now))
                changed = true
            }
        }

        // Leaves: present in state, absent from this tick, past the grace window.
        for (pid, ps) in st.participants where !incomingIds.contains(pid) {
            if now - ps.lastSeenTs > opts.graceMs {
                st.participants.removeValue(forKey: pid)
                emit(.participantLeft(meetingId: mid, participantId: pid, name: ps.participant.name, ts: now))
                changed = true
            }
        }

        if st.title != snap.title { st.title = snap.title; changed = true }
        if let u = snap.url, st.url != u { st.url = u }   // refresh silently

        meetings[mid] = st
        if changed { emit(.meetingUpdated(snapshot(of: mid, now: now))) }
    }

    private func endMeeting(_ mid: String, _ now: Int) {
        guard let st = meetings[mid] else { return }
        for (pid, ps) in st.participants {
            emit(.participantLeft(meetingId: mid, participantId: pid, name: ps.participant.name, ts: now))
        }
        meetings.removeValue(forKey: mid)
        emit(.meetingEnded(meetingId: mid, ts: now))
    }

    // MARK: Helpers

    /// Build a full snapshot of a meeting's current tracked state.
    private func snapshot(of mid: String, now: Int) -> MeetingSnapshot {
        let st = meetings[mid]!
        let parts = st.participants.values
            .map { $0.participant }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        return MeetingSnapshot(id: mid, platform: st.platform, title: st.title, url: st.url,
                               participants: parts, startedAt: st.startedAt, updatedAt: now)
    }

    /// Merge incoming flags over known state: a `nil` incoming flag keeps the last
    /// known value (sticky) so a flaky read doesn't blank a participant's state.
    private static func mergeSticky(old: MeetingParticipant, new: MeetingParticipant) -> MeetingParticipant {
        MeetingParticipant(
            id: new.id,
            name: new.name.isEmpty ? old.name : new.name,
            isLocal: new.isLocal ?? old.isLocal,
            isMuted: new.isMuted ?? old.isMuted,
            isSpeaking: new.isSpeaking ?? old.isSpeaking
        )
    }

    /// A `participantUpdated` only fires on a *definite* identity/mute flip —
    /// NOT on `isSpeaking` (that's covered by speech_on/off) and NOT on
    /// transitions to/from `nil` (unknown is sticky, never a "change").
    private static func flagsChanged(_ a: MeetingParticipant, _ b: MeetingParticipant) -> Bool {
        a.name != b.name || a.isLocal != b.isLocal || a.isMuted != b.isMuted
    }

    /// Merge snapshots that share a meeting id within one tick (e.g. the same
    /// Meet open in two tabs / a healthy window + a backgrounded empty one).
    private static func mergeById(_ snaps: [MeetingSnapshot]) -> [String: MeetingSnapshot] {
        var out: [String: MeetingSnapshot] = [:]
        for s in snaps {
            guard var existing = out[s.id] else { out[s.id] = s; continue }
            var byId = Dictionary(existing.participants.map { ($0.id, $0) },
                                  uniquingKeysWith: { a, _ in a })
            for p in s.participants {
                if let cur = byId[p.id] {
                    byId[p.id] = MeetingParticipant(
                        id: p.id,
                        name: cur.name.isEmpty ? p.name : cur.name,
                        isLocal: cur.isLocal ?? p.isLocal,
                        isMuted: cur.isMuted ?? p.isMuted,
                        isSpeaking: (cur.isSpeaking ?? false) || (p.isSpeaking ?? false))
                } else {
                    byId[p.id] = p
                }
            }
            existing.participants = Array(byId.values)
            if existing.title.isEmpty { existing.title = s.title }
            out[s.id] = existing
        }
        return out
    }
}
