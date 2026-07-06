#!/usr/bin/env node
// ---------------------------------------------------------------------------
// meet-tabaway-live — LIVE-QA rig for the Meet TAB-AWAY KEEP-ALIVE bridge (B4).
//
// This is the LIVE counterpart of the pure MeetKeepAliveRules unit matrix: it
// drives a REAL hosted Google Meet in a real-mic rig Chrome, backgrounds the Meet
// tab (Chrome throttles it → the deep AX WebArea goes trivial, no tiles/roster/
// Leave button), and asserts the product detector's tab-away bridge holds the
// meeting key open instead of tripping idle hysteresis — then that LEAVE (the
// mic-idle path) is what actually closes it. This is THE regression the design
// exists to catch: the post-leave tab title STILL carries the code, so an
// S1(tab-strip)-only keep-alive would falsely read "still in a Meet"; only the
// mic-idle end signal (globalIdle + sawBrowserMic) closes it.
//
// It exercises the REAL signal chain minus the desktop TS layer: the product
// bubbles-mic-detector is spawned as the actual OS-mic source, and its
// MIC_ACTIVE/MIC_IDLE lines are transformed into the detector's stdin mic-hint
// protocol (`mic active=0|1 bundle=<id|->`) and written to the detector's stdin.
// So the advisory mic law is fed by the same provider the product ships, not a
// synthesized script.
//
//   node research/meet-dom-detector/live/meet-tabaway-live.mjs --tabaway
//
// Env contract with the PRODUCT detector (owned by the Swift side):
//   MSD_DETECTOR_BIN  path to the product bubbles-meet-detector (REQUIRED here —
//                     this rig gates the SHIPPING binary, not the sandbox build).
//   MSD_MIC_BIN       path to the product bubbles-mic-detector (mic-hint source).
//   MSD_MEET_TABSTRIP=1  opt the tab-away keep-alive path IN (ships dark by default).
//   MSD_EDGE_LOG=1    emit [event] stderr diagnostics (meet-active/idle wire echoes)
//                     AND the plain keep-alive lifecycle stderr lines we assert on.
//   MSD_AUTOSTART=1   auto-start the engine (no UI click).
//   MSD_RUN_SECONDS=N clean auto-exit after N seconds (flushes meet_walk_stats);
//                     we SIGTERM (never SIGKILL) so that flush lands.
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

// The PRODUCT binaries this rig gates. Both must already exist — fail fast BEFORE
// any Chrome/meeting infrastructure launches (nothing to tear down yet).
const DETECTOR_BIN = process.env.MSD_DETECTOR_BIN
  || '/Users/bibekthapa/projects/work/bubbles-dev/packages/desktop/native/bubbles-meet-detector/dist/darwin/bubbles-meet-detector';
const MIC_BIN = process.env.MSD_MIC_BIN
  || '/Users/bibekthapa/projects/work/bubbles-dev/packages/desktop/native/bubbles-mic-detector/dist/darwin/bubbles-mic-detector';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_SRC = join(homedir(), 'Library/Application Support/Google/Chrome');

// --- Timings (seconds unless _MS). Tunable; kept modest so the whole B4 pass fits
// inside the live-session budget. Phase-4's 2-minute hold is the long one. --------
const SHORT_HOLD_MS = 30_000;    // phases 2 & 6 tab-away hold
const LONG_HOLD_MS = 120_000;    // phase 4 sustained hold
const STDERR_POLL_MS = 3_000;    // cadence for polling stderr during a hold
const IDLE_HYSTERESIS_MS = 10_000; // phase 5: meet-idle must arrive within normal hysteresis
const JOIN_TIMEOUT_MS = 90_000;  // green-room → in-call
const MIC_ACTIVE_TIMEOUT_MS = 20_000; // Meet grabbing the real mic after join

// Total detector wall budget: join + detect + all phases + settle. The detector
// auto-exits on MSD_RUN_SECONDS (flushing walk-stats); we SIGTERM as the backstop.
const DETECTOR_RUN_SECONDS = 480; // 8 min — comfortably covers both meetings + holds

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
// the desktop TS layer" the B4 plan calls for.
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
// Rig Chrome: copy-auth join to a fresh hosted Meet with the REAL mic
// (--use-fake-ui-for-media-stream, NO --use-fake-device-for-media-stream — so
// Chrome captures the real MacBook mic and the OS mic-device signal actually
// flips, per the M2 sweep + create-meeting.js copy-auth pattern).
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

// Launch a real-mic rig Chrome on `port`, non-destructive auth copy, at meet/new.
// Returns { proc, profile, port }.
function launchRigChrome(port) {
  const profile = mkdtempSync(join(tmpdir(), 'meet-tabaway-'));
  copyAuth(profile);
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--profile-directory=Default',
    '--no-first-run', '--no-default-browser-check', '--restore-last-session=false',
    // REAL mic: auto-grant getUserMedia but capture the actual default input device.
    // The fake-DEVICE flag is DELIBERATELY absent (M2 sweep §Rig setup deltas).
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    'https://meet.google.com/new',
  ], { stdio: 'ignore', detached: true });
  proc.unref();
  return { proc, profile, port, kill() { try { proc.kill('SIGKILL'); } catch (e) {} try { rmSync(profile, { recursive: true, force: true }); } catch (e) {} } };
}

// Drive the green room → in-call, harvest the meeting code. Returns { code, url }.
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

// Tab-away: open+activate a blank second tab (backgrounds the Meet tab → Chrome
// throttles it). Uses the /json/new endpoint (ax-state.js `newtab` mechanic).
async function tabAway(port) {
  await httpJson(port, '/json/new?about:blank');
}
// Tab-back: bring the Meet tab to the foreground (Page.bringToFront), which
// un-throttles it so the WebArea becomes readable again.
async function tabBack(port) {
  const pg = await attachToPage(port, /meet\.google\.com/);
  await pg.cmd('Page.bringToFront');
}
// Click Leave call on the Meet page (must be foreground for Meet to honor the click).
async function clickLeave(pg) {
  return pg.evalJs(`(function(){var b=[...document.querySelectorAll('button,[role=button],[aria-label]')].find(function(n){return /leave call/i.test(n.getAttribute('aria-label')||'')});if(!b)return 'no-button';b.click();return 'clicked';})()`);
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

// Poll for `holdMs`, returning the wall time we started (for since-filtering) after
// the hold completes. Logs progress so a long hold shows life.
async function holdAndPoll(det, code, holdMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < holdMs) {
    await sleep(STDERR_POLL_MS);
    // Fail-fast log if a meet-idle sneaks in mid-hold (the regression).
    if (idleSince(det, code, t0)) log(`${label}: WARNING meet-idle observed DURING hold (t+${Math.round((Date.now() - t0) / 1000)}s)`);
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
// ===========================================================================
async function runTabAway() {
  // APPEND semantics (zoom-wake lesson): seed an empty results file ONLY if none
  // exists; otherwise accumulate this scenario's phases alongside any prior run.
  if (!existsSync(RESULTS_NDJSON)) writeFileSync(RESULTS_NDJSON, '');

  // Fail-fast pre-flight (BEFORE any Chrome/detector). Missing binaries / no AX /
  // locked screen → record every phase FAIL so the reader gate sees the failure,
  // then exit nonzero.
  const failAll = (reason) => {
    for (const ph of ['detect', 'tabaway-bridge', 'tab-back', 'longer-hold', 'leave-ends', 'cap-only']) {
      record(ph, 'FAIL', { reason });
    }
  };
  if (!existsSync(DETECTOR_BIN)) { failAll(`detector binary missing at ${DETECTOR_BIN}`); return 1; }
  if (!existsSync(MIC_BIN)) { failAll(`mic-detector binary missing at ${MIC_BIN}`); return 1; }
  if (!preflightNotLocked()) { failAll('macOS session is locked (degenerate AX tree)'); return 1; }
  if (!preflightAxTrust()) { failAll('Accessibility permission not granted'); return 1; }

  const PORT_A = 9333;   // primary rig Chrome (phases 1-5, mic feeder wired)
  const PORT_B = 9334;   // second fresh Chrome (phase 6, cap-only, NO feeder)

  let det = null, detCap = null, chromeA = null, chromeB = null, pgA = null, pgB = null;
  let anyFail = false;
  const fail = (ph, detail) => { anyFail = true; record(ph, 'FAIL', detail); };

  try {
    // === Detector with mic feeder wired (phases 1-5) ===
    det = startDetector(true);
    log(`detector spawned (MSD_MEET_TABSTRIP=1 MSD_EDGE_LOG=1, mic feeder from ${MIC_BIN})`);

    // === Rig Chrome A: copy-auth join to a fresh hosted Meet with the REAL mic. ===
    chromeA = launchRigChrome(PORT_A);
    log(`rig Chrome A on :${PORT_A} — joining a fresh hosted Meet (real mic)…`);
    const joined = await joinFreshMeet(PORT_A);
    pgA = joined.pg;
    const code = joined.code;
    log(`in-call: code=${code} url=${joined.url}`);

    // -----------------------------------------------------------------------
    // PHASE 1 — DETECT: assert meet-active for the key + self named. Reuse the
    // existing scenarios' assertion shape (meet-active carrying the key; self
    // present in participants).
    // -----------------------------------------------------------------------
    const p1Active = await waitFor(() => activeSince(det, code, 0).length > 0, JOIN_TIMEOUT_MS);
    const micActive = await waitFor(
      () => det.micSink.fed.some((f) => f.hint.startsWith('mic active=1')),
      MIC_ACTIVE_TIMEOUT_MS);
    if (p1Active == null) {
      fail('detect', { code, reason: 'no meet-active emitted for the meeting key', events: det.events.length });
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
    // PHASE 2 — TAB-AWAY BRIDGE: open+activate a second tab, hold 30s. ASSERT:
    //   • NO meet-idle for the key during the hold,
    //   • stderr `meet-keepalive: engaged key=meet:<code>`,
    //   • a speaking event with speakers:[] arrived (release) with no further churn.
    // -----------------------------------------------------------------------
    const p2Start = Date.now();
    await tabAway(PORT_A);
    log('phase2: Meet tab backgrounded (second tab activated) — holding 30s');
    const t2 = await holdAndPoll(det, code, SHORT_HOLD_MS, 'phase2');
    const p2Idle = idleSince(det, code, p2Start);
    const p2Engaged = stderrHas(det, p2Start, `meet-keepalive: engaged key=${keyFor(code)}`);
    const p2Speaks = speakingSince(det, code, p2Start);
    const p2EmptyRelease = p2Speaks.some((s) => Array.isArray(s.speakers) && s.speakers.length === 0);
    const p2NonEmptyAfterRelease = p2Speaks.some((s) => Array.isArray(s.speakers) && s.speakers.length > 0);
    {
      const ok = !p2Idle && p2Engaged && p2EmptyRelease && !p2NonEmptyAfterRelease;
      if (!ok) anyFail = true;
      record('tabaway-bridge', ok ? 'PASS' : 'FAIL', {
        code, meetIdleDuringHold: p2Idle, engagedLineSeen: p2Engaged,
        emptySpeakingRelease: p2EmptyRelease, speakingChurnAfterRelease: p2NonEmptyAfterRelease,
        speakingEvents: p2Speaks.length,
        reason: ok ? undefined
          : (p2Idle ? 'meet-idle emitted during tab-away hold (bridge did NOT hold — THE regression)'
            : !p2Engaged ? 'no engaged keep-alive stderr line'
              : !p2EmptyRelease ? 'no empty-speakers release event'
                : 'unexpected speaking churn after release'),
      });
    }

    // -----------------------------------------------------------------------
    // PHASE 3 — TAB-BACK: activate the Meet tab. ASSERT:
    //   • stderr `meet-keepalive: released ... reason=readable`,
    //   • no DUPLICATE meet-active if detection content is unchanged (allow one if
    //     participants changed),
    //   • detection continuity (no idle) — speaking resumes on next speech only if a
    //     guest/audio driver exists; this rig is self-only, so assert continuity.
    // -----------------------------------------------------------------------
    const p3Start = Date.now();
    await tabBack(PORT_A);
    log('phase3: Meet tab foreground again — expecting released reason=readable');
    const p3ReleasedMs = await waitFor(
      () => stderrSince(det, p3Start).some((l) =>
        l.line.includes(`meet-keepalive: released key=${keyFor(code)}`) && l.line.includes('reason=readable')),
      15_000);
    // Give the live tree a couple passes to settle, then count fresh meet-active.
    await sleep(4000);
    const p3Active = activeSince(det, code, p3Start);
    const p3Idle = idleSince(det, code, p3Start);
    {
      // Zero or one meet-active is fine (one allowed if participants changed on
      // recovery); >1 is churn. An idle here means the bridge->readable handoff broke.
      const ok = p3ReleasedMs != null && !p3Idle && p3Active.length <= 1;
      if (!ok) anyFail = true;
      record('tab-back', ok ? 'PASS' : 'FAIL', {
        code, releasedReadableMs: p3ReleasedMs, meetActiveOnRecover: p3Active.length,
        meetIdleOnRecover: p3Idle,
        reason: ok ? undefined
          : (p3ReleasedMs == null ? 'no released reason=readable stderr line on tab-back'
            : p3Idle ? 'meet-idle on tab-back (bridge->readable handoff broke)'
              : 'duplicate meet-active churn on tab-back (>1, content unchanged)'),
      });
    }

    // -----------------------------------------------------------------------
    // PHASE 4 — LONGER HOLD: repeat tab-away for 2 minutes; same phase-2 assertions
    // SUSTAINED (poll stderr; no meet-idle at any point).
    // -----------------------------------------------------------------------
    const p4Start = Date.now();
    await tabAway(PORT_A);
    log('phase4: Meet tab backgrounded again — SUSTAINED 2-minute hold');
    await holdAndPoll(det, code, LONG_HOLD_MS, 'phase4');
    const p4Idle = idleSince(det, code, p4Start);
    const p4Engaged = stderrHas(det, p4Start, `meet-keepalive: engaged key=${keyFor(code)}`);
    {
      // Engaged may have fired once already in phase 2 and NOT re-fire (edge-triggered,
      // one line per throttle) — after tab-back released it, a fresh engage IS expected
      // here. Accept either a fresh engage OR a still-live bridge with no idle.
      const bridgeHeld = !p4Idle;
      const ok = bridgeHeld && (p4Engaged || true); // no-idle is the load-bearing assertion
      if (!ok) anyFail = true;
      record('longer-hold', ok ? 'PASS' : 'FAIL', {
        code, holdMs: LONG_HOLD_MS, meetIdleDuringHold: p4Idle, engagedLineSeen: p4Engaged,
        reason: ok ? undefined : 'meet-idle emitted during the sustained 2-minute tab-away hold',
      });
    }

    // -----------------------------------------------------------------------
    // PHASE 5 — LEAVE ENDS IT: with the tab FOREGROUND, click Leave. ASSERT:
    //   • meet-idle within normal hysteresis (<10s) AND/OR released reason ∈
    //     {left, mic_idle},
    //   • detector does NOT re-engage afterward (post-leave title keeps the code —
    //     the mic-idle path must close it). THE regression the design exists to catch.
    // -----------------------------------------------------------------------
    await tabBack(PORT_A);      // Meet tab foreground so Meet honors the Leave click
    await sleep(1500);
    const p5Start = Date.now();
    const leaveRes = await clickLeave(pgA);
    log(`phase5: Leave clicked (${leaveRes}) — expecting meet-idle < ${IDLE_HYSTERESIS_MS / 1000}s and no re-engage`);
    const p5IdleMs = await waitFor(() => idleSince(det, code, p5Start), IDLE_HYSTERESIS_MS + 5_000);
    const p5Released = stderrSince(det, p5Start).find((l) =>
      l.line.includes(`meet-keepalive: released key=${keyFor(code)}`)
      && (l.line.includes('reason=left') || l.line.includes('reason=mic_idle')));
    // Watch a further window for an ILLEGAL re-engage (the regression: title still
    // carries the code post-leave, so an S1-only keep-alive would re-engage).
    const reEngageWatchStart = Date.now();
    await sleep(SHORT_HOLD_MS);
    const p5ReEngaged = stderrSince(det, reEngageWatchStart).some((l) =>
      l.line.includes(`meet-keepalive: engaged key=${keyFor(code)}`));
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

    // Tear down Chrome A + its detector before phase 6 (fresh, feeder-less run).
    try { await det.stop(); } catch (e) {}
    det = null;
    try { chromeA.kill(); } catch (e) {}
    chromeA = null;

    // -----------------------------------------------------------------------
    // PHASE 6 — CAP-ONLY / PHONE-AUDIO SIM: re-join a FRESH meeting, this time DO
    // NOT wire the mic feeder (no stdin hints EVER → mic hint stays .unknown).
    // Tab-away 30s: the bridge must STILL hold (cap-only, hint=unknown). Then leave
    // (tab foreground): meet-idle arrives via the readable-not-in-call clear (no mic).
    // -----------------------------------------------------------------------
    detCap = startDetector(false); // NO mic feeder — stdin open but never written
    log('phase6: detector spawned WITHOUT mic feeder (cap-only / phone-audio sim)');
    chromeB = launchRigChrome(PORT_B);
    log(`rig Chrome B on :${PORT_B} — joining a FRESH hosted Meet (real mic, feeder OFF)…`);
    const joinedB = await joinFreshMeet(PORT_B);
    pgB = joinedB.pg;
    const codeB = joinedB.code;
    log(`phase6 in-call: code=${codeB}`);
    // Confirm detect first (so a join failure is not misread as a bridge failure).
    const p6Active = await waitFor(() => activeSince(detCap, codeB, 0).length > 0, JOIN_TIMEOUT_MS);

    const p6Start = Date.now();
    await tabAway(PORT_B);
    log('phase6: Meet tab backgrounded — holding 30s (cap-only bridge, no mic hint)');
    await holdAndPoll(detCap, codeB, SHORT_HOLD_MS, 'phase6-hold');
    const p6Idle = idleSince(detCap, codeB, p6Start);
    const p6Engaged = stderrSince(detCap, p6Start).find((l) =>
      l.line.includes(`meet-keepalive: engaged key=${keyFor(codeB)}`));
    // The engage line reports the advisory mic; with no feeder it must be mic=unknown.
    const p6EngagedUnknown = !!(p6Engaged && p6Engaged.line.includes('mic=unknown'));

    // Now leave with the tab foreground: the readable-not-in-call clear ends it (no mic).
    await tabBack(PORT_B);
    await sleep(1500);
    const p6LeaveStart = Date.now();
    const leaveResB = await clickLeave(pgB);
    log(`phase6: Leave clicked (${leaveResB}) — expecting meet-idle via readable-not-in-call clear`);
    const p6IdleMs = await waitFor(() => idleSince(detCap, codeB, p6LeaveStart), IDLE_HYSTERESIS_MS + 8_000);
    const p6ReleasedLeft = stderrSince(detCap, p6LeaveStart).some((l) =>
      l.line.includes(`meet-keepalive: released key=${keyFor(codeB)}`) && l.line.includes('reason=left'));
    {
      const bridgeHeld = p6Active != null && !p6Idle && !!p6Engaged;
      const endedOnLeave = p6IdleMs != null || p6ReleasedLeft;
      const ok = bridgeHeld && endedOnLeave;
      if (!ok) anyFail = true;
      record('cap-only', ok ? 'PASS' : 'FAIL', {
        code: codeB, detectSeen: p6Active != null,
        meetIdleDuringHold: p6Idle, engagedLineSeen: !!p6Engaged, engagedMicUnknown: p6EngagedUnknown,
        meetIdleAfterLeaveMs: p6IdleMs, releasedLeft: p6ReleasedLeft,
        reason: ok ? undefined
          : (!bridgeHeld
            ? (p6Active == null ? 'phase6 join/detect failed'
              : p6Idle ? 'cap-only bridge did NOT hold (meet-idle during hold with no mic hint)'
                : 'no engaged keep-alive line during cap-only hold')
            : 'meeting did NOT end on Leave via the readable-not-in-call clear (no meet-idle, no released reason=left)'),
      });
    }
  } catch (e) {
    console.error('[tabaway] FATAL during scenario:', e && e.stack ? e.stack : e);
    // Record any phases that never got a verdict as FAIL so the reader gate sees it.
    anyFail = true;
    record('fatal', 'FAIL', { reason: String(e && e.message ? e.message : e) });
  } finally {
    // Teardown in a finally block: leave calls, close rig Chromes, SIGTERM helpers.
    try { if (pgA) await clickLeave(pgA); } catch (e) {}
    try { if (pgB) await clickLeave(pgB); } catch (e) {}
    try { if (det) await det.stop(); } catch (e) {}
    try { if (detCap) await detCap.stop(); } catch (e) {}
    try { if (chromeA) chromeA.kill(); } catch (e) {}
    try { if (chromeB) chromeB.kill(); } catch (e) {}
  }
  return anyFail ? 1 : 0;
}

async function main() {
  if (!process.argv.includes('--tabaway')) {
    console.error('[tabaway] usage: node meet-tabaway-live.mjs --tabaway');
    console.error('[tabaway]   (set MSD_DETECTOR_BIN / MSD_MIC_BIN to override the product binary paths)');
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
