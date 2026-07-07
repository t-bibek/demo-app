#!/usr/bin/env node
// ---------------------------------------------------------------------------
// teams-tabaway-live (v1.0) — LIVE-QA rig for the TEAMS-WEB TAB-AWAY KEEP-ALIVE
// bridge adapter (the live gate for un-gating MSD_TEAMS_TABSTRIP).
//
// This is the Teams-web counterpart of the PROVEN Meet driver
// research/meet-dom-detector/live/meet-tabaway-live.mjs (@ v3.3). It reuses that
// driver's helpers + architecture VERBATIM where possible (cdp-lib's httpJsonPut
// PUT-created blank tab for a genuine background-throttle, bounded blocking polls,
// phase-boundary drains, solo-release guards, the no-throttle tolerance branch, raw
// stderr/wire/driver log persistence, append-only per-phase results, SIGTERM
// teardown) and swaps in only the Teams-web policy: the join flow and the REAL
// keep-alive vocabulary the SHIPPING binary composes for the `teams:` adapter.
//
// GATE PURPOSE
// ------------
// The Teams-web tab-away bridge adapter (bubbles-dev-tabaway commit b789bd35 on
// feature/meet-tabaway-keepalive) SHIPS DARK — TeamsTabAwayKeepAlive.defaultEnabled
// == false. MSD_TEAMS_TABSTRIP=1 force-enables it. It cannot un-gate until it has
// its OWN live rig scenario (the Meet adapter un-gated only after meet-tabaway-live
// went green). THIS driver is that scenario. A roll-up PASS here is the live gate for
// flipping TeamsTabAwayKeepAlive.defaultEnabled to true.
//
// WHY BACKGROUND-THROTTLE IS THE CANONICAL BLINDNESS (Teams-web sweep 2026-07-07)
// ------------------------------------------------------------------------------
// research/teams-web/tabaway-sweep-2026-07-07.md measured it: a Teams-web meeting in
// a backgrounded Chrome tab THROTTLES, and the deep AXWebArea (teams.live.com/v2)
// goes BLIND — measured blind BOTH quiet AND audible (unlike Meet, which exempts an
// audible tab). A naive probe reads not-in-call and the tracker ends the call on its
// first idle. The bridge re-emits the same meeting key from process-lifetime memory
// while the tab is throttled. Background-throttle — NOT tab discard — is therefore
// the canonical blindness this rig gates. There is NO discard phase and NO
// multiparty phase here (the 5-phase plan); the Meet driver's optional phases 3/7/8
// have no Teams analogue in this gate.
//
// THE REAL KEEP-ALIVE VOCABULARY (verbatim from the SHIPPING binary)
// -----------------------------------------------------------------
// Every assertion below is grounded in what the product actually composes at runtime.
// The two format sites live in shared/TabAwayBridge.swift (the platform-neutral core
// the `teams:` adapter drives); TeamsTabAway.swift pins logTag="teams-keepalive" /
// keyPrefix="teams:".
//   engage  (TabAwayBridge.swift:76-77):
//     `\(logTag): engaged key=\(keyPrefix)\(key) reason=tab_present mic=\(micStr)`
//     → `teams-keepalive: engaged key=teams:<key> reason=tab_present mic=<m>`
//        <m> ∈ { browser_active | global_idle | unknown }   (micStr switch, lines 71-75)
//     The engage reason is ALWAYS `tab_present`.
//   release (TabAwayBridge.swift:81-82):
//     `\(logTag): released key=\(keyPrefix)\(key) reason=\(reason)`
//     → `teams-keepalive: released key=teams:<key> reason=<r>`
//     reason literals, one per emit site:
//       readable  — readable path recovered the live tree (tab activated again while
//                   STILL in-call): the bridge's normal recovery (TabAwayBridge.swift:114)
//       left      — a Teams WebArea is readable but NOT in-call: the call ended / the
//                   tab landed not-in-call (TabAwayBridge.swift:155). For Teams the
//                   post-leave tab LABEL is UNCHANGED (sweep T6/T7), so THIS clear is
//                   the load-bearing end path — the label alone can't tell left from
//                   in-call; the readable-not-in-call web-area read is what clears it.
//       gone      — miss-path end, state==.tabGone: the tab was closed (TabAwayBridge.swift:191)
//       mic_idle  — miss-path end, mic==.globalIdle && sawBrowserMic (TabAwayBridge.swift:192)
//       expired   — miss-path end, cap expired, no positive liveness (TabAwayBridge.swift:192)
//
// THE WIRE KEY vs THE STDERR KEY (a load-bearing Teams-web subtlety)
// -----------------------------------------------------------------
// The wire events are the UNIFIED tokens for EVERY platform — `meet-active` /
// `meet-idle` / `speaking` (MonitorCore.swift:537/617/755) — distinguished by the
// `platform` field ("Microsoft Teams") and the `key` prefix. There is NO `teams-active`
// wire event; the teamsWebProbe detection surfaces as a `meet-active` with
// platform="Microsoft Teams". For a consumer teams.live.com/v2 meeting the URL carries
// no extractable conversation id, so stableMeetingKey (MeetingKey.swift) FALLS THROUGH
// to normalizedBrowserURL → the WIRE key is the normalized URL (e.g.
// `https://teams.live.com/v2`), NOT `teams:<id>`. The keep-alive adapter's identity is
// that same URL string and keyPrefix re-adds `teams:` for the LOGGED key. So:
//   • wire  `meet-active`/`meet-idle`/`speaking` key  == <normalizedURL>       (no teams: prefix)
//   • stderr `teams-keepalive: … key=teams:<normalizedURL>`                    (teams: re-added)
// The driver therefore LEARNS the wire key from the first meet-active for a
// Microsoft-Teams detection and derives the stderr key as `teams:<wireKey>`. It never
// assumes an id-shaped key.
//
// HOSTING / JOIN FLOW (operator input needed — hosting is NOT scriptable)
// ----------------------------------------------------------------------
// Per the sweep (§Rig setup), the meeting is HOSTED by the NATIVE Teams app
// (com.microsoft.teams2, hosting a teams.live.com consumer meeting) and the rig Chrome
// joins as an ANONYMOUS WEB GUEST ("Continue on this browser" → type name → Join now),
// then is ADMITTED FROM THE NATIVE LOBBY by the human host. Native hosting + the lobby
// admit CANNOT be scripted from this driver (the sweep drove the native app via a
// separate TeamsDrive helper + a human). So this driver PROMPTS THE OPERATOR ONCE at
// start for the teams.live.com meeting URL (or reads MSD_TEAMS_MEETING_URL), waits on
// stdin, and — after the rig Chrome asks to join each phase's meeting — prints a
// one-line ADMIT prompt and waits for the guest to reach in-call. The operator hosts
// from the native app, shares the link, and admits the guest from the native lobby.
// Phases that need a FRESH meeting (4/5 re-use one meeting; the cap-only phase 5 asks
// for a fresh URL) re-prompt as noted per phase.
//
//   node research/teams-web/teams-tabaway-live.mjs --tabaway
//     MSD_TEAMS_MEETING_URL=<teams.live.com URL>  skip the interactive URL prompt
//     MSD_TEAMS_MEETING_URL_CAPONLY=<url>          fresh meeting for the cap-only phase 5
//                                                  (else the driver re-prompts on stdin)
//     MSD_TEAMS_GUEST_NAME=<name>                  guest display name (default "QA Web Guest")
//
// Env contract with the PRODUCT detector (owned by the Swift side):
//   MSD_DETECTOR_BIN     path to the product bubbles-meet-detector (REQUIRED — this rig
//                        gates the SHIPPING binary, not the sandbox build).
//   MSD_MIC_BIN          path to the product bubbles-mic-detector (mic-hint source).
//   MSD_TEAMS_TABSTRIP=1 opt the Teams-web tab-away path IN (it ships dark by default).
//   MSD_EDGE_LOG=1       emit [event] diagnostics AND the plain keep-alive lifecycle lines.
//   MSD_AUTOSTART=1      auto-start the engine (no UI click).
//   MSD_RUN_SECONDS=N    clean auto-exit after N seconds (flushes walk-stats); we SIGTERM
//                        (never SIGKILL) so that flush lands.
//   MSD_CHROME_PROFILE   persistent rig profile dir (see PROFILE RESOLUTION below).
//
// PHASES (all assertions against the REAL vocabulary above):
//   1  detect              — native app hosts; rig Chrome joins teams.live.com as an
//                            anonymous guest, admitted from the native lobby. Assert the
//                            detector emits a Microsoft-Teams meet-active (the teams wire
//                            equivalent) for the learned teams key + LEARN the wire key.
//   1b key-stability       — FOREGROUND: open the People panel via CDP (the roster
//                            control), wait ~5s, assert the wire key did NOT change (no
//                            meet-active on a DIFFERENT web-Teams key, no meet-idle for
//                            the original); close the panel, same assertion. Gates the
//                            G2f meeting-split fix: the consumer SPA prefixes `People | `
//                            onto the in-call title when the panel opens, so a title-key
//                            that kept the prefix would split the meeting mid-call. The
//                            fix keys on the LAST title segment (panel-prefix-proof).
//   2  bg-throttle-cycle   — CANONICAL: background the web tab (PUT tab-away → the
//                            renderer throttles → the teams.live.com/v2 AXWebArea goes
//                            blind) → assert `teams-keepalive: engaged … reason=tab_present`
//                            within ~15s, NO meet-idle for a 30s hold, speakers [] released
//                            iff someone spoke pre-hold (solo guard), then activate →
//                            `released … reason=readable` + ≤1 fresh meet-active + no idle.
//   3  longer-hold         — 2-min background hold. engage required-if-throttled (the
//                            no-throttle tolerance branch, like Meet v3.1), zero idle,
//                            readable recovery.
//   4  leave-ends          — foreground, LEAVE the call via the Teams web UI (the sweep's
//                            Leave control). Assert meet-idle within hysteresis AND
//                            released reason=left (the readable-not-in-call clear — the
//                            post-leave LABEL is UNCHANGED for Teams so this is THE
//                            load-bearing end path), no re-engage in 30s.
//   5  cap-only            — a FRESH meeting, NO mic feeder, background → engaged
//                            mic=unknown, 30s hold, reactivate → released reason=readable,
//                            then leave → meet-idle.
//
// Roll-up PASS = all phases (1, 1b, 2-5; phase-3's no-throttle branch tolerated). Persist
// raw logs per run like the Meet v3.3 driver. Baked-in discipline: every wait is a bounded
// blocking poll (no monitors); boundary drains between all phases; results append-only.
// ---------------------------------------------------------------------------
'use strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, copyFileSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

// cdp-lib.js is CommonJS and lives in the Meet live dir; bridge it into this ESM driver.
const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const LIVE = join(REPO, 'research', 'meet-dom-detector', 'live');
const { attachToPage, httpJson, httpJsonPut, sleep } = require(join(LIVE, 'cdp-lib.js'));

// AUTONOMOUS NATIVE HOSTING (default path). The Teams-host lib drives the native Teams
// app (com.microsoft.teams2) through TeamsDrive to bootstrap a throwaway teams.live.com
// meeting, harvest its invite link, admit the rig guest from the native lobby, and end
// the meeting on teardown — so this gate runs OPERATOR-FREE. Live-verified 2026-07-07
// (bootstrap→harvest→anon-guest-join→admit→roster 2→end, clean, twice in a row). When the
// lib reports unavailable (Teams not signed in / AX not trusted / a step proves
// unscriptable), the driver falls back to the operator prompt / MSD_TEAMS_MEETING_URL env.
// MSD_TEAMS_NO_HOST=1 forces the operator/env fallback (e.g. to host from a different box).
import * as teamsHost from '../../qa/teams-live/teams-host-lib.mjs';
const hostLog = teamsHost.makeLog('teams-tabaway');

const RESULTS_NDJSON = join(HERE, 'teams-tabaway-results.ndjson');
const SCENARIO = 'teams-tabaway-live';

// The PRODUCT binaries this rig gates. Both must already exist — fail fast BEFORE any
// Chrome/meeting infrastructure launches (nothing to tear down yet).
const DETECTOR_BIN = process.env.MSD_DETECTOR_BIN
  || '/Users/bibekthapa/projects/work/bubbles-dev/packages/desktop/native/bubbles-meet-detector/dist/darwin/bubbles-meet-detector';
const MIC_BIN = process.env.MSD_MIC_BIN
  || '/Users/bibekthapa/projects/work/bubbles-dev/packages/desktop/native/bubbles-mic-detector/dist/darwin/bubbles-mic-detector';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_SRC = join(homedir(), 'Library/Application Support/Google/Chrome');

// Persistent-profile candidates, in resolution order (mirrors the Meet driver + the
// Teams-web sweep, which used research/meet-dom-detector/live/.rig-profiles/host).
const PROFILE_DIR = join(LIVE, '.rig-profiles');
const PROFILE_HOST = join(PROFILE_DIR, 'host');

const GUEST_NAME = process.env.MSD_TEAMS_GUEST_NAME || 'QA Web Guest';

// --- Timings (ms unless _SEC). Tunable; kept modest so the whole pass fits inside the
// live-session budget. Phase-3's 2-minute hold is the long one. -------------------
const SHORT_HOLD_MS = 30_000;      // phases 2 & 5 background-throttle hold (no meet-idle)
const LONG_HOLD_MS = 120_000;      // phase 3 sustained background-throttle hold
const STDERR_POLL_MS = 3_000;      // cadence for polling during a hold
const IDLE_HYSTERESIS_MS = 10_000; // meet-idle must arrive within normal hysteresis
// Background-throttle → the URL loop misses the meeting + engages. The renderer throttle
// can take a few frame-budget cycles to bite, so allow ~15s (Meet driver's phase-2 latency).
const BG_ENGAGE_TIMEOUT_MS = 15_000;
const JOIN_TIMEOUT_MS = 90_000;    // green-room → in-call (includes the human lobby admit)
const MIC_ACTIVE_TIMEOUT_MS = 25_000; // Teams grabbing the real mic after join
const QUIT_GRACE_MS = 6_000;       // persistent-profile clean-quit grace before SIGTERM

// Total detector wall budget: join + detect + all phases + settle. The detector
// auto-exits on MSD_RUN_SECONDS (flushing walk-stats); we SIGTERM as the backstop.
const DETECTOR_RUN_SECONDS = 540;  // 9 min — covers two meetings + the 2-min hold + admits

const log = (...a) => console.log('[teams-tabaway]', ...a);
const nowSec = () => Math.floor(Date.now() / 1000);

// ===========================================================================
// RAW-EVIDENCE PERSISTENCE (mirrors the Meet v3.3 driver). A per-run log directory
// captures the COMPLETE detector streams + the rig's phase actions so a forensic read
// has the verbatim timeline. Created lazily on first use; research/teams-web/logs/ is
// gitignored (root .gitignore `logs` rule, line 18 — unanchored, matches any logs dir)
// so raw traces (which may show a meeting URL) never commit.
//   stderr.log  — every detector stderr line, `mono=<ms> wall=<ISO> | <line>`
//   wire.ndjson — every detector stdout wire event, {mono,wall,raw:<orig-json>}
//   driver.log  — the rig's own phase actions (tabAway/tabBack/leave/admit-prompt)
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

// Per-phase verdict ledger — accumulated so a single roll-up line gates the whole
// scenario (the live reader qa/live-scenario-verdict.mjs takes the LAST line for a
// scenario id; per-phase lines carry a distinct `scenario:phase` id so they never
// collide with the aggregate roll-up written LAST).
const phaseVerdicts = [];
function record(phase, verdict, detail) {
  phaseVerdicts.push({ phase, verdict });
  const line = JSON.stringify({ scenario: `${SCENARIO}:${phase}`, phase, verdict, ts: nowSec(), ...detail });
  appendFileSync(RESULTS_NDJSON, line + '\n');
  log(`RESULT ${phase}: ${verdict}` + (detail && detail.reason ? ` — ${detail.reason}` : ''));
}

// Aggregate roll-up: PASS iff ALL phases passed (1, 1b key-stability, 2-5). There are NO
// optional phases in this Teams-web gate (unlike Meet's discard/mp-remote-end SKIP-tolerant
// phases). A
// phase-3 no-throttle run still records PASS from its tolerance branch (below), so it
// never SKIPs. Written LAST under the bare `teams-tabaway-live` scenario id so
// live-scenario-verdict.mjs gates on it.
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
// Pre-flight: Accessibility trust + screen-lock guard (identical policy to the Meet
// driver — the detector reads the Teams window via AX and returns EMPTY without trust,
// and a LOCKED session yields a degenerate AX tree that false-FAILs every assertion).
// ===========================================================================
function preflightAxTrust() {
  const probe = join(mkdtempSync(join(tmpdir(), 'axtrust-')), 'probe.swift');
  writeFileSync(probe, 'import ApplicationServices\nprint(AXIsProcessTrusted() ? "TRUSTED" : "UNTRUSTED")\n');
  const r = spawnSync('swift', [probe], { encoding: 'utf8', timeout: 120_000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (!out.includes('TRUSTED') || out.includes('UNTRUSTED')) {
    console.error('[teams-tabaway] FATAL: Accessibility permission is NOT granted for this process.');
    console.error('[teams-tabaway] Fix: System Settings → Privacy & Security → Accessibility → enable the terminal,');
    console.error('[teams-tabaway] then re-run. Probe output: ' + JSON.stringify(out));
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
    console.error('[teams-tabaway] FATAL: the macOS session is LOCKED (IOConsoleLocked=' + m[1] + ').');
    console.error('[teams-tabaway] A locked session yields a degenerate AX tree — every tab-away assertion would');
    console.error('[teams-tabaway] false-FAIL. Unlock the screen and keep it awake (caffeinate), then re-run.');
    return false;
  }
  log('screen-lock guard: unlocked' + (m ? ` (IOConsoleLocked=${m[1]})` : ' (IOConsoleLocked key absent — assumed unlocked)'));
  return true;
}

// ===========================================================================
// Operator prompts — hosting the native Teams meeting + the lobby admit are NOT
// scriptable (the sweep drove the native app via a separate helper + a human). We
// prompt ONCE for the meeting URL (or read the env) and wait on stdin at each
// admit boundary. Every prompt is a BOUNDED blocking wait (no background monitors).
// ===========================================================================
function makeStdin() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const queue = [];
  const waiters = [];
  rl.on('line', (l) => { if (waiters.length) waiters.shift()(l); else queue.push(l); });
  return {
    // Resolve with the next stdin line (bounded by timeoutMs; null on timeout).
    nextLine(timeoutMs) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((res) => {
        const t = setTimeout(() => {
          const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); res(null);
        }, timeoutMs);
        const w = (l) => { clearTimeout(t); res(l); };
        waiters.push(w);
      });
    },
    close() { try { rl.close(); } catch (e) {} },
  };
}

// AUTONOMOUS-MODE availability: the default path natively hosts via teams-host-lib. It is
// available iff the caller did not force the fallback (MSD_TEAMS_NO_HOST=1), TeamsDrive is
// built, and AX trust is granted (Teams gets launched by bootstrapMeeting). Probed ONCE.
let _hostAvail = null;
function hostAvailable() {
  if (_hostAvail != null) return _hostAvail;
  if (process.env.MSD_TEAMS_NO_HOST === '1') { _hostAvail = false; log('autonomous native hosting DISABLED (MSD_TEAMS_NO_HOST=1) — operator/env fallback'); return _hostAvail; }
  const okBin = teamsHost.prebuild(hostLog);              // external-detector mode only needs TeamsDrive present
  const okAx = okBin && teamsHost.preflightAxTrust();
  _hostAvail = !!(okBin && okAx);
  log(`autonomous native hosting ${_hostAvail ? 'AVAILABLE' : 'UNAVAILABLE'} (TeamsDrive=${okBin} axTrust=${okAx}) — ${_hostAvail ? 'the gate hosts operator-free' : 'falling back to operator prompt / env URL'}`);
  return _hostAvail;
}
// Track meetings this run HOSTED so teardown ends them (never leaks a live native meeting
// that wedges the next gate). Keyed by label; value {url}. Only autonomous meetings land here.
const hostedMeetings = [];

// Resolve a teams.live.com meeting URL. DEFAULT (autonomous): bring native Teams to front,
// bootstrap a throwaway meeting, harvest its invite link — no operator, no env. FALLBACK:
// env var, else prompt the operator on stdin (bounded 5-minute wait). An explicit env URL
// ALWAYS wins (lets the operator pin a specific meeting even in autonomous mode).
async function resolveMeetingUrl(stdin, envVar, label) {
  const env = process.env[envVar];
  if (env && /^https?:\/\//i.test(env.trim())) { log(`${label} meeting URL from ${envVar}`); return env.trim(); }
  if (hostAvailable()) {
    log(`${label}: bootstrapping a throwaway native-hosted Teams meeting (autonomous, no operator)…`);
    teamsHost.preflightSignedIn();
    const boot = await teamsHost.bootstrapMeeting(hostLog);
    if (boot) {
      const url = await teamsHost.harvestInvite(hostLog);
      if (url) {
        hostedMeetings.push({ label, url });
        driverLog('autonomous-hosted', { label, urlHost: (() => { try { return new URL(url).host; } catch { return '?'; } })() });
        log(`${label}: hosted + harvested (host=${(() => { try { return new URL(url).host; } catch { return '?'; } })()}, id redacted)`);
        return url;
      }
      log(`${label}: bootstrap OK but invite harvest failed — falling back to operator/env`);
    } else {
      log(`${label}: autonomous bootstrapMeeting failed — falling back to operator/env`);
    }
  }
  console.log(`\n[teams-tabaway] ===== OPERATOR ACTION NEEDED (${label}) =====`);
  console.log('[teams-tabaway] 1. In the NATIVE Teams app, host a NEW teams.live.com (consumer) meeting.');
  console.log('[teams-tabaway] 2. Copy its "Share link" (the anonymous-guest join URL).');
  console.log(`[teams-tabaway] 3. Paste the URL here and press Enter (or set ${envVar} and re-run):`);
  driverLog('prompt:meeting-url', { label, envVar });
  for (;;) {
    const line = await stdin.nextLine(5 * 60_000);
    if (line == null) { console.log('[teams-tabaway] (still waiting for the meeting URL…)'); continue; }
    const url = line.trim();
    if (/^https?:\/\//i.test(url)) { driverLog('meeting-url-received', { label }); return url; }
    console.log('[teams-tabaway] that did not look like an http(s) URL — paste the teams.live.com share link:');
  }
}

// After the rig Chrome ASKS to join, the guest sits in the native lobby until the host
// admits it. DEFAULT (autonomous): admitLoop presses the native "Admit participant in
// lobby" control until the guest is in. FALLBACK: prompt the human operator. Either way,
// bounded-wait for the guest to reach in-call (the authoritative roster check — Teams
// native AX exposes no numeric count). Returns true if in-call within JOIN_TIMEOUT_MS.
async function promptAdmitAndWaitInCall(pg, stdin, label) {
  if (hostAvailable() && hostedMeetings.length > 0) {
    log(`${label}: auto-admitting the guest from the native lobby (autonomous)…`);
    driverLog('autonomous-admit', { label });
    // admitLoop presses Admit while the lobby signal persists; the guest-page in-call read
    // is the authoritative confirmation (host + guest == roster 2). Run them concurrently:
    // start the admit loop, and poll the guest page — return as soon as the page is in-call.
    const admitP = teamsHost.admitLoop({ targetCount: 2, waitMs: JOIN_TIMEOUT_MS }, hostLog);
    const inCall = await waitFor(async () => await pgInCall(pg), JOIN_TIMEOUT_MS, 1000);
    try { await admitP; } catch (e) {}
    return inCall != null;
  }
  console.log(`\n[teams-tabaway] ===== OPERATOR ACTION NEEDED (${label}) =====`);
  console.log('[teams-tabaway] The rig Chrome guest has asked to join. In the NATIVE Teams app,');
  console.log('[teams-tabaway] ADMIT the participant from the lobby ("Admit"). No stdin needed — the');
  console.log('[teams-tabaway] driver auto-detects in-call; press Enter only to nudge a re-check.');
  driverLog('prompt:admit', { label });
  const inCall = await waitFor(async () => await pgInCall(pg), JOIN_TIMEOUT_MS, 1000);
  return inCall != null;
}

// Teardown: end the native meeting this run hosted (autonomous mode) so no live meeting
// lingers to wedge the next gate. The native host is only ever in ONE call at a time (a
// "fresh" cap-only phase reuses the same live native call — bootstrapMeeting returns early
// when already in-call), so a single endMeeting drains it; it is idempotent (a no-op once
// the Leave button is gone), and we retry a couple times to be certain the call is gone.
// No-op when the operator hosted (nothing for us to end).
async function endHostedMeetings() {
  if (!hostAvailable() || hostedMeetings.length === 0) return;
  for (let i = 0; i < 2; i++) {
    try {
      const ended = await teamsHost.endMeeting(hostLog);
      driverLog('autonomous-teardown', { attempt: i + 1, ended, stillInMeeting: teamsHost.reallyInMeeting() });
      if (!teamsHost.reallyInMeeting()) break;
    } catch (e) { driverLog('autonomous-teardown-error', { error: String(e && e.message ? e.message : e) }); }
  }
}

// ===========================================================================
// Mic-hint feeder: spawn the PRODUCT bubbles-mic-detector, transform its lines, and
// write them into the detector's stdin (the "real signal chain minus the desktop TS
// layer"). VERBATIM from the Meet driver — the mic-hint stdin protocol is platform-
// neutral (`mic active=0|1 bundle=<id|->`).
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
// walk-stats flush. MSD_TEAMS_TABSTRIP=1 opts the Teams-web tab-away path IN.
// ===========================================================================
function startDetector(wireMic) {
  const env = {
    ...process.env,
    MSD_AUTOSTART: '1',
    MSD_TEAMS_TABSTRIP: '1',
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
// PROFILE RESOLUTION + concurrent-use guard for the rig Chrome (mirrors the Meet
// driver + the sweep — the persistent signed-in profile is reused IN PLACE, clean-quit
// only, never two Chromes on one user-data-dir).
// ===========================================================================
function resolveHostProfile() {
  const envDir = process.env.MSD_CHROME_PROFILE;
  if (envDir && existsSync(envDir)) { log(`rig profile: MSD_CHROME_PROFILE → ${envDir}`); return { dir: envDir, persistent: true }; }
  if (envDir) log(`rig profile: MSD_CHROME_PROFILE set to a MISSING path (${envDir}) — falling through`);
  if (existsSync(PROFILE_HOST)) { log(`rig profile: persistent host → ${PROFILE_HOST}`); return { dir: PROFILE_HOST, persistent: true }; }
  console.error('[teams-tabaway] WARN No persistent rig profile found — falling back to a copy-auth temp profile.');
  const dir = mkdtempSync(join(tmpdir(), 'teams-tabaway-'));
  copyAuth(dir);
  return { dir, persistent: false };
}
function assertProfileNotInUse(dir) {
  const r = spawnSync('pgrep', ['-fl', `--user-data-dir=${dir}`], { encoding: 'utf8', timeout: 10_000 });
  const out = (r.stdout || '').trim();
  const hits = out.split('\n').filter((l) => l && /Google Chrome/i.test(l));
  if (hits.length > 0) {
    console.error(`[teams-tabaway] FATAL: a Chrome is ALREADY running with --user-data-dir=${dir}`);
    console.error('[teams-tabaway] Two Chromes cannot share one persistent profile. Quit that Chrome and re-run:');
    for (const h of hits) console.error('[teams-tabaway]   ' + h);
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
// Teams-web anonymous guest join (sweep's continue-on-web → name → mic-on → join).
// Extracted from research/teams-web/tabaway-sweep-driver.mjs (joinGuest). Navigates
// the attached page to the meeting URL and drives the pre-join flow; the human then
// admits from the native lobby (promptAdmitAndWaitInCall).
// ===========================================================================
async function teamsGuestAsk(page, meetingUrl, name) {
  driverLog('guestAsk', { url: meetingUrl.split('?')[0], name });
  const click = (needle) => page.evalJs(`(() => {
    const els = [...document.querySelectorAll('button, a, [role="button"]')];
    const el = els.find(e => (e.innerText || '').trim().toLowerCase().includes(${JSON.stringify(needle)}));
    if (el) { el.click(); return (el.innerText || '').trim(); } return null;
  })()`, 10_000);

  await page.cmd('Page.navigate', { url: meetingUrl });
  // 1) Continue on this browser / Join on the web.
  let continued = false;
  for (let i = 0; i < 24 && !continued; i++) {
    if (await click('continue on this browser') || await click('join on the web')) { continued = true; break; }
    await sleep(1500);
  }
  await sleep(6000);
  // 2) Type the guest display name.
  await page.evalJs(`(() => {
    const inp = document.querySelector('input[placeholder*="name" i], input[type="text"]');
    if (!inp) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(inp, ${JSON.stringify(name)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`, 8_000);
  await sleep(1200);
  // 3) Mic ON (real mic guest wants to be unmuted so the device-hold / mic-idle path is testable).
  await page.evalJs(`(() => {
    const t = document.querySelector('[data-tid*="toggle-mute"], [aria-label*="microphone" i][role="switch"], [title*="Unmute" i], [aria-label*="Unmute" i]');
    if (t && (t.getAttribute('aria-checked') === 'false' || /unmute/i.test((t.getAttribute('title')||t.getAttribute('aria-label')||'')))) { t.click(); return 'clicked-unmute'; }
    return t ? 'already-on-or-unknown' : 'no-toggle';
  })()`, 8_000);
  // 4) Join now (lands in the lobby awaiting the native host's admit).
  let asked = false;
  for (let i = 0; i < 16 && !asked; i++) {
    if (await click('join now') || await click('join meeting')) { asked = true; break; }
    await sleep(1500);
  }
  return { continued, asked };
}

// Is the attached page in-call? Mirrors the sweep's classify() in-call heuristic
// (Leave / call controls present AND not a waiting/lobby banner).
async function pgInCall(page) {
  try {
    const snap = await page.evalJs(`(() => {
      const btns = [...document.querySelectorAll('button, a, [role="button"]')].map(e => (e.innerText||'').trim()).filter(Boolean).slice(0,40);
      const body = (document.body ? document.body.innerText : '').slice(0,3000);
      return JSON.stringify({ btns, body });
    })()`, 8_000);
    let s = {}; try { s = JSON.parse(snap); } catch { s = {}; }
    const hay = ((s.body||'') + ' ' + (s.btns||[]).join(' ')).toLowerCase();
    const inCall = /\bleave\b|hang up|call controls|meeting controls|raise( your)? hand|\bpeople\b|more actions/.test(hay)
      && !/waiting for|someone will let you in|let you in/.test(hay);
    return inCall;
  } catch (e) { return false; }
}

// Drive the guest through the pre-join flow, then wait (with the operator admit prompt)
// for in-call. Returns { page, inCall, url } — url is the live in-call URL (for logging).
async function joinTeamsMeeting(port, meetingUrl, stdin, label) {
  const page = await attachToPage(port, /about:blank|^$|teams\./);
  await teamsGuestAsk(page, meetingUrl, GUEST_NAME);
  await sleep(4000);
  const inCall = await promptAdmitAndWaitInCall(page, stdin, label);
  let url = '';
  try { url = (await page.evalJs('location.href', 6_000)) || ''; } catch (e) {}
  return { page, inCall, url: url.split('?')[0] };
}

// ===========================================================================
// Tab / leave drivers over CDP (mirror the Meet driver — a PUT-created + activated
// blank tab genuinely backgrounds the meeting tab so the renderer throttles).
// ===========================================================================
async function tabAway(port) {
  driverLog('tabAway', { port });
  await httpJsonPut(port, '/json/new?about:blank');
}
async function tabBack(port) {
  driverLog('tabBack', { port });
  const pg = await attachToPage(port, /teams\.(live|microsoft)\.com/);
  await pg.cmd('Page.bringToFront');
  return pg;
}
// Click Leave in the Teams web UI (sweep's leave selector). Must be foreground.
async function clickLeave(pg) {
  driverLog('clickLeave');
  try { await pg.cmd('Page.bringToFront'); } catch (e) {}
  return pg.evalJs(`(() => {
    const els = [...document.querySelectorAll('button,[role="button"],[data-tid]')];
    const el = els.find(e => /^leave$|leave meeting|hang up/i.test(((e.getAttribute('aria-label')||'') + ' ' + (e.innerText||'')).trim()));
    if (!el) return 'no-leave';
    el.click();
    return (el.getAttribute('aria-label')||el.innerText||'').trim().slice(0,40);
  })()`, 8_000);
}

// Toggle the People (roster/Attendees) panel in the Teams web UI — the exact control
// the sweep exercises and the G2e detector's `AXOutline desc="Attendees"` outline gates
// on. Consumer teams.live.com/v2 labels it aria-label/title/innerText "People" (matches
// the fixture `AXButton desc="People"`), often with a data-tid/id "roster-button".
// Clicking it OPENS the panel (which is when the SPA PREFIXES `People | ` onto the
// AXWebArea title — the mid-call meeting-split hazard this phase-1b step guards). A
// second click CLOSES it. Must be foreground (the click has to register).
async function togglePeoplePanel(pg) {
  driverLog('togglePeoplePanel');
  try { await pg.cmd('Page.bringToFront'); } catch (e) {}
  return pg.evalJs(`(() => {
    const els = [...document.querySelectorAll('button,[role="button"],[data-tid],[id]')];
    const labelOf = (e) => ((e.getAttribute('aria-label')||'') + ' ' + (e.getAttribute('title')||'') + ' ' + (e.innerText||'')).trim();
    // 1) Text/label match ("People", "Show participants", "Participants").
    let el = els.find(e => /^people$|show participants|^participants$|hide participants/i.test(labelOf(e)));
    // 2) id/data-tid roster fallback (the sweep's control identifier).
    if (!el) el = els.find(e => /roster-button|people-button|^roster$|participants/i.test(((e.id||'') + ' ' + (e.getAttribute('data-tid')||'')).trim()));
    if (!el) return 'no-people-control';
    el.click();
    return (labelOf(el) || el.id || el.getAttribute('data-tid') || '').trim().slice(0,40) || 'clicked-roster';
  })()`, 8_000);
}

// ===========================================================================
// Assertion helpers over the captured detector streams.
//
// THE WIRE KEY is LEARNED from the first WEB-shaped Microsoft-Teams meet-active. Its
// shape depends on the meeting URL (stableMeetingKey, shared/MeetingKey.swift):
//   • WORK meetup-join (teams.microsoft.com .../meetup-join/... — this gate's scope):
//     the URL carries the `19:meeting_…@thread.v2` conversation id (or a meetup-join id),
//     so the wire key is ALREADY `teams:19:meeting_…@thread.v2` (id-bearing, `teams:`-
//     prefixed). stderrKeyFor must NOT re-add the prefix (below).
//   • consumer teams.live.com/v2: no extractable id → stableMeetingKey falls through to
//     normalizedBrowserURL → the wire key is the bare normalized URL (no `teams:`).
// Either way the STDERR keep-alive key is `teams:` + (wireKey with any `teams:` stripped)
// — i.e. it equals the wireKey verbatim when the wireKey already carries the prefix.
//
// NATIVE CO-RESIDENT KEY (Zoom run-1 lesson / trap #7): the native Teams app
// (com.microsoft.teams2) is co-resident on this box and emits on the SAME unified wire
// as a NATIVE detection with key `Microsoft Teams|com.microsoft.teams2` (kind="native").
// The consumer run latched THAT key. This gate is the WEB bridge — filter to WEB-shaped
// keys ONLY: kind==="browser" (the meet-active wire event carries `kind`) AND never the
// native `<platform>|<bundle>` key.
// ===========================================================================
const isTeams = (e) => e && e.platform === 'Microsoft Teams';
const NATIVE_TEAMS_KEY = 'Microsoft Teams|com.microsoft.teams2';
// A WEB-shaped Teams meeting key: emitted by a browser detection (kind==="browser"),
// never the native `<platform>|<bundle>` key. For work-Teams it is `teams:19:meeting_…`;
// for consumer teams.live.com it is the normalized URL. The pipe-bearing native key and
// the `teams:`-prefix / URL shape are mutually exclusive, so the kind guard is the
// primary filter and the explicit native-key reject is belt-and-suspenders.
const isWebTeamsKey = (e) => e.kind === 'browser' && e.key !== NATIVE_TEAMS_KEY;
// The first WEB Teams meet-active's key IS the wire key the monitor diffs on — NEVER the
// co-resident native key.
const teamsActive = (det, sinceTs) =>
  det.events.filter((e) => e.event === 'meet-active' && isTeams(e) && isWebTeamsKey(e) && (sinceTs == null || e.ts >= sinceTs));
const eventsForKey = (det, wireKey, sinceTs) =>
  det.events.filter((e) => e.key === wireKey && (sinceTs == null || e.ts >= sinceTs));
const stderrSince = (det, sinceTs) => det.stderrLines.filter((l) => sinceTs == null || l.ts >= sinceTs);
const idleSince = (det, wireKey, sinceTs) =>
  eventsForKey(det, wireKey, sinceTs).some((e) => e.event === 'meet-idle');
const activeSince = (det, wireKey, sinceTs) =>
  eventsForKey(det, wireKey, sinceTs).filter((e) => e.event === 'meet-active');
const speakingSince = (det, wireKey, sinceTs) =>
  eventsForKey(det, wireKey, sinceTs).filter((e) => e.event === 'speaking');

// The REAL engage/release line key. The keep-alive adapter (TeamsTabAway.swift:119-130)
// derives its memory key = stableMeetingKey with any leading `teams:` STRIPPED, and
// keyPrefix ("teams:") re-adds it for the logged line. So the logged key ==
// `teams:` + (wireKey minus a leading `teams:`). For a WORK meetup-join wire key
// (`teams:19:meeting_…`) that yields the wireKey VERBATIM — re-adding blindly would
// double-prefix (`teams:teams:…`) and NEVER match. For a consumer bare-URL wire key
// (no prefix) it prepends `teams:` as before. This prefix-aware form is correct for BOTH.
const stderrKeyFor = (wireKey) => (wireKey.startsWith('teams:') ? wireKey : `teams:${wireKey}`);
const engagedLine = (det, wireKey, sinceTs) => stderrSince(det, sinceTs).find((l) =>
  l.line.includes(`teams-keepalive: engaged key=${stderrKeyFor(wireKey)}`) && l.line.includes('reason=tab_present'));
// The REAL release line (TabAwayBridge.swift:81-82) for a specific reason literal.
const releasedLine = (det, wireKey, sinceTs, reason) => stderrSince(det, sinceTs).find((l) =>
  l.line.includes(`teams-keepalive: released key=${stderrKeyFor(wireKey)}`) && l.line.includes(`reason=${reason}`));

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
// Wait up to timeoutMs for a predicate (sync OR async) to become true. Returns ms
// elapsed when it fired, or null on timeout. Every wait in this driver goes through here
// (a bounded blocking poll — no background monitors).
async function waitFor(pred, timeoutMs, stepMs = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return Date.now() - t0;
    await sleep(stepMs);
  }
  return null;
}
// PHASE-BOUNDARY DRAIN (rig artifact, extracted from the Meet driver): a tabBack /
// reactivation at the END of phase N logs its `released reason=readable` on the
// detector's NEXT probe cycle, which can land AFTER phase N+1 stamps its since-timestamp
// (the Meet driver observed +1506ms) — phase N+1's stray-release check then miscounts the
// leaked line and false-FAILs. Call AFTER the tabBack that ends phase N and BEFORE stamping
// phase N+1's since-timestamp: if the bridge was engaged in phase N (so a readable release
// is plausibly pending), wait up to ~10s for that release to land, then settle ~3s of quiet.
async function drainBoundary(det, wireKey, sinceTs, wasEngaged, label) {
  if (wasEngaged) {
    const anyReleaseSince = () => stderrSince(det, sinceTs).some((l) =>
      l.line.includes(`teams-keepalive: released key=${stderrKeyFor(wireKey)}`));
    const landed = await waitFor(anyReleaseSince, 10_000);
    log(`${label}: boundary drain — phase-N release ${landed != null ? `landed at +${landed}ms` : 'not seen within 10s (already drained or none pending)'}`);
  }
  await sleep(3_000);
}

// ===========================================================================
// Main scenario. Phases 1, 1b (key-stability), 2-5; every wait is a bounded blocking poll;
// boundary drains between all phases; results append-only. Roll-up PASS = all PASS
// (phase-3's no-throttle branch tolerated).
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

  const hostProfile = resolveHostProfile();
  if (hostProfile.persistent && !assertProfileNotInUse(hostProfile.dir)) {
    failAll(`persistent rig profile already in use: ${hostProfile.dir}`);
    return 1;
  }

  const PORT_A = 9351;   // primary rig Chrome (phases 1-4, mic feeder wired) — sweep's port
  const PORT_B = 9353;   // cap-only rig Chrome (phase 5, SAME persistent profile, serialized, NO feeder)

  const stdin = makeStdin();
  let det = null, detCap = null, chromeA = null, chromeB = null, pgA = null, pgB = null;
  let anyFail = false;

  try {
    // Resolve the (native-hosted) meeting URL for phases 1-4 up front.
    const meetingUrl = await resolveMeetingUrl(stdin, 'MSD_TEAMS_MEETING_URL', 'phases 1-4');

    // === Detector with mic feeder wired (phases 1-4) ===
    det = startDetector(true);
    log(`detector spawned (MSD_TEAMS_TABSTRIP=1 MSD_EDGE_LOG=1, mic feeder from ${MIC_BIN})`);

    // === Rig Chrome: persistent profile IN PLACE (or the loud fallback). ===
    chromeA = hostProfile.persistent ? launchPersistentChrome(PORT_A, hostProfile.dir) : launchTempChrome(PORT_A, hostProfile.dir);
    log(`rig Chrome on :${PORT_A} (${hostProfile.persistent ? 'persistent in-place' : 'temp copyAuth'} profile ${hostProfile.dir}) — joining the native-hosted teams.live.com meeting as an anonymous guest (real mic)…`);
    const joined = await joinTeamsMeeting(PORT_A, meetingUrl, stdin, 'phase 1 — admit the guest');
    pgA = joined.page;
    log(`join result: inCall=${joined.inCall} url=${joined.url}`);

    // -----------------------------------------------------------------------
    // PHASE 1 — DETECT: the detector must emit a Microsoft-Teams meet-active (the teams
    // wire equivalent — teamsWebProbe surfaces as meet-active with platform="Microsoft
    // Teams") for the meeting. LEARN the wire key from that event (the normalized
    // teams.live.com URL for a consumer meeting) so every later phase keys correctly.
    // -----------------------------------------------------------------------
    const p1ActiveMs = await waitFor(() => teamsActive(det, 0).length > 0, JOIN_TIMEOUT_MS);
    const wireKey = p1ActiveMs != null ? teamsActive(det, 0).slice(-1)[0].key : null;
    const micActive = await waitFor(
      () => det.micSink.fed.some((f) => f.hint.startsWith('mic active=1')), MIC_ACTIVE_TIMEOUT_MS);
    if (p1ActiveMs == null || !wireKey) {
      anyFail = true;
      record('detect', 'FAIL', {
        reason: 'no Microsoft-Teams meet-active emitted (guest never admitted/in-call, or the teamsWebProbe did not surface the meeting)',
        inCall: joined.inCall, teamsActiveEvents: teamsActive(det, 0).length,
      });
    } else {
      const act = teamsActive(det, 0).slice(-1)[0];
      // Detect PASS = a Teams meet-active for a learned key (self-name is best-effort on
      // the anonymous consumer flow — the sweep noted the display name falls back, so we
      // do NOT gate on selfNamed the way the Meet driver does).
      const verdict = 'PASS';
      record('detect', verdict, {
        wireKey, stderrKey: stderrKeyFor(wireKey), platform: act.platform,
        meetActiveMs: p1ActiveMs, self: act.self, inCall: joined.inCall,
        micActiveHintSeen: micActive != null, title: act.title, kind: act.kind,
        note: 'teamsWebProbe surfaces on the UNIFIED wire as a BROWSER meet-active platform="Microsoft Teams" (never the co-resident native key); for a WORK meetup-join URL the wire key is teams:<19:meeting_…@thread.v2>, and the stderr keep-alive key equals it verbatim (prefix-aware)',
      });
    }

    // Guard: without a learned wire key the remaining phases cannot assert. Fail them fast.
    if (!wireKey) {
      for (const ph of ['key-stability', 'bg-throttle-cycle', 'longer-hold', 'leave-ends', 'cap-only']) {
        record(ph, 'FAIL', { reason: 'phase 1 did not learn a Teams wire key (no meet-active) — dependent phase cannot run' });
      }
      anyFail = true;
      return 1;
    }

    // -----------------------------------------------------------------------
    // PHASE 1b — KEY-STABILITY (the G2f meeting-split guard): the People panel toggle
    // must NOT split the meeting key. On consumer teams.live.com/v2 the SPA PREFIXES
    // `People | ` onto the AXWebArea title when the panel opens; a title-derived key that
    // kept that prefix would flip mid-call (`teams:live:meeting with…` →
    // `teams:live:people | meeting with…`), starting a NEW downstream session and
    // orphaning the first. The G2f fix keys on the LAST title segment (panel-prefix-
    // proof), so the key is INVARIANT across the toggle. This phase asserts that live:
    // open the People panel → wait ~5s → the wire key did NOT change (no meet-active on a
    // DIFFERENT web-Teams key, no meet-idle for the original); close → same assertion.
    // FOREGROUND (no throttle) — this is a KEY-identity test, not a tab-away test, so any
    // new key here is a pure identity split, not a bridge artifact.
    // -----------------------------------------------------------------------
    const KEY_STABILITY_SETTLE_MS = 5_000;
    // A key-split shows as a web-Teams meet-active whose key differs from the learned one.
    const splitActivesSince = (sinceTs) =>
      teamsActive(det, sinceTs).filter((e) => e.key !== wireKey);
    let ksOk = true;
    const ksDetail = { wireKey, phases: {} };
    try {
      await tabBack(PORT_A); // ensure foreground so the panel click registers
      // (i) OPEN the People panel.
      const openStart = Date.now();
      const openRes = await togglePeoplePanel(pgA);
      log(`phase1b (key-stability): People panel OPENED (${openRes}) — settling ${KEY_STABILITY_SETTLE_MS / 1000}s, asserting the wire key does NOT split`);
      await sleep(KEY_STABILITY_SETTLE_MS);
      const openSplit = splitActivesSince(openStart).map((e) => e.key);
      const openIdle = idleSince(det, wireKey, openStart);
      ksDetail.phases.open = { control: openRes, splitKeys: [...new Set(openSplit)], idleForOriginal: openIdle };
      if (openSplit.length > 0 || openIdle) ksOk = false;

      // (ii) CLOSE the People panel.
      const closeStart = Date.now();
      const closeRes = await togglePeoplePanel(pgA);
      log(`phase1b: People panel CLOSED (${closeRes}) — settling ${KEY_STABILITY_SETTLE_MS / 1000}s, asserting the wire key STILL does NOT split`);
      await sleep(KEY_STABILITY_SETTLE_MS);
      const closeSplit = splitActivesSince(closeStart).map((e) => e.key);
      const closeIdle = idleSince(det, wireKey, closeStart);
      ksDetail.phases.close = { control: closeRes, splitKeys: [...new Set(closeSplit)], idleForOriginal: closeIdle };
      if (closeSplit.length > 0 || closeIdle) ksOk = false;

      // If the control was never found, this phase cannot assert its property — FAIL loud
      // (a silent skip would hide a real split behind a missing selector).
      if (openRes === 'no-people-control' && closeRes === 'no-people-control') {
        ksOk = false;
        ksDetail.reason = 'People/roster control not found in the Teams-web UI — cannot exercise the panel toggle (selector drift?)';
      } else if (!ksOk) {
        ksDetail.reason = `People-panel toggle SPLIT the meeting key (open split=${JSON.stringify(ksDetail.phases.open.splitKeys)} idle=${ksDetail.phases.open.idleForOriginal}; close split=${JSON.stringify(ksDetail.phases.close.splitKeys)} idle=${ksDetail.phases.close.idleForOriginal}) — the title-derived key is NOT panel-prefix-proof`;
      }
    } catch (e) {
      ksOk = false;
      ksDetail.reason = `phase1b threw: ${e && e.message ? e.message : e}`;
    }
    record('key-stability', ksOk ? 'PASS' : 'FAIL', ksDetail);
    if (!ksOk) anyFail = true;
    // Settle the detector after the two toggles so phase 2's since-stamp starts quiet.
    await sleep(2_000);

    // -----------------------------------------------------------------------
    // PHASE 2 — BG-THROTTLE-CYCLE (CANONICAL): genuinely background the Teams-web tab,
    // hold, then activate it — the full engage→hold→recover cycle the bridge ships for.
    //   (a) BACKGROUND (PUT-created + activated blank tab) → the renderer throttles → the
    //       teams.live.com/v2 AXWebArea goes BLIND → assert `teams-keepalive: engaged …
    //       reason=tab_present` within ~15s (stamp the latency).
    //   (b) HOLD 30s: NO meet-idle (the bridge holds the key open across the throttle),
    //       speakers [] released iff someone spoke pre-hold (solo guard).
    //   (c) ACTIVATE (still in-call) → the live tree returns → `released … reason=readable`
    //       + ≤1 fresh meet-active (no-churn by design) + NO meet-idle.
    // -----------------------------------------------------------------------
    const p2Start = Date.now();
    await tabAway(PORT_A);
    log('phase2 (bg-throttle-cycle): Teams tab genuinely backgrounded — expecting engaged reason=tab_present within ~15s');
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
    // TeamsTabAway.rebuildDetection carries every == field verbatim), so proof = the
    // readable release edge + NO meet-idle + 0..1 meet-active (>1 = churn FAIL).
    const p2RecoverStart = Date.now();
    await tabBack(PORT_A);
    log('phase2: Teams tab activated (still in-call) — expecting released reason=readable + NO meet-idle (no-churn by design)');
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
    // PHASE 3 — LONGER-HOLD: sustained 2-minute background-throttle hold. Whether the
    // bridge engages depends on Chrome's background-throttle heuristic actually firing
    // (measured non-deterministic on the Meet driver). So: THROTTLED → require engage +
    // readable recovery; NOT THROTTLED → the tab stayed readable, nothing to bridge →
    // require zero idle + zero stray keep-alive lines (the no-throttle tolerance branch,
    // Meet v3.1). A meet-idle during the hold is ALWAYS a FAIL (the load-bearing invariant).
    // -----------------------------------------------------------------------
    await drainBoundary(det, wireKey, p2RecoverStart, p2EngagedMs != null, 'phase2→3');
    const p3Start = Date.now();
    await tabAway(PORT_A);
    log('phase3 (longer-hold): Teams tab backgrounded — SUSTAINED 2-minute throttle hold (expect engage, ZERO meet-idle)');
    const p3EngagedMs = await waitFor(() => !!engagedLine(det, wireKey, p3Start), BG_ENGAGE_TIMEOUT_MS);
    await holdAndPoll(det, wireKey, LONG_HOLD_MS, 'phase3');
    const p3Idle = idleSince(det, wireKey, p3Start);
    const p3Engaged = engagedLine(det, wireKey, p3Start);
    const p3RecoverStart = Date.now();
    await tabBack(PORT_A);
    log('phase3: Teams tab activated (still in-call) — expecting released reason=readable (if throttled)');
    const p3ReadableMs = await waitFor(() => !!releasedLine(det, wireKey, p3RecoverStart, 'readable'), IDLE_HYSTERESIS_MS + 8_000);
    {
      const throttled = !!p3Engaged;
      const noIdleOk = !p3Idle;
      const recoverOk = p3ReadableMs != null;
      const strayRelease = stderrSince(det, p3Start).find((l) =>
        l.line.includes(`teams-keepalive: released key=${stderrKeyFor(wireKey)}`));
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
    // PHASE 4 — LEAVE-ENDS (load-bearing regression): tab FOREGROUND, click Leave via the
    // Teams web UI. For Teams the post-leave tab LABEL is UNCHANGED (sweep T6/T7), so the
    // readable-not-in-call clear (reason=left) is THE load-bearing end path — the label
    // alone can't tell left from in-call; only the readable-not-in-call web-area read
    // clears the bridge. ASSERT meet-idle < hysteresis AND released reason=left, and NO
    // re-engage in the following 30s.
    // -----------------------------------------------------------------------
    await drainBoundary(det, wireKey, p3RecoverStart, !!p3Engaged, 'phase3→4');
    await tabBack(PORT_A);      // Teams tab foreground so the Leave click registers
    await sleep(1500);
    const p4Start = Date.now();
    const leaveRes = await clickLeave(pgA);
    log(`phase4 (leave-ends): Leave clicked (${leaveRes}) — expecting released reason=left + meet-idle < ${IDLE_HYSTERESIS_MS / 1000}s and no re-engage`);
    const p4LeftMs = await waitFor(() => !!releasedLine(det, wireKey, p4Start, 'left'), IDLE_HYSTERESIS_MS + 8_000);
    const p4LeftL = releasedLine(det, wireKey, p4Start, 'left');
    const p4IdleMs = await waitFor(() => idleSince(det, wireKey, p4Start), IDLE_HYSTERESIS_MS + 5_000);
    // Watch a further 30s for an ILLEGAL re-engage (the regression: the tab label is
    // UNCHANGED post-leave, so a label-only keep-alive would re-engage).
    const reEngageWatchStart = Date.now();
    await sleep(SHORT_HOLD_MS);
    const p4ReEngaged = !!engagedLine(det, wireKey, reEngageWatchStart);
    {
      const idleInHysteresis = p4IdleMs != null && p4IdleMs <= IDLE_HYSTERESIS_MS;
      // The load-bearing assertion: released reason=left is REQUIRED (the readable-not-in-
      // call clear is THE Teams end path). meet-idle within hysteresis is also required.
      const ok = p4LeftMs != null && idleInHysteresis && !p4ReEngaged;
      if (!ok) anyFail = true;
      record('leave-ends', ok ? 'PASS' : 'FAIL', {
        wireKey, meetIdleMs: p4IdleMs, idleInHysteresis,
        releasedLeftMs: p4LeftMs, releasedLine: p4LeftL ? p4LeftL.line : null,
        reEngagedAfterLeave: p4ReEngaged,
        note: 'Teams post-leave tab label is UNCHANGED, so released reason=left (readable-not-in-call clear) is THE load-bearing end path',
        reason: ok ? undefined
          : (p4LeftMs == null ? 'no released reason=left after Leave (the readable-not-in-call clear did NOT fire — THE load-bearing Teams end path failed)'
            : !idleInHysteresis ? `no meet-idle < ${IDLE_HYSTERESIS_MS}ms after Leave`
              : 'detector RE-ENGAGED the bridge after Leave (label unchanged post-leave — the readable-not-in-call clear failed to close it) — THE regression'),
      });
    }

    // Tear down rig Chrome A + its detector before phase 5. Phase 5 relaunches the SAME
    // persistent profile — Chrome A MUST be fully clean-quit first (serialized: never two
    // Chromes on one profile). Stop the detector, clean-quit A, then WAIT for the profile
    // lock to clear before relaunching.
    try { await det.stop(); } catch (e) {}
    det = null;
    try { await chromeA.kill(); } catch (e) {}
    chromeA = null;
    pgA = null;

    // -----------------------------------------------------------------------
    // PHASE 5 — CAP-ONLY (background-throttle, NO mic feeder, SERIALIZED on the SAME
    // persistent profile): a FRESH native-hosted meeting, join WITHOUT the mic feeder (no
    // stdin hints EVER → the advisory mic hint stays .unknown). Background-throttle: the
    // bridge must STILL engage on an .unknown mic (advisory law: .unknown never ends a
    // bridge), the engage line reporting mic=unknown; hold 30s with NO meet-idle; then
    // ACTIVATE (still in-call) → released reason=readable; then LEAVE → meet-idle.
    // -----------------------------------------------------------------------
    const capUrl = await resolveMeetingUrl(stdin, 'MSD_TEAMS_MEETING_URL_CAPONLY', 'phase 5 (cap-only) — FRESH meeting');
    detCap = startDetector(false); // NO mic feeder — stdin open but never written
    log('phase5 (cap-only): detector spawned WITHOUT mic feeder (advisory mic hint stays .unknown)');
    if (hostProfile.persistent) {
      const t0 = Date.now();
      while (Date.now() - t0 < 15_000 && !assertProfileNotInUse(hostProfile.dir)) { await sleep(1000); }
    }
    chromeB = hostProfile.persistent
      ? launchPersistentChrome(PORT_B, hostProfile.dir)
      : (() => { const t = mkdtempSync(join(tmpdir(), 'teams-tabaway-b-')); copyAuth(t); return launchTempChrome(PORT_B, t); })();
    log(`phase5 Chrome on :${PORT_B} (${hostProfile.persistent ? 'SAME persistent in-place profile, serialized' : 'temp copyAuth fallback'}) — joining a FRESH native-hosted teams.live.com meeting (real mic, feeder OFF)…`);
    const joinedB = await joinTeamsMeeting(PORT_B, capUrl, stdin, 'phase 5 — admit the guest');
    pgB = joinedB.page;
    log(`phase5 join result: inCall=${joinedB.inCall} url=${joinedB.url}`);
    // Learn the fresh meeting's wire key from its own meet-active (a fresh meeting may key
    // differently — always relearn).
    const p5ActiveMs = await waitFor(() => teamsActive(detCap, 0).length > 0, JOIN_TIMEOUT_MS);
    const wireKeyB = p5ActiveMs != null ? teamsActive(detCap, 0).slice(-1)[0].key : null;

    await tabAway(PORT_B);
    const p5Start = Date.now();
    log('phase5: Teams tab genuinely backgrounded — expecting engage mic=unknown, holding 30s (cap-only, no mic hint)');
    const p5EngagedMs = wireKeyB ? await waitFor(() => !!engagedLine(detCap, wireKeyB, p5Start), BG_ENGAGE_TIMEOUT_MS) : null;
    if (wireKeyB) await holdAndPoll(detCap, wireKeyB, SHORT_HOLD_MS, 'phase5-hold');
    const p5Idle = wireKeyB ? idleSince(detCap, wireKeyB, p5Start) : false;
    const p5Engaged = wireKeyB ? engagedLine(detCap, wireKeyB, p5Start) : null;
    const p5EngagedUnknown = !!(p5Engaged && p5Engaged.line.includes('mic=unknown'));

    const p5RecoverStart = Date.now();
    let p5ReadableMs = null, p5IdleAfterRecover = false, p5RecoverActiveCount = 0;
    if (wireKeyB) {
      await tabBack(PORT_B);
      log('phase5: Teams tab activated (still in-call) — expecting released reason=readable + NO meet-idle, then Leave → meet-idle');
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
          : (!detectOk ? 'phase5 join/detect failed (guest never admitted/in-call or no Teams meet-active)'
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
    console.error('[teams-tabaway] FATAL during scenario:', e && e.stack ? e.stack : e);
    anyFail = true;
    record('fatal', 'FAIL', { reason: String(e && e.message ? e.message : e) });
  } finally {
    // Teardown: leave calls, clean-quit rig Chromes (SERIAL on one persistent profile),
    // SIGTERM the detectors so walk-stats flush. pgA is nulled after A's clean-quit so we
    // never Leave-click a dead tab here.
    try { if (pgA) await clickLeave(pgA); } catch (e) {}
    try { if (pgB) await clickLeave(pgB); } catch (e) {}
    try { if (det) await det.stop(); } catch (e) {}
    try { if (detCap) await detCap.stop(); } catch (e) {}
    try { if (chromeA) await chromeA.kill(); } catch (e) {}
    try { if (chromeB) await chromeB.kill(); } catch (e) {}
    // End any native meeting we hosted (autonomous mode) so no live meeting lingers to
    // wedge the next gate. No-op when the operator hosted.
    try { await endHostedMeetings(); } catch (e) {}
    try { stdin.close(); } catch (e) {}
    driverLog('teardown-complete', { anyFail, hostedMeetings: hostedMeetings.length });
    closeLogStreams();
  }
  return anyFail ? 1 : 0;
}

async function main() {
  if (!process.argv.includes('--tabaway')) {
    console.error('[teams-tabaway] usage: node research/teams-web/teams-tabaway-live.mjs --tabaway');
    console.error('[teams-tabaway]   The NATIVE Teams app hosts a teams.live.com meeting; the rig Chrome joins as an');
    console.error('[teams-tabaway]   anonymous web guest and is admitted from the native lobby by the operator.');
    console.error('[teams-tabaway]   Set MSD_TEAMS_MEETING_URL (+ MSD_TEAMS_MEETING_URL_CAPONLY for the fresh phase-5');
    console.error('[teams-tabaway]   meeting) to skip the interactive URL prompts. MSD_DETECTOR_BIN / MSD_MIC_BIN');
    console.error('[teams-tabaway]   override the product binary paths; MSD_CHROME_PROFILE points the rig Chrome at');
    console.error('[teams-tabaway]   a persistent signed-in profile.');
    process.exit(2);
  }
  const code = await runTabAway();
  const summary = recordSummary();
  console.log('TEAMS TABAWAY LIVE SESSION COMPLETE');
  process.exit(summary === 'PASS' && code === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[teams-tabaway] FATAL', e && e.stack ? e.stack : e);
  console.log('TEAMS TABAWAY LIVE SESSION COMPLETE');
  process.exit(1);
});
