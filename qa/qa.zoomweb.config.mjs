// ---------------------------------------------------------------------------
// ZOOM WEB LIVE-QA manifest — the exit gate for the app.zoom.us (Chromium)
// event-driven speaker detector. Kept SEPARATE from qa/qa.config.mjs (the
// default, CI-safe manifest) so CI never launches the Zoom app / Chrome / the
// detector (INV-17 greps CI to enforce it). Run it via:
//
//   QA_CONFIG=qa/qa.zoomweb.config.mjs qa/run_autonomous_qa.sh --skip-review
//
// Shape + gating semantics are identical to qa.config.mjs / qa.zoom.config.mjs
// (same generic engine in qa/orchestrator.mjs) — see QA_AUTOMATION_FLOW.md.
//
// ONE shared live session:
//   • `zoomweb-live-session` (FIRST — the orchestrator runs suites in array
//     order) hosts a NATIVE Zoom meeting, joins a Chrome "Web Observer" (the
//     observed surface) + Guest Alpha / Guest Bravo web guests (all with
//     speech-gain gating), runs every scenario back-to-back, writes one NDJSON
//     verdict per scenario to qa/zoomweb-live/zoomweb-live-results.ndjson, and
//     prints `ZOOMWEB LIVE SESSION COMPLETE` (the match — printed on EVERY exit
//     path incl. pre-flight failure, so the reader suites always report a real
//     verdict).
//   • the READER suites grep the last line for their scenario via
//     qa/live-scenario-verdict.mjs and pass only on verdict PASS.
// No `minCount` on any live suite (INV-4 covers CI-baselined suites only; these
// are live-only, absent from CI by design).
//
// `tools: []` — the web guests' speech reaches the host's system audio output and
// the detector's system tap directly (no BlackHole loopback needed for REMOTE
// audio, same as the native Zoom + Teams live gates).
// ---------------------------------------------------------------------------

const RESULTS = 'qa/zoomweb-live/zoomweb-live-results.ndjson';

export default {
  suites: [
    {
      // Drives the whole live session; the reader suites depend on its NDJSON.
      id: 'zoomweb-live-session',
      cwd: '.',
      cmd: 'node qa/zoomweb-live/run-zoomweb-live-qa.mjs --all',
      match: 'ZOOMWEB LIVE SESSION COMPLETE',
      timeoutMs: 25 * 60_000,
    },
    {
      // Every scripted speaker change → a matching zoomweb_edge; rapid ~2.7s swap
      // block of 4 → >=3/4 caught. Raw per-swap dts + measured active-class linger
      // recorded for latency-bar + halfLife calibration.
      id: 'zoomweb-events-live',
      cwd: '.',
      cmd: `node qa/live-scenario-verdict.mjs zoomweb-events-live ${RESULTS}`,
      match: '"verdict":"PASS"',
    },
    {
      // Detection correct in speaker view, gallery view, and screen-share
      // filmstrip (view switched on the observer client). Share sub-block may
      // degrade to REVIEW with evidence; speaker + gallery must PASS.
      id: 'zoomweb-views-live',
      cwd: '.',
      cmd: `node qa/live-scenario-verdict.mjs zoomweb-views-live ${RESULTS}`,
      match: '"verdict":"PASS"',
    },
    {
      // Interleaved legacy/event A/B (pooled medians): eventCpu <= 0.6x polling
      // AND event full walks < 0.5x legacy (zoomweb_walk_stats). REVIEW = near-miss.
      id: 'cpu-compare-live',
      cwd: '.',
      cmd: `node qa/live-scenario-verdict.mjs cpu-compare-live ${RESULTS}`,
      match: '"verdict":"PASS"',
    },
    {
      // Unmuted-but-SILENT guest 60s → ZERO web speaker attribution (falsification).
      id: 'zoomweb-silence-live',
      cwd: '.',
      cmd: `node qa/live-scenario-verdict.mjs zoomweb-silence-live ${RESULTS}`,
      match: '"verdict":"PASS"',
    },
    {
      // Default-flip probe: MSD_MODE=legacy must be byte-silent AND no-env must run
      // event mode (2026-07-05 default flip: event-driven is the default everywhere,
      // legacy is the explicit opt-out).
      id: 'zoomweb-legacy-silent',
      cwd: '.',
      cmd: `node qa/live-scenario-verdict.mjs zoomweb-legacy-silent ${RESULTS}`,
      match: '"verdict":"PASS"',
    },
  ],

  // No blocker tools: web guests' speech reaches the detector's system tap through
  // the host's system output (proven with the Teams/Zoom guests). The mute/speak
  // matrix drives the guests, not the local mic, so no BlackHole is required.
  tools: [],

  // Review runs in the fast deterministic gate (INV-1..19); the live gate is
  // invoked with --skip-review. Kept for parity with a manual full run.
  review: {
    id: 'qa-check-review',
    cmd: 'node qa/review-check.mjs',
    required: true,
  },
};
