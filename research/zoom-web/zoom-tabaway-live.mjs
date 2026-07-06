#!/usr/bin/env node
// ---------------------------------------------------------------------------
// zoom-tabaway-live (v1.0) — LIVE-QA rig for the ZOOM-WEB TAB-AWAY KEEP-ALIVE
// bridge adapter (the live gate for un-gating MSD_ZOOM_TABSTRIP).
//
// This is the Zoom-web counterpart of the PROVEN Teams driver
// research/teams-web/teams-tabaway-live.mjs (@ v1.0). It reuses that driver's
// helpers + architecture VERBATIM where possible (cdp-lib's httpJsonPut PUT-created
// blank tab for a genuine background-throttle, bounded blocking polls, phase-boundary
// drains, solo-release guards, the no-throttle tolerance branch, raw stderr/wire/driver
// log persistence, append-only per-phase results, SIGTERM teardown) and swaps in only
// the Zoom-web policy: (1) FULLY AUTOMATED native hosting (unlike Teams, which prompts
// an operator — Zoom hosting IS scriptable, so this rig is autonomous), and (2) the REAL
// keep-alive vocabulary the SHIPPING binary composes for the `zoom:` adapter.
//
// GATE PURPOSE
// ------------
// The Zoom-web tab-away bridge adapter (bubbles-dev-tabaway, macos/zoom/ZoomTabAway.swift,
// landing as G3b on feature/meet-tabaway-keepalive) SHIPS DARK —
// ZoomTabAwayKeepAlive.defaultEnabled == false. MSD_ZOOM_TABSTRIP=1 force-enables it. It
// cannot un-gate until it has its OWN live rig scenario (the Meet adapter un-gated only
// after meet-tabaway-live went green; the Teams adapter after teams-tabaway-live). THIS
// driver is that scenario. A roll-up PASS here is the live gate for flipping
// ZoomTabAwayKeepAlive.defaultEnabled to true.
//
// WHY BACKGROUND-THROTTLE IS THE CANONICAL BLINDNESS (Zoom-web sweep 2026-07-07)
// -----------------------------------------------------------------------------
// research/zoom-web/tabaway-sweep-2026-07-07.md measured it: a Zoom-web meeting in a
// backgrounded Chrome tab THROTTLES, and the deep AXWebArea (app.zoom.us/wc/…) goes
// BLIND — measured blind BOTH quiet AND audible (like Teams-web, and unlike Meet, which
// exempts an audible tab). A naive probe reads not-in-call and the tracker ends the call
// on its first idle. The bridge re-emits the same meeting key from process-lifetime
// memory while the tab is throttled. Background-throttle — NOT tab discard — is therefore
// the canonical blindness this rig gates. There is NO discard phase and NO multiparty
// phase here (the 5-phase plan mirrors the Teams gate; the Meet driver's optional phases
// 3/7/8 have no Zoom-web analogue in this gate).
//
// THE REAL KEEP-ALIVE VOCABULARY (verbatim from the SHIPPING binary)
// -----------------------------------------------------------------
// Every assertion below is grounded in what the product actually composes at runtime.
// The two format sites live in shared/TabAwayBridge.swift (the platform-neutral core the
// `zoom:` adapter drives); ZoomTabAway.swift pins logTag="zoom-keepalive" /
// keyPrefix="zoom:".
//   engage  (TabAwayBridge.swift:76-77):
//     `\(logTag): engaged key=\(keyPrefix)\(key) reason=tab_present mic=\(micStr)`
//     → `zoom-keepalive: engaged key=zoom:<key> reason=tab_present mic=<m>`
//        <m> ∈ { browser_active | global_idle | unknown }   (micStr switch, lines 71-75)
//     The engage reason is ALWAYS `tab_present`.
//   release (TabAwayBridge.swift:81-82):
//     `\(logTag): released key=\(keyPrefix)\(key) reason=\(reason)`
//     → `zoom-keepalive: released key=zoom:<key> reason=<r>`
//     reason literals, one per emit site:
//       readable  — readable path recovered the live tree (tab activated again while
//                   STILL in-call): the bridge's normal recovery (TabAwayBridge.swift:114)
//       left      — a Zoom WebArea is readable but NOT in-call (TabAwayBridge.swift:155)
//       gone      — miss-path end, state==.tabGone: the tab-strip label stopped matching
//                   the remembered topic (TabAwayBridge.swift:191)
//       mic_idle  — miss-path end, mic==.globalIdle && sawBrowserMic (TabAwayBridge.swift:192)
//       expired   — miss-path end, cap expired, no positive liveness (TabAwayBridge.swift:192)
//
// THE ZOOM-SPECIFIC LEAVE TERMINATOR (load-bearing, phase 4)
// ---------------------------------------------------------
// Unlike Teams (whose post-leave tab label is UNCHANGED, so ONLY the readable-not-in-call
// `left` clear ends it), Zoom's post-leave tab NAVIGATES: on Leave the URL leaves
// /wc/<id>/…/join → app.zoom.us/wc/ home and the strip label REVERTS to a bare `Zoom`
// (sweep Z6/Z7). So the remembered TOPIC stops matching — a NATURAL terminator. The bridge
// can therefore end via EITHER of two reasons and BOTH are correct:
//   • released reason=left — the readable-not-in-call clear fired first (foreground, the
//     Zoom WebArea was readable but reported not-in-call), OR
//   • released reason=gone — the miss-path saw the label revert to bare `Zoom` (which the
//     remembered-topic matcher rejects), so state==.tabGone → .end.
// The driver ACCEPTS EITHER and RECORDS WHICH (informationally). It asserts the OUTCOME
// (bridge released + meet-idle within hysteresis + no re-engage), not one hard-pinned
// reason — a concurrent leave-path fix (G2c) may change which clear wins the race, so
// pinning a single reason would be brittle.
//
// THE WIRE KEY == THE STDERR KEY (a Zoom-web simplification vs Teams)
// ------------------------------------------------------------------
// The wire events are the UNIFIED tokens for EVERY platform — `meet-active` / `meet-idle`
// / `speaking` (MonitorCore.swift:537/617/756) — distinguished by the `platform` field
// ("Zoom") and the `key`. There is NO `zoom-active` wire event; the zoomWebProbe detection
// surfaces as a `meet-active` with platform="Zoom". CRITICALLY, unlike Teams (whose
// consumer URL carries no id, so stableMeetingKey falls back to the normalized URL and the
// wire key has NO `teams:` prefix), Zoom /wc/<digits> URLs DO carry a per-meeting identity:
// stableMeetingKey (MeetingKey.swift:47-53) extracts the numeric conference id and yields
// `zoom:<digits>` — so the WIRE key IS `zoom:<digits>`, WITH the prefix. The adapter's
// identity STRIPS the `zoom:` prefix for the memory key and keyPrefix RE-ADDS it for the
// log, so the LOGGED key is `zoom:<digits>` too. Net:
//   • wire  `meet-active`/`meet-idle`/`speaking` key  == `zoom:<digits>`   (WITH zoom: prefix)
//   • stderr `zoom-keepalive: … key=zoom:<digits>`                          (SAME string)
// The driver LEARNS the wire key from the first Zoom meet-active and ASSERTS it CONTAINS
// the /wc/<digits> conference digits (the per-meeting identity). The stderr key equals the
// wire key verbatim (no prefix re-derivation needed, unlike the Teams driver).
//
// HOSTING / JOIN FLOW (FULLY AUTONOMOUS — no operator prompts)
// -----------------------------------------------------------
// UNLIKE the Teams gate (native hosting + lobby admit are not scriptable, so it prompts an
// operator), ZOOM HOSTING IS AUTOMATABLE. This driver reuses the Zoom sweep's machinery
// (qa/zoom-live/zoom-host-lib.mjs, the same lib research/zoom-web/host-bootstrap.mjs and
// tabaway-sweep-driver.mjs @ 4186932 drive):
//   1. bootstrapMeeting()  — the signed-in NATIVE Zoom app starts a fresh instant meeting
//                            (free-tier "New meeting").
//   2. harvestInvite()     — ⌘I → Copy invite link → pbpaste yields the
//                            `zoom.us/j/<id>?pwd=<pwd>` invite; guestUrl() rewrites it to
//                            the `/wc/join/<id>?pwd=<pwd>&un=<name>` web-client join URL.
//   3. rig Chrome joins /wc/ as a web guest (name → Join → join-audio-by-computer).
//   4. admitLoop()         — the native host admits the web guest from the waiting room.
// No stdin, no human. Phase 5 (cap-only) bootstraps a SECOND fresh native meeting the same
// way (free tier caps a meeting at 40 min, so a fresh bootstrap is the norm anyway).
//
//   node research/zoom-web/zoom-tabaway-live.mjs --tabaway
//     ZOOM_MEETING_URL=<zoom.us/j/… URL>  reuse/rejoin a specific meeting (skips bootstrap
//                                         harvest for phases 1-4; the host-lib honors it)
//     ZOOM_GUEST_NAME=<name>              guest display name (default "QA Web Guest")
//
// Env contract with the PRODUCT detector (owned by the Swift side):
//   MSD_DETECTOR_BIN     path to the product bubbles-meet-detector (REQUIRED — this rig
//                        gates the SHIPPING binary, not the sandbox build).
//   MSD_MIC_BIN          path to the product bubbles-mic-detector (mic-hint source).
//   MSD_ZOOM_TABSTRIP=1  opt the Zoom-web tab-away path IN (it ships dark by default).
//   MSD_EDGE_LOG=1       emit [event] diagnostics AND the plain keep-alive lifecycle lines.
//   MSD_AUTOSTART=1      auto-start the engine (no UI click).
//   MSD_RUN_SECONDS=N    clean auto-exit after N seconds (flushes walk-stats); we SIGTERM
//                        (never SIGKILL) so that flush lands.
//   MSD_CHROME_PROFILE   persistent rig profile dir (see PROFILE RESOLUTION below).
//
// PHASES (all assertions against the REAL vocabulary above):
//   1  detect              — bootstrap a native-hosted meeting; rig Chrome joins /wc/ as a
//                            web guest, admitted from the native waiting room. Assert the
//                            detector emits a Zoom meet-active for the learned key + LEARN
//                            the wire key AND assert it contains the /wc/<digits> conference
//                            digits (Zoom carries per-meeting identity).
//   2  bg-throttle-cycle   — CANONICAL: background the web tab (PUT tab-away → the renderer
//                            throttles → the app.zoom.us/wc AXWebArea goes blind) → assert
//                            `zoom-keepalive: engaged … reason=tab_present` within ~15s, NO
//                            meet-idle for a 30s hold, speakers [] released iff someone spoke
//                            pre-hold (solo guard), then activate → `released … reason=readable`
//                            + ≤1 fresh meet-active + no idle.
//   3  longer-hold         — 2-min background hold. engage required-if-throttled (the
//                            no-throttle tolerance branch, like Meet v3.1), zero idle,
//                            readable recovery.
//   4  leave-ends          — foreground, LEAVE the call via the Zoom web UI (the sweep's
//                            Leave→Leave-Meeting selector). THE ZOOM-SPECIFIC ASSERTION:
//                            post-leave the tab NAVIGATES off /wc/ and the label reverts to
//                            bare `Zoom`, so the bridge ends via released reason=left
//                            (readable-not-in-call) OR reason=gone (label-mismatch tabGone)
//                            — accept EITHER, record which — AND meet-idle within hysteresis
//                            AND no re-engage in 30s.
//   5  cap-only            — a FRESH native-hosted meeting, NO mic feeder, background →
//                            engaged mic=unknown, 30s hold, reactivate → released
//                            reason=readable, then leave → meet-idle.
//
// Roll-up PASS = all five (phase-3's no-throttle branch tolerated). Persist raw logs per
// run like the Teams v1.0 driver. Baked-in discipline: every wait is a bounded blocking
// poll (no monitors); boundary drains between all phases; results append-only.
// ---------------------------------------------------------------------------
'use strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, copyFileSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createRequire } from 'node:module';

// cdp-lib.js is CommonJS and lives in the Meet live dir; bridge it into this ESM driver.
const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const LIVE = join(REPO, 'research', 'meet-dom-detector', 'live');
const { attachToPage, httpJson, httpJsonPut, sleep } = require(join(LIVE, 'cdp-lib.js'));

// The Zoom native-hosting machinery (the SAME lib host-bootstrap.mjs +
// tabaway-sweep-driver.mjs @ 4186932 drive). Hosting IS scriptable for Zoom, so this rig
// is FULLY AUTONOMOUS — bootstrapMeeting() starts a native instant meeting, harvestInvite()
// yields the /j/ invite (rewritten to the /wc/ web-client join URL), admitLoop() admits the
// web guest from the waiting room, endMeeting() tears down.
//
// NB: zoom-host-lib.mjs has an IMPORT-TIME side effect — it `process.exit(1)`s if
// MSD_DETECTOR_BIN is set but the binary is missing (fail fast). We import it LAZILY (inside
// runTabAway, AFTER our own binary-existence guards have already written the 5-phase FAIL
// ledger) so a bogus-binary run still emits per-phase FAILs + the roll-up, rather than dying
// silently at module load. `zoomHost` and `hostLog` are populated by loadZoomHost().
let zoomHost = null;
let hostLog = null;
async function loadZoomHost() {
  if (!zoomHost) {
    zoomHost = await import(join(REPO, 'qa', 'zoom-live', 'zoom-host-lib.mjs'));
    hostLog = zoomHost.makeLog('zw-host');
  }
  return zoomHost;
}

const RESULTS_NDJSON = join(HERE, 'zoom-tabaway-results.ndjson');
const SCENARIO = 'zoom-tabaway-live';

// The PRODUCT binaries this rig gates. Both must already exist — fail fast BEFORE any
// Chrome/meeting infrastructure launches (nothing to tear down yet).
const DETECTOR_BIN = process.env.MSD_DETECTOR_BIN
  || '/Users/bibekthapa/projects/work/bubbles-dev/packages/desktop/native/bubbles-meet-detector/dist/darwin/bubbles-meet-detector';
const MIC_BIN = process.env.MSD_MIC_BIN
  || '/Users/bibekthapa/projects/work/bubbles-dev/packages/desktop/native/bubbles-mic-detector/dist/darwin/bubbles-mic-detector';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_SRC = join(homedir(), 'Library/Application Support/Google/Chrome');

// Persistent-profile candidates, in resolution order (mirrors the Teams driver + the
// Zoom-web sweep, which used research/meet-dom-detector/live/.rig-profiles/host).
const PROFILE_DIR = join(LIVE, '.rig-profiles');
const PROFILE_HOST = join(PROFILE_DIR, 'host');

const GUEST_NAME = process.env.ZOOM_GUEST_NAME || 'QA Web Guest';

// --- Timings (ms unless _SEC). Tunable; kept modest so the whole pass fits inside the
// live-session budget. Phase-3's 2-minute hold is the long one. -------------------
const SHORT_HOLD_MS = 30_000;      // phases 2 & 5 background-throttle hold (no meet-idle)
const LONG_HOLD_MS = 120_000;      // phase 3 sustained background-throttle hold
const STDERR_POLL_MS = 3_000;      // cadence for polling during a hold
const IDLE_HYSTERESIS_MS = 10_000; // meet-idle must arrive within normal hysteresis
// Background-throttle → the URL loop misses the meeting + engages. The renderer throttle
// can take a few frame-budget cycles to bite, so allow ~15s (Meet/Teams phase-2 latency).
const BG_ENGAGE_TIMEOUT_MS = 15_000;
const JOIN_TIMEOUT_MS = 120_000;   // green-room → in-call (includes the native waiting-room admit)
const MIC_ACTIVE_TIMEOUT_MS = 25_000; // Zoom-web grabbing the real mic after join
const ADMIT_WAIT_MS = 120_000;     // native-side admit-loop budget (host + web guest = 2)
const QUIT_GRACE_MS = 6_000;       // persistent-profile clean-quit grace before SIGTERM

// Total detector wall budget: bootstrap + join + detect + all phases + settle. The detector
// auto-exits on MSD_RUN_SECONDS (flushing walk-stats); we SIGTERM as the backstop.
const DETECTOR_RUN_SECONDS = 600;  // 10 min — covers two native bootstraps + the 2-min hold

const log = (...a) => console.log('[zoom-tabaway]', ...a);
const nowSec = () => Math.floor(Date.now() / 1000);

// ===========================================================================
// RAW-EVIDENCE PERSISTENCE (mirrors the Teams v1.0 driver). A per-run log directory
// captures the COMPLETE detector streams + the rig's phase actions so a forensic read has
// the verbatim timeline. Created lazily on first use; research/zoom-web/logs/ is gitignored
// (root .gitignore `logs` rule — unanchored, matches any logs dir) so raw traces (which may
// show a meeting URL) never commit.
//   stderr.log  — every detector stderr line, `mono=<ms> wall=<ISO> | <line>`
//   wire.ndjson — every detector stdout wire event, {mono,wall,raw:<orig-json>}
//   driver.log  — the rig's own phase actions (tabAway/tabBack/leave/host-bootstrap)
// `mono` is a monotonic ms clock (process.hrtime.bigint) immune to wall-clock steps.
// ===========================================================================
const MONO0 = process.hrtime.bigint();
const monoMs = () => Number((process.hrtime.bigint() - MONO0) / 1000000n);
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const LOGS_DIR = join(HERE, 'logs');
const RUN_LOG_DIR = join(LOGS_DIR, `tabaway-${RUN_STAMP}`);
let _logStreams = null;
function runLogStreams() {
  if (_logStreams) return _logStreams;
  mkdirSync(RUN_LOG_DIR, { recursive: true });
  _logStreams = {
    stderr: createWriteStream(join(RUN_LOG_DIR, 'stderr.log'), { flags: 'a' }),
    wire: createWriteStream(join(RUN_LOG_DIR, 'wire.ndjson'), { flags: 'a' }),
    driver: createWriteStream(join(RUN_LOG_DIR, 'driver.log'), { flags: 'a' }),
  };
  log(`raw-evidence log dir: ${RUN_LOG_DIR}`);
  return _logStreams;
}
function teeStderr(line) {
  try { runLogStreams().stderr.write(`mono=${monoMs()} wall=${new Date().toISOString()} | ${line}\n`); } catch (e) {}
}
function teeWire(rawJson) {
  try { runLogStreams().wire.write(JSON.stringify({ mono: monoMs(), wall: new Date().toISOString(), raw: rawJson }) + '\n'); } catch (e) {}
}
function driverLog(action, detail) {
  const rec = { mono: monoMs(), wall: new Date().toISOString(), action, ...(detail || {}) };
  try { runLogStreams().driver.write(JSON.stringify(rec) + '\n'); } catch (e) {}
  log(`driver: ${action}` + (detail ? ` ${JSON.stringify(detail)}` : ''));
}
function closeLogStreams() {
  if (!_logStreams) return;
  for (const s of [_logStreams.stderr, _logStreams.wire, _logStreams.driver]) { try { s.end(); } catch (e) {} }
}

// Per-phase verdict ledger — accumulated so a single roll-up line gates the whole scenario
// (the live reader qa/live-scenario-verdict.mjs takes the LAST line for a scenario id;
// per-phase lines carry a distinct `scenario:phase` id so they never collide with the
// aggregate roll-up written LAST).
const phaseVerdicts = [];
function record(phase, verdict, detail) {
  phaseVerdicts.push({ phase, verdict });
  const line = JSON.stringify({ scenario: `${SCENARIO}:${phase}`, phase, verdict, ts: nowSec(), ...detail });
  appendFileSync(RESULTS_NDJSON, line + '\n');
  log(`RESULT ${phase}: ${verdict}` + (detail && detail.reason ? ` — ${detail.reason}` : ''));
}

// Aggregate roll-up: PASS iff ALL five phases passed. There are NO optional phases in this
// Zoom-web gate (unlike Meet's discard/mp-remote-end SKIP-tolerant phases). A phase-3
// no-throttle run still records PASS from its tolerance branch (below), so it never SKIPs.
// Written LAST under the bare `zoom-tabaway-live` scenario id so live-scenario-verdict.mjs
// gates on it.
function recordSummary() {
  const failed = phaseVerdicts.filter((p) => p.verdict !== 'PASS').map((p) => p.phase);
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
    + (skipped.length ? ` — skipped: ${skipped.join(', ')}` : ''));
  return verdict;
}

// ===========================================================================
// Pre-flight: Accessibility trust + screen-lock guard (identical policy to the Teams
// driver — the detector reads the Zoom window via AX and returns EMPTY without trust, and
// a LOCKED session yields a degenerate AX tree that false-FAILs every assertion). The
// native hosting also needs AX (host-lib drives the Zoom app via the AX helper).
// ===========================================================================
function preflightAxTrust() {
  const probe = join(mkdtempSync(join(tmpdir(), 'axtrust-')), 'probe.swift');
  writeFileSync(probe, 'import ApplicationServices\nprint(AXIsProcessTrusted() ? "TRUSTED" : "UNTRUSTED")\n');
  const r = spawnSync('swift', [probe], { encoding: 'utf8', timeout: 120_000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (!out.includes('TRUSTED') || out.includes('UNTRUSTED')) {
    console.error('[zoom-tabaway] FATAL: Accessibility permission is NOT granted for this process.');
    console.error('[zoom-tabaway] Fix: System Settings → Privacy & Security → Accessibility → enable the terminal,');
    console.error('[zoom-tabaway] then re-run. Probe output: ' + JSON.stringify(out));
    return false;
  }
  log('Accessibility trust: OK');
  return true;
}
function preflightNotLocked() {
  const r = spawnSync('ioreg', ['-n', 'IOHIDSystem', '-d', '4', '-r'], { encoding: 'utf8', timeout: 10_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/"IOConsoleLocked"\s*=\s*(Yes|No|true|false|1|0)/i);
  if (m && /^(yes|true|1)$/i.test(m[1])) {
    console.error('[zoom-tabaway] FATAL: the macOS session is LOCKED (IOConsoleLocked=' + m[1] + ').');
    console.error('[zoom-tabaway] A locked session yields a degenerate AX tree — every tab-away assertion would');
    console.error('[zoom-tabaway] false-FAIL. Unlock the screen and keep it awake (caffeinate), then re-run.');
    return false;
  }
  log('screen-lock guard: unlocked' + (m ? ` (IOConsoleLocked=${m[1]})` : ' (IOConsoleLocked key absent — assumed unlocked)'));
  return true;
}

// ===========================================================================
// AUTONOMOUS Zoom native hosting (the Zoom sweep's machinery). Unlike Teams (where
// hosting/admit are not scriptable and the driver prompts an operator), Zoom hosting IS
// automatable: bootstrapMeeting() starts a native instant meeting, harvestInvite() yields
// the /j/ invite, and admitLoop() admits the web guest from the waiting room. No stdin.
// ===========================================================================
// invite (…zoom.us/j/<id>?pwd=<pwd>) → web-client join URL (same parse as the sweep
// driver's guestUrl() and qa/zoom-live/zoom-web-guest.mjs).
function guestUrl(inviteUrl, name) {
  const m = inviteUrl.match(/zoom\.us\/j\/(\d+)\?pwd=([\w.-]+)/);
  if (!m) throw new Error(`unparseable invite URL: ${inviteUrl}`);
  return `https://app.zoom.us/wc/join/${m[1]}?pwd=${m[2]}&un=${encodeURIComponent(name)}`;
}

// Bootstrap a FRESH native-hosted meeting + harvest its /j/ invite URL. Returns the invite
// URL (or null on failure). FULLY AUTONOMOUS — drives the signed-in native Zoom app.
async function bootstrapAndHarvest(label) {
  driverLog('host:bootstrap', { label });
  if (!zoomHost.preflightSignedIn()) { log(`${label}: Zoom app not signed in`); return null; }
  const started = await zoomHost.bootstrapMeeting(hostLog);
  if (!started) { log(`${label}: bootstrapMeeting failed`); return null; }
  const invite = process.env.ZOOM_MEETING_URL || await zoomHost.harvestInvite(hostLog);
  driverLog('host:invite', { label, harvested: !!invite });
  return invite || null;
}

// After the rig Chrome asks to join, the web guest sits in the native waiting room until
// the host admits it. Drive the native-side admit loop (host + web guest = roster 2), then
// bounded-wait for the guest tab to reach in-call. Returns true if in-call within JOIN_TIMEOUT_MS.
async function admitAndWaitInCall(pg, label) {
  driverLog('host:admit', { label });
  // Native-side admit (roster target 2 = native host + the one web guest).
  const admitted = await zoomHost.admitLoop({ targetCount: 2, waitMs: ADMIT_WAIT_MS }, hostLog);
  driverLog('host:admit-result', { label, admitted, roster: zoomHost.rosterCount() });
  // Regardless of the host-side roster read, the load-bearing signal is the guest tab
  // reaching in-call — bounded-poll the page for it.
  const inCall = await waitFor(async () => await pgInCall(pg), JOIN_TIMEOUT_MS, 1500);
  return inCall != null;
}

// ===========================================================================
// Mic-hint feeder: spawn the PRODUCT bubbles-mic-detector, transform its lines, and write
// them into the detector's stdin (the "real signal chain minus the desktop TS layer").
// VERBATIM from the Teams/Meet driver — the mic-hint stdin protocol is platform-neutral
// (`mic active=0|1 bundle=<id|->`).
// ===========================================================================
function transformMicLine(line) {
  const s = line.trim();
  if (!s) return null;
  if (s === 'MIC_IDLE') return 'mic active=0 bundle=-';
  if (s === 'MIC_ACTIVE') return 'mic active=1 bundle=-';
  if (s.startsWith('MIC_ACTIVE')) {
    const m = s.match(/\bbundle="([^"]*)"/);
    const bundle = m && m[1] ? m[1] : '-';
    return `mic active=1 bundle=${bundle}`;
  }
  return null; // LOG / unknown — do not forward
}
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
      try { if (detectorStdin && detectorStdin.writable) detectorStdin.write(hint + '\n'); } catch (e) {}
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', () => {});
  proc.on('error', (e) => log('mic feeder spawn error: ' + e.message));
  return { proc, stop() { try { proc.kill('SIGTERM'); } catch (e) {} } };
}

// ===========================================================================
// Detector: spawn the PRODUCT binary with stdin OPEN (for the mic feeder) and capture
// stdout wire events + stderr lifecycle lines. SIGTERM (not SIGKILL) on teardown so
// walk-stats flush. MSD_ZOOM_TABSTRIP=1 opts the Zoom-web tab-away path IN.
// ===========================================================================
function startDetector(wireMic) {
  const env = {
    ...process.env,
    MSD_AUTOSTART: '1',
    MSD_ZOOM_TABSTRIP: '1',
    MSD_EDGE_LOG: '1',
    MSD_RUN_SECONDS: String(DETECTOR_RUN_SECONDS),
  };
  const proc = spawn(DETECTOR_BIN, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [];      // parsed stdout wire events (meet-active / speaking / meet-idle)
  const stderrLines = []; // {ts, line} for the keep-alive lifecycle + [event] echoes
  const bufs = { out: '', err: '' };
  const onData = (stream) => (d) => {
    bufs[stream] += d.toString();
    let i;
    while ((i = bufs[stream].indexOf('\n')) >= 0) {
      const ln = bufs[stream].slice(0, i); bufs[stream] = bufs[stream].slice(i + 1);
      if (stream === 'err') { stderrLines.push({ ts: Date.now(), line: ln }); teeStderr(ln); }
      const j = ln.indexOf('{');
      if (j < 0) continue;
      let o; try { o = JSON.parse(ln.slice(j)); } catch (e) { continue; }
      if (o && typeof o === 'object' && o.event) {
        events.push({ ts: Date.now(), ...o });
        if (stream === 'out') teeWire(ln.slice(j));
      }
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
// PROFILE RESOLUTION + concurrent-use guard for the rig Chrome (mirrors the Teams driver +
// the sweep — the persistent signed-in profile is reused IN PLACE, clean-quit only, never
// two Chromes on one user-data-dir).
// ===========================================================================
function resolveHostProfile() {
  const envDir = process.env.MSD_CHROME_PROFILE;
  if (envDir && existsSync(envDir)) { log(`rig profile: MSD_CHROME_PROFILE → ${envDir}`); return { dir: envDir, persistent: true }; }
  if (envDir) log(`rig profile: MSD_CHROME_PROFILE set to a MISSING path (${envDir}) — falling through`);
  if (existsSync(PROFILE_HOST)) { log(`rig profile: persistent host → ${PROFILE_HOST}`); return { dir: PROFILE_HOST, persistent: true }; }
  console.error('[zoom-tabaway] WARN No persistent rig profile found — falling back to a copy-auth temp profile.');
  const dir = mkdtempSync(join(tmpdir(), 'zoom-tabaway-'));
  copyAuth(dir);
  return { dir, persistent: false };
}
function assertProfileNotInUse(dir) {
  const r = spawnSync('pgrep', ['-fl', `--user-data-dir=${dir}`], { encoding: 'utf8', timeout: 10_000 });
  const out = (r.stdout || '').trim();
  const hits = out.split('\n').filter((l) => l && /Google Chrome/i.test(l));
  if (hits.length > 0) {
    console.error(`[zoom-tabaway] FATAL: a Chrome is ALREADY running with --user-data-dir=${dir}`);
    console.error('[zoom-tabaway] Two Chromes cannot share one persistent profile. Quit that Chrome and re-run:');
    for (const h of hits) console.error('[zoom-tabaway]   ' + h);
    return false;
  }
  return true;
}

// ===========================================================================
// Rig Chrome. REAL mic (--use-fake-ui-for-media-stream, NO fake DEVICE) so the OS mic
// signal actually flips (sweep §Rig setup). Persistent = clean-quit (Browser.close →
// SIGTERM, never SIGKILL/rmSync); temp fallback = SIGKILL + rmSync.
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
  '--use-fake-ui-for-media-stream',            // auto-grant gUM, capture the REAL default mic
  '--autoplay-policy=no-user-gesture-required',
  'about:blank',
];
function launchPersistentChrome(port, dir) {
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--profile-directory=Default',
    ...CHROME_ARGS_TAIL,
  ], { stdio: 'ignore', detached: true });
  proc.unref();
  return {
    proc, profile: dir, port, persistent: true,
    async kill() {
      try {
        const v = await httpJson(port, '/json/version');
        const wsUrl = v && v.webSocketDebuggerUrl;
        if (wsUrl) {
          const { WS } = require(join(LIVE, 'cdp-lib.js'));
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
function launchTempChrome(port, dir) {
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--profile-directory=Default',
    ...CHROME_ARGS_TAIL,
  ], { stdio: 'ignore', detached: true });
  proc.unref();
  return {
    proc, profile: dir, port, persistent: false,
    async kill() { try { proc.kill('SIGKILL'); } catch (e) {} try { rmSync(dir, { recursive: true, force: true }); } catch (e) {} },
  };
}

// ===========================================================================
// Zoom-web guest join (the sweep's name → Join → join-audio-by-computer flow). Extracted
// from research/zoom-web/tabaway-sweep-driver.mjs (joinGuest). Navigates the attached page
// to the /wc/join web-client URL and drives the pre-join flow; the native host then admits
// from the waiting room (admitAndWaitInCall).
// ===========================================================================
function setNameInput(page, name) {
  return page.evalJs(`(() => {
    const i = document.querySelector('#input-for-name, input[type=text], input[placeholder*="name" i]');
    if (!i) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, ${JSON.stringify(name)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`, 8_000);
}
function clickByText(page, reSrc) {
  return page.evalJs(`(() => {
    const re = ${reSrc};
    const els = [...document.querySelectorAll('button,[role=button],a')];
    const b = els.find(e => re.test((e.innerText || e.getAttribute('aria-label') || '').trim()));
    if (b) { b.click(); return true; } return false;
  })()`, 8_000);
}
function readJoinState(page) {
  return page.evalJs(`(() => ({
    hasNameInput: !!document.querySelector('#input-for-name'),
    inFooter: !!document.querySelector('[aria-label*="mute" i], [class*="footer-button"]'),
    needsAudioJoin: /join audio by computer|join with computer audio/i.test(document.body?.innerText || ''),
    needsSignIn: /sign in to join|please sign in/i.test(document.body?.innerText || ''),
    url: location.href, title: document.title,
  }))()`, 8_000);
}
// Drive the Zoom-web guest pre-join flow to the point where it ASKS to join (lands in the
// native waiting room). Mirrors the sweep driver's joinGuest name→Join→audio loop.
async function zoomGuestAsk(page, inviteUrl, name, joinTimeoutMs = 90_000) {
  const url = guestUrl(inviteUrl, name);
  driverLog('guestAsk', { url: url.split('?')[0], name });
  await page.cmd('Page.navigate', { url });
  const t0 = Date.now();
  let clickedJoin = false, lastState = {};
  while (Date.now() - t0 < joinTimeoutMs) {
    let st;
    try { st = await readJoinState(page); } catch (e) { await sleep(1500); continue; }
    lastState = st;
    if (st.needsSignIn) return { stage: 'auth-wall', ...st };
    if (st.hasNameInput) {
      await setNameInput(page, name);
      await sleep(400);
      await clickByText(page, '/^join$/i');
      clickedJoin = true;
    }
    if (st.needsAudioJoin) await clickByText(page, '/join audio by computer|join with computer audio|join audio/i');
    // Reached the footer (in-call controls present) — asked to join / in the room.
    if (clickedJoin && !st.hasNameInput && st.inFooter) return { stage: 'asked', ...st };
    await sleep(2000);
  }
  return { stage: 'timeout', ...lastState };
}

// Is the attached page in-call? Mirrors the sweep's in-call heuristic (footer / call
// controls present AND not a waiting/lobby banner).
async function pgInCall(page) {
  try {
    const snap = await page.evalJs(`(() => {
      const footer = !!document.querySelector('[aria-label*="mute" i], [class*="footer-button"]');
      const body = (document.body ? document.body.innerText : '').slice(0,3000);
      return JSON.stringify({ footer, body });
    })()`, 8_000);
    let s = {}; try { s = JSON.parse(snap); } catch { s = {}; }
    const hay = (s.body || '').toLowerCase();
    const waiting = /waiting for the host|please wait|the host will let you in|you are in the waiting room/.test(hay);
    return !!s.footer && !waiting;
  } catch (e) { return false; }
}

// Drive the guest through the pre-join flow, then admit (native) + wait for in-call.
// Returns { page, inCall, url } — url is the live in-call URL (for logging).
async function joinZoomMeeting(port, inviteUrl, label) {
  const page = await attachToPage(port, /about:blank|^$|zoom\./);
  await zoomGuestAsk(page, inviteUrl, GUEST_NAME);
  await sleep(4000);
  const inCall = await admitAndWaitInCall(page, label);
  let url = '';
  try { url = (await page.evalJs('location.href', 6_000)) || ''; } catch (e) {}
  return { page, inCall, url: url.split('?')[0] };
}

// ===========================================================================
// Tab / leave drivers over CDP (mirror the Teams driver — a PUT-created + activated blank
// tab genuinely backgrounds the meeting tab so the renderer throttles).
// ===========================================================================
async function tabAway(port) {
  driverLog('tabAway', { port });
  await httpJsonPut(port, '/json/new?about:blank');
}
async function tabBack(port) {
  driverLog('tabBack', { port });
  const pg = await attachToPage(port, /app\.zoom\.us\/wc/);
  await pg.cmd('Page.bringToFront');
  return pg;
}
// Click Leave in the Zoom web UI (the sweep's Leave → Leave-Meeting confirm flow). Must be
// foreground. Post-leave the tab NAVIGATES off /wc/ and the label reverts to bare `Zoom`.
async function clickLeave(pg) {
  driverLog('clickLeave');
  try { await pg.cmd('Page.bringToFront'); } catch (e) {}
  const r = await pg.evalJs(`(() => {
    const els = [...document.querySelectorAll('button,[role=button]')];
    // Zoom web: "Leave" opens a confirm popover with "Leave Meeting".
    let el = els.find(e => /^leave$/i.test((e.getAttribute('aria-label')||e.innerText||'').trim()));
    if (el) { el.click(); }
    setTimeout(() => {
      const c = [...document.querySelectorAll('button,[role=button]')]
        .find(e => /leave meeting|leave now/i.test((e.getAttribute('aria-label')||e.innerText||'').trim()));
      if (c) c.click();
    }, 600);
    return el ? 'clicked-leave' : 'no-leave';
  })()`, 8_000);
  await sleep(1500); // let the confirm click + navigation off /wc/ land
  return r;
}

// ===========================================================================
// Assertion helpers over the captured detector streams.
//
// THE WIRE KEY is LEARNED from the first Zoom meet-active. UNLIKE Teams, the Zoom wire key
// IS `zoom:<digits>` (WITH the prefix — the /wc/<digits> conference id, MeetingKey.swift),
// and the STDERR keep-alive key is the SAME `zoom:<digits>` string (the adapter strips the
// prefix for the memory key, keyPrefix re-adds it for the log). So wireKey === stderrKey.
// ===========================================================================
const isZoom = (e) => e && e.platform === 'Zoom';
// The first Zoom meet-active's key IS the wire key the monitor diffs on.
const zoomActive = (det, sinceTs) =>
  det.events.filter((e) => e.event === 'meet-active' && isZoom(e) && (sinceTs == null || e.ts >= sinceTs));
const eventsForKey = (det, wireKey, sinceTs) =>
  det.events.filter((e) => e.key === wireKey && (sinceTs == null || e.ts >= sinceTs));
const stderrSince = (det, sinceTs) => det.stderrLines.filter((l) => sinceTs == null || l.ts >= sinceTs);
const idleSince = (det, wireKey, sinceTs) =>
  eventsForKey(det, wireKey, sinceTs).some((e) => e.event === 'meet-idle');
const activeSince = (det, wireKey, sinceTs) =>
  eventsForKey(det, wireKey, sinceTs).filter((e) => e.event === 'meet-active');
const speakingSince = (det, wireKey, sinceTs) =>
  eventsForKey(det, wireKey, sinceTs).filter((e) => e.event === 'speaking');

// The REAL engage line (TabAwayBridge.swift:76-77): reason is ALWAYS tab_present, key is
// zoom:<digits>. For Zoom the stderr key EQUALS the wire key (both `zoom:<digits>`).
const stderrKeyFor = (wireKey) => wireKey;
const engagedLine = (det, wireKey, sinceTs) => stderrSince(det, sinceTs).find((l) =>
  l.line.includes(`zoom-keepalive: engaged key=${stderrKeyFor(wireKey)}`) && l.line.includes('reason=tab_present'));
// The REAL release line (TabAwayBridge.swift:81-82) for a specific reason literal.
const releasedLine = (det, wireKey, sinceTs, reason) => stderrSince(det, sinceTs).find((l) =>
  l.line.includes(`zoom-keepalive: released key=${stderrKeyFor(wireKey)}`) && l.line.includes(`reason=${reason}`));
// Any release for the key (reason-agnostic) — used by the Zoom leave phase, which accepts
// EITHER reason=left (readable-not-in-call) OR reason=gone (label-mismatch tabGone).
const anyReleasedLine = (det, wireKey, sinceTs) => stderrSince(det, sinceTs).find((l) =>
  l.line.includes(`zoom-keepalive: released key=${stderrKeyFor(wireKey)}`));
const releaseReasonOf = (line) => { const m = line && line.match(/reason=(\w+)/); return m ? m[1] : null; };

// Hold for holdMs (bounded blocking poll), returning the wall time we started (for
// since-filtering). Logs a meet-idle observed DURING a hold (the regression).
async function holdAndPoll(det, wireKey, holdMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < holdMs) {
    await sleep(STDERR_POLL_MS);
    if (idleSince(det, wireKey, t0)) log(`${label}: meet-idle observed DURING hold (t+${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  return t0;
}
// Wait up to timeoutMs for a predicate (sync OR async) to become true. Returns ms elapsed
// when it fired, or null on timeout. Every wait in this driver goes through here (a bounded
// blocking poll — no background monitors).
async function waitFor(pred, timeoutMs, stepMs = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return Date.now() - t0;
    await sleep(stepMs);
  }
  return null;
}
// PHASE-BOUNDARY DRAIN (rig artifact, extracted from the Teams/Meet driver): a tabBack /
// reactivation at the END of phase N logs its `released reason=readable` on the detector's
// NEXT probe cycle, which can land AFTER phase N+1 stamps its since-timestamp — phase N+1's
// stray-release check then miscounts the leaked line and false-FAILs. Call AFTER the tabBack
// that ends phase N and BEFORE stamping phase N+1's since-timestamp: if the bridge was
// engaged in phase N (so a readable release is plausibly pending), wait up to ~10s for that
// release to land, then settle ~3s of quiet.
async function drainBoundary(det, wireKey, sinceTs, wasEngaged, label) {
  if (wasEngaged) {
    const landed = await waitFor(() => !!anyReleasedLine(det, wireKey, sinceTs), 10_000);
    log(`${label}: boundary drain — phase-N release ${landed != null ? `landed at +${landed}ms` : 'not seen within 10s (already drained or none pending)'}`);
  }
  await sleep(3_000);
}

// ===========================================================================
// Main scenario. Five phases; every wait is a bounded blocking poll; boundary drains
// between all phases; results append-only. Roll-up PASS = all five PASS (phase-3's
// no-throttle branch tolerated).
// ===========================================================================
async function runTabAway() {
  // APPEND semantics (zoom-wake lesson): seed an empty results file ONLY if none exists;
  // otherwise accumulate this scenario's phases alongside any prior run.
  if (!existsSync(RESULTS_NDJSON)) writeFileSync(RESULTS_NDJSON, '');

  const failAll = (reason) => {
    for (const ph of ['detect', 'bg-throttle-cycle', 'longer-hold', 'leave-ends', 'cap-only']) {
      record(ph, 'FAIL', { reason });
    }
  };
  if (!existsSync(DETECTOR_BIN)) { failAll(`detector binary missing at ${DETECTOR_BIN}`); return 1; }
  if (!existsSync(MIC_BIN)) { failAll(`mic-detector binary missing at ${MIC_BIN}`); return 1; }
  if (!preflightNotLocked()) { failAll('macOS session is locked (degenerate AX tree)'); return 1; }
  if (!preflightAxTrust()) { failAll('Accessibility permission not granted'); return 1; }

  // Only NOW import the native-hosting lib (it fail-fast process.exit(1)s at import if the
  // detector binary is missing — but our guards above already handled that case with a full
  // 5-phase FAIL ledger, so the binaries are present by here).
  await loadZoomHost();

  const hostProfile = resolveHostProfile();
  if (hostProfile.persistent && !assertProfileNotInUse(hostProfile.dir)) {
    failAll(`persistent rig profile already in use: ${hostProfile.dir}`);
    return 1;
  }

  const PORT_A = 9371;   // primary rig Chrome (phases 1-4, mic feeder wired) — sweep's measured port
  const PORT_B = 9373;   // cap-only rig Chrome (phase 5, SAME persistent profile, serialized, NO feeder)

  let det = null, detCap = null, chromeA = null, chromeB = null, pgA = null, pgB = null;
  let anyFail = false;

  try {
    // Bootstrap the (native-hosted) meeting for phases 1-4 up front + harvest its invite.
    const invite = await bootstrapAndHarvest('phases 1-4');
    if (!invite) { failAll('native Zoom bootstrap/invite-harvest failed (app not signed in, or New-meeting/⌘I harvest failed)'); return 1; }
    log(`phases 1-4 native-hosted meeting invite harvested (${invite.split('?')[0]})`);

    // === Detector with mic feeder wired (phases 1-4) ===
    det = startDetector(true);
    log(`detector spawned (MSD_ZOOM_TABSTRIP=1 MSD_EDGE_LOG=1, mic feeder from ${MIC_BIN})`);

    // === Rig Chrome: persistent profile IN PLACE (or the loud fallback). ===
    chromeA = hostProfile.persistent ? launchPersistentChrome(PORT_A, hostProfile.dir) : launchTempChrome(PORT_A, hostProfile.dir);
    log(`rig Chrome on :${PORT_A} (${hostProfile.persistent ? 'persistent in-place' : 'temp copyAuth'} profile ${hostProfile.dir}) — joining the native-hosted meeting as a web guest via /wc/ (real mic)…`);
    const joined = await joinZoomMeeting(PORT_A, invite, 'phase 1 — admit the guest');
    pgA = joined.page;
    log(`join result: inCall=${joined.inCall} url=${joined.url}`);

    // -----------------------------------------------------------------------
    // PHASE 1 — DETECT: the detector must emit a Zoom meet-active (the zoomWebProbe surfaces
    // as meet-active with platform="Zoom") for the meeting. LEARN the wire key from that
    // event — for Zoom it is `zoom:<digits>` (the /wc/<digits> conference id, WITH prefix) —
    // AND assert it CONTAINS the invite's conference digits (Zoom DOES carry per-meeting
    // identity, unlike the Teams URL fallback).
    // -----------------------------------------------------------------------
    const inviteDigits = (invite.match(/\/j\/(\d+)/) || [])[1] || null;
    const p1ActiveMs = await waitFor(() => zoomActive(det, 0).length > 0, JOIN_TIMEOUT_MS);
    const wireKey = p1ActiveMs != null ? zoomActive(det, 0).slice(-1)[0].key : null;
    const micActive = await waitFor(
      () => det.micSink.fed.some((f) => f.hint.startsWith('mic active=1')), MIC_ACTIVE_TIMEOUT_MS);
    // The load-bearing Zoom-web identity assertion: the wire key carries the conference digits.
    const keyHasDigits = !!(wireKey && inviteDigits && wireKey.includes(inviteDigits));
    if (p1ActiveMs == null || !wireKey) {
      anyFail = true;
      record('detect', 'FAIL', {
        reason: 'no Zoom meet-active emitted (guest never admitted/in-call, or the zoomWebProbe did not surface the meeting)',
        inCall: joined.inCall, zoomActiveEvents: zoomActive(det, 0).length,
      });
    } else if (!keyHasDigits) {
      anyFail = true;
      record('detect', 'FAIL', {
        reason: `Zoom wire key '${wireKey}' does NOT contain the /wc/ conference digits '${inviteDigits}' (per-meeting identity assertion failed)`,
        wireKey, inviteDigits, inCall: joined.inCall,
      });
    } else {
      const act = zoomActive(det, 0).slice(-1)[0];
      const verdict = 'PASS';
      record('detect', verdict, {
        wireKey, stderrKey: stderrKeyFor(wireKey), platform: act.platform,
        meetActiveMs: p1ActiveMs, self: act.self, inCall: joined.inCall,
        inviteDigits, keyHasDigits, micActiveHintSeen: micActive != null, title: act.title,
        note: 'zoomWebProbe surfaces on the UNIFIED wire as meet-active platform="Zoom"; wire key is zoom:<digits> (WITH prefix — MeetingKey extracts the /wc/<digits> conference id), and the stderr keep-alive key is the SAME zoom:<digits> string',
      });
    }

    // Guard: without a learned wire key the remaining phases cannot assert. Fail them fast.
    if (!wireKey) {
      for (const ph of ['bg-throttle-cycle', 'longer-hold', 'leave-ends', 'cap-only']) {
        record(ph, 'FAIL', { reason: 'phase 1 did not learn a Zoom wire key (no meet-active) — dependent phase cannot run' });
      }
      anyFail = true;
      return 1;
    }

    // -----------------------------------------------------------------------
    // PHASE 2 — BG-THROTTLE-CYCLE (CANONICAL): genuinely background the Zoom-web tab, hold,
    // then activate it — the full engage→hold→recover cycle the bridge ships for.
    //   (a) BACKGROUND (PUT-created + activated blank tab) → the renderer throttles → the
    //       app.zoom.us/wc AXWebArea goes BLIND → assert `zoom-keepalive: engaged …
    //       reason=tab_present` within ~15s (stamp the latency).
    //   (b) HOLD 30s: NO meet-idle (the bridge holds the key open across the throttle),
    //       speakers [] released iff someone spoke pre-hold (solo guard).
    //   (c) ACTIVATE (still in-call) → the live tree returns → `released … reason=readable`
    //       + ≤1 fresh meet-active (no-churn by design) + NO meet-idle.
    // -----------------------------------------------------------------------
    const p2Start = Date.now();
    await tabAway(PORT_A);
    log('phase2 (bg-throttle-cycle): Zoom tab genuinely backgrounded — expecting engaged reason=tab_present within ~15s');
    const p2EngagedMs = await waitFor(() => !!engagedLine(det, wireKey, p2Start), BG_ENGAGE_TIMEOUT_MS);
    const p2EngagedL = engagedLine(det, wireKey, p2Start);
    log('phase2: holding backgrounded 30s (expect ZERO meet-idle; speakers [] iff someone spoke pre-hold)');
    await holdAndPoll(det, wireKey, SHORT_HOLD_MS, 'phase2-hold');
    const p2IdleDuringHold = idleSince(det, wireKey, p2Start);
    const p2Speaks = speakingSince(det, wireKey, p2Start);
    const p2EmptyRelease = p2Speaks.some((s) => Array.isArray(s.speakers) && s.speakers.length === 0);
    const p2NonEmptyAfterRelease = p2Speaks.some((s) => Array.isArray(s.speakers) && s.speakers.length > 0);
    // SOLO GUARD: the wire emits `speaking` only on set CHANGES. If nobody ever spoke there
    // is no non-empty set to drain and no empty release will ever arrive — the release
    // assertion binds ONLY when someone actually spoke BEFORE the hold.
    const p2SinceHold = new Set(p2Speaks);
    const p2PreHoldSpoke = speakingSince(det, wireKey, 0)
      .some((s) => !p2SinceHold.has(s) && Array.isArray(s.speakers) && s.speakers.length > 0);
    const p2ReleaseOk = p2PreHoldSpoke ? p2EmptyRelease : true;
    // (c) Activate — STILL in-call, so the live tree returns → reason=readable. Recovery is
    // NO-CHURN BY DESIGN (the keep-alive Detection is rebuilt == the readable one —
    // rebuildDetection carries every == field verbatim), so proof = the readable release
    // edge + NO meet-idle + 0..1 meet-active (>1 = churn FAIL).
    const p2RecoverStart = Date.now();
    await tabBack(PORT_A);
    log('phase2: Zoom tab activated (still in-call) — expecting released reason=readable + NO meet-idle (no-churn by design)');
    const p2ReadableMs = await waitFor(() => !!releasedLine(det, wireKey, p2RecoverStart, 'readable'), IDLE_HYSTERESIS_MS + 8_000);
    const p2ReadableL = releasedLine(det, wireKey, p2RecoverStart, 'readable');
    await sleep(2_000);
    const p2IdleAfterRecover = idleSince(det, wireKey, p2RecoverStart);
    const p2RecoverActiveCount = activeSince(det, wireKey, p2RecoverStart).length;
    {
      const aOk = p2EngagedMs != null && p2EngagedL != null;
      const bOk = !p2IdleDuringHold && p2ReleaseOk && !p2NonEmptyAfterRelease;
      const cOk = p2ReadableMs != null && !p2IdleAfterRecover && p2RecoverActiveCount <= 1;
      const ok = aOk && bOk && cOk;
      if (!ok) anyFail = true;
      record('bg-throttle-cycle', ok ? 'PASS' : 'FAIL', {
        wireKey, engagedMs: p2EngagedMs, engagedLine: p2EngagedL ? p2EngagedL.line : null,
        meetIdleDuringHold: p2IdleDuringHold, emptySpeakingRelease: p2EmptyRelease, preHoldSpoke: p2PreHoldSpoke,
        speakingChurnAfterRelease: p2NonEmptyAfterRelease, speakingEvents: p2Speaks.length,
        releasedReadableMs: p2ReadableMs, releasedLine: p2ReadableL ? p2ReadableL.line : null,
        meetActiveInRecoverWindow: p2RecoverActiveCount, meetIdleAfterRecover: p2IdleAfterRecover,
        note: 'background-throttle canonical cycle: engage on background, hold with zero idle, recover readable on activate (no-churn by design)',
        reason: ok ? undefined
          : (!aOk ? `bridge did NOT engage on background-throttle (no engaged reason=tab_present within ${BG_ENGAGE_TIMEOUT_MS / 1000}s — the tab did not background/throttle, or the PUT tab-away failed)`
            : !bOk ? (p2IdleDuringHold ? 'meet-idle DURING the 30s background hold (bridge did NOT hold — THE regression)'
              : !p2ReleaseOk ? 'someone spoke pre-hold but no empty-speakers release during the hold'
                : 'unexpected speaking churn after the empty release')
            : (p2ReadableMs == null ? 'no released reason=readable after activating the still-in-call tab'
              : p2IdleAfterRecover ? 'spurious meet-idle after activation (the still-in-call call was falsely ended on recovery)'
                : `meet-active CHURN on recovery (${p2RecoverActiveCount}; >1 breaks the no-churn-by-design contract)`)),
      });
    }

    // -----------------------------------------------------------------------
    // PHASE 3 — LONGER-HOLD: sustained 2-minute background-throttle hold. Whether the bridge
    // engages depends on Chrome's background-throttle heuristic actually firing (measured
    // non-deterministic on the Meet driver). So: THROTTLED → require engage + readable
    // recovery; NOT THROTTLED → the tab stayed readable, nothing to bridge → require zero
    // idle + zero stray keep-alive lines (the no-throttle tolerance branch, Meet v3.1). A
    // meet-idle during the hold is ALWAYS a FAIL (the load-bearing invariant).
    // -----------------------------------------------------------------------
    await drainBoundary(det, wireKey, p2RecoverStart, p2EngagedMs != null, 'phase2→3');
    const p3Start = Date.now();
    await tabAway(PORT_A);
    log('phase3 (longer-hold): Zoom tab backgrounded — SUSTAINED 2-minute throttle hold (expect engage, ZERO meet-idle)');
    const p3EngagedMs = await waitFor(() => !!engagedLine(det, wireKey, p3Start), BG_ENGAGE_TIMEOUT_MS);
    await holdAndPoll(det, wireKey, LONG_HOLD_MS, 'phase3');
    const p3Idle = idleSince(det, wireKey, p3Start);
    const p3Engaged = engagedLine(det, wireKey, p3Start);
    const p3RecoverStart = Date.now();
    await tabBack(PORT_A);
    log('phase3: Zoom tab activated (still in-call) — expecting released reason=readable (if throttled)');
    const p3ReadableMs = await waitFor(() => !!releasedLine(det, wireKey, p3RecoverStart, 'readable'), IDLE_HYSTERESIS_MS + 8_000);
    {
      const throttled = !!p3Engaged;
      const noIdleOk = !p3Idle;
      const recoverOk = p3ReadableMs != null;
      const strayRelease = anyReleasedLine(det, wireKey, p3Start);
      const ok = throttled ? (noIdleOk && recoverOk) : (noIdleOk && !strayRelease);
      if (!ok) anyFail = true;
      record('longer-hold', ok ? 'PASS' : 'FAIL', {
        wireKey, holdMs: LONG_HOLD_MS, engagedMs: p3EngagedMs, throttled,
        meetIdleDuringHold: p3Idle, releasedReadableMs: p3ReadableMs,
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
    // PHASE 4 — LEAVE-ENDS (Zoom-specific terminator): tab FOREGROUND, click Leave via the
    // Zoom web UI. THE ZOOM-SPECIFIC ASSERTION: post-leave the tab NAVIGATES off /wc/ and the
    // strip label reverts to bare `Zoom` (sweep Z6/Z7). The bridge therefore ends via EITHER
    //   • released reason=left  (the readable-not-in-call clear, foreground), OR
    //   • released reason=gone  (the miss-path saw the label revert → tabGone → .end).
    // ACCEPT EITHER and RECORD WHICH (informationally — a concurrent leave-path fix G2c may
    // change which clear wins the race). Assert the OUTCOME: bridge released (either reason)
    // + meet-idle within hysteresis + no re-engage in the following 30s.
    // -----------------------------------------------------------------------
    await drainBoundary(det, wireKey, p3RecoverStart, !!p3Engaged, 'phase3→4');
    await tabBack(PORT_A);      // Zoom tab foreground so the Leave click registers
    await sleep(1500);
    const p4Start = Date.now();
    const leaveRes = await clickLeave(pgA);
    log(`phase4 (leave-ends): Leave clicked (${leaveRes}) — expecting released reason=left|gone + meet-idle < ${IDLE_HYSTERESIS_MS / 1000}s and no re-engage`);
    const p4ReleasedMs = await waitFor(() => !!anyReleasedLine(det, wireKey, p4Start), IDLE_HYSTERESIS_MS + 8_000);
    const p4ReleasedL = anyReleasedLine(det, wireKey, p4Start);
    const p4Reason = releaseReasonOf(p4ReleasedL && p4ReleasedL.line);
    const p4IdleMs = await waitFor(() => idleSince(det, wireKey, p4Start), IDLE_HYSTERESIS_MS + 5_000);
    // Watch a further 30s for an ILLEGAL re-engage (the regression: a bridge that failed to
    // clear on the navigation would re-engage on the next background).
    const reEngageWatchStart = Date.now();
    await sleep(SHORT_HOLD_MS);
    const p4ReEngaged = !!engagedLine(det, wireKey, reEngageWatchStart);
    {
      const idleInHysteresis = p4IdleMs != null && p4IdleMs <= IDLE_HYSTERESIS_MS;
      // The load-bearing assertion (OUTCOME, not a pinned reason): a release fired with reason
      // left OR gone, meet-idle within hysteresis, no re-engage. The reason is recorded but
      // EITHER left|gone passes — the Zoom navigation terminator can clear via either path.
      const reasonAccepted = p4Reason === 'left' || p4Reason === 'gone';
      const ok = p4ReleasedMs != null && reasonAccepted && idleInHysteresis && !p4ReEngaged;
      if (!ok) anyFail = true;
      record('leave-ends', ok ? 'PASS' : 'FAIL', {
        wireKey, meetIdleMs: p4IdleMs, idleInHysteresis,
        releasedMs: p4ReleasedMs, releasedReason: p4Reason, releasedLine: p4ReleasedL ? p4ReleasedL.line : null,
        reasonAccepted, reEngagedAfterLeave: p4ReEngaged,
        note: 'Zoom post-leave tab NAVIGATES off /wc/ and the label reverts to bare `Zoom`; the bridge ends via released reason=left (readable-not-in-call) OR reason=gone (label-mismatch tabGone) — EITHER accepted, reason recorded informationally (a G2c leave-path fix may change which clear wins)',
        reason: ok ? undefined
          : (p4ReleasedMs == null ? 'no released line for the key after Leave (neither reason=left nor reason=gone fired — the Zoom navigation terminator failed to clear the bridge)'
            : !reasonAccepted ? `release reason was '${p4Reason}' (expected left or gone — the Zoom leave/navigation terminator)`
              : !idleInHysteresis ? `no meet-idle < ${IDLE_HYSTERESIS_MS}ms after Leave`
                : 'detector RE-ENGAGED the bridge after Leave (the navigation-off-/wc/ terminator failed to close it) — THE regression'),
      });
    }

    // Tear down rig Chrome A + its detector before phase 5. Phase 5 relaunches the SAME
    // persistent profile — Chrome A MUST be fully clean-quit first (serialized: never two
    // Chromes on one profile). Stop the detector, clean-quit A, then WAIT for the profile
    // lock to clear before relaunching. Also END the phase-1..4 native meeting (fresh one
    // for phase 5; free tier caps at 40 min so a fresh bootstrap is the norm anyway).
    try { await det.stop(); } catch (e) {}
    det = null;
    try { await chromeA.kill(); } catch (e) {}
    chromeA = null;
    pgA = null;
    try { await zoomHost.endMeeting(hostLog); } catch (e) {}

    // -----------------------------------------------------------------------
    // PHASE 5 — CAP-ONLY (background-throttle, NO mic feeder, SERIALIZED on the SAME
    // persistent profile): a FRESH native-hosted meeting, join WITHOUT the mic feeder (no
    // stdin hints EVER → the advisory mic hint stays .unknown). Background-throttle: the
    // bridge must STILL engage on an .unknown mic (advisory law: .unknown never ends a
    // bridge), the engage line reporting mic=unknown; hold 30s with NO meet-idle; then
    // ACTIVATE (still in-call) → released reason=readable; then LEAVE → meet-idle.
    // -----------------------------------------------------------------------
    const capInvite = await bootstrapAndHarvest('phase 5 (cap-only) — FRESH meeting');
    if (!capInvite) {
      anyFail = true;
      record('cap-only', 'FAIL', { reason: 'phase 5 native Zoom bootstrap/invite-harvest failed' });
      return 1;
    }
    log(`phase 5 fresh native-hosted meeting invite harvested (${capInvite.split('?')[0]})`);
    detCap = startDetector(false); // NO mic feeder — stdin open but never written
    log('phase5 (cap-only): detector spawned WITHOUT mic feeder (advisory mic hint stays .unknown)');
    if (hostProfile.persistent) {
      const t0 = Date.now();
      while (Date.now() - t0 < 15_000 && !assertProfileNotInUse(hostProfile.dir)) { await sleep(1000); }
    }
    chromeB = hostProfile.persistent
      ? launchPersistentChrome(PORT_B, hostProfile.dir)
      : (() => { const t = mkdtempSync(join(tmpdir(), 'zoom-tabaway-b-')); copyAuth(t); return launchTempChrome(PORT_B, t); })();
    log(`phase5 Chrome on :${PORT_B} (${hostProfile.persistent ? 'SAME persistent in-place profile, serialized' : 'temp copyAuth fallback'}) — joining a FRESH native-hosted meeting (real mic, feeder OFF)…`);
    const joinedB = await joinZoomMeeting(PORT_B, capInvite, 'phase 5 — admit the guest');
    pgB = joinedB.page;
    log(`phase5 join result: inCall=${joinedB.inCall} url=${joinedB.url}`);
    // Learn the fresh meeting's wire key from its own meet-active (a fresh meeting keys on a
    // NEW conference id — always relearn).
    const p5ActiveMs = await waitFor(() => zoomActive(detCap, 0).length > 0, JOIN_TIMEOUT_MS);
    const wireKeyB = p5ActiveMs != null ? zoomActive(detCap, 0).slice(-1)[0].key : null;

    await tabAway(PORT_B);
    const p5Start = Date.now();
    log('phase5: Zoom tab genuinely backgrounded — expecting engage mic=unknown, holding 30s (cap-only, no mic hint)');
    const p5EngagedMs = wireKeyB ? await waitFor(() => !!engagedLine(detCap, wireKeyB, p5Start), BG_ENGAGE_TIMEOUT_MS) : null;
    if (wireKeyB) await holdAndPoll(detCap, wireKeyB, SHORT_HOLD_MS, 'phase5-hold');
    const p5Idle = wireKeyB ? idleSince(detCap, wireKeyB, p5Start) : false;
    const p5Engaged = wireKeyB ? engagedLine(detCap, wireKeyB, p5Start) : null;
    const p5EngagedUnknown = !!(p5Engaged && p5Engaged.line.includes('mic=unknown'));

    const p5RecoverStart = Date.now();
    let p5ReadableMs = null, p5IdleAfterRecover = false, p5RecoverActiveCount = 0;
    if (wireKeyB) {
      await tabBack(PORT_B);
      log('phase5: Zoom tab activated (still in-call) — expecting released reason=readable + NO meet-idle, then Leave → meet-idle');
      p5ReadableMs = await waitFor(() => !!releasedLine(detCap, wireKeyB, p5RecoverStart, 'readable'), IDLE_HYSTERESIS_MS + 8_000);
      await sleep(2_000);
      p5IdleAfterRecover = idleSince(detCap, wireKeyB, p5RecoverStart);
      p5RecoverActiveCount = activeSince(detCap, wireKeyB, p5RecoverStart).length;
    }

    // Now LEAVE the still-live meeting → meet-idle (the definitive end for this phase).
    await sleep(1500);
    const p5LeaveStart = Date.now();
    const p5LeaveRes = pgB ? await clickLeave(pgB) : 'no-page';
    log(`phase5: Leave clicked (${p5LeaveRes}) — expecting meet-idle < ${IDLE_HYSTERESIS_MS / 1000}s`);
    const p5IdleMs = wireKeyB ? await waitFor(() => idleSince(detCap, wireKeyB, p5LeaveStart), IDLE_HYSTERESIS_MS + 8_000) : null;
    {
      const detectOk = p5ActiveMs != null && !!wireKeyB;
      const bridgeHeld = detectOk && p5EngagedMs != null && !p5Idle && !!p5Engaged;
      const recoveredReadable = p5ReadableMs != null && !p5IdleAfterRecover && p5RecoverActiveCount <= 1;
      const endedOnLeave = p5IdleMs != null && p5IdleMs <= IDLE_HYSTERESIS_MS;
      const ok = bridgeHeld && p5EngagedUnknown && recoveredReadable && endedOnLeave;
      if (!ok) anyFail = true;
      record('cap-only', ok ? 'PASS' : 'FAIL', {
        wireKey: wireKeyB, detectSeen: detectOk,
        engagedMs: p5EngagedMs, meetIdleDuringHold: p5Idle,
        engagedLineSeen: !!p5Engaged, engagedMicUnknown: p5EngagedUnknown,
        engagedLine: p5Engaged ? p5Engaged.line : null,
        releasedReadableMs: p5ReadableMs, meetActiveInRecoverWindow: p5RecoverActiveCount,
        meetIdleAfterRecover: p5IdleAfterRecover,
        leaveResult: p5LeaveRes, meetIdleAfterLeaveMs: p5IdleMs,
        reason: ok ? undefined
          : (!detectOk ? 'phase5 join/detect failed (guest never admitted/in-call or no Zoom meet-active)'
            : !bridgeHeld
              ? (p5EngagedMs == null ? 'background-throttle did NOT engage the cap-only bridge (no engaged line — tab did not throttle)'
                : p5Idle ? 'cap-only bridge did NOT hold (meet-idle during hold with mic=unknown — advisory law violated)'
                  : 'no engaged keep-alive line during cap-only hold')
              : !p5EngagedUnknown ? 'engage line did NOT report mic=unknown (the feeder-less advisory mic should be unknown)'
                : !recoveredReadable ? (p5ReadableMs == null ? 'no readable recovery after activating the still-in-call tab (no released reason=readable)'
                  : p5IdleAfterRecover ? 'spurious meet-idle after activation (the still-in-call call was falsely ended on recovery)'
                    : `meet-active CHURN on recovery (${p5RecoverActiveCount}; >1 breaks the no-churn-by-design contract)`)
                  : 'meeting did NOT end on Leave (no meet-idle < hysteresis after the Leave click)'),
      });
    }
  } catch (e) {
    console.error('[zoom-tabaway] FATAL during scenario:', e && e.stack ? e.stack : e);
    anyFail = true;
    record('fatal', 'FAIL', { reason: String(e && e.message ? e.message : e) });
  } finally {
    // Teardown: leave calls, clean-quit rig Chromes (SERIAL on one persistent profile),
    // SIGTERM the detectors so walk-stats flush, END the native meeting. pgA is nulled after
    // A's clean-quit so we never Leave-click a dead tab here.
    try { if (pgA) await clickLeave(pgA); } catch (e) {}
    try { if (pgB) await clickLeave(pgB); } catch (e) {}
    try { if (det) await det.stop(); } catch (e) {}
    try { if (detCap) await detCap.stop(); } catch (e) {}
    try { if (chromeA) await chromeA.kill(); } catch (e) {}
    try { if (chromeB) await chromeB.kill(); } catch (e) {}
    try { await zoomHost.endMeeting(hostLog); } catch (e) {}
    driverLog('teardown-complete', { anyFail });
    closeLogStreams();
  }
  return anyFail ? 1 : 0;
}

async function main() {
  if (!process.argv.includes('--tabaway')) {
    console.error('[zoom-tabaway] usage: node research/zoom-web/zoom-tabaway-live.mjs --tabaway');
    console.error('[zoom-tabaway]   FULLY AUTONOMOUS: the signed-in NATIVE Zoom app hosts a fresh instant meeting;');
    console.error('[zoom-tabaway]   the rig Chrome joins as a web guest via /wc/ and is admitted from the native');
    console.error('[zoom-tabaway]   waiting room automatically (no operator prompts). Set ZOOM_MEETING_URL to reuse a');
    console.error('[zoom-tabaway]   specific meeting; ZOOM_GUEST_NAME sets the guest display name. MSD_DETECTOR_BIN /');
    console.error('[zoom-tabaway]   MSD_MIC_BIN override the product binary paths; MSD_CHROME_PROFILE points the rig');
    console.error('[zoom-tabaway]   Chrome at a persistent signed-in profile.');
    process.exit(2);
  }
  const code = await runTabAway();
  const summary = recordSummary();
  console.log('ZOOM TABAWAY LIVE SESSION COMPLETE');
  process.exit(summary === 'PASS' && code === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[zoom-tabaway] FATAL', e && e.stack ? e.stack : e);
  console.log('ZOOM TABAWAY LIVE SESSION COMPLETE');
  process.exit(1);
});
