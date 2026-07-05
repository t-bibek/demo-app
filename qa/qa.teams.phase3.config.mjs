// ---------------------------------------------------------------------------
// TEAMS PHASE-3 LIVE-QA manifest — gates the PRODUCT binary (bubbles-dev
// feature/active-speaker-integration tip d8a87b8da6) on the Phase-3 rig-extension
// requirements. UNLIKE qa.teams.config.mjs (one shared session, 4 scenarios), each
// Phase-3 scenario is its OWN session runner because their lifecycles don't share a
// detector cleanly: teams-throttle-live holds a 120s backgrounded window;
// teams-wake-accel runs TWO detector legs back-to-back (wake on, then MSD_TEAMS_WAKE=0);
// teams-web-cold-start full-quits Chrome for a cold start. Each mode writes ONE NDJSON
// verdict to qa/teams-live/teams-live-results.ndjson and prints `TEAMS LIVE SESSION
// COMPLETE`; the reader suite gates it via qa/live-scenario-verdict.mjs.
//
// REQUIRED ENV (Phase-3 orchestration MUST set):
//   MSD_DETECTOR_BIN   absolute path to the built product detector binary. Every
//                      Phase-3 scenario hard-FAILs fast if unset (requireProductBin).
//   TEAMS_MEETING_URL  a joinable Teams meeting URL — REQUIRED for teams-web-cold-start
//                      (no native host session to harvest a link from), and lets the
//                      other scenarios skip the in-call harvest.
// OPTIONAL ENV:
//   MSD_REFERENCE_BIN  frozen reference binary; enables the ABA-on-flake re-check when
//                      teams-wake-accel FAILs (else the FAIL stands without ABA).
//   TEAMS_EXPECT_SELF, TEAMS_GUEST_NAME  (see run-teams-live-qa.mjs)
//
// Run one scenario end-to-end (session + gate) via the autonomous orchestrator:
//   QA_CONFIG=qa/qa.teams.phase3.config.mjs qa/run_autonomous_qa.sh --skip-review
// ---------------------------------------------------------------------------

const RESULTS = 'qa/teams-live/teams-live-results.ndjson';
const RUNNER = 'node qa/teams-live/run-teams-live-qa.mjs';

// One (session-runner, reader) pair per scenario. The runner truncates the results
// file at start, so each scenario is gated against ITS OWN fresh run — do NOT run
// two Phase-3 sessions concurrently against the same results file.
const scenario = (id, flag, timeoutMin) => ([
  { id: `${id}-session`, cwd: '.', cmd: `${RUNNER} ${flag}`, match: 'TEAMS LIVE SESSION COMPLETE', timeoutMs: timeoutMin * 60_000 },
  { id, cwd: '.', cmd: `node qa/live-scenario-verdict.mjs ${id} ${RESULTS}`, match: '"verdict":"PASS"' },
]);

export default {
  suites: [
    // teams-throttle-live — minimize >=120s w/ guest speaking: keep-alive engages, key
    // never idles, ring releases to [] (no phantom), recovers on restore.
    ...scenario('teams-throttle-live', '--throttle-live', 12),
    // teams-ring-continuity — gallery->speaker->gallery under continuous speech: the
    // named speaker survives the switch without a release+reopen gap > 2.5s.
    ...scenario('teams-ring-continuity', '--ring-continuity', 10),
    // teams-wake-accel — 6x 5s-on/5s-off flips: wake attached + consumed near each
    // ring onset, 0 consumes in a >=30s silence, teams_wakes>0; control leg
    // (MSD_TEAMS_WAKE=0) has zero wake lines but detection still works (additive proof).
    ...scenario('teams-wake-accel', '--wake-accel', 15),
    // teams-web-cold-start — cold Chrome + Teams web tab: title-wake fires for the
    // Chrome pid and the web meeting is roster-DETECTED within the budget.
    ...scenario('teams-web-cold-start', '--web-cold-start', 8),
    // teams-ring-probe — falsification probe against the product binary
    // (MSD_RING_TRACE=1): open-mic-silent stays dark, speech lights, tone control.
    // Zero-parsed-ring-lines fails safe as REVIEW.
    ...scenario('teams-ring-probe', '--probe', 12),
  ],

  // No blocker tools: the guest's speech energy is Chrome's fake-mic override; Teams
  // native plays the guest's audio and the detector's ring IS Teams' own VAD.
  tools: [],

  review: { id: 'qa-check-review', cmd: 'node qa/review-check.mjs', required: true },
};
