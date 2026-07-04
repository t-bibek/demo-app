// ---------------------------------------------------------------------------
// LIVE-QA manifest — the exit gate for NATIVE Zoom (us.zoom.xos) speaker/
// participant detection. Kept SEPARATE from qa/qa.config.mjs (the default,
// CI-safe manifest) so CI never launches the Zoom app / Chrome / the detector.
// Run it via:
//
//   QA_CONFIG=qa/qa.zoom.config.mjs qa/run_autonomous_qa.sh --skip-review
//
// Shape + gating semantics are identical to qa.config.mjs / qa.live.config.mjs
// (same generic engine in qa/orchestrator.mjs) — see QA_AUTOMATION_FLOW.md.
//
// ONE shared live session:
//   • `zoom-live-session` (FIRST — orchestrator runs suites in array order)
//     starts a native Zoom meeting (ZoomDrive: New meeting → Start), admits a
//     web-client guest from the waiting room, runs all scenarios back-to-back,
//     writes one NDJSON verdict line per scenario to
//     qa/zoom-live/zoom-live-results.ndjson, and prints `ZOOM LIVE SESSION
//     COMPLETE` (the match — printed on EVERY path incl. pre-flight failure, so
//     the reader suites always report a real verdict).
//   • the READER suites grep the last line for their scenario via
//     qa/live-scenario-verdict.mjs and pass only on verdict PASS.
// No `minCount` on any live suite (INV-4 only demands CI/README baselines for
// suites that declare one; these are live-only, absent from CI by design).
//
// The remote guest's fake-device tone plays through the host's system output and
// the detector's system tap hears it — no BlackHole needed for REMOTE audio
// (unlike Meet). Only SELF-mic speech would need a real input device; the
// mute-gate scenarios drive the guest, so no blocker tool is required here.
// ---------------------------------------------------------------------------

const RESULTS = 'qa/zoom-live/zoom-live-results.ndjson';

export default {
  suites: [
    {
      // Drives the whole live session; the reader suites depend on its NDJSON.
      id: 'zoom-live-session',
      cwd: '.',
      cmd: 'node qa/zoom-live/run-zoom-live-qa.mjs --all',
      match: 'ZOOM LIVE SESSION COMPLETE',
      timeoutMs: 20 * 60_000,
    },
    {
      // meeting_initialized (zoom::meeting) + participant_joined for self
      // (is_local, real "(me)" name) and the admitted guest.
      id: 'zoom-detect-live',
      cwd: '.',
      cmd: `node qa/live-scenario-verdict.mjs zoom-detect-live ${RESULTS}`,
      match: '"verdict":"PASS"',
    },
    {
      // Roster is EXACTLY {self, guest} with the panel open; no name outside that
      // set ever joins (home-shell / panel-header leak → FAIL).
      id: 'zoom-roster-live',
      cwd: '.',
      cmd: `node qa/live-scenario-verdict.mjs zoom-roster-live ${RESULTS}`,
      match: '"verdict":"PASS"',
    },
    {
      // Guest unmuted + tone → speech_on {guest, zoom.mute_gate}; guest muted →
      // no speech_on names the guest (the mute-gate spine).
      id: 'zoom-mutegate-live',
      cwd: '.',
      cmd: `node qa/live-scenario-verdict.mjs zoom-mutegate-live ${RESULTS}`,
      match: '"verdict":"PASS"',
    },
    {
      // Panel closed: tile overlays persist but "(me)" doesn't, so a 2-unmuted
      // call is honest "Someone" (audio.someone) — never a fabricated name.
      id: 'zoom-panelclosed-live',
      cwd: '.',
      cmd: `node qa/live-scenario-verdict.mjs zoom-panelclosed-live ${RESULTS}`,
      match: '"verdict":"PASS"',
    },
    {
      // PIP background coverage (plan C3/B1): the main meeting window is degraded
      // (unfocused, then minimized if unfocus alone doesn't spawn the PIP — the
      // ACTUAL trigger is recorded); PIP "Talking:" edges (zoom.pip / zoom.pip.edge)
      // must still name the speaker. REVIEW if this Zoom build never shows a PIP.
      id: 'pip-background-live',
      cwd: '.',
      cmd: `node qa/live-scenario-verdict.mjs pip-background-live ${RESULTS}`,
      match: '"verdict":"PASS"',
    },
    {
      // VAD quality (plan C3/B4): a tone/noise burst with speech OFF must NOT name
      // the guest (energy != voice); real fake-speech MUST. Raw levels recorded.
      id: 'vad-quality-live',
      cwd: '.',
      cmd: `node qa/live-scenario-verdict.mjs vad-quality-live ${RESULTS}`,
      match: '"verdict":"PASS"',
    },
  ],

  // No blocker tools: the guest's fake-device tone reaches the detector's system
  // tap through system output (proven with the Teams guest); the mute-gate
  // scenarios drive the guest, not the local mic, so no BlackHole is needed.
  tools: [],

  // Review runs in the fast deterministic gate (INV-1..8); the live gate is
  // invoked with --skip-review. Kept for parity with a manual full run.
  review: {
    id: 'qa-check-review',
    cmd: 'node qa/review-check.mjs',
    required: true,
  },
};
