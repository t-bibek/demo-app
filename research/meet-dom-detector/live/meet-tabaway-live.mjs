#!/usr/bin/env node
// ---------------------------------------------------------------------------
// meet-tabaway-live (v2) — LIVE-QA rig for the Meet TAB-AWAY KEEP-ALIVE bridge.
//
// This is the LIVE counterpart of the pure MeetKeepAliveRules unit matrix: it
// drives a REAL hosted Google Meet in a real-mic rig Chrome and asserts the
// product detector's tab-away bridge (MeetTabStripKeepAlive) holds the meeting
// key open across a blindness window instead of tripping idle hysteresis — then
// that a CLEAN end signal (rejoin-landing clear, tab close, or mic-idle) is what
// actually releases it.
//
// WHY DISCARD IS THE CANONICAL BLINDNESS (finding of 2026-07-06, self-contained)
// -----------------------------------------------------------------------------
// The v1 rig backgrounded the Meet tab with a quick tab-switch and expected the
// deep AXWebArea to go trivial (no tiles/roster/Leave). The B4 live pass proved
// that assumption FALSE: a Chrome whose accessibility was WOKEN while the meeting
// was readable keeps BACKGROUNDED tabs' AX trees MATERIALIZED. A plain tab-switch
// never blinds the probe, so the keep-alive bridge NEVER ENGAGED under the old
// rig — the observational hold correctly saw "bridge dormant" and there was no
// engage→hold→release cycle to gate.
//
// The REAL production blindness is Chrome DISCARDING / FREEZING background tabs
// (memory saver). A discarded tab's renderer is torn down: its Meet WebArea dies
// entirely and the detector's URL loop can no longer find a meet.google.com/ web
// area at all — the true `tabPresent` (label survives in the strip, WebArea gone)
// miss-path that the bridge exists to cover. Discard is DETERMINISTICALLY
// inducible via chrome://discards, so THIS is the canonical blindness this rig
// drives (phase 3), with the old tab-switch kept as an observational "woken Chrome
// stays readable; bridge correctly dormant" control (phase 2).
//
// THE REAL KEEP-ALIVE VOCABULARY (verbatim from GoogleMeetProbe.swift, 2026-07-06)
// -------------------------------------------------------------------------------
// Every assertion below is grounded in what the SHIPPING binary actually composes
// at runtime — NOT the v1 rig's assumed vocabulary (which mis-asserted reasons the
// binary never emits). The two format sites (GoogleMeetProbe.swift:215-216 engage,
// :219-221 release) and the four release reasons are:
//   engaged:  `meet-keepalive: engaged key=meet:<code> reason=tab_present mic=<m>`
//             where <m> ∈ { browser_active | global_idle | unknown }   (:208-217)
//   released: `meet-keepalive: released key=meet:<code> reason=<r>`      (:219-221)
//             reason literals, one per emit site:
//               readable  — readable path recovered the live tree  (:104)
//               left      — a Meet WebArea is readable but NOT in-call: the call
//                           ended / the tab landed on a rejoin page (:123)
//               gone      — miss-path .end, state==.tabGone: tab closed (:178,:181)
//               mic_idle  — miss-path .end, mic==.globalIdle && sawBrowserMic (:179)
//               expired   — miss-path .end, cap expired, no positive liveness (:179)
// The engage reason is ALWAYS `tab_present` (there is no `reason=readable` engage —
// v1's phase comments implied otherwise). A foreground Leave releases with
// `reason=left` (readable-not-in-call clear), NOT `reason=mic_idle`.
//
// It exercises the REAL signal chain minus the desktop TS layer: the product
// bubbles-mic-detector is spawned as the actual OS-mic source, and its
// MIC_ACTIVE/MIC_IDLE lines are transformed into the detector's stdin mic-hint
// protocol (`mic active=0|1 bundle=<id|->`) and written to the detector's stdin.
//
//   node research/meet-dom-detector/live/meet-tabaway-live.mjs --tabaway
//   node research/meet-dom-detector/live/meet-tabaway-live.mjs --tabaway --no-reactivate
//     (discard phase closes the Meet tab instead of reactivating it — tabGone path)
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
// with that exact user-data-dir (ps match), we FAIL FAST. Phases that need a
// SECOND simultaneous Chrome (none in v2 — the discard cycle is single-Chrome)
// keep temp profiles.
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
const { attachToPage, httpJson, sleep } = require('./cdp-lib.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_NDJSON = join(HERE, 'live-qa-results.ndjson');
const SCENARIO = 'meet-tabaway-live';

// --no-reactivate: the discard phase CLOSES the Meet tab (tabGone → reason=gone)
// instead of reactivating it. Default reactivates (readable-not-in-call → reason=left).
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
const SHORT_HOLD_MS = 30_000;    // phases 2 & 6 observational / cap-only hold
const DISCARD_HOLD_MS = 45_000;  // phase 3 blindness hold (no meet-idle for 45s)
const LONG_HOLD_MS = 120_000;    // phase 4 sustained observational hold
const STDERR_POLL_MS = 3_000;    // cadence for polling stderr during a hold
const IDLE_HYSTERESIS_MS = 10_000; // meet-idle must arrive within normal hysteresis
const ENGAGE_TIMEOUT_MS = 12_000;  // discard → detector misses meeting + engages (~10s)
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

// Aggregate roll-up: PASS only when EVERY recorded phase passed. Written LAST under
// the bare `meet-tabaway-live` scenario id so live-scenario-verdict.mjs gates on it.
function recordSummary() {
  const failed = phaseVerdicts.filter((p) => p.verdict !== 'PASS').map((p) => p.phase);
  const verdict = phaseVerdicts.length > 0 && failed.length === 0 ? 'PASS' : 'FAIL';
  const line = JSON.stringify({
    scenario: SCENARIO, verdict, ts: nowSec(),
    phases: phaseVerdicts, failedPhases: failed,
    reason: verdict === 'PASS' ? undefined : `failed phases: ${failed.join(', ') || '(no phases ran)'}`,
  });
  appendFileSync(RESULTS_NDJSON, line + '\n');
  log(`RESULT ${SCENARIO} (roll-up): ${verdict}` + (failed.length ? ` — failed: ${failed.join(', ')}` : ''));
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
  await httpJson(port, '/json/new?about:blank');
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

// DISCARD the Meet tab via chrome://discards (phase 3 — the CANONICAL blindness).
//
// APPROACH IMPLEMENTED: drive the chrome://discards page UI. Open a helper tab at
// chrome://discards, then in its (shadow-DOM) tab-discard table find the ROW whose
// title/URL cell contains the meeting code/URL and click that row's "Discard" action
// link. chrome://discards renders `<discards-main-view>` → shadow `<discards-tab-discard-info>`
// → a `<table>` whose rows expose per-tab "Discard" / "Urgent Discard" `<a is="action-link">`
// controls; we deep-query the shadow tree, match the row, and .click() the discard link.
//
// ALTERNATIVE (noted, NOT implemented): if the clickable rows prove brittle across
// Chrome versions, chrome://discards exposes a Mojo bridge on the page — the
// `discardById(sessionId)` / `discardUrgentById(sessionId)` remotes on the page's
// `uiHandler` (window-scoped in the discards page bundle). One could enumerate the
// discards infos (each carries an `id`), match by `.title`/`.tabUrl`, and call the
// remote directly, bypassing the DOM. We drive the DOM here because it needs no
// knowledge of the internal Mojo symbol names; the Mojo path is the fallback if a
// future Chrome reshapes the table markup.
async function discardMeetTab(port, code, meetUrl) {
  // Open the discards helper tab and attach to it.
  await httpJson(port, '/json/new?chrome://discards');
  const dpg = await attachToPage(port, /chrome:\/\/discards/);
  // Give the tab-discard table a moment to render its rows.
  await sleep(1500);
  // Deep shadow-DOM walk: collect every <tr>, find the one naming this meeting, click
  // its Discard link. Returns a small status object for the verdict detail.
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
    if(!target) return {ok:false, reason:'no-matching-row', rowCount:rows.length};
    var links = target.querySelectorAll('a');
    var disc = null;
    for (var k=0;k<links.length;k++){ if(/^\\s*Discard\\s*$/i.test(links[k].textContent||'')){ disc = links[k]; break; } }
    // Fall back to the first "Urgent Discard" if a plain "Discard" is absent.
    if(!disc){ for (var m=0;m<links.length;m++){ if(/Discard/i.test(links[m].textContent||'')){ disc = links[m]; break; } } }
    if(!disc) return {ok:false, reason:'no-discard-link', linkCount:links.length};
    disc.click();
    return {ok:true, clicked:(disc.textContent||'').trim()};
  })()`;
  const res = await dpg.evalJs(clickExpr);
  return res;
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
// PHASES (v2, renumbered):
//   1  detect            — meet-active for the key + self named (unchanged shape).
//   2  bg-hold-dormant   — OBSERVATIONAL: quick tab-switch backgrounds the Meet tab;
//                          a WOKEN Chrome keeps its AX tree materialized, so the probe
//                          stays readable. Assert NO engage AND NO meet-idle: the
//                          bridge is correctly DORMANT (documents the B4 finding).
//   3  discard-blindness — CANONICAL: discard the Meet tab via chrome://discards.
//                          Assert the full engage→hold→clean-release cycle with the
//                          REAL vocabulary (see below). The `--no-reactivate` variant
//                          closes the tab (tabGone → reason=gone) instead.
//   4  longer-hold       — OBSERVATIONAL: sustained 2-min quick-tab-away; same as
//                          phase 2, still dormant, no meet-idle (load-bearing no-idle).
//   5  leave-ends        — LEAVE regression (unchanged assertions — it passed and is
//                          load-bearing): foreground Leave → meet-idle < hysteresis
//                          and NO re-engage (post-leave title keeps the code).
//   6  cap-only          — DISCARD path WITHOUT the mic feeder (hint stays .unknown):
//                          bridge holds on unknown, then REACTIVATION ends it.
// ===========================================================================
async function runTabAway() {
  // APPEND semantics (zoom-wake lesson): seed an empty results file ONLY if none
  // exists; otherwise accumulate this scenario's phases alongside any prior run.
  if (!existsSync(RESULTS_NDJSON)) writeFileSync(RESULTS_NDJSON, '');

  // Fail-fast pre-flight (BEFORE any Chrome/detector). Missing binaries / no AX /
  // locked screen → record every phase FAIL so the reader gate sees the failure,
  // then exit nonzero.
  const failAll = (reason) => {
    for (const ph of ['detect', 'bg-hold-dormant', 'discard-blindness', 'longer-hold', 'leave-ends', 'cap-only']) {
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
  const PORT_B = 9334;   // second fresh Chrome (phase 6, cap-only, NO feeder)

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
    // PHASE 2 — BG-HOLD-DORMANT (observational control): quick tab-switch, hold 30s.
    // The B4 finding: a WOKEN Chrome keeps a backgrounded tab's AX tree materialized,
    // so the probe STAYS readable and the bridge stays correctly DORMANT. ASSERT:
    //   • NO meet-idle for the key (call stays live — probe never blinded), AND
    //   • NO engage line (bridge never needed to engage — nothing to bridge over).
    // -----------------------------------------------------------------------
    const p2Start = Date.now();
    await tabAway(PORT_A);
    log('phase2 (bg-hold-dormant): Meet tab backgrounded via quick tab-switch — holding 30s (expect DORMANT bridge)');
    await holdAndPoll(det, code, SHORT_HOLD_MS, 'phase2');
    const p2Idle = idleSince(det, code, p2Start);
    const p2Engaged = engagedLine(det, code, p2Start);
    {
      // Dormant bridge: no idle (probe stayed readable) AND no engage (nothing to bridge).
      const ok = !p2Idle && !p2Engaged;
      if (!ok) anyFail = true;
      record('bg-hold-dormant', ok ? 'PASS' : 'FAIL', {
        code, meetIdleDuringHold: p2Idle, engagedLineSeen: !!p2Engaged,
        note: 'woken Chrome stays readable while backgrounded; bridge correctly dormant',
        reason: ok ? undefined
          : (p2Idle ? 'meet-idle during a plain background hold (probe blinded unexpectedly — NOT the discard path)'
            : 'bridge ENGAGED on a plain background hold (a woken Chrome should stay readable — bridge should be dormant)'),
      });
    }
    await tabBack(PORT_A); // restore foreground before the discard phase

    // -----------------------------------------------------------------------
    // PHASE 3 — DISCARD-INDUCED BLINDNESS (the canonical engage→hold→clean-release):
    // background the Meet tab, then DISCARD it via chrome://discards. The renderer is
    // torn down → the Meet WebArea dies → the URL loop can no longer find a
    // meet.google.com/ area (the true tabPresent miss-path). ASSERT, in order:
    //   (a) within ~10s the URL loop MISSES the meeting AND the REAL engage line fires
    //       (`meet-keepalive: engaged key=meet:<code> reason=tab_present mic=<m>`),
    //   (b) NO meet-idle for a 45s hold; speakers released to [],
    //   (c) then per variant:
    //       default:        REACTIVATE the Meet tab — it reloads to a rejoin/landing
    //                       state (NOT in-call) → readable-not-in-call clear
    //                       (`reason=left`), then meet-idle < hysteresis.
    //       --no-reactivate: CLOSE the Meet tab → tabGone → `reason=gone`, then idle.
    // -----------------------------------------------------------------------
    {
      // Background the Meet tab first (discard targets a background tab).
      await tabAway(PORT_A);
      await sleep(1000);
      const p3Start = Date.now();
      const discardRes = await discardMeetTab(PORT_A, code, joined.url);
      log(`phase3 (discard-blindness): chrome://discards discard → ${JSON.stringify(discardRes)}`);

      // (a) Engage fires within ~10s and the URL loop misses the meeting (no fresh
      //     meet-active for the discarded tab — its web area died). The engage line
      //     PROVES the miss-path fired (the bridge only engages when the WebArea is
      //     gone but the tab label survives).
      const p3EngagedMs = await waitFor(() => !!engagedLine(det, code, p3Start), ENGAGE_TIMEOUT_MS);
      const p3EngagedL = engagedLine(det, code, p3Start);

      // (b) Hold 45s: NO meet-idle; speakers must have been released to [].
      const t3 = await holdAndPoll(det, code, DISCARD_HOLD_MS, 'phase3-hold');
      const p3IdleDuringHold = idleSince(det, code, p3Start);
      const p3Speaks = speakingSince(det, code, p3Start);
      const p3EmptyRelease = p3Speaks.some((s) => Array.isArray(s.speakers) && s.speakers.length === 0);
      const p3NonEmptyAfterRelease = p3Speaks.some((s) => Array.isArray(s.speakers) && s.speakers.length > 0);

      // (c) End the blindness per variant and assert the CLEAN release + idle.
      const p3EndStart = Date.now();
      let releaseReason, releaseL, endMode;
      if (NO_REACTIVATE) {
        endMode = 'tab-close';
        // Close the Meet tab entirely → tabGone → reason=gone.
        try {
          const list = await httpJson(PORT_A, '/json');
          const meetT = Array.isArray(list) && list.find((t) => t.type === 'page' && /meet\.google\.com/.test(t.url || ''));
          if (meetT) await httpJson(PORT_A, `/json/close/${meetT.id}`);
        } catch (e) { log('phase3: tab-close error ' + e.message); }
        releaseReason = 'gone';
      } else {
        endMode = 'reactivate';
        // Reactivate the Meet tab — a discarded tab RELOADS on activation to a
        // rejoin/landing state (NOT in-call) → readable-not-in-call clear.
        try { await tabBack(PORT_A); } catch (e) { log('phase3: reactivate error ' + e.message); }
        releaseReason = 'left';
      }
      log(`phase3: ending blindness via ${endMode} — expecting released reason=${releaseReason} + meet-idle < ${IDLE_HYSTERESIS_MS / 1000}s`);
      const p3ReleasedMs = await waitFor(() => !!releasedLine(det, code, p3EndStart, releaseReason), IDLE_HYSTERESIS_MS + 8_000);
      releaseL = releasedLine(det, code, p3EndStart, releaseReason);
      const p3IdleMs = await waitFor(() => idleSince(det, code, p3EndStart), IDLE_HYSTERESIS_MS + 5_000);

      const aOk = p3EngagedMs != null && p3EngagedL != null;
      const bOk = !p3IdleDuringHold && p3EmptyRelease && !p3NonEmptyAfterRelease;
      const cOk = p3ReleasedMs != null && p3IdleMs != null && p3IdleMs <= IDLE_HYSTERESIS_MS;
      const ok = aOk && bOk && cOk;
      if (!ok) anyFail = true;
      record('discard-blindness', ok ? 'PASS' : 'FAIL', {
        code, endMode, discardResult: discardRes,
        engagedMs: p3EngagedMs, engagedLine: p3EngagedL ? p3EngagedL.line : null,
        meetIdleDuringHold: p3IdleDuringHold, emptySpeakingRelease: p3EmptyRelease,
        speakingChurnAfterRelease: p3NonEmptyAfterRelease, speakingEvents: p3Speaks.length,
        releasedReason: releaseReason, releasedLine: releaseL ? releaseL.line : null,
        meetIdleAfterEndMs: p3IdleMs,
        reason: ok ? undefined
          : (!aOk ? 'discard did NOT engage the keep-alive bridge (no engaged reason=tab_present within ~10s — the WebArea did not die / discard failed)'
            : !bOk ? (p3IdleDuringHold ? 'meet-idle DURING the 45s discard hold (bridge did NOT hold — THE regression)'
              : !p3EmptyRelease ? 'no empty-speakers release during the discard hold'
                : 'unexpected speaking churn after the empty release')
            : (p3ReleasedMs == null ? `no released reason=${releaseReason} after ${endMode}`
              : 'meet-idle did not follow the release within normal hysteresis')),
      });
    }

    // -----------------------------------------------------------------------
    // PHASE 4 — LONGER-HOLD (observational): sustained 2-minute quick tab-away.
    // Same as phase 2 (woken Chrome stays readable), SUSTAINED. The load-bearing
    // assertion is NO meet-idle over the whole 2 minutes (the bridge stays dormant
    // and the probe stays readable — the call never falsely ends).
    // -----------------------------------------------------------------------
    const p4Start = Date.now();
    await tabAway(PORT_A);
    log('phase4 (longer-hold): Meet tab backgrounded again — SUSTAINED 2-minute observational hold');
    await holdAndPoll(det, code, LONG_HOLD_MS, 'phase4');
    const p4Idle = idleSince(det, code, p4Start);
    const p4Engaged = engagedLine(det, code, p4Start);
    {
      // No-idle is the load-bearing assertion. On a woken Chrome the bridge stays
      // dormant (no engage) too; we tolerate an engage if this Chrome happened to
      // throttle, but a meet-idle is always a FAIL (the call must never falsely end).
      const ok = !p4Idle;
      if (!ok) anyFail = true;
      record('longer-hold', ok ? 'PASS' : 'FAIL', {
        code, holdMs: LONG_HOLD_MS, meetIdleDuringHold: p4Idle, engagedLineSeen: !!p4Engaged,
        note: 'sustained background hold on a woken Chrome; probe stays readable, call never falsely ends',
        reason: ok ? undefined : 'meet-idle emitted during the sustained 2-minute background hold (call falsely ended)',
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

    // Tear down host Chrome A + its detector before phase 6 (fresh, feeder-less run).
    try { await det.stop(); } catch (e) {}
    det = null;
    try { await chromeA.kill(); } catch (e) {}
    chromeA = null;

    // -----------------------------------------------------------------------
    // PHASE 6 — CAP-ONLY (DISCARD path, NO mic feeder): re-join a FRESH meeting in a
    // temp-profile Chrome, this time DO NOT wire the mic feeder (no stdin hints EVER →
    // mic hint stays .unknown). DISCARD the Meet tab: the bridge must STILL hold on an
    // .unknown mic (advisory law: .unknown never ends a bridge), with the engage line
    // reporting mic=unknown. Then REACTIVATE (readable-not-in-call clear, reason=left)
    // — the cap-only bridge holds on unknown, and reactivation ends it.
    // -----------------------------------------------------------------------
    detCap = startDetector(false); // NO mic feeder — stdin open but never written
    log('phase6 (cap-only): detector spawned WITHOUT mic feeder (mic hint stays .unknown)');
    // Second Chrome: temp copy-auth profile (a persistent profile can't be shared and
    // this phase runs after A is fully quit anyway; temp keeps it simple + isolated).
    const tmpB = mkdtempSync(join(tmpdir(), 'meet-tabaway-b-'));
    copyAuth(tmpB);
    chromeB = launchTempChrome(PORT_B, tmpB);
    log(`rig Chrome B on :${PORT_B} (temp profile) — joining a FRESH hosted Meet (real mic, feeder OFF)…`);
    const joinedB = await joinFreshMeet(PORT_B);
    pgB = joinedB.pg;
    const codeB = joinedB.code;
    log(`phase6 in-call: code=${codeB}`);
    // Confirm detect first (so a join failure is not misread as a bridge failure).
    const p6Active = await waitFor(() => activeSince(detCap, codeB, 0).length > 0, JOIN_TIMEOUT_MS);

    // Background then DISCARD the Meet tab (canonical blindness, cap-only).
    await tabAway(PORT_B);
    await sleep(1000);
    const p6Start = Date.now();
    const discardResB = await discardMeetTab(PORT_B, codeB, joinedB.url);
    log(`phase6: chrome://discards discard → ${JSON.stringify(discardResB)} — holding 30s (cap-only, no mic hint)`);
    const p6EngagedMs = await waitFor(() => !!engagedLine(detCap, codeB, p6Start), ENGAGE_TIMEOUT_MS);
    await holdAndPoll(detCap, codeB, SHORT_HOLD_MS, 'phase6-hold');
    const p6Idle = idleSince(detCap, codeB, p6Start);
    const p6Engaged = engagedLine(detCap, codeB, p6Start);
    // The engage line reports the advisory mic; with no feeder it must be mic=unknown.
    const p6EngagedUnknown = !!(p6Engaged && p6Engaged.line.includes('mic=unknown'));

    // Now REACTIVATE: the discarded tab reloads to a rejoin/landing state → the
    // readable-not-in-call clear ends it (reason=left), no mic evidence needed.
    await tabBack(PORT_B);
    const p6EndStart = Date.now();
    log('phase6: reactivated the discarded Meet tab — expecting released reason=left + meet-idle');
    const p6ReleasedLeft = await waitFor(() => !!releasedLine(detCap, codeB, p6EndStart, 'left'), IDLE_HYSTERESIS_MS + 8_000);
    const p6IdleMs = await waitFor(() => idleSince(detCap, codeB, p6EndStart), IDLE_HYSTERESIS_MS + 8_000);
    {
      const bridgeHeld = p6Active != null && p6EngagedMs != null && !p6Idle && !!p6Engaged;
      const endedOnReactivate = p6ReleasedLeft != null || p6IdleMs != null;
      const ok = bridgeHeld && endedOnReactivate;
      if (!ok) anyFail = true;
      record('cap-only', ok ? 'PASS' : 'FAIL', {
        code: codeB, detectSeen: p6Active != null, discardResult: discardResB,
        engagedMs: p6EngagedMs, meetIdleDuringHold: p6Idle,
        engagedLineSeen: !!p6Engaged, engagedMicUnknown: p6EngagedUnknown,
        releasedLeftMs: p6ReleasedLeft, meetIdleAfterReactivateMs: p6IdleMs,
        reason: ok ? undefined
          : (!bridgeHeld
            ? (p6Active == null ? 'phase6 join/detect failed'
              : p6EngagedMs == null ? 'discard did NOT engage the cap-only bridge (no engaged line — WebArea did not die / discard failed)'
                : p6Idle ? 'cap-only bridge did NOT hold (meet-idle during hold with mic=unknown — advisory law violated)'
                  : 'no engaged keep-alive line during cap-only hold')
            : 'meeting did NOT end on reactivation via the readable-not-in-call clear (no released reason=left, no meet-idle)'),
      });
    }
  } catch (e) {
    console.error('[tabaway] FATAL during scenario:', e && e.stack ? e.stack : e);
    // Record a fatal so the reader gate sees the failure.
    anyFail = true;
    record('fatal', 'FAIL', { reason: String(e && e.message ? e.message : e) });
  } finally {
    // Teardown in a finally block: leave calls, close rig Chromes, SIGTERM helpers.
    // The host Chrome is CLEAN-QUIT (its .kill() is Browser.close→SIGTERM for a
    // persistent profile, SIGKILL+rmSync for a temp fallback).
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
    console.error('[tabaway]   --no-reactivate: discard phase closes the Meet tab (tabGone → reason=gone)');
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
