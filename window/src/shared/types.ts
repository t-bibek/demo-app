/** Meeting platforms supported on Windows. */
export type Platform = 'meet' | 'zoom' | 'teams';

export const PLATFORM_LABELS: Record<Platform, string> = {
  meet: 'Google Meet',
  zoom: 'Zoom',
  teams: 'Microsoft Teams',
};

/**
 * Events emitted by the UIA engine (engine/uia-engine.ps1) as NDJSON on stdout.
 */

/** One poll tick observed a meeting window; `speakers` are the names speaking right now. */
export interface EnginePulse {
  type: 'pulse';
  platform: Platform;
  /** Names currently detected as speaking (may be several at once). */
  speakers: string[];
  /** Participant names visible in the window, when cheaply available. */
  participants?: string[];
  /** Title of the meeting window the pulse came from. */
  windowTitle?: string;
  /** Engine-side epoch milliseconds. */
  ts: number;
  /** Which detection strategy produced this (tile-label, caption, generic...). */
  source?: string;
}

/** Periodic snapshot of which meeting windows the engine can see. */
export interface EngineWindows {
  type: 'windows';
  windows: Array<{
    platform: Platform;
    title: string;
    /** Number of accessibility nodes scanned. */
    nodeCount: number;
    /**
     * False when a browser/WebView2 window's accessibility tree is empty
     * (names unavailable; audio-based detection still works). Zoom desktop's
     * tiny tree is normal and reports true.
     */
    treeOk?: boolean;
    /** Current output audio peak (0..1) of the app owning this window. */
    audioPeak?: number;
  }>;
  ts: number;
}

/** Engine lifecycle / diagnostics. */
export interface EngineStatus {
  type: 'status';
  level: 'info' | 'warn' | 'error';
  message: string;
  ts: number;
}

export type EngineEvent = EnginePulse | EngineWindows | EngineStatus;

/**
 * Events produced by the SessionTracker in the Electron main process and
 * forwarded to the renderer over IPC.
 */

export interface SpeakerStart {
  type: 'speaker-start';
  platform: Platform;
  name: string;
  startTs: number;
}

/** Emitted while a speaker session is ongoing, so UIs can show a live timer. */
export interface SpeakerTick {
  type: 'speaker-tick';
  platform: Platform;
  name: string;
  startTs: number;
  durationMs: number;
}

export interface SpeakerEnd {
  type: 'speaker-end';
  platform: Platform;
  name: string;
  startTs: number;
  endTs: number;
  durationMs: number;
}

export type TrackerEvent = SpeakerStart | SpeakerTick | SpeakerEnd;

/** Everything the renderer can receive. */
export type AppEvent = TrackerEvent | EngineWindows | EngineStatus;

export interface SpeakerLogApi {
  onEvent(cb: (event: AppEvent) => void): () => void;
}

export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  // Use the displayed (rounded) value for the branch so 59.96s doesn't render
  // as "60.0s" and the minute path never shows "1m 60s".
  if (Math.round(totalSeconds * 10) < 600) return `${totalSeconds.toFixed(1)}s`;
  let minutes = Math.floor(totalSeconds / 60);
  let seconds = Math.round(totalSeconds % 60);
  if (seconds === 60) {
    minutes += 1;
    seconds = 0;
  }
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}
