import { useEffect, useMemo, useState } from 'react';
import {
  AppEvent,
  EngineStatus,
  EngineWindows,
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

const MAX_LOG_ROWS = 500;
const MAX_STATUS_LINES = 8;

export function App() {
  const [active, setActive] = useState<Map<string, ActiveSpeaker>>(new Map());
  const [sessions, setSessions] = useState<SpeakerEnd[]>([]);
  const [windows, setWindows] = useState<EngineWindows['windows']>([]);
  const [statuses, setStatuses] = useState<EngineStatus[]>([]);

  useEffect(() => {
    const unsubscribe = window.speakerLog.onEvent((event: AppEvent) => {
      switch (event.type) {
        case 'speaker-start': {
          console.log(
            `▶ [${PLATFORM_LABELS[event.platform]}] ${event.name} started speaking (${formatClock(event.startTs)})`,
          );
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
          console.log(
            `■ [${PLATFORM_LABELS[event.platform]}] ${event.name} spoke for ` +
              `${formatDuration(event.durationMs)} (${formatClock(event.startTs)} → ${formatClock(event.endTs)})`,
          );
          setActive((prev) => {
            const next = new Map(prev);
            next.delete(`${event.platform}::${event.name}`);
            return next;
          });
          setSessions((prev) => [event, ...prev].slice(0, MAX_LOG_ROWS));
          break;
        }
        case 'windows':
          setWindows(event.windows);
          break;
        case 'status':
          console.log(`[engine:${event.level}] ${event.message}`);
          setStatuses((prev) => [event, ...prev].slice(0, MAX_STATUS_LINES));
          break;
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
