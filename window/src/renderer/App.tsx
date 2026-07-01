import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppEvent,
  EngineStatus,
  EngineWindows,
  MeetingSnapshot,
  PLATFORM_LABELS,
  Platform,
  SpeakerEnd,
  formatClock,
  formatDuration,
} from '../shared/types';

interface ActiveSpeaker {
  platform: Platform;
  name: string;
  startTs: number;
  durationMs: number;
}

type EventKind = 'meeting' | 'participant' | 'speech';

interface EventRow {
  id: number;
  ts: number;
  type: string;
  kind: EventKind;
  summary: string;
}

const MAX_LOG_ROWS = 500;
const MAX_STATUS_LINES = 8;
const MAX_EVENT_ROWS = 300;

export function App() {
  const [active, setActive] = useState<Map<string, ActiveSpeaker>>(new Map());
  const [sessions, setSessions] = useState<SpeakerEnd[]>([]);
  const [windows, setWindows] = useState<EngineWindows['windows']>([]);
  const [statuses, setStatuses] = useState<EngineStatus[]>([]);
  const [meetings, setMeetings] = useState<MeetingSnapshot[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const eventId = useRef(0);

  useEffect(() => {
    const logEvent = (ts: number, type: string, kind: EventKind, summary: string) => {
      setEvents((prev) => [{ id: eventId.current++, ts, type, kind, summary }, ...prev].slice(0, MAX_EVENT_ROWS));
    };
    const upsertMeeting = (m: MeetingSnapshot) =>
      setMeetings((prev) => {
        const i = prev.findIndex((x) => x.id === m.id);
        if (i < 0) return [...prev, m];
        const next = [...prev];
        next[i] = m;
        return next;
      });

    const unsubscribe = window.speakerLog.onEvent((event: AppEvent) => {
      switch (event.type) {
        case 'speaker-start': {
          setActive((prev) => {
            const next = new Map(prev);
            next.set(`${event.platform}::${event.name}`, {
              platform: event.platform,
              name: event.name,
              startTs: event.startTs,
              durationMs: 0,
            });
            return next;
          });
          logEvent(event.startTs, 'speech_on', 'speech', event.name);
          break;
        }
        case 'speaker-tick': {
          setActive((prev) => {
            const key = `${event.platform}::${event.name}`;
            const next = new Map(prev);
            // Create the entry if the start was missed (e.g. renderer reload
            // while this person was mid-sentence) — the tick carries everything.
            next.set(key, {
              platform: event.platform,
              name: event.name,
              startTs: event.startTs,
              durationMs: event.durationMs,
            });
            return next;
          });
          break;
        }
        case 'speaker-end': {
          setActive((prev) => {
            const next = new Map(prev);
            next.delete(`${event.platform}::${event.name}`);
            return next;
          });
          setSessions((prev) => [event, ...prev].slice(0, MAX_LOG_ROWS));
          logEvent(event.endTs, 'speech_off', 'speech', `${event.name} · ${formatDuration(event.durationMs)}`);
          break;
        }
        case 'windows':
          setWindows(event.windows);
          break;
        case 'status':
          setStatuses((prev) => [event, ...prev].slice(0, MAX_STATUS_LINES));
          break;
        case 'meeting_initialized': {
          upsertMeeting(event.meeting);
          const n = event.meeting.participants.length;
          logEvent(
            event.meeting.updatedAt,
            'meeting_initialized',
            'meeting',
            `${event.meeting.title} · ${n} participant${n === 1 ? '' : 's'}`,
          );
          break;
        }
        case 'meeting_updated':
          upsertMeeting(event.meeting);
          break;
        case 'meeting_ended': {
          setMeetings((prev) => {
            const title = prev.find((m) => m.id === event.meetingId)?.title ?? event.meetingId;
            logEvent(event.ts, 'meeting_ended', 'meeting', title);
            return prev.filter((m) => m.id !== event.meetingId);
          });
          break;
        }
        case 'participant_joined':
          logEvent(event.ts, 'participant_joined', 'participant', event.participant.name);
          break;
        case 'participant_left':
          logEvent(event.ts, 'participant_left', 'participant', event.name);
          break;
        case 'participant_updated': {
          const mute =
            event.participant.isMuted === true ? 'muted' : event.participant.isMuted === false ? 'unmuted' : '—';
          logEvent(event.ts, 'participant_updated', 'participant', `${event.participant.name} · ${mute}`);
          break;
        }
      }
    });
    return unsubscribe;
  }, []);

  const totals = useMemo(() => {
    const byName = new Map<string, number>();
    for (const s of sessions) {
      byName.set(s.name, (byName.get(s.name) ?? 0) + s.durationMs);
    }
    for (const a of active.values()) {
      byName.set(a.name, (byName.get(a.name) ?? 0) + a.durationMs);
    }
    return [...byName.entries()].sort((a, b) => b[1] - a[1]);
  }, [sessions, active]);

  const activeList = [...active.values()].sort((a, b) => a.startTs - b.startTs);
  const meeting = meetings[0];

  return (
    <div className="app">
      <header>
        <h1>Meeting Speaker Logger</h1>
        <div className="windows">
          {(['meet', 'zoom', 'teams'] as Platform[]).map((p) => {
            const found = windows.filter((w) => w.platform === p);
            // treeOk === false means a browser tree with no content: names
            // unavailable, but audio-based detection still works.
            const namesUnavailable = found.some((w) => w.treeOk === false);
            const audioActive = found.some((w) => (w.audioPeak ?? 0) > 0.02);
            return (
              <span
                key={p}
                className={`chip ${found.length > 0 ? (namesUnavailable ? 'chip-warn' : 'chip-on') : 'chip-off'}`}
                title={
                  found
                    .map((w) => `${w.title} (${w.nodeCount} a11y nodes, audio ${(w.audioPeak ?? 0).toFixed(2)})`)
                    .join('\n') || 'No meeting window detected'
                }
              >
                {PLATFORM_LABELS[p]}
                {found.length > 0
                  ? `${namesUnavailable ? ' ⚠ names n/a' : ' ● live'}${audioActive ? ' ♪' : ''}`
                  : ' ○'}
              </span>
            );
          })}
        </div>
        {meeting && (
          <div className="meeting-summary">
            <span className={`meeting-dot dot-${meeting.platform}`} />
            <span className="meeting-title">{meeting.title || PLATFORM_LABELS[meeting.platform]}</span>
            <span className="muted">
              · {meeting.participants.length} participant{meeting.participants.length === 1 ? '' : 's'}
            </span>
          </div>
        )}
      </header>

      <section className="now-speaking">
        <h2>Now speaking</h2>
        {activeList.length === 0 ? (
          <p className="muted">Nobody is speaking right now.</p>
        ) : (
          <div className="speaker-cards">
            {activeList.map((s) => (
              <div className="speaker-card" key={`${s.platform}::${s.name}`}>
                <span className="pulse-dot" />
                <div>
                  <div className="speaker-name">{s.name}</div>
                  <div className="speaker-meta">
                    {PLATFORM_LABELS[s.platform]} · {formatDuration(s.durationMs)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="columns">
        <section className="log">
          <h2>Speaking log</h2>
          {sessions.length === 0 ? (
            <p className="muted">No completed speaking turns yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Platform</th>
                  <th>Speaker</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s, i) => (
                  <tr key={`${s.startTs}-${s.name}-${i}`}>
                    <td>{formatClock(s.startTs)}</td>
                    <td>{PLATFORM_LABELS[s.platform]}</td>
                    <td>{s.name}</td>
                    <td>{formatDuration(s.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="totals">
          <h2>Talk time</h2>
          {totals.length === 0 ? (
            <p className="muted">—</p>
          ) : (
            <ul>
              {totals.map(([name, ms]) => (
                <li key={name}>
                  <span>{name}</span>
                  <span className="mono">{formatDuration(ms)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="event-log">
        <h2>
          Event log <span className="muted">({events.length})</span>
        </h2>
        {events.length === 0 ? (
          <p className="muted">meeting_initialized, participant_joined, speech_on …</p>
        ) : (
          <ul className="event-list">
            {events.map((e) => (
              <li key={e.id}>
                <span className="mono event-ts">{formatClock(e.ts)}</span>
                <span className={`event-type event-${e.kind}`}>{e.type}</span>
                <span className="event-summary">{e.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer>
        {statuses.length > 0 && (
          <details open={statuses[0].level !== 'info'}>
            <summary>Engine status</summary>
            <ul className="status-list">
              {statuses.map((s, i) => (
                <li key={`${s.ts}-${i}`} className={`status-${s.level}`}>
                  <span className="mono">{formatClock(s.ts)}</span> {s.message}
                </li>
              ))}
            </ul>
          </details>
        )}
      </footer>
    </div>
  );
}
