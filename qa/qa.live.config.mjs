// ---------------------------------------------------------------------------
// LIVE-QA manifest — the exit gate for the Meet event-driven ring/focus detector.
// Kept SEPARATE from qa/qa.config.mjs (the default, CI-safe manifest) so CI never
// launches Chrome windows or the detector app. Run it via:
//
//   QA_CONFIG=qa/qa.live.config.mjs qa/run_autonomous_qa.sh --skip-review
//
// Shape + gating semantics are identical to qa.config.mjs (same generic engine in
// qa/orchestrator.mjs) — see QA_AUTOMATION_FLOW.md.
//
// ONE shared live session, not one rig per suite:
//   • `live-session` (FIRST — orchestrator runs suites in array order) launches the
//     3-party rig + detector once, runs all scenarios back-to-back, writes one NDJSON
//     verdict line per scenario to live/live-qa-results.ndjson, and prints
//     `LIVE SESSION COMPLETE` (the match).
//   • three READER suites grep the last line for their scenario via
//     qa/live-scenario-verdict.mjs and pass only on verdict PASS.
// No `minCount` on any live suite (INV-4 only demands CI/README baselines for suites
// that declare a minCount; these are live-only and absent from CI by design).
// ---------------------------------------------------------------------------

export default {
  suites: [
    {
      // Drives the whole live session; the reader suites depend on its NDJSON output.
      id: 'live-session',
      cwd: '.',
      cmd: 'node research/meet-dom-detector/live/run-live-qa.mjs --all',
      match: 'LIVE SESSION COMPLETE',
      timeoutMs: 20 * 60_000,
    },
    {
      // Every scripted speaker change produced a matching meet_edge within 800ms and
      // >=3 of 4 rapid swaps were caught (asserted inside run-live-qa.mjs; this reads
      // the recorded verdict).
      id: 'ax-events-live',
      cwd: '.',
      cmd: 'node qa/live-scenario-verdict.mjs ax-events-live',
      match: '"verdict":"PASS"',
    },
    {
      // eventCpu <= 0.6*pollingCpu AND event full_walks < 0.5*polling full_walks.
      id: 'cpu-compare-live',
      cwd: '.',
      cmd: 'node qa/live-scenario-verdict.mjs cpu-compare-live',
      match: '"verdict":"PASS"',
    },
    {
      // 3-party accuracy matrix holds in event mode (speaker >=0.6, non-speakers
      // <=0.3, overlap both >=0.5, silence <=0.3).
      id: 'regression-live',
      cwd: '.',
      cmd: 'node qa/live-scenario-verdict.mjs regression-live',
      match: '"verdict":"PASS"',
    },
    {
      // Meet TAB-AWAY KEEP-ALIVE (B4) — drives a real hosted Meet in a real-mic rig
      // Chrome, backgrounds the tab (Chrome throttles → the AX WebArea goes trivial),
      // and asserts the product detector's tab-away bridge HOLDS the meeting key open
      // instead of tripping idle hysteresis, then that LEAVE (the mic-idle path) closes
      // it. The product bubbles-mic-detector is spawned as the real OS-mic source and
      // its lines are transformed into the detector's stdin mic-hint protocol. Standalone
      // driver (not part of run-live-qa's roster rig); APPENDS per-phase + a roll-up line
      // to the same live-qa-results.ndjson. Requires MSD_DETECTOR_BIN/MSD_MIC_BIN pointed
      // at the product binaries.
      id: 'meet-tabaway-session',
      cwd: '.',
      cmd: 'node research/meet-dom-detector/live/meet-tabaway-live.mjs --tabaway',
      match: 'MEET TABAWAY LIVE SESSION COMPLETE',
      timeoutMs: 15 * 60_000,
    },
    {
      // Reads the aggregate roll-up (PASS only if all six phases passed).
      id: 'meet-tabaway-live',
      cwd: '.',
      cmd: 'node qa/live-scenario-verdict.mjs meet-tabaway-live',
      match: '"verdict":"PASS"',
    },
    {
      // Teams-WEB TAB-AWAY KEEP-ALIVE (G2b) — the live gate for un-gating
      // MSD_TEAMS_TABSTRIP (the Teams-web tab-away bridge adapter, bubbles-dev-tabaway
      // commit b789bd35, which SHIPS DARK until it has its own live rig scenario). The
      // NATIVE Teams app hosts a teams.live.com meeting; the rig Chrome joins as an
      // anonymous web guest, admitted from the native lobby (operator-driven — native
      // hosting/admit is not scriptable, so the driver prompts once for the meeting URL
      // or reads MSD_TEAMS_MEETING_URL / MSD_TEAMS_MEETING_URL_CAPONLY). Five phases
      // (detect, bg-throttle-cycle, longer-hold, leave-ends, cap-only) assert the REAL
      // keep-alive vocabulary (teams-keepalive: engaged … reason=tab_present mic=<…>;
      // released … reason=readable|left). Standalone driver; APPENDS per-phase + a
      // roll-up line to research/teams-web/teams-tabaway-results.ndjson. Requires
      // MSD_DETECTOR_BIN/MSD_MIC_BIN pointed at the product binaries.
      id: 'teams-tabaway-session',
      cwd: '.',
      cmd: 'node research/teams-web/teams-tabaway-live.mjs --tabaway',
      match: 'TEAMS TABAWAY LIVE SESSION COMPLETE',
      timeoutMs: 20 * 60_000,
    },
    {
      // Reads the aggregate roll-up (PASS only if all five phases passed). The second
      // arg points the reader at the Teams results file (the reader defaults to the Meet
      // results NDJSON).
      id: 'teams-tabaway-live',
      cwd: '.',
      cmd: 'node qa/live-scenario-verdict.mjs teams-tabaway-live research/teams-web/teams-tabaway-results.ndjson',
      match: '"verdict":"PASS"',
    },
    {
      // Zoom-WEB TAB-AWAY KEEP-ALIVE (G3b) — the live gate for un-gating MSD_ZOOM_TABSTRIP
      // (the Zoom-web tab-away bridge adapter macos/zoom/ZoomTabAway.swift, which SHIPS DARK
      // until it has its own live rig scenario). FULLY AUTONOMOUS: the signed-in NATIVE Zoom
      // app hosts a fresh instant meeting (qa/zoom-live/zoom-host-lib.mjs bootstrapMeeting/
      // harvestInvite/admitLoop — the same machinery the G3a sweep drove), the rig Chrome
      // joins as a web guest via /wc/, and the native waiting-room admit is scripted (no
      // operator prompts, unlike the Teams gate). Five phases (detect, bg-throttle-cycle,
      // longer-hold, leave-ends, cap-only) assert the REAL keep-alive vocabulary
      // (zoom-keepalive: engaged … reason=tab_present mic=<…>; released … reason=readable;
      // leave-ends accepts released reason=left|gone — Zoom's post-leave navigation-off-/wc/
      // terminator). Standalone driver; APPENDS per-phase + a roll-up line to
      // research/zoom-web/zoom-tabaway-results.ndjson. Requires MSD_DETECTOR_BIN/MSD_MIC_BIN
      // pointed at the product binaries.
      id: 'zoom-tabaway-session',
      cwd: '.',
      cmd: 'node research/zoom-web/zoom-tabaway-live.mjs --tabaway',
      match: 'ZOOM TABAWAY LIVE SESSION COMPLETE',
      timeoutMs: 20 * 60_000,
    },
    {
      // Reads the aggregate roll-up (PASS only if all five phases passed). The second arg
      // points the reader at the Zoom results file (the reader defaults to the Meet results
      // NDJSON).
      id: 'zoom-tabaway-live',
      cwd: '.',
      cmd: 'node qa/live-scenario-verdict.mjs zoom-tabaway-live research/zoom-web/zoom-tabaway-results.ndjson',
      match: '"verdict":"PASS"',
    },
  ],

  // Same blocker-tool object shape as qa.config.mjs: heal audio injection before the
  // live session needs it (primary BlackHole loopback → device-free getUserMedia
  // fallback). Not required, so its absence is a WARN in CI-less environments.
  tools: [
    {
      id: 'meet-audio-injection',
      description: 'Inject synthetic host/guest speech into a live Google Meet call',
      required: false,
      check: { cmd: 'bash research/meet-dom-detector/live/bh-loopback-check.sh', timeoutMs: 60_000 },
      fix:   { cmd: 'bash research/meet-dom-detector/live/bh-fix.sh', needsPrivilege: true, timeoutMs: 120_000 },
      fallback: {
        id: 'fake-audio-getusermedia',
        description: 'Device-free WAV-backed getUserMedia override (no virtual device, no AEC)',
        check: { cmd: 'node research/meet-dom-detector/live/gum-override-probe.js', timeoutMs: 120_000 },
      },
    },
  ],

  // Review already runs in the fast deterministic gate (INV-1..8); the live gate is
  // invoked with --skip-review. Kept here for parity so a manual full run still has a
  // review floor.
  review: {
    id: 'qa-check-review',
    cmd: 'node qa/review-check.mjs',
    required: true,
  },
};
