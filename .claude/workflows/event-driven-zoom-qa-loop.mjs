// ---------------------------------------------------------------------------
// Autonomous implement → QA → fix → review loop for the ZOOM (web + native)
// event-driven speaker detection change. Adapted from
// event-driven-ring-qa-loop.mjs (the Meet loop that went GREEN 2026-07-04).
// Deterministic JS orchestration; agents do the reasoning.
//
// Model routing: implement / fix / reviewer agents run on Opus (hard
// reasoning); QA-runner and report agents inherit the session model.
//
// Reuse:
//   args.planFile      — plan the agents implement/verify against (default below)
//   args.maxIters      — iteration cap (default 3)
//   args.skipImplement — true to skip Phase 1 and loop QA/fix/review on existing code
//
// Gates (all via the qa/ orchestrator):
//   fast:        qa/run_autonomous_qa.sh --skip-tools     (suites + review invariants)
//   live native: QA_CONFIG=qa/qa.zoom.config.mjs    qa/run_autonomous_qa.sh --skip-review
//   live web:    QA_CONFIG=qa/qa.zoomweb.config.mjs qa/run_autonomous_qa.sh --skip-review
//   regression:  QA_CONFIG=qa/qa.live.config.mjs    qa/run_autonomous_qa.sh --skip-review (Meet live)
// Every phase appends one NDJSON line to qa/loop-log.ndjson.
// ---------------------------------------------------------------------------
export const meta = {
  name: 'event-driven-zoom-qa-loop',
  description: 'Zoom web+native event-driven detection: implement → QA → fix → review loop (capped iterations)',
  whenToUse: 'Autonomous implement/QA/fix/review loop for the Zoom event-driven detector. Pass {skipImplement:true} to re-run QA/fix/review on existing code.',
  phases: [
    { title: 'Implement', detail: 'Swift hybrid observers + VAD, QA rigs + manifests (two Opus agents, parallel)', model: 'opus' },
    { title: 'Fast QA', detail: 'qa/run_autonomous_qa.sh --skip-tools' },
    { title: 'Live QA', detail: 'zoom native gate + zoom web gate + Meet live regression (serialized)' },
    { title: 'Fix', detail: 'Opus fix agent on failure/gap reports', model: 'opus' },
    { title: 'Review', detail: 'Opus reviewer: QA-sufficiency + calibration adjudication', model: 'opus' },
    { title: 'Report', detail: 'docs/qa-report-zoom-event-driven.md from live results + loop log' },
  ],
}

const REPO = '/Users/bibekthapa/projects/work/demo-app/.claude/worktrees/zoom-native-hardening'
// args may arrive as a JSON-encoded string depending on the caller — coerce.
const A = (() => { try { return typeof args === 'string' ? JSON.parse(args) : (args || {}) } catch { return {} } })()
const PLAN = A.planFile || '/Users/bibekthapa/.claude/plans/zoom-event-driven-implementation.md'
const MAX_ITERS = A.maxIters || 3

const LOG_HOWTO = (iteration, phaseName) =>
  `\n\nFinally, append exactly ONE NDJSON line to ${REPO}/qa/loop-log.ndjson (create if missing) recording the outcome: ` +
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
if (!A.skipImplement) {
  phase('Implement')
  const [sw, qi] = await parallel([
    () => agent(
      `You are the Swift implementation agent for the ZOOM (web + native) event-driven detector change.\n` +
      `Repo (git worktree — work ONLY here, never cd to the primary repo): ${REPO}. Branch zoom-event-driven is already checked out.\n` +
      `FIRST read, in order: (1) the plan at ${PLAN} — it is your contract, including the "Existing infrastructure to reuse" section with exact verified signatures; (2) ${REPO}/.claude/CHROMIUM-AX-NOTIFICATIONS.md (class flips are AX-silent — bounded diffs are the PRIMARY edge source, AXObserver is wake-ups only); (3) ${REPO}/docs/zoom-native-detection.md (native has NO tile speaking signal — do not chase one; side channels only).\n` +
      `Implement the plan's Part A (Zoom web) and Part B (Zoom native + shared VAD) EXACTLY. Key hard requirements:\n` +
      `- EXACT new file paths (QA review invariants grep them): macos/Sources/SpeakerCore/ZoomWebEdgeEvents.swift, macos/Sources/SpeakerCore/ZoomNativeEdgeEvents.swift, macos/Sources/SpeakerCore/VoiceActivity.swift, macos/Sources/MeetSpeakerDetector/Engine/ZoomWebTileObserver.swift, macos/Sources/MeetSpeakerDetector/Engine/ZoomNativeObserver.swift.\n` +
      `- Flag-gated: with no env vars set, Zoom behavior must be byte-for-byte legacy (zero zoom observer/edge NDJSON output — a live scenario probes this at runtime). MSD_MODE=event enables the Zoom web observer path (same flag as Meet) and implies skipping the legacy zoom-web full sub-walk unless MSD_SKIP_ZOOMWEB_FULLSCAN=0. Legacy mode must keep counting full_walks so the CPU A/B baseline works.\n` +
      `- Instrumentation NDJSON: zoomweb_edge {kind,from,to,confidence,mono_ts,wall_ts}, zoomweb_walk_stats {full_walks,subtree_reads,edges,reconcile_repairs,...} emitted per reconcile AND on stop in BOTH modes, zoomweb_observer lifecycle; zoom_edge (native talking-changed) + zoom_walk_stats for native. Honor MSD_RUN_SECONDS and MSD_EDGE_LOG (edges appended there too; keep stdout mirroring). Stale-selector forensics: zero tile match while in-call ⇒ ONE rate-limited zoomweb_selector_dump line with per-selector presence + per-tile class chains.\n` +
      `- Purity (invariant greps): NO Date()/DispatchTime.now/CACurrentMediaTime/mach_absolute_time inside SpeakerCore (VoiceActivity.swift, ZoomWebEdgeEvents.swift, ZoomNativeEdgeEvents.swift are all time-injected; clock = AXKit.monotonicMs() injected by the engine).\n` +
      `- Self-exclusion at snapshot-BUILD level (Meet/Teams pattern) on every new attribution path — a self-active tile or self PIP "Talking:" NEVER becomes an edge holder; add the corresponding self-tests.\n` +
      `- TransitionConfidence: reuse the existing pure type with a Zoom-specific config; halfLife will be calibrated from the live-measured class linger (start at 1200ms; leave the constant clearly named + env-overridable so the fix agent can calibrate with justification).\n` +
      `- VAD (plan B4): pure SchmittVad in SpeakerCore (RMS 50ms frames, enter >high for >=2 frames, exit <low sustained >=400ms hangover), meters gain RMS accumulation, engine swaps the peak gates for SchmittVad booleans — SAME downstream booleans; default ON with MSD_VAD=peak escape hatch; env MSD_VAD_ENTER/MSD_VAD_EXIT/MSD_VAD_HANGOVER_MS.\n` +
      `- Native (plan B1–B3): PIP "Talking:" talking-changed edges + native TransitionConfidence (source "zoom.pip.edge" only in event mode; legacy "zoom.pip" preserved); ZoomNativeObserver with AXTitleChanged/AXWindowCreated/AXUIElementDestroyed wake-ups + DEFENSIVE menu tier (Zoom 7.0.5 showed no persistent Meeting menu — subscribe only if present at runtime, emit an NDJSON note either way, degrade gracefully); bounded per-tick subtree reads with cached anchors + 4s full reconcile in event mode, byte-identical full walks in legacy.\n` +
      `- ZoomSpeakerRules: append the new web class-anchor fields + locale-table support per plan A2/B5; every existing zoom-rules.json must still decode (partial-override back-compat); add rules round-trip/partial/locale self-tests.\n` +
      `- Add ALL self-tests from plan A5/B1/B4/B5 to macos/Sources/SpeakerCoreSelfTest/main.swift (append blocks; never regress an existing test).\n` +
      `After each major step run, in ${REPO}/macos: swift build && swift run SpeakerCoreSelfTest — must print ALL PASSED before proceeding (cold builds can take minutes — run long commands in the background and wait).\n` +
      `Work ONLY under macos/. Do NOT commit. Do NOT run the live rigs or the qa/ orchestrator (the loop does that).` +
      LOG_HOWTO(0, 'implement-swift') +
      `\nThen, as your VERY LAST action, call the StructuredOutput tool with: summary, filesChanged, buildGreen (true only if the final build + self-test are green), notes (anything the QA/fix agents must know — especially any deliberate deviation from the plan and why). Do not end your turn without calling it.`,
      { label: 'implement-swift', phase: 'Implement', model: 'opus', schema: IMPL_SCHEMA }),
    () => agent(
      `You are the QA-infrastructure implementation agent for the ZOOM (web + native) event-driven detector change.\n` +
      `Repo (git worktree — work ONLY here): ${REPO}. Branch zoom-event-driven is already checked out.\n` +
      `FIRST read: (1) the plan at ${PLAN} — especially Part C and the "QA harness contracts (verified — follow exactly)" + "Known rig facts" sections; (2) ${REPO}/qa/zoom-live/run-zoom-live-qa.mjs and ${REPO}/qa/zoom-live/zoom-web-guest.mjs (the proven native rig you extend + web-guest join you reuse); (3) ${REPO}/research/meet-dom-detector/live/run-live-qa.mjs (the interleaved CPU A/B + edge-correlation implementation to mirror) and ${REPO}/research/meet-dom-detector/live/fake-mic-override.js (__fakeMicSpeak speech-gain gating).\n` +
      `Do NOT touch macos/ (a parallel agent owns it) and do NOT edit qa/qa.config.mjs (the CI default manifest must stay untouched).\n` +
      `Deliverables:\n` +
      `1. qa/zoomweb-live/run-zoomweb-live-qa.mjs (+ helper modules as needed): the web live rig per plan C4. Topology: native host via the existing ZoomDrive bootstrap/harvest/admit flow (import/reuse code from qa/zoom-live/, refactor shared pieces into a module rather than copy-pasting) + Chrome web participant "Web Observer" as the observed surface + Guest Alpha/Guest Bravo web guests. ALL web guests join with fake-mic-override speech-gain gating (__fakeMicSpeak) — NEVER tone+mute-toggle; mute state and speech content stay independently controllable. Scenarios (one NDJSON verdict line each to qa/zoomweb-live/zoomweb-live-results.ndjson; print ZOOMWEB LIVE SESSION COMPLETE at the end; failAll marker printed on EVERY early-exit path): zoomweb-events-live (scripted turns + rapid ~2.7s swap block of 4; correlate detector zoomweb_edge lines from MSD_EDGE_LOG against scripted onsets; >=3/4 rapid caught; record raw per-swap dts AND measured active-class linger durations — the latency bar and TransitionConfidence halfLife get calibrated from these, Meet's 2500ms bar as precedent, justification in comments), zoomweb-views-live (speaker view / gallery view / screen-share filmstrip driven on the observer client per plan; share sub-block may degrade to REVIEW only with evidence), cpu-compare-live (INTERLEAVED legacy/event blocks 4x ~22s, warmup dropped, pooled medians, eventCpu <= 0.6x polling AND event full walks < 0.5x legacy from zoomweb_walk_stats, REVIEW band = near-miss only, raw samples always recorded), zoomweb-silence-live (unmuted-but-silent guest 60s => ZERO web speaker attribution), zoomweb-legacy-silent (a ~30s detector block with NO MSD_MODE during the live meeting => zero zoomweb_edge/zoomweb_observer/zoomweb_walk_stats lines while the meeting is still detected legacy). Also: ZOOMWEB_CAPTURE_FIXTURES=1 makes the runner AXSnapshot-capture one gallery + one speaker-view + one share snapshot of the observer Chrome into macos/Fixtures/zoom-web/ (committed later; the Swift self-tests will replay them).\n` +
      `2. qa/qa.zoomweb.config.mjs: session suite FIRST (match 'ZOOMWEB LIVE SESSION COMPLETE', timeoutMs 25*60_000, tools: []) then one reader suite per scenario via node qa/live-scenario-verdict.mjs <scenario> qa/zoomweb-live/zoomweb-live-results.ndjson with match '"verdict":"PASS"' and NO minCount. Validate the shape against qa/orchestrator.mjs so it cannot exit 2.\n` +
      `3. Extend qa/zoom-live/run-zoom-live-qa.mjs + qa/qa.zoom.config.mjs with two NEW scenarios per plan C3: pip-background-live (drive the main meeting window unfocused, then minimized via ZoomDrive if unfocus alone does not spawn the PIP; RECORD which trigger actually produced it; assert "Talking:" edges name the speaker while the main tree is degraded) and vad-quality-live (guest tone/noise burst with speech OFF must NOT produce a named mute-gate attribution; real fake-speech MUST; record raw levels). The existing 5 zoom suites must stay green.\n` +
      `4. qa/review-check.mjs: APPEND guards INV-15..INV-19 exactly per plan C2 (zoom event self-exclusion; time-injected VAD+zoom edges; live manifests incl. qa.zoomweb.config.mjs not referenced by CI; MSD_MODE A/B wired for zoom; NO caption/transcript dependence in any Zoom source Swift or qa/zoom* JS). Follow the existing guard()/pass()/fail() style; the Swift files are being written by a parallel agent — a missing file must FAIL the guard with a clear message, not crash the script.\n` +
      `5. QA_AUTOMATION_FLOW.md: append a section documenting this loop (.claude/workflows/event-driven-zoom-qa-loop.mjs), the four gates, results files, loop-log format, iteration cap, model routing, and re-run args (planFile, maxIters, skipImplement).\n` +
      `Robustness lessons you MUST encode: run long commands in the background; the live runner fast-fails if any rig child process dies (check proc.exitCode in every wait loop); teardown in finally; kill leftover rig Chromes by remote-debugging-port pattern before starting; use fresh CDP ports (not 9224-9227 or 9341); caffeinate -d -u for the session; osascript frontmost before native keystrokes; command-U TOGGLES the participants panel (open once); Zoom free tier caps meetings at 40 min (bootstrap fresh per run).\n` +
      `Do NOT launch the live rigs end-to-end (that is the loop's QA phase) — but DO smoke-check: node --check every JS file you touch, and node qa/orchestrator.mjs config validation for both manifests if a dry validation path exists.` +
      LOG_HOWTO(0, 'implement-qa') +
      `\nThen, as your VERY LAST action, call the StructuredOutput tool with: summary, filesChanged, buildGreen (true iff all node --check pass), notes. Do not end your turn without calling it.`,
      { label: 'implement-qa', phase: 'Implement', model: 'opus', schema: IMPL_SCHEMA }),
  ])
  note({ iteration: 0, phase: 'implement-swift', verdict: sw ? (sw.buildGreen ? 'done' : 'done-build-red') : 'agent-error', failures: [] })
  note({ iteration: 0, phase: 'implement-qa', verdict: qi ? (qi.buildGreen ? 'done' : 'done-build-red') : 'agent-error', failures: [] })
}

// ---------------------------------------------------------------- Loop
const fastGatePrompt = (iter) =>
  `QA runner (deterministic gate), iteration ${iter}. Repo: ${REPO} (git worktree — run everything from here).\n` +
  `Run from the repo root: qa/run_autonomous_qa.sh --skip-tools\n` +
  `swift-selftest may compile for several minutes on a cold build — run the command in the background and wait for completion. Capture the full output.\n` +
  `verdict = 'pass' iff the exit code is 0. Do NOT fix anything.` +
  LOG_HOWTO(iter, 'qa-deterministic') +
  `\nReturn: verdict, failingSuites (ids of failing suites/invariants from the summary, [] if pass), rawTail (last ~100 output lines verbatim).`

const liveGatePrompt = (iter) =>
  `QA runner (LIVE exit gate), iteration ${iter}. Repo: ${REPO} (git worktree — run everything from here).\n` +
  `This launches the native Zoom app, several Chrome windows and the detector on-screen, unattended — expected and pre-approved. Total ~30-50 min. Run caffeinate -d -u for the duration (background it, kill in cleanup).\n` +
  `Run these three gates IN ORDER from the repo root, each IN THE BACKGROUND, waiting for completion before starting the next; STOP at the first failure (do not run later gates):\n` +
  `1. NATIVE:  QA_CONFIG=qa/qa.zoom.config.mjs qa/run_autonomous_qa.sh --skip-review\n` +
  `2. WEB:     QA_CONFIG=qa/qa.zoomweb.config.mjs qa/run_autonomous_qa.sh --skip-review\n` +
  `3. MEET REGRESSION: QA_CONFIG=qa/qa.live.config.mjs qa/run_autonomous_qa.sh --skip-review\n` +
  `Between gates: verify the previous gate's rig tore down (no leftover meeting window, no rig Chrome; kill leftovers by remote-debugging-port pattern). On iteration ${iter === 0 ? '0 specifically, export ZOOMWEB_CAPTURE_FIXTURES=1 for the WEB gate so zoom-web fixtures get captured into macos/Fixtures/zoom-web/' : iter + ', set ZOOMWEB_CAPTURE_FIXTURES=1 for the WEB gate only if macos/Fixtures/zoom-web/ is still empty'}.\n` +
  `verdict = 'pass' iff ALL THREE exit 0. Then read qa/zoom-live/zoom-live-results.ndjson, qa/zoomweb-live/zoomweb-live-results.ndjson and research/meet-dom-detector/live/live-qa-results.ndjson and return their FULL contents concatenated (with one-line file headers) as resultsNdjson.\n` +
  `If rig processes linger after a failure, kill them so the next iteration starts clean. Do NOT fix anything.` +
  LOG_HOWTO(iter, 'qa-live') +
  `\nReturn: verdict, failingSuites (which gate + suite ids), rawTail (last ~120 output lines of the FAILING gate, or of gate 3 if all passed), resultsNdjson.`

const fixPrompt = (iter, what, payload) =>
  `You are the fix agent (iteration ${iter}) for the Zoom event-driven detector change. Plan: ${PLAN}. Repo: ${REPO} (git worktree — work only here).\n` +
  `${what} FAILED. Failure report:\n${payload}\n` +
  `Diagnose the ROOT CAUSE and fix it minimally, staying consistent with the plan (bounded diffs as primary edge source, pure time-injected confidence/VAD, flag-gated legacy default, CI-safe default manifest, self-exclusion, NO caption/transcript dependence, never chase a native tile speaking signal). Product code, tests, QA infra, or the live rig may be at fault — fix whichever actually is. Threshold/latency calibration is legitimate ONLY with physics justification from recorded raw data (linger/latency distributions) — record the justification in code comments; never weaken an assertion just to pass.\n` +
      `Verify locally before finishing: swift build + swift run SpeakerCoreSelfTest green (in ${REPO}/macos, background long builds) if you touched Swift; node --check on any JS touched. Do NOT run the full QA gates — the loop reruns them.` +
  LOG_HOWTO(iter, 'fix') +
  `\nThen, as your VERY LAST action, call the StructuredOutput tool with: summary, filesChanged, buildGreen, notes. Do not end your turn without calling it.`

const reviewerPrompt = (iter, live) =>
  `Independent reviewer: assess whether the QA that just passed is SUFFICIENT — you review the QA, not the product. Plan: ${PLAN}. Repo: ${REPO}.\n` +
  `Read: the plan's Part C + exit criteria, git status + git diff (uncommitted implementation), macos/Sources/SpeakerCoreSelfTest/main.swift (new zoom test blocks), qa/qa.zoomweb.config.mjs + qa/zoomweb-live/run-zoomweb-live-qa.mjs + qa/zoom-live/run-zoom-live-qa.mjs (what live QA actually asserts), qa/review-check.mjs (INV-15..19), and the live results below.\n` +
  `Hunt specifically for: (1) linger-boundary coverage — decay just-before/just-after the calibrated halfLife, re-spike during decay, holder switch mid-linger (these need PURE self-tests); (2) view-switch races — edges during a gallery<->speaker transition, tile-set churn mid-diff; (3) PIP-appearance honesty — did pip-background-live record the ACTUAL trigger (unfocus vs minimize) or assert the untested hypothesis; (4) VAD hysteresis boundaries — enter at exactly 2 frames, exit at exactly the hangover, single-frame ding rejection, and whether vad-quality-live could pass vacuously (audio never reaching the tap); (5) live blind spots — assertions passable with zero edges AND zero walks, REVIEW verdicts silently treated as pass, cpu-compare sampling the wrong process, silence scenario passing because the guest never actually emitted audio in other scenarios (cross-check); (6) ADJUDICATE any threshold calibration done mid-loop (latency bar, halfLife, VAD levels): physics-justified from recorded raw data only — gaming = unresolved gap; (7) legacy byte-silence — is zoomweb-legacy-silent actually probing during an active meeting; (8) regression sufficiency — Meet live + Teams fast green with the VAD swap live.\n` +
  `A gap is UNRESOLVED only if it is a realistic risk not covered by any existing test or invariant. Each gap must name the missing test/assertion and where it should live.\n` +
  `Live results NDJSON:\n${live.resultsNdjson || '(missing)'}` +
  LOG_HOWTO(iter, 'review') +
  `\nThen, as your VERY LAST action, call the StructuredOutput tool with: sufficient (true iff no unresolved gaps), gaps, rationale. Do not end your turn without calling it.`

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
    const fx = await agent(fixPrompt(iter, 'The LIVE QA exit gate (zoom native / zoom web / Meet regression)', payload),
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
  `Generate the final QA report for the Zoom event-driven detector loop. Repo: ${REPO}. Plan: ${PLAN}. Loop status: ${status} after ${iter + 1 > MAX_ITERS ? MAX_ITERS : iter + 1} iteration(s).\n` +
  `Read qa/loop-log.ndjson (full loop history), qa/zoom-live/zoom-live-results.ndjson, qa/zoomweb-live/zoomweb-live-results.ndjson, research/meet-dom-detector/live/live-qa-results.ndjson, and the reviewer verdict: ${lastReview ? JSON.stringify({ sufficient: lastReview.sufficient, gaps: lastReview.gaps }) : '(no reviewer ran)'}.\n` +
  `Write docs/qa-report-zoom-event-driven.md: per-scenario pass/fail tables for BOTH surfaces, CPU/walk-count comparison with RAW numbers, measured active-class linger + edge-latency distributions (raw per-swap dts) and the calibration decisions they justified, per-view accuracy (speaker/gallery/share), the pip-background trigger finding (unfocus vs minimize — what was actually observed), vad-quality raw levels, the legacy byte-silence probe result, the rig topology honestly described (native host + web observer if that is what ran), reviewer verdict + gaps, iteration history, and how to re-run each gate. If status is not GREEN, title it as a STATUS report and lead with what is still failing and why.\n` +
  `Also append the final NDJSON line to qa/loop-log.ndjson: {"phase":"exit","verdict":"${status}","iteration":${iter},"ts":<unix seconds from date +%s>}.\n` +
  `Return a <=20-line plain-text summary of the report.`,
  { label: 'report', phase: 'Report', effort: 'low' })

return { status, iterationsUsed: Math.min(iter + 1, MAX_ITERS), journal, reportSummary: reportOut }