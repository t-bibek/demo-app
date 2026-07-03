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
