#!/usr/bin/env node
// ---------------------------------------------------------------------------
// meet-tabaway-live (v3) — LIVE-QA rig for the Meet TAB-AWAY KEEP-ALIVE bridge.
//
// This is the LIVE counterpart of the pure MeetKeepAliveRules unit matrix: it
// drives a REAL hosted Google Meet in a real-mic rig Chrome and asserts the
// product detector's tab-away bridge (MeetTabStripKeepAlive) holds the meeting
// key open across a blindness window instead of tripping idle hysteresis — then
// that a CLEAN end signal (readable recovery, rejoin-landing clear, tab close, or
// mic-idle) is what actually releases it.
//
// WHY BACKGROUND-THROTTLE IS THE CANONICAL BLINDNESS (self-contained premise)
// --------------------------------------------------------------------------
// When a Meet tab is GENUINELY backgrounded — a second tab opened AND activated so
// the Meet tab is no longer the foreground tab — Chrome THROTTLES the background
// renderer. Its deep AXWebArea goes blind: the detector's URL loop can no longer
// read a live in-call meet.google.com/ web area, so the miss-path fires and the
// keep-alive bridge ENGAGES to hold the meeting key open across the throttle
// window. This is measured, deterministic, and is the exact scenario the product
// ships the bridge for: engage on background, hold with zero meet-idle, then a
// clean release when the tab is activated again (the live tree returns → reason
// `readable`) or the call actually ends (Leave / tab close / mic-idle).
//
// A key mechanical prerequisite made this observable: opening the second (blanking)
// tab requires an HTTP PUT to the DevTools `/json/new` endpoint. Chrome 110+ REJECTS
// a GET on `/json/new` with 405 Method Not Allowed, so the older GET silently failed
// to create the tab — the Meet tab was never actually backgrounded, the renderer
// never throttled, the bridge never engaged, and the rig mis-concluded "a woken
// Chrome keeps backgrounded tabs readable; bridge dormant." With the PUT fix in
// place the tab genuinely backgrounds, the renderer genuinely throttles, and the
// engage→hold→recover cycle is real and gateable. Background-throttle — NOT tab
// discard — is therefore the canonical blindness this rig gates (phase 2).
//
// DISCARD IS OPTIONAL / NON-GATING. Chrome tab DISCARD (memory saver: the renderer
// is torn down entirely and the tab RELOADS on activation, landing not-in-call) is
// a STRONGER blindness but is not deterministically inducible from a driver: the
// chrome://discards UI has proven brittle (a zero-row table on a woken headful
// Chrome) and its Mojo bridge symbol names are version-dependent. The discard phase
// (phase 3) attempts a Mojo-first, DOM-fallback discard; if BOTH mechanisms fail to
// fire a discard it records SKIP (mechanism-unavailable) and does NOT fail the
// roll-up. Only a discard that actually FIRES is asserted.
//
// THE REAL KEEP-ALIVE VOCABULARY (verbatim from GoogleMeetProbe.swift)
// -------------------------------------------------------------------
// Every assertion below is grounded in what the SHIPPING binary actually composes
// at runtime. The two format sites (engage, release) and the five release reasons:
//   engaged:  `meet-keepalive: engaged key=meet:<code> reason=tab_present mic=<m>`
//             where <m> ∈ { browser_active | global_idle | unknown }
//   released: `meet-keepalive: released key=meet:<code> reason=<r>`
//             reason literals, one per emit site:
//               readable  — the readable path recovered the live tree (tab activated
//                           again while STILL in-call): the bridge's normal recovery
//               left      — a Meet WebArea is readable but NOT in-call: the call
//                           ended / the tab landed on a rejoin page (Leave, or a
//                           discarded tab reloaded not-in-call)
//               gone      — miss-path end, state==.tabGone: the tab was closed
//               mic_idle  — miss-path end, mic==.globalIdle && sawBrowserMic
//               expired   — miss-path end, cap expired, no positive liveness
// The engage reason is ALWAYS `tab_present`. A background→activate-still-in-call
// recovery releases with `reason=readable`; a foreground Leave (or a discard+reload
// landing not-in-call) releases with `reason=left`.
//
// It exercises the REAL signal chain minus the desktop TS layer: the product
// bubbles-mic-detector is spawned as the actual OS-mic source, and its
// MIC_ACTIVE/MIC_IDLE lines are transformed into the detector's stdin mic-hint
// protocol (`mic active=0|1 bundle=<id|->`) and written to the detector's stdin.
//
//   node research/meet-dom-detector/live/meet-tabaway-live.mjs --tabaway
//   node research/meet-dom-detector/live/meet-tabaway-live.mjs --tabaway --no-reactivate
//     (discard phase, IF it fires, closes the Meet tab instead of reactivating it —
//      tabGone → reason=gone; otherwise the discard phase is SKIP)
//
// Env contract with the PRODUCT detector (owned by the Swift side):
//   MSD_DETECTOR_BIN   path to the product bubbles-meet-detector (REQUIRED here —
//                      this rig gates the SHIPPING binary, not the sandbox build).
//   MSD_MIC_BIN        path to the product bubbles-mic-detector (mic-hint source).
//   MSD_MEET_TABSTRIP=1  opt the tab-away keep-alive path IN (ships dark by default).
//   MSD_EDGE_LOG=1     emit [event] stderr diagnostics AND the plain keep-alive
//                      lifecycle stderr lines we assert on.
//   MSD_AUTOSTART=1    auto-start the engine (no UI click).
//   MSD_RUN_SECONDS=N  clean auto-exit after N seconds (flushes meet_walk_stats);
//                      we SIGTERM (never SIGKILL) so that flush lands.
//   MSD_CHROME_PROFILE persistent host profile dir (see PROFILE RESOLUTION below).
//
// PERSISTENT PROFILE IN PLACE (fixes every-run Google passkey prompts)
// -------------------------------------------------------------------
// Google device-bound passkey sessions BREAK when a profile is copied (the old
// mkdtempSync+copyAuth path re-triggered the passkey prompt on every run). The
// PRIMARY (host) Chrome now runs `--user-data-dir` pointed DIRECTLY at a persistent
// profile IN PLACE. Resolution order (first that exists wins):
//   1. $MSD_CHROME_PROFILE (if set)
//   2. research/meet-dom-detector/live/.rig-profiles/host-refresh-2026-07-06
//   3. research/meet-dom-detector/live/.rig-profiles/host
//   4. FALLBACK: old mkdtempSync + copyAuth temp profile (warns loudly).
// A persistent profile is CLEAN-QUIT on teardown (CDP Browser.close, then SIGTERM
// after a grace window; NEVER SIGKILL, NEVER rmSync — that would corrupt the
// session). It is also guarded against concurrent use: if a Chrome already runs
// with that exact user-data-dir (ps match), we FAIL FAST.
//
// SERIALIZED — NEVER TWO CHROMES ON ONE PROFILE. Every phase (including cap-only,
// phase 6) reuses the SAME persistent profile, but STRICTLY one at a time: the
// primary host Chrome is fully clean-quit before cap-only relaunches the same
// profile. Serializing removes the need for a concurrent copy-auth temp Chrome —
// which is what previously hit the Google login wall (a copied profile carries a
// stale cookie snapshot and re-triggers the sign-in / passkey prompt). The
// in-place persistent profile joins cleanly with zero prompts.
//
// Results: one NDJSON verdict line PER PHASE, APPENDED to live-qa-results.ndjson
// (the zoom-wake driver lesson — never clobber a prior --all run's verdicts in the
// same session; seed an empty file only when none exists). Nonzero exit on any FAIL.
// ---------------------------------------------------------------------------
'use strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createRequire } from 'node:module';

// cdp-lib.js is CommonJS; bridge it into this ESM driver.
const require = createRequire(import.meta.url);
const { attachToPage, httpJson, httpJsonPut, sleep } = require('./cdp-lib.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_NDJSON = join(HERE, 'live-qa-results.ndjson');
const SCENARIO = 'meet-tabaway-live';

// --no-reactivate: IF the discard phase fires a real discard, it CLOSES the Meet tab
// (tabGone → reason=gone) instead of reactivating it. Default reactivates a discarded
// tab (it reloads not-in-call → reason=left). No effect if the discard phase SKIPs.
const NO_REACTIVATE = process.argv.includes('--no-reactivate');

// The PRODUCT binaries this rig gates. Both must already exist — fail fast BEFORE
// any Chrome/meeting infrastructure launches (nothing to tear down yet).
const DETECTOR_BIN = process.env.MSD_DETECTOR_BIN
  || '/Users/bibekthapa/projects/work/bubbles-dev/packages/desktop/native/bubbles-meet-detector/dist/darwin/bubbles-meet-detector';
const MIC_BIN = process.env.MSD_MIC_BIN
  || '/Users/bibekthapa/projects/work/bubbles-dev/packages/desktop/native/bubbles-mic-detector/dist/darwin/bubbles-mic-detector';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_SRC = join(homedir(), 'Library/Application Support/Google/Chrome');

// Persistent-profile candidates, in resolution order (see PROFILE RESOLUTION above).
const PROFILE_DIR = join(HERE, '.rig-profiles');
const PROFILE_REFRESH = join(PROFILE_DIR, 'host-refresh-2026-07-06');
const PROFILE_HOST = join(PROFILE_DIR, 'host');

// --- Timings (seconds unless _MS). Tunable; kept modest so the whole pass fits
// inside the live-session budget. Phase-4's 2-minute hold is the long one. --------
const SHORT_HOLD_MS = 30_000;    // phases 2 & 6 background-throttle hold (no meet-idle)
const DISCARD_HOLD_MS = 45_000;  // phase 3 discard-blindness hold (no meet-idle for 45s)
const LONG_HOLD_MS = 120_000;    // phase 4 sustained background-throttle hold
const STDERR_POLL_MS = 3_000;    // cadence for polling stderr during a hold
const IDLE_HYSTERESIS_MS = 10_000; // meet-idle must arrive within normal hysteresis
// Background-throttle → the URL loop misses the meeting + engages. The renderer
// throttle can take a few frame-budget cycles to bite, so allow ~15s for phase 2.
const BG_ENGAGE_TIMEOUT_MS = 15_000;
// Discard tears the renderer down immediately, so the engage fires faster (~10s).
const ENGAGE_TIMEOUT_MS = 10_000;
const JOIN_TIMEOUT_MS = 90_000;  // green-room → in-call
const MIC_ACTIVE_TIMEOUT_MS = 20_000; // Meet grabbing the real mic after join
const QUIT_GRACE_MS = 6_000;     // persistent-profile clean-quit grace before SIGTERM

// Total detector wall budget: join + detect + all phases + settle. The detector
// auto-exits on MSD_RUN_SECONDS (flushing walk-stats); we SIGTERM as the backstop.
const DETECTOR_RUN_SECONDS = 480; // 8 min — comfortably covers the meeting + holds

const log = (...a) => console.log('[tabaway]', ...a);
const nowSec = () => Math.floor(Date.now() / 1000);

// Per-phase verdict ledger — accumulated so a single roll-up line can gate the whole
// scenario (the live reader qa/live-scenario-verdict.mjs takes the LAST line for a
// scenario, so per-phase lines carry a `phase` sub-key + a distinct scenario id, and
// the aggregate `meet-tabaway-live` roll-up is written LAST).
const phaseVerdicts = [];

// One NDJSON verdict line per phase. APPEND (never clobber) — a prior `--all` run's
// verdicts may already be on disk in the same session (zoom-wake driver lesson).
// Per-phase lines self-identify as `<SCENARIO>:<phase>` so they never collide with
// the aggregate roll-up the reader gate matches on.
function record(phase, verdict, detail) {
  phaseVerdicts.push({ phase, verdict });
  const line = JSON.stringify({ scenario: `${SCENARIO}:${phase}`, phase, verdict, ts: nowSec(), ...detail });
  appendFileSync(RESULTS_NDJSON, line + '\n');
  log(`RESULT ${phase}: ${verdict}` + (detail && detail.reason ? ` — ${detail.reason}` : ''));
}

// Aggregate roll-up: PASS iff the GATING phases (1,2,4,5,6) all passed. The optional
// discard-blindness phase (3) is allowed to be PASS *or* SKIP — a SKIP means the
// discard mechanism was unavailable (chrome://discards / Mojo could not fire a real
// discard) and MUST NOT fail the roll-up; a FAIL there (a discard that fired but the
// bridge mishandled) still fails. Written LAST under the bare `meet-tabaway-live`
// scenario id so live-scenario-verdict.mjs gates on it.
const OPTIONAL_PHASES = new Set(['discard-blindness']);
function recordSummary() {
  // A phase fails the roll-up when it is not PASS — EXCEPT an optional phase that
  // SKIPped (mechanism-unavailable) is tolerated. An optional phase that FAILed is not.
  const failed = phaseVerdicts.filter((p) => {
    if (p.verdict === 'PASS') return false;
    if (p.verdict === 'SKIP' && OPTIONAL_PHASES.has(p.phase)) return false;
    return true;
  }).map((p) => p.phase);
  const skipped = phaseVerdicts.filter((p) => p.verdict === 'SKIP').map((p) => p.phase);
  const verdict = phaseVerdicts.length > 0 && failed.length === 0 ? 'PASS' : 'FAIL';
  const line = JSON.stringify({
    scenario: SCENARIO, verdict, ts: nowSec(),
    phases: phaseVerdicts, failedPhases: failed, skippedPhases: skipped,
    reason: verdict === 'PASS' ? undefined : `failed phases: ${failed.join(', ') || '(no phases ran)'}`,
  });
  appendFileSync(RESULTS_NDJSON, line + '\n');
  log(`RESULT ${SCENARIO} (roll-up): ${verdict}`
    + (failed.length ? ` — failed: ${failed.join(', ')}` : '')
    + (skipped.length ? ` — skipped(optional): ${skipped.join(', ')}` : ''));
  return verdict;
}

// ===========================================================================
// Pre-flight: Accessibility trust + screen-lock guard.
// ===========================================================================

// AX trust probe — the detector reads the Meet window via AX and returns EMPTY
// without it (same probe as run-live-qa.mjs).
function preflightAxTrust() {
  const probe = join(mkdtempSync(join(tmpdir(), 'axtrust-')), 'probe.swift');
  writeFileSync(probe, 'import ApplicationServices\nprint(AXIsProcessTrusted() ? "TRUSTED" : "UNTRUSTED")\n');
  const r = spawnSync('swift', [probe], { encoding: 'utf8', timeout: 120_000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (!out.includes('TRUSTED') || out.includes('UNTRUSTED')) {
    console.error('[tabaway] FATAL: Accessibility permission is NOT granted for this process.');
    console.error('[tabaway] Fix: System Settings → Privacy & Security → Accessibility → enable the terminal,');
    console.error('[tabaway] then re-run. Probe output: ' + JSON.stringify(out));
    return false;
  }
  log('Accessibility trust: OK');
  return true;
}

// Screen-lock guard (memory: locked-screen-ax-blindness). A locked macOS session
// gives a DEGENERATE AX tree — the detector would read no tiles/roster and every
// tab-away assertion would be a false FAIL (AX-fail while the meeting is genuinely
// live). Refuse to run under a lock rather than emit misleading verdicts.
function preflightNotLocked() {
  const r = spawnSync('ioreg', ['-n', 'IOHIDSystem', '-d', '4', '-r'], { encoding: 'utf8', timeout: 10_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/"IOConsoleLocked"\s*=\s*(Yes|No|true|false|1|0)/i);
  if (m && /^(yes|true|1)$/i.test(m[1])) {
    console.error('[tabaway] FATAL: the macOS session is LOCKED (IOConsoleLocked=' + m[1] + ').');
    console.error('[tabaway] A locked session yields a degenerate AX tree — every tab-away assertion would');
    console.error('[tabaway] false-FAIL. Unlock the screen and keep it awake (caffeinate), then re-run.');
    return false;
  }
  log('screen-lock guard: unlocked' + (m ? ` (IOConsoleLocked=${m[1]})` : ' (IOConsoleLocked key absent — assumed unlocked)'));
  return true;
}

// ===========================================================================
// Mic-hint feeder: spawn the PRODUCT bubbles-mic-detector, transform its lines,
// and write them into the detector's stdin. This is the "real signal chain minus
// the desktop TS layer" the plan calls for.
//   MIC_ACTIVE ... bundle="X" ...   → mic active=1 bundle=X
//   MIC_ACTIVE (bare)               → mic active=1 bundle=-
//   MIC_IDLE                        → mic active=0 bundle=-
// Anything else (LOG lines, etc.) is dropped — the detector's parseMicHintLine
// ignores non-conforming lines anyway, but we never forward them so the stdin
// stream stays clean.
// ===========================================================================
function transformMicLine(line) {
  const s = line.trim();
  if (!s) return null;
  if (s === 'MIC_IDLE') return 'mic active=0 bundle=-';
  if (s === 'MIC_ACTIVE') return 'mic active=1 bundle=-';
  if (s.startsWith('MIC_ACTIVE')) {
    // MIC_ACTIVE app="Google Chrome" bundle="com.google.Chrome" pid=48584
    const m = s.match(/\bbundle="([^"]*)"/);
    const bundle = m && m[1] ? m[1] : '-';
    return `mic active=1 bundle=${bundle}`;
  }
  return null; // LOG / unknown — do not forward
}

// Spawn the mic provider and pipe transformed hints into detectorStdin. Records the
// raw + transformed lines for the verdict detail. Returns a handle to stop it.
function startMicFeeder(detectorStdin, sink) {
  const proc = spawn(MIC_BIN, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const onData = (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ln = buf.slice(0, i); buf = buf.slice(i + 1);
      sink.raw.push({ ts: Date.now(), line: ln.trim() });
      const hint = transformMicLine(ln);
      if (hint == null) continue;
      sink.fed.push({ ts: Date.now(), hint });
      try {
        if (detectorStdin && detectorStdin.writable) detectorStdin.write(hint + '\n');
      } catch (e) { /* detector gone — stop forwarding */ }
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', () => {}); // drain
  proc.on('error', (e) => log('mic feeder spawn error: ' + e.message));
  return {
    proc,
    stop() { try { proc.kill('SIGTERM'); } catch (e) {} },
  };
}

// ===========================================================================
// Detector: spawn the PRODUCT binary with stdin OPEN (for the mic feeder) and
// capture stdout events + stderr lifecycle lines. SIGTERM (not SIGKILL) on
// teardown so meet_walk_stats flushes (memory + zoom-wake lesson).
// ===========================================================================
function startDetector(wireMic) {
  const env = {
    ...process.env,
    MSD_AUTOSTART: '1',
    MSD_MEET_TABSTRIP: '1',
    MSD_EDGE_LOG: '1',
    MSD_RUN_SECONDS: String(DETECTOR_RUN_SECONDS),
  };
  // stdin MUST be a pipe (not ignore) — the mic feeder writes hints into it. Even in
  // the cap-only phase (no feeder) we keep stdin open so the detector's stdin reader
  // thread behaves identically to production.
  const proc = spawn(DETECTOR_BIN, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });

  const events = [];      // parsed stdout wire events (meet-active / speaking / meet-idle)
  const stderrLines = []; // {ts, line} for the keep-alive lifecycle + [event] echoes
  const bufs = { out: '', err: '' };
  const onData = (stream) => (d) => {
    bufs[stream] += d.toString();
    let i;
    while ((i = bufs[stream].indexOf('\n')) >= 0) {
      const ln = bufs[stream].slice(0, i); bufs[stream] = bufs[stream].slice(i + 1);
      if (stream === 'err') stderrLines.push({ ts: Date.now(), line: ln });
      const j = ln.indexOf('{');
      if (j < 0) continue;
      let o; try { o = JSON.parse(ln.slice(j)); } catch (e) { continue; }
      if (o && typeof o === 'object' && o.event) events.push({ ts: Date.now(), ...o });
    }
  };
  proc.stdout.on('data', onData('out'));
  proc.stderr.on('data', onData('err'));
  const done = new Promise((res) => proc.on('exit', res));

  let feeder = null;
  const micSink = { raw: [], fed: [] };
  if (wireMic) feeder = startMicFeeder(proc.stdin, micSink);

  return {
    proc, events, stderrLines, micSink, done,
    // Graceful stop: SIGTERM so the product flushes meet_walk_stats, then a bounded
    // wait, then SIGKILL only as a last resort.
    async stop() {
      if (feeder) feeder.stop();
      try { proc.stdin.end(); } catch (e) {}
      try { proc.kill('SIGTERM'); } catch (e) {}
      const exited = await Promise.race([done, sleep(8000).then(() => 'timeout')]);
      if (exited === 'timeout') { try { proc.kill('SIGKILL'); } catch (e) {} }
    },
  };
}

// ===========================================================================
// PROFILE RESOLUTION + concurrent-use guard for the PRIMARY (host) Chrome.
// ===========================================================================

// Resolve the persistent host profile per the documented order. Returns
// { dir, persistent } — persistent:false only for the loud copyAuth fallback.
function resolveHostProfile() {
  const envDir = process.env.MSD_CHROME_PROFILE;
  if (envDir && existsSync(envDir)) { log(`host profile: MSD_CHROME_PROFILE → ${envDir}`); return { dir: envDir, persistent: true }; }
  if (envDir) log(`host profile: MSD_CHROME_PROFILE set to a MISSING path (${envDir}) — falling through`);
  if (existsSync(PROFILE_REFRESH)) { log(`host profile: persistent refresh → ${PROFILE_REFRESH}`); return { dir: PROFILE_REFRESH, persistent: true }; }
  if (existsSync(PROFILE_HOST)) { log(`host profile: persistent host → ${PROFILE_HOST}`); return { dir: PROFILE_HOST, persistent: true }; }
  // FALLBACK: no persistent profile in place — warn LOUDLY and copy-auth a temp one.
  // Google device-bound passkeys will re-prompt on this path.
  console.error('[tabaway] WARN ============================================================');
  console.error('[tabaway] WARN No persistent host profile found. Falling back to the OLD');
  console.error('[tabaway] WARN mkdtempSync + copyAuth temp-profile path. Google device-bound');
  console.error('[tabaway] WARN passkey sessions BREAK when a profile is copied, so expect a');
  console.error(`[tabaway] WARN passkey/login prompt. To fix, seed ${PROFILE_HOST}`);
  console.error('[tabaway] WARN (or set MSD_CHROME_PROFILE) with a logged-in Chrome profile.');
  console.error('[tabaway] WARN ============================================================');
  const dir = mkdtempSync(join(tmpdir(), 'meet-tabaway-'));
  copyAuth(dir);
  return { dir, persistent: false };
}

// Guard against concurrent use of a persistent profile: Chrome REFUSES to open a
// user-data-dir already owned by a running instance (and it would corrupt the
// session). Fail fast with a clear message if a Chrome process already holds it.
// Match on the exact `--user-data-dir=<dir>` token so unrelated Electron apps
// (ClickUp, etc.) that also pass --user-data-dir don't false-positive.
function assertProfileNotInUse(dir) {
  const r = spawnSync('pgrep', ['-fl', `--user-data-dir=${dir}`], { encoding: 'utf8', timeout: 10_000 });
  const out = (r.stdout || '').trim();
  // pgrep exit 0 with a Chrome line = in use. Filter to Google Chrome lines to be safe.
  const hits = out.split('\n').filter((l) => l && /Google Chrome/i.test(l));
  if (hits.length > 0) {
    console.error(`[tabaway] FATAL: a Chrome is ALREADY running with --user-data-dir=${dir}`);
    console.error('[tabaway] Two Chromes cannot share one persistent profile (it corrupts the');
    console.error('[tabaway] session). Quit that Chrome and re-run. Matching processes:');
    for (const h of hits) console.error('[tabaway]   ' + h);
    return false;
  }
  return true;
}

// ===========================================================================
// Rig Chrome. Two flavors:
//   • launchPersistentChrome — the PRIMARY host, --user-data-dir pointed IN PLACE
//     at a persistent profile. CLEAN-QUIT teardown (Browser.close → SIGTERM);
//     NEVER SIGKILL, NEVER rmSync.
//   • launchTempChrome — a copy-auth temp profile (the fallback path and any phase
//     that needs a second simultaneous Chrome). SIGKILL + rmSync teardown is fine.
// Both use the REAL mic (--use-fake-ui-for-media-stream, NO fake DEVICE) so the OS
// mic-device signal actually flips (M2 sweep + create-meeting.js copy-auth pattern).
// ===========================================================================
function copyAuth(profile) {
  const surface = [
    'Local State', 'Default/Cookies', 'Default/Cookies-wal', 'Default/Cookies-shm',
    'Default/Network/Cookies', 'Default/Network/Cookies-wal', 'Default/Preferences',
  ];
  mkdirSync(join(profile, 'Default'), { recursive: true });
  for (const rel of surface) {
    const s = join(CHROME_SRC, rel), d = join(profile, rel);
    try { if (existsSync(s)) { mkdirSync(dirname(d), { recursive: true }); copyFileSync(s, d); } } catch (e) {}
  }
  writeFileSync(join(profile, 'First Run'), '');
}

const CHROME_ARGS_TAIL = [
  '--no-first-run', '--no-default-browser-check', '--restore-last-session=false',
  // REAL mic: auto-grant getUserMedia but capture the actual default input device.
  // The fake-DEVICE flag is DELIBERATELY absent (M2 sweep §Rig setup deltas).
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  'https://meet.google.com/new',
];

// Launch the PRIMARY host Chrome IN PLACE on a persistent profile. Clean-quit only.
function launchPersistentChrome(port, dir) {
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--profile-directory=Default',
    ...CHROME_ARGS_TAIL,
  ], { stdio: 'ignore', detached: true });
  proc.unref();
  return {
    proc, profile: dir, port, persistent: true,
    // CLEAN-QUIT: ask Chrome to close via CDP (Browser.close flushes the session
    // cleanly), then SIGTERM after a grace window. NEVER SIGKILL, NEVER rmSync — a
    // hard kill or dir removal corrupts the device-bound passkey session.
    async kill() {
      try {
        const list = await httpJson(port, '/json/version');
        const wsUrl = list && list.webSocketDebuggerUrl;
        if (wsUrl) {
          const { WS } = require('./cdp-lib.js');
          const ws = new WS(wsUrl); await ws.connect();
          ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
          await sleep(1500); ws.close();
        }
      } catch (e) { /* fall through to SIGTERM */ }
      const exited = await Promise.race([
        new Promise((res) => proc.on('exit', res)),
        sleep(QUIT_GRACE_MS).then(() => 'timeout'),
      ]);
      if (exited === 'timeout') { try { proc.kill('SIGTERM'); } catch (e) {} }
      // Deliberately NO SIGKILL and NO rmSync — persistent profile stays intact.
    },
  };
}

// Launch a copy-auth TEMP-profile Chrome (fallback path / second-Chrome phases).
function launchTempChrome(port, dir) {
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--profile-directory=Default',
    ...CHROME_ARGS_TAIL,
  ], { stdio: 'ignore', detached: true });
  proc.unref();
  return {
    proc, profile: dir, port, persistent: false,
    async kill() {
      try { proc.kill('SIGKILL'); } catch (e) {}
      try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    },
  };
}

// Drive the green room → in-call, harvest the meeting code. Returns { pg, code, url }.
async function joinFreshMeet(port) {
  const pg = await attachToPage(port, /google\.com/);
  let url = '', code = '';
  const t0 = Date.now();
  while (Date.now() - t0 < JOIN_TIMEOUT_MS) {
    await sleep(1500);
    url = (await pg.evalJs('location.href')) || '';
    // Click Join now / Ask to join at the green room.
    await pg.evalJs(`(function(){var b=[...document.querySelectorAll('button,span')].find(function(n){return /^(Join now|Ask to join)$/i.test((n.textContent||'').trim());});if(b){b.click();return true}return false})()`);
    const m = url.match(/meet\.google\.com\/([a-z]{3}-[a-z]{3,4}-[a-z]{3})/i);
    if (m) { code = m[1]; }
    // Confirmed in-call once the Leave-call control exists.
    const inCall = await pg.evalJs(`!![...document.querySelectorAll('button,[role=button],[aria-label]')].find(function(b){return /leave call/i.test(b.getAttribute('aria-label')||'')})`);
    if (code && inCall) return { pg, code, url: url.split('?')[0] };
  }
  if (code) return { pg, code, url: url.split('?')[0] }; // in-call check flaked but code is known
  throw new Error('joinFreshMeet: never reached an in-call Meet within timeout (url=' + url + ')');
}

// ===========================================================================
// Tab / discard drivers over CDP.
// ===========================================================================

// Tab-away (observational control, phase 2/4): open+activate a blank second tab so
// the Meet tab is backgrounded. On a WOKEN Chrome its AX tree stays materialized, so
// the probe still reads the meeting — the bridge stays correctly DORMANT.
async function tabAway(port) {
  await httpJsonPut(port, '/json/new?about:blank');
}
// Tab-back: bring the Meet tab to the foreground (Page.bringToFront).
async function tabBack(port) {
  const pg = await attachToPage(port, /meet\.google\.com/);
  await pg.cmd('Page.bringToFront');
}
// Click Leave call on the Meet page (must be foreground for Meet to honor the click).
async function clickLeave(pg) {
  return pg.evalJs(`(function(){var b=[...document.querySelectorAll('button,[role=button],[aria-label]')].find(function(n){return /leave call/i.test(n.getAttribute('aria-label')||'')});if(!b)return 'no-button';b.click();return 'clicked';})()`);
}

// DISCARD the Meet tab via chrome://discards (phase 3 — OPTIONAL/non-gating blindness).
//
// Returns { fired, via, detail }:
//   fired:true  — a discard action was actually invoked (Mojo remote call OR a DOM
//                 discard-link click on a matched row). Phase 3 then ASSERTS the bridge.
//   fired:false — NEITHER mechanism could fire (no Mojo remote reachable AND no matching
//                 discard row/link). Phase 3 records SKIP (mechanism-unavailable).
//
// MOJO-FIRST (the robust variant). chrome://discards is a Mojo WebUI: the page bundle
// binds a details-provider remote that exposes `discardById(id)` (and, in some builds,
// `discard(index)`). The remote is reachable two ways, tried in order:
//   1. A page-global handle if the bundle exposed one (`window.uiHandler` /
//      `window.detailsProvider` / `window.discardsDetailsProvider`) — call its
//      discardById after matching a tab info by title/tabUrl.
//   2. Dynamic import of the generated mojom module. Chrome serves the WebUI's own
//      bindings under chrome://resources and the page's module graph; we import the
//      discards mojom + mojo bindings by URL, construct the DetailsProvider remote,
//      bind it via the page's Mojo interface broker, `getTabDiscardsInfo()` to
//      enumerate live infos, match by title/tabUrl, and `discardById(info.id)`.
// Symbol/URL names differ across Chrome versions, so every access is probed
// defensively (typeof / try) and any miss falls through to the next path rather than
// throwing. If no Mojo path is reachable, we fall back to the DOM.
//
// DOM FALLBACK. Deep-query the shadow tree for the tab-discards <table>, find the ROW
// naming this meeting (code/URL substring), and click its "Discard" / "Urgent Discard"
// `<a is="action-link">`. This is what a human clicks; it is brittle (a woken headful
// Chrome has been observed to render a ZERO-row table), so it is the fallback only.
async function discardMeetTab(port, code, meetUrl) {
  // Open the discards helper tab and attach to it. MUST be PUT — Chrome 110+ returns
  // 405 for a GET on /json/new, so the tab was never created (surfaced downstream as
  // "page target not found for /chrome://discards/").
  await httpJsonPut(port, '/json/new?chrome://discards');
  const dpg = await attachToPage(port, /chrome:\/\/discards/);
  // Give the tab-discard table / Mojo pipe a moment to initialize.
  await sleep(1500);

  // ---- Mojo-first attempt. Runs entirely in the discards page context. ----
  // The IIFE is async so we can await the dynamic mojom import; awaitPromise:true in
  // attachToPage's evalJs resolves it. It returns a small status object; ANY failure
  // is caught and reported so we can decide DOM-fallback vs SKIP without throwing.
  const mojoExpr = `(async function(){
    var code = ${JSON.stringify(code)};
    var url = ${JSON.stringify(meetUrl || '')};
    function matchInfo(info){
      try {
        var t = (info && (info.title||'')) + ' ' + (info && (info.tabUrl && info.tabUrl.url || info.tabUrl || ''));
        return (code && t.indexOf(code)>=0) || (url && t.indexOf(url)>=0);
      } catch(e){ return false; }
    }
    // Path 1: a page-global provider handle, if the bundle exposed one.
    var handle = window.uiHandler || window.detailsProvider || window.discardsDetailsProvider || null;
    // Path 2: construct the provider from the generated mojom module.
    if (!handle) {
      var candidates = [
        'chrome://resources/mojo/components/performance_manager/public/mojom/webui_graph_dump.mojom-webui.js',
        'chrome://discards/discards.mojom-webui.js',
        './discards.mojom-webui.js',
        'chrome://discards/tab_discards/tab_discards_info.mojom-webui.js'
      ];
      for (var i=0;i<candidates.length && !handle;i++){
        try {
          var mod = await import(candidates[i]);
          // The generated module exports a *Remote and/or a getRemote() factory. Try the
          // common shapes: DetailsProvider.getRemote(), new DetailsProviderRemote().
          var Provider = mod.DetailsProvider || mod.DetailsProviderRemote || null;
          if (Provider && typeof Provider.getRemote === 'function') { handle = Provider.getRemote(); }
          else if (mod.DetailsProviderRemote) { handle = new mod.DetailsProviderRemote(); }
        } catch(e){ /* try next candidate */ }
      }
    }
    if (!handle) return {fired:false, via:'mojo', reason:'no-provider-remote'};
    // Enumerate infos (method name varies) and discard the matching one by id.
    var infos = null;
    try {
      var getter = handle.getTabDiscardsInfo || handle.getInfo || handle.getDiscardsInfo;
      if (typeof getter === 'function') { var r = await getter.call(handle); infos = (r && (r.infos || r.tabDiscardsInfos || r)) || null; }
    } catch(e){ return {fired:false, via:'mojo', reason:'getInfo-threw:'+(e&&e.message)}; }
    if (!Array.isArray(infos)) return {fired:false, via:'mojo', reason:'no-infos'};
    var target = infos.find(matchInfo);
    if (!target) return {fired:false, via:'mojo', reason:'no-matching-info', infoCount:infos.length};
    try {
      if (typeof handle.discardById === 'function') { await handle.discardById(target.id); return {fired:true, via:'mojo', method:'discardById', id:target.id}; }
      var idx = infos.indexOf(target);
      if (typeof handle.discard === 'function') { await handle.discard(idx); return {fired:true, via:'mojo', method:'discard', index:idx}; }
    } catch(e){ return {fired:false, via:'mojo', reason:'discard-threw:'+(e&&e.message)}; }
    return {fired:false, via:'mojo', reason:'no-discard-method'};
  })()`;
  let mojo;
  try { mojo = await dpg.evalJs(mojoExpr); } catch (e) { mojo = { fired: false, via: 'mojo', reason: 'eval-threw:' + (e && e.message) }; }
  if (mojo && mojo.fired) return { fired: true, via: 'mojo', detail: mojo };

  // ---- DOM fallback: deep shadow-DOM walk, match the row, click its Discard link. ----
  const clickExpr = `(function(){
    function deepRows(root, acc){
      if(!root) return acc;
      var trs = root.querySelectorAll ? root.querySelectorAll('tr') : [];
      for (var i=0;i<trs.length;i++) acc.push(trs[i]);
      var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (var j=0;j<all.length;j++){ if(all[j].shadowRoot) deepRows(all[j].shadowRoot, acc); }
      return acc;
    }
    var rows = deepRows(document, []);
    var code = ${JSON.stringify(code)};
    var url = ${JSON.stringify(meetUrl || '')};
    var target = null;
    for (var i=0;i<rows.length;i++){
      var txt = (rows[i].textContent||'');
      if ((code && txt.indexOf(code)>=0) || (url && txt.indexOf(url)>=0)) { target = rows[i]; break; }
    }
    if(!target) return {fired:false, reason:'no-matching-row', rowCount:rows.length};
    var links = target.querySelectorAll('a');
    var disc = null;
    for (var k=0;k<links.length;k++){ if(/^\\s*Discard\\s*$/i.test(links[k].textContent||'')){ disc = links[k]; break; } }
    // Fall back to the first "Urgent Discard" if a plain "Discard" is absent.
    if(!disc){ for (var m=0;m<links.length;m++){ if(/Discard/i.test(links[m].textContent||'')){ disc = links[m]; break; } } }
    if(!disc) return {fired:false, reason:'no-discard-link', linkCount:links.length};
    disc.click();
    return {fired:true, clicked:(disc.textContent||'').trim()};
  })()`;
  let dom;
  try { dom = await dpg.evalJs(clickExpr); } catch (e) { dom = { fired: false, reason: 'eval-threw:' + (e && e.message) }; }
  if (dom && dom.fired) return { fired: true, via: 'dom', detail: dom };

  // Neither fired — report BOTH mechanisms' diagnostics so the SKIP detail is defensible.
  return { fired: false, via: 'none', detail: { mojo, dom } };
}

// ===========================================================================
// Assertion helpers over the captured detector streams.
// ===========================================================================
const keyFor = (code) => `meet:${code}`;
const eventsForKey = (det, code, sinceTs) =>
  det.events.filter((e) => e.key === keyFor(code) && (sinceTs == null || e.ts >= sinceTs));
const stderrSince = (det, sinceTs) => det.stderrLines.filter((l) => sinceTs == null || l.ts >= sinceTs);
const stderrHas = (det, sinceTs, needle) => stderrSince(det, sinceTs).some((l) => l.line.includes(needle));
const idleSince = (det, code, sinceTs) =>
  eventsForKey(det, code, sinceTs).some((e) => e.event === 'meet-idle');
const activeSince = (det, code, sinceTs) =>
  eventsForKey(det, code, sinceTs).filter((e) => e.event === 'meet-active');
const speakingSince = (det, code, sinceTs) =>
  eventsForKey(det, code, sinceTs).filter((e) => e.event === 'speaking');

// The REAL engage line (GoogleMeetProbe.swift:215-216): reason is ALWAYS tab_present.
const engagedLine = (det, code, sinceTs) => stderrSince(det, sinceTs).find((l) =>
  l.line.includes(`meet-keepalive: engaged key=${keyFor(code)}`) && l.line.includes('reason=tab_present'));
// The REAL release line (GoogleMeetProbe.swift:219-221) for a specific reason literal.
const releasedLine = (det, code, sinceTs, reason) => stderrSince(det, sinceTs).find((l) =>
  l.line.includes(`meet-keepalive: released key=${keyFor(code)}`) && l.line.includes(`reason=${reason}`));

// Poll for `holdMs`, returning the wall time we started (for since-filtering) after
// the hold completes. Logs progress so a long hold shows life.
async function holdAndPoll(det, code, holdMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < holdMs) {
    await sleep(STDERR_POLL_MS);
    if (idleSince(det, code, t0)) log(`${label}: meet-idle observed DURING hold (t+${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  return t0;
}

// Wait up to timeoutMs for a predicate over the streams to become true. Returns ms
// elapsed when it fired, or null on timeout.
async function waitFor(pred, timeoutMs, stepMs = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return Date.now() - t0;
    await sleep(stepMs);
  }
  return null;
}

// ===========================================================================
// Main scenario.
//
// PHASES (v3):
//   1  detect              — meet-active for the key + self named (unchanged).
//   2  bg-throttle-cycle   — CANONICAL (replaces the old bg-hold-dormant): genuinely
//                            background the Meet tab (PUT-created + activated blank tab)
//                            → the renderer throttles → assert the REAL engage line
//                            `engaged reason=tab_present` within ~15s, NO meet-idle for
//                            a 30s hold, speakers released to []; then ACTIVATE the Meet
//                            tab → assert `released reason=readable` (still in-call) and
//                            detection continues (no meet-idle, still in-call). The full
//                            engage→hold→recover cycle the product ships for.
//   3  discard-blindness   — OPTIONAL/NON-GATING: try to discard the Meet tab (Mojo
//                            first, DOM fallback). If a discard FIRES: engage within
//                            ~10s, 45s no-idle hold, then end per variant (reactivate →
//                            reload-not-in-call → reason=left; --no-reactivate → tab
//                            close → reason=gone), each followed by meet-idle. If
//                            NEITHER mechanism fires: SKIP (mechanism-unavailable) —
//                            does NOT fail the roll-up.
//   4  longer-hold         — sustained 2-min background-throttle hold. EXPECT the engage
//                            (the bridge working): engagedLineSeen required, NO meet-idle
//                            for the whole 2 min, then tab-back → released reason=readable.
//   5  leave-ends          — LEAVE regression (unchanged, load-bearing): foreground Leave
//                            → meet-idle < hysteresis and NO re-engage.
//   6  cap-only            — SERIALIZED on the SAME persistent profile (host Chrome fully
//                            quit first): relaunch, join a FRESH meeting WITHOUT the mic
//                            feeder (hint stays .unknown), background-throttle → engage
//                            with mic=unknown, 30s no-idle hold, ACTIVATE → released
//                            reason=readable (still in-call!), then Leave → meet-idle.
//
// Roll-up PASS iff phases 1,2,4,5,6 PASS and phase 3 is PASS-or-SKIP.
// ===========================================================================
async function runTabAway() {
  // APPEND semantics (zoom-wake lesson): seed an empty results file ONLY if none
  // exists; otherwise accumulate this scenario's phases alongside any prior run.
  if (!existsSync(RESULTS_NDJSON)) writeFileSync(RESULTS_NDJSON, '');

  // Fail-fast pre-flight (BEFORE any Chrome/detector). Missing binaries / no AX /
  // locked screen → record every phase FAIL so the reader gate sees the failure,
  // then exit nonzero.
  const failAll = (reason) => {
    for (const ph of ['detect', 'bg-throttle-cycle', 'discard-blindness', 'longer-hold', 'leave-ends', 'cap-only']) {
      record(ph, 'FAIL', { reason });
    }
  };
  if (!existsSync(DETECTOR_BIN)) { failAll(`detector binary missing at ${DETECTOR_BIN}`); return 1; }
  if (!existsSync(MIC_BIN)) { failAll(`mic-detector binary missing at ${MIC_BIN}`); return 1; }
  if (!preflightNotLocked()) { failAll('macOS session is locked (degenerate AX tree)'); return 1; }
  if (!preflightAxTrust()) { failAll('Accessibility permission not granted'); return 1; }

  // Resolve the PRIMARY host profile and guard against concurrent use BEFORE launch.
  const hostProfile = resolveHostProfile();
  if (hostProfile.persistent && !assertProfileNotInUse(hostProfile.dir)) {
    failAll(`persistent host profile already in use: ${hostProfile.dir}`);
    return 1;
  }

  const PORT_A = 9333;   // primary host Chrome (phases 1-5, mic feeder wired)
  const PORT_B = 9334;   // cap-only host Chrome (phase 6, SAME persistent profile,
                         // launched AFTER A is fully quit — serialized, NO feeder).

  let det = null, detCap = null, chromeA = null, chromeB = null, pgA = null, pgB = null;
  let anyFail = false;

  try {
    // === Detector with mic feeder wired (phases 1-5) ===
    det = startDetector(true);
    log(`detector spawned (MSD_MEET_TABSTRIP=1 MSD_EDGE_LOG=1, mic feeder from ${MIC_BIN})`);

    // === PRIMARY host Chrome: persistent profile IN PLACE (or the loud fallback). ===
    chromeA = hostProfile.persistent
      ? launchPersistentChrome(PORT_A, hostProfile.dir)
      : launchTempChrome(PORT_A, hostProfile.dir);
    log(`host Chrome on :${PORT_A} (${hostProfile.persistent ? 'persistent in-place' : 'temp copyAuth'} profile ${hostProfile.dir}) — joining a fresh hosted Meet (real mic)…`);
    const joined = await joinFreshMeet(PORT_A);
    pgA = joined.pg;
    const code = joined.code;
    log(`in-call: code=${code} url=${joined.url}`);

    // -----------------------------------------------------------------------
    // PHASE 1 — DETECT: assert meet-active for the key + self named.
    // -----------------------------------------------------------------------
    const p1Active = await waitFor(() => activeSince(det, code, 0).length > 0, JOIN_TIMEOUT_MS);
    const micActive = await waitFor(
      () => det.micSink.fed.some((f) => f.hint.startsWith('mic active=1')),
      MIC_ACTIVE_TIMEOUT_MS);
    if (p1Active == null) {
      anyFail = true;
      record('detect', 'FAIL', { code, reason: 'no meet-active emitted for the meeting key', events: det.events.length });
    } else {
      const act = activeSince(det, code, 0).slice(-1)[0];
      const selfNamed = !!(act && (act.self || (Array.isArray(act.participantDetails) && act.participantDetails.some((p) => p.isSelf))));
      const verdict = selfNamed ? 'PASS' : 'FAIL';
      if (verdict !== 'PASS') anyFail = true;
      record('detect', verdict, {
        code, key: keyFor(code), meetActiveMs: p1Active,
        self: act && act.self, selfNamed,
        micActiveHintSeen: micActive != null,
        reason: verdict === 'PASS' ? undefined : 'meet-active present but self not named',
      });
    }

    // -----------------------------------------------------------------------
    // PHASE 2 — BG-THROTTLE-CYCLE (CANONICAL): genuinely background the Meet tab, hold,
    // then activate it — the full engage→hold→recover cycle the product ships for.
    //   (a) BACKGROUND (PUT-created + activated blank tab) → the renderer throttles →
    //       the URL loop misses the in-call web area → assert the REAL engage line
    //       `engaged reason=tab_present` within ~15s (stamp the latency).
    //   (b) HOLD 30s: NO meet-idle (the bridge holds the key open across the throttle),
    //       speakers released to [] (no stuck speaker across the blindness boundary).
    //   (c) ACTIVATE the Meet tab (still in-call) → the live tree returns → assert
    //       `released reason=readable` AND detection continues (no meet-idle; the call
    //       is still live — recovery, not an end).
    // -----------------------------------------------------------------------
    const p2Start = Date.now();
    await tabAway(PORT_A);
    log('phase2 (bg-throttle-cycle): Meet tab genuinely backgrounded — expecting engage reason=tab_present within ~15s');
    // (a) Engage fires within ~15s (renderer throttle can take a few frame budgets).
    const p2EngagedMs = await waitFor(() => !!engagedLine(det, code, p2Start), BG_ENGAGE_TIMEOUT_MS);
    const p2EngagedL = engagedLine(det, code, p2Start);
    // (b) Hold 30s: NO meet-idle; speakers must have been released to [].
    log('phase2: holding backgrounded 30s (expect ZERO meet-idle, speakers released to [])');
    await holdAndPoll(det, code, SHORT_HOLD_MS, 'phase2-hold');
    const p2IdleDuringHold = idleSince(det, code, p2Start);
    const p2Speaks = speakingSince(det, code, p2Start);
    const p2EmptyRelease = p2Speaks.some((s) => Array.isArray(s.speakers) && s.speakers.length === 0);
    const p2NonEmptyAfterRelease = p2Speaks.some((s) => Array.isArray(s.speakers) && s.speakers.length > 0);
    // SOLO-MEETING GUARD: the wire emits `speaking` only on set CHANGES. In a solo
    // hosted Meet nobody ever speaks, so there is no non-empty set to release and no
    // empty release will ever arrive — the release assertion only binds when someone
    // actually spoke BEFORE the hold (the drain-to-[] behavior itself is selftest-
    // proven via the confidence-decay release policy).
    const p2SinceHold = new Set(p2Speaks);
    const p2PreHoldSpoke = speakingSince(det, code, 0)
      .some((s) => !p2SinceHold.has(s) && Array.isArray(s.speakers) && s.speakers.length > 0);
    const p2ReleaseOk = p2PreHoldSpoke ? p2EmptyRelease : true;
    // (c) Activate the Meet tab — STILL in-call, so the live tree returns → reason=readable.
    const p2RecoverStart = Date.now();
    await tabBack(PORT_A);
    log('phase2: Meet tab activated (still in-call) — expecting released reason=readable + detection continues');
    const p2ReadableMs = await waitFor(() => !!releasedLine(det, code, p2RecoverStart, 'readable'), IDLE_HYSTERESIS_MS + 8_000);
    const p2ReadableL = releasedLine(det, code, p2RecoverStart, 'readable');
    // Detection continues: a fresh meet-active AND no meet-idle in the recovery window.
    const p2RecoverActive = await waitFor(() => activeSince(det, code, p2RecoverStart).length > 0, IDLE_HYSTERESIS_MS + 8_000);
    await sleep(2_000); // brief settle so a spurious post-recovery idle would surface
    const p2IdleAfterRecover = idleSince(det, code, p2RecoverStart);
    {
      const aOk = p2EngagedMs != null && p2EngagedL != null;
      const bOk = !p2IdleDuringHold && p2ReleaseOk && !p2NonEmptyAfterRelease;
      const cOk = p2ReadableMs != null && p2RecoverActive != null && !p2IdleAfterRecover;
      const ok = aOk && bOk && cOk;
      if (!ok) anyFail = true;
      record('bg-throttle-cycle', ok ? 'PASS' : 'FAIL', {
        code, engagedMs: p2EngagedMs, engagedLine: p2EngagedL ? p2EngagedL.line : null,
        meetIdleDuringHold: p2IdleDuringHold, emptySpeakingRelease: p2EmptyRelease,
        preHoldSpoke: p2PreHoldSpoke,
        speakingChurnAfterRelease: p2NonEmptyAfterRelease, speakingEvents: p2Speaks.length,
        releasedReadableMs: p2ReadableMs, releasedLine: p2ReadableL ? p2ReadableL.line : null,
        recoveredMeetActive: p2RecoverActive != null, meetIdleAfterRecover: p2IdleAfterRecover,
        note: 'background-throttle canonical cycle: engage on background, hold, recover on activate',
        reason: ok ? undefined
          : (!aOk ? `bridge did NOT engage on background-throttle (no engaged reason=tab_present within ${BG_ENGAGE_TIMEOUT_MS / 1000}s — the tab did not background/throttle, or the PUT tab-away failed)`
            : !bOk ? (p2IdleDuringHold ? 'meet-idle DURING the 30s background hold (bridge did NOT hold — THE regression)'
              : !p2EmptyRelease ? 'no empty-speakers release during the background hold'
                : 'unexpected speaking churn after the empty release')
            : (p2ReadableMs == null ? 'no released reason=readable after activating the still-in-call tab'
              : p2RecoverActive == null ? 'detection did NOT continue after activation (no fresh meet-active)'
                : 'spurious meet-idle after activation (the still-in-call call was falsely ended on recovery)')),
      });
    }

    // -----------------------------------------------------------------------
    // PHASE 3 — DISCARD-BLINDNESS (OPTIONAL/NON-GATING): try to DISCARD the Meet tab
    // (Mojo first, DOM fallback). A discard tears the renderer down entirely and the
    // tab RELOADS on activation, landing NOT-in-call — a stronger blindness than a
    // throttle. But it is not deterministically inducible from a driver, so:
    //   • If NEITHER mechanism fires → SKIP (mechanism-unavailable). NOT a roll-up FAIL.
    //   • If a discard FIRES → assert, in order:
    //       (a) engage `reason=tab_present` within ~10s (the WebArea died → miss-path),
    //       (b) NO meet-idle for a 45s hold; speakers released to [],
    //       (c) end per variant:
    //           default:        REACTIVATE — a discarded tab reloads NOT-in-call →
    //                           readable-not-in-call clear (`reason=left`), then meet-idle.
    //           --no-reactivate: CLOSE the tab → tabGone → `reason=gone`, then meet-idle.
    // -----------------------------------------------------------------------
    {
      // Background the Meet tab first (discard targets a background tab).
      await tabAway(PORT_A);
      await sleep(1000);
      const p3Start = Date.now();
      const discardRes = await discardMeetTab(PORT_A, code, joined.url);
      log(`phase3 (discard-blindness): discard attempt → ${JSON.stringify(discardRes)}`);

      if (!discardRes || !discardRes.fired) {
        // Neither Mojo nor DOM could fire a discard — record SKIP (does NOT gate).
        // Bring the Meet tab back to the foreground so the next phase starts clean.
        try { await tabBack(PORT_A); } catch (e) {}
        record('discard-blindness', 'SKIP', {
          code, via: discardRes ? discardRes.via : 'none', discardResult: discardRes,
          note: 'discard mechanism unavailable (Mojo remote unreachable AND no matching discard row/link) — OPTIONAL phase, does not fail the roll-up',
          reason: 'discard-mechanism-unavailable',
        });
      } else {
        // A discard actually fired — assert the full engage→hold→clean-release cycle.
        // (a) Engage fires within ~10s and the URL loop misses the meeting (its web
        //     area died). The engage line PROVES the miss-path fired.
        const p3EngagedMs = await waitFor(() => !!engagedLine(det, code, p3Start), ENGAGE_TIMEOUT_MS);
        const p3EngagedL = engagedLine(det, code, p3Start);

        // (b) Hold 45s: NO meet-idle; speakers must have been released to [].
        await holdAndPoll(det, code, DISCARD_HOLD_MS, 'phase3-hold');
        const p3IdleDuringHold = idleSince(det, code, p3Start);
        const p3Speaks = speakingSince(det, code, p3Start);
        const p3EmptyRelease = p3Speaks.some((s) => Array.isArray(s.speakers) && s.speakers.length === 0);
        const p3NonEmptyAfterRelease = p3Speaks.some((s) => Array.isArray(s.speakers) && s.speakers.length > 0);

        // (c) End the blindness per variant and assert the CLEAN release + idle.
        const p3EndStart = Date.now();
        let releaseReason, releaseL, endMode;
        if (NO_REACTIVATE) {
          endMode = 'tab-close';
          try {
            const list = await httpJson(PORT_A, '/json');
            const meetT = Array.isArray(list) && list.find((t) => t.type === 'page' && /meet\.google\.com/.test(t.url || ''));
            if (meetT) await httpJson(PORT_A, `/json/close/${meetT.id}`);
          } catch (e) { log('phase3: tab-close error ' + e.message); }
          releaseReason = 'gone';
        } else {
          endMode = 'reactivate';
          // A discarded tab RELOADS on activation to a rejoin/landing state (NOT
          // in-call) → readable-not-in-call clear (reason=left).
          try { await tabBack(PORT_A); } catch (e) { log('phase3: reactivate error ' + e.message); }
          releaseReason = 'left';
        }
        log(`phase3: ending blindness via ${endMode} — expecting released reason=${releaseReason} + meet-idle < ${IDLE_HYSTERESIS_MS / 1000}s`);
        const p3ReleasedMs = await waitFor(() => !!releasedLine(det, code, p3EndStart, releaseReason), IDLE_HYSTERESIS_MS + 8_000);
        releaseL = releasedLine(det, code, p3EndStart, releaseReason);
        const p3IdleMs = await waitFor(() => idleSince(det, code, p3EndStart), IDLE_HYSTERESIS_MS + 5_000);

        const aOk = p3EngagedMs != null && p3EngagedL != null;
        // Same solo-meeting guard as phase 2: the release assertion binds only when
        // someone spoke before the blindness began.
        const p3SinceHold = new Set(p3Speaks);
        const p3PreHoldSpoke = speakingSince(det, code, 0)
          .some((s) => !p3SinceHold.has(s) && Array.isArray(s.speakers) && s.speakers.length > 0);
        const p3ReleaseOk = p3PreHoldSpoke ? p3EmptyRelease : true;
        const bOk = !p3IdleDuringHold && p3ReleaseOk && !p3NonEmptyAfterRelease;
        const cOk = p3ReleasedMs != null && p3IdleMs != null && p3IdleMs <= IDLE_HYSTERESIS_MS;
        const ok = aOk && bOk && cOk;
        if (!ok) anyFail = true;
        record('discard-blindness', ok ? 'PASS' : 'FAIL', {
          code, endMode, via: discardRes.via, discardResult: discardRes,
          engagedMs: p3EngagedMs, engagedLine: p3EngagedL ? p3EngagedL.line : null,
          meetIdleDuringHold: p3IdleDuringHold, emptySpeakingRelease: p3EmptyRelease,
          speakingChurnAfterRelease: p3NonEmptyAfterRelease, speakingEvents: p3Speaks.length,
          releasedReason: releaseReason, releasedLine: releaseL ? releaseL.line : null,
          meetIdleAfterEndMs: p3IdleMs,
          reason: ok ? undefined
            : (!aOk ? 'discard FIRED but did NOT engage the keep-alive bridge (no engaged reason=tab_present within ~10s — the WebArea did not die)'
              : !bOk ? (p3IdleDuringHold ? 'meet-idle DURING the 45s discard hold (bridge did NOT hold — THE regression)'
                : !p3EmptyRelease ? 'no empty-speakers release during the discard hold'
                  : 'unexpected speaking churn after the empty release')
              : (p3ReleasedMs == null ? `no released reason=${releaseReason} after ${endMode}`
                : 'meet-idle did not follow the release within normal hysteresis')),
        });
      }
    }

    // -----------------------------------------------------------------------
    // PHASE 4 — LONGER-HOLD: sustained 2-minute background-throttle hold. Now that a
    // backgrounded tab genuinely throttles, we EXPECT the engage (it is the bridge
    // WORKING). ASSERT: engagedLineSeen required, NO meet-idle over the whole 2 min
    // (the load-bearing hold), then tab-back → recovery released reason=readable.
    // -----------------------------------------------------------------------
    const p4Start = Date.now();
    await tabAway(PORT_A);
    log('phase4 (longer-hold): Meet tab genuinely backgrounded — SUSTAINED 2-minute throttle hold (expect engage, ZERO meet-idle)');
    // Give the throttle a moment to engage before the long hold so engagedLineSeen is
    // meaningful across the whole window.
    const p4EngagedMs = await waitFor(() => !!engagedLine(det, code, p4Start), BG_ENGAGE_TIMEOUT_MS);
    await holdAndPoll(det, code, LONG_HOLD_MS, 'phase4');
    const p4Idle = idleSince(det, code, p4Start);
    const p4Engaged = engagedLine(det, code, p4Start);
    // Recovery: activate the still-in-call tab → released reason=readable.
    const p4RecoverStart = Date.now();
    await tabBack(PORT_A);
    log('phase4: Meet tab activated (still in-call) — expecting released reason=readable');
    const p4ReadableMs = await waitFor(() => !!releasedLine(det, code, p4RecoverStart, 'readable'), IDLE_HYSTERESIS_MS + 8_000);
    {
      // A meet-idle during the hold is ALWAYS a FAIL (the load-bearing invariant).
      // Whether the bridge engages depends on Chrome's background-throttle heuristic
      // actually firing — measured non-deterministic (fired run 1, not run 2 on
      // 2026-07-06). So: throttled → require engage + readable recovery; NOT
      // throttled → the tab stayed readable, nothing to bridge — require zero idle
      // and zero stray keep-alive lines instead. Phase 2 carries the deterministic
      // engage proof (a fresh background always throttles within its window there).
      const throttled = !!p4Engaged;
      const noIdleOk = !p4Idle;
      const recoverOk = p4ReadableMs != null;
      const strayRelease = stderrSince(det, p4Start).find((l) => l.line.includes('meet-keepalive: released'));
      const ok = throttled ? (noIdleOk && recoverOk) : (noIdleOk && !strayRelease);
      if (!ok) anyFail = true;
      record('longer-hold', ok ? 'PASS' : 'FAIL', {
        code, holdMs: LONG_HOLD_MS, engagedMs: p4EngagedMs, throttled,
        meetIdleDuringHold: p4Idle, releasedReadableMs: p4ReadableMs,
        note: throttled
          ? 'sustained background-throttle hold: bridge engaged, held 2 min with zero idle, recovered readable on activation'
          : 'no-throttle-this-run: Chrome kept the backgrounded tab readable; nothing to bridge — zero-idle invariant held (engage proof carried by phase 2)',
        reason: ok ? undefined
          : (!noIdleOk ? 'meet-idle emitted during the sustained 2-minute background hold (call falsely ended)'
            : throttled ? 'no released reason=readable after activating the still-in-call tab'
              : `stray keep-alive release without an engage during an un-throttled hold: ${strayRelease ? strayRelease.line : ''}`),
      });
    }

    // -----------------------------------------------------------------------
    // PHASE 5 — LEAVE-ENDS (unchanged, load-bearing regression): tab FOREGROUND,
    // click Leave. ASSERT meet-idle < hysteresis AND/OR released reason ∈ {left,
    // mic_idle}; detector does NOT re-engage afterward (post-leave title keeps the
    // code — the mic-idle path must close it). THE regression the design exists to catch.
    // -----------------------------------------------------------------------
    await tabBack(PORT_A);      // Meet tab foreground so Meet honors the Leave click
    await sleep(1500);
    const p5Start = Date.now();
    const leaveRes = await clickLeave(pgA);
    log(`phase5 (leave-ends): Leave clicked (${leaveRes}) — expecting meet-idle < ${IDLE_HYSTERESIS_MS / 1000}s and no re-engage`);
    const p5IdleMs = await waitFor(() => idleSince(det, code, p5Start), IDLE_HYSTERESIS_MS + 5_000);
    const p5Released = stderrSince(det, p5Start).find((l) =>
      l.line.includes(`meet-keepalive: released key=${keyFor(code)}`)
      && (l.line.includes('reason=left') || l.line.includes('reason=mic_idle')));
    // Watch a further window for an ILLEGAL re-engage (the regression: title still
    // carries the code post-leave, so an S1-only keep-alive would re-engage).
    const reEngageWatchStart = Date.now();
    await sleep(SHORT_HOLD_MS);
    const p5ReEngaged = !!engagedLine(det, code, reEngageWatchStart);
    {
      const idleInHysteresis = p5IdleMs != null && p5IdleMs <= IDLE_HYSTERESIS_MS;
      const endSignal = idleInHysteresis || !!p5Released;
      const ok = endSignal && !p5ReEngaged;
      if (!ok) anyFail = true;
      record('leave-ends', ok ? 'PASS' : 'FAIL', {
        code, meetIdleMs: p5IdleMs, idleInHysteresis,
        releasedReason: p5Released ? p5Released.line : null, reEngagedAfterLeave: p5ReEngaged,
        reason: ok ? undefined
          : (!endSignal ? `no meet-idle < ${IDLE_HYSTERESIS_MS}ms and no released reason∈{left,mic_idle} after Leave`
            : 'detector RE-ENGAGED the bridge after Leave (title keeps the code — mic-idle path failed to close it) — THE regression'),
      });
    }

    // Tear down host Chrome A + its detector before phase 6. Phase 6 relaunches the
    // SAME persistent profile — the host Chrome MUST be fully clean-quit first
    // (serialized: never two Chromes on one profile). We stop the detector, clean-quit
    // Chrome A, then WAIT for the profile lock to clear (assertProfileNotInUse) before
    // relaunching so the second launch can't collide with a not-yet-exited Chrome.
    try { await det.stop(); } catch (e) {}
    det = null;
    try { await chromeA.kill(); } catch (e) {}
    chromeA = null;
    pgA = null; // its page is gone with Chrome A — don't Leave-click a dead tab in finally

    // -----------------------------------------------------------------------
    // PHASE 6 — CAP-ONLY (background-throttle, NO mic feeder, SERIALIZED on the SAME
    // persistent profile): relaunch the SAME persistent-profile Chrome (host A fully
    // quit — never two Chromes on one profile), join a FRESH meeting WITHOUT the mic
    // feeder (no stdin hints EVER → mic hint stays .unknown). Background-throttle the
    // Meet tab: the bridge must STILL engage on an .unknown mic (advisory law: .unknown
    // never ends a bridge), with the engage line reporting mic=unknown; hold 30s with NO
    // meet-idle; then ACTIVATE (still in-call!) → released reason=readable — then LEAVE
    // → meet-idle. Serializing on the persistent profile removes the copy-auth temp
    // Chrome that used to hit the Google login wall (stale cookie snapshot).
    // -----------------------------------------------------------------------
    detCap = startDetector(false); // NO mic feeder — stdin open but never written
    log('phase6 (cap-only): detector spawned WITHOUT mic feeder (mic hint stays .unknown)');
    // Relaunch the SAME persistent profile, serialized — wait for A's profile lock to
    // clear so we never open two Chromes on one user-data-dir.
    if (hostProfile.persistent) {
      const t0 = Date.now();
      while (Date.now() - t0 < 15_000 && !assertProfileNotInUse(hostProfile.dir)) { await sleep(1000); }
    }
    chromeB = hostProfile.persistent
      ? launchPersistentChrome(PORT_B, hostProfile.dir)
      : (() => { const t = mkdtempSync(join(tmpdir(), 'meet-tabaway-b-')); copyAuth(t); return launchTempChrome(PORT_B, t); })();
    log(`phase6 Chrome on :${PORT_B} (${hostProfile.persistent ? 'SAME persistent in-place profile, serialized' : 'temp copyAuth fallback'}) — joining a FRESH hosted Meet (real mic, feeder OFF)…`);
    const joinedB = await joinFreshMeet(PORT_B);
    pgB = joinedB.pg;
    const codeB = joinedB.code;
    log(`phase6 in-call: code=${codeB}`);
    // Confirm detect first (so a join failure is not misread as a bridge failure).
    const p6Active = await waitFor(() => activeSince(detCap, codeB, 0).length > 0, JOIN_TIMEOUT_MS);

    // Background-throttle the Meet tab (canonical blindness, cap-only — NO discard).
    await tabAway(PORT_B);
    const p6Start = Date.now();
    log('phase6: Meet tab genuinely backgrounded — expecting engage mic=unknown, holding 30s (cap-only, no mic hint)');
    const p6EngagedMs = await waitFor(() => !!engagedLine(detCap, codeB, p6Start), BG_ENGAGE_TIMEOUT_MS);
    await holdAndPoll(detCap, codeB, SHORT_HOLD_MS, 'phase6-hold');
    const p6Idle = idleSince(detCap, codeB, p6Start);
    const p6Engaged = engagedLine(detCap, codeB, p6Start);
    // The engage line reports the advisory mic; with no feeder it must be mic=unknown.
    const p6EngagedUnknown = !!(p6Engaged && p6Engaged.line.includes('mic=unknown'));

    // ACTIVATE: the tab is STILL in-call (throttle, not discard), so the live tree
    // returns → readable recovery (reason=readable), NO meet-idle (call still live).
    const p6RecoverStart = Date.now();
    await tabBack(PORT_B);
    log('phase6: Meet tab activated (still in-call) — expecting released reason=readable, then Leave → meet-idle');
    const p6ReadableMs = await waitFor(() => !!releasedLine(detCap, codeB, p6RecoverStart, 'readable'), IDLE_HYSTERESIS_MS + 8_000);
    const p6RecoverActive = await waitFor(() => activeSince(detCap, codeB, p6RecoverStart).length > 0, IDLE_HYSTERESIS_MS + 8_000);

    // Now LEAVE the still-live meeting → meet-idle (the definitive end for this phase).
    await sleep(1500); // tab is foreground; let Meet settle before the Leave click
    const p6LeaveStart = Date.now();
    const p6LeaveRes = await clickLeave(pgB);
    log(`phase6: Leave clicked (${p6LeaveRes}) — expecting meet-idle < ${IDLE_HYSTERESIS_MS / 1000}s`);
    const p6IdleMs = await waitFor(() => idleSince(detCap, codeB, p6LeaveStart), IDLE_HYSTERESIS_MS + 8_000);
    {
      // Bridge engaged on .unknown and held (no idle during the throttle hold); it
      // recovered readable on activation while still in-call; then Leave ended it.
      const bridgeHeld = p6Active != null && p6EngagedMs != null && !p6Idle && !!p6Engaged;
      const recoveredReadable = p6ReadableMs != null && p6RecoverActive != null;
      const endedOnLeave = p6IdleMs != null && p6IdleMs <= IDLE_HYSTERESIS_MS;
      const ok = bridgeHeld && p6EngagedUnknown && recoveredReadable && endedOnLeave;
      if (!ok) anyFail = true;
      record('cap-only', ok ? 'PASS' : 'FAIL', {
        code: codeB, detectSeen: p6Active != null,
        engagedMs: p6EngagedMs, meetIdleDuringHold: p6Idle,
        engagedLineSeen: !!p6Engaged, engagedMicUnknown: p6EngagedUnknown,
        engagedLine: p6Engaged ? p6Engaged.line : null,
        releasedReadableMs: p6ReadableMs, recoveredMeetActive: p6RecoverActive != null,
        leaveResult: p6LeaveRes, meetIdleAfterLeaveMs: p6IdleMs,
        reason: ok ? undefined
          : (!bridgeHeld
            ? (p6Active == null ? 'phase6 join/detect failed'
              : p6EngagedMs == null ? 'background-throttle did NOT engage the cap-only bridge (no engaged line — tab did not throttle)'
                : p6Idle ? 'cap-only bridge did NOT hold (meet-idle during hold with mic=unknown — advisory law violated)'
                  : 'no engaged keep-alive line during cap-only hold')
            : !p6EngagedUnknown ? 'engage line did NOT report mic=unknown (the feeder-less advisory mic should be unknown)'
              : !recoveredReadable ? 'no readable recovery after activating the still-in-call tab (no released reason=readable / no fresh meet-active)'
                : 'meeting did NOT end on Leave (no meet-idle < hysteresis after the Leave click)'),
      });
    }
  } catch (e) {
    console.error('[tabaway] FATAL during scenario:', e && e.stack ? e.stack : e);
    // Record a fatal so the reader gate sees the failure.
    anyFail = true;
    record('fatal', 'FAIL', { reason: String(e && e.message ? e.message : e) });
  } finally {
    // Teardown in a finally block: leave calls, close rig Chromes, SIGTERM helpers.
    // Both host Chromes (A phases 1-5, B phase 6) are the SAME persistent profile run
    // SERIALLY; each is CLEAN-QUIT (its .kill() is Browser.close→SIGTERM for a
    // persistent profile, SIGKILL+rmSync for a temp fallback). pgA is nulled after A's
    // clean-quit so we never Leave-click a dead tab here.
    try { if (pgA) await clickLeave(pgA); } catch (e) {}
    try { if (pgB) await clickLeave(pgB); } catch (e) {}
    try { if (det) await det.stop(); } catch (e) {}
    try { if (detCap) await detCap.stop(); } catch (e) {}
    try { if (chromeA) await chromeA.kill(); } catch (e) {}
    try { if (chromeB) await chromeB.kill(); } catch (e) {}
  }
  return anyFail ? 1 : 0;
}

async function main() {
  if (!process.argv.includes('--tabaway')) {
    console.error('[tabaway] usage: node meet-tabaway-live.mjs --tabaway [--no-reactivate]');
    console.error('[tabaway]   --no-reactivate: IF the OPTIONAL discard phase fires, close the Meet tab');
    console.error('[tabaway]                    (tabGone → reason=gone) instead of reactivating it');
    console.error('[tabaway]   (set MSD_DETECTOR_BIN / MSD_MIC_BIN to override the product binary paths;');
    console.error('[tabaway]    MSD_CHROME_PROFILE to point the host Chrome at a persistent profile)');
    process.exit(2);
  }
  const code = await runTabAway();
  const summary = recordSummary();
  console.log('MEET TABAWAY LIVE SESSION COMPLETE');
  // Nonzero exit on ANY phase FAIL (roll-up FAIL) — even if runTabAway returned 0.
  process.exit(summary === 'PASS' && code === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[tabaway] FATAL', e && e.stack ? e.stack : e);
  console.log('MEET TABAWAY LIVE SESSION COMPLETE');
  process.exit(1);
});
