#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Shared-session LIVE QA runner for Microsoft Teams NATIVE (com.microsoft.teams2)
// structural participant/speaker detection — tier B of the two-tier harness
// (tier A is the deterministic fixture replay in SpeakerCoreSelfTest).
//
// ONE live session, scenarios back-to-back. Teams can't be puppeteered like the
// Meet Chrome+CDP rig, so native UI is driven through `swift run TeamsDrive`
// (AXPress on named controls) and the second participant joins via WEB Teams in
// a CDP-driven Chrome with a fake mic (tone) — the same guest pattern the Meet
// rig uses. Scenarios (one NDJSON verdict line each → teams-live-results.ndjson):
//
//   teams-detect-live   — host joins a call (TeamsDrive: Meet tab → Join → Join
//                         now); the detector emits meeting_initialized with a
//                         teams:: meeting id and a LOCAL participant.
//   teams-selfmute-live — TeamsDrive toggles "Mute mic"/"Unmute mic"; the local
//                         participant's is_muted must flip both ways (validates
//                         the structural self tile + toolbar mute fusion).
//   teams-layouts-live  — View → Gallery / Speaker / Together mode, plus window
//                         resizes (large/small): the roster must stay EXACTLY
//                         the expected set in every driven cell (zero false
//                         positives, zero misses). Undrivable cells are recorded
//                         and downgrade the verdict to REVIEW, never silent.
//   teams-guest-live    — a web-Teams guest (Chrome, fake mic) joins; the roster
//                         must grow by EXACTLY the guest; with the guest unmuted
//                         and emitting audio, speech_on must NAME the guest
//                         (teams.mute_gate / teams.pip) — never "Someone", never
//                         the local user. Needs TEAMS_MEETING_URL (or a link
//                         harvested from the Meet tab's Share link → Copy).
//
//   teams-ring-probe    — (--probe) FALSIFICATION run: a guest joins with the
//                         getUserMedia SPEECH override so mute-state and speech-
//                         content decouple, then holds an open mic SILENT while the
//                         detector's RAW per-tile ring is sampled (MSD_RING_TRACE).
//                         Answers the one state the tone rig can't make: does the
//                         ring light for unmuted-but-silent? Also times linger-L.
//
// Detector contract (same as the Meet live gate): MSD_AUTOSTART=1,
// MSD_RUN_SECONDS=N; every engine event mirrors to stdout as `[event] {json}`
// (and, under --probe, raw ring dumps as `[ringtrace] {json}`).
//
//   node qa/teams-live/run-teams-live-qa.mjs --all      # the 4-scenario sweep
//   node qa/teams-live/run-teams-live-qa.mjs --probe     # the ring falsification probe (#1)
//   node qa/teams-live/run-teams-live-qa.mjs --throttle  # WebView2 throttle/PIP measurement (#3)
//
// Env: TEAMS_EXPECT_SELF (default: git user.name), TEAMS_MEETING_URL,
//      TEAMS_GUEST_NAME (default "QA Guest"), TEAMS_SKIP_GUEST=1.
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const MACOS = join(REPO, 'macos');
// MSD_DETECTOR_BIN overrides the sandbox SwiftPM debug binary so an EXTERNAL
// (product) detector can be gated by this live rig. When set, the swift-build
// prebuild is skipped and the binary must already exist — fail fast here,
// BEFORE any meeting/rig infrastructure is launched.
const DETECTOR_BIN = process.env.MSD_DETECTOR_BIN || join(MACOS, '.build', 'debug', 'MeetSpeakerDetector');
const TEAMSDRIVE_BIN = join(MACOS, '.build', 'debug', 'TeamsDrive');
if (process.env.MSD_DETECTOR_BIN && !existsSync(DETECTOR_BIN)) {
  console.error(`[teams-live] FATAL: MSD_DETECTOR_BIN is set but no detector binary exists at ${DETECTOR_BIN}`);
  process.exit(1);
}
const RESULTS_NDJSON = join(HERE, 'teams-live-results.ndjson');
const GUEST_PORT = 9331;

const EXPECT_SELF = process.env.TEAMS_EXPECT_SELF
  || spawnSync('git', ['config', 'user.name'], { encoding: 'utf8' }).stdout.trim()
  || 'Bibek Thapa';
const GUEST_NAME = process.env.TEAMS_GUEST_NAME || 'QA Guest';

const log = (...a) => console.log('[teams-live]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

function record(scenario, verdict, detail) {
  appendFileSync(RESULTS_NDJSON, JSON.stringify({ scenario, verdict, ts: nowSec(), ...detail }) + '\n');
  log(`RESULT ${scenario}: ${verdict}`);
}

// --- TeamsDrive wrapper: press/find/resize on the native Teams AX tree. ---------
function drive(...args) {
  const r = spawnSync(TEAMSDRIVE_BIN, args, { encoding: 'utf8', timeout: 120_000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  return { ok: r.status === 0, out };
}
// Press the FIRST of several candidate labels that exists (labels differ across
// Teams builds/locales); returns the label that worked or null.
async function pressFirst(candidates, settleMs = 1200) {
  for (const c of candidates) {
    const r = drive('press', c);
    if (r.ok) { log(`pressed "${c}"`); await sleep(settleMs); return c; }
  }
  return null;
}

// --- Pre-flights (mirror the Meet runner) ----------------------------------------
function preflightAxTrust() {
  const r = drive('windows');
  if (r.out.includes('NOT_TRUSTED')) return false;
  return true; // NOT_RUNNING is fine here — we launch Teams next
}
function prebuild() {
  if (process.env.MSD_DETECTOR_BIN) {
    log(`using external detector: ${DETECTOR_BIN} (prebuild skipped)`);
    if (!existsSync(TEAMSDRIVE_BIN)) {
      console.error(`[teams-live] external-detector mode still needs TeamsDrive at ${TEAMSDRIVE_BIN} — run \`swift build --package-path macos\` once`);
      return false;
    }
    return true;
  }
  log('swift build --package-path macos …');
  const r = spawnSync('swift', ['build', '--package-path', MACOS], { encoding: 'utf8', timeout: 20 * 60_000 });
  if (r.status !== 0) {
    console.error('[teams-live] swift build FAILED:\n' + ((r.stdout || '') + (r.stderr || '')).split('\n').slice(-25).join('\n'));
    return false;
  }
  return existsSync(DETECTOR_BIN) && existsSync(TEAMSDRIVE_BIN);
}

// --- Streaming detector: parse `[event] {json}` (and, for the probe, `[ringtrace]`)
// stdout lines as they arrive. `extraEnv` lets the probe turn on the raw ring trace
// (MSD_RING_TRACE) and a finer poll (MSD_POLL_INTERVAL_MS) for linger-L resolution. --
function startDetector(seconds, extraEnv = {}) {
  // MSD_EDGE_LOG=1 — REQUIRED for the PRODUCT binary: its typed `[event]` mirror
  // (meeting_initialized / participant_* / speech_on / teams_edge) is gated on
  // edgeDiagnostics (MonitorDiagnostics.emitEventLine guard; main.swift:149).
  // Without it the product emits ONLY the stdout wire + meet_walk_stats, and every
  // waitEvent() in this rig goes dark (root cause of the 2026-07-06 suite-1
  // false-blindness). The sandbox binary emits [event] unconditionally, so this is
  // a no-op for it. Callers can still override with a file path via extraEnv/env.
  const env = { ...process.env, MSD_AUTOSTART: '1', MSD_RUN_SECONDS: String(seconds),
                MSD_EDGE_LOG: process.env.MSD_EDGE_LOG || '1', ...extraEnv };
  const proc = spawn(DETECTOR_BIN, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = [];
  const ringTrace = [];    // raw per-tick Teams ring dumps (probe only; empty otherwise)
  const teamsTrace = [];   // [teamstrace] — SANDBOX-ONLY window-level trace; the PRODUCT
                           // binary never emits it (only [ringtrace]). Kept for back-compat.
  const wire = [];         // stdout NDJSON WIRE events ({event:"meet-active"|"meet-idle"|
                           // "speaking",…}, no [event] prefix) with a receive ts. The
                           // idle/ended signal the throttle scenario asserts lives HERE:
                           // the product's typed [event] mirror has no meeting_ended line;
                           // `meet-idle` is emitted only on the wire (main.swift emit()).
  const stderrLines = [];  // {ts, line} for stderr lines carrying a keyword the scenarios
                           // grep by substring (teams-keepalive / teams-wake / title-wake).
  const STDERR_KEYWORDS = ['teams-keepalive', 'teams-wake', 'title-wake'];
  let buf = '';
  const onData = (stream) => (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ln = buf.slice(0, i); buf = buf.slice(i + 1);
      const rxTs = Date.now();
      if (stream === 'err' && STDERR_KEYWORDS.some((k) => ln.includes(k))) {
        stderrLines.push({ ts: rxTs, line: ln });
      }
      const j = ln.indexOf('{');
      if (j < 0) continue;
      if (ln.includes('[event]')) {
        try { const o = JSON.parse(ln.slice(j)); if (o && o.type) events.push(o); } catch (e) {}
      } else if (ln.includes('[ringtrace]')) {
        try { const o = JSON.parse(ln.slice(j)); if (o) ringTrace.push(o); } catch (e) {}
      } else if (ln.includes('[teamstrace]')) {
        try { const o = JSON.parse(ln.slice(j)); if (o) teamsTrace.push(o); } catch (e) {}
      } else if (stream === 'out') {
        // Plain stdout WIRE line (no diagnostic prefix). Capture the meeting-lifecycle
        // events with a receive ts so scenarios can assert "key never idled".
        try { const o = JSON.parse(ln.slice(j)); if (o && typeof o.event === 'string') wire.push({ rxTs, ...o }); } catch (e) {}
      }
    }
  };
  proc.stdout.on('data', onData('out'));
  proc.stderr.on('data', onData('err'));
  const done = new Promise((res) => proc.on('exit', res));
  return { proc, events, ringTrace, teamsTrace, wire, stderrLines, done, kill: () => { try { proc.kill('SIGKILL'); } catch (e) {} } };
}
const isTeams = (e) => typeof e.meeting_id === 'string' && e.meeting_id.startsWith('teams::');
async function waitEvent(det, pred, timeoutMs, label) {
  const t0 = Date.now();
  let seen = 0;
  while (Date.now() - t0 < timeoutMs) {
    for (; seen < det.events.length; seen++) {
      if (pred(det.events[seen])) return det.events[seen];
    }
    await sleep(500);
  }
  log(`waitEvent timeout: ${label}`);
  return null;
}
// Replay joined/left events into the CURRENT teams roster {name -> {is_local,is_muted}}.
function teamsRoster(det) {
  const roster = new Map();
  for (const e of det.events) {
    if (!isTeamsProd(e)) continue;   // product pipe-key OR sandbox teams:: (superset)
    if (e.type === 'participant_joined') roster.set(e.name, { is_local: !!e.is_local, is_muted: e.is_muted });
    else if (e.type === 'participant_updated' && roster.has(e.name)) roster.set(e.name, { is_local: !!e.is_local, is_muted: e.is_muted });
    else if (e.type === 'participant_left') roster.delete(e.name);
  }
  return roster;
}
const rosterNames = (det) => [...teamsRoster(det).keys()].sort();

// --- Join / leave the call on native Teams ---------------------------------------
async function hostJoinCall() {
  spawnSync('open', ['-b', 'com.microsoft.teams2'], { encoding: 'utf8' });
  await sleep(12_000);
  drive('raise');
  await sleep(2_000);
  // Already in a call? (a Leave button exists) — reuse it.
  if (drive('find', 'Leave').ok) { log('already in a call'); return true; }
  // Navigate: app bar "Meet" tab → a meeting-link card's "Join" → pre-join "Join now".
  await pressFirst(['Meet']);
  await sleep(2_500);
  if (!await pressFirst(['Join'])) {
    // No scheduled/active meeting card to join — start an INSTANT meeting instead, so
    // the live scenarios don't depend on a pre-existing meeting (prior runs end theirs).
    log('no Join card on the Meet tab — starting "Meet now"');
    if (!await pressFirst(['Meet now', 'Meet Now', 'Start meeting'], 3_000)) {
      log('no Join card and no "Meet now" — cannot start a call');
      return false;
    }
  }
  await sleep(6_000);
  // Pre-join screen → join. ("Join now" is the primary button; fall back to "Join".)
  await pressFirst(['Join now', 'Join'], 2_000);
  // In-call marker: the Leave button appears.
  for (let i = 0; i < 20; i++) {
    if (drive('find', 'Leave').ok) break;
    await sleep(3_000);
  }
  if (!drive('find', 'Leave').ok) return false;
  // Open the Participants panel — the reliable roster + remote-mute source (and
  // in a solo call the ONLY participant source; the stage has no tiles then).
  if (!drive('find', 'Attendees').ok) await pressFirst(['People'], 3_000);
  return true;
}
async function hostLeaveCall() {
  await pressFirst(['Leave'], 2_000);
}

// --- Meeting-link harvest, IN-CALL (live-verified path): the People panel's
// "Share invite" → "Copy meeting link" → clipboard. (The Meet-tab "Share link"
// dialog does not materialize under AXPress, so harvest happens after joining.)
async function harvestInCall() {
  if (process.env.TEAMS_MEETING_URL) return process.env.TEAMS_MEETING_URL;
  if (!await pressFirst(['Share invite'], 2_500)) return null;
  if (!await pressFirst(['Copy meeting link', 'Copy link'], 1_500)) return null;
  const clip = spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout.trim();
  // Dismiss the share menu (Escape).
  spawnSync('osascript', ['-e', 'tell application "System Events" to key code 53']);
  await sleep(800);
  return /^https:\/\/teams\./.test(clip) ? clip : null;
}

// --- Guest speech control (probe only). The getUserMedia override exposes two
// INDEPENDENT gates so mute-state and speech-content decouple:
//   __fakeMicSpeak(on) — real decoded voice at gain 1/0 (mic stays unmuted)
//   __fakeMicTone(on)  — a pure sine (energy, no speech content) — energy-vs-content
// so the probe can hold an open mic SILENT (impossible with the fake-device tone). --
const guestMicReady = (page) => page.evalJs('!!window.__fakeMicReady');
const setGuestSpeak = (page, on) => page.evalJs(`window.__fakeMicSpeak && window.__fakeMicSpeak(${on ? 'true' : 'false'})`);
const setGuestTone = (page, on, hz = 440) => page.evalJs(`window.__fakeMicTone && window.__fakeMicTone(${on ? 'true' : 'false'}, ${hz})`);
// Best-effort mute toggle for the mute-mid-speech window (Teams web control labels vary).
const setGuestMuted = (page, muted) => page.evalJs(`(() => {
  const t = document.querySelector('[data-tid*="toggle-mute"], [aria-label*="microphone" i][role="switch"], [aria-label*="mute" i][role="button"], [title*="ute" i]');
  if (!t) return 'no-toggle';
  const lbl = ((t.getAttribute('title') || '') + ' ' + (t.getAttribute('aria-label') || '')).toLowerCase();
  const currentlyMuted = /unmute/.test(lbl);           // "Unmute" shown ⇒ currently muted
  if (currentlyMuted !== ${muted ? 'true' : 'false'}) { t.click(); return 'toggled'; }
  return 'already';
})()`);

// --- Web-Teams guest via Chrome CDP. Default: fake-device tone (existing scenarios).
// opts.override=true installs the getUserMedia SPEECH override BEFORE Teams grabs the
// mic (launch about:blank → add pre-nav script → navigate), so the probe can drive
// speak/tone/silence independently of mute. --------------------------------------
async function joinGuest(url, opts = {}) {
  const { launchChrome, attachToPage } = require(join(REPO, 'research', 'meet-dom-detector', 'live', 'cdp-lib.js'));
  let chrome, page;
  if (opts.override) {
    const { buildOverride } = require(join(REPO, 'research', 'meet-dom-detector', 'live', 'fake-mic-override.js'));
    const wav = join(REPO, 'research', 'meet-dom-detector', 'live', 'fake-audio', 'guest.wav');
    chrome = launchChrome({ port: GUEST_PORT, headful: true, fakeAudio: true, url: 'about:blank', profileTag: 'teams-guest' });
    page = await attachToPage(GUEST_PORT, /about:blank|/);
    await page.cmd('Page.addScriptToEvaluateOnNewDocument', { source: buildOverride(wav, 'GUEST') });
    await page.cmd('Page.navigate', { url });
  } else {
    chrome = launchChrome({ port: GUEST_PORT, headful: true, fakeAudio: true, url, profileTag: 'teams-guest' });
    page = await attachToPage(GUEST_PORT, /teams\.(live|microsoft)\.com/);
  }
  const click = (needle) => page.evalJs(`(() => {
    const els = [...document.querySelectorAll('button, a, [role="button"]')];
    const el = els.find(e => (e.innerText || '').trim().toLowerCase().includes(${JSON.stringify(needle)}));
    if (el) { el.click(); return true; } return false;
  })()`);
  // Anonymous join flow: continue on browser → name → join now.
  for (let i = 0; i < 20; i++) {
    if (await click('continue on this browser')) break;
    await sleep(1_500);
  }
  await sleep(6_000);
  await page.evalJs(`(() => {
    const inp = document.querySelector('input[placeholder*="name" i], input[type="text"]');
    if (!inp) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(inp, ${JSON.stringify(GUEST_NAME)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(1_000);
  // Make sure the guest mic is ON at the pre-join screen (best-effort toggle read).
  await page.evalJs(`(() => {
    const t = document.querySelector('[data-tid*="toggle-mute"], [aria-label*="microphone" i][role="switch"], [title*="Unmute" i]');
    if (t && (t.getAttribute('aria-checked') === 'false' || /unmute/i.test(t.getAttribute('title') || ''))) { t.click(); return 'unmuted'; }
    return t ? 'already-on-or-unknown' : 'no-toggle';
  })()`);
  for (let i = 0; i < 10; i++) {
    if (await click('join now')) break;
    await sleep(1_500);
  }
  return { chrome, page, click };
}

// ===========================================================================
// FALSIFICATION PROBE (plan #1). The live QA rig only ever produced two guest
// audio states — muted and unmuted-with-tone — so the state that dominates real
// meetings (unmuted-but-SILENT, an open mic saying nothing) was never tested. If
// the ring (`vdi-frame-occlusion`) lights for that state, `teams.ring` mislabels
// every silent participant as speaking. This drives a decoupled speak/tone/silence
// timeline and samples the RAW per-tile ring (MSD_RING_TRACE) to answer:
//   A  0–45s  unmuted + silent   → ring MUST stay dark   (the load-bearing test)
//   B  next   speak (real voice) → ring lights           (rig-sanity: we can move it)
//   C  next   stop               → measure linger-L (ring-clear latency)
//   D  next   pure tone          → dark=content-VAD, lit=energy-triggered
//   E  next   mute mid-speech    → clear latency on mute
// PASS = the rig drove the ring in B AND it stayed dark through silent A (+ tone D).
const RING_TRACE_NDJSON = join(HERE, 'teams-ring-probe-trace.ndjson');
const PROBE_MARKS_JSON = join(HERE, 'teams-ring-probe-marks.json');

// Sleep `ms`, re-raising Teams every 2s so its native window stays AX-readable
// (backgrounding the app while the guest Chrome is frontmost can throttle the ring).
async function sampleFor(ms, tickFn) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (tickFn) tickFn(); } catch (e) {} await sleep(2_000); }
}

// Fraction of ring-trace samples in [t0,t1) whose ring_names include the guest.
function guestRingFraction(ringTrace, t0, t1) {
  const win = ringTrace.filter((r) => r.ts >= t0 && r.ts < t1);
  if (!win.length) return { frac: null, samples: 0, lit: 0 };
  const lit = win.filter((r) => Array.isArray(r.ring_names) && r.ring_names.includes(GUEST_NAME)).length;
  return { frac: +(lit / win.length).toFixed(3), samples: win.length, lit };
}

// linger-L: ms from `stopTs` to the LAST sample (within `horizonMs`) where the guest
// ring was still lit. null if the ring was already dark at stop (cleared immediately).
function measureLinger(ringTrace, stopTs, horizonMs = 15_000) {
  const after = ringTrace.filter((r) => r.ts >= stopTs && r.ts < stopTs + horizonMs);
  let last = null;
  for (const r of after) if (Array.isArray(r.ring_names) && r.ring_names.includes(GUEST_NAME)) last = r.ts;
  return last === null ? 0 : last - stopTs;
}

function analyzeProbe(ringTrace, marks) {
  const at = (phase) => { const m = marks.find((x) => x.phase === phase); return m ? m.ts : null; };
  const a = guestRingFraction(ringTrace, at('A_silent_start'), at('A_silent_end'));
  const b = guestRingFraction(ringTrace, at('B_speak_start'), at('B_speak_end'));
  const d = guestRingFraction(ringTrace, at('D_tone_start'), at('D_tone_end'));
  const lingerMs = at('C_stop') != null ? measureLinger(ringTrace, at('C_stop')) : null;
  const muteClearMs = at('E_mute') != null ? measureLinger(ringTrace, at('E_mute')) : null;
  // The rig must have DRIVEN the ring in B, else the run says nothing about the claim.
  const rigDroveRing = b.frac != null && b.frac >= 0.5;
  const stayedDarkSilent = a.frac != null && a.frac <= 0.1;
  const stayedDarkTone = d.frac == null || d.frac <= 0.1;   // tone window is informational
  const pass = rigDroveRing && stayedDarkSilent;
  return {
    pass, rigDroveRing, stayedDarkSilent, stayedDarkTone,
    silentWindow: a, speakWindow: b, toneWindow: d,
    lingerMs, muteClearMs, ringSamples: ringTrace.length,
  };
}

// ===========================================================================
// PHASE-3 PURE ANALYSIS HELPERS. Every parser below is keyed to a line format
// PINNED from the PRODUCT sources at bubbles-dev d8a87b8da6 (feature/active-
// speaker-integration); the file:line each format is emitted at is recorded in
// the block comment above each helper so a format drift is caught at review, not
// live. All helpers are PURE (log arrays in, verdict object out) and unit-tested
// offline against synthesized fixtures — no live Teams needed to verify the math.
//   All export at the bottom of the file alongside the probe/throttle helpers.
// ---------------------------------------------------------------------------

// --- Stderr line parsers -----------------------------------------------------
// teams-keepalive: bubbles-dev macos/teams/TeamsProbes.swift:172-173 (engaged),
//                  :197-198 (released). Format (verbatim, plain stderr, no JSON):
//   "teams-keepalive: engaged key=<memKey> age_ms=<n> pid=<pid>"
//   "teams-keepalive: released key=<memKey> reason=<reason>"
// where memKey = "Microsoft Teams|<bundle>" (TeamsProbes.swift:40) — note the memKey
// CONTAINS A SPACE ("Microsoft Teams|…"), so `key=` is captured non-greedily up to the
// next ` age_ms=` / ` reason=` field, NOT with \S+ (which would stop at the space).
const KEEPALIVE_ENGAGE_RE = /teams-keepalive: engaged key=(.+?) age_ms=(-?\d+) pid=(\d+)/;
const KEEPALIVE_RELEASE_RE = /teams-keepalive: released key=(.+?) reason=(\S+)/;
function parseKeepaliveLines(stderrLines) {
  const engage = [], release = [];
  for (const { ts, line } of stderrLines) {
    let m;
    if ((m = line.match(KEEPALIVE_ENGAGE_RE))) engage.push({ ts, key: m[1], ageMs: +m[2], pid: +m[3] });
    else if ((m = line.match(KEEPALIVE_RELEASE_RE))) release.push({ ts, key: m[1], reason: m[2] });
  }
  return { engage, release };
}

// teams-wake: bubbles-dev macos/teams/TeamsWakeObserver.swift
//   :207  "teams-wake: attached pid=<pid>"
//   :164  "teams-wake: consumed key=teams dt_ms=<n>"
//   :151  "teams-wake: released pid=<pid>"
//   :181  "teams-wake: observer-create-fail pid=<pid> err=<n> — poll-only"
// (app/window-register-fail lines exist too — informational, not asserted).
const WAKE_ATTACHED_RE = /teams-wake: attached pid=(\d+)/;
const WAKE_CONSUMED_RE = /teams-wake: consumed key=teams dt_ms=(-?\d+)/;
const WAKE_RELEASED_RE = /teams-wake: released pid=(\d+)/;
const WAKE_CREATE_FAIL_RE = /teams-wake: observer-create-fail pid=(\d+) err=(-?\d+)/;
function parseWakeLines(stderrLines) {
  const attached = [], consumed = [], released = [], createFail = [];
  for (const { ts, line } of stderrLines) {
    let m;
    if ((m = line.match(WAKE_ATTACHED_RE))) attached.push({ ts, pid: +m[1] });
    else if ((m = line.match(WAKE_CONSUMED_RE))) consumed.push({ ts, dtMs: +m[1] });
    else if ((m = line.match(WAKE_RELEASED_RE))) released.push({ ts, pid: +m[1] });
    else if ((m = line.match(WAKE_CREATE_FAIL_RE))) createFail.push({ ts, pid: +m[1], err: +m[2] });
  }
  return { attached, consumed, released, createFail };
}

// title-wake: bubbles-dev macos/shared/Browsers.swift:198-199. Format:
//   "title-wake: <bundle> pid=<pid> title=<snippet>"  (snippet = first 60 chars)
const TITLE_WAKE_RE = /title-wake: (\S+) pid=(\d+) title=(.*)/;
function parseTitleWakeLines(stderrLines) {
  const out = [];
  for (const { ts, line } of stderrLines) {
    const m = line.match(TITLE_WAKE_RE);
    if (m) out.push({ ts, bundle: m[1], pid: +m[2], title: m[3] });
  }
  return out;
}

// --- Ring-trace helpers (product [ringtrace] teams_ring_trace object) --------
// The rig reads ONLY two fields off a ring sample: `ts` (wall-clock epoch ms) and
// `ring_names` (lit non-self tile names). Source: TeamsSpeakerPipeline.swift:248-262.
// A named ring is LIT in a sample when ring_names includes that name.
function ringLitSamples(ringTrace, name, t0, t1) {
  return ringTrace.filter((r) => r.ts >= t0 && r.ts < t1
    && Array.isArray(r.ring_names) && r.ring_names.includes(name));
}
// First ts at/after `from` (within `horizonMs`) at which the named ring is lit, or null.
function firstRingLit(ringTrace, name, from, horizonMs) {
  const s = ringTrace.filter((r) => r.ts >= from && r.ts < from + horizonMs
    && Array.isArray(r.ring_names) && r.ring_names.includes(name))
    .sort((a, b) => a.ts - b.ts);
  return s.length ? s[0].ts : null;
}
// The longest contiguous span (ms) in [t0,t1) during which the named ring was DARK,
// treating any sample gap larger than `sampleGapMs` as the poll cadence (not a real
// gap). Used by ring-continuity: a layout switch must not open a >GAP release window.
function longestDarkGap(ringTrace, name, t0, t1, sampleGapMs = 700) {
  const win = ringTrace.filter((r) => r.ts >= t0 && r.ts < t1).sort((a, b) => a.ts - b.ts);
  if (!win.length) return { gapMs: null, samples: 0 };
  let worst = 0, darkStart = null, prevTs = null;
  const lit = (r) => Array.isArray(r.ring_names) && r.ring_names.includes(name);
  for (const r of win) {
    // A poll gap larger than sampleGapMs means we simply weren't sampling — do not
    // charge it as a dark span (it is unobserved, not observed-dark).
    if (prevTs != null && r.ts - prevTs > sampleGapMs && darkStart != null) darkStart = r.ts;
    if (lit(r)) { if (darkStart != null) { worst = Math.max(worst, prevTs - darkStart); darkStart = null; } }
    else if (darkStart == null) darkStart = r.ts;
    prevTs = r.ts;
  }
  if (darkStart != null && prevTs != null) worst = Math.max(worst, prevTs - darkStart);
  return { gapMs: worst, samples: win.length };
}

// --- teams_edge helpers ([event] teams_edge, MonitorDiagnostics.swift:175-194) --
// Format: {"type":"teams_edge","kind":<token>,"to":<name>,"confidence":<f>,
//          "mono_ts":<n>,"wall_ts":<epochMs>,"ts":<epochMs>}. No `from` (a ring
// onset names only the newly ringing tile). `wall_ts` is the correlation key.
const teamsEdges = (events) => events.filter((e) => e.type === 'teams_edge');
const teamsEdgesTo = (events, name) => teamsEdges(events).filter((e) => e.to === name);

// --- Scenario 1: teams-throttle-live ----------------------------------------
// Assert, over a minimize→(>=120s throttle)→restore window with the guest still
// speaking: (a) a teams-keepalive ENGAGE line appears during the throttle;
// (b) the meeting key NEVER idled — no wire meet-idle for `key`, and no full
//     speech_off-flush-to-empty (the [event] idle signal) — during the throttle;
// (c) speakers released to [] (no phantom) — the guest ring went dark while the
//     tree was throttled (a phantom would keep ring_names lit with no fresh reads);
// (d) on restore, the guest ring re-lit (recovery) within recoverMs.
// Inputs are pre-extracted so this is pure + unit-testable:
//   keepalive = parseKeepaliveLines(...).engage/.release
//   wire      = det.wire (meeting-lifecycle wire events, each {rxTs,event,key})
//   ringTrace = det.ringTrace
// marks: {minimizeTs, restoreTs} (Date.now() at each action). meetingKey is the
// product key ("Microsoft Teams|<bundle>"). recoverMs default 8000.
function analyzeThrottle({ keepalive, wire, ringTrace, meetingKey, guestName, minimizeTs, restoreTs, recoverMs = 8_000 }) {
  const engagedDuring = keepalive.engage.filter((e) => e.ts >= minimizeTs && e.ts <= restoreTs);
  // Idle signal on the wire is {"event":"meet-idle","key":...}; a re-fire of
  // meet-active for the SAME key after an idle would mean the session dropped.
  const idledDuring = wire.filter((w) => w.event === 'meet-idle'
    && (meetingKey == null || w.key === meetingKey)
    && w.rxTs >= minimizeTs && w.rxTs <= restoreTs);
  const keptSession = idledDuring.length === 0;
  // Phantom check: in the last third of the throttle window (well after the tree
  // should have thrown its last fresh ring read), the guest ring must be DARK.
  const tailStart = minimizeTs + Math.floor((restoreTs - minimizeTs) * 2 / 3);
  const tailLit = ringLitSamples(ringTrace, guestName, tailStart, restoreTs).length;
  const releasedToEmpty = tailLit === 0;
  // Recovery: guest ring re-lights within recoverMs of restore.
  const recoverTs = firstRingLit(ringTrace, guestName, restoreTs, recoverMs);
  const recovered = recoverTs != null;
  const pass = engagedDuring.length > 0 && keptSession && releasedToEmpty && recovered;
  return {
    pass, keepaliveEngaged: engagedDuring.length > 0, keptSession,
    releasedToEmpty, recovered,
    recoverMs: recoverTs != null ? recoverTs - restoreTs : null,
    engageCount: engagedDuring.length, idleCount: idledDuring.length, tailLitSamples: tailLit,
  };
}

// --- Scenario 2: teams-ring-continuity --------------------------------------
// During continuous guest speech, a layout switch (gallery→speaker→gallery) must
// NOT open a spurious ring release+reopen gap > maxGapMs (default 2500ms). We read
// the ring trace across [switchStart, switchEnd) and take the longest observed
// DARK span for the guest; a real continuity break shows as a long dark gap, while
// the poll cadence (unobserved gaps) is excluded. teams_edge onsets are reported
// (an extra reopen edge inside the window corroborates a release+reopen).
function analyzeRingContinuity({ ringTrace, events, guestName, switchStart, switchEnd, maxGapMs = 2500 }) {
  const { gapMs, samples } = longestDarkGap(ringTrace, guestName, switchStart, switchEnd);
  // Reopen edges: teams_edge naming the guest that fired DURING the switch window
  // (a survived switch needs zero — the ring never dropped, so nothing re-onset).
  const reopenEdges = teamsEdgesTo(events, guestName)
    .filter((e) => (e.wall_ts || e.ts) >= switchStart && (e.wall_ts || e.ts) < switchEnd).length;
  const survived = samples > 0 && gapMs != null && gapMs <= maxGapMs;
  return { pass: survived, survived, longestDarkGapMs: gapMs, samples, reopenEdges, maxGapMs };
}

// --- Scenario 3: teams-wake-accel -------------------------------------------
// >=6 scripted 5s-on/5s-off flips. Assert (main leg, MSD_TEAMS_WAKE default on):
//   - >=1 teams-wake:attached line;
//   - >=1 teams-wake:consumed dt_ms within ±toleranceMs of each ring-gained
//     teams_edge ONSET (a flip counts as covered if ANY consumed lands near ITS
//     onset edge); allow misses on <= allowedMisses of N onsets;
//   - 0 consumed during a >=30s silence window;
//   - teams_wakes > 0 in the final walk-stats line.
// Onsets = teams_edge naming the guest (each `wall_ts`). Consumed lines carry only
// dt_ms + a receive ts; we correlate on the CONSUMED receive ts vs the onset wall_ts.
function analyzeWakeAccel({ wake, events, walkStats, onsetName, silenceWindow, toleranceMs = 2000, allowedMisses = 1 }) {
  const onsets = teamsEdgesTo(events, onsetName).map((e) => e.wall_ts || e.ts).sort((a, b) => a - b);
  const consumedTs = wake.consumed.map((c) => c.ts);
  let covered = 0;
  const perOnset = onsets.map((on) => {
    const hit = consumedTs.some((ct) => Math.abs(ct - on) <= toleranceMs);
    if (hit) covered++;
    return { onset: on, covered: hit };
  });
  const onsetsOk = onsets.length > 0 && (onsets.length - covered) <= allowedMisses;
  const attachedOk = wake.attached.length >= 1;
  // Silence quiet: 0 consumed within the silence window.
  const consumedInSilence = silenceWindow
    ? wake.consumed.filter((c) => c.ts >= silenceWindow.start && c.ts <= silenceWindow.end).length
    : 0;
  const silenceQuiet = consumedInSilence === 0;
  const wakesCounter = walkStats && typeof walkStats.teams_wakes === 'number' ? walkStats.teams_wakes : null;
  const counterOk = wakesCounter != null && wakesCounter > 0;
  const pass = attachedOk && onsetsOk && silenceQuiet && counterOk;
  return {
    pass, attachedOk, onsetsOk, silenceQuiet, counterOk,
    onsets: onsets.length, onsetsCovered: covered, consumedTotal: wake.consumed.length,
    consumedInSilence, teamsWakes: wakesCounter, perOnset,
  };
}
// CONTROL leg (MSD_TEAMS_WAKE=0): ZERO teams-wake lines AND ring detection still
// works at the poll floor (>=1 teams_edge naming the guest). Proves the wake path
// is purely additive — turning it off removes wakes but not detection.
function analyzeWakeControl({ wake, events, walkStats, onsetName }) {
  const noWakeLines = wake.attached.length === 0 && wake.consumed.length === 0
    && wake.released.length === 0 && wake.createFail.length === 0;
  const detectionWorks = teamsEdgesTo(events, onsetName).length >= 1;
  const wakesCounter = walkStats && typeof walkStats.teams_wakes === 'number' ? walkStats.teams_wakes : null;
  const counterZero = wakesCounter === 0 || wakesCounter == null;
  const pass = noWakeLines && detectionWorks && counterZero;
  return { pass, noWakeLines, detectionWorks, counterZero, teamsWakes: wakesCounter,
           edgeCount: teamsEdgesTo(events, onsetName).length };
}

// --- Scenario 4: teams-web-cold-start ---------------------------------------
// Cold Chrome + a Teams WEB meeting tab. Assert: a title-wake line fires for the
// Chrome pid AND the meeting is DETECTED (a meeting_initialized [event] with
// platform "teams") within `passBudget` passes / `msBudget` ms of detector start.
// Web is roster-only — do NOT require a speaking signal (Phase-2 verdict may be
// roster-only). Reports the actual detect latency so the bar can be tuned.
function analyzeWebColdStart({ titleWakes, events, detectStartTs, chromePids, msBudget = 3000 }) {
  const wakeForChrome = titleWakes.find((t) => !chromePids || chromePids.includes(t.pid));
  const wakeFired = !!wakeForChrome;
  // meeting_initialized for a teams platform (product emits platform token "teams").
  const init = events.find((e) => e.type === 'meeting_initialized' && e.platform === 'teams');
  const detected = !!init;
  const detectLatencyMs = init && init.ts != null && detectStartTs != null ? init.ts - detectStartTs : null;
  const withinBudget = detected && (detectLatencyMs == null || detectLatencyMs <= msBudget);
  const pass = wakeFired && detected && withinBudget;
  return { pass, wakeFired, detected, withinBudget, detectLatencyMs, msBudget,
           wakePid: wakeForChrome ? wakeForChrome.pid : null };
}

// --- Scenario 6: ABA-on-flake protocol --------------------------------------
// A rig helper (not prose): any cpu/perf-style suite FAIL triggers ONE automatic
// ABA re-check (suspect binary vs frozen reference, back-to-back, same held
// session) before the verdict is final. Binary-INDEPENDENT session-state effects
// (present on BOTH legs: e.g. bounded-tier non-engagement, subtree_reads==0 on
// both) mark the run ENVIRONMENTAL-RETRY instead of FAIL — the environment, not
// the binary, is degenerate. Reference binary path = MSD_REFERENCE_BIN.
// This is the PURE adjudicator; the live driver (runWakeAccel etc.) supplies the
// two legs' walk-stats + the original verdict.
function abaAdjudicate({ originalVerdict, suspectStats, referenceStats }) {
  if (originalVerdict !== 'FAIL') return { verdict: originalVerdict, aba: false };
  const s = suspectStats || {};
  const r = referenceStats || {};
  // Binary-independent degeneracy: a signal that is broken IDENTICALLY on both the
  // suspect and the frozen reference is an environment fault, not a regression.
  const bothSubtreeZero = s.subtree_reads === 0 && r.subtree_reads === 0;
  const bothNoFullWalks = (s.full_walks === 0) && (r.full_walks === 0);
  if (bothSubtreeZero || bothNoFullWalks) {
    return { verdict: 'ENVIRONMENTAL-RETRY', aba: true,
             reason: bothSubtreeZero ? 'subtree_reads==0 on BOTH legs (session degenerate, not the binary)'
                                     : 'full_walks==0 on BOTH legs (bounded tier never engaged on either)',
             suspectStats: s, referenceStats: r };
  }
  // The suspect is genuinely worse than the frozen reference on the work metric →
  // the FAIL stands. Otherwise (suspect <= reference) the original FAIL was flake →
  // recheck clears it to REVIEW for the human gate, never an outright silent PASS.
  const suspectWorse = (s.full_walks || 0) > (r.full_walks || 0);
  return suspectWorse
    ? { verdict: 'FAIL', aba: true, reason: 'ABA confirms: suspect full_walks > reference', suspectStats: s, referenceStats: r }
    : { verdict: 'REVIEW', aba: true, reason: 'ABA does not reproduce the FAIL (suspect <= reference) — flake, human-gate', suspectStats: s, referenceStats: r };
}

async function runProbe() {
  mkdirSync(HERE, { recursive: true });
  writeFileSync(RESULTS_NDJSON, '');
  if (!prebuild()) { record('teams-ring-probe', 'FAIL', { reason: 'swift build failed' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }
  if (!preflightAxTrust()) { record('teams-ring-probe', 'FAIL', { reason: 'Accessibility permission not granted' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }

  // Raw ring trace + fine poll (150ms) so linger-L has sub-500ms resolution.
  const det = startDetector(1800, { MSD_RING_TRACE: '1', MSD_POLL_INTERVAL_MS: '150' });
  const marks = [];
  const mark = (phase, extra = {}) => { const m = { phase, ts: Date.now(), ...extra }; marks.push(m); log(`MARK ${phase} @${m.ts}`); };
  let chromeGuest = null;
  try {
    if (!await hostJoinCall()) { record('teams-ring-probe', 'FAIL', { reason: 'host could not join a call' }); return; }
    // isTeamsProd matches BOTH the sandbox teams:: id and the product
    // "Microsoft Teams|<bundle>" key, so the probe gates the PRODUCT binary
    // (MSD_DETECTOR_BIN) unchanged as well as the sandbox debug build.
    await waitEvent(det, (e) => e.type === 'meeting_initialized' && isTeamsProd(e), 60_000, 'meeting_initialized');
    const meetingUrl = await harvestInCall();
    if (!meetingUrl) { record('teams-ring-probe', 'REVIEW', { reason: 'no meeting URL (set TEAMS_MEETING_URL)' }); return; }
    log('meeting link: ' + meetingUrl);

    chromeGuest = await joinGuest(meetingUrl, { override: true });
    await sleep(8_000);
    await pressFirst(['Admit'], 3_000);
    const guestJoin = await waitEvent(det, (e) => e.type === 'participant_joined' && isTeamsProd(e) && e.name === GUEST_NAME, 120_000, 'guest joined');
    if (!guestJoin) { record('teams-ring-probe', 'FAIL', { reason: 'guest never joined (override path)' }); return; }
    const page = chromeGuest.page;
    // Confirm the getUserMedia override actually installed.
    let ready = false;
    for (let i = 0; i < 20 && !ready; i++) { ready = await guestMicReady(page); if (!ready) await sleep(500); }
    if (!ready) { record('teams-ring-probe', 'REVIEW', { reason: 'fake-mic override never became ready (__fakeMicReady false)' }); return; }
    const raise = () => drive('raise');

    // A — open mic, SILENT (load-bearing).
    await setGuestTone(page, false); await setGuestSpeak(page, false);
    mark('A_silent_start'); raise(); await sampleFor(45_000, raise); mark('A_silent_end');
    // B — real speech.
    await setGuestSpeak(page, true);
    mark('B_speak_start'); await sampleFor(30_000, raise); mark('B_speak_end');
    // C — stop → linger.
    await setGuestSpeak(page, false); mark('C_stop'); await sampleFor(20_000, raise);
    // D — pure tone (energy, no content).
    await setGuestTone(page, true);
    mark('D_tone_start'); await sampleFor(40_000, raise); await setGuestTone(page, false); mark('D_tone_end');
    // E — speak then mute mid-speech.
    await setGuestSpeak(page, true); mark('E_speak_start'); await sampleFor(10_000, raise);
    const muteAction = await setGuestMuted(page, true); mark('E_mute', { muteAction });
    await sampleFor(10_000, raise); await setGuestSpeak(page, false);

    // Persist the raw trace + marks (fixture-authoring source) and verdict.
    writeFileSync(RING_TRACE_NDJSON, det.ringTrace.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(PROBE_MARKS_JSON, JSON.stringify(marks, null, 2));
    // Fail-SAFE on zero parsed ring lines: if the product's [ringtrace] sink never
    // produced a single sample, the probe measured NOTHING — it must be REVIEW, never
    // a silent PASS or a FAIL (a prior review verified this property; keep it). This is
    // the explicit guard; analyzeProbe already downgrades an unmoved ring to REVIEW too.
    if (det.ringTrace.length === 0) {
      record('teams-ring-probe', 'REVIEW', {
        reason: 'zero [ringtrace] lines parsed from the detector stderr — MSD_RING_TRACE sink produced nothing (product binary? wrong stream? tree unreadable). Nothing measured.',
        ringSamples: 0,
      });
      log('PROBE zero ring samples -> REVIEW (fail-safe)');
      return;
    }
    const v = analyzeProbe(det.ringTrace, marks);
    record('teams-ring-probe', v.pass ? 'PASS' : (v.rigDroveRing ? 'FAIL' : 'REVIEW'), v);
    log(`PROBE silentA=${JSON.stringify(v.silentWindow)} speakB=${JSON.stringify(v.speakWindow)} toneD=${JSON.stringify(v.toneWindow)} lingerMs=${v.lingerMs} muteClearMs=${v.muteClearMs}`);
  } finally {
    await hostLeaveCall();
    if (chromeGuest && chromeGuest.chrome) chromeGuest.chrome.kill();
    det.kill();
  }
  console.log('TEAMS LIVE SESSION COMPLETE');
  process.exit(0);
}

// ===========================================================================
// THROTTLE / PIP MEASUREMENT (plan #3). When Teams is backgrounded, WebView2
// throttles the renderer and the deep AX tree goes empty; today we degrade to
// "Someone" and hold the roster for a GUESSED 5-min TTL (teamsMemoryTtlMs). This
// drives the scriptable backgrounding modes (minimize, hide) with precise timing
// and reads the window-level trace (MSD_RING_TRACE → [teamstrace]) to measure, per
// mode: ms from the action to tree-empty, and whether the compact/PIP "<name> is
// speaking" note survives the throttle. Occlude / Chat-tab are not cleanly
// scriptable — a manual window is left open with the trace running for those.
const THROTTLE_NDJSON = join(HERE, 'teams-throttle-trace.ndjson');

// osascript app hide/show + AXMinimized via TeamsDrive.
const hideTeams = () => spawnSync('osascript', ['-e', 'tell application "System Events" to set visible of (first process whose bundle identifier is "com.microsoft.teams2") to false'], { encoding: 'utf8' });
const showTeams = () => { spawnSync('open', ['-b', 'com.microsoft.teams2']); drive('raise'); };

// First [teamstrace] sample AT/AFTER actionTs whose window went unreadable (tree
// empty). Returns { latencyMs, pipSurvived, samples } over [actionTs, actionTs+winMs).
function measureThrottle(teamsTrace, actionTs, winMs = 25_000) {
  const win = teamsTrace.filter((r) => r.ts >= actionTs && r.ts < actionTs + winMs);
  const firstEmpty = win.find((r) => r.readable === false || r.tile_count === 0);
  const pipSurvived = win.some((r) => (r.readable === false || r.tile_count === 0) && r.pip != null);
  return {
    latencyMs: firstEmpty ? firstEmpty.ts - actionTs : null,   // null = never went empty in the window
    pipSurvived, samples: win.length,
    keptAlive: win.some((r) => r.keep_alive === true),
  };
}

async function runThrottleMode(det, mode, apply, restore) {
  log(`THROTTLE mode=${mode}: applying…`);
  const actionTs = Date.now();
  apply();
  await sampleFor(25_000, null);          // observe the tree-empty transition
  const m = measureThrottle(det.teamsTrace, actionTs);
  log(`THROTTLE mode=${mode}: tree-empty in ${m.latencyMs == null ? 'NEVER(<25s)' : m.latencyMs + 'ms'}, pipSurvived=${m.pipSurvived}, keptAlive=${m.keptAlive}`);
  restore();
  await sampleFor(8_000, () => drive('raise'));   // let it recover before the next mode
  return { mode, ...m, actionTs };
}

async function runThrottle() {
  mkdirSync(HERE, { recursive: true });
  writeFileSync(RESULTS_NDJSON, '');
  if (!prebuild()) { record('teams-throttle', 'FAIL', { reason: 'swift build failed' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }
  if (!preflightAxTrust()) { record('teams-throttle', 'FAIL', { reason: 'Accessibility permission not granted' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }

  const det = startDetector(1800, { MSD_RING_TRACE: '1', MSD_POLL_INTERVAL_MS: '250' });
  const results = [];
  try {
    if (!await hostJoinCall()) { record('teams-throttle', 'FAIL', { reason: 'host could not join a call' }); return; }
    await waitEvent(det, (e) => e.type === 'meeting_initialized' && isTeams(e), 60_000, 'meeting_initialized');
    // Baseline: confirm the tree is readable while foreground.
    await sampleFor(6_000, () => drive('raise'));

    // Scriptable modes.
    results.push(await runThrottleMode(det, 'minimize', () => drive('minimize'), () => drive('unminimize')));
    results.push(await runThrottleMode(det, 'hidden', () => hideTeams(), () => showTeams()));

    // Manual window (occlude with another app / switch to Chat): the operator does
    // these by hand while the trace keeps recording; we just timestamp the window.
    const manualTs = Date.now();
    log('THROTTLE manual: occlude Teams with another maximized app AND/OR switch Teams to the Chat tab now — 40s…');
    await sampleFor(40_000, null);
    const manual = measureThrottle(det.teamsTrace, manualTs, 40_000);

    writeFileSync(THROTTLE_NDJSON, det.teamsTrace.map((r) => JSON.stringify(r)).join('\n') + '\n');
    // Recommend a TTL: comfortably above the slowest observed tree-empty latency, or
    // REVIEW if nothing throttled (measurement inconclusive).
    const lats = results.map((r) => r.latencyMs).filter((x) => x != null);
    const anyThrottled = lats.length > 0 || manual.latencyMs != null;
    record('teams-throttle', anyThrottled ? 'PASS' : 'REVIEW', {
      results, manual, slowestEmptyMs: lats.length ? Math.max(...lats) : null,
      note: 'set teamsMemoryTtlMs from real backgrounded-meeting duration, NOT this latency; latency only bounds how fast we must switch to keep-alive.',
    });
  } finally {
    showTeams();
    await hostLeaveCall();
    det.kill();
  }
  console.log('TEAMS LIVE SESSION COMPLETE');
  process.exit(0);
}

// ===========================================================================
// EVENT-DRIVEN PORT PROBE (AXObserve). Prerequisite for porting Meet's observer
// pattern to Teams: runs AXObserve on native Teams while a guest drives REAL ring
// on/off handoffs (speak/silence every 7s), so we can see WHICH AXObserver
// notifications actually fire as a wake-up in Teams' WebView2 tree — empirically,
// not by assuming Meet's set transfers 1:1. Output: notifications bucketed by type
// + tag, correlated with the driven toggles → the confirmed wake-up event set (or
// BLOCKED if nothing usable fires).
const AXOBSERVE_BIN = join(MACOS, '.build', 'debug', 'AXObserve');
const OBSERVE_LOG = join(HERE, 'teams-axobserve-probe.log');

// Parse the notification token + tag out of an AXObserve line.
const AX_NOTIF_RE = /\b(AX[A-Za-z]+Changed|AXLayoutChanged|AXAnnouncementRequested|AXLiveRegion[A-Za-z]+|AXSelectedChildrenChanged|AXMenuItemSelected|AXMenuOpened|AXFocusedUIElementChanged|AXUIElementDestroyed)\b/;
function parseAxLine(line) {
  const m = line.match(AX_NOTIF_RE);
  if (!m) return null;
  const tag = /\[LIVE\]/.test(line) ? 'LIVE' : (/\[TILE\]/.test(line) ? 'TILE' : 'other');
  return { notif: m[1], tag };
}
function analyzeObserve(axLines, toggles) {
  const parsed = axLines.map((l) => ({ ts: l.ts, ...(parseAxLine(l.line) || {}) })).filter((p) => p.notif);
  const byType = {}, byTag = { LIVE: 0, TILE: 0, other: 0 };
  for (const p of parsed) { byType[p.notif] = (byType[p.notif] || 0) + 1; byTag[p.tag]++; }
  // Correlate: events within 2s AFTER each toggle = wake-ups the observer would ride.
  const WAKE_MS = 2_000;
  let togglesWithEvents = 0;
  const wakeTypeCounts = {};
  for (const t of toggles) {
    const near = parsed.filter((p) => p.ts >= t.ts && p.ts < t.ts + WAKE_MS);
    if (near.length) togglesWithEvents++;
    for (const p of near) wakeTypeCounts[p.notif] = (wakeTypeCounts[p.notif] || 0) + 1;
  }
  const topWakeTypes = Object.entries(wakeTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  // Usable = the ring transitions produced observer wake-ups on a majority of toggles,
  // AND at least one tile/value/layout event type carried them (not just clock noise).
  const wakeTypesUseful = topWakeTypes.filter(([n]) => /Value|Layout|Selected|LiveRegion|Announcement|Destroyed/.test(n));
  const usable = togglesWithEvents >= Math.ceil(toggles.length * 0.5) && wakeTypesUseful.length > 0;
  return {
    usable, totalEvents: parsed.length, togglesTotal: toggles.length, togglesWithEvents,
    byType, byTag, topWakeTypes, wakeTypesUseful: wakeTypesUseful.map(([n, c]) => `${n}:${c}`),
  };
}

async function runObserve() {
  mkdirSync(HERE, { recursive: true });
  writeFileSync(RESULTS_NDJSON, '');
  if (!prebuild()) { record('teams-axobserve-probe', 'FAIL', { reason: 'swift build failed' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }
  if (!preflightAxTrust()) { record('teams-axobserve-probe', 'FAIL', { reason: 'Accessibility permission not granted' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }

  let chromeGuest = null, axProc = null;
  const toggles = [], axLines = [];
  try {
    if (!await hostJoinCall()) { record('teams-axobserve-probe', 'FAIL', { reason: 'host could not join a call' }); return; }
    const det = startDetector(900);
    await waitEvent(det, (e) => e.type === 'meeting_initialized' && isTeams(e), 60_000, 'meeting_initialized');
    const url = await harvestInCall();
    if (!url) { record('teams-axobserve-probe', 'REVIEW', { reason: 'no meeting URL' }); det.kill(); return; }
    log('meeting link: ' + url);
    chromeGuest = await joinGuest(url, { override: true });
    await sleep(8_000); await pressFirst(['Admit'], 3_000);
    const gj = await waitEvent(det, (e) => e.type === 'participant_joined' && isTeams(e) && e.name === GUEST_NAME, 120_000, 'guest joined');
    det.kill();
    if (!gj) { record('teams-axobserve-probe', 'FAIL', { reason: 'guest never joined' }); return; }
    const page = chromeGuest.page;
    for (let i = 0; i < 20 && !(await guestMicReady(page)); i++) await sleep(500);
    drive('raise'); await sleep(1_000);

    // Spawn AXObserve over the whole handoff sequence.
    const OBS_SECS = 74;
    axProc = spawn(AXOBSERVE_BIN, ['teams', String(OBS_SECS)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let abuf = '';
    const onA = (d) => { abuf += d.toString(); let i; while ((i = abuf.indexOf('\n')) >= 0) { const ln = abuf.slice(0, i); abuf = abuf.slice(i + 1); axLines.push({ ts: Date.now(), line: ln }); } };
    axProc.stdout.on('data', onA); axProc.stderr.on('data', onA);
    const axDone = new Promise((r) => axProc.on('exit', r));
    await sleep(2_000);   // let AXObserve register its hooks

    // Drive REAL ring handoffs: speak/silence every 7s (~9 transitions), re-raising
    // Teams so its WebView2 tree stays live for the observer.
    await setGuestSpeak(page, false); await sleep(1_500);
    for (let i = 0; i < 9; i++) {
      const on = i % 2 === 0;
      await setGuestSpeak(page, on);
      toggles.push({ i, on, ts: Date.now() });
      log(`toggle ${i}: guest ${on ? 'SPEAK' : 'silent'}`);
      await sampleFor(7_000, () => drive('raise'));
    }
    await axDone;

    writeFileSync(OBSERVE_LOG, axLines.map((l) => l.line).join('\n') + '\n');
    const summary = analyzeObserve(axLines, toggles);
    record('teams-axobserve-probe', summary.usable ? 'PASS' : 'FAIL', summary);
    log('OBSERVE ' + JSON.stringify(summary));
  } finally {
    if (axProc) { try { axProc.kill('SIGKILL'); } catch (e) {} }
    await hostLeaveCall();
    if (chromeGuest && chromeGuest.chrome) chromeGuest.chrome.kill();
  }
  console.log('TEAMS LIVE SESSION COMPLETE');
  process.exit(0);
}

// ===========================================================================
// EVENT-MODE LIVE QA (MSD_TEAMS_MODE=event). Validates the ported half end-to-end on
// a real call: the per-tick ring snapshot/diff feeds TransitionConfidence and emits
// teams_edge + teams_walk_stats. Drives RAPID handoffs (a guest toggling speak/silence
// every ~2.2s) and asserts: (1) teams_walk_stats emitted with event_mode=true, (2)
// teams_edge onsets fired on the ring churn, (3) the guest is still NAMED via
// teams.ring / teams.ring.transition (attribution intact), (4) ZERO Someone / self
// false speech. Reports the walk-count (the honest CPU story: Teams doesn't skip the
// walk — event mode buys ACCURACY, not fewer walks).
async function runEventQA() {
  mkdirSync(HERE, { recursive: true });
  writeFileSync(RESULTS_NDJSON, '');
  if (!prebuild()) { record('teams-eventqa', 'FAIL', { reason: 'swift build failed' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }
  if (!preflightAxTrust()) { record('teams-eventqa', 'FAIL', { reason: 'Accessibility permission not granted' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }

  // MSD_RING_TRACE surfaces the per-edge teams_edge lines (debug-gated in the default
  // path) so this QA can count onsets; event mode is on by default but set explicitly.
  const det = startDetector(900, { MSD_TEAMS_MODE: 'event', MSD_RING_TRACE: '1' });
  let chromeGuest = null;
  try {
    if (!await hostJoinCall()) { record('teams-eventqa', 'FAIL', { reason: 'host could not join a call' }); return; }
    await waitEvent(det, (e) => e.type === 'meeting_initialized' && isTeams(e), 60_000, 'meeting_initialized');
    const url = await harvestInCall();
    if (!url) { record('teams-eventqa', 'REVIEW', { reason: 'no meeting URL' }); return; }
    log('meeting link: ' + url);
    chromeGuest = await joinGuest(url, { override: true });
    await sleep(8_000); await pressFirst(['Admit'], 3_000);
    const gj = await waitEvent(det, (e) => e.type === 'participant_joined' && isTeams(e) && e.name === GUEST_NAME, 120_000, 'guest joined');
    if (!gj) { record('teams-eventqa', 'FAIL', { reason: 'guest never joined' }); return; }
    const page = chromeGuest.page;
    for (let i = 0; i < 20 && !(await guestMicReady(page)); i++) await sleep(500);
    drive('raise'); await sleep(1_000);

    // Rapid handoffs: speak/silence every ~2.2s to churn the ring (onset edges).
    for (let i = 0; i < 12; i++) {
      await setGuestSpeak(page, i % 2 === 0);
      log(`handoff ${i}: guest ${i % 2 === 0 ? 'SPEAK' : 'silent'}`);
      await sampleFor(2_200, () => drive('raise'));
    }
    await sleep(3_000);
    det.kill(); await det.done;

    const walkStats = det.events.filter((e) => e.type === 'teams_walk_stats');
    const lastStats = walkStats[walkStats.length - 1] || null;
    const edges = det.events.filter((e) => e.type === 'teams_edge');
    const guestNamed = det.events.filter((e) => e.type === 'speech_on' && e.name === GUEST_NAME && /teams\.(ring|ring\.transition)/.test(e.source || ''));
    const transitionNamed = det.events.filter((e) => e.type === 'speech_on' && e.source === 'teams.ring.transition');
    const badSpeech = det.events.filter((e) => e.type === 'speech_on' && (e.name === 'Someone' || e.name === EXPECT_SELF));
    const pass = !!lastStats && lastStats.event_mode === true && edges.length > 0 && guestNamed.length > 0 && badSpeech.length === 0;
    record('teams-eventqa', pass ? 'PASS' : 'FAIL', {
      walkStats: lastStats, edgeCount: edges.length, guestNamed: guestNamed.length,
      transitionNamed: transitionNamed.length, badSpeech: badSpeech.length,
      note: 'event mode buys accuracy (edges → rapid-swap disambiguation), NOT fewer walks — teams has no walk-skip (docs §10).',
    });
    log(`EVENTQA walkStats=${JSON.stringify(lastStats)} edges=${edges.length} guestNamed=${guestNamed.length} transitionNamed=${transitionNamed.length} bad=${badSpeech.length}`);
  } finally {
    await hostLeaveCall();
    if (chromeGuest && chromeGuest.chrome) chromeGuest.chrome.kill();
    det.kill();
  }
  console.log('TEAMS LIVE SESSION COMPLETE');
  process.exit(0);
}

// ===========================================================================
// OBS-SWEEP LIVE SESSION (--obssweep). Drives the PRODUCT binary (MSD_DETECTOR_BIN)
// with MSD_OBS_TRACE=1 so its in-process TeamsObserverSweep registers the full
// kAX notification set on the native-Teams pid + call windows, and captures raw
// stderr (the obs-sweep lines) tee'd to a file, plus the edge log and a scripted
// phase/flip timeline. This is measurement-only: it never asserts detection
// correctness, only whether ANY AX callback fires and whether registration took
// (obs-sweep-stats registered>0). Reuses hostJoinCall/joinGuest/setGuestSpeak/
// drive/hide/show exactly as the other live modes. Env: OBS_SWEEP_DIR (artifact
// dir), OBS_SWEEP_SESSION (session tag for filenames).
const OBS_DIR = process.env.OBS_SWEEP_DIR
  || '/private/tmp/claude-501/-Users-bibekthapa-projects-work-demo-app/a7193c99-f3ed-4083-a664-863fa5775596/scratchpad/obs-sweep';
const OBS_SESSION = process.env.OBS_SWEEP_SESSION || 's1';

// Spawn the PRODUCT detector with the observer sweep on; tee raw stderr+stdout to
// files and keep a per-line wall-clock receive log (so obs-sweep callback lines
// can be correlated with the scripted flip timeline by receive-ts, mirroring how
// runObserve timestamps AXObserve lines). Also parses [event] JSON into memory so
// we can wait on meeting_initialized / participant_joined.
function startSweepDetector(seconds, sessionTag, extraEnv = {}) {
  const stderrPath = join(OBS_DIR, `sweep-stderr-${sessionTag}.log`);
  const edgePath = join(OBS_DIR, `edge-${sessionTag}.log`);
  const rxPath = join(OBS_DIR, `sweep-rx-${sessionTag}.ndjson`); // {ts, stream, line} per line
  const env = {
    ...process.env,
    MSD_AUTOSTART: '1',
    MSD_RUN_SECONDS: String(seconds),
    MSD_OBS_TRACE: '1',
    MSD_EDGE_LOG: edgePath,
    ...extraEnv,
  };
  const proc = spawn(DETECTOR_BIN, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = [];
  const obsLines = [];   // {ts, line} for every stderr line containing 'obs-sweep'
  writeFileSync(stderrPath, '');
  writeFileSync(rxPath, '');
  const mkOn = (stream) => {
    let buf = '';
    return (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ln = buf.slice(0, i); buf = buf.slice(i + 1);
        const ts = Date.now();
        appendFileSync(rxPath, JSON.stringify({ ts, stream, line: ln }) + '\n');
        if (stream === 'err') appendFileSync(stderrPath, ln + '\n');
        if (ln.includes('obs-sweep')) obsLines.push({ ts, line: ln });
        const j = ln.indexOf('{');
        if (j >= 0 && ln.includes('[event]')) {
          try { const o = JSON.parse(ln.slice(j)); if (o && o.type) events.push(o); } catch (e) {}
        }
      }
    };
  };
  proc.stdout.on('data', mkOn('out'));
  proc.stderr.on('data', mkOn('err'));
  const done = new Promise((res) => proc.on('exit', res));
  return { proc, events, obsLines, done, stderrPath, edgePath, rxPath,
           pid: proc.pid, kill: () => { try { proc.kill('SIGKILL'); } catch (e) {} } };
}

// Best-effort native layout switch via TeamsDrive: View menu → gallery/speaker/
// together. Labels vary by Teams build; press the first that lands. Returns the
// label used or null (layout coverage is manual-best-effort per the protocol).
async function driveLayout(kind) {
  const menus = {
    gallery: ['Gallery', 'Gallery view', 'Gallery at top'],
    speaker: ['Speaker', 'Speaker view', 'Focus'],
    together: ['Together mode', 'Together'],
  }[kind] || [];
  // Open the "More"/"View" affordance first if present, then press the layout.
  await pressFirst(['View', 'More', 'More options'], 1200);
  return await pressFirst(menus, 1500);
}

// PRODUCT-binary Teams predicate. The sandbox detector keys meeting_id as
// "teams::…" (isTeams above), but the PRODUCT binary emits
// meeting_id="Microsoft Teams|com.microsoft.teams2" with platform="teams" on
// meeting_initialized (and the same pipe id on participant_joined). Match on
// platform OR the pipe-id so the sweep wrapper recognizes the product's events.
const isTeamsProd = (e) =>
  e && (e.platform === 'teams'
    || (typeof e.meeting_id === 'string'
        && (e.meeting_id.startsWith('teams::')
            || e.meeting_id.startsWith('Microsoft Teams|'))));

// A scripted phase marker, wall-clock ts. Written to the flip timeline.
function phaseMark(marks, phase, extra = {}) {
  const m = { phase, ts: Date.now(), ...extra };
  marks.push(m);
  log(`PHASE ${phase} @${m.ts}`);
  return m;
}

async function runOneSweepSession(sessionTag) {
  const stderrPath = join(OBS_DIR, `sweep-stderr-${sessionTag}.log`);
  const edgePath = join(OBS_DIR, `edge-${sessionTag}.log`);
  const rxPath = join(OBS_DIR, `sweep-rx-${sessionTag}.ndjson`);
  const marksPath = join(OBS_DIR, `flip-timeline-${sessionTag}.json`);
  const marks = [];
  let chromeGuest = null;
  const det = startSweepDetector(1200, sessionTag);
  const result = { sessionTag, det: { pid: det.pid }, blocked: null };

  try {
    phaseMark(marks, 'session_start', { sessionTag, detectorPid: det.pid });
    if (!await hostJoinCall()) { result.blocked = 'host could not join a Teams native call'; return result; }
    const init = await waitEvent(det, (e) => e.type === 'meeting_initialized' && isTeamsProd(e), 60_000, 'meeting_initialized');
    if (!init) { result.blocked = 'no teams meeting_initialized within 60s (sweep never got a native pid)'; return result; }
    phaseMark(marks, 'meeting_initialized', { meeting_id: init.meeting_id });

    // Wait up to 30s for the FIRST obs-sweep-stats line with registered>0 — the
    // registration proof. If registered=0 / no stats, diagnose before continuing.
    const regDeadline = Date.now() + 30_000;
    let firstStats = null;
    while (Date.now() < regDeadline) {
      const stats = det.obsLines.filter((l) => l.line.includes('obs-sweep-stats'));
      const withReg = stats.find((l) => /registered=([1-9]\d*)/.test(l.line));
      if (withReg) { firstStats = withReg; break; }
      await sleep(1000);
    }
    if (!firstStats) {
      const anyStats = det.obsLines.filter((l) => l.line.includes('obs-sweep-stats'));
      result.registrationProof = anyStats.length
        ? `stats present but registered=0: ${anyStats[anyStats.length - 1].line}`
        : 'NO obs-sweep-stats lines at all — sweep never attached (env? attach condition? pid?)';
      phaseMark(marks, 'registration_UNPROVEN', { detail: result.registrationProof });
      // Continue anyway to gather diagnostics, but the verdict will flag this.
    } else {
      result.registrationProof = firstStats.line;
      phaseMark(marks, 'registration_proven', { line: firstStats.line });
    }

    // Bring in a speaking guest (needed for ring flips). Harvest link, join guest.
    const url = await harvestInCall();
    if (url) {
      log('meeting link: ' + url);
      try {
        chromeGuest = await joinGuest(url, { override: true });
        await sleep(8_000); await pressFirst(['Admit'], 3_000);
        const gj = await waitEvent(det, (e) => e.type === 'participant_joined' && isTeamsProd(e) && e.name === GUEST_NAME, 120_000, 'guest joined');
        if (gj) {
          phaseMark(marks, 'guest_joined', { name: GUEST_NAME });
          const page = chromeGuest.page;
          for (let i = 0; i < 20 && !(await guestMicReady(page)); i++) await sleep(500);
        } else {
          phaseMark(marks, 'guest_join_FAILED', {});
        }
      } catch (e) { log('guest join error: ' + e.message); phaseMark(marks, 'guest_join_ERROR', { err: String(e && e.message) }); }
    } else {
      phaseMark(marks, 'no_meeting_url', { note: 'ring-flip window will be solo — best-effort self-tile activity only' });
    }
    const page = chromeGuest ? chromeGuest.page : null;

    drive('raise'); await sleep(1000);

    // ---- Window (i): guest speaking cycles ~5s on / ~5s off, >=6 flips (>=60s) ----
    phaseMark(marks, 'W1_flips_start', {});
    for (let i = 0; i < 6; i++) {
      const on = true;
      if (page) await setGuestSpeak(page, on);
      phaseMark(marks, 'flip_on', { i });
      await sampleFor(5_000, () => drive('raise'));
      if (page) await setGuestSpeak(page, false);
      phaseMark(marks, 'flip_off', { i });
      await sampleFor(5_000, () => drive('raise'));
    }
    phaseMark(marks, 'W1_flips_end', {});

    // ---- Window (ii): silence (>=60s), guest muted/silent, no flips ----
    if (page) await setGuestSpeak(page, false);
    phaseMark(marks, 'W2_silence_start', {});
    await sampleFor(60_000, () => drive('raise'));
    phaseMark(marks, 'W2_silence_end', {});

    // ---- Window (iii): layout change events (best-effort) ----
    phaseMark(marks, 'W3_layout_start', {});
    for (const kind of ['speaker', 'gallery', 'together', 'gallery']) {
      const used = await driveLayout(kind);
      phaseMark(marks, 'layout_switch', { kind, used });
      await sampleFor(8_000, () => drive('raise'));
    }
    phaseMark(marks, 'W3_layout_end', {});

    // ---- Window (iv): foreground vs backgrounded/minimized (throttle state) ----
    // Drive guest speech continuously so ring WOULD flip if callbacks fired; the
    // question is whether callbacks keep coming while Teams is throttled.
    phaseMark(marks, 'W4_foreground_speak_start', {});
    if (page) await setGuestSpeak(page, true);
    await sampleFor(15_000, () => drive('raise'));   // foreground, speaking
    phaseMark(marks, 'W4_minimize', {});
    drive('minimize');
    await sampleFor(20_000, null);                    // minimized, guest still speaking
    phaseMark(marks, 'W4_unminimize', {});
    drive('unminimize'); drive('raise');
    await sampleFor(6_000, () => drive('raise'));
    phaseMark(marks, 'W4_hide', {});
    hideTeams();
    await sampleFor(20_000, null);                    // hidden, guest still speaking
    phaseMark(marks, 'W4_show', {});
    showTeams();
    await sampleFor(6_000, () => drive('raise'));
    if (page) await setGuestSpeak(page, false);
    phaseMark(marks, 'W4_end', {});

    phaseMark(marks, 'session_end', {});

    // Snapshot the last stats line per pid for the registration-proof table.
    const statsLines = det.obsLines.filter((l) => l.line.includes('obs-sweep-stats'));
    result.lastStats = statsLines.length ? statsLines[statsLines.length - 1].line : null;
    result.allStatsCount = statsLines.length;
    result.callbackLines = det.obsLines.filter((l) => /obs-sweep: (?!register-fail)(?!observer-create-fail)(?!stats)/.test(l.line)).length;
  } finally {
    // Give the detector a moment to flush a final stats tick, then stop it.
    await sleep(1500);
    if (chromeGuest && chromeGuest.chrome) { try { chromeGuest.chrome.kill(); } catch (e) {} }
    await hostLeaveCall();
    det.kill();
    writeFileSync(marksPath, JSON.stringify(marks, null, 2));
    result.artifacts = { stderrPath, edgePath, rxPath, marksPath };
  }
  return result;
}

async function runObsSweep() {
  mkdirSync(OBS_DIR, { recursive: true });
  mkdirSync(HERE, { recursive: true });
  writeFileSync(RESULTS_NDJSON, '');
  if (!process.env.MSD_DETECTOR_BIN) {
    console.error('[teams-live] --obssweep REQUIRES MSD_DETECTOR_BIN pointed at the PRODUCT binary');
    record('teams-obssweep', 'FAIL', { reason: 'MSD_DETECTOR_BIN unset' });
    console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1);
  }
  if (!prebuild()) { record('teams-obssweep', 'FAIL', { reason: 'TeamsDrive missing' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }
  if (!preflightAxTrust()) { record('teams-obssweep', 'FAIL', { reason: 'Accessibility permission not granted' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }

  const sessions = (process.env.OBS_SWEEP_SESSIONS || 's1,s2').split(',');
  const results = [];
  for (const tag of sessions) {
    log(`===== OBS-SWEEP SESSION ${tag} =====`);
    try {
      const r = await runOneSweepSession(tag);
      results.push(r);
      record(`teams-obssweep-${tag}`, r.blocked ? 'BLOCKED' : 'DONE', r);
    } catch (e) {
      log(`session ${tag} threw: ${e && e.stack}`);
      results.push({ sessionTag: tag, error: String(e && e.message) });
      record(`teams-obssweep-${tag}`, 'ERROR', { error: String(e && e.message) });
    }
    // Cooldown between sessions so Teams settles.
    await sleep(5_000);
  }
  writeFileSync(join(OBS_DIR, 'sessions-summary.json'), JSON.stringify(results, null, 2));
  log('OBS-SWEEP ALL SESSIONS DONE');
  console.log('TEAMS LIVE SESSION COMPLETE');
  process.exit(0);
}

// ===========================================================================
// PHASE-3 LIVE SCENARIO DRIVERS (gate the PRODUCT binary via MSD_DETECTOR_BIN).
// Each: scripted driver + parser (the pure analyzers above) + one NDJSON verdict
// line in the existing record() idiom. All require MSD_DETECTOR_BIN pointed at the
// product binary — the analyzers key on product-only line formats (teams-keepalive,
// teams-wake, [ringtrace], teams_edge, title-wake). MSD_RING_TRACE=1 surfaces
// [ringtrace] + the teams_edge [event] lines; MSD_EDGE_LOG also unlocks teams_edge.
// The product native meeting KEY is "Microsoft Teams|<bundle>"; isTeamsProd matches
// it (or the sandbox teams:: id) so these run against either binary, but the FORMAT
// asserts only hold for the product.
const TEAMS_PROD_KEY = 'Microsoft Teams|com.microsoft.teams2';

// Require the product binary for a Phase-3 scenario; record FAIL + bail if unset.
function requireProductBin(scenario) {
  if (!process.env.MSD_DETECTOR_BIN) {
    console.error(`[teams-live] ${scenario} REQUIRES MSD_DETECTOR_BIN pointed at the PRODUCT binary`);
    record(scenario, 'FAIL', { reason: 'MSD_DETECTOR_BIN unset (Phase-3 scenarios gate the product binary)' });
    console.log('TEAMS LIVE SESSION COMPLETE');
    process.exit(1);
  }
}

// Bring up host + a speaking web guest against a running detector. Returns
// { chromeGuest, page, meetingUrl } or { blocked:<reason> } (caller records the
// scenario verdict). Reuses hostJoinCall/harvestInCall/joinGuest/guestMicReady
// exactly as the probe/eventqa modes. Guest speech is left OFF (caller drives it).
async function bringUpGuestSession(det, scenario) {
  if (!await hostJoinCall()) return { blocked: 'host could not join a Teams native call' };
  const init = await waitEvent(det, (e) => e.type === 'meeting_initialized' && isTeamsProd(e), 60_000, 'meeting_initialized');
  if (!init) return { blocked: 'no teams meeting_initialized within 60s' };
  const meetingUrl = await harvestInCall();
  if (!meetingUrl) return { blocked: 'no meeting URL (set TEAMS_MEETING_URL)' };
  log('meeting link: ' + meetingUrl);
  let chromeGuest;
  try {
    chromeGuest = await joinGuest(meetingUrl, { override: true });
  } catch (e) { return { blocked: 'guest join threw: ' + (e && e.message) }; }
  await sleep(8_000);
  await pressFirst(['Admit'], 3_000);
  const gj = await waitEvent(det, (e) => e.type === 'participant_joined' && isTeamsProd(e) && e.name === GUEST_NAME, 120_000, 'guest joined');
  if (!gj) { if (chromeGuest && chromeGuest.chrome) chromeGuest.chrome.kill(); return { blocked: 'guest never joined' }; }
  const page = chromeGuest.page;
  let ready = false;
  for (let i = 0; i < 20 && !ready; i++) { ready = await guestMicReady(page); if (!ready) await sleep(500); }
  if (!ready) { if (chromeGuest.chrome) chromeGuest.chrome.kill(); return { blocked: 'fake-mic override never ready' }; }
  return { chromeGuest, page, meetingUrl, initKey: init.meeting_id };
}

// Last emitted meet_walk_stats line (product emits it on MSD_RUN_SECONDS auto-exit
// and periodically). type is "meet_walk_stats" for every platform (shared line).
function lastWalkStats(det) {
  const ws = det.events.filter((e) => e.type === 'meet_walk_stats');
  return ws.length ? ws[ws.length - 1] : null;
}

// ---- Scenario 1: teams-throttle-live ---------------------------------------
async function runThrottleLive() {
  const SC = 'teams-throttle-live';
  requireProductBin(SC);
  mkdirSync(HERE, { recursive: true });
  writeFileSync(RESULTS_NDJSON, '');
  if (!prebuild()) { record(SC, 'FAIL', { reason: 'TeamsDrive missing' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }
  if (!preflightAxTrust()) { record(SC, 'FAIL', { reason: 'Accessibility permission not granted' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }

  const det = startDetector(1800, { MSD_RING_TRACE: '1', MSD_POLL_INTERVAL_MS: '250' });
  let chromeGuest = null;
  try {
    const s = await bringUpGuestSession(det, SC);
    if (s.blocked) { record(SC, 'REVIEW', { reason: s.blocked }); return; }
    chromeGuest = s.chromeGuest; const page = s.page;
    const meetingKey = s.initKey || TEAMS_PROD_KEY;
    // Guest speaking; confirm the ring lights foreground before the throttle.
    await setGuestSpeak(page, true);
    drive('raise');
    await sampleFor(8_000, () => drive('raise'));
    // Minimize with the guest STILL speaking; hold >=120s (no raise — that's the point:
    // the window is backgrounded and WebView2 throttles; keep-alive must hold the key).
    const minimizeTs = Date.now();
    log(`${SC}: minimize + hold 120s (guest still speaking)`);
    drive('minimize');
    await sampleFor(125_000, null);
    const restoreTs = Date.now();
    log(`${SC}: restore`);
    drive('unminimize'); drive('raise');
    await sampleFor(12_000, () => drive('raise'));   // let detection recover
    await setGuestSpeak(page, false);

    const keepalive = parseKeepaliveLines(det.stderrLines);
    const v = analyzeThrottle({
      keepalive, wire: det.wire, ringTrace: det.ringTrace,
      meetingKey, guestName: GUEST_NAME, minimizeTs, restoreTs, recoverMs: 8_000,
    });
    // Blocked infra vs a real assertion failure: if we captured NO ring samples at
    // all in the throttle window the run measured nothing -> REVIEW, never a green PASS.
    const noSamples = det.ringTrace.filter((r) => r.ts >= minimizeTs && r.ts <= restoreTs + 12_000).length === 0;
    record(SC, noSamples ? 'REVIEW' : (v.pass ? 'PASS' : 'FAIL'),
      noSamples ? { reason: 'no ring samples in the throttle window (nothing measured)', ...v }
                : { minimizeTs, restoreTs, throttleMs: restoreTs - minimizeTs, ...v });
    log(`${SC} ${JSON.stringify(v)}`);
  } finally {
    await hostLeaveCall();
    if (chromeGuest && chromeGuest.chrome) chromeGuest.chrome.kill();
    det.kill();
  }
  console.log('TEAMS LIVE SESSION COMPLETE');
  process.exit(0);
}

// ---- Scenario 2: teams-ring-continuity -------------------------------------
async function runRingContinuity() {
  const SC = 'teams-ring-continuity';
  requireProductBin(SC);
  mkdirSync(HERE, { recursive: true });
  writeFileSync(RESULTS_NDJSON, '');
  if (!prebuild()) { record(SC, 'FAIL', { reason: 'TeamsDrive missing' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }
  if (!preflightAxTrust()) { record(SC, 'FAIL', { reason: 'Accessibility permission not granted' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }

  const det = startDetector(1800, { MSD_RING_TRACE: '1', MSD_POLL_INTERVAL_MS: '250' });
  let chromeGuest = null;
  try {
    const s = await bringUpGuestSession(det, SC);
    if (s.blocked) { record(SC, 'REVIEW', { reason: s.blocked }); return; }
    chromeGuest = s.chromeGuest; const page = s.page;
    // CONTINUOUS guest speech across the whole layout sweep (the ring must persist).
    await setGuestSpeak(page, true);
    drive('raise');
    await sampleFor(8_000, () => drive('raise'));   // establish a lit ring first
    const switchStart = Date.now();
    // gallery -> speaker -> gallery via the same driveLayout used by the obs sweep.
    const layoutsUsed = [];
    for (const kind of ['speaker', 'gallery']) {
      const used = await driveLayout(kind);
      layoutsUsed.push({ kind, used });
      await sampleFor(6_000, () => drive('raise'));
    }
    const switchEnd = Date.now();
    await setGuestSpeak(page, false);

    const v = analyzeRingContinuity({
      ringTrace: det.ringTrace, events: det.events, guestName: GUEST_NAME,
      switchStart, switchEnd, maxGapMs: 2500,
    });
    const noSamples = v.samples === 0;
    const anyDriven = layoutsUsed.some((l) => l.used);
    record(SC, noSamples ? 'REVIEW' : (!anyDriven ? 'REVIEW' : (v.pass ? 'PASS' : 'FAIL')),
      noSamples ? { reason: 'no ring samples across the switch window', layoutsUsed, ...v }
      : !anyDriven ? { reason: 'no layout switch was drivable (View menu labels not found) — inconclusive', layoutsUsed, ...v }
      : { switchStart, switchEnd, layoutsUsed, ...v });
    log(`${SC} ${JSON.stringify(v)} layouts=${JSON.stringify(layoutsUsed)}`);
  } finally {
    await hostLeaveCall();
    if (chromeGuest && chromeGuest.chrome) chromeGuest.chrome.kill();
    det.kill();
  }
  console.log('TEAMS LIVE SESSION COMPLETE');
  process.exit(0);
}

// ---- Scenario 3: teams-wake-accel (main + control legs) --------------------
// Runs ONE guest session; within it, two detector legs back-to-back on the same
// call: main (MSD_TEAMS_WAKE default on) then control (MSD_TEAMS_WAKE=0). Both use
// the SAME 6×(5s-on/5s-off) flip script + a >=30s trailing silence window.
async function runWakeAccelLeg(det, page, { silenceSecs = 32 } = {}) {
  const flips = [];
  drive('raise'); await sleep(1000);
  for (let i = 0; i < 6; i++) {
    await setGuestSpeak(page, true);
    flips.push({ i, on: true, ts: Date.now() });
    await sampleFor(5_000, () => drive('raise'));
    await setGuestSpeak(page, false);
    flips.push({ i, on: false, ts: Date.now() });
    await sampleFor(5_000, () => drive('raise'));
  }
  // >=30s silence window: guest stays silent, ring quiet, so NO wake should consume.
  const silenceStart = Date.now();
  await setGuestSpeak(page, false);
  await sampleFor(silenceSecs * 1000, () => drive('raise'));
  const silenceEnd = Date.now();
  return { flips, silenceWindow: { start: silenceStart, end: silenceEnd } };
}

async function runWakeAccel() {
  const SC = 'teams-wake-accel';
  requireProductBin(SC);
  mkdirSync(HERE, { recursive: true });
  writeFileSync(RESULTS_NDJSON, '');
  if (!prebuild()) { record(SC, 'FAIL', { reason: 'TeamsDrive missing' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }
  if (!preflightAxTrust()) { record(SC, 'FAIL', { reason: 'Accessibility permission not granted' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }

  // MAIN leg detector (wake ON by default). Long enough for flips + silence.
  const detMain = startDetector(1800, { MSD_RING_TRACE: '1' });
  let chromeGuest = null;
  let mainResult = null, ctrlResult = null;
  try {
    const s = await bringUpGuestSession(detMain, SC);
    if (s.blocked) { record(SC, 'REVIEW', { reason: s.blocked }); return; }
    chromeGuest = s.chromeGuest; const page = s.page;

    // --- MAIN leg ---
    log(`${SC}: MAIN leg (MSD_TEAMS_WAKE default on)`);
    const mainLeg = await runWakeAccelLeg(detMain, page);
    detMain.kill(); await detMain.done;
    const mainWake = parseWakeLines(detMain.stderrLines);
    mainResult = analyzeWakeAccel({
      wake: mainWake, events: detMain.events, walkStats: lastWalkStats(detMain),
      onsetName: GUEST_NAME, silenceWindow: mainLeg.silenceWindow,
    });

    // --- CONTROL leg (same call still live; fresh detector with the kill switch) ---
    log(`${SC}: CONTROL leg (MSD_TEAMS_WAKE=0)`);
    const detCtrl = startDetector(1800, { MSD_RING_TRACE: '1', MSD_TEAMS_WAKE: '0' });
    try {
      // Re-establish the meeting for the fresh detector, then re-run the same script.
      await waitEvent(detCtrl, (e) => e.type === 'meeting_initialized' && isTeamsProd(e), 60_000, 'ctrl meeting_initialized');
      await waitEvent(detCtrl, (e) => e.type === 'participant_joined' && isTeamsProd(e) && e.name === GUEST_NAME, 60_000, 'ctrl guest');
      await runWakeAccelLeg(detCtrl, page);
    } finally { detCtrl.kill(); await detCtrl.done; }
    const ctrlWake = parseWakeLines(detCtrl.stderrLines);
    ctrlResult = analyzeWakeControl({
      wake: ctrlWake, events: detCtrl.events, walkStats: lastWalkStats(detCtrl), onsetName: GUEST_NAME,
    });

    // ABA-on-flake: if the additive contract legs disagree in a way that reads like a
    // perf regression (main FAILs on the wake path), a reference re-check adjudicates.
    let aba = null;
    let verdict = mainResult.pass && ctrlResult.pass ? 'PASS' : 'FAIL';
    if (verdict === 'FAIL' && process.env.MSD_REFERENCE_BIN) {
      aba = await abaRecheckWakeAccel({ suspectVerdict: verdict });
      if (aba) verdict = aba.verdict;
    }
    record(SC, verdict, { mainLeg: mainResult, controlLeg: ctrlResult, aba });
    log(`${SC} main=${JSON.stringify(mainResult)} control=${JSON.stringify(ctrlResult)} aba=${JSON.stringify(aba)}`);
  } finally {
    await hostLeaveCall();
    if (chromeGuest && chromeGuest.chrome) chromeGuest.chrome.kill();
    detMain.kill();
  }
  console.log('TEAMS LIVE SESSION COMPLETE');
  process.exit(0);
}

// ABA re-check for a FAILed wake-accel run: hold the session, run the SUSPECT binary
// (MSD_DETECTOR_BIN) and the FROZEN reference (MSD_REFERENCE_BIN) back-to-back over a
// short steady window, compare their meet_walk_stats via the pure abaAdjudicate.
// Binary-independent degeneracy (subtree_reads==0 / full_walks==0 on BOTH) →
// ENVIRONMENTAL-RETRY. Requires the reference to exist; otherwise no ABA (null).
async function abaRecheckWakeAccel({ suspectVerdict }) {
  const refBin = process.env.MSD_REFERENCE_BIN;
  if (!refBin || !existsSync(refBin)) { log('ABA: no MSD_REFERENCE_BIN — skipping re-check'); return null; }
  log('ABA: re-checking suspect vs frozen reference back-to-back');
  const steadyWalk = async (bin) => {
    const proc = spawn(bin, [], { env: { ...process.env, MSD_AUTOSTART: '1', MSD_RUN_SECONDS: '25', MSD_RING_TRACE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    await new Promise((res) => proc.on('exit', res));
    let ws = null;
    for (const ln of out.split('\n')) {
      const i = ln.indexOf('{'); if (i < 0 || !ln.includes('[event]')) continue;
      try { const o = JSON.parse(ln.slice(i)); if (o && o.type === 'meet_walk_stats') ws = o; } catch (e) {}
    }
    return ws;
  };
  const suspectStats = await steadyWalk(DETECTOR_BIN);
  const referenceStats = await steadyWalk(refBin);
  return abaAdjudicate({ originalVerdict: suspectVerdict, suspectStats, referenceStats });
}

// ---- Scenario 4: teams-web-cold-start --------------------------------------
// Cold Chrome (full quit) + a Teams WEB meeting tab. Assert a title-wake fires for
// the Chrome pid AND a teams meeting_initialized [event] appears within the budget.
async function runWebColdStart() {
  const SC = 'teams-web-cold-start';
  requireProductBin(SC);
  mkdirSync(HERE, { recursive: true });
  writeFileSync(RESULTS_NDJSON, '');
  if (!prebuild()) { record(SC, 'FAIL', { reason: 'TeamsDrive missing' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }
  if (!preflightAxTrust()) { record(SC, 'FAIL', { reason: 'Accessibility permission not granted' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(1); }

  const meetingUrl = process.env.TEAMS_MEETING_URL;
  if (!meetingUrl) { record(SC, 'REVIEW', { reason: 'TEAMS_MEETING_URL required for the web cold-start (no native harvest without a host session)' }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(0); }

  // COLD Chrome: full quit + verify no Chrome processes before we start.
  log(`${SC}: quitting all Chrome …`);
  spawnSync('osascript', ['-e', 'tell application "Google Chrome" to quit'], { encoding: 'utf8' });
  await sleep(3_000);
  spawnSync('pkill', ['-x', 'Google Chrome'], { encoding: 'utf8' });
  await sleep(2_000);
  const chromeProcs = spawnSync('pgrep', ['-x', 'Google Chrome'], { encoding: 'utf8' }).stdout.trim();
  if (chromeProcs) { record(SC, 'REVIEW', { reason: `Chrome still running after quit (pids ${chromeProcs}) — not a cold start` }); console.log('TEAMS LIVE SESSION COMPLETE'); process.exit(0); }

  // Start the detector FIRST (so the title-wake for the cold Chrome shell is observed
  // from the very first pass), then launch cold Chrome onto the Teams web meeting.
  const det = startDetector(600, { MSD_RING_TRACE: '1' });
  const detectStartTs = Date.now();
  let chromeGuest = null;
  try {
    await sleep(1_500);   // let the detector reach steady poll
    chromeGuest = await joinGuest(meetingUrl, { override: false });
    const chromePids = spawnSync('pgrep', ['-x', 'Google Chrome'], { encoding: 'utf8' })
      .stdout.trim().split('\n').filter(Boolean).map(Number);
    // Wait up to the budget for a teams meeting_initialized [event].
    await waitEvent(det, (e) => e.type === 'meeting_initialized' && e.platform === 'teams', 30_000, 'web teams meeting_initialized');
    await sleep(2_000);

    const titleWakes = parseTitleWakeLines(det.stderrLines);
    // Report against BOTH the Meet-side 3000ms baseline AND whatever the actual
    // latency was (so the Teams-web bar can be tuned) — see the note in the verdict.
    const v = analyzeWebColdStart({ titleWakes, events: det.events, detectStartTs, chromePids, msBudget: 3000 });
    record(SC, v.pass ? 'PASS' : (v.detected ? 'REVIEW' : 'FAIL'), {
      chromePids, ...v,
      note: 'msBudget 3000 is the Meet baseline; detectLatencyMs is the ACTUAL Teams-web number to tune the bar against. detected-but-late => REVIEW (roster-only web detection may be slower than Meet).',
    });
    log(`${SC} ${JSON.stringify(v)}`);
  } finally {
    if (chromeGuest && chromeGuest.chrome) chromeGuest.chrome.kill();
    det.kill();
  }
  console.log('TEAMS LIVE SESSION COMPLETE');
  process.exit(0);
}

// ===========================================================================
async function main() {
  if (process.argv.includes('--obssweep')) return runObsSweep();
  if (process.argv.includes('--observe')) return runObserve();
  if (process.argv.includes('--eventqa')) return runEventQA();
  if (process.argv.includes('--probe')) return runProbe();
  if (process.argv.includes('--throttle')) return runThrottle();
  // Phase-3 product-binary scenarios.
  if (process.argv.includes('--throttle-live')) return runThrottleLive();
  if (process.argv.includes('--ring-continuity')) return runRingContinuity();
  if (process.argv.includes('--wake-accel')) return runWakeAccel();
  if (process.argv.includes('--web-cold-start')) return runWebColdStart();
  if (!process.argv.includes('--all')) {
    console.error('usage: node run-teams-live-qa.mjs --all | --probe | --throttle | --throttle-live | --ring-continuity | --wake-accel | --web-cold-start | --obssweep');
    process.exit(2);
  }
  mkdirSync(HERE, { recursive: true });
  writeFileSync(RESULTS_NDJSON, '');

  const failAll = (reason) => {
    for (const s of ['teams-detect-live', 'teams-selfmute-live', 'teams-layouts-live', 'teams-guest-live']) {
      record(s, 'FAIL', { reason });
    }
    console.log('TEAMS LIVE SESSION COMPLETE');
    process.exit(1);
  };
  if (!prebuild()) failAll('swift build failed');
  if (!preflightAxTrust()) failAll('Accessibility permission not granted');

  // Detector runs the WHOLE session (generous window; killed at the end).
  const det = startDetector(1800);
  let chromeGuest = null;

  try {
    // --- teams-detect-live -------------------------------------------------------
    const joined = await hostJoinCall();
    if (!joined) {
      record('teams-detect-live', 'FAIL', { reason: 'could not join a call via TeamsDrive (Meet tab → Join → Join now)' });
      record('teams-selfmute-live', 'FAIL', { reason: 'no call' });
      record('teams-layouts-live', 'FAIL', { reason: 'no call' });
      record('teams-guest-live', 'FAIL', { reason: 'no call' });
      console.log('TEAMS LIVE SESSION COMPLETE');
      process.exit(1);
    }
    const init = await waitEvent(det, (e) => e.type === 'meeting_initialized' && isTeamsProd(e), 60_000, 'teams meeting_initialized');
    const selfJoin = await waitEvent(det, (e) => e.type === 'participant_joined' && isTeamsProd(e) && e.is_local === true, 60_000, 'local participant');
    const selfNameOk = !!selfJoin && selfJoin.name === EXPECT_SELF;
    record('teams-detect-live', init && selfJoin && selfNameOk ? 'PASS' : 'FAIL', {
      meetingInitialized: !!init, localParticipant: selfJoin ? selfJoin.name : null,
      expectSelf: EXPECT_SELF, selfNameOk, roster: rosterNames(det),
    });

    // --- teams-selfmute-live -----------------------------------------------------
    // Toggle twice so BOTH transitions are asserted (unmuted→muted→unmuted).
    const before = det.events.length;
    const pressedMute = await pressFirst(['Mute mic', 'Mute microphone', 'Mute'], 4_000);
    const mutedEv = await waitEvent(det, (e) => e.type === 'participant_updated' && isTeamsProd(e) && e.name === (selfJoin ? selfJoin.name : EXPECT_SELF) && e.is_muted === true, 25_000, 'self muted');
    const pressedUnmute = await pressFirst(['Unmute mic', 'Unmute microphone', 'Unmute'], 4_000);
    const unmutedEv = await waitEvent(det, (e) => e.type === 'participant_updated' && isTeamsProd(e) && e.name === (selfJoin ? selfJoin.name : EXPECT_SELF) && e.is_muted === false, 25_000, 'self unmuted');
    record('teams-selfmute-live', pressedMute && mutedEv && pressedUnmute && unmutedEv ? 'PASS' : 'FAIL', {
      pressedMute, mutedSeen: !!mutedEv, pressedUnmute, unmutedSeen: !!unmutedEv,
      eventsInWindow: det.events.length - before,
    });

    // --- teams-layouts-live ------------------------------------------------------
    // Roster before the sweep = the truth the sweep must preserve exactly.
    const expectRoster = rosterNames(det);
    const cells = [];
    const layoutMenus = [
      { cell: 'gallery', items: ['Gallery', 'Grid'] },
      { cell: 'speaker', items: ['Speaker', 'Large gallery'] },
      { cell: 'together', items: ['Together mode', 'Together'] },
    ];
    for (const lay of layoutMenus) {
      const opened = await pressFirst(['View'], 1_500);
      const picked = opened ? await pressFirst(lay.items, 4_000) : null;
      await sleep(6_000);
      const roster = rosterNames(det);
      cells.push({ cell: lay.cell, driven: !!picked, picked, rosterExact: JSON.stringify(roster) === JSON.stringify(expectRoster), roster });
      if (opened && !picked) drive('press', 'View'); // close a dangling menu
    }
    for (const size of [[1280, 800], [640, 480]]) {
      const r = drive('resize', String(size[0]), String(size[1]));
      await sleep(6_000);
      const roster = rosterNames(det);
      cells.push({ cell: `resize-${size[0]}x${size[1]}`, driven: r.ok, rosterExact: JSON.stringify(roster) === JSON.stringify(expectRoster), roster });
    }
    drive('resize', '1147', '719');
    const allDriven = cells.every((c) => c.driven);
    const allExact = cells.filter((c) => c.driven).every((c) => c.rosterExact);
    // Undrivable layout = REVIEW (honest), roster drift in a driven cell = FAIL.
    record('teams-layouts-live', !allExact ? 'FAIL' : (allDriven ? 'PASS' : 'REVIEW'), {
      expectRoster, cells,
    });

    // --- teams-guest-live --------------------------------------------------------
    const meetingUrl = process.env.TEAMS_SKIP_GUEST ? null : await harvestInCall();
    log('meeting link: ' + (meetingUrl || '(none)'));
    if (process.env.TEAMS_SKIP_GUEST) {
      record('teams-guest-live', 'REVIEW', { reason: 'TEAMS_SKIP_GUEST=1' });
    } else if (!meetingUrl) {
      record('teams-guest-live', 'REVIEW', { reason: 'no meeting URL (set TEAMS_MEETING_URL or keep a Share-link card on the Meet tab)' });
    } else {
      const rosterBefore = rosterNames(det);
      try {
        chromeGuest = await joinGuest(meetingUrl);
      } catch (e) {
        log('guest join error: ' + e.message);
      }
      // Admit from the native side if a lobby prompt shows.
      await sleep(8_000);
      await pressFirst(['Admit'], 3_000);
      const guestJoin = await waitEvent(det, (e) => e.type === 'participant_joined' && isTeamsProd(e) && e.name === GUEST_NAME, 120_000, 'guest joined');
      const rosterAfter = rosterNames(det);
      const expectAfter = [...rosterBefore, GUEST_NAME].sort();
      const rosterExact = JSON.stringify(rosterAfter) === JSON.stringify(expectAfter);
      // The guest's fake mic emits a constant tone → remote audio; with exactly
      // one unmuted remote the engine must NAME the guest (mute-gate or the
      // "<name> is speaking" note) — never Someone, never the local user.
      let speech = null;
      if (guestJoin) {
        // Product sources are teams.ring / teams.ring.transition (TeamsSpeakerPipeline
        // .swift:202-205); sandbox tokens kept for back-compat with the debug binary.
        speech = await waitEvent(det, (e) => e.type === 'speech_on' && e.name === GUEST_NAME
          && /teams\.(mute_gate|pip|structural|ring)/.test(e.source || ''), 90_000, 'guest speech_on');
      }
      const badSpeech = det.events.filter((e) => e.type === 'speech_on' && e.ts >= (guestJoin ? guestJoin.ts : 0)
        && (e.name === 'Someone' || e.name === EXPECT_SELF)).length;
      record('teams-guest-live', guestJoin && rosterExact && speech && badSpeech === 0 ? 'PASS' : 'FAIL', {
        guestJoined: !!guestJoin, rosterBefore, rosterAfter, rosterExact,
        guestNamed: !!speech, speechSource: speech ? speech.source : null, badSpeechEvents: badSpeech,
      });
    }
  } finally {
    await hostLeaveCall();
    if (chromeGuest && chromeGuest.chrome) chromeGuest.chrome.kill();
    det.kill();
  }

  console.log('TEAMS LIVE SESSION COMPLETE');
  process.exit(0);
}

// Pure analysis helpers exported for the offline unit tests — no live session
// needed to verify the math. probe-analysis.test.mjs covers the first four; the
// Phase-3 helpers are covered by phase3-analysis.test.mjs.
export {
  guestRingFraction, measureLinger, analyzeProbe, measureThrottle,
  // Phase-3 stderr parsers
  parseKeepaliveLines, parseWakeLines, parseTitleWakeLines,
  // Phase-3 ring/edge helpers
  ringLitSamples, firstRingLit, longestDarkGap, teamsEdges, teamsEdgesTo,
  // Phase-3 scenario analyzers
  analyzeThrottle, analyzeRingContinuity, analyzeWakeAccel, analyzeWakeControl,
  analyzeWebColdStart, abaAdjudicate,
};

// Only drive a live session when RUN directly (so a test can import the helpers above
// without spawning Chrome / the detector).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('[teams-live] FATAL', e && e.stack ? e.stack : e);
    console.log('TEAMS LIVE SESSION COMPLETE'); // reader suites fail on missing verdicts
    process.exit(1);
  });
}
