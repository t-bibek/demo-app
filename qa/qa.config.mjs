// ---------------------------------------------------------------------------
// Autonomous-QA manifest — the ONLY file most changes should touch.
//
// A future agent extends the flow by editing DATA here, never the engine:
//   • add a QA scenario/suite   -> append to `suites`
//   • add a blocker-tool + its  -> append to `tools` (each tool: check -> fix ->
//     recovery path                fallback chain; every fallback can itself have
//                                  check/fix/fallback)
//   • strengthen the review gate -> add invariants in qa/review-check.mjs
//
// The engine (qa/orchestrator.mjs) is generic: it reads this file, runs the
// phases, enforces the exit criteria, and prints a per-item pass/fail summary.
// All `cwd` paths are relative to the repo root. See QA_AUTOMATION_FLOW.md.
// ---------------------------------------------------------------------------

export default {
  // === QA suites ===========================================================
  // Gated on EXIT CODE (each suite already exits non-zero on any failure).
  //   match:    a RegExp string that MUST appear in stdout+stderr. Use a
  //             backreference — `(\\d+)/\\1 passed` asserts "N of N passed" for
  //             ANY N, so adding scenarios doesn't break it but a partial pass
  //             (33/34) does. Belt-and-suspenders over the exit code.
  //   minCount: if the match's first group is a number, assert it is >= this.
  //             Catches a suite that SILENTLY drops scenarios yet still exits 0
  //             (e.g. 34 -> 5, all "passing"). Also the single source of truth
  //             the review gate cross-checks against CI/README (see INV-4).
  suites: [
    {
      id: 'node-harness',
      cwd: 'research/meet-dom-detector',
      cmd: 'node test.js',
      match: '(\\d+)/\\1 passed',
      minCount: 23,
    },
    {
      id: 'browser-qa',
      cwd: 'research/meet-dom-detector',
      cmd: 'node browser-qa/run-browser-qa.js',
      match: '(\\d+)/\\1 scenarios passed',
      minCount: 34,
    },
    {
      id: 'swift-selftest',
      cwd: 'macos',
      cmd: 'swift run SpeakerCoreSelfTest',
      match: 'ALL PASSED',
      timeoutMs: 20 * 60_000, // first build can be slow
    },
    {
      // The Teams ring-probe (plan #1) verdict MATH, offline. Guards that the
      // analysis correctly classifies a synthetic ring trace (dark-when-silent =>
      // PASS, lit-when-silent => FAIL, ring-never-moved => inconclusive) so the
      // live falsification run can be trusted. No live session / Chrome needed.
      id: 'teams-ring-probe-analysis',
      cwd: '.',
      cmd: 'node qa/teams-live/probe-analysis.test.mjs',
      match: 'ALL PASSED',
    },
  ],

  // === Blocker tools (the "Blackbox" pattern) ==============================
  // A capability a test needs (here: injecting synthetic speech into a live
  // Meet). The engine runs `check`; on failure it runs `fix` and re-checks; if
  // still down it walks the `fallback` chain. Each node is {id?, check, fix?,
  // fallback?}. `fix.needsPrivilege` steps run ONLY with --allow-privileged
  // (so CI never sudo-prompts). A tool that ends DOWN fails the run only when
  // `required: true`; otherwise it's a WARN (live-only capability absent in CI).
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

  // === Independent review gate =============================================
  // A RUNNABLE check of the QA checks themselves (assertion quality / coverage /
  // baseline drift), not the product. Blocks when `required`. Swap `cmd` to wire
  // in an LLM-driven review; keep review-check.mjs as the deterministic floor.
  review: {
    id: 'qa-check-review',
    cmd: 'node qa/review-check.mjs',
    required: true,
  },
};
