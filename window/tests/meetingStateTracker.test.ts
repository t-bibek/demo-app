import { describe, expect, it } from 'vitest';
import { MeetingStateTracker } from '../src/shared/meetingStateTracker';
import { MeetingEvent, MeetingParticipant, MeetingSnapshot, Platform } from '../src/shared/types';

const GRACE = 4000;

function makeTracker() {
  const events: MeetingEvent[] = [];
  const tracker = new MeetingStateTracker((e) => events.push(e), { graceMs: GRACE });
  return { tracker, events };
}

const only = (events: MeetingEvent[], type: MeetingEvent['type']) => events.filter((e) => e.type === type);

function p(id: string, name: string, flags: Partial<MeetingParticipant> = {}): MeetingParticipant {
  return { id, name, ...flags };
}

function snap(
  id: string,
  participants: MeetingParticipant[],
  extra: Partial<MeetingSnapshot> = {},
): MeetingSnapshot {
  return {
    id,
    platform: (extra.platform ?? 'meet') as Platform,
    title: extra.title ?? 'Standup',
    url: extra.url,
    participants,
    startedAt: 0,
    updatedAt: 0,
  };
}

describe('MeetingStateTracker', () => {
  it('emits meeting_initialized + a join per participant on first sight', () => {
    const { tracker, events } = makeTracker();
    tracker.observe([snap('m', [p('a', 'Alice'), p('b', 'Bob')])], 0);

    expect(only(events, 'meeting_initialized')).toHaveLength(1);
    expect(only(events, 'participant_joined')).toHaveLength(2);
    expect(tracker.meetingCount).toBe(1);
  });

  it('emits participant_joined for a newcomer on a later tick', () => {
    const { tracker, events } = makeTracker();
    tracker.observe([snap('m', [p('a', 'Alice')])], 0);
    events.length = 0;
    tracker.observe([snap('m', [p('a', 'Alice'), p('c', 'Carol')])], 1000);

    const joins = only(events, 'participant_joined');
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({ participant: { name: 'Carol' } });
  });

  it('does not churn leave/join for a one-tick flicker within the grace window', () => {
    const { tracker, events } = makeTracker();
    tracker.observe([snap('m', [p('a', 'Alice'), p('b', 'Bob')])], 0);
    tracker.observe([snap('m', [p('a', 'Alice')])], 1000); // Bob blips out
    tracker.observe([snap('m', [p('a', 'Alice'), p('b', 'Bob')])], 2000); // ...and back

    expect(only(events, 'participant_left')).toHaveLength(0);
  });

  it('emits participant_left once a participant is gone past the grace window', () => {
    const { tracker, events } = makeTracker();
    tracker.observe([snap('m', [p('a', 'Alice'), p('b', 'Bob')])], 0);
    events.length = 0;
    tracker.observe([snap('m', [p('a', 'Alice')])], GRACE + 1000);

    const left = only(events, 'participant_left');
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ name: 'Bob' });
  });

  it('emits exactly one participant_updated on a definite mute flip', () => {
    const { tracker, events } = makeTracker();
    tracker.observe([snap('m', [p('a', 'Alice', { isMuted: false })])], 0);
    events.length = 0;
    tracker.observe([snap('m', [p('a', 'Alice', { isMuted: true })])], 500);
    tracker.observe([snap('m', [p('a', 'Alice', { isMuted: true })])], 1000); // no further change

    expect(only(events, 'participant_updated')).toHaveLength(1);
  });

  it('treats an undefined flag read as sticky, not a change', () => {
    const { tracker, events } = makeTracker();
    tracker.observe([snap('m', [p('a', 'Alice', { isMuted: false })])], 0);
    events.length = 0;
    tracker.observe([snap('m', [p('a', 'Alice', {})])], 500); // mute unreadable this scan

    expect(only(events, 'participant_updated')).toHaveLength(0);
  });

  it('does not emit participant_updated on an isSpeaking flip (speech events cover it)', () => {
    const { tracker, events } = makeTracker();
    tracker.observe([snap('m', [p('a', 'Alice', { isMuted: false, isSpeaking: false })])], 0);
    events.length = 0;
    tracker.observe([snap('m', [p('a', 'Alice', { isMuted: false, isSpeaking: true })])], 500);

    expect(only(events, 'participant_updated')).toHaveLength(0);
  });

  it('merges two snapshots that share a meeting id within one tick', () => {
    const { tracker, events } = makeTracker();
    tracker.observe([snap('m', [p('a', 'Alice')]), snap('m', [p('b', 'Bob')])], 0);

    expect(only(events, 'meeting_initialized')).toHaveLength(1);
    expect(only(events, 'participant_joined')).toHaveLength(2);
    expect(tracker.meetingCount).toBe(1);
  });

  it('treats an empty-roster tick as "no info", keeping the meeting and roster alive', () => {
    const { tracker, events } = makeTracker();
    tracker.observe([snap('m', [p('a', 'Alice'), p('b', 'Bob')])], 0);
    events.length = 0;
    tracker.observe([snap('m', [])], 1000); // unreadable tree, not "everyone left"

    expect(only(events, 'participant_left')).toHaveLength(0);
    expect(only(events, 'meeting_ended')).toHaveLength(0);
    expect(tracker.meetingCount).toBe(1);
  });

  it('ends a meeting (with leaves) once it is unseen past the grace window', () => {
    const { tracker, events } = makeTracker();
    tracker.observe([snap('m', [p('a', 'Alice')])], 0);
    events.length = 0;
    tracker.observe([], GRACE + 1000); // call hung up -> no pulses

    expect(only(events, 'participant_left')).toHaveLength(1);
    expect(only(events, 'meeting_ended')).toHaveLength(1);
    expect(tracker.meetingCount).toBe(0);
  });

  it('endAll closes every open meeting', () => {
    const { tracker, events } = makeTracker();
    tracker.observe([snap('m1', [p('a', 'Alice')]), snap('m2', [p('b', 'Bob')])], 0);
    events.length = 0;
    tracker.endAll(5000);

    expect(only(events, 'meeting_ended')).toHaveLength(2);
    expect(tracker.meetingCount).toBe(0);
  });
});
