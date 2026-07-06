// ---------------------------------------------------------------------------
// Shared native-Teams HOST driver for the live QA rigs. The Teams-web counterpart
// of qa/zoom-live/zoom-host-lib.mjs — it drives the ONE proven TeamsDrive bootstrap
// / invite-harvest / lobby-admit / leave flow so the tab-away rig (and any future
// Teams rig) can host a throwaway teams.live.com meeting operator-free, instead of
// prompting a human. Every mechanic here was extracted from the PROVEN hosting path
// in qa/teams-live/run-teams-live-qa.mjs (hostJoinCall / harvestInCall / hostLeaveCall,
// live-verified 2026-07-03..06: teams-detect-live PASS, meeting_initialized true,
// self "Bibek Thapa") and hardened for the autonomous gate:
//   • bootstrapMeeting  — Teams native → Meet tab → "Meet now" (instant meeting) →
//                         "Join now" → wait for the in-call Leave button. Also clears
//                         the stale "Rejoin the call" wedge left by a prior run that
//                         never cleanly ended (the Teams analog of Zoom's "meeting in
//                         progress" modal).
//   • harvestInvite     — in-call People panel → "Share invite" → "Copy meeting link"
//                         → pbpaste (clipboard cleared first, restored after) → expect
//                         a teams.live.com / teams.microsoft.com link.
//   • admitLoop         — poll for the lobby prompt / an Admit button and press Admit
//                         until the roster reaches target (best-effort AX signal).
//   • endMeeting        — Leave/hang-up press; if the auto-hidden toolbar hides the
//                         controls, fall back to the Zoom quit-confirm pattern (quit
//                         Teams → confirm "Leave"/"End" → relaunch to the signed-in home).
//   • reallyInMeeting   — authoritative in-call check: the Leave button is present in
//                         the AX tree (the product's teamsCallWindowOpen gate is the
//                         SAME "Leave button / Shared-content landmark / Attendees
//                         outline" evidence — TeamsTileExtraction.swift:65).
//
// This module is PURE plumbing: it owns no scenario logic and writes no verdicts —
// the callers do. TeamsDrive's press/find/windows surface mirrors ZoomDrive's, so the
// host-lib parsing helpers port near-1:1; the ONE shape difference is that TeamsDrive
// has no `--window` flag and no `harvest-url` verb (Teams exposes controls as flat
// button labels + the clipboard is the invite source), so the helpers below drop the
// window-scoping the Zoom lib needed.
// ---------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const MACOS = join(REPO, 'macos');

// Consumer-Teams bundle IDs, newest first (TeamsDrive/main.swift uses the same list).
const TEAMS_BUNDLE = 'com.microsoft.teams2';

// MSD_DETECTOR_BIN overrides the sandbox SwiftPM debug binary so an EXTERNAL (product)
// detector can be gated by the live rigs. When set, prebuild() skips the swift build
// and the binary must already exist — fail fast at import, BEFORE any caller launches
// meeting/rig infrastructure. (Mirrors zoom-host-lib.)
export const PATHS = {
  REPO,
  MACOS,
  DETECTOR_BIN: process.env.MSD_DETECTOR_BIN || join(MACOS, '.build', 'debug', 'MeetSpeakerDetector'),
  TEAMSDRIVE_BIN: join(MACOS, '.build', 'debug', 'TeamsDrive'),
  AXSNAPSHOT_BIN: join(MACOS, '.build', 'debug', 'AXSnapshot'),
};
if (process.env.MSD_DETECTOR_BIN && !existsSync(PATHS.DETECTOR_BIN)) {
  console.error(`[teams-host] FATAL: MSD_DETECTOR_BIN is set but no detector binary exists at ${PATHS.DETECTOR_BIN}`);
  process.exit(1);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowSec = () => Math.floor(Date.now() / 1000);

// A tagged logger so a rig's host-driver output is distinguishable.
export function makeLog(tag) {
  return (...a) => console.log(`[${tag}:host]`, ...a);
}

// --- TeamsDrive wrapper -----------------------------------------------------------
// Mirrors zoom-host-lib.drive(). TeamsDrive prints one parseable line per action
// (PRESSED …/MATCH …/NOT_FOUND …/WINDOW …/RAISED …) and exits 0 only on success.
export function drive(...args) {
  const r = spawnSync(PATHS.TEAMSDRIVE_BIN, args, { encoding: 'utf8', timeout: 120_000 });
  return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

// Press the FIRST candidate label that exists (labels differ across Teams builds /
// locales). TeamsDrive.press prints `PRESSED role=… text="…"` on success; success is
// exit 0 (r.ok). Returns the label that worked, or null. `opts.args` appends extra
// TeamsDrive flags (e.g. ['--role','AXButton'] or ['--exact']).
export async function pressFirst(candidates, opts = {}, settleMs = 1200, log = () => {}) {
  const extra = Array.isArray(opts) ? opts : (opts.args || []);
  for (const c of candidates) {
    const r = drive('press', c, ...extra);
    if (r.ok && r.out.startsWith('PRESSED')) { log(`pressed "${c}"`); await sleep(settleMs); return c; }
  }
  return null;
}

// True if ANY control whose AXDescription/AXTitle contains `needle` exists. TeamsDrive
// find exits 0 (r.ok) iff ≥1 match, prints NOT_FOUND + exits 1 otherwise.
export function findText(needle, extra = []) {
  return drive('find', needle, ...extra).ok;
}

// --- Pre-flights -----------------------------------------------------------------
// Build the WHOLE macos package once (detector + TeamsDrive + AXSnapshot) so every
// binary a rig spawns is fresh, and compile time never lands inside a timed CPU window.
// External-detector mode skips the build but still needs TeamsDrive present. Returns
// false with a tail on failure. (Mirrors zoom-host-lib.prebuild.)
export function prebuild(log = () => {}) {
  if (process.env.MSD_DETECTOR_BIN) {
    log(`using external detector: ${PATHS.DETECTOR_BIN} (prebuild skipped)`);
    if (!existsSync(PATHS.TEAMSDRIVE_BIN)) {
      console.error(`[teams-host] external-detector mode still needs TeamsDrive at ${PATHS.TEAMSDRIVE_BIN} — run \`swift build --package-path macos\` once`);
      return false;
    }
    return true;
  }
  log('swift build --package-path macos …');
  const r = spawnSync('swift', ['build', '--package-path', MACOS], { encoding: 'utf8', timeout: 20 * 60_000 });
  if (r.status !== 0) {
    console.error('[teams-host] swift build FAILED:\n' + ((r.stdout || '') + (r.stderr || '')).split('\n').slice(-25).join('\n'));
    return false;
  }
  return existsSync(PATHS.DETECTOR_BIN) && existsSync(PATHS.TEAMSDRIVE_BIN);
}

// AX trust: TeamsDrive prints NOT_TRUSTED (and exits 1) without Accessibility. `windows`
// is a cheap read; NOT_RUNNING is fine (we launch Teams next).
export function preflightAxTrust() { return !drive('windows').out.includes('NOT_TRUSTED'); }

// Bring the signed-in native Teams app to the foreground (it is signed in on this host).
export function preflightSignedIn() {
  spawnSync('open', ['-b', TEAMS_BUNDLE]);
  return true;
}

// --- Authoritative in-call check --------------------------------------------------
// REALLY in a call = the Leave button is in the AX tree. This is the SAME evidence the
// product's in-call gate uses (TeamsTileExtraction.swift:65 — "Leave button / Shared
// content landmark / Attendees outline"), and it is what run-teams-live-qa's proven
// hostJoinCall polls for. A STALE "Rejoin the call" button (a prior meeting that never
// cleanly ended) is NOT in-call — it means the app shows a post-call shell, so we must
// NOT match "Rejoin"/other Leave-substring chrome. TeamsDrive `find "Leave"` matches on
// AXDescription/AXTitle substring; "Rejoin the call" does not contain "leave", so a bare
// find "Leave" is safe and precise here.
export function reallyInMeeting() {
  return findText('Leave');
}

// --- Meeting bootstrap ------------------------------------------------------------
// Teams native → Meet tab → "Meet now" (instant meeting) → "Join now" → wait for the
// in-call Leave button. Every live run bootstraps a FRESH throwaway meeting.
//
// STALE-WEDGE RECOVERY: a prior run whose meeting never cleanly ended leaves the app
// on a post-call shell with a "Rejoin the call" button (observed live 2026-07-07) — the
// Teams analog of Zoom's "meeting currently in-progress" modal. That shell is NOT
// in-call (no Leave button) and blocks nothing, but "Meet now" may be crowded out. We
// first try a clean instant meeting; if the Meet-tab affordance is missing we press
// "Rejoin the call" to re-enter our own prior meeting (it is ours — throwaway), so this
// run has a live call to drive; the finally-block endMeeting then ends it for real.
export async function bootstrapMeeting(log = () => {}) {
  spawnSync('open', ['-b', TEAMS_BUNDLE]); await sleep(8000);
  drive('raise'); await sleep(2000);
  if (reallyInMeeting()) { log('already in a call'); await openPeoplePanel(log); return true; }

  // Navigate to the Meet tab (the instant-meeting surface). The app-bar "Meet" checkbox
  // and the Meet window both carry "Meet" — press the tab, then look for the start
  // affordance ON the Meet home.
  await pressFirst(['Meet'], {}, 2500, log);
  await sleep(2500);

  // Start an INSTANT meeting. Candidate labels across builds:
  //   "Meet now" / "Meet Now" / "Start meeting" — the instant-meeting button.
  //   "Create a meeting link" then "Join" — the Meet-home two-step (live-observed
  //     2026-07-07: the Meet tab shows "Create a meeting link" + a per-card "Join").
  let started = await pressFirst(['Meet now', 'Meet Now', 'Start meeting'], {}, 3000, log);
  if (!started) {
    // Two-step: create a fresh meeting link, then Join the card it produces.
    if (await pressFirst(['Create a meeting link'], {}, 3000, log)) {
      await sleep(3000);
      started = await pressFirst(['Join now', 'Join'], {}, 3000, log);
    }
  }
  if (!started) {
    // Fall back to Joining any existing meeting card on the Meet tab.
    started = await pressFirst(['Join'], {}, 3000, log);
  }
  if (!started) {
    // Last resort: re-enter our own stale meeting so this run has a live call to end.
    if (findText('Rejoin')) {
      log('no fresh "Meet now" affordance — Rejoining our own prior (stale) meeting');
      started = await pressFirst(['Rejoin the call', 'Rejoin'], {}, 3000, log);
    }
  }
  if (!started) { log('FATAL: no "Meet now" / "Create a meeting link" / "Join" / "Rejoin" affordance on the Meet tab — cannot start a call'); return false; }

  await sleep(6000);
  // Pre-join green room → join. "Join now" is primary; fall back to "Join".
  await pressFirst(['Join now', 'Join'], {}, 2500, log);

  // In-call marker: the Leave button appears. Poll up to ~60s (green-room → in-call can
  // include a permissions prompt on the first-ever start). Dismiss any one-off modal.
  for (let i = 0; i < 20; i++) {
    if (reallyInMeeting()) { await openPeoplePanel(log); return true; }
    await pressFirst(['Join now', 'Join', 'OK', 'Got it', 'Continue', 'Allow'], {}, 800, log);
    await sleep(3000);
  }
  return reallyInMeeting();
}

// Open the Participants/People panel — the reliable roster + Share-invite source (and in
// a solo call the ONLY participant source; the stage has no tiles then). Idempotent: if
// the Attendees outline is already up, do nothing (Teams' People toggle can close it).
async function openPeoplePanel(log = () => {}) {
  if (findText('Attendees')) return;
  await pressFirst(['People', 'Participants', 'Show participants'], {}, 3000, log);
}

// --- Invite-URL harvest: People panel → Share invite → Copy meeting link → pbpaste ---
// (clipboard cleared first, restored after). The Meet-tab "Share link" dialog does not
// materialize under AXPress, so harvest happens AFTER joining (proven in run-teams-live-qa
// harvestInCall). Consumer meetings yield a teams.live.com/meet link; work meetings a
// teams.microsoft.com/l/meetup-join link — accept both.
export async function harvestInvite(log = () => {}) {
  if (process.env.TEAMS_MEETING_URL) return process.env.TEAMS_MEETING_URL;
  const saved = spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout;
  spawnSync('pbcopy', [], { input: '' }); // CLEAR first so a stale clipboard can't masquerade as the link

  await openPeoplePanel(log);
  // Share tray → copy. Label variants across builds.
  await pressFirst(['Share invite', 'Share meeting invite', 'Copy join info', 'Invite someone'], {}, 2500, log);
  await pressFirst(['Copy meeting link', 'Copy link', 'Copy join link', 'Copy'], {}, 1500, log);
  const clip = spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout.trim();
  // Dismiss any share menu (Escape).
  spawnSync('osascript', ['-e', 'tell application "System Events" to key code 53']);
  await sleep(800);
  spawnSync('pbcopy', [], { input: saved }); // restore the user's clipboard

  const link = extractTeamsUrl(clip);
  if (link) return link;
  log(`harvestInvite: clipboard did not carry a teams link (got ${clip ? clip.slice(0, 40) + '…' : '<empty>'})`);
  return null;
}

// A teams.live.com (consumer) OR teams.microsoft.com (work) join URL.
function extractTeamsUrl(s) {
  if (!s) return null;
  const m = s.match(/https:\/\/teams\.(?:live|microsoft)\.com\/[^\s"'<>]+/i);
  return m ? m[0] : null;
}

// --- Lobby admit. A web guest reaches the native lobby a few seconds AFTER its join
// call returns (live-measured 4–8s), so WAIT for the host-side lobby signal, then press
// the Admit control. The live-verified control is an `AXButton` whose text is
// "Admit participant in lobby" (observed 2026-07-07); "Admit all" / "Admit" cover other
// builds and the several-guests-stacked case. Teams' native AX exposes NO numeric roster
// count (unlike Zoom's window line), so we cannot count the roster from the host — the
// authoritative "guest reached roster == targetCount" check is the CALLER's own detector
// / the guest page's in-call read.
//
// The load-bearing correctness fix (vs. a naive "pressed once → done"): the guest sits
// in the lobby with the Admit button present the WHOLE time until pressed, so we keep
// pressing WHILE the lobby signal persists and only return true once that lobby signal
// has CLEARED after an admit press (== the guest left the lobby, i.e. was admitted). A
// single early press against a stale state can no longer short-circuit the loop. A guest
// that never lands (or is never admitted) leaves this false → the caller degrades guest
// scenarios to REVIEW/DETECTION-NEGATIVE, not a hard FAIL. `targetCount` scales how many
// admits we require before declaring the lobby drained (host + (targetCount-1) guests).
export async function admitLoop({ targetCount = 2, waitMs = 90_000 } = {}, log = () => {}) {
  const t0 = Date.now();
  const need = Math.max(1, targetCount - 1); // guests to admit (roster minus the host)
  let admitted = 0;
  const lobbyPending = () => findText('Admit participant in lobby') || findText('waiting in the lobby')
    || findText('in the lobby') || findText('would like to join') || findText('Admit');
  while (Date.now() - t0 < waitMs) {
    if (lobbyPending()) {
      // Press the live-verified label first, then the generic fallbacks. "Admit all"
      // clears every pending guest in one press when several stack up.
      const a = await pressFirst(['Admit participant in lobby', 'Admit all', 'Admit All', 'Admit'],
        { args: ['--role', 'AXButton'] }, 1500, log)
        || await pressFirst(['Admit'], {}, 1500, log);
      if (a) {
        admitted++;
        // Confirm THIS admit took: the lobby signal should clear within a couple seconds.
        // If it cleared and we've admitted enough guests, we're done (the guest is in-call;
        // the caller's detector/guest-page read confirms roster == targetCount).
        await sleep(2500);
        if (admitted >= need && !lobbyPending()) return true;
      }
    } else if (admitted >= need) {
      // No lobby prompt AND we've already admitted our guests → drained.
      return true;
    }
    await sleep(2500);
  }
  // Timed out: report success only if we admitted enough AND the lobby is now clear.
  return admitted >= need && !lobbyPending();
}

// --- End / leave the meeting (teardown; called in finally). -----------------------
// MUST reliably end so no stale "Rejoin the call" shell wedges the NEXT run's bootstrap
// and no throwaway meeting lingers to contaminate the next gate. FAST PATH: press the
// in-call Leave (a two-step on some builds: Leave → confirm "Leave"), verify the Leave
// button is gone. The meeting toolbar can auto-hide, so raise + retry.
//
// FALLBACK (auto-hidden-toolbar wedge, the Zoom quit-confirm pattern): if the named Leave
// button is never findable, QUIT the Teams app → Teams surfaces a leave/close confirm
// whose button IS in the AX tree (a modal, not the auto-hidden in-call toolbar) — press
// it, verify reallyInMeeting() false, then relaunch the app to the signed-in home so the
// next bootstrap has a live app to drive.
export async function endMeeting(log = () => {}) {
  // FAST PATH: named Leave on the in-call toolbar.
  for (let i = 0; i < 6; i++) {
    if (!reallyInMeeting()) { log('endMeeting: no Leave button — not in a call'); return true; }
    drive('raise'); await sleep(500);
    // Open the Leave control, then confirm any two-step popup ("Leave" / "Leave meeting").
    await pressFirst(['Leave', 'Leave meeting', 'Leave call', 'Hang up'], {}, 1000, log);
    await pressFirst(['Leave', 'Leave meeting', 'Leave now', 'End meeting', 'End call', 'Yes'], {}, 1000, log);
    await sleep(1500);
  }
  if (!reallyInMeeting()) return true;

  // FALLBACK (auto-hidden-toolbar wedge): the named Leave was never findable. QUIT Teams →
  // a leave/close confirm modal surfaces a named button in the AX tree. Press it, verify,
  // retry a few times (the quit → modal render can race).
  log('endMeeting: named Leave not findable (auto-hidden toolbar) — QUIT-CONFIRM-MODAL fallback');
  for (let i = 0; i < 4 && reallyInMeeting(); i++) {
    spawnSync('osascript', ['-e', `tell application "id ${TEAMS_BUNDLE}" to quit`], { timeout: 15_000 });
    await sleep(2500); // let the leave/close confirm modal render
    const pressed = await pressFirst(['Leave', 'Leave meeting', 'End meeting', 'End call', 'Quit', 'Yes'], {}, 1200, log);
    if (pressed) log(`endMeeting: pressed quit-confirm "${pressed}"`);
    await sleep(2500);
  }
  const ended = !reallyInMeeting();
  log(`endMeeting: quit-confirm fallback ${ended ? 'ended the call' : 'did NOT clear the call'} (reallyInMeeting=${!ended})`);
  // Relaunch to the signed-in home so the next bootstrap has a live app to drive.
  spawnSync('open', ['-b', TEAMS_BUNDLE]); await sleep(6000);
  return !reallyInMeeting();
}
