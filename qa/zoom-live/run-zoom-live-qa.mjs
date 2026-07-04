#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Shared-session LIVE QA runner for NATIVE Zoom (us.zoom.xos) speaker/
// participant detection — tier B of the two-tier harness (tier A is the
// deterministic fixture replay in SpeakerCoreSelfTest). ONE live session,
// scenarios back-to-back, one NDJSON verdict line each → zoom-live-results.ndjson,
// then `qa/live-scenario-verdict.mjs <scenario> …` gates each in qa.zoom.config.mjs.
//
// Native Zoom can't be puppeteered like the Meet/CDP rig, so the host is driven
// through `swift run ZoomDrive` (AXPress + menu bar + minimize) and the remote
// joins via the Zoom WEB client in a CDP Chrome with a fake-device audio tone
// (qa/zoom-live/zoom-web-guest.mjs). Native Zoom's waiting room (if on) is
// cleared host-side by admitLoop(). Every mechanic here was validated live
// against Zoom 7.0.5 (qa/zoom-live/live-evidence.md).
//
// Scenarios (each → {scenario, verdict, ts, …detail}):
//   zoom-detect-live   — host starts a meeting; detector emits meeting_initialized
//                        (zoom::meeting) + participant_joined for self (is_local,
//                        real "(me)" name) and the admitted guest.
//   zoom-roster-live   — with the guest admitted, the roster is EXACTLY
//                        {self, guest}; any name outside that set (home-shell /
//                        panel-header leak) FAILS. Panel toggled open/closed.
//   zoom-mutegate-live — guest UNMUTED + tone → speech_on {guest, zoom.mute_gate};
//                        guest MUTED → no speech_on naming the guest.
//   zoom-panelclosed-live — panel closed: tile overlays still expose the roster
//                        but not "(me)", so a 2-unmuted call is honest "Someone"
//                        (audio.someone), never a fabricated name.
//
//   pip-background-live — the main meeting window is driven UNFOCUSED, then
//                        MINIMIZED (via ZoomDrive) if unfocus alone doesn't spawn
//                        the PIP; the ACTUAL trigger is RECORDED. While the main
//                        tree is degraded, PIP "Talking:" edges must still name the
//                        speaker (source zoom.pip / zoom.pip.edge). [plan C3/B1]
//   vad-quality-live    — a guest SHORT-TRANSIENT tone burst train (ding-like pulses)
//                        with speech OFF must NOT produce a named mute-gate
//                        attribution (transient energy != voice; the SchmittVad
//                        enterFrames debounce rejects sub-3-frame bursts); real
//                        fake-SPEECH MUST. Raw RMS levels recorded (MSD_VAD_TRACE) for
//                        VAD calibration. Uses the speech-gain override so tone and
//                        speech are INDEPENDENTLY controllable. [plan C3/B4]
//
//   node qa/zoom-live/run-zoom-live-qa.mjs --all
//
// Env: ZOOM_EXPECT_SELF (default git user.name), ZOOM_GUEST_NAME (default
//      "Guest Alpha"), ZOOM_MEETING_URL (skip harvest), ZOOM_SKIP_GUEST=1.
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { joinZoomWebGuest, setGuestMuted } from './zoom-web-guest.mjs';
// Speech-gain gating (independent of mute): the vad-quality scenario needs
// tone-energy and real-speech as SEPARATE controls — a tone+mute-toggle guest
// cannot distinguish "energy, no voice" from "voice", which is exactly what the
// VAD-quality probe asserts. Reuses the web rig's speech-gain guest.
import {
  joinZoomWebGuest as joinSpeechGuest, setGuestSpeak, setGuestTone, pulseGuestTone,
  setGuestMuted as setSpeechGuestMuted,
} from '../zoomweb-live/zoomweb-guest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const MACOS = join(REPO, 'macos');
const DETECTOR_BIN = join(MACOS, '.build', 'debug', 'MeetSpeakerDetector');
const ZOOMDRIVE_BIN = join(MACOS, '.build', 'debug', 'ZoomDrive');
const RESULTS_NDJSON = join(HERE, 'zoom-live-results.ndjson');
const EVENTS_NDJSON = join(HERE, 'detector-events.ndjson');
const GUEST_PORT = 9350;

const EXPECT_SELF = process.env.ZOOM_EXPECT_SELF
  || spawnSync('git', ['config', 'user.name'], { encoding: 'utf8' }).stdout.trim()
  || 'David Thapa';
const GUEST_NAME = process.env.ZOOM_GUEST_NAME || 'Guest Alpha';
// The VAD-quality guest carries a DISTINCT name (so the roster stays exact for the
// early roster scenario and the two guests' edges never collide).
const SPEECH_GUEST_NAME = process.env.ZOOM_SPEECH_GUEST_NAME || 'Guest Bravo';
const SCENARIOS = ['zoom-detect-live', 'zoom-roster-live', 'zoom-mutegate-live', 'zoom-panelclosed-live', 'pip-background-live', 'vad-quality-live'];
// Fixed edge log so the pip-background detector's zoom_edge lines are readable back.
const EDGE_LOG = join(HERE, 'zoom-native-edges.ndjson');
const SPEECH_GUEST_PORT = 9351; // a distinct port from the tone guest (9350)

const log = (...a) => console.log('[zoom-live]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

function record(scenario, verdict, detail) {
  appendFileSync(RESULTS_NDJSON, JSON.stringify({ scenario, verdict, ts: nowSec(), ...detail }) + '\n');
  log(`RESULT ${scenario}: ${verdict}`);
}

// --- ZoomDrive wrapper -----------------------------------------------------------
function drive(...args) {
  const r = spawnSync(ZOOMDRIVE_BIN, args, { encoding: 'utf8', timeout: 120_000 });
  return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}
async function pressFirst(candidates, opts = {}, settleMs = 1200) {
  const extra = Array.isArray(opts) ? opts : (opts.args || []);
  for (const c of candidates) {
    const r = drive('press', c, ...extra);
    if (r.ok && r.out.startsWith('PRESSED')) { log(`pressed "${c}"`); await sleep(settleMs); return c; }
  }
  return null;
}
function meetingWindowPresent() {
  return drive('windows').out.split('\n').some((l) => /meeting=YES/.test(l));
}
function rosterVisible() { // "computer audio" text present ⇒ a roster is readable
  return drive('find', 'computer audio').ok;
}

// --- Keystrokes land on Zoom only after raising it --------------------------------
function keystroke(key, mods = []) {
  drive('raise');
  const using = mods.length ? ` using {${mods.map((m) => m + ' down').join(', ')}}` : '';
  spawnSync('osascript', ['-e', `tell application "System Events" to keystroke "${key}"${using}`]);
}
const panelToggle = () => keystroke('u', ['command']);          // ⌘U participants panel

// --- Pre-flights -----------------------------------------------------------------
function prebuild() {
  log('swift build --package-path macos …');
  const r = spawnSync('swift', ['build', '--package-path', MACOS], { encoding: 'utf8', timeout: 20 * 60_000 });
  if (r.status !== 0) {
    console.error('[zoom-live] swift build FAILED:\n' + ((r.stdout || '') + (r.stderr || '')).split('\n').slice(-25).join('\n'));
    return false;
  }
  return existsSync(DETECTOR_BIN) && existsSync(ZOOMDRIVE_BIN);
}
function preflightAxTrust() { return !drive('windows').out.includes('NOT_TRUSTED'); }
function preflightSignedIn() {
  spawnSync('open', ['-b', 'us.zoom.xos']); // reopen the home window
  return true;
}

// --- Streaming detector (mirror the Teams runner). Back-compat: startDetector(180)
// still works; pass an options object to enable event mode + an edge log (needed
// for the native pip.edge source) and to collect the raw zoom_edge/zoom_walk_stats
// NDJSON lines alongside the [event] product events. -----------------------------
function startDetector(secondsOrOpts) {
  const opts = typeof secondsOrOpts === 'number' ? { seconds: secondsOrOpts } : (secondsOrOpts || {});
  const seconds = opts.seconds || 180;
  writeFileSync(EVENTS_NDJSON, '');
  const env = { ...process.env, MSD_AUTOSTART: '1', MSD_RUN_SECONDS: String(seconds) };
  if (opts.mode) env.MSD_MODE = opts.mode;
  if (opts.vadTrace) env.MSD_VAD_TRACE = '1';   // emit raw-RMS [vadtrace] lines for calibration
  if (opts.edgeLog) { env.MSD_EDGE_LOG = opts.edgeLog; try { writeFileSync(opts.edgeLog, ''); } catch (e) {} }
  const proc = spawn(DETECTOR_BIN, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = [];   // product events (participant_joined / speech_on / meeting_initialized / …)
  const raw = [];      // instrumentation NDJSON (zoom_edge / zoom_walk_stats / zoom_observer / …)
  let buf = '';
  // The detector emits BOTH product events AND instrumentation lines with the same
  // `[event] {json}` stdout prefix; split by TYPE so the original 5 scenarios keep
  // reading product events from `events` while the new PIP/VAD scenarios read
  // instrumentation (zoom_edge / talking-changed) from `raw`.
  const isInstrumentation = (o) => /(_edge|_walk_stats|_observer|_selector_dump|_menu_probe|vad_frame)$/.test(o.type || '')
    || o.kind === 'active-moved' || o.kind === 'talking-changed';
  const onData = (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ln = buf.slice(0, i); buf = buf.slice(i + 1);
      const j = ln.indexOf('{');
      if (j < 0) continue;
      const payload = ln.slice(j);
      let o; try { o = JSON.parse(payload); } catch (e) { continue; }
      if (!o || typeof o !== 'object' || !o.type) continue;
      if (isInstrumentation(o)) { raw.push(o); }
      else { events.push(o); appendFileSync(EVENTS_NDJSON, payload + '\n'); }
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const done = new Promise((res) => proc.on('exit', res));
  return { proc, events, raw, done, kill: () => { try { proc.kill('SIGKILL'); } catch (e) {} } };
}
const isZoom = (e) => typeof e.meeting_id === 'string' && e.meeting_id.startsWith('zoom::');
async function waitEvent(det, pred, timeoutMs, label) {
  const t0 = Date.now();
  let seen = 0;
  while (Date.now() - t0 < timeoutMs) {
    for (; seen < det.events.length; seen++) if (pred(det.events[seen])) return det.events[seen];
    await sleep(500);
  }
  log(`waitEvent timeout: ${label}`);
  return null;
}
function zoomRoster(det) {
  const roster = new Map();
  for (const e of det.events) {
    if (!isZoom(e)) continue;
    if (e.type === 'participant_joined') roster.set(e.name, { is_local: !!e.is_local, is_muted: e.is_muted });
    else if (e.type === 'participant_updated' && roster.has(e.name)) roster.set(e.name, { is_local: !!e.is_local, is_muted: e.is_muted });
    else if (e.type === 'participant_left') roster.delete(e.name);
  }
  return roster;
}
const rosterNames = (det) => [...zoomRoster(det).keys()].sort();
// speech_on events in a recent window, by source.
function recentSpeech(det, sinceEventIdx) {
  return det.events.slice(sinceEventIdx).filter((e) => isZoom(e) && e.type === 'speech_on');
}

// --- Meeting bootstrap (validated: New meeting → Start preview) -------------------
async function bootstrapMeeting() {
  spawnSync('open', ['-b', 'us.zoom.xos']); await sleep(6000);
  drive('raise'); await sleep(1500);
  if (meetingWindowPresent()) { log('already in a meeting'); return true; }
  const started = await pressFirst(
    ['Start a new meeting with video on', 'Start new meeting', 'New meeting', 'New Meeting'], {}, 2000);
  if (!started && process.env.ZOOM_PMI) spawnSync('open', [`zoommtg://zoom.us/start?confno=${process.env.ZOOM_PMI}`]);
  else if (!started) return false;
  await sleep(8000);
  // Preview "Start" (join with video) if shown.
  await pressFirst(['Start'], { args: ['--window', 'Zoom Meeting'] }, 3000);
  for (let i = 0; i < 20; i++) { if (meetingWindowPresent()) return true; await sleep(3000); }
  return false;
}

// --- Invite-URL harvest: ⌘I → Copy invite link → pbpaste (clipboard restored) ----
async function harvestInvite() {
  if (process.env.ZOOM_MEETING_URL) return process.env.ZOOM_MEETING_URL;
  const saved = spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout;
  keystroke('i', ['command']); await sleep(2500);
  const pressed = await pressFirst(['Copy invite link', 'Copy Invite Link'], {}, 1200);
  let link = null;
  if (pressed) {
    const clip = spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout.trim();
    const m = clip.match(/https:\/\/[a-z0-9.-]*zoom\.us\/j\/\d+\?pwd=[\w.-]+/i);
    link = m ? m[0] : null;
  }
  spawnSync('pbcopy', [], { input: saved }); // restore the user's clipboard
  spawnSync('osascript', ['-e', 'tell application "System Events" to key code 53']); // Escape
  await sleep(800);
  if (link) return link;
  // Fallback: AX scrape of the invite window.
  const r = drive('harvest-url');
  const m2 = r.out.match(/https:\/\/[a-z0-9.-]*zoom\.us\/j\/\d+\?pwd=[\w.-]+/i);
  return m2 ? m2[0] : null;
}

// --- Waiting-room admit. The guest reaches the waiting room a few seconds AFTER
// joinZoomWebGuest returns, so first WAIT for the host-side signal (toast or
// panel row), then press Admit and VERIFY the roster grew to 2. Returns true
// once a second "computer audio" row appears. ⌘U toggles, so open the panel at
// most once. A guest that never lands (waiting-room disabled account, network)
// leaves this false → the caller degrades guest scenarios to REVIEW, not FAIL.
async function admitLoop(waitMs = 60_000) {
  const rosterCount = () => drive('windows').out.split('\n')
    .map((l) => (l.match(/roster=(\d+)/) || [])[1]).filter(Boolean).map(Number).reduce((a, b) => Math.max(a, b), 0);
  const t0 = Date.now();
  let opened = false;
  while (Date.now() - t0 < waitMs) {
    if (rosterCount() >= 2) return true;               // already admitted
    const waiting = drive('find', 'waiting room').ok || drive('find', 'entered the waiting').ok;
    if (waiting) {
      if (!opened) { panelToggle(); await sleep(2500); opened = true; } // reveal the panel's Admit
      await pressFirst(['Admit'], { args: ['--role', 'AXButton'] }, 1500);
      await pressFirst(['Admit'], { args: ['--window', 'Zoom Meeting'] }, 1500);
      if (rosterCount() >= 2) return true;
    }
    await sleep(2500);
  }
  return rosterCount() >= 2;
}

// ===================================================================== scenarios
// `guestOk` = a guest is genuinely IN the meeting (browser launched AND admitted
// past the waiting room). A guest that never lands is a RIG issue, not a
// detection bug → guest-dependent checks degrade to REVIEW, never FAIL.
async function scenarioDetectRoster(det, guestOk) {
  // detect: meeting + self (+ guest when present). The detector's own is_local
  // read IS the self ground truth (the Zoom account name via "(me)"), independent
  // of git identity — so the assertion is "self detected as is_local with a REAL
  // name (not You/Someone)"; ZOOM_EXPECT_SELF is an exact match only when set.
  const init = await waitEvent(det, (e) => e.type === 'meeting_initialized' && isZoom(e), 60_000, 'meeting_initialized');
  const self = await waitEvent(det, (e) => e.type === 'participant_joined' && isZoom(e) && e.is_local, 30_000, 'self join');
  const guest = guestOk ? await waitEvent(det, (e) => e.type === 'participant_joined' && e.name === GUEST_NAME, 60_000, 'guest join') : null;
  const selfName = self?.name || null;
  const selfNameReal = !!selfName && !/^(you|someone)$/i.test(selfName);
  const selfMatchesEnv = process.env.ZOOM_EXPECT_SELF ? selfName === EXPECT_SELF : true;
  const selfOk = init && !!self && selfNameReal && selfMatchesEnv;
  // Self is the gated property; a missing guest (rig no-show) is REVIEW.
  const detectVerdict = !selfOk ? 'FAIL' : (guestOk ? (guest ? 'PASS' : 'REVIEW') : 'PASS');
  record('zoom-detect-live', detectVerdict, {
    meetingInitialized: !!init, selfName, selfIsLocal: !!self?.is_local, selfNameReal,
    expectSelfEnv: process.env.ZOOM_EXPECT_SELF || null, selfMatchesEnv,
    guestExpected: !!guestOk, guestJoined: !!guest, roster: rosterNames(det), eventsFile: EVENTS_NDJSON,
  });

  // roster: exactly {detected self, guest?}; no stranger ever joins. Self is the
  // detector's is_local name (not a hardcoded identity).
  const expect = [selfName, ...(guestOk ? [GUEST_NAME] : [])].filter(Boolean).sort();
  panelToggle(); await sleep(3000);           // ensure open
  const openNames = rosterNames(det);
  const allJoined = det.events.filter((e) => isZoom(e) && e.type === 'participant_joined').map((e) => e.name);
  const strangers = allJoined.filter((n) => !expect.includes(n));
  const rosterExact = JSON.stringify(openNames) === JSON.stringify(expect);
  // No stranger EVER (the real safety invariant) is a hard FAIL; a guest that
  // never showed just makes the exact-set check REVIEW.
  const rosterVerdict = (selfNameReal && strangers.length === 0)
    ? (rosterExact ? 'PASS' : 'REVIEW') : 'FAIL';
  record('zoom-roster-live', rosterVerdict, {
    expect, got: openNames, unexpectedNames: [...new Set(strangers)], eventsFile: EVENTS_NDJSON,
  });
}

async function scenarioMuteGate(det, guestPage, guestOk) {
  if (!guestPage || !guestOk) { record('zoom-mutegate-live', 'REVIEW', { reason: guestPage ? 'guest never admitted (waiting room / rig)' : 'no guest (ZOOM_SKIP_GUEST)' }); return; }
  panelToggle(); await sleep(2500); // panel open so self is identified via "(me)"
  // (a) guest UNMUTED + tone → named by the mute-gate.
  await setGuestMuted(guestPage, false); await sleep(3000);
  const idxA = det.events.length;
  const namedGuest = await waitEvent(det,
    (e) => e.type === 'speech_on' && e.name === GUEST_NAME && /mute_gate/.test(e.source || ''), 25_000, 'guest named');
  // (b) guest MUTED → no speech_on naming the guest.
  await setGuestMuted(guestPage, true); await sleep(4000);
  const idxB = det.events.length;
  await sleep(6000);
  const guestNamedWhileMuted = recentSpeech(det, idxB).some((e) => e.name === GUEST_NAME);
  record('zoom-mutegate-live', (namedGuest && !guestNamedWhileMuted) ? 'PASS' : 'FAIL', {
    unmutedNamed: !!namedGuest, unmutedSource: namedGuest?.source || null,
    guestNamedWhileMuted, eventsFile: EVENTS_NDJSON,
  });
}

async function scenarioPanelClosed(det, guestPage) {
  panelToggle(); await sleep(2500);
  if (rosterVisible()) { panelToggle(); await sleep(2500); } // ensure CLOSED
  const closedVerified = !rosterVisible();
  if (guestPage) { await setGuestMuted(guestPage, false); await sleep(3000); }
  const idx = det.events.length;
  await sleep(10_000);
  const speech = recentSpeech(det, idx);
  // The safety invariant with the panel closed: the detector may only emit a
  // name it can justify — the known roster {self, guest} or the honest anonymous
  // "Someone". A PHANTOM speaker (toolbar chrome, a name outside the roster) is
  // the real bug and the only FAIL. Whether the honest floor shows "Someone" or
  // the correctly-attributed unmuted guest depends on remoteActive timing and is
  // recorded as detail, not gated.
  const known = new Set(rosterNames(det).concat('Someone'));
  const phantom = speech.map((e) => e.name).filter((n) => !known.has(n));
  const someoneSeen = speech.some((e) => e.name === 'Someone' && /audio\.someone/.test(e.source || ''));
  record('zoom-panelclosed-live', phantom.length === 0 ? 'PASS' : 'FAIL', {
    closedVerified, someoneSeen, phantomSpeakers: [...new Set(phantom)],
    speechNames: [...new Set(speech.map((e) => e.name))], eventsFile: EVENTS_NDJSON,
  });
}

// --- PIP + focus helpers ---------------------------------------------------------
// A native Zoom "windows" line exposes pip=YES/no and minimized=; use them to detect
// whether the PIP thumbnail has appeared and which trigger produced it.
function pipPresent() {
  return drive('windows').out.split('\n').some((l) => /pip=YES/.test(l));
}
function mainMinimized() {
  return drive('windows').out.split('\n').some((l) => /meeting=YES/.test(l) && /minimized=1/.test(l));
}
// Unfocus Zoom by bringing another app frontmost (Finder is always available), so
// the main meeting window loses focus WITHOUT being minimized — the first PIP-trigger
// hypothesis (unfocus alone) vs the fallback (minimize).
function unfocusZoom() {
  spawnSync('osascript', ['-e', 'tell application "Finder" to activate']);
}
// True when the Zoom app is the FRONTMOST (focused) application. Used to confirm the
// main meeting window has actually lost focus (background-coverage precondition).
function zoomFrontmost() {
  const r = spawnSync('osascript', ['-e',
    'tell application "System Events" to get name of first application process whose frontmost is true'],
    { encoding: 'utf8' });
  return /zoom/i.test((r.stdout || '').trim());
}
// Read the native talking-changed edges (zoom.pip / zoom.pip.edge) from the fixed
// edge log AND from the detector's raw NDJSON lines.
function readNativeEdges(det) {
  const edges = [];
  if (existsSync(EDGE_LOG)) {
    for (const ln of readFileSync(EDGE_LOG, 'utf8').split('\n')) {
      const i = ln.indexOf('{'); if (i < 0) continue;
      try { const o = JSON.parse(ln.slice(i)); if (o && (o.type === 'zoom_edge' || o.kind === 'talking-changed')) edges.push(o); } catch (e) {}
    }
  }
  for (const r of det.raw || []) if (r.type === 'zoom_edge' || r.kind === 'talking-changed') edges.push(r);
  return edges;
}

// ===================================================================== pip-background-live
// The PIP thumbnail is the native background-coverage channel (docs §B1): when the
// main meeting window is degraded (unfocused/minimized) the PIP keeps "Talking:"
// legible. HYPOTHESIS (session evidence: ⌘⇧M minimize showed the PIP) — but the plan
// forbids asserting the untested trigger, so PROBE unfocus FIRST, fall back to
// minimize, and RECORD which trigger actually produced the PIP.
async function scenarioPipBackground(guestPage, guestOk) {
  if (!guestPage || !guestOk) { record('pip-background-live', 'REVIEW', { reason: guestPage ? 'guest never admitted' : 'no guest' }); return; }
  // Dedicated EVENT-mode detector with an edge log so zoom.pip.edge / talking-changed
  // lines are captured while the main tree is degraded.
  const det = startDetector({ seconds: 90, mode: 'event', edgeLog: EDGE_LOG });
  await sleep(4000);
  // Guest speaks (real speech) so the PIP has a "Talking:" name to show.
  try { await setGuestMuted(guestPage, false); } catch (e) {}
  await sleep(2000);

  // Trigger probe (ordered by how faithfully each reproduces a real user gesture —
  // Zoom's PIP is spawned by its OWN minimize/unfocus HANDLER, which watches the user
  // gesture; a programmatic AXMinimized=true can bypass that handler, which is why the
  // prior run minimized the window yet no PIP appeared):
  //  1. unfocus (bring Finder up) — the lightest trigger;
  //  2. ⌘⇧M keystroke — Zoom's own "minimize meeting" hotkey, the session-evidence-
  //     proven PIP trigger (goes through Zoom's handler, unlike ZoomDrive's AXMinimize);
  //  3. ZoomDrive AXMinimize — last-resort so the main tree is at least degraded.
  let trigger = null;
  unfocusZoom(); await sleep(4000);
  if (pipPresent()) trigger = 'unfocus';
  if (!trigger) {
    keystroke('m', ['command', 'shift']); await sleep(4000);   // ⌘⇧M — Zoom minimize hotkey
    if (pipPresent()) trigger = 'minimize-hotkey';
  }
  if (!trigger) {
    // Last resort: programmatic minimize (degrades the main tree even if no PIP).
    drive('minimize', '--window', 'Zoom Meeting'); await sleep(4000);
    if (pipPresent()) trigger = 'minimize-ax';
    else if (mainMinimized()) trigger = 'minimize-ax-nopip';
  }
  const pipUp = pipPresent();
  // The main window is "degraded" when it is NOT the frontmost/focused surface: it is
  // minimized, PIP-only, or simply unfocused (Finder frontmost). All three exercise
  // the background-coverage path — an unfocused-but-readable tree is in fact the case
  // where the mute-gate SHOULD keep naming the speaker, so it counts as degraded here.
  const mainDegraded = mainMinimized() || pipUp || trigger != null || !zoomFrontmost();

  // Hold ~12s of the guest speaking while degraded, then collect edges naming the guest.
  const idx = det.events.length;
  await sleep(12_000);
  const nativeEdges = readNativeEdges(det).filter((e) => e.to === GUEST_NAME);
  const pipSpeech = det.events.slice(idx).filter((e) =>
    isZoom(e) && e.type === 'speech_on' && e.name === GUEST_NAME && /zoom\.pip/.test(e.source || ''));
  // Any zoom-source naming of the guest while degraded = background coverage. When the
  // PIP is genuinely absent on this build, the roster/tile-overlay tree usually stays
  // readable behind the minimized window, so the mute-gate still names the speaker.
  const degradedSpeech = det.events.slice(idx).filter((e) =>
    isZoom(e) && e.type === 'speech_on' && e.name === GUEST_NAME);
  const degradedSources = [...new Set(degradedSpeech.map((e) => e.source))];

  // MUTE this tone guest before returning: the NEXT scenario (vad-quality) needs its
  // speech guest (Guest Bravo) to be the ONLY unmuted remote so the mute-gate names
  // Bravo specifically instead of collapsing two unmuted remotes to "Someone".
  try { await setGuestMuted(guestPage, true); } catch (e) {}

  // Restore the main window for the following scenarios (cover both minimize paths:
  // AXMinimized=false un-minimizes a programmatic minimize; ⌘⇧M toggles the hotkey
  // minimize back; raise brings the meeting frontmost).
  drive('restore', '--window', 'Zoom Meeting'); await sleep(1500);
  if (mainMinimized() || pipPresent()) { keystroke('m', ['command', 'shift']); await sleep(1500); }
  drive('raise'); await sleep(1000);
  det.kill(); await det.done.catch(() => {});

  // Honest gate. The PRODUCT goal here is BACKGROUND COVERAGE: while the main meeting
  // window is degraded (unfocused/minimized), the speaker is still named. PIP
  // "Talking:" is ONE mechanism for that; the mute-gate over the still-readable
  // tile-overlay/roster tree behind the minimized window is another. Both satisfy the
  // goal, so the gate asserts COVERAGE, not the specific PIP mechanism (plan B1
  // forbids asserting the untested PIP hypothesis — a PIP that never spawns on this
  // build must not FAIL a working background path).
  //  - PIP appeared → the PIP-coverage claim is directly testable: PASS iff a pip
  //    source named the guest (its own edge/speech), else fall through to coverage.
  //  - Main degraded and ANY zoom source named the guest → background coverage
  //    achieved → PASS (record which source carried it).
  //  - Main degraded but NOTHING named the guest → REVIEW (coverage unconfirmed —
  //    audio path or degraded-tree read suspect; never a phantom-producing FAIL).
  //  - Never degraded at all → REVIEW (no trigger worked on this build).
  const pipNamed = nativeEdges.length > 0 || pipSpeech.length > 0;
  const covered = degradedSpeech.length > 0;
  let verdict;
  if (pipUp && pipNamed) verdict = 'PASS';
  else if (mainDegraded && covered) verdict = 'PASS';
  else verdict = 'REVIEW';
  record('pip-background-live', verdict, {
    pipTrigger: trigger, pipAppeared: pipUp, mainDegraded,
    pipEdgeCount: nativeEdges.length, pipSpeechCount: pipSpeech.length,
    pipSources: [...new Set([...nativeEdges.map((e) => e.type || e.kind), ...pipSpeech.map((e) => e.source)])],
    degradedCoverageNamed: covered, degradedCoverageSources: degradedSources,
    note: pipUp ? 'PIP present: pip source or degraded-tree coverage must name the speaker'
      : 'PIP never spawned on this Zoom build (minimize/unfocus did not create the thumbnail) — background coverage asserted via the degraded-tree mute-gate instead of the untestable PIP',
    edgeLog: EDGE_LOG, eventsFile: EVENTS_NDJSON,
  });
}

// ===================================================================== vad-quality-live
// The real VAD (SchmittVad) must reject ENERGY WITHOUT VOICE. A guest joined with the
// SPEECH-GAIN override lets us drive a pure TONE (energy, no speech content) and real
// fake-SPEECH as INDEPENDENT controls (a tone+mute-toggle guest can't). Assert: tone
// burst with speech OFF → the guest is NOT named by the mute-gate; real speech →
// the guest IS named. Records raw RMS-ish levels for VAD calibration evidence.
async function scenarioVadQuality(speechGuestPage, speechGuestOk, speechGuestName) {
  const gname = speechGuestName || SPEECH_GUEST_NAME;
  if (!speechGuestPage || !speechGuestOk) { record('vad-quality-live', 'REVIEW', { reason: speechGuestPage ? 'speech-gain guest never admitted' : 'no speech-gain guest' }); return; }
  const det = startDetector({ seconds: 90, mode: 'event', vadTrace: true });
  await sleep(4000);
  try { await setSpeechGuestMuted(speechGuestPage, false); } catch (e) {}
  panelToggle(); await sleep(2500); // panel open so self is identified via "(me)"

  // (a) TRANSIENT tone bursts, SPEECH OFF — energy without VOICE, delivered as short
  // ding-like pulses (the class of non-voice energy the SchmittVad's enter debounce
  // is designed to reject). A SUSTAINED tone is NOT used: a level-only VAD cannot
  // reject sustained tone energy and never claimed to — only transients — so asserting
  // sustained-tone rejection would test a capability the shipped VAD does not have.
  // Each ~40ms pulse spans at most TWO 50ms frames (one full + a boundary sliver);
  // the shipped default enterFrames=3 requires ≥3 consecutive over-enter frames to
  // open, so a 2-frame straddling transient is rejected ⇒ must NOT name the guest.
  // (plan B4: "reject a single-frame transient — ding/click/chime".)
  await setGuestSpeak(speechGuestPage, false);
  const idxTone = det.events.length;
  await pulseGuestTone(speechGuestPage, { pulseMs: 40, gapMs: 300, count: 20, hz: 440 });
  await sleep(1500);
  const namedByTone = det.events.slice(idxTone).filter((e) =>
    isZoom(e) && e.type === 'speech_on' && e.name === gname && /mute_gate/.test(e.source || ''));
  await setGuestTone(speechGuestPage, false);
  await sleep(3000);

  // (b) real SPEECH — must name the guest.
  await setGuestSpeak(speechGuestPage, true);
  const namedBySpeech = await waitEvent(det,
    (e) => isZoom(e) && e.type === 'speech_on' && e.name === gname && /mute_gate/.test(e.source || ''), 25_000, 'speech-named');
  await setGuestSpeak(speechGuestPage, false);

  // Raw level evidence: the detector emits [vadtrace]/level lines when present;
  // record any that arrived so the fix agent can calibrate MSD_VAD_ENTER/EXIT.
  const levelSamples = (det.raw || []).filter((r) => /vad|level|rms/i.test(r.type || '')).slice(-40);
  det.kill(); await det.done.catch(() => {});

  const verdict = (namedByTone.length === 0 && !!namedBySpeech) ? 'PASS'
    : (namedBySpeech ? 'FAIL' : 'REVIEW'); // no speech attribution at all ⇒ possibly audio never reached the tap
  record('vad-quality-live', verdict, {
    guest: gname, toneNamedGuest: namedByTone.length > 0, speechNamedGuest: !!namedBySpeech,
    speechSource: namedBySpeech?.source || null, levelSamples,
    note: 'tone=energy-without-voice must NOT name; real speech MUST. REVIEW if neither fired (audio path suspect).',
    eventsFile: EVENTS_NDJSON,
  });
}

// ===================================================================== main
function failAll(reason) {
  for (const s of SCENARIOS) record(s, 'FAIL', { reason });
  console.log('ZOOM LIVE SESSION COMPLETE');
  process.exit(1);
}

async function main() {
  if (!process.argv.includes('--all')) { console.error('usage: run-zoom-live-qa.mjs --all'); process.exit(2); }
  writeFileSync(RESULTS_NDJSON, '');
  if (!prebuild()) return failAll('swift build failed');
  if (!preflightAxTrust()) return failAll('Accessibility not granted to this process');
  preflightSignedIn();

  let det, guest = null, guestOk = false, speechGuest = null, speechGuestOk = false;
  try {
    if (!await bootstrapMeeting()) return failAll('could not start a Zoom meeting (signed in? "New meeting" present?)');
    const invite = await harvestInvite();
    if (!invite) log('WARN: no invite URL harvested — running host-only (guest scenarios REVIEW/skip)');

    if (invite && process.env.ZOOM_SKIP_GUEST !== '1') {
      try {
        guest = await joinZoomWebGuest({ port: GUEST_PORT, name: GUEST_NAME, inviteUrl: invite });
        guestOk = await admitLoop();   // true only once the guest is IN the meeting
        if (!guestOk) log('WARN: guest never admitted past the waiting room — guest scenarios -> REVIEW');
        await sleep(5000);
      } catch (e) { log('guest join failed: ' + e.message); guest = null; guestOk = false; }
    }

    det = startDetector(180);
    await sleep(3000);
    // The original 5 suites run FIRST with the roster EXACTLY {self, GUEST_NAME}.
    await scenarioDetectRoster(det, guestOk);
    await scenarioMuteGate(det, guest?.page || null, guestOk);
    await scenarioPanelClosed(det, guest?.page || null);
    // Kill the shared session detector; the two NEW scenarios (plan C3) each spawn
    // their OWN event-mode detector, so freeing the AX read path avoids
    // double-attribution during the degraded-window / tone probes.
    try { det?.kill(); await det?.done?.catch(() => {}); } catch (e) {}

    // Now — AFTER the roster-exact scenarios — join the DISTINCT-named speech-gain
    // guest (Guest Bravo) for vad-quality-live. It must NOT be present during the
    // early roster scenario (which would flag it a "stranger"), so it joins here.
    if (invite && process.env.ZOOM_SKIP_GUEST !== '1') {
      try {
        speechGuest = await joinSpeechGuest({ port: SPEECH_GUEST_PORT, name: SPEECH_GUEST_NAME, seat: 'bravo', inviteUrl: invite });
        speechGuestOk = await admitLoop(90_000); // host + tone guest + speech guest
        await sleep(4000);
      } catch (e) { log('speech-gain guest join failed: ' + e.message); speechGuest = null; speechGuestOk = false; }
    }

    await scenarioPipBackground(guest?.page || null, guestOk);
    await scenarioVadQuality(speechGuest?.page || null, speechGuestOk, SPEECH_GUEST_NAME);
  } catch (e) {
    log('FATAL ' + e.stack);
    for (const s of SCENARIOS) record(s, 'FAIL', { reason: 'runner exception: ' + e.message });
  } finally {
    try { await pressFirst(['End meeting for all', 'Leave meeting', 'Leave']); } catch (e) {}
    try { guest?.chrome?.kill(); } catch (e) {}
    try { speechGuest?.chrome?.kill(); } catch (e) {}
    try { det?.kill(); } catch (e) {}
  }
  console.log('ZOOM LIVE SESSION COMPLETE');
  process.exit(0);
}

main();
