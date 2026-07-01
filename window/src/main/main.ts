import { app, BrowserWindow } from 'electron';
import path from 'path';
import { UiaEngine } from './engine';
import { EventLogWriter } from './eventLog';
import { SessionTracker } from '../shared/sessionTracker';
import { MeetingStateTracker } from '../shared/meetingStateTracker';
import { meetingId, participantId } from '../shared/meetingIdentity';
import {
  AppEvent,
  EngineEvent,
  EnginePulse,
  EngineStatus,
  EngineWindows,
  MeetingEvent,
  MeetingParticipant,
  MeetingSnapshot,
  Platform,
  SpeakerEnd,
  SpeechContext,
  TrackerEvent,
} from '../shared/types';

const SIMULATE = process.argv.includes('--simulate');
const TICK_MS = 500;
const MAX_RETAINED_SESSIONS = 500;
const MAX_RETAINED_STATUSES = 8;
/**
 * Mirror every emitted event (meeting / participant / speech) to stdout as a
 * `[event] {json}` NDJSON line, in addition to the log file. Matches the macOS
 * port's `EngineConfig.logEventsToTerminal`; handy while developing.
 */
const LOG_EVENTS_TO_TERMINAL = true;

let mainWindow: BrowserWindow | null = null;
let rendererReady = false;

// Main process is the source of truth: enough state is retained to replay the
// UI after a renderer reload (Ctrl+R) and to deliver events emitted before the
// page finished loading.
const retainedSessions: SpeakerEnd[] = [];
const retainedStatuses: EngineStatus[] = [];
const liveMeetings = new Map<string, MeetingSnapshot>();
let lastWindows: EngineWindows | null = null;

// Durable Recall-style event stream (created once the app is ready so
// app.getPath('userData') resolves).
let eventLog: EventLogWriter | null = null;

function sendToRenderer(event: AppEvent): void {
  switch (event.type) {
    case 'speaker-end':
      retainedSessions.push(event);
      if (retainedSessions.length > MAX_RETAINED_SESSIONS) retainedSessions.shift();
      break;
    case 'status':
      retainedStatuses.push(event);
      if (retainedStatuses.length > MAX_RETAINED_STATUSES) retainedStatuses.shift();
      break;
    case 'windows':
      lastWindows = event;
      break;
  }
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-event', event);
  }
}

function replayToRenderer(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const meetingEvents: MeetingEvent[] = [...liveMeetings.values()].map((meeting) => ({
    type: 'meeting_initialized',
    meeting,
  }));
  const events: AppEvent[] = [
    ...(lastWindows ? [lastWindows] : []),
    ...retainedStatuses,
    ...meetingEvents,
    ...retainedSessions, // oldest first; the renderer prepends, newest ends on top
  ];
  for (const event of events) {
    mainWindow.webContents.send('app-event', event);
  }
}

// Single event sink: append to the NDJSON log file AND (when enabled) mirror the
// same line to stdout for terminal debugging. Mirrors DetectionEngine.record().
function record(type: string, fields: Record<string, unknown>, ts: number): void {
  eventLog?.logEvent(type, fields, ts);
  if (!LOG_EVENTS_TO_TERMINAL) return;
  console.log(`[event] ${JSON.stringify({ ...fields, type, ts })}`);
}

function speechFields(
  platform: Platform,
  name: string,
  ctx: SpeechContext,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const f: Record<string, unknown> = {
    platform,
    name,
    meeting_id: ctx.meetingId,
    participant_id: ctx.participantId,
  };
  if (ctx.source) f.source = ctx.source;
  return { ...f, ...extra };
}

function handleTrackerEvent(event: TrackerEvent): void {
  switch (event.type) {
    case 'speaker-start':
      record('speech_on', speechFields(event.platform, event.name, event.ctx, { start_ts: event.startTs }), event.startTs);
      break;
    case 'speaker-tick':
      break; // live duration goes to the UI, not the durable log
    case 'speaker-end':
      record(
        'speech_off',
        speechFields(event.platform, event.name, event.ctx, {
          start_ts: event.startTs,
          end_ts: event.endTs,
          duration_ms: event.durationMs,
        }),
        event.endTs,
      );
      break;
  }
  sendToRenderer(event);
}

function meetingFields(s: MeetingSnapshot): Record<string, unknown> {
  const f: Record<string, unknown> = {
    meeting_id: s.id,
    platform: s.platform,
    title: s.title,
    participant_count: s.participants.length,
  };
  if (s.url) f.url = s.url;
  return f;
}

function participantFields(mid: string, p: MeetingParticipant): Record<string, unknown> {
  const f: Record<string, unknown> = { meeting_id: mid, participant_id: p.id, name: p.name };
  if (p.isLocal !== undefined) f.is_local = p.isLocal;
  if (p.isMuted !== undefined) f.is_muted = p.isMuted;
  return f;
}

function handleMeetingEvent(event: MeetingEvent): void {
  switch (event.type) {
    case 'meeting_initialized':
      liveMeetings.set(event.meeting.id, event.meeting);
      record('meeting_initialized', meetingFields(event.meeting), event.meeting.updatedAt);
      break;
    case 'meeting_updated':
      liveMeetings.set(event.meeting.id, event.meeting);
      record('meeting_updated', meetingFields(event.meeting), event.meeting.updatedAt);
      break;
    case 'meeting_ended':
      liveMeetings.delete(event.meetingId);
      record('meeting_ended', { meeting_id: event.meetingId }, event.ts);
      break;
    case 'participant_joined':
      record('participant_joined', participantFields(event.meetingId, event.participant), event.ts);
      break;
    case 'participant_updated':
      record('participant_updated', participantFields(event.meetingId, event.participant), event.ts);
      break;
    case 'participant_left':
      record(
        'participant_left',
        { meeting_id: event.meetingId, participant_id: event.participantId, name: event.name },
        event.ts,
      );
      break;
  }
  sendToRenderer(event);
}

// The engine pulses every poll (~500 ms) while audio is active and applies its
// own 800 ms hangover to bridge word gaps, so a short tracker silence window is
// enough to close a turn promptly without splitting continuous speech.
const tracker = new SessionTracker((event) => handleTrackerEvent(event), {
  endSilenceMs: 1800,
  pulseWidthMs: 300,
});

// Recall-style meeting + participant lifecycle. A grace period (a few polls)
// absorbs detection flicker so one missed scan doesn't churn leave/join or end
// a meeting; a hang-up (engine stops pulsing that meeting) ages it out.
const meetingTracker = new MeetingStateTracker((event) => handleMeetingEvent(event), { graceMs: 4000 });

/**
 * Meetings accumulated from this poll's pulses, keyed by stable meeting id. The
 * engine emits one pulse per in-call window (plus audio/roster fallbacks), so we
 * union their rosters + speakers within a tick and flush ONE snapshot per
 * meeting to the state tracker — mirroring DetectionEngine's per-tick observe.
 */
interface PendingMeeting {
  platform: Platform;
  title: string;
  url?: string;
  self?: string;
  participants: Set<string>;
  speaking: Set<string>;
}
const pending = new Map<string, PendingMeeting>();

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function onPulse(event: EnginePulse): void {
  const now = Date.now();
  const mid = meetingId(event.platform, event.url, event.windowTitle ?? '');

  // Speech pulses -> speaking sessions (WHO is speaking), tagged with identity.
  for (const name of event.speakers) {
    tracker.pulse(event.platform, name, now, {
      meetingId: mid,
      participantId: participantId(mid, name),
      source: event.source,
    });
  }

  // Accumulate roster + speaking for this poll's meeting snapshot.
  let agg = pending.get(mid);
  if (!agg) {
    agg = {
      platform: event.platform,
      title: event.windowTitle ?? '',
      url: event.url,
      self: event.self,
      participants: new Set<string>(),
      speaking: new Set<string>(),
    };
    pending.set(mid, agg);
  }
  if (event.self) agg.self = event.self;
  if (event.url) agg.url = event.url;
  if (event.windowTitle && !agg.title) agg.title = event.windowTitle;
  for (const p of event.participants ?? []) agg.participants.add(p);
  for (const s of event.speakers) {
    agg.participants.add(s);
    agg.speaking.add(s);
  }
}

// Flush accumulated meetings to the state tracker each poll. Passing [] when no
// pulse arrived lets an ended call age out and emit meeting_ended.
function flushMeetings(now: number): void {
  const snapshots: MeetingSnapshot[] = [];
  for (const [mid, agg] of pending) {
    const seen = new Set<string>();
    const participants: MeetingParticipant[] = [];
    for (const raw of agg.participants) {
      const name = raw.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      participants.push({
        id: participantId(mid, name),
        name,
        isLocal: agg.self ? sameName(name, agg.self) : undefined,
        isMuted: undefined,
        isSpeaking: agg.speaking.has(name),
      });
    }
    snapshots.push({
      id: mid,
      platform: agg.platform,
      title: agg.title,
      url: agg.url,
      participants,
      startedAt: now,
      updatedAt: now,
    });
  }
  pending.clear();
  meetingTracker.observe(snapshots, now);
}

const engine = new UiaEngine(
  {
    onEvent: (event: EngineEvent) => {
      switch (event.type) {
        case 'pulse':
          onPulse(event);
          break;
        case 'windows':
          sendToRenderer(event);
          break;
        case 'status':
          if (event.level === 'error') console.error(`[engine] ${event.message}`);
          else if (event.level === 'warn') console.warn(`[engine] ${event.message}`);
          else console.log(`[engine] ${event.message}`);
          sendToRenderer(event);
          break;
      }
    },
    onExit: () => {
      const now = Date.now();
      tracker.endAll();
      meetingTracker.endAll(now);
      pending.clear();
      // Without this, the header chips keep showing "● live" for an engine that
      // is no longer watching anything.
      sendToRenderer({ type: 'windows', windows: [], ts: now });
    },
  },
  { simulate: SIMULATE },
);

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    title: 'Meeting Speaker Logger',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });
  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true;
    replayToRenderer();
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });
}

app.whenReady().then(() => {
  eventLog = new EventLogWriter();
  createWindow();
  console.log(
    SIMULATE
      ? '[app] Started in SIMULATE mode — synthetic speakers, no real meeting needed.'
      : '[app] Watching for Google Meet / Zoom / Microsoft Teams meeting windows...',
  );
  engine.start();

  setInterval(() => {
    const now = Date.now();
    tracker.update(now);
    flushMeetings(now);
  }, TICK_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  engine.stop();
  const now = Date.now();
  tracker.endAll();
  meetingTracker.endAll(now);
  eventLog?.close();
  app.quit();
});

app.on('before-quit', () => {
  engine.stop();
  // Flush sessions + meetings still open (endAll is idempotent; this path is the
  // only one taken when quitting via the app menu rather than the window X).
  const now = Date.now();
  tracker.endAll();
  meetingTracker.endAll(now);
  eventLog?.close();
});
