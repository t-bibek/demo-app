# Autonomous QA flow

A runnable, config-driven pipeline that gates the Meet active-speaker detector: it
runs every QA suite, recovers a blocked test-tool automatically (fix → fallback,
no human re-trigger), runs an independent review of the checks themselves, and
**exits non-zero if any exit criterion fails**. The logic lives in code, not in
this doc — this page explains it and points at the source.

```
qa/run_autonomous_qa.sh        # thin entrypoint (exec's the engine, propagates exit code)
qa/orchestrator.mjs            # engine: runs the phases + enforces the exit criteria
qa/qa.config.mjs               # manifest: the ONLY file most changes touch (suites/tools/review)
qa/review-check.mjs            # independent review gate as executable invariants
```

## Run it

```bash
qa/run_autonomous_qa.sh                 # full: tools → suites → review
qa/run_autonomous_qa.sh --suites-only   # just suites + exit gate (fast; CI default)
qa/run_autonomous_qa.sh --skip-tools    # suites + review, no live-tool phase
qa/run_autonomous_qa.sh --allow-privileged   # permit sudo-y tool fixes (e.g. BlackHole reload)
qa/run_autonomous_qa.sh --json          # machine-readable report (still exits 0/1)
QA_CONFIG=path/to/alt.mjs qa/run_autonomous_qa.sh   # run an alternate manifest (also for testing)
```

Exit code: `0` when all exit criteria are met, `1` on any blocker, `2` if the
manifest itself is malformed (validated before anything runs). So it drops
straight into CI or a pre-push hook.

## What it does (three phases)

Driven entirely by [`qa/qa.config.mjs`](qa/qa.config.mjs); the engine
([`qa/orchestrator.mjs`](qa/orchestrator.mjs)) is generic.

### 1. TOOLS — the blocker-recovery pattern (`resolveTool`)
A *tool* is a capability a test needs that can break independently — here, injecting
synthetic host/guest speech into a live Google Meet call ("Blackbox"). For each tool
the engine walks a recovery chain **in code**:

```
check ──ok──▶ HEALTHY
  │fail
  ▼
fix (if any) ──▶ re-check ──ok──▶ FIXED
  │still failing / fix skipped
  ▼
fallback.check ──ok──▶ FALLBACK        (each fallback may have its own check/fix/fallback)
  │all fallbacks fail
  ▼
DOWN  ──▶ blocks the run only if the tool is `required: true`, else WARN
```

- A `fix` marked `needsPrivilege: true` (e.g. `sudo` to reload the audio driver)
  runs **only** with `--allow-privileged`, so CI never sudo-prompts.
- This is the exact "try the fix, then automatically fall back to the alternative,
  no human re-trigger" behaviour the Blackbox blocker needed. Live example — the
  primary [BlackHole loopback](research/meet-dom-detector/live/bh-loopback-check.sh)
  is wedged, its [reinstall fix](research/meet-dom-detector/live/bh-fix.sh) needs
  sudo (skipped), so the engine falls back to the device-free
  [getUserMedia rig](research/meet-dom-detector/live/gum-override-probe.js) and
  reports `FALLBACK via fake-audio-getusermedia` — green, unattended.

### 2. SUITES — the QA scenarios (`runSuite`)
Each suite in the manifest is gated on three things, any of which fails it:
- **exit code** — every suite already exits non-zero on a failing scenario;
- **`match`** — a regex that must appear in output. The backreference form
  `(\d+)/\1 passed` asserts "N of N passed" for any N, so a partial pass (33/34)
  fails while adding scenarios doesn't;
- **`minCount`** — asserts the matched N ≥ baseline, catching a suite that
  *silently drops* scenarios yet still exits 0.

Current suites: `node-harness` (23/23), `browser-qa` (34/34), `swift-selftest`
(`ALL PASSED`).

### 3. REVIEW — checking the checks (`qa/review-check.mjs`)
A **runnable** independent review, not a doc. It encodes the findings of the
2026-07 QA-suite audit ([docs/qa-review-findings-2026-07.md](docs/qa-review-findings-2026-07.md))
as executable invariants, so those exact regressions fail CI instead of slipping
through green:

- **INV-1** every Meet attribution path (ring / focused / geometry) excludes the
  self tile — guards the real self-naming bug that was found and fixed;
- **INV-2** every `MeetSpeakerSignal` case is asserted by a `via, .<case>` self-test;
- **INV-3** the token-independence scenarios still exist (detection must never
  depend on a rotating Google CSS token);
- **INV-4** the suite baselines in the manifest match CI + README (baseline-drift guard).

Point `review.cmd` at an LLM reviewer to layer a judgement pass on top;
`review-check.mjs` is the deterministic floor.

## Exit criteria (enforced in `orchestrator.mjs`, not here)
The run **fails (exit 1)** if any of:
- a suite fails — non-zero exit, timeout, output-buffer overflow, missing `match`,
  a `minCount` set on a `match` with no numeric group (unverifiable), or count
  below `minCount`;
- **no suites are configured** (a mis-edit that verifies nothing is a failure, not a pass);
- a `required: true` tool ends `DOWN` (primary + all fallbacks unavailable);
- the `required` review gate fails.

A **malformed manifest exits 2** before any phase runs — e.g. a fallback with a
`fix` but no `check` (an unverifiable heal), or a tool with nothing to probe.

Non-required tools that end `DOWN` are reported as `⚠ WARN` and do **not** fail the
run (they're live-only capabilities, absent in CI). The verdict block prints a
per-item pass/fail summary and every blocker.

> These guards came out of an adversarial review of the orchestrator itself
> (fallback-chain correctness, exit-gate edge cases, extensibility, portability) —
> the same find → verify pattern the flow applies to the product.

## Extending it (edit data, not the engine)

| To add… | Edit | How |
|---|---|---|
| a QA suite/scenario set | [`qa/qa.config.mjs`](qa/qa.config.mjs) `suites[]` | `{ id, cwd, cmd, match?, minCount?, timeoutMs? }` |
| a blocker tool | `qa/qa.config.mjs` `tools[]` | `{ id, required, check, fix?, fallback? }` |
| another fallback for a tool | that tool's `fallback` | nest `fallback: { id, check, fix?, fallback? }` — chains to any depth |
| a privileged recovery step | a `fix` | set `needsPrivilege: true` (runs only under `--allow-privileged`) |
| a review invariant | [`qa/review-check.mjs`](qa/review-check.mjs) | append a `guard(name, () => { … pass()/fail() … })` block |

The engine reads the manifest and never hardcodes a suite/tool id, so none of the
above requires touching [`qa/orchestrator.mjs`](qa/orchestrator.mjs).

## CI

The existing GitHub Actions workflow
([.github/workflows/meet-detector-qa.yml](.github/workflows/meet-detector-qa.yml))
runs the individual suites. To gate a job on the whole flow instead, call
`qa/run_autonomous_qa.sh --suites-only` (or `--skip-tools` to include the review
gate but not the live audio tools, which need a browser + meeting).

CI runs the **default** manifest only. The live manifest
([`qa/qa.live.config.mjs`](qa/qa.live.config.mjs)) launches Chrome windows + the
detector app and must **never** be referenced from CI — the review gate enforces
this as **INV-7**.

## Autonomous implement→QA→fix loop (multi-agent)

For a large, verify-heavy change (the Meet **event-driven ring/focus** detector) a
single deterministic script drives implement → QA → fix → re-verify → review to
completion, with agents doing the reasoning and the loop logic staying pure JS. The
script is committed at
[`.claude/workflows/event-driven-ring-qa-loop.mjs`](.claude/workflows/event-driven-ring-qa-loop.mjs)
so the whole run is reproducible.

### The two gates (both through the `qa/` orchestrator)

Every iteration runs the fast deterministic gate; only when it is green does the
live exit gate run:

```bash
# Fast gate (every iteration): suites + review invariants INV-1..8, no live tools.
qa/run_autonomous_qa.sh --skip-tools

# Live exit gate (only after the fast gate passes): the live manifest, tools phase
# heals audio injection, review already ran in the fast gate so it is skipped.
QA_CONFIG=qa/qa.live.config.mjs qa/run_autonomous_qa.sh --skip-review
```

The live gate's `live-session` suite launches the 3-party rig + detector once
([`research/meet-dom-detector/live/run-live-qa.mjs`](research/meet-dom-detector/live/run-live-qa.mjs)),
runs `ax-events-live` / `cpu-compare-live` / `regression-live` back-to-back, and
writes one NDJSON verdict line per scenario to
`research/meet-dom-detector/live/live-qa-results.ndjson`; three reader suites gate on
`"verdict":"PASS"` for their scenario (via
[`qa/live-scenario-verdict.mjs`](qa/live-scenario-verdict.mjs)).

### Flow + iteration cap

`MAX_ITERS = 3` (override with `maxIters`). Each iteration: **fast QA** → on pass
**live QA** → on pass **reviewer** (assesses *QA sufficiency*, not the product —
decay-timing edges, missed transition types, observer-callback races that can only be
proven with pure self-tests). A failing gate or an unresolved reviewer gap routes a
failure report to a **fix** agent and loops back. Exit is `GREEN` (all gates green +
no unresolved gaps) or `ITER_CAP` after 3 iterations; on `GREEN` a report is written to
`docs/qa-report-event-driven-2026-07.md`.

### Loop log (`qa/loop-log.ndjson`)

Every phase appends exactly one NDJSON line so the whole history is auditable:

```json
{"iteration":0,"phase":"implement-qa","verdict":"pass","failures":[],"ts":1751600000}
```

- `iteration` — 0 for the implement phase, then 0..MAX_ITERS-1 as the loop turns.
- `phase` — `implement-swift` | `implement-qa` | `qa-deterministic` | `qa-live` |
  `fix` | `review` | `exit`.
- `verdict` — `pass` | `fail` | `done` | `gaps` (and `GREEN` | `ITER_CAP` on the final
  `exit` line).
- `failures` — suite/invariant ids or short reviewer-gap strings.
- `ts` — unix seconds.

### Model routing

Implement / fix / reviewer agents run on **Opus** (hard reasoning); the QA-runner and
report/log agents inherit the session model (**Fable**) at low effort (mechanical: run
the command, parse the output into the schema). The loop/routing logic itself is
deterministic JS orchestrated from the Fable session.

### Re-run it

The workflow takes three args:

- `planFile` — the plan the agents implement/verify against (defaults to the
  event-driven-ring plan).
- `maxIters` — iteration cap (default 3).
- `skipImplement` — set `true` to skip Phase 1 and loop QA/fix/review on **existing**
  code (e.g. after a manual tweak, or to re-verify a landed change).

So `{ skipImplement: true }` re-runs just the QA/fix/review loop against whatever is
currently in the tree.
