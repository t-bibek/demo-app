#!/usr/bin/env node
// ---------------------------------------------------------------------------
// meet-tabaway-live (v3.2) — LIVE-QA rig for the Meet TAB-AWAY KEEP-ALIVE bridge.
//
// v3.2 DELTA (two assertion artifacts fixed + multi-party phases added):
//   • RECOVERY IS NO-CHURN BY DESIGN (phases 2 & 6). The keep-alive Detection is
//     rebuilt == to the last readable one (GoogleMeetProbe.swift observeReadable →
//     the miss-path Detection carries every == field VERBATIM), so a hold causes NO
//     meet-active churn and RECOVERY emits NO fresh meet-active when content is
//     unchanged (MonitorCore's `lastByKey[key] != d` diff sees no change). v3.1's
//     `recoveredMeetActive` requirement was therefore structurally wrong and
//     false-FAILed live. FIXED: recovery proof = `released reason=readable` + NO
//     meet-idle in the recovery window + 0..1 meet-active (>1 = churn FAIL).
//   • PHASE-BOUNDARY DRAIN. A tabBack/reactivation at the END of phase N logs its
//     `released` edge on the detector's NEXT probe cycle, landing AFTER phase N+1
//     stamps its since-timestamp (+1506ms observed) — phase 4's no-throttle branch
//     then miscounts the leaked line as a "stray release" and false-FAILs. FIXED:
//     drainBoundary() flushes phase N's pending release (bounded ~10s) + settles ~3s
//     of quiet before phase N+1 stamps, applied at every tabBack boundary (2→3,3→4,4→5).
//   • --multiparty: two ADDED phases after the solo 1-6 (which are byte-identical to
//     v3.1 modulo the two fixes above): phase 7 mp-drain (GATING — a speaking guest
//     drains to speakers:[] across the blindness boundary, then resumes) and phase 8
//     mp-remote-end (best-effort C5 evidence — host ends-for-all while the watched
//     guest is backgrounded; SKIP if end-for-all isn't drivable). Reuses the 3-party
//     machinery (fake-mic-override.buildOverride speaking WAV + admit-guest.admit).
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
//   node research/meet-dom-detector/live/meet-tabaway-live.mjs --tabaway --multiparty
//     (solo phases 1-6 UNCHANGED, then phase 7 mp-drain [gating] + phase 8
//      mp-remote-end [best-effort]. Multi-party roll-up PASS = 1,2,4,5,6,7 PASS
//      + 3 PASS-or-SKIP + 8 PASS-or-SKIP.)
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
// Multi-party (--multiparty) reuse machinery — the EXISTING 3-party rig building
// blocks (roster-rig-3p.js / fake-audio-rig.js), reused verbatim rather than
// reinvented: buildOverride installs the WAV-backed getUserMedia mic pre-nav so a
// guest is AUDIBLY SPEAKING on a loop; admit lets the host bot admit that guest.
const { buildOverride } = require('./fake-mic-override.js');
const { admit } = require('./admit-guest.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_NDJSON = join(HERE, 'live-qa-results.ndjson');
const SCENARIO = 'meet-tabaway-live';

// --no-reactivate: IF the discard phase fires a real discard, it CLOSES the Meet tab
// (tabGone → reason=gone) instead of reactivating it. Default reactivates a discarded
// tab (it reloads not-in-call → reason=left). No effect if the discard phase SKIPs.
const NO_REACTIVATE = process.argv.includes('--no-reactivate');

// --multiparty: run the two extra multi-party phases (7 mp-drain gating, 8
// mp-remote-end best-effort) after the solo phases 1-6. The solo path (phases 1-6)
// is BYTE-IDENTICAL whether or not this flag is set — the flag only appends work.
const MULTIPARTY = process.argv.includes('--multiparty');

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

// Multi-party (--multiparty) fake-audio + the signed-in bot host profile. The guest
// speaks a looping speech WAV (Meet VAD treats decoded voice as speech). The bot host
// (phase 8) reuses the SAME persistent .rig-profiles/host the 3-party rig uses.
const FAKE_AUDIO_DIR = join(HERE, 'fake-audio');
const GUEST_WAV = join(FAKE_AUDIO_DIR, 'guest.wav');   // Guest speech loop (fake-audio-rig.js)
const HOST_WAV = join(FAKE_AUDIO_DIR, 'host.wav');     // Bot-host speech loop (phase 8)
const GUEST_NAME_MP = 'Guest Drain';                   // distinct typed name the detector must NAME
const PORT_GUEST = 9335;   // phase-7 guest Chrome (temp profile, speaking WAV)
const PORT_BOTHOST = 9336; // phase-8 bot-host Chrome (.rig-profiles/host, hosts the meeting)

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
// PASS-or-SKIP phases (a SKIP is tolerated, only a FAIL gates): the discard-blindness
// phase (3, mechanism may be unavailable) and — under --multiparty — the best-effort
// mp-remote-end phase (8, end-for-all may not be drivable). mp-drain (7) is GATING.
const OPTIONAL_PHASES = new Set(['discard-blindness', 'mp-remote-end']);
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

// ===========================================================================
// MULTI-PARTY (--multiparty) Chrome + join helpers. These REUSE the 3-party rig's
// building blocks (fake-mic-override.buildOverride, admit-guest.admit) rather than
// reinventing: a guest/bot Chrome launches on about:blank with the WAV-backed gUM
// override installed PRE-NAV (survives the navigate-to-Meet), so the seat is
// AUDIBLY SPEAKING on a loop the moment Meet grabs the mic.
// ===========================================================================

// Launch an EXTRA Chrome (guest or bot-host) on about:blank, attach a persistent CDP
// connection, and install the fake-mic override pre-navigation (roster-rig-3p.launch
// pattern). Returns { proc, port, conn, profile, temp, kill }. `temp:true` guest
// profiles are SIGKILL+rmSync; a persistent bot-host profile (.rig-profiles/host) is
// clean-quit (Browser.close→SIGTERM), NEVER rmSync — same rule as the primary host.
async function launchMpChrome({ port, profile, wav, label, temp }) {
  const args = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    // Keep occluded/background renderers running so the SPEAKING guest keeps
    // transmitting audio even when its window is not OS-frontmost (roster-rig-3p flags).
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: 'ignore', detached: true });
  proc.unref();
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try { const l = await httpJson(port, '/json'); if (Array.isArray(l)) target = l.find((t) => t.type === 'page'); } catch (e) {}
  }
  if (!target) throw new Error(`[${label}] no page target on :${port}`);
  const conn = await attachToPage(port, /about:blank|/);
  await conn.cmd('Page.addScriptToEvaluateOnNewDocument', { source: buildOverride(wav, label) });
  return {
    proc, port, conn, profile, temp: !!temp,
    async kill() {
      if (temp) {
        try { proc.kill('SIGKILL'); } catch (e) {}
        try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
        return;
      }
      // Persistent bot-host profile: clean-quit (Browser.close → SIGTERM), never rmSync.
      try {
        const v = await httpJson(port, '/json/version');
        const wsUrl = v && v.webSocketDebuggerUrl;
        if (wsUrl) {
          const { WS } = require('./cdp-lib.js');
          const ws = new WS(wsUrl); await ws.connect();
          ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
          await sleep(1500); ws.close();
        }
      } catch (e) {}
      const exited = await Promise.race([
        new Promise((res) => proc.on('exit', res)),
        sleep(QUIT_GRACE_MS).then(() => 'timeout'),
      ]);
      if (exited === 'timeout') { try { proc.kill('SIGTERM'); } catch (e) {} }
    },
  };
}

// A guest asks to join a given meeting URL under a distinct typed name (anonymous
// green room). Mirrors roster-rig-3p.guestAsk / fake-audio-rig.guestAsk verbatim.
async function mpGuestAsk(conn, meetingUrl, name) {
  await conn.cmd('Page.navigate', { url: meetingUrl });
  // Wait for the pre-join screen (Join now / Ask to join present).
  for (let i = 0; i < 60; i++) {
    const ok = await conn.evalJs(`/meet\\.google\\.com/.test(location.href)&&!![...document.querySelectorAll('button,[role=button]')].find(function(b){return /join now|ask to join/i.test((b.getAttribute('aria-label')||b.textContent||''))})`);
    if (ok) break;
    await sleep(500);
  }
  await sleep(1500);
  // Type the distinct guest name.
  await conn.evalJs(`(function(){var i=document.querySelector('input[type=text][aria-label], input[jsname][type=text]');if(i){i.value=${JSON.stringify(name)};i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await sleep(500);
  const clickByName = (rx) => conn.evalJs(`(function(){var re=new RegExp(${JSON.stringify(rx)},'i');var el=[...document.querySelectorAll('button,[role=button]')].find(function(n){return n.getBoundingClientRect().width>0&&re.test((n.getAttribute('aria-label')||'')+' '+(n.textContent||''));});if(!el)return 'null';el.click();return (el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,30);})()`);
  await clickByName('Got it'); await sleep(300);
  await clickByName('Turn off camera'); await sleep(300);
  return clickByName('Ask to join|Join now');
}

// Wait for a connection to reach in-call (Leave-call control present). Returns true/false.
async function mpWaitInCall(conn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const inCall = await conn.evalJs(`!![...document.querySelectorAll('button,[role=button],[aria-label]')].find(function(b){return /leave call/i.test(b.getAttribute('aria-label')||'')})`);
    if (inCall) return true;
    await sleep(1000);
  }
  return false;
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

// PHASE-BOUNDARY DRAIN (rig artifact: the phase-3→4 boundary race, and its 2→3 / 4→5
// siblings). A tabBack / reactivation at the END of phase N recovers the live tree, and
// the detector logs `released reason=readable` on its NEXT probe cycle — which can land
// AFTER phase N+1 stamps its `sinceTs` (observed +1506ms). Phase N+1 then miscounts that
// LEAKED release as belonging to its own window (e.g. the no-throttle branch reads it as
// a "stray release" and false-FAILs). Call this AFTER the tabBack that ends phase N and
// BEFORE stamping phase N+1's since-timestamp: if the bridge was engaged in phase N (so a
// readable release is plausibly pending from its recovery), wait up to ~10s for that
// released line to land, then settle ~3s of quiet so no phase-N edge leaks forward. Only
// consumes phase-N's own pending recovery; it never suppresses a phase-N+1 signal because
// phase N+1 hasn't acted yet. Returns nothing — the caller stamps a fresh Date.now() after.
async function drainBoundary(det, code, sinceTs, wasEngaged, label) {
  if (wasEngaged) {
    // Wait (bounded) for ANY recovery release edge from phase N's tabBack/reactivation
    // to land (readable on a still-in-call recovery, or left/gone on a reload/close) —
    // phase N+1's stray-release check matches any `meet-keepalive: released`.
    const anyReleaseSince = () => stderrSince(det, sinceTs).some((l) =>
      l.line.includes(`meet-keepalive: released key=${keyFor(code)}`));
    const landed = await waitFor(anyReleaseSince, 10_000);
    log(`${label}: boundary drain — phase-N release ${landed != null ? `landed at +${landed}ms` : 'not seen within 10s (already drained or none pending)'}`);
  }
  // Settle a quiet window so any trailing edge from phase N is flushed before N+1 stamps.
  await sleep(3_000);
}

// ===========================================================================
// Main scenario.
//
// PHASES (v3.2):
//   1  detect              — meet-active for the key + self named (unchanged).
//   2  bg-throttle-cycle   — CANONICAL (replaces the old bg-hold-dormant): genuinely
//                            background the Meet tab (PUT-created + activated blank tab)
//                            → the renderer throttles → assert the REAL engage line
//                            `engaged reason=tab_present` within ~15s, NO meet-idle for
//                            a 30s hold, speakers released to []; then ACTIVATE the Meet
//                            tab → recovery is NO-CHURN BY DESIGN: assert `released
//                            reason=readable` + NO meet-idle + 0..1 meet-active (>1 =
//                            churn FAIL). NOT a required fresh meet-active (the v3.2 fix).
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
//                            reason=readable (no-churn recovery proof, same v3.2 fix),
//                            then Leave → meet-idle.
//   7  mp-drain            — (--multiparty, GATING) host = the DETECTOR-watched Chrome;
//                            add ONE guest (temp profile, looping speech WAV → AUDIBLY
//                            SPEAKING). Pre-hold: a `speaking` event NAMES the guest.
//                            Background the host Meet tab → engage → assert a LIVE
//                            `speaking` speakers:[] drain arrives during the hold (the
//                            never-yet-observed-live drain across a blindness boundary);
//                            hold 30s no meet-idle; activate → released reason=readable
//                            (no-churn) → guest speaking RESUMES within ~20s (wav loops).
//   8  mp-remote-end       — (--multiparty, best-effort SKIP) the watched Chrome joins as
//                            a GUEST of a .rig-profiles/host bot-hosted meeting; the bot
//                            host ENDS-FOR-ALL while the watched guest tab is BACKGROUNDED.
//                            Assert engaged pre-end; measure the PHANTOM DURATION
//                            (end-for-all → watched meet-idle) + the release path
//                            (reactivation→left, or cap→expired) — the C5 evidence. If
//                            end-for-all isn't drivable from the bot host UI: SKIP.
//
// Roll-up (solo)       PASS iff phases 1,2,4,5,6 PASS and phase 3 is PASS-or-SKIP.
// Roll-up (--multiparty) PASS iff phases 1,2,4,5,6,7 PASS, phase 3 PASS-or-SKIP, and
//                        phase 8 PASS-or-SKIP.
//
// Every tabBack boundary (2→3,3→4,4→5) drains phase N's pending recovery release
// (drainBoundary) before phase N+1 stamps its window — the v3.2 boundary-race fix.
// ===========================================================================
async function runTabAway() {
  // APPEND semantics (zoom-wake lesson): seed an empty results file ONLY if none
  // exists; otherwise accumulate this scenario's phases alongside any prior run.
  if (!existsSync(RESULTS_NDJSON)) writeFileSync(RESULTS_NDJSON, '');

  // Fail-fast pre-flight (BEFORE any Chrome/detector). Missing binaries / no AX /
  // locked screen → record every phase FAIL so the reader gate sees the failure,
  // then exit nonzero.
  const failAll = (reason) => {
    const phases = ['detect', 'bg-throttle-cycle', 'discard-blindness', 'longer-hold', 'leave-ends', 'cap-only'];
    // Under --multiparty a pre-flight failure must also fail the extra phases so the
    // reader gate sees them (mp-drain is gating; mp-remote-end is PASS-or-SKIP but a
    // pre-flight FAIL is still a FAIL, not a tolerated mechanism-unavailable SKIP).
    if (MULTIPARTY) phases.push('mp-drain', 'mp-remote-end');
    for (const ph of phases) record(ph, 'FAIL', { reason });
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
  // Multi-party (--multiparty) handles — declared in the outer scope so the finally
  // block tears them down even if a phase throws. detMp watches the host Chrome (mic
  // feeder wired); chromeMp is the DETECTOR-watched host/guest; guestMp / botHostMp are
  // the extra speaking seats. pgMp is the detector-watched Meet page.
  let detMp = null, chromeMp = null, guestMp = null, botHostMp = null, pgMp = null;
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
    //
    // RECOVERY PROOF (v3.2 — the no-churn-by-design fix, rig artifact #3). The
    // keep-alive Detection is DELIBERATELY rebuilt == to the last readable one
    // (GoogleMeetProbe.swift observeReadable → the miss-path Detection carries every
    // == field VERBATIM), so a hold causes NO meet-active churn. On recovery the
    // readable pass `return detection` ALSO compares == to that same stored content
    // when nothing changed, so the monitor's `lastByKey[key] != d` diff (MonitorCore)
    // emits NO fresh meet-active. Requiring `recoveredMeetActive` (v3.1's p2RecoverActive
    // != null) was therefore STRUCTURALLY WRONG and just false-FAILed a live run.
    //
    // The correct recovery proof, matching what the product actually emits:
    //   • `released reason=readable` — the bridge's normal recovery edge fired
    //     (setEngaged(code,false) returned true → the live tree returned in-call), AND
    //   • NO meet-idle in the recovery window — the still-in-call call was NOT ended, AND
    //   • 0..1 meet-active in the window (tolerate ONE — a benign roster/title refresh
    //     that legitimately changed content; >1 = meet-active CHURN across the boundary,
    //     which is exactly the design-defeating flicker this bridge exists to prevent).
    const p2RecoverStart = Date.now();
    await tabBack(PORT_A);
    log('phase2: Meet tab activated (still in-call) — expecting released reason=readable + NO meet-idle (no-churn by design: recovery emits no fresh meet-active when content is unchanged)');
    const p2ReadableMs = await waitFor(() => !!releasedLine(det, code, p2RecoverStart, 'readable'), IDLE_HYSTERESIS_MS + 8_000);
    const p2ReadableL = releasedLine(det, code, p2RecoverStart, 'readable');
    await sleep(2_000); // brief settle so a spurious post-recovery idle / churn would surface
    const p2IdleAfterRecover = idleSince(det, code, p2RecoverStart);
    const p2RecoverActiveCount = activeSince(det, code, p2RecoverStart).length;
    {
      const aOk = p2EngagedMs != null && p2EngagedL != null;
      const bOk = !p2IdleDuringHold && p2ReleaseOk && !p2NonEmptyAfterRelease;
      // Recovery: readable-release edge fired + NO meet-idle + no meet-active CHURN
      // (0 or 1 tolerated — the no-churn-by-design contract; >1 is the flicker FAIL).
      const cOk = p2ReadableMs != null && !p2IdleAfterRecover && p2RecoverActiveCount <= 1;
      const ok = aOk && bOk && cOk;
      if (!ok) anyFail = true;
      record('bg-throttle-cycle', ok ? 'PASS' : 'FAIL', {
        code, engagedMs: p2EngagedMs, engagedLine: p2EngagedL ? p2EngagedL.line : null,
        meetIdleDuringHold: p2IdleDuringHold, emptySpeakingRelease: p2EmptyRelease,
        preHoldSpoke: p2PreHoldSpoke,
        speakingChurnAfterRelease: p2NonEmptyAfterRelease, speakingEvents: p2Speaks.length,
        releasedReadableMs: p2ReadableMs, releasedLine: p2ReadableL ? p2ReadableL.line : null,
        meetActiveInRecoverWindow: p2RecoverActiveCount, meetIdleAfterRecover: p2IdleAfterRecover,
        note: 'background-throttle canonical cycle: engage on background, hold, recover on activate — recovery is no-churn BY DESIGN (keep-alive Detection == readable one), so proof = released reason=readable + NO meet-idle + 0..1 meet-active',
        reason: ok ? undefined
          : (!aOk ? `bridge did NOT engage on background-throttle (no engaged reason=tab_present within ${BG_ENGAGE_TIMEOUT_MS / 1000}s — the tab did not background/throttle, or the PUT tab-away failed)`
            : !bOk ? (p2IdleDuringHold ? 'meet-idle DURING the 30s background hold (bridge did NOT hold — THE regression)'
              : !p2EmptyRelease ? 'no empty-speakers release during the background hold'
                : 'unexpected speaking churn after the empty release')
            : (p2ReadableMs == null ? 'no released reason=readable after activating the still-in-call tab'
              : p2IdleAfterRecover ? 'spurious meet-idle after activation (the still-in-call call was falsely ended on recovery)'
                : `meet-active CHURN on recovery (${p2RecoverActiveCount} meet-active in the window; >1 breaks the no-churn-by-design contract — the keep-alive Detection should compare == to the readable one)`)),
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
    // Body-scope tracker so the 3→4 drain can flush phase 3's recovery release even
    // though phase 3's engage/tabBack vars are scoped inside its block. `since` is the
    // timestamp of phase 3's final tabBack (SKIP or reactivate variant); `engaged` is
    // whether the bridge was engaged in phase 3 (so a readable release is plausibly
    // pending). Left null/false for the tab-close variant (no readable release).
    let p3BoundaryTs = null, p3BoundaryEngaged = false;
    {
      // BOUNDARY 2→3 DRAIN: phase 2 ended with a tabBack recovery — flush its pending
      // `released reason=readable` edge before phase 3 acts, so it can't leak forward.
      await drainBoundary(det, code, p2RecoverStart, p2EngagedMs != null, 'phase2→3');
      // Background the Meet tab first (discard targets a background tab). This bg alone
      // engages the bridge, so even the SKIP path's tabBack below yields a readable release.
      await tabAway(PORT_A);
      await sleep(1000);
      const p3Start = Date.now();
      const discardRes = await discardMeetTab(PORT_A, code, joined.url);
      log(`phase3 (discard-blindness): discard attempt → ${JSON.stringify(discardRes)}`);

      if (!discardRes || !discardRes.fired) {
        // Neither Mojo nor DOM could fire a discard — record SKIP (does NOT gate).
        // Bring the Meet tab back to the foreground so the next phase starts clean. The
        // phase2→3 tabAway engaged the bridge, so THIS tabBack fires a readable release
        // that the 3→4 drain must flush (the observed +1506ms leak).
        try { await tabBack(PORT_A); } catch (e) {}
        p3BoundaryTs = Date.now(); p3BoundaryEngaged = true;
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
          // The reactivation release (reason=left) can land after p4Start — flag the
          // boundary so the 3→4 drain flushes it. (tab-close/gone: no tabBack, no leak.)
          p3BoundaryTs = Date.now(); p3BoundaryEngaged = true;
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
    // BOUNDARY 3→4 DRAIN (THE observed race): phase 3's tabBack/reactivation logs its
    // `released` edge on the NEXT probe cycle, which lands AFTER p4Start (+1506ms
    // observed) and the no-throttle branch miscounts it as a stray release → false FAIL.
    // Flush it (bounded ~10s) + settle before stamping p4Start.
    await drainBoundary(det, code, p3BoundaryTs != null ? p3BoundaryTs : Date.now(), p3BoundaryEngaged, 'phase3→4');
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
    // BOUNDARY 4→5 DRAIN: if phase 4 throttled, its recovery tabBack logs a readable
    // release that could land after p5Start; flush it before stamping (same discipline
    // as 2→3 / 3→4). p4Engaged is truthy only on a throttled run (the only run that
    // engaged the bridge and therefore has a pending recovery release).
    await drainBoundary(det, code, p4RecoverStart, !!p4Engaged, 'phase4→5');
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
    // SAME no-churn-by-design fix as phase 2 (rig artifact #3): recovery emits NO fresh
    // meet-active when content is unchanged (the keep-alive Detection == the readable
    // one), so v3.1's `p6RecoverActive != null` requirement was structurally wrong.
    // Recovery proof = released reason=readable + NO meet-idle + 0..1 meet-active (churn>1
    // = FAIL). We settle briefly then count instead of waiting for a meet-active that the
    // no-churn contract means may never arrive.
    const p6RecoverStart = Date.now();
    await tabBack(PORT_B);
    log('phase6: Meet tab activated (still in-call) — expecting released reason=readable + NO meet-idle (no-churn by design), then Leave → meet-idle');
    const p6ReadableMs = await waitFor(() => !!releasedLine(detCap, codeB, p6RecoverStart, 'readable'), IDLE_HYSTERESIS_MS + 8_000);
    await sleep(2_000); // settle so a spurious post-recovery idle / churn would surface
    const p6IdleAfterRecover = idleSince(detCap, codeB, p6RecoverStart);
    const p6RecoverActiveCount = activeSince(detCap, codeB, p6RecoverStart).length;

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
      // Recovery proof (no-churn by design): released reason=readable + NO meet-idle +
      // 0..1 meet-active (churn>1 = FAIL). NOT a required fresh meet-active.
      const recoveredReadable = p6ReadableMs != null && !p6IdleAfterRecover && p6RecoverActiveCount <= 1;
      const endedOnLeave = p6IdleMs != null && p6IdleMs <= IDLE_HYSTERESIS_MS;
      const ok = bridgeHeld && p6EngagedUnknown && recoveredReadable && endedOnLeave;
      if (!ok) anyFail = true;
      record('cap-only', ok ? 'PASS' : 'FAIL', {
        code: codeB, detectSeen: p6Active != null,
        engagedMs: p6EngagedMs, meetIdleDuringHold: p6Idle,
        engagedLineSeen: !!p6Engaged, engagedMicUnknown: p6EngagedUnknown,
        engagedLine: p6Engaged ? p6Engaged.line : null,
        releasedReadableMs: p6ReadableMs, meetActiveInRecoverWindow: p6RecoverActiveCount,
        meetIdleAfterRecover: p6IdleAfterRecover,
        leaveResult: p6LeaveRes, meetIdleAfterLeaveMs: p6IdleMs,
        reason: ok ? undefined
          : (!bridgeHeld
            ? (p6Active == null ? 'phase6 join/detect failed'
              : p6EngagedMs == null ? 'background-throttle did NOT engage the cap-only bridge (no engaged line — tab did not throttle)'
                : p6Idle ? 'cap-only bridge did NOT hold (meet-idle during hold with mic=unknown — advisory law violated)'
                  : 'no engaged keep-alive line during cap-only hold')
            : !p6EngagedUnknown ? 'engage line did NOT report mic=unknown (the feeder-less advisory mic should be unknown)'
              : !recoveredReadable ? (p6ReadableMs == null ? 'no readable recovery after activating the still-in-call tab (no released reason=readable)'
                : p6IdleAfterRecover ? 'spurious meet-idle after activation (the still-in-call call was falsely ended on recovery)'
                  : `meet-active CHURN on recovery (${p6RecoverActiveCount} meet-active; >1 breaks the no-churn-by-design contract)`)
                : 'meeting did NOT end on Leave (no meet-idle < hysteresis after the Leave click)'),
      });
    }

    // =======================================================================
    // MULTI-PARTY PHASES (only when --multiparty). Phases 1-6 above are the solo
    // path and run identically regardless of this flag; the block below is pure
    // ADDED work. Tear down phase-6's Chrome B + detCap first (the meeting is left,
    // the profile lock must clear before we relaunch the persistent profile).
    // =======================================================================
    if (MULTIPARTY) {
      try { await detCap.stop(); } catch (e) {}
      detCap = null;
      try { await chromeB.kill(); } catch (e) {}
      chromeB = null;
      pgB = null;
      if (hostProfile.persistent) {
        const t0 = Date.now();
        while (Date.now() - t0 < 15_000 && !assertProfileNotInUse(hostProfile.dir)) { await sleep(1000); }
      }

      // ---------------------------------------------------------------------
      // PHASE 7 — MP-DRAIN (GATING under --multiparty): the never-yet-observed-LIVE
      // drain-to-[] across a blindness boundary WITH a real remote speaker.
      //   Setup: the DETECTOR-watched Chrome (persistent profile, mic feeder wired —
      //   production mode) HOSTS a fresh Meet; ONE guest (temp profile, looping speech
      //   WAV → AUDIBLY SPEAKING) asks to join and the host admits it.
      //   (pre-hold) Assert a `speaking` event NAMES the guest (non-empty set) — the
      //             detector resolves the remote speaker off the host's live AX tree.
      //   (drain)   Background the host's Meet tab → engage reason=tab_present → assert
      //             a `speaking` event with speakers:[] ARRIVES DURING THE HOLD. This is
      //             the live drain-to-[] across the blindness boundary: with no live ring
      //             the Meet pipeline resolves an empty tile set and the confidence-held
      //             holder decays to [] (GoogleMeetProbe miss-path emits speakers:[]).
      //   (hold)    30s, NO meet-idle (the bridge holds the key open).
      //   (recover) Activate → released reason=readable (no-churn by design: proof is the
      //             readable edge + no idle, NOT a fresh meet-active) → the guest wav is
      //             still looping, so guest speaking RESUMES being detected (a non-empty
      //             `speaking` event naming the guest within ~20s).
      // ---------------------------------------------------------------------
      const guestProfile = mkdtempSync(join(tmpdir(), 'meet-tabaway-guest-'));
      try {
        detMp = startDetector(true); // mic feeder wired — production-mode host
        log('phase7 (mp-drain): detector spawned (mic feeder wired) — host will admit ONE speaking guest');
        chromeMp = hostProfile.persistent
          ? launchPersistentChrome(PORT_A, hostProfile.dir)
          : launchTempChrome(PORT_A, hostProfile.dir);
        log(`phase7 host Chrome on :${PORT_A} — joining a FRESH hosted Meet…`);
        const joinedMp = await joinFreshMeet(PORT_A);
        pgMp = joinedMp.pg;
        const codeMp = joinedMp.code;
        log(`phase7 host in-call: code=${codeMp} url=${joinedMp.url}`);
        const p7HostActive = await waitFor(() => activeSince(detMp, codeMp, 0).length > 0, JOIN_TIMEOUT_MS);

        // Launch the SPEAKING guest (temp profile, looping WAV) and ask to join.
        guestMp = await launchMpChrome({ port: PORT_GUEST, profile: guestProfile, wav: GUEST_WAV, label: 'GUEST', temp: true });
        const askRes = await mpGuestAsk(guestMp.conn, joinedMp.url, GUEST_NAME_MP);
        log(`phase7 guest ("${GUEST_NAME_MP}") asked to join: ${askRes}`);
        const admitted = await admit({ hostPort: PORT_A, guestPorts: [PORT_GUEST], guestName: GUEST_NAME_MP, timeoutSec: 90, log });
        log(`phase7 guest admitted: ${admitted}`);
        const guestInCall = admitted && await mpWaitInCall(guestMp.conn, 30_000);

        // (pre-hold) A speaking event must NAME the guest (non-empty set). The guest
        // wav loops, so give it a generous window for Meet VAD + the fused resolver.
        const namesGuest = (s) => Array.isArray(s.speakers) && s.speakers.some((n) => n === GUEST_NAME_MP || (n || '').includes(GUEST_NAME_MP));
        const p7PreSpeakMs = await waitFor(
          () => speakingSince(detMp, codeMp, 0).some(namesGuest), 45_000);
        const p7PreSpokeGuest = p7PreSpeakMs != null;

        // (drain) Background the host Meet tab → engage → assert a speakers:[] drain
        // event arrives DURING the hold.
        const p7Start = Date.now();
        await tabAway(PORT_A);
        log('phase7 (drain): host Meet tab backgrounded — expecting engage reason=tab_present + a LIVE speakers:[] drain during the hold');
        const p7EngagedMs = await waitFor(() => !!engagedLine(detMp, codeMp, p7Start), BG_ENGAGE_TIMEOUT_MS);
        // The drain-to-[] event: a `speaking` event with an EMPTY set after the guest
        // was speaking, arriving across the blindness boundary during the hold.
        const p7DrainMs = await waitFor(
          () => speakingSince(detMp, codeMp, p7Start).some((s) => Array.isArray(s.speakers) && s.speakers.length === 0),
          SHORT_HOLD_MS);
        const p7DrainSeen = p7DrainMs != null;
        // Finish the 30s hold (drain may have fired early); assert NO meet-idle.
        await holdAndPoll(detMp, codeMp, SHORT_HOLD_MS, 'phase7-hold');
        const p7IdleDuringHold = idleSince(detMp, codeMp, p7Start);

        // (recover) Activate the still-in-call tab → readable release (no-churn proof)
        // → the looping guest resumes being detected as a speaker within ~20s.
        const p7RecoverStart = Date.now();
        await tabBack(PORT_A);
        log('phase7 (recover): host Meet tab activated (still in-call) — expecting released reason=readable + guest speaking RESUMES (wav loops)');
        const p7ReadableMs = await waitFor(() => !!releasedLine(detMp, codeMp, p7RecoverStart, 'readable'), IDLE_HYSTERESIS_MS + 8_000);
        await sleep(2_000); // settle so a spurious post-recovery idle / churn surfaces
        const p7IdleAfterRecover = idleSince(detMp, codeMp, p7RecoverStart);
        const p7RecoverActiveCount = activeSince(detMp, codeMp, p7RecoverStart).length;
        const p7ResumeMs = await waitFor(
          () => speakingSince(detMp, codeMp, p7RecoverStart).some(namesGuest), 20_000);
        const p7Resumed = p7ResumeMs != null;

        {
          const preOk = p7HostActive != null && guestInCall && p7PreSpokeGuest;
          const engageOk = p7EngagedMs != null;
          const drainOk = p7DrainSeen;
          const holdOk = !p7IdleDuringHold;
          // Recovery: no-churn-by-design — readable edge + no idle + 0..1 meet-active.
          const recoverOk = p7ReadableMs != null && !p7IdleAfterRecover && p7RecoverActiveCount <= 1;
          const resumeOk = p7Resumed;
          const ok = preOk && engageOk && drainOk && holdOk && recoverOk && resumeOk;
          if (!ok) anyFail = true;
          record('mp-drain', ok ? 'PASS' : 'FAIL', {
            code: codeMp, guestName: GUEST_NAME_MP, guestAdmitted: !!admitted, guestInCall,
            preHoldSpeakingNamedGuestMs: p7PreSpeakMs,
            engagedMs: p7EngagedMs, liveDrainToEmptyMs: p7DrainMs, drainSeen: p7DrainSeen,
            meetIdleDuringHold: p7IdleDuringHold,
            releasedReadableMs: p7ReadableMs, meetActiveInRecoverWindow: p7RecoverActiveCount,
            meetIdleAfterRecover: p7IdleAfterRecover, guestSpeakingResumedMs: p7ResumeMs,
            note: 'multi-party live drain: a real remote speaker (looping WAV guest) drains to speakers:[] across the background-throttle blindness boundary, then resumes on recovery',
            reason: ok ? undefined
              : (!preOk ? (p7HostActive == null ? 'phase7 host join/detect failed'
                : !guestInCall ? 'the speaking guest never reached in-call (admit failed or Meet anonymous-join throttle)'
                  : 'no pre-hold speaking event NAMED the guest (the remote speaker was never resolved before the hold)')
                : !engageOk ? `bridge did NOT engage on background-throttle (no engaged reason=tab_present within ${BG_ENGAGE_TIMEOUT_MS / 1000}s)`
                  : !drainOk ? 'NO live speakers:[] drain arrived during the hold (the confidence-held speaker did not decay to [] across the blindness boundary — THE drain regression)'
                    : !holdOk ? 'meet-idle DURING the 30s multi-party hold (bridge did NOT hold)'
                      : !recoverOk ? (p7ReadableMs == null ? 'no released reason=readable after activation'
                        : p7IdleAfterRecover ? 'spurious meet-idle after activation (still-in-call call falsely ended on recovery)'
                          : `meet-active CHURN on recovery (${p7RecoverActiveCount}; >1 breaks no-churn-by-design)`)
                        : 'guest speaking did NOT resume being detected within ~20s after recovery (the looping WAV should re-light the ring)'),
          });
        }
      } catch (e) {
        anyFail = true;
        record('mp-drain', 'FAIL', { reason: 'phase7 threw: ' + String(e && e.message ? e.message : e) });
      } finally {
        try { if (pgMp) await clickLeave(pgMp); } catch (e) {}
        try { if (guestMp) await guestMp.kill(); } catch (e) {}
        guestMp = null;
        try { if (detMp) await detMp.stop(); } catch (e) {}
        detMp = null;
        try { if (chromeMp) await chromeMp.kill(); } catch (e) {}
        chromeMp = null;
        pgMp = null;
        try { rmSync(guestProfile, { recursive: true, force: true }); } catch (e) {}
        if (hostProfile.persistent) {
          const t0 = Date.now();
          while (Date.now() - t0 < 15_000 && !assertProfileNotInUse(hostProfile.dir)) { await sleep(1000); }
        }
      }

      // ---------------------------------------------------------------------
      // PHASE 8 — MP-REMOTE-END (best-effort, non-gating SKIP if the mechanics don't
      // hold): the C5 evidence run. The DETECTOR-watched Chrome joins as a GUEST of a
      // meeting HOSTED by the .rig-profiles/host bot Chrome; the bot host ENDS THE
      // MEETING FOR ALL while the watched guest tab is BACKGROUNDED.
      //   Assert bridge engaged pre-end (the guest tab was backgrounded → keep-alive
      //   holds the key). Then the host ends-for-all; measure how long until the WATCHED
      //   side ends (released + meet-idle) and by WHICH path:
      //     • reactivation → the reloaded/closed call reads not-in-call → reason=left, or
      //     • cap           → the bridge cap expires with no liveness → reason=expired.
      //   Record the measured PHANTOM DURATION (end-for-all → watched meet-idle) — the
      //   C5 evidence. If ending-for-all is not drivable from the bot host UI, SKIP with
      //   diagnostics (does NOT gate the roll-up).
      // ---------------------------------------------------------------------
      const botHostProfile = hostProfile.persistent ? hostProfile.dir
        : (() => { const t = mkdtempSync(join(tmpdir(), 'meet-tabaway-bothost-')); copyAuth(t); return t; })();
      try {
        detMp = startDetector(true); // watches the GUEST-side (detector-watched) Chrome
        log('phase8 (mp-remote-end): detector spawned — the watched Chrome joins as a GUEST of a bot-hosted meeting');
        // Bot host = .rig-profiles/host, hosts a fresh meeting (speaking WAV so it is a
        // real live participant). Serialized: the persistent profile lock cleared above.
        botHostMp = await launchMpChrome({ port: PORT_BOTHOST, profile: botHostProfile, wav: HOST_WAV, label: 'BOTHOST', temp: !hostProfile.persistent });
        await botHostMp.conn.cmd('Page.navigate', { url: 'https://meet.google.com/new' });
        let meetingUrl = '';
        for (let i = 0; i < 40 && !/meet\.google\.com\/[a-z]{3}-[a-z]{3,4}-[a-z]{3}/i.test(meetingUrl); i++) {
          await sleep(1500);
          meetingUrl = (await botHostMp.conn.evalJs('location.href')) || '';
          await botHostMp.conn.evalJs(`(function(){var b=[...document.querySelectorAll('button,span')].find(function(n){return /^(Join now|Ask to join)$/i.test((n.textContent||'').trim())});if(b)b.click();})()`);
        }
        meetingUrl = meetingUrl.split('?')[0];
        const codeMp2 = (meetingUrl.match(/meet\.google\.com\/([a-z]{3}-[a-z]{3,4}-[a-z]{3})/i) || [])[1] || '';
        const botInCall = await mpWaitInCall(botHostMp.conn, JOIN_TIMEOUT_MS);
        log(`phase8 bot host in-call: ${botInCall} url=${meetingUrl} code=${codeMp2}`);

        // The DETECTOR-watched Chrome joins as a GUEST (temp profile, distinct name).
        const watchedProfile = mkdtempSync(join(tmpdir(), 'meet-tabaway-watched-'));
        chromeMp = launchTempChrome(PORT_BOTHOST + 100, watchedProfile);
        // launchTempChrome opens on meet.google.com/new; navigate it to the bot's URL.
        pgMp = await attachToPage(PORT_BOTHOST + 100, /google\.com/);
        const watchedGuestName = 'Watched Guest';
        const wAsk = await mpGuestAsk(pgMp, meetingUrl, watchedGuestName);
        log(`phase8 watched guest ("${watchedGuestName}") asked to join: ${wAsk}`);
        const wAdmit = await admit({ hostPort: PORT_BOTHOST, guestPorts: [PORT_BOTHOST + 100], guestName: watchedGuestName, timeoutSec: 90, log });
        const watchedInCall = wAdmit && await mpWaitInCall(pgMp, 30_000);
        log(`phase8 watched guest admitted+in-call: ${wAdmit}/${watchedInCall}`);
        const p8DetectMs = await waitFor(() => activeSince(detMp, codeMp2, 0).length > 0, JOIN_TIMEOUT_MS);

        // Background the WATCHED guest tab → engage (bridge holds the key).
        await tabAway(PORT_BOTHOST + 100);
        const p8BgStart = Date.now();
        log('phase8: watched guest tab backgrounded — expecting engage reason=tab_present, then host ends-for-all');
        const p8EngagedMs = await waitFor(() => !!engagedLine(detMp, codeMp2, p8BgStart), BG_ENGAGE_TIMEOUT_MS);

        // Drive END-FOR-ALL from the bot host UI: click "Leave call" ▸ "End the call for
        // everyone" (aka "End call for all"). Best-effort — the label/flow varies; if we
        // cannot find the end-for-all control, SKIP.
        const endForAllExpr = `(function(){
          function clickByName(rx){var re=new RegExp(rx,'i');var el=[...document.querySelectorAll('button,[role=button],[role=menuitem],span,div')].find(function(n){return n.getBoundingClientRect().width>0&&re.test((n.getAttribute('aria-label')||'')+' '+(n.textContent||''))});if(!el)return null;el.click();return (el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,40);}
          // Open the Leave-call split control / menu, then choose end-for-all.
          var a = clickByName('Leave call');
          return {leave:a};
        })()`;
        const endConfirmExpr = `(function(){
          function clickByName(rx){var re=new RegExp(rx,'i');var el=[...document.querySelectorAll('button,[role=button],[role=menuitem],span,div')].find(function(n){return n.getBoundingClientRect().width>0&&re.test((n.getAttribute('aria-label')||'')+' '+(n.textContent||''))});if(!el)return null;el.click();return (el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,40);}
          return {end: clickByName('End the call for everyone|End call for (all|everyone)|End meeting for all')};
        })()`;
        await botHostMp.conn.evalJs(endForAllExpr);
        await sleep(1200);
        const endRes = await botHostMp.conn.evalJs(endConfirmExpr);
        const p8EndStart = Date.now();
        const endDrivable = !!(endRes && endRes.end && endRes.end !== 'null');
        log(`phase8 end-for-all attempt: ${JSON.stringify(endRes)} → drivable=${endDrivable}`);

        if (!endDrivable) {
          record('mp-remote-end', 'SKIP', {
            code: codeMp2, watchedInCall, engagedMs: p8EngagedMs, endResult: endRes,
            note: 'end-the-call-for-everyone control not drivable from the bot host UI (label/flow variant) — best-effort phase, records SKIP',
            reason: 'end-for-all-mechanism-unavailable',
          });
        } else {
          // Measure how long until the WATCHED side ends (released + meet-idle) and by
          // WHICH path. The bridge holds the phantom until reactivation reads not-in-call
          // (reason=left) OR the cap expires (reason=expired). We DO reactivate the tab
          // partway so a reactivation-path end is observable within budget; the released
          // reason we actually see records the path.
          await sleep(8_000); // let the phantom sit a beat (measure the bridge holding it)
          try { await tabBack(PORT_BOTHOST + 100); } catch (e) {} // reactivate → reloads not-in-call
          const p8ReleasedLeft = await waitFor(() => !!releasedLine(detMp, codeMp2, p8EndStart, 'left'), 40_000);
          const p8ReleasedExpired = releasedLine(detMp, codeMp2, p8EndStart, 'expired');
          const p8IdleMs = await waitFor(() => idleSince(detMp, codeMp2, p8EndStart), 60_000);
          const releasedPath = p8ReleasedLeft != null ? 'left' : (p8ReleasedExpired ? 'expired' : 'none');
          const phantomMs = p8IdleMs; // end-for-all → watched meet-idle (the C5 phantom duration)
          const ended = p8IdleMs != null;
          // Non-gating: PASS records the C5 evidence; if the watched side never ended
          // within budget, SKIP with the diagnostics (mechanics didn't hold) rather than
          // FAIL — this is best-effort per the plan.
          if (ended) {
            record('mp-remote-end', 'PASS', {
              code: codeMp2, detectMs: p8DetectMs, engagedMs: p8EngagedMs,
              endForAll: endRes, releasedPath, phantomDurationMs: phantomMs,
              note: `C5 evidence: host ended-for-all while the watched guest tab was BACKGROUNDED; the watched side ended after ${phantomMs}ms via reason=${releasedPath}`,
            });
          } else {
            record('mp-remote-end', 'SKIP', {
              code: codeMp2, detectMs: p8DetectMs, engagedMs: p8EngagedMs,
              endForAll: endRes, releasedPath,
              note: 'end-for-all fired but the watched side did not reach meet-idle within the measurement budget — mechanics did not hold, records SKIP (best-effort, non-gating)',
              reason: 'watched-side-did-not-end-in-budget',
            });
          }
        }
        try { rmSync(watchedProfile, { recursive: true, force: true }); } catch (e) {}
      } catch (e) {
        // Best-effort: any throw is a SKIP with diagnostics, NOT a FAIL.
        record('mp-remote-end', 'SKIP', { reason: 'phase8 threw (best-effort SKIP): ' + String(e && e.message ? e.message : e) });
      } finally {
        try { if (pgMp) await clickLeave(pgMp); } catch (e) {}
        try { if (chromeMp) await chromeMp.kill(); } catch (e) {}
        chromeMp = null; pgMp = null;
        try { if (botHostMp) { await clickLeave(botHostMp.conn); } } catch (e) {}
        try { if (botHostMp) await botHostMp.kill(); } catch (e) {}
        botHostMp = null;
        try { if (detMp) await detMp.stop(); } catch (e) {}
        detMp = null;
      }
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
    try { if (pgMp) await clickLeave(pgMp); } catch (e) {}
    try { if (det) await det.stop(); } catch (e) {}
    try { if (detCap) await detCap.stop(); } catch (e) {}
    try { if (detMp) await detMp.stop(); } catch (e) {}
    try { if (chromeA) await chromeA.kill(); } catch (e) {}
    try { if (chromeB) await chromeB.kill(); } catch (e) {}
    try { if (chromeMp) await chromeMp.kill(); } catch (e) {}
    // Multi-party extra seats (--multiparty): guest + bot host. Each phase's own
    // finally normally nulls these; this is the belt-and-suspenders backstop.
    try { if (guestMp) await guestMp.kill(); } catch (e) {}
    try { if (botHostMp) await botHostMp.kill(); } catch (e) {}
  }
  return anyFail ? 1 : 0;
}

async function main() {
  if (!process.argv.includes('--tabaway')) {
    console.error('[tabaway] usage: node meet-tabaway-live.mjs --tabaway [--no-reactivate] [--multiparty]');
    console.error('[tabaway]   --no-reactivate: IF the OPTIONAL discard phase fires, close the Meet tab');
    console.error('[tabaway]                    (tabGone → reason=gone) instead of reactivating it');
    console.error('[tabaway]   --multiparty:    after the solo phases 1-6, run phase 7 mp-drain (GATING:');
    console.error('[tabaway]                    a speaking guest drains to speakers:[] across the blindness');
    console.error('[tabaway]                    boundary, then resumes) + phase 8 mp-remote-end (best-effort');
    console.error('[tabaway]                    C5 evidence: host ends-for-all while the watched guest is bg).');
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
