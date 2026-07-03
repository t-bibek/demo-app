// ---------------------------------------------------------------------------
// Autonomous implement → QA → fix → review loop for the Meet event-driven
// ring/focus detector (see QA_AUTOMATION_FLOW.md § "Autonomous implement→QA→fix
// loop"). Deterministic JS orchestration; agents do the reasoning.
//
// Model routing: implement / fix / reviewer agents run on Opus (hard reasoning);
// QA-runner and report agents inherit the session model (mechanical work).
//
// Reuse:
//   args.planFile      — plan the agents implement/verify against (default below)
//   args.maxIters      — iteration cap (default 3)
//   args.skipImplement — true to skip Phase 1 and loop QA/fix/review on existing code
//
// Gates (both via the qa/ orchestrator, per QA_AUTOMATION_FLOW.md):
//   fast: qa/run_autonomous_qa.sh --skip-tools            (suites + review invariants)
//   live: QA_CONFIG=qa/qa.live.config.mjs qa/run_autonomous_qa.sh --skip-review
// Every phase appends one NDJSON line to qa/loop-log.ndjson.
// ---------------------------------------------------------------------------
export const meta = {
  name: 'event-driven-ring-qa-loop',
  description: 'Meet event-driven ring/focus: implement → QA → fix → review loop (capped iterations)',
  whenToUse: 'Autonomous implement/QA/fix/review loop for the Meet event-driven detector. Pass {skipImplement:true} to re-run QA/fix/review on existing code.',
  phases: [
    { title: 'Implement', detail: 'Swift hybrid observer + QA infra (two Opus agents, parallel)', model: 'opus' },
    { title: 'Fast QA', detail: 'qa/run_autonomous_qa.sh --skip-tools' },
    { title: 'Live QA', detail: '3-party rig: ax-events, cpu-compare, regression' },
    { title: 'Fix', detail: 'Opus fix agent on failure/gap reports', model: 'opus' },
    { title: 'Review', detail: 'Opus reviewer: QA-sufficiency gaps', model: 'opus' },
    { title: 'Report', detail: 'QA report from live results + loop log' },
  ],
}

const REPO = '/Users/bibekthapa/projects/work/demo-app'
const PLAN = (args && args.planFile) ||
  '/Users/bibekthapa/.claude/plans/task-implement-event-driven-ring-focus-velvety-pebble.md'
const MAX_ITERS = (args && args.maxIters) || 3

const LOG_HOWTO = (iteration, phaseName) =>
  `\n\nFinally, append exactly ONE NDJSON line to ${REPO}/qa/loop-log.ndjson (create the file if missing) recording the outcome: ` +
  `{"iteration":${iteration},"phase":"${phaseName}","verdict":"<pass|fail|done|gaps>","failures":[<ids or short strings>],"ts":<unix seconds from date +%s>} ` +
  `— build it with node -e or printf; it must be valid single-line JSON.`

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    buildGreen: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['summary', 'filesChanged', 'buildGreen'],
}
const QA_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    failingSuites: { type: 'array', items: { type: 'string' } },
    rawTail: { type: 'string' },
    resultsNdjson: { type: 'string' },
  },
  required: ['verdict', 'failingSuites', 'rawTail'],
}
const REV_SCHEMA = {
  type: 'object',
  properties: {
    sufficient: { type: 'boolean' },
    gaps: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
  required: ['sufficient', 'gaps', 'rationale'],
}

const journal = []
const note = (e) => {
  journal.push(e)
  const extra = e.failures && e.failures.length ? ' — ' + e.failures.slice(0, 4).join('; ') : ''
  log(`[iter ${e.iteration}] ${e.phase}: ${e.verdict}${extra}`)
}

// ---------------------------------------------------------------- Phase 1
if (!(args && args.skipImplement)) {
  phase('Implement')
  const [sw, qi] = await parallel([
    () => agent(
      `You are the implementation agent for the Meet event-driven detector change.\n` +
      `FIRST read ${REPO}/.claude/MEET-AX-STRUCTURE-HANDOFF.md — it is the freshest live-verified AX ground truth and OVERRIDES older docs. Critical corrections it contains: (1) equalizer level-classes ARE in AX (gjg47c silent vs level tokens on DYfzY/IisKdb nodes) — subscribe equalizer-anchor nodes in the observer too and emit their transitions as edges (per-utterance signal); attribution of an equalizer node to a tile must be whole-tree-scan + geometry-to-nearest-tile (the host's own meter is NOT nested under a tile), and anchor on absence-of-gjg47c, never a specific level token; (2) AXFocused is NOT a speaker signal — still emit focus-moved edges but do not elevate focus attribution above its current chain position; (3) activate→settle→read (never same-tick) for AX materialization; event mode should activate less often than every tick (around reconcile/subscription) without regressing detection.\n` +
      `Then read the approved plan at ${PLAN} and implement its "Implementation design (macOS Swift)" section EXACTLY, steps 1–8, in ${REPO} (the plan's "Corrections" section reconciles it with the handoff). Key hard requirements:\n` +
      `- Use the EXACT new file paths named in the plan — QA review invariants grep them: macos/Sources/AXKit/AXKit.swift, macos/Sources/SpeakerCore/TransitionConfidence.swift, macos/Sources/SpeakerCore/MeetEdgeEvents.swift, macos/Sources/MeetSpeakerDetector/Engine/MeetTileObserver.swift, macos/Tests/SpeakerCoreTests/TransitionConfidenceTests.swift.\n` +
      `- Flag-gated: with no env vars set, behavior must be byte-for-byte legacy 500ms polling. MSD_MODE=event enables the observer path AND implies the Meet sub-walk short-circuit in scan() (skipMeetInFullScan) unless MSD_SKIP_MEET_FULLSCAN=0 — the live CPU-compare suite depends on event mode actually eliminating the expensive Meet sub-walks. MSD_MODE=legacy (or unset) must keep full_walks counting per scan() so the A/B baseline works (review invariant INV-8 checks both values are handled).\n` +
      `- Instrumentation NDJSON exactly per plan: meet_edge (kind/from/to/confidence/mono_ts), meet_walk_stats (full_walks/subtree_reads/edges/reconcile_repairs/walks_per_min, emitted per reconcile AND on stop, counting in BOTH modes), meet_observer lifecycle. Honor MSD_RUN_SECONDS (clean auto-exit after N seconds) and MSD_EDGE_LOG (edge events also appended to this file; keep stdout mirroring).\n` +
      `- TransitionConfidence: pure and time-injected — no Date()/DispatchTime.now()/CACurrentMediaTime/mach_absolute_time anywhere inside SpeakerCore logic (INV-6 greps for these); monotonicMs() lives outside SpeakerCore (app target or AXKit). Math and defaults exactly per plan (spike 1.0, floor 0.25, halfLife 1200ms).\n` +
      `- meetActiveSpeaker: additive defaulted transition: param; transition:nil must be behavior-identical (all existing self-tests pass unchanged). New via case .ringTransition MUST get a "via, .ringTransition" assertion in SpeakerCoreSelfTest (INV-2 auto-derives required coverage from the MeetSpeakerSignal enum).\n` +
      `- Self-exclusion (!isMe / isMe == false) on every new attribution path — INV-5 greps MeetActiveSpeaker.swift and MeetEdgeEvents.swift for it — including a self-focus-edge-yields-no-name self-test.\n` +
      `- Add ALL self-tests from the plan's "Self-test additions" (decay values t=0/halfLife/infinity, non-holder zero, monotonic non-increase, holder-switch re-spike, rapid-swap disambiguation incl. the transition:nil non-regression twin, meetEdgesFromDiff cases).\n` +
      `After each plan step run, in ${REPO}/macos: swift build && swift run SpeakerCoreSelfTest — must print ALL PASSED before you proceed to the next step. Never regress an existing test.\n` +
      `Work ONLY under macos/. Do not commit. Do not run the live rig or the qa/ orchestrator (the loop does that).` +
      LOG_HOWTO(0, 'implement-swift') +
      `\nThen, as your VERY LAST action, call the StructuredOutput tool with: summary, filesChanged, buildGreen (true only if the final build + self-test are green), notes (anything the QA/fix agents must know). Do not end your turn without calling it.`,
      { label: 'implement-swift', phase: 'Implement', model: 'opus', schema: IMPL_SCHEMA }),
    () => agent(
      `You are the QA-infrastructure implementation agent for the Meet event-driven detector change.\n` +
      `FIRST read ${REPO}/.claude/MEET-AX-STRUCTURE-HANDOFF.md (especially §9 rig gotchas: admit is two-step toast-then-People-panel-row, guests cannot mute guests, Chrome pins the mic device at admit). Then read the approved plan at ${PLAN} and implement its "QA design" + "Orchestration harness" documentation items in ${REPO}. Do NOT touch macos/ (a parallel agent owns it) and do NOT edit qa/qa.config.mjs (the default manifest must stay CI-safe).\n` +
      `Deliverables:\n` +
      `1. 3-party rig with scripted turns: a 3-party rig ALREADY EXISTS — research/meet-dom-detector/live/roster-rig-3p.js (host + Guest Alpha + Guest Bravo, distinct fake voices, ports 9224/9226/9227, reuses signed-in .rig-profiles). Extend IT (in place or via a thin driver module it exports to) with the scripted speech-turn sequence: SILENCE, HOST(8s), ALPHA(8s, ring appears), BRAVO(8s, ring MUST MOVE), RAPID SWAP Alpha(2s)>Bravo(2s)>Alpha(2s)>Bravo(2s), OVERLAP Alpha+Bravo(8s), SILENCE — reusing the per-seat speech gating + cross-observation turn logic from fake-audio-rig.js. Write swaps:[{from,to,tSpeakStart}] timestamps into a results JSON and generalize cross-observation to the 3-way matrix (each observer page records the fraction of polls it named each OTHER participant). If a guest fails to admit (Meet throttle), degrade to 2-party with verdict REVIEW, not FAIL. Preserve every encoded gotcha. Only touch fake-audio-rig.js / make-fake-speech.sh / admit-guest.js if the 3p rig is actually missing a needed capability (check what voices/WAVs it already generates before adding any).\n` +
      `2. research/meet-dom-detector/live/run-live-qa.mjs (new): shared-session runner per plan — pre-flight Accessibility trust (fail fast with a clear "grant Accessibility permission" message), run swift build --package-path macos BEFORE any timed window, launch the rig once, then scenarios: ax-events-live (correlate detector meet_edge events from the MSD_EDGE_LOG file against scripted swaps; every speaker change matched within 800ms; >=3 of 4 rapid swaps caught), cpu-compare-live (launch detector with MSD_MODE=legacy then MSD_MODE=event, 90s steady GUEST1-speaks window each, back-to-back; sample ps -o %cpu= -p <detector pid> every 2s, use the MEDIAN; parse meet_walk_stats; PASS iff eventCpu <= 0.6*pollingCpu AND event full_walks < 0.5*polling full_walks; within 10% of a threshold => verdict REVIEW; always record raw samples), regression-live (3-party accuracy matrix in event mode: expected speaker seen >=0.6 by others, non-speakers <=0.3, overlap both >=0.5, silence <=0.3). Write one NDJSON verdict line per scenario to research/meet-dom-detector/live/live-qa-results.ndjson and print LIVE SESSION COMPLETE at the end (the orchestrator matches on it).\n` +
      `3. qa/qa.live.config.mjs (new): live manifest per plan — suite live-session FIRST (cmd: node research/meet-dom-detector/live/run-live-qa.mjs --all, match 'LIVE SESSION COMPLETE', timeoutMs 20*60_000), then reader suites ax-events-live / cpu-compare-live / regression-live that each read the LAST line for their scenario from live-qa-results.ndjson and exit 0 only on verdict PASS (match on '\"verdict\":\"PASS\"'). NO minCount on live suites. Reuse the audio-injection blocker-tool object shape from qa/qa.config.mjs. Validate the manifest shape against qa/orchestrator.mjs's config validation so it can't exit 2.\n` +
      `4. qa/review-check.mjs: append guards INV-5 (event self-exclusion: macos/Sources/SpeakerCore/MeetActiveSpeaker.swift + macos/Sources/SpeakerCore/MeetEdgeEvents.swift filter isMe, and a self-focus-edge self-test exists in SpeakerCoreSelfTest), INV-6 (macos/Sources/SpeakerCore/TransitionConfidence.swift has no Date()/DispatchTime.now/CACurrentMediaTime/mach_absolute_time after comment stripping, and a decay self-test exists), INV-7 (.github/workflows/meet-detector-qa.yml does NOT reference qa.live.config.mjs), INV-8 (engine source handles both MSD_MODE=event and legacy). Follow the existing guard()/pass()/fail() style. The Swift files are being written by a parallel agent — write the guards against those exact paths; a missing file must FAIL the guard with a clear message, not crash the review script.\n` +
      `5. QA_AUTOMATION_FLOW.md: add a section "Autonomous implement→QA→fix loop (multi-agent)" documenting the workflow script at .claude/workflows/event-driven-ring-qa-loop.mjs, the two gates (fast: qa/run_autonomous_qa.sh --skip-tools; live: QA_CONFIG=qa/qa.live.config.mjs qa/run_autonomous_qa.sh --skip-review), qa/loop-log.ndjson line format, the iteration cap, Opus/Fable model routing, and how to re-run (args: planFile, maxIters, skipImplement).\n` +
      `Do NOT launch the live rig or full live QA (that is the loop's QA phase). Smoke-check node --check on every JS file you touch.` +
      LOG_HOWTO(0, 'implement-qa') +
      `\nThen, as your VERY LAST action, call the StructuredOutput tool with: summary, filesChanged, buildGreen (true iff all node --check pass and the needed WAVs exist), notes. Do not end your turn without calling it.`,
      { label: 'implement-qa', phase: 'Implement', model: 'opus', schema: IMPL_SCHEMA }),
  ])
  note({ iteration: 0, phase: 'implement-swift', verdict: sw ? (sw.buildGreen ? 'done' : 'done-build-red') : 'agent-error', failures: [] })
  note({ iteration: 0, phase: 'implement-qa', verdict: qi ? (qi.buildGreen ? 'done' : 'done-build-red') : 'agent-error', failures: [] })
}

// ---------------------------------------------------------------- Loop
const fastGatePrompt = (iter) =>
  `QA runner (deterministic gate), iteration ${iter}. Repo: ${REPO}.\n` +
  `Run from the repo root: qa/run_autonomous_qa.sh --skip-tools\n` +
  `swift-selftest may compile for several minutes on a cold build — if the command may exceed ~9 minutes, run it in the background and wait for completion. Capture the full output.\n` +
  `verdict = 'pass' iff the exit code is 0. Do NOT fix anything.` +
  LOG_HOWTO(iter, 'qa-deterministic') +
  `\nReturn: verdict, failingSuites (ids of failing suites/invariants from the summary, [] if pass), rawTail (last ~100 output lines verbatim).`

const liveGatePrompt = (iter) =>
  `QA runner (LIVE exit gate), iteration ${iter}. Repo: ${REPO}.\n` +
  `This launches 3 Chrome windows plus the detector app on-screen, unattended — expected and pre-approved.\n` +
  `Run from the repo root IN THE BACKGROUND (takes 10–20 min) and wait for completion:\n` +
  `QA_CONFIG=qa/qa.live.config.mjs qa/run_autonomous_qa.sh --skip-review\n` +
  `verdict = 'pass' iff the exit code is 0. Then read research/meet-dom-detector/live/live-qa-results.ndjson and return its FULL contents as resultsNdjson.\n` +
  `If rig Chrome processes linger after a failure (remote-debugging ports 9224/9225/9226), kill them so the next iteration starts clean. Do NOT fix anything.` +
  LOG_HOWTO(iter, 'qa-live') +
  `\nReturn: verdict, failingSuites, rawTail (last ~120 output lines verbatim), resultsNdjson.`

const fixPrompt = (iter, what, payload) =>
  `You are the fix agent (iteration ${iter}) for the Meet event-driven detector change. Plan: ${PLAN}. Repo: ${REPO}.\n` +
  `${what} FAILED. Failure report:\n${payload}\n` +
  `Diagnose the ROOT CAUSE and fix it minimally, staying consistent with the plan (hybrid observer + reconciliation sweep, pure time-injected confidence, flag-gated legacy default, CI-safe default manifest). Product code, tests, QA infra, or the live rig may be at fault — fix whichever actually is. Do not weaken assertions or thresholds just to pass unless they are genuinely wrong per the plan (justify in notes if so).\n` +
  `Verify locally before finishing: swift build + swift run SpeakerCoreSelfTest green (in macos/) if you touched Swift; node --check on any JS touched. Do NOT run the full QA gates — the loop reruns them.` +
  LOG_HOWTO(iter, 'fix') +
  `\nReturn: summary, filesChanged, buildGreen, notes.`

const reviewerPrompt = (iter, live) =>
  `Independent reviewer: assess whether the QA that just passed is SUFFICIENT — you review the QA, not the product. Plan: ${PLAN}. Repo: ${REPO}.\n` +
  `Read: ${REPO}/.claude/MEET-AX-STRUCTURE-HANDOFF.md (AX ground truth — e.g. AXFocused is NOT a speaker signal; equalizer level-classes ARE in AX), git status + git diff (uncommitted implementation), macos/Sources/SpeakerCoreSelfTest/main.swift (new test blocks), qa/qa.live.config.mjs, research/meet-dom-detector/live/run-live-qa.mjs (what live QA actually asserts), qa/review-check.mjs (INV-5..8), and the live results below.\n` +
  `Hunt specifically for: (1) decay-timing edges — stickiness boundary just-before/just-after, re-spike during decay, decay across holder switch; (2) missed transition types — ring gained-from-none, ring lost-to-none, focus/ring disagreement, reconciliation-disagrees-with-last-edge self-heal; (3) races between observer callbacks — out-of-order callbacks, edge arriving during the reconciliation sweep, observer restart with edges pending (these need PURE self-tests; they cannot be proven live); (4) live-QA blind spots — assertions that can pass vacuously (zero edges AND zero walks), REVIEW verdicts silently treated as pass, cpu-compare sampling the wrong process.\n` +
  `A gap is UNRESOLVED only if it is a realistic risk not covered by any existing test or invariant. Each gap must name the missing test/assertion and where it should live.\n` +
  `Live results NDJSON:\n${live.resultsNdjson || '(missing)'}` +
  LOG_HOWTO(iter, 'review') +
  `\nReturn: sufficient (true iff no unresolved gaps), gaps, rationale.`

let iter = 0
let status = 'ITER_CAP'
let lastLive = null
let lastReview = null

while (iter < MAX_ITERS) {
  const det = await agent(fastGatePrompt(iter), { label: `fast-qa#${iter}`, phase: 'Fast QA', effort: 'low', schema: QA_SCHEMA })
  note({ iteration: iter, phase: 'qa-deterministic', verdict: det ? det.verdict : 'agent-error', failures: det ? det.failingSuites : [] })
  if (!det || det.verdict !== 'pass') {
    iter++
    if (iter >= MAX_ITERS) break
    const payload = det ? JSON.stringify({ failingSuites: det.failingSuites, rawTail: det.rawTail }, null, 2) : 'QA runner agent died; rerun and inspect manually.'
    const fx = await agent(fixPrompt(iter, 'The deterministic QA gate (qa/run_autonomous_qa.sh --skip-tools)', payload),
      { label: `fix#${iter}`, phase: 'Fix', model: 'opus', schema: IMPL_SCHEMA })
    note({ iteration: iter, phase: 'fix', verdict: fx ? 'done' : 'agent-error', failures: det ? det.failingSuites : [] })
    continue
  }

  const live = await agent(liveGatePrompt(iter), { label: `live-qa#${iter}`, phase: 'Live QA', schema: QA_SCHEMA })
  lastLive = live
  note({ iteration: iter, phase: 'qa-live', verdict: live ? live.verdict : 'agent-error', failures: live ? live.failingSuites : [] })
  if (!live || live.verdict !== 'pass') {
    iter++
    if (iter >= MAX_ITERS) break
    const payload = live ? JSON.stringify({ failingSuites: live.failingSuites, rawTail: live.rawTail, results: live.resultsNdjson }, null, 2) : 'Live QA runner agent died; rerun and inspect manually.'
    const fx = await agent(fixPrompt(iter, 'The LIVE QA exit gate (QA_CONFIG=qa/qa.live.config.mjs)', payload),
      { label: `fix#${iter}`, phase: 'Fix', model: 'opus', schema: IMPL_SCHEMA })
    note({ iteration: iter, phase: 'fix', verdict: fx ? 'done' : 'agent-error', failures: live ? live.failingSuites : [] })
    continue
  }

  const rev = await agent(reviewerPrompt(iter, live), { label: `review#${iter}`, phase: 'Review', model: 'opus', schema: REV_SCHEMA })
  lastReview = rev
  note({ iteration: iter, phase: 'review', verdict: rev && rev.sufficient ? 'pass' : 'gaps', failures: rev ? rev.gaps : ['reviewer agent died'] })
  if (rev && rev.sufficient) { status = 'GREEN'; break }
  iter++
  if (iter >= MAX_ITERS) break
  const fx = await agent(fixPrompt(iter, 'The reviewer flagged QA-sufficiency gaps (close them: add the missing tests/assertions)', JSON.stringify(rev ? rev.gaps : ['reviewer agent died'], null, 2)),
    { label: `fix#${iter}`, phase: 'Fix', model: 'opus', schema: IMPL_SCHEMA })
  note({ iteration: iter, phase: 'fix', verdict: fx ? 'done' : 'agent-error', failures: rev ? rev.gaps : [] })
}

// ---------------------------------------------------------------- Report
phase('Report')
const reportOut = await agent(
  `Generate the final QA report for the Meet event-driven detector loop. Repo: ${REPO}. Plan: ${PLAN}. Loop status: ${status} after ${iter + 1 > MAX_ITERS ? MAX_ITERS : iter + 1} iteration(s).\n` +
  `Read qa/loop-log.ndjson (full loop history), research/meet-dom-detector/live/live-qa-results.ndjson (per-scenario live results incl. raw CPU samples), and the reviewer verdict: ${lastReview ? JSON.stringify({ sufficient: lastReview.sufficient, gaps: lastReview.gaps }) : '(no reviewer ran)'}.\n` +
  `Write docs/qa-report-event-driven-2026-07.md: per-scenario pass/fail table, CPU/walk-count comparison table with RAW numbers (pollingCpu, eventCpu, ratio, full_walks both modes), edge-latency stats (per scripted swap), rapid-swap catch rate, 3-party accuracy matrix, reviewer verdict + any gaps, iteration history, and how to re-run each gate. If status is not GREEN, title it as a STATUS report and lead with what is still failing and why.\n` +
  `Also append the final NDJSON line to qa/loop-log.ndjson: {"phase":"exit","verdict":"${status}","iteration":${iter},"ts":<unix seconds>}.\n` +
  `Return a <=20-line plain-text summary of the report.`,
  { label: 'report', phase: 'Report', effort: 'low' })

return { status, iterationsUsed: Math.min(iter + 1, MAX_ITERS), journal, reportSummary: reportOut }
