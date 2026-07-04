// ---------------------------------------------------------------------------
// TEAMS LIVE-QA manifest — tier B of the Teams two-tier harness (tier A is the
// deterministic fixture replay inside `swift run SpeakerCoreSelfTest`; see
// macos/Fixtures/teams + qa/qa.config.mjs's swift-selftest suite). Mirrors
// qa/qa.live.config.mjs: kept OUT of CI (INV-7) because it launches the native
// Teams app, the detector, and a Chrome web-guest. Run it via:
//
//   QA_CONFIG=qa/qa.teams.config.mjs qa/run_autonomous_qa.sh --skip-review
//
// ONE shared live session (`teams-live-session` runs first — the orchestrator
// executes suites in array order): it drives the layout × participant matrix on
// a real call via `swift run TeamsDrive` (AXPress on named native controls) +
// a CDP web-guest, writes one NDJSON verdict per scenario to
// qa/teams-live/teams-live-results.ndjson, and prints `TEAMS LIVE SESSION
// COMPLETE` (the match). The reader suites then gate per scenario through
// qa/live-scenario-verdict.mjs (results-file arg #2). No minCount on live
// suites (INV-4 covers CI-baselined suites only).
//
// Env knobs (see run-teams-live-qa.mjs): TEAMS_EXPECT_SELF, TEAMS_MEETING_URL,
// TEAMS_GUEST_NAME, TEAMS_SKIP_GUEST=1.
// ---------------------------------------------------------------------------

const RESULTS = 'qa/teams-live/teams-live-results.ndjson';

export default {
  suites: [
    {
      // Drives the whole live session; the reader suites consume its NDJSON.
      id: 'teams-live-session',
      cwd: '.',
      cmd: 'node qa/teams-live/run-teams-live-qa.mjs --all',
      match: 'TEAMS LIVE SESSION COMPLETE',
      timeoutMs: 30 * 60_000,
    },
    {
      // Detector recognizes the native call: teams:: meeting_initialized + the
      // LOCAL participant with the expected display name.
      id: 'teams-detect-live',
      cwd: '.',
      cmd: `node qa/live-scenario-verdict.mjs teams-detect-live ${RESULTS}`,
      match: '"verdict":"PASS"',
    },
    {
      // Structural self tile + toolbar fusion: local is_muted flips BOTH ways
      // when TeamsDrive toggles Mute mic / Unmute mic.
      id: 'teams-selfmute-live',
      cwd: '.',
      cmd: `node qa/live-scenario-verdict.mjs teams-selfmute-live ${RESULTS}`,
      match: '"verdict":"PASS"',
    },
    {
      // Layout × size matrix: gallery / speaker / together + two window sizes —
      // the roster stays EXACTLY the expected set in every driven cell.
      id: 'teams-layouts-live',
      cwd: '.',
      cmd: `node qa/live-scenario-verdict.mjs teams-layouts-live ${RESULTS}`,
      match: '"verdict":"PASS"',
    },
    {
      // Web-guest cell: roster grows by exactly the guest; with one unmuted
      // remote emitting audio, speech_on NAMES the guest (never "Someone",
      // never the local user).
      id: 'teams-guest-live',
      cwd: '.',
      cmd: `node qa/live-scenario-verdict.mjs teams-guest-live ${RESULTS}`,
      match: '"verdict":"PASS"',
    },
  ],

  // No blocker tools: the guest's speech energy is Chrome's fake-device tone
  // (no BlackHole loopback needed — Teams native plays the guest's audio, the
  // detector's system tap hears it).
  tools: [],

  // Review runs in the deterministic gate (qa.config.mjs); the live gate is
  // invoked with --skip-review. Kept for manual full-run parity.
  review: {
    id: 'qa-check-review',
    cmd: 'node qa/review-check.mjs',
    required: true,
  },
};
