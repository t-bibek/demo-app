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
// Detector contract (same as the Meet live gate): MSD_AUTOSTART=1,
// MSD_RUN_SECONDS=N; every engine event mirrors to stdout as `[event] {json}`.
//
//   node qa/teams-live/run-teams-live-qa.mjs --all
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
const DETECTOR_BIN = join(MACOS, '.build', 'debug', 'MeetSpeakerDetector');
const TEAMSDRIVE_BIN = join(MACOS, '.build', 'debug', 'TeamsDrive');
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
  log('swift build --package-path macos …');
  const r = spawnSync('swift', ['build', '--package-path', MACOS], { encoding: 'utf8', timeout: 20 * 60_000 });
  if (r.status !== 0) {
    console.error('[teams-live] swift build FAILED:\n' + ((r.stdout || '') + (r.stderr || '')).split('\n').slice(-25).join('\n'));
    return false;
  }
  return existsSync(DETECTOR_BIN) && existsSync(TEAMSDRIVE_BIN);
}

// --- Streaming detector: parse `[event] {json}` stdout lines as they arrive. -----
function startDetector(seconds) {
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
      try { const o = JSON.parse(ln.slice(j)); if (o && o.type) events.push(o); } catch (e) {}
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const done = new Promise((res) => proc.on('exit', res));
  return { proc, events, done, kill: () => { try { proc.kill('SIGKILL'); } catch (e) {} } };
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
  if (!await pressFirst(['Join'])) { log('no Join button on the Meet tab'); return false; }
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

// --- Web-Teams guest via Chrome CDP (fake mic tone = guest speech energy). --------
async function joinGuest(url) {
  const { launchChrome, attachToPage } = require(join(REPO, 'research', 'meet-dom-detector', 'live', 'cdp-lib.js'));
  const chrome = launchChrome({ port: GUEST_PORT, headful: true, fakeAudio: true, url, profileTag: 'teams-guest' });
  const page = await attachToPage(GUEST_PORT, /teams\.(live|microsoft)\.com/);
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
async function main() {
  if (!process.argv.includes('--all')) {
    console.error('usage: node run-teams-live-qa.mjs --all');
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

main().catch((e) => {
  console.error('[teams-live] FATAL', e && e.stack ? e.stack : e);
  console.log('TEAMS LIVE SESSION COMPLETE'); // reader suites fail on missing verdicts
  process.exit(1);
});
