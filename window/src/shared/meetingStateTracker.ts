import {
  MeetingEvent,
  MeetingParticipant,
  MeetingSnapshot,
  Platform,
} from './types';

export interface MeetingStateOptions {
  /**
   * How long a participant/meeting may go unseen before it is considered gone.
   * A few engine poll intervals, like `SessionTracker.endSilenceMs`.
   */
  graceMs: number;
}

export const DEFAULT_MEETING_STATE_OPTIONS: MeetingStateOptions = {
  graceMs: 4000,
};

interface ParticipantState {
  participant: MeetingParticipant;
  lastSeenTs: number;
}

interface MeetingState {
  platform: Platform;
  title: string;
  url?: string;
  participants: Map<string, ParticipantState>;
  startedAt: number;
  lastSeenTs: number;
}

/**
 * Turns per-tick `MeetingSnapshot`s into Recall-style meeting + participant
 * lifecycle events (`meeting_initialized/updated/ended`,
 * `participant_joined/updated/left`). Ported from the macOS port's
 * `MeetingStateTracker.swift`.
 *
 * Same discipline as `SessionTracker`: pure, deterministic, time is always
 * passed in explicitly, output goes through an `emit` callback — no I/O. A grace
 * period absorbs detection flicker so a participant momentarily missing from one
 * scan does not churn leave/join, and a brief empty/unreadable tree does not end
 * the meeting.
 */
export class MeetingStateTracker {
  private readonly meetings = new Map<string, MeetingState>();
  private readonly opts: MeetingStateOptions;

  constructor(
    private readonly emit: (event: MeetingEvent) => void,
    opts: Partial<MeetingStateOptions> = {},
  ) {
    this.opts = { ...DEFAULT_MEETING_STATE_OPTIONS, ...opts };
  }

  /**
   * Observe the meetings visible this tick. Pass `[]` when no meeting is visible
   * so open meetings age out and emit `meeting_ended`.
   */
  observe(snapshots: MeetingSnapshot[], now: number): void {
    const merged = MeetingStateTracker.mergeById(snapshots);

    for (const [mid, snap] of merged) {
      if (!this.meetings.has(mid)) this.initMeeting(mid, snap, now);
      else this.diffMeeting(mid, snap, now);
    }

    // Meetings not seen at all this tick: end them once past the grace window.
    for (const [mid, st] of this.meetings) {
      if (!merged.has(mid) && now - st.lastSeenTs > this.opts.graceMs) {
        this.endMeeting(mid, now);
      }
    }
  }

  /** Close every open meeting immediately (engine stop / shutdown). */
  endAll(now: number): void {
    for (const mid of [...this.meetings.keys()]) this.endMeeting(mid, now);
  }

  get meetingCount(): number {
    return this.meetings.size;
  }

  // Lifecycle transitions ----------------------------------------------------

  private initMeeting(mid: string, snap: MeetingSnapshot, now: number): void {
    const st: MeetingState = {
      platform: snap.platform,
      title: snap.title,
      url: snap.url,
      participants: new Map(),
      startedAt: now,
      lastSeenTs: now,
    };
    for (const p of snap.participants) st.participants.set(p.id, { participant: p, lastSeenTs: now });
    this.meetings.set(mid, st);

    this.emit({ type: 'meeting_initialized', meeting: this.snapshot(mid, now) });
    for (const p of snap.participants) {
      this.emit({ type: 'participant_joined', meetingId: mid, participant: p, ts: now });
    }
  }

  private diffMeeting(mid: string, snap: MeetingSnapshot, now: number): void {
    const st = this.meetings.get(mid);
    if (!st) return;
    st.lastSeenTs = now;

    // Empty/unreadable tree -> "no info this tick", NOT "everyone left". Keep the
    // known roster alive and only refresh the title.
    if (snap.participants.length === 0) {
      for (const ps of st.participants.values()) ps.lastSeenTs = now;
      let titleChanged = false;
      if (snap.title && st.title !== snap.title) {
        st.title = snap.title;
        titleChanged = true;
      }
      if (snap.url && st.url !== snap.url) st.url = snap.url; // refresh silently
      if (titleChanged) this.emit({ type: 'meeting_updated', meeting: this.snapshot(mid, now) });
      return;
    }

    let changed = false;
    const incomingIds = new Set(snap.participants.map((p) => p.id));

    // Joins + flag updates.
    for (const p of snap.participants) {
      const existing = st.participants.get(p.id);
      if (existing) {
        existing.lastSeenTs = now;
        const merged = MeetingStateTracker.mergeSticky(existing.participant, p);
        if (MeetingStateTracker.flagsChanged(existing.participant, merged)) {
          this.emit({ type: 'participant_updated', meetingId: mid, participant: merged, ts: now });
          changed = true;
        }
        existing.participant = merged; // silently refresh isSpeaking etc.
      } else {
        st.participants.set(p.id, { participant: p, lastSeenTs: now });
        this.emit({ type: 'participant_joined', meetingId: mid, participant: p, ts: now });
        changed = true;
      }
    }

    // Leaves: present in state, absent from this tick, past the grace window.
    for (const [pid, ps] of [...st.participants]) {
      if (!incomingIds.has(pid) && now - ps.lastSeenTs > this.opts.graceMs) {
        st.participants.delete(pid);
        this.emit({ type: 'participant_left', meetingId: mid, participantId: pid, name: ps.participant.name, ts: now });
        changed = true;
      }
    }

    if (st.title !== snap.title) {
      st.title = snap.title;
      changed = true;
    }
    if (snap.url && st.url !== snap.url) st.url = snap.url; // refresh silently

    if (changed) this.emit({ type: 'meeting_updated', meeting: this.snapshot(mid, now) });
  }

  private endMeeting(mid: string, now: number): void {
    const st = this.meetings.get(mid);
    if (!st) return;
    for (const [pid, ps] of st.participants) {
      this.emit({ type: 'participant_left', meetingId: mid, participantId: pid, name: ps.participant.name, ts: now });
    }
    this.meetings.delete(mid);
    this.emit({ type: 'meeting_ended', meetingId: mid, ts: now });
  }

  // Helpers ------------------------------------------------------------------

  /** Build a full snapshot of a meeting's current tracked state. */
  private snapshot(mid: string, now: number): MeetingSnapshot {
    const st = this.meetings.get(mid)!;
    const participants = [...st.participants.values()]
      .map((ps) => ps.participant)
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return {
      id: mid,
      platform: st.platform,
      title: st.title,
      url: st.url,
      participants,
      startedAt: st.startedAt,
      updatedAt: now,
    };
  }

  /**
   * Merge incoming flags over known state: an `undefined` incoming flag keeps the
   * last known value (sticky) so a flaky read doesn't blank a participant's state.
   */
  private static mergeSticky(old: MeetingParticipant, next: MeetingParticipant): MeetingParticipant {
    return {
      id: next.id,
      name: next.name || old.name,
      isLocal: next.isLocal ?? old.isLocal,
      isMuted: next.isMuted ?? old.isMuted,
      isSpeaking: next.isSpeaking ?? old.isSpeaking,
    };
  }

  /**
   * A `participant_updated` only fires on a *definite* is-local / mute flip. NOT on
   * `name`: both sides share the participant id, and the id IS the normalized name,
   * so any name difference here is purely cosmetic — the same person surfacing as
   * "bibek thapa" (tile caption) one tick and "Bibek Thapa" (panel) the next.
   * Emitting on that churns endless participant_updated / meeting_updated (seen live
   * in Meet PIP). A genuine rename changes the id and so reads as leave+join. Also
   * NOT on `isSpeaking` (covered by speech_on/off) or undefined transitions (unknown
   * is sticky, never a "change").
   */
  private static flagsChanged(a: MeetingParticipant, b: MeetingParticipant): boolean {
    return a.isLocal !== b.isLocal || a.isMuted !== b.isMuted;
  }

  /**
   * Merge snapshots that share a meeting id within one tick (e.g. the same Meet
   * open in two tabs / a healthy window + a backgrounded empty one).
   */
  private static mergeById(snaps: MeetingSnapshot[]): Map<string, MeetingSnapshot> {
    const out = new Map<string, MeetingSnapshot>();
    for (const s of snaps) {
      const existing = out.get(s.id);
      if (!existing) {
        out.set(s.id, s);
        continue;
      }
      const byId = new Map<string, MeetingParticipant>();
      for (const p of existing.participants) byId.set(p.id, p);
      for (const p of s.participants) {
        const cur = byId.get(p.id);
        if (cur) {
          byId.set(p.id, {
            id: p.id,
            name: cur.name || p.name,
            isLocal: cur.isLocal ?? p.isLocal,
            isMuted: cur.isMuted ?? p.isMuted,
            isSpeaking: (cur.isSpeaking ?? false) || (p.isSpeaking ?? false),
          });
        } else {
          byId.set(p.id, p);
        }
      }
      out.set(s.id, {
        ...existing,
        title: existing.title || s.title,
        participants: [...byId.values()],
      });
    }
    return out;
  }
}
