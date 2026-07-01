import { app, BrowserWindow } from 'electron';
import path from 'path';
import { UiaEngine } from './engine';
import { SessionTracker } from '../shared/sessionTracker';
import {
  AppEvent,
  EngineEvent,
  EngineStatus,
  EngineWindows,
  PLATFORM_LABELS,
  SpeakerEnd,
  TrackerEvent,
  formatClock,
  formatDuration,
} from '../shared/types';

const SIMULATE = process.argv.includes('--simulate');
const TICK_MS = 500;
const MAX_RETAINED_SESSIONS = 500;
const MAX_RETAINED_STATUSES = 8;

let mainWindow: BrowserWindow | null = null;
let rendererReady = false;

// Main process is the source of truth: enough state is retained to replay the
// UI after a renderer reload (Ctrl+R) and to deliver events emitted before the
// page finished loading.
const retainedSessions: SpeakerEnd[] = [];
const retainedStatuses: EngineStatus[] = [];
let lastWindows: EngineWindows | null = null;

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
  const events: AppEvent[] = [
    ...(lastWindows ? [lastWindows] : []),
    ...retainedStatuses,
    ...retainedSessions, // oldest first; the renderer prepends, newest ends on top
  ];
  for (const event of events) {
    mainWindow.webContents.send('app-event', event);
  }
}

function logTrackerEvent(event: TrackerEvent): void {
  const label = PLATFORM_LABELS[event.platform];
  switch (event.type) {
    case 'speaker-start':
      // ASCII markers: Windows consoles often garble Unicode glyphs.
      console.log(`>> [${label}] ${event.name} started speaking (${formatClock(event.startTs)})`);
      break;
    case 'speaker-end':
      console.log(
        `[] [${label}] ${event.name} spoke for ${formatDuration(event.durationMs)} ` +
          `(${formatClock(event.startTs)} -> ${formatClock(event.endTs)})`,
      );
      break;
    case 'speaker-tick':
      // Live progress is visible in the UI; keep the console to start/stop lines.
      break;
  }
}

// The engine pulses every poll (~500 ms) while audio is active and applies its
// own 800 ms hangover to bridge word gaps, so a short tracker silence window is
// enough to close a turn promptly without splitting continuous speech.
const tracker = new SessionTracker(
  (event) => {
    logTrackerEvent(event);
    sendToRenderer(event);
  },
  { endSilenceMs: 1800, pulseWidthMs: 300 },
);

const engine = new UiaEngine(
  {
    onEvent: (event: EngineEvent) => {
      const now = Date.now();
      switch (event.type) {
        case 'pulse':
          for (const name of event.speakers) {
            tracker.pulse(event.platform, name, now);
          }
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
      tracker.endAll();
      // Without this, the header chips keep showing "● live" for an engine
      // that is no longer watching anything.
      sendToRenderer({ type: 'windows', windows: [], ts: Date.now() });
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
  createWindow();
  console.log(
    SIMULATE
      ? '[app] Started in SIMULATE mode — synthetic speakers, no real meeting needed.'
      : '[app] Watching for Google Meet / Zoom / Microsoft Teams meeting windows...',
  );
  engine.start();

  setInterval(() => tracker.update(Date.now()), TICK_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  engine.stop();
  tracker.endAll();
  app.quit();
});

app.on('before-quit', () => {
  engine.stop();
  // Flush sessions still open (endAll is idempotent; this path is the only
  // one taken when quitting via the app menu rather than the window X).
  tracker.endAll();
});
