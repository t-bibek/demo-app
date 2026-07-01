import { describe, expect, it } from 'vitest';
import { SessionTracker } from '../src/shared/sessionTracker';
import { TrackerEvent } from '../src/shared/types';

const OPTS = { endSilenceMs: 2000, pulseWidthMs: 500 };

function makeTracker() {
  const events: TrackerEvent[] = [];
  const tracker = new SessionTracker((e) => events.push(e), OPTS);
  return { tracker, events };
}

const only = (events: TrackerEvent[], type: TrackerEvent['type']) =>
  events.filter((e) => e.type === type);

describe('SessionTracker', () => {
  it('opens a session on first pulse and closes it after the silence window', () => {
    const { tracker, events } = makeTracker();

    tracker.pulse('zoom', 'Alice', 10_000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'speaker-start', platform: 'zoom', name: 'Alice', startTs: 10_000 });

    // Within the silence window: still active, emits a tick.
    tracker.update(11_000);
    expect(only(events, 'speaker-end')).toHaveLength(0);
    expect(only(events, 'speaker-tick')).toHaveLength(1);

    // Past the silence window: closes with duration = pulse width (single pulse).
    tracker.update(12_100);
    const ends = only(events, 'speaker-end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      platform: 'zoom',
      name: 'Alice',
      startTs: 10_000,
      durationMs: 500,
      endTs: 10_500,
    });
    expect(tracker.activeCount).toBe(0);
  });

  it('accumulates duration across continuous pulses', () => {
    const { tracker, events } = makeTracker();

    for (let t = 0; t <= 10_000; t += 500) {
      tracker.pulse('meet', 'Bob', 50_000 + t);
    }
    tracker.update(63_000);

    const ends = only(events, 'speaker-end');
    expect(ends).toHaveLength(1);
    // 10s of pulses + one pulse width.
    expect(ends[0]).toMatchObject({ name: 'Bob', durationMs: 10_500 });
    expect(only(events, 'speaker-start')).toHaveLength(1);
  });

  it('does not split a session on gaps shorter than endSilenceMs', () => {
    const { tracker, events } = makeTracker();

    tracker.pulse('teams', 'Carol', 0);
    tracker.update(1_500); // gap of 1.5s < 2s
    tracker.pulse('teams', 'Carol', 1_800);
    tracker.update(3_000);
    expect(only(events, 'speaker-end')).toHaveLength(0);

    tracker.update(4_000); // 2.2s after last pulse -> closes
    const ends = only(events, 'speaker-end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ startTs: 0, durationMs: 2_300 });
  });

  it('splits sessions on gaps longer than endSilenceMs', () => {
    const { tracker, events } = makeTracker();

    tracker.pulse('zoom', 'Dave', 0);
    tracker.update(2_500); // closes first session
    tracker.pulse('zoom', 'Dave', 5_000);
    tracker.update(8_000); // closes second session

    expect(only(events, 'speaker-start')).toHaveLength(2);
    expect(only(events, 'speaker-end')).toHaveLength(2);
  });

  it('tracks overlapping speakers independently, keyed by platform and name', () => {
    const { tracker, events } = makeTracker();

    tracker.pulse('zoom', 'Alice', 0);
    tracker.pulse('zoom', 'Bob', 200);
    tracker.pulse('meet', 'Alice', 300); // same name, other platform
    expect(only(events, 'speaker-start')).toHaveLength(3);
    expect(tracker.activeCount).toBe(3);

    tracker.update(3_000);
    expect(only(events, 'speaker-end')).toHaveLength(3);
  });

  it('emits growing tick durations for live sessions', () => {
    const { tracker, events } = makeTracker();

    tracker.pulse('meet', 'Eve', 0);
    tracker.pulse('meet', 'Eve', 1_000);
    tracker.update(1_100);
    tracker.pulse('meet', 'Eve', 1_500);
    tracker.update(1_600);

    const ticks = only(events, 'speaker-tick');
    expect(ticks).toHaveLength(2);
    expect(ticks.map((t) => (t.type === 'speaker-tick' ? t.durationMs : 0))).toEqual([
      1_500, 2_000,
    ]);
  });

  it('endAll closes every active session', () => {
    const { tracker, events } = makeTracker();

    tracker.pulse('zoom', 'Alice', 0);
    tracker.pulse('teams', 'Bob', 0);
    tracker.endAll();

    expect(only(events, 'speaker-end')).toHaveLength(2);
    expect(tracker.activeCount).toBe(0);
  });

  it('ignores blank names and trims whitespace', () => {
    const { tracker, events } = makeTracker();

    tracker.pulse('zoom', '   ', 0);
    tracker.pulse('zoom', '  Alice  ', 0);
    tracker.pulse('zoom', 'Alice', 500); // same person after trim

    expect(only(events, 'speaker-start')).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: 'Alice' });
    expect(tracker.activeCount).toBe(1);
  });

  it('never moves lastSeen backwards on out-of-order timestamps', () => {
    const { tracker, events } = makeTracker();

    tracker.pulse('zoom', 'Alice', 5_000);
    tracker.pulse('zoom', 'Alice', 4_000); // stale timestamp
    tracker.update(7_500);

    const ends = only(events, 'speaker-end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ durationMs: 500 });
  });

  it('carries the meeting/participant/source context on speech events', () => {
    const { tracker, events } = makeTracker();

    tracker.pulse('meet', 'Alice', 0, {
      meetingId: 'meet::abc-defg-hij',
      participantId: 'meet::abc-defg-hij::alice',
      source: 'meet-tiles',
    });
    tracker.update(3_000); // closes the session

    const start = only(events, 'speaker-start')[0];
    const end = only(events, 'speaker-end')[0];
    for (const e of [start, end]) {
      expect(e.ctx).toEqual({
        meetingId: 'meet::abc-defg-hij',
        participantId: 'meet::abc-defg-hij::alice',
        source: 'meet-tiles',
      });
    }
  });

  it('keys sessions by participantId, so one name in two meetings stays distinct', () => {
    const { tracker, events } = makeTracker();

    tracker.pulse('meet', 'Alice', 0, { meetingId: 'm1', participantId: 'm1::alice' });
    tracker.pulse('meet', 'Alice', 0, { meetingId: 'm2', participantId: 'm2::alice' });

    expect(only(events, 'speaker-start')).toHaveLength(2);
    expect(tracker.activeCount).toBe(2);
  });
});
