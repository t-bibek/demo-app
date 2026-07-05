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
  const env = { ...process.env, MSD_AUTOSTART: '1', MSD_RUN_SECONDS: String(seconds), ...extraEnv };
  const proc = spawn(DETECTOR_BIN, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = [];
  const ringTrace = [];    // raw per-tick Teams ring dumps (probe only; empty otherwise)
  const teamsTrace = [];   // per-tick window-level trace (throttle spike; empty otherwise)
  let buf = '';
  const onData = (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ln = buf.slice(0, i); buf = buf.slice(i + 1);
      const j = ln.indexOf('{');
      if (j < 0) continue;
      if (ln.includes('[event]')) {
        try { const o = JSON.parse(ln.slice(j)); if (o && o.type) events.push(o); } catch (e) {}
      } else if (ln.includes('[ringtrace]')) {
        try { const o = JSON.parse(ln.slice(j)); if (o) ringTrace.push(o); } catch (e) {}
      } else if (ln.includes('[teamstrace]')) {
        try { const o = JSON.parse(ln.slice(j)); if (o) teamsTrace.push(o); } catch (e) {}
      }
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const done = new Promise((res) => proc.on('exit', res));
  return { proc, events, ringTrace, teamsTrace, done, kill: () => { try { proc.kill('SIGKILL'); } catch (e) {} } };
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
    if (!isTeams(e)) continue;
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
    await waitEvent(det, (e) => e.type === 'meeting_initialized' && isTeams(e), 60_000, 'meeting_initialized');
    const meetingUrl = await harvestInCall();
    if (!meetingUrl) { record('teams-ring-probe', 'REVIEW', { reason: 'no meeting URL (set TEAMS_MEETING_URL)' }); return; }
    log('meeting link: ' + meetingUrl);

    chromeGuest = await joinGuest(meetingUrl, { override: true });
    await sleep(8_000);
    await pressFirst(['Admit'], 3_000);
    const guestJoin = await waitEvent(det, (e) => e.type === 'participant_joined' && isTeams(e) && e.name === GUEST_NAME, 120_000, 'guest joined');
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
async function main() {
  if (process.argv.includes('--obssweep')) return runObsSweep();
  if (process.argv.includes('--observe')) return runObserve();
  if (process.argv.includes('--eventqa')) return runEventQA();
  if (process.argv.includes('--probe')) return runProbe();
  if (process.argv.includes('--throttle')) return runThrottle();
  if (!process.argv.includes('--all')) {
    console.error('usage: node run-teams-live-qa.mjs --all | --probe | --throttle');
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
    const init = await waitEvent(det, (e) => e.type === 'meeting_initialized' && isTeams(e), 60_000, 'teams meeting_initialized');
    const selfJoin = await waitEvent(det, (e) => e.type === 'participant_joined' && isTeams(e) && e.is_local === true, 60_000, 'local participant');
    const selfNameOk = !!selfJoin && selfJoin.name === EXPECT_SELF;
    record('teams-detect-live', init && selfJoin && selfNameOk ? 'PASS' : 'FAIL', {
      meetingInitialized: !!init, localParticipant: selfJoin ? selfJoin.name : null,
      expectSelf: EXPECT_SELF, selfNameOk, roster: rosterNames(det),
    });

    // --- teams-selfmute-live -----------------------------------------------------
    // Toggle twice so BOTH transitions are asserted (unmuted→muted→unmuted).
    const before = det.events.length;
    const pressedMute = await pressFirst(['Mute mic', 'Mute microphone', 'Mute'], 4_000);
    const mutedEv = await waitEvent(det, (e) => e.type === 'participant_updated' && isTeams(e) && e.name === (selfJoin ? selfJoin.name : EXPECT_SELF) && e.is_muted === true, 25_000, 'self muted');
    const pressedUnmute = await pressFirst(['Unmute mic', 'Unmute microphone', 'Unmute'], 4_000);
    const unmutedEv = await waitEvent(det, (e) => e.type === 'participant_updated' && isTeams(e) && e.name === (selfJoin ? selfJoin.name : EXPECT_SELF) && e.is_muted === false, 25_000, 'self unmuted');
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
      const guestJoin = await waitEvent(det, (e) => e.type === 'participant_joined' && isTeams(e) && e.name === GUEST_NAME, 120_000, 'guest joined');
      const rosterAfter = rosterNames(det);
      const expectAfter = [...rosterBefore, GUEST_NAME].sort();
      const rosterExact = JSON.stringify(rosterAfter) === JSON.stringify(expectAfter);
      // The guest's fake mic emits a constant tone → remote audio; with exactly
      // one unmuted remote the engine must NAME the guest (mute-gate or the
      // "<name> is speaking" note) — never Someone, never the local user.
      let speech = null;
      if (guestJoin) {
        speech = await waitEvent(det, (e) => e.type === 'speech_on' && e.name === GUEST_NAME
          && /teams\.(mute_gate|pip|structural)/.test(e.source || ''), 90_000, 'guest speech_on');
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

// Pure analysis helpers exported for the offline unit test
// (qa/teams-live/probe-analysis.test.mjs) — no live session needed to verify the math.
export { guestRingFraction, measureLinger, analyzeProbe, measureThrottle };

// Only drive a live session when RUN directly (so a test can import the helpers above
// without spawning Chrome / the detector).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('[teams-live] FATAL', e && e.stack ? e.stack : e);
    console.log('TEAMS LIVE SESSION COMPLETE'); // reader suites fail on missing verdicts
    process.exit(1);
  });
}
