// ---------------------------------------------------------------------------
// Shared native-Zoom HOST driver for the live QA rigs. Extracted from
// run-zoom-live-qa.mjs so the native rig (qa/zoom-live) and the web rig
// (qa/zoomweb-live) drive the ONE proven ZoomDrive bootstrap / invite-harvest /
// waiting-room-admit flow through the same code instead of copy-pasting it (the
// gotchas — preview "Start", ⌘I copy-invite + clipboard restore, ⌘U toggles the
// panel so open it once, roster>=2 verify — all live in ONE place here).
//
// Every mechanic here was validated live against Zoom 7.0.5
// (qa/zoom-live/live-evidence.md). This module is PURE plumbing: it owns no
// scenario logic and writes no verdicts — the callers do.
// ---------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const MACOS = join(REPO, 'macos');

// MSD_DETECTOR_BIN overrides the sandbox SwiftPM debug binary so an EXTERNAL
// (product) detector can be gated by the live rigs. When set, prebuild() skips
// the swift build and the binary must already exist — fail fast at import,
// BEFORE any caller launches meeting/rig infrastructure.
export const PATHS = {
  REPO,
  MACOS,
  DETECTOR_BIN: process.env.MSD_DETECTOR_BIN || join(MACOS, '.build', 'debug', 'MeetSpeakerDetector'),
  ZOOMDRIVE_BIN: join(MACOS, '.build', 'debug', 'ZoomDrive'),
  AXSNAPSHOT_BIN: join(MACOS, '.build', 'debug', 'AXSnapshot'),
};
if (process.env.MSD_DETECTOR_BIN && !existsSync(PATHS.DETECTOR_BIN)) {
  console.error(`[zoom-host] FATAL: MSD_DETECTOR_BIN is set but no detector binary exists at ${PATHS.DETECTOR_BIN}`);
  process.exit(1);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowSec = () => Math.floor(Date.now() / 1000);

// A tagged logger so the two rigs' host-driver output is distinguishable.
export function makeLog(tag) {
  return (...a) => console.log(`[${tag}:host]`, ...a);
}

// --- ZoomDrive wrapper -----------------------------------------------------------
export function drive(...args) {
  const r = spawnSync(PATHS.ZOOMDRIVE_BIN, args, { encoding: 'utf8', timeout: 120_000 });
  return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

export async function pressFirst(candidates, opts = {}, settleMs = 1200, log = () => {}) {
  const extra = Array.isArray(opts) ? opts : (opts.args || []);
  for (const c of candidates) {
    const r = drive('press', c, ...extra);
    if (r.ok && r.out.startsWith('PRESSED')) { log(`pressed "${c}"`); await sleep(settleMs); return c; }
  }
  return null;
}

export function meetingWindowPresent() {
  return drive('windows').out.split('\n').some((l) => /meeting=YES/.test(l));
}

export function rosterVisible() { // "computer audio" text present ⇒ a roster is readable
  return drive('find', 'computer audio').ok;
}

// Highest roster= count across all Zoom windows (the fused meeting window carries it).
export function rosterCount() {
  return drive('windows').out.split('\n')
    .map((l) => (l.match(/roster=(\d+)/) || [])[1]).filter(Boolean).map(Number)
    .reduce((a, b) => Math.max(a, b), 0);
}

// --- Keystrokes land on Zoom only after raising it --------------------------------
// osascript frontmost (drive raise) BEFORE any keystroke — a keystroke sent while
// Zoom is backgrounded lands in whatever app is frontmost (a recurring live-rig bug).
export function keystroke(key, mods = []) {
  drive('raise');
  const using = mods.length ? ` using {${mods.map((m) => m + ' down').join(', ')}}` : '';
  spawnSync('osascript', ['-e', `tell application "System Events" to keystroke "${key}"${using}`]);
}
export const panelToggle = () => keystroke('u', ['command']); // ⌘U TOGGLES the participants panel — open once

// --- Pre-flights -----------------------------------------------------------------
// Build the WHOLE macos package once (detector + ZoomDrive + AXSnapshot) so every
// binary the rigs spawn is fresh, and compile time never lands inside a timed CPU
// window. Returns false with a tail on failure.
export function prebuild(log = () => {}) {
  if (process.env.MSD_DETECTOR_BIN) {
    log(`using external detector: ${PATHS.DETECTOR_BIN} (prebuild skipped)`);
    if (!existsSync(PATHS.ZOOMDRIVE_BIN)) {
      console.error(`[zoom-host] external-detector mode still needs ZoomDrive at ${PATHS.ZOOMDRIVE_BIN} — run \`swift build --package-path macos\` once`);
      return false;
    }
    return true;
  }
  log('swift build --package-path macos …');
  const r = spawnSync('swift', ['build', '--package-path', MACOS], { encoding: 'utf8', timeout: 20 * 60_000 });
  if (r.status !== 0) {
    console.error('[zoom-host] swift build FAILED:\n' + ((r.stdout || '') + (r.stderr || '')).split('\n').slice(-25).join('\n'));
    return false;
  }
  return existsSync(PATHS.DETECTOR_BIN) && existsSync(PATHS.ZOOMDRIVE_BIN);
}

export function preflightAxTrust() { return !drive('windows').out.includes('NOT_TRUSTED'); }

export function preflightSignedIn() {
  spawnSync('open', ['-b', 'us.zoom.xos']); // reopen the home window
  return true;
}

// --- Meeting bootstrap (validated: New meeting → Start preview) -------------------
// Zoom free tier caps a meeting at 40 min, so every live run bootstraps FRESH.
export async function bootstrapMeeting(log = () => {}) {
  spawnSync('open', ['-b', 'us.zoom.xos']); await sleep(6000);
  drive('raise'); await sleep(1500);
  // "already in a meeting" must mean REALLY joined (roster/audio readable), NOT just the
  // preview window up — the green-room preview's window ALSO matches meetingWindowPresent().
  if (reallyInMeeting()) { log('already in a meeting'); return true; }
  const started = await pressFirst(
    ['Start a new meeting with video on', 'Start new meeting', 'New meeting', 'New Meeting'], {}, 2000, log);
  if (!started && process.env.ZOOM_PMI) spawnSync('open', [`zoommtg://zoom.us/start?confno=${process.env.ZOOM_PMI}`]);
  else if (!started) return false;
  await sleep(4000);
  // A PRIOR meeting that never cleanly ended (host client killed without pressing "End
  // meeting for all") keeps running SERVER-side; Zoom then blocks "Start new meeting"
  // with a "You have a meeting that is currently in-progress" modal. Live evidence
  // 2026-07-04: this recurs across runs and wedges the whole gate. Recover by REJOINING
  // that meeting (it is ours) so this run has a live meeting to drive; the finally-block
  // teardown then ends it for real. Cancel the modal, rejoin via ZOOM_MEETING_URL if we
  // have one, else press the home "Join meeting".
  if (drive('find', 'currently in-progress').ok) {
    log('prior meeting still in-progress server-side — rejoining it');
    await pressFirst(['Cancel'], {}, 800, log);
    if (process.env.ZOOM_MEETING_URL) { spawnSync('open', [process.env.ZOOM_MEETING_URL]); await sleep(6000); await pressFirst(['Join', 'Open Zoom Workplace', 'Open zoom.us'], { args: ['--window', 'Zoom Meeting'] }, 2000, log); }
    else { await pressFirst(['Join meeting', 'Join Meeting'], {}, 1500, log); }
  }
  await sleep(4000);
  // "Start a new meeting" opens a PREVIEW/green-room dialog whose window title also
  // matches "Zoom Meeting", so meetingWindowPresent() goes true on the PREVIEW while the
  // meeting has NOT joined. Live evidence (2026-07-04): one fixed-delay "Start" press
  // often lands before the preview's button renders, leaving the meeting stuck on the
  // preview → cmd-I invite harvest + waiting-room admit both fail → guests never flow
  // audio. Press "Start" REPEATEDLY until the meeting is REALLY live (computer audio
  // joined), dismissing any one-off modal that could steal the join.
  for (let i = 0; i < 24; i++) {
    if (reallyInMeeting()) return true;
    await pressFirst(['Start'], { args: ['--window', 'Zoom Meeting'] }, 1500, log);
    await pressFirst(['OK', 'Got it', 'Continue'], {}, 500, log);
    await sleep(2500);
  }
  return reallyInMeeting();
}

// REALLY in a meeting, distinct from the green-room PREVIEW window (which shares the
// "Zoom Meeting" title AND carries its own "… currently unmuted" mic control, so those
// signals do NOT distinguish preview from joined). The ONE reliable distinguisher: the
// preview has a "Start" (join) button and the joined meeting does not. So: a meeting
// window exists AND there is no preview "Start" button left to press.
export function reallyInMeeting() {
  if (!meetingWindowPresent()) return false;
  const previewStart = drive('find', 'Start').out.split('\n')
    .some((l) => /text="Start"/.test(l) && /window="[^"]*Zoom Meeting/.test(l));
  return !previewStart;
}

// --- Invite-URL harvest: ⌘I → Copy invite link → pbpaste (clipboard restored) ----
export async function harvestInvite(log = () => {}) {
  if (process.env.ZOOM_MEETING_URL) return process.env.ZOOM_MEETING_URL;
  const saved = spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout;
  keystroke('i', ['command']); await sleep(2500);
  const pressed = await pressFirst(['Copy invite link', 'Copy Invite Link'], {}, 1200, log);
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

// --- Waiting-room admit. A guest reaches the waiting room a few seconds AFTER its
// join call returns, so first WAIT for the host-side signal (toast or panel row),
// then press Admit and VERIFY the roster grew. ⌘U TOGGLES, so open the panel at
// most once. `targetCount` lets a multi-guest rig wait for the roster to reach the
// full expected size (e.g. host + observer + 2 guests = 4). Returns true once the
// roster hits targetCount. A guest that never lands leaves this false → the caller
// degrades guest scenarios to REVIEW, not FAIL.
export async function admitLoop({ targetCount = 2, waitMs = 90_000 } = {}, log = () => {}) {
  const t0 = Date.now();
  let opened = false;
  while (Date.now() - t0 < waitMs) {
    if (rosterCount() >= targetCount) return true;             // already at target
    const waiting = drive('find', 'waiting room').ok || drive('find', 'entered the waiting').ok
      || drive('find', 'would like to join').ok;
    if (waiting) {
      if (!opened) { panelToggle(); await sleep(2500); opened = true; } // reveal the panel's Admit
      // "Admit all" clears every pending guest in one press when several stack up.
      await pressFirst(['Admit all', 'Admit All'], { args: ['--role', 'AXButton'] }, 1500, log);
      await pressFirst(['Admit'], { args: ['--role', 'AXButton'] }, 1500, log);
      await pressFirst(['Admit'], { args: ['--window', 'Zoom Meeting'] }, 1500, log);
      if (rosterCount() >= targetCount) return true;
    }
    await sleep(2500);
  }
  return rosterCount() >= targetCount;
}

// --- End / leave the meeting (teardown; called in finally). -----------------------
// MUST reliably end, else the meeting keeps running SERVER-side and the NEXT run's
// "Start new meeting" is blocked by the in-progress modal (recurring live-rig wedge).
// "End" is a TWO-step flow (End → confirm "End meeting for all"), and the meeting
// toolbar auto-hides, so raise + retry, then VERIFY the meeting window is gone.
export async function endMeeting(log = () => {}) {
  for (let i = 0; i < 6; i++) {
    if (!meetingWindowPresent()) return true;
    drive('raise'); await sleep(400);
    // Open the End/Leave control ON the meeting window (bare "End" substring-matches the
    // Workplace calendar button, so scope to the meeting window and prefer the full
    // destructive labels). Then confirm the two-step "End meeting for all" popup.
    await pressFirst(['End meeting for all', 'End Meeting for All', 'Leave meeting', 'Leave Meeting'],
      { args: ['--window', 'Zoom Meeting'] }, 1000, log);
    await pressFirst(['End', 'Leave'], { args: ['--window', 'Zoom Meeting'] }, 1000, log);
    // Confirm popup (may be a separate small window).
    await pressFirst(['End meeting for all', 'End Meeting for All', 'Leave meeting', 'Leave', 'Yes'], {}, 1000, log);
    await sleep(1500);
  }
  return !meetingWindowPresent();
}
