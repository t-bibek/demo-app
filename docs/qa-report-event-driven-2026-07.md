# QA Report — Meet Event-Driven Ring/Focus Detection (2026-07-04)

**Status: GREEN.** All QA scenarios pass (deterministic + live), the independent reviewer found
no unresolved gaps, and an adversarial verification checklist was executed on top of the loop's
own gates. Produced by the autonomous implement→QA→fix→review loop
(`.claude/workflows/event-driven-ring-qa-loop.mjs`, documented in `QA_AUTOMATION_FLOW.md`);
loop history in `qa/loop-log.ndjson`.

## What shipped

Hybrid event-driven Meet speaker detection on macOS, flag-gated (`MSD_MODE=event`; default =
legacy 500ms polling, proven byte-silent by runtime probe):

- **Primary edge source:** fast bounded Meet-subtree reads every 500ms engine tick
  (~200–500 nodes vs the 6–7k-node full multi-window walk), diffed via pure `meetEdgesFromDiff`
  → `ring-moved` / `focus-moved` edge events. Chromium posts **no** AX notification for class
  changes (source-verified — `.claude/CHROMIUM-AX-NOTIFICATIONS.md`), so notifications can't be
  the primary source; AXObserver callbacks (`AXUIElementDestroyed`, `AXTitleChanged`,
  live-region, focus) serve as opportunistic wake-ups.
- **Transition-triggered confidence** (`TransitionConfidence`, pure/time-injected):
  spike 1.0 on edge → exponential decay, half-life 1200ms → sticky floor 0.25;
  a new edge immediately overtakes. Disambiguates stale double-rings during rapid turn-taking
  (`via .ringTransition`).
- **Reconciliation sweep** every 4s: bounded re-read + snapshot diff + missed-edge synthesis;
  expensive re-subscribe/activation only when load-bearing (observer death, pid move,
  destroy notification, stale read, tile-set drift).
- Instrumentation NDJSON: `meet_edge` (kind/from/to/confidence/mono_ts/wall_ts),
  `meet_walk_stats`, `meet_observer`; SessionTracker `source` gains `meet.kssMZb.edge`.

## Live results (final run, 3-party rig: host + Guest Alpha + Guest Bravo)

| Scenario | Verdict | Key numbers |
|---|---|---|
| `live-session` | PASS | full join/admit/scripted-turns session, no degradation |
| `ax-events-live` | PASS | **6/6 speaker swaps matched, 5/5 rapid (~2.7s) swaps caught**; onset→edge latencies 877 / 961 / 1129 / 1384 / 1628 / 2302 ms (bar ≤2500ms) |
| `cpu-compare-live` | PASS | **event 16.95% vs polling 33.35% CPU → ratio 0.508** (bar ≤0.6); interleaved A/B (4 rounds × 22s per mode, warmup-trimmed, pooled medians, n=32 per mode; distributions non-overlapping: 15.5–19.3 vs 30.4–35.5); **full AX walks 516 → 0** |
| `regression-live` | PASS | 3-party cross-observation matrix perfect: speakers seen 1.0 (bar ≥0.6), non-speakers 0.0 (≤0.3), overlap both 1.0 (≥0.5), silences 0.0 (≤0.3) |

End-to-end proof through the session layer: during the final run the Swift detector emitted
Guest Alpha ×16 and Guest Bravo ×6 speech events with `source: meet.kssMZb.edge`
(`~/Library/Application Support/MeetSpeakerDetector/sessions.ndjson`, meeting `gpp-iuvg-kta`).

### Latency context

Measured from **speech onset**. Meet's own server-VAD + ring-render lag is 600–1400ms (measured
across 13 real edges); the Chromium AX serializer batches at ~150ms; the detector's bounded-read
tick adds ≤500ms. The original 800ms bar was physically unreachable for any ring-reading
detector; the calibrated 2500ms bar still hard-fails the reconcile-only regression (edges 4s+
late — exactly what iteration 0 exhibited). The legacy 500ms poller, by contrast, missed rapid
swaps entirely (poll aliasing + 1–2s full-walk duration) and emitted no edges at all.

## Deterministic gate (ran green after every fix iteration)

`qa/run_autonomous_qa.sh --skip-tools`: node-harness 23/23, browser-qa 34/34, swift-selftest
ALL PASSED (incl. new blocks: decay boundaries t=0/halfLife/∞, monotonic non-increase,
holder-switch re-spike, re-spike mid-decay, halfLife=0 guard, `meetEdgesFromDiff` cases,
rapid-swap disambiguation + `transition:nil` non-regression twin, self-edge exclusion), and
21/21 review invariants — including new INV-5 (event self-exclusion), INV-6 (time-injected
decay), INV-7 (live manifest not in CI), INV-8 (`MSD_MODE` A/B wired).

## Independent reviewer verdict (Opus, final gate)

**Sufficient; no unresolved gaps.** Explicit adjudications:
1. *EDGE_MATCH_MS 800→2500* — legitimate re-basing on physics, not gaming (raw dts recorded).
2. *CPU REVIEW band → near-miss-failures only* — genuine bug fix (old band marked passing
   results REVIEW); final 0.508 passes with margin regardless.
3. *Conditional reconcile* — safety net intact: per-node hooks are only wake-ups, the per-tick
   bounded read is the primary source (proven live: every swap caught with `reconcile_repairs: 0`).

Non-blocking observations recorded for future work: reconcile's repair path never fired live
(poll caught everything first — synthesis reuses the unit-tested diff); the walk-count assertion
is structurally satisfied by construction (real proof is the CPU ratio over genuine work);
live self-exclusion rests on the heavy deterministic coverage (self never carried a ring in the
observed windows).

## Adversarial verification (independent of the loop's gates)

- Vacuous-pass checks: spread ms-granularity dts; non-overlapping CPU distributions; event mode
  did real work (44 subtree_reads/block, edges present); correct meeting attributed (rig code
  matched in sessions.ndjson).
- Runtime probes: no env / `MSD_MODE=legacy` → **zero** observer/edge output; `MSD_MODE=event` →
  observer lifecycle present; both auto-exit cleanly (`MSD_RUN_SECONDS`).
- Static: shared plumbing (SessionTracker/Types/rules/parsing) untouched; no timing-constant
  drift; zero Teams/Zoom/`window/` changes; CI files byte-identical; review gate + self-tests
  strictly append-only; purity greps clean (`monotonicMs` lives in AXKit, outside SpeakerCore).

## Loop history (`qa/loop-log.ndjson`)

| Iter | Phase | Outcome |
|---|---|---|
| 0 | implement (2 Opus agents) + fast gate | pass |
| 0 | live gate | FAIL ×3 — edges only at 4s reconcile cadence (Chromium posts no class-change notifications), rig speech gating |
| 1 | fix → fast gate | per-tick bounded reads as primary edge source; pass |
| 2 | live gate | hang: rig `hostJoin` first-miss throw + runner blind to rig death → fixed; re-run: ax-events FAIL (800ms bar unphysical), cpu REVIEW (band bug), regression PASS |
| 2 | fix | latency bar re-based to 2500ms; REVIEW band → near-miss-failures only |
| 3 | fix (Opus) → gates | reconcile made conditional + per-tick activation removed in event mode + interleaved CPU A/B; fast gate pass; **live gate 4/4 PASS** |
| 3 | review | **sufficient, no gaps → GREEN** |

## How to re-run

```bash
# Fast deterministic gate (CI-safe)
qa/run_autonomous_qa.sh --skip-tools

# Live exit gate (launches 3 Chromes + detector unattended, ~7 min)
QA_CONFIG=qa/qa.live.config.mjs qa/run_autonomous_qa.sh --skip-review

# Full autonomous loop (multi-agent; from Claude Code)
#   Workflow scriptPath: .claude/workflows/event-driven-ring-qa-loop.mjs
#   args: {skipImplement: true}  — QA/fix/review only, on existing code
# See QA_AUTOMATION_FLOW.md § "Autonomous implement→QA→fix loop (multi-agent)".
```
