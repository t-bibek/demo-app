import { Platform, TrackerEvent } from './types';

export interface TrackerOptions {
  /**
   * How long a speaker can go unseen (no pulses) before their session is
   * considered finished. Should be a few engine poll intervals so indicator
   * flicker does not split one utterance into many sessions.
   */
  endSilenceMs: number;
  /**
   * Approximate width of one engine poll. A speaker seen in exactly one poll
   * spoke for roughly this long, so it is added to lastSeen - start when
   * computing durations.
   */
  pulseWidthMs: number;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  endSilenceMs: 2000,
  pulseWidthMs: 500,
};

interface ActiveSession {
  platform: Platform;
  name: string;
  startTs: number;
  lastSeenTs: number;
}

/**
 * Aggregates "name X is speaking right now" pulses (one per engine poll) into
 * speaking sessions with a start time and duration.
 *
 * Time is always passed in explicitly so the class is deterministic and
 * testable; callers drive it with Date.now().
 */
export class SessionTracker {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly opts: TrackerOptions;

  constructor(
    private readonly emit: (event: TrackerEvent) => void,
    opts: Partial<TrackerOptions> = {},
  ) {
    this.opts = { ...DEFAULT_TRACKER_OPTIONS, ...opts };
  }

  /** Report that `name` was observed speaking on `platform` at time `ts`. */
  pulse(platform: Platform, name: string, ts: number): void {
    const cleaned = name.trim();
    if (!cleaned) return;

    const key = `${platform}::${cleaned}`;
    const existing = this.sessions.get(key);
    if (existing) {
      // Guard against clock weirdness; never move lastSeen backwards.
      existing.lastSeenTs = Math.max(existing.lastSeenTs, ts);
      return;
    }

    const session: ActiveSession = { platform, name: cleaned, startTs: ts, lastSeenTs: ts };
    this.sessions.set(key, session);
    this.emit({ type: 'speaker-start', platform, name: cleaned, startTs: ts });
  }

  /**
   * Advance the clock: close sessions that have been silent for longer than
   * endSilenceMs and emit a live tick for each session still active.
   */
  update(now: number): void {
    for (const [key, s] of this.sessions) {
      if (now - s.lastSeenTs > this.opts.endSilenceMs) {
        this.sessions.delete(key);
        this.emit(this.endEvent(s));
      } else {
        this.emit({
          type: 'speaker-tick',
          platform: s.platform,
          name: s.name,
          startTs: s.startTs,
          durationMs: this.durationOf(s),
        });
      }
    }
  }

  /** Close every active session immediately (e.g. on shutdown or window lost). */
  endAll(): void {
    for (const [key, s] of this.sessions) {
      this.sessions.delete(key);
      this.emit(this.endEvent(s));
    }
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  private durationOf(s: ActiveSession): number {
    return s.lastSeenTs - s.startTs + this.opts.pulseWidthMs;
  }

  private endEvent(s: ActiveSession): TrackerEvent {
    const durationMs = this.durationOf(s);
    return {
      type: 'speaker-end',
      platform: s.platform,
      name: s.name,
      startTs: s.startTs,
      endTs: s.startTs + durationMs,
      durationMs,
    };
  }
}
