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
//   node qa/zoom-live/run-zoom-live-qa.mjs --all
//
// Env: ZOOM_EXPECT_SELF (default git user.name), ZOOM_GUEST_NAME (default
//      "Guest Alpha"), ZOOM_MEETING_URL (skip harvest), ZOOM_SKIP_GUEST=1.
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { joinZoomWebGuest, setGuestMuted } from './zoom-web-guest.mjs';

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
const SCENARIOS = ['zoom-detect-live', 'zoom-roster-live', 'zoom-mutegate-live', 'zoom-panelclosed-live'];

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

// --- Streaming detector (mirror the Teams runner) --------------------------------
function startDetector(seconds) {
  writeFileSync(EVENTS_NDJSON, '');
  const env = { ...process.env, MSD_AUTOSTART: '1', MSD_RUN_SECONDS: String(seconds) };
  const proc = spawn(DETECTOR_BIN, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = [];
  let buf = '';
  const onData = (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ln = buf.slice(0, i); buf = buf.slice(i + 1);
      const j = ln.indexOf('{');
      if (!ln.includes('[event]') || j < 0) continue;
      const payload = ln.slice(j);
      try { const o = JSON.parse(payload); if (o && o.type) { events.push(o); appendFileSync(EVENTS_NDJSON, payload + '\n'); } } catch (e) {}
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const done = new Promise((res) => proc.on('exit', res));
  return { proc, events, done, kill: () => { try { proc.kill('SIGKILL'); } catch (e) {} } };
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

// --- Waiting-room admit: press the in-panel "Admit" button (⌘U reveals it) --------
async function admitLoop(maxTries = 8) {
  for (let i = 0; i < maxTries; i++) {
    if (!drive('find', 'entered the waiting room').ok && !drive('find', 'admit').ok) return; // nobody waiting
    panelToggle(); await sleep(2000); // reveal waiting-room mgmt in the panel
    if (await pressFirst(['Admit'], { args: ['--window', 'Zoom Meeting'] }, 2000)) return;
    await sleep(2500);
  }
}

// ===================================================================== scenarios
async function scenarioDetectRoster(det, guestPage) {
  // detect: meeting + self + guest. The detector's own is_local read IS the
  // self ground truth (the Zoom account's display name via "(me)"), which is
  // independent of git identity — so the assertion is "self is detected as
  // is_local with a REAL name (not You/Someone)", and ZOOM_EXPECT_SELF is only an
  // exact-match check when explicitly provided.
  const init = await waitEvent(det, (e) => e.type === 'meeting_initialized' && isZoom(e), 60_000, 'meeting_initialized');
  const self = await waitEvent(det, (e) => e.type === 'participant_joined' && isZoom(e) && e.is_local, 30_000, 'self join');
  const guest = guestPage ? await waitEvent(det, (e) => e.type === 'participant_joined' && e.name === GUEST_NAME, 60_000, 'guest join') : null;
  const selfName = self?.name || null;
  const selfNameReal = !!selfName && !/^(you|someone)$/i.test(selfName);
  const selfMatchesEnv = process.env.ZOOM_EXPECT_SELF ? selfName === EXPECT_SELF : true;
  const selfNameOk = selfNameReal && selfMatchesEnv;
  record('zoom-detect-live', (init && self && selfNameOk && (!guestPage || guest)) ? 'PASS' : 'FAIL', {
    meetingInitialized: !!init, selfName, selfIsLocal: !!self?.is_local, selfNameReal,
    expectSelfEnv: process.env.ZOOM_EXPECT_SELF || null, selfMatchesEnv,
    guestExpected: !!guestPage, guestJoined: !!guest, roster: rosterNames(det), eventsFile: EVENTS_NDJSON,
  });

  // roster: exactly {detected self, guest}; no stranger ever joins. Self is the
  // detector's is_local name (not a hardcoded identity).
  const expect = [selfName, ...(guestPage ? [GUEST_NAME] : [])].filter(Boolean).sort();
  panelToggle(); await sleep(3000);           // ensure open
  const openNames = rosterNames(det);
  const allJoined = det.events.filter((e) => isZoom(e) && e.type === 'participant_joined').map((e) => e.name);
  const strangers = allJoined.filter((n) => !expect.includes(n));
  record('zoom-roster-live', (selfNameReal && JSON.stringify(openNames) === JSON.stringify(expect) && strangers.length === 0) ? 'PASS' : 'FAIL', {
    expect, got: openNames, unexpectedNames: [...new Set(strangers)], eventsFile: EVENTS_NDJSON,
  });
}

async function scenarioMuteGate(det, guestPage) {
  if (!guestPage) { record('zoom-mutegate-live', 'REVIEW', { reason: 'no guest (ZOOM_SKIP_GUEST)' }); return; }
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

  let det, guest = null;
  try {
    if (!await bootstrapMeeting()) return failAll('could not start a Zoom meeting (signed in? "New meeting" present?)');
    const invite = await harvestInvite();
    if (!invite) log('WARN: no invite URL harvested — running host-only (guest scenarios REVIEW/skip)');

    if (invite && process.env.ZOOM_SKIP_GUEST !== '1') {
      try {
        guest = await joinZoomWebGuest({ port: GUEST_PORT, name: GUEST_NAME, inviteUrl: invite });
        await admitLoop();
        await sleep(5000);
      } catch (e) { log('guest join failed: ' + e.message); guest = null; }
    }

    det = startDetector(180);
    await sleep(3000);
    await scenarioDetectRoster(det, guest?.page || null);
    await scenarioMuteGate(det, guest?.page || null);
    await scenarioPanelClosed(det, guest?.page || null);
  } catch (e) {
    log('FATAL ' + e.stack);
    for (const s of SCENARIOS) record(s, 'FAIL', { reason: 'runner exception: ' + e.message });
  } finally {
    try { await pressFirst(['End meeting for all', 'Leave meeting', 'Leave']); } catch (e) {}
    try { guest?.chrome?.kill(); } catch (e) {}
    try { det?.kill(); } catch (e) {}
  }
  console.log('ZOOM LIVE SESSION COMPLETE');
  process.exit(0);
}

main();
