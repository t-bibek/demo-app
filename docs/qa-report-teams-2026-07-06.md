# QA Report — Teams Active-Speaker Detection, Phase-3 Complete Scenario Pass (2026-07-06)

**Status: GREEN with one open product finding (wake-accel coverage) and scenario-semantics REVIEWs.**
Final gate of the Teams active-speaker run: full live scenario pass over both Teams surfaces
(native + web) against the PRODUCT binary, plus the Meet regression closing gate (4/4 PASS).

## Binaries under test

| Snapshot | Commit | Role |
|---|---|---|
| `detector-5b01e99-final` | `5b01e994f8` (branch tip at run start) | evidence runs: suite 1 first passes, throttle |
| `detector-p1webfix-final` | `9d2bbfe838` (menu-leak fix, selftest 350) | ALL remaining suites + re-runs + Meet gate |
| `detector-d8a87b8-reference` | `d8a87b8da6` (pre-web-enable) | ABA-on-flake reference |

Built via `packages/desktop/native/bubbles-meet-detector/macos/build.sh`, selftest ALL PASSED,
snapshots frozen in the QA scratchpad (immune to concurrent rebuilds). Offline verdict math
validated before any live run: probe-analysis 20/20, phase3-analysis 43/43.

## Rollup

| # | Suite | Verdict | Evidence (one line) |
|---|---|---|---|
| 1 | teams-detect-live | **PASS** (fixed bin) | meeting_initialized + local self "Bibek Thapa" named, solo AND 2-party shapes |
| 1 | teams-selfmute-live | REVIEW (product contract) | product NEVER emits Teams mute: `selfMuted: nil` by design (TeamsProbes.swift:139/187/253); ParticipantInfo has no mute field |
| 1 | teams-layouts-live | **PASS-with-REVIEW** (fixed bin) | all driven cells roster-exact (menu-leak FIXED, twice proven); `together` undrivable in <3-party call |
| 1 | teams-guest-live | **PASS** (fixed bin) | roster grew exactly by guest; guest NAMED via `teams.ring.transition`; 0 bad speech |
| 2 | teams-throttle-live | REVIEW (env) | WebView2 never throttled in 126s minimize (active-call renderer exemption): keep-alive unexercisable; keptSession ✓, recovery 407ms ✓ |
| 2 | teams-ring-continuity | **PASS** | longest dark gap 0ms / 30 samples / 0 reopen edges across gallery→speaker→gallery under speech |
| 2 | teams-wake-accel | **FAIL (genuine — fix-loop item)** | 2 runs identical: 1/6 onsets wake-covered (first only), 3 consumed total; detection healthy (6/6 edges both legs); control leg PASS (additive proof) |
| 3 | teams-ring-probe | REVIEW | load-bearing silent-open-mic DARK ✓ (0.032); speech 0.476 vs 0.5 rig-drove bar (WAV duty-cycle); tone 0.482 = documented energy-VAD trade; linger 1969ms; mute-clear 9606ms; 238 samples |
| 4a | teams-web-cold-start | REVIEW (rig) | cold-Chrome title-wake PROVEN 3× (first discovery pass); in-call web detection unmeasurable standalone vs lobby-gated room (scenario needs host+admit + web-key assert) |
| 4b | web speaking spot-check | **PASS** | 25/25 flips covered on WEB key; 27 handoffs all `teams.ring.transition`; onsets-from-silence 433/450ms; handoffs median 1945 / max 2504ms; silence clean; ring purity 87/88 |
| 5 | Meet regression (live-session, ax-events, cpu-compare, regression) | **PASS 4/4** | swaps 6/6 (dt 430–697ms), rapid 5/5; cpu meanRatio 0.28, walkRatio 0.406 (real work: fw 32 vs 13); 3-party matrix perfect |

## Incident 1 — suite-1 "total detection darkness" (resolved: rig env-contract gap)

First native baseline run reported zero Teams events while TeamsDrive drove in-call controls
successfully. A 4-leg live discrimination (tip / reference / pre-8a 16614b2 / sandbox debug)
showed ALL product binaries detect the meeting (wire `meet-active`, correct key/title/self) —
the product's typed `[event]` mirror (meeting_initialized / participant_* / speech_on /
teams_edge) is gated on `MSD_EDGE_LOG=<path>|1` (`MonitorDiagnostics.emitEventLine`;
`main.swift:149`); only `meet_walk_stats` is unconditional. The rig's `startDetector` never set
it (the sandbox binary emits `[event]` unconditionally; the known-good obs-sweep wrapper sets
`MSD_EDGE_LOG=<edgePath>` — why it never hit this). Also excluded live: strict title gate
(`teamsIsCallWindowTitle` is character-identical to the pre-8a predicate and the real window
title "Meeting with Bibek Thapa | Microsoft Teams" matches it), screen lock, AX trust.

**Rig fixes (this commit):** `startDetector` defaults `MSD_EDGE_LOG=1`; `--all` baseline widened
to the product event vocabulary (`isTeamsProd` pipe-key predicate; guest speech source regex
`+ ring|ring.transition` per TeamsSpeakerPipeline.swift:202-205).

## Incident 2 — native menu items extracted as participants (product bug, FIXED + regression-proven)

On `5b01e99`, teams-layouts-live leaked the View menu into the roster in every driven cell:
`["Focus on content","Gallery","Large gallery","More options"]` (+"Gallery size"). Root cause:
the P1-web AXMenuItem title-tile branch (web-enable commit) had no web-context gate — native
Teams menus are also empty-desc AXMenuItems. Fix `9d2bbfe838` gates the branch on
`TeamsExtractSource == .web` (native scanner passes `.native`). Regression proof: identical
scenario on the fixed snapshot returns exact rosters in ALL driven cells, twice (2-party and
solo), zero leaked names.

**Old-snapshot validity scope:** the fix touches ONLY the AXMenuItem title-branch admission in
`teamsExtractWindow` (+ its TeamsProbes call site). Suites that do not assert rosters —
throttle (keep-alive lines, wire idle, ring presence), ring-continuity (ring trace), wake-accel
(wake stderr lines, edges, walk stats), ring-probe (ring trace) — are unaffected by construction;
their old/mixed-snapshot results stand.

## Open product finding — teams-wake-accel (for the fix loop)

Two independent runs (both legs of each): wake observer attaches, **consumes near the FIRST
ring onset only** (1/6 covered, 3 consumed total, ±2s window), while ring detection itself stays
healthy at the poll floor (6/6 teams_edge onsets in BOTH main and control legs) and the silence
window stays quiet (0 consumed). Control leg (MSD_TEAMS_WAKE=0) fully PASSES: zero wake lines
AND detection intact — the wake path is purely additive, so this is a lost-acceleration issue,
not a detection issue. Hypothesis for the fix loop: the AXTitleChanged/AXValueChanged window
carriers fire on call-window title settle but not on subsequent ring flips.
Rig notes bundled with this finding: (a) the leg kills the detector before `MSD_RUN_SECONDS`
auto-flush, losing the final `teams_wakes` counter (counterOk unreadable); (b) `abaAdjudicate`'s
`subtree_reads==0` degeneracy heuristic is Meet-specific and fires vacuously for Teams-only
sessions (Teams has no bounded tier) — both wake-accel ENVIRONMENTAL-RETRY verdicts were this
misfire; the FAIL classification here supersedes them.

## Scenario-semantics classifications (REVIEW, with product-contract citations)

- **teams-selfmute-live:** asserts `participant_updated.is_muted` flips. Product deliberately
  emits `selfMuted: nil` on every Teams path ("Teams has no self-mute signal — never emitted",
  TeamsProbes.swift:139/187/253); `ParticipantInfo` is `{name, isSelf}` (shared/Filters.swift:43) —
  no mute field exists. Sandbox-only capability; not a product gap.
- **teams-throttle-live:** the scenario models minimize ⇒ WebView2 throttle ⇒ tree-empty. Live,
  an active call keeps the renderer (ring stayed lit and correct through 126s minimized — 29 lit
  tail samples of a genuinely speaking guest). Meaningful product properties PROVEN: session key
  never idled; detection recovered 407ms after restore; keep-alive classifier remains covered by
  selftest fixtures.
- **teams-web-cold-start:** title-wake for cold Chrome proven 3× (pids 83608/83782/83954, first
  discovery pass). Full in-call web detection is structurally unmeasurable in the standalone
  scenario against a lobby-gated personal room (no host to admit; with a host, the platform-only
  assert false-triggers on the native meeting). The web in-call detection claim is instead proven
  by 4b (web key `meeting_initialized`, participant_count 2). Scenario redesign filed: host+admit
  orchestration + web-key-specific assert.

## Latency numbers

| Signal | Measured |
|---|---|
| Teams web ring onset from silence | 433 / 450 ms |
| Teams web ring handoff (release+re-onset) | median 1945ms, max 2504ms (release ~1.6s + onset ~0.6s compound) |
| Teams native ring-clear linger (speech stop) | 1969 ms |
| Teams native ring-clear on mute | 9606 ms |
| Teams throttle-restore ring recovery | 407 ms |
| Teams web cold-start title-wake | first discovery pass (3/3 runs) |
| Meet swap onset→edge (regression gate) | 430–697 ms (bar 2500ms), 6/6 + rapid 5/5 |

## Artifacts index

Scratchpad root: `…/scratchpad/phase3/`
- Suite logs: `suite1-native-baseline.log`, `suite1-rerun.log`, `suite1-fixedbin.log`,
  `suite1-clean.log`, `suite2a-throttle.log`, `suite2b-ringcont.log`, `suite2c-wakeaccel.log`,
  `suite2c-retry.log`, `suite3-probe.log`, `suite4a-webcold.log`, `suite5-meet.log`
- Diagnosis: `diag-titles.txt`, `diag-dump-teams.log`, `diag-{snap,ref,cur16614b2,sbx}-*.log`,
  `diag-edgelog-*.log`, `4a-recon-*`, `4a-v2-*`
- 4b spot-check: `4b2-{stdout,stderr,driver}.log`, `4b2-artifacts/flip-timeline-*.ndjson`
- Verdict NDJSONs: `qa/teams-live/teams-live-results.ndjson` (last run),
  `research/meet-dom-detector/live/live-qa-results.ndjson` (Meet gate)
- Probe raw: `qa/teams-live/teams-ring-probe-trace.ndjson`, `teams-ring-probe-marks.json`

## Caveats

- **Tone lights the ring** (energy-VAD): confirmed live (tone window 0.482 lit) — documented
  trade, probe verdict logic accounts for it. No caption dependence anywhere.
- **English UI anchors**: TeamsDrive labels and product anchors (Leave / Attendees / Shared
  content) are English-locale.
- **Wake is foreground-only** and currently first-onset-only (see open finding).
- **Web background-tab**: spot-check ran foreground; Phase-2 background-tab throttle notes apply.
- **Lobby-gated rooms**: anonymous web guests need a host admit; stale lobby entries from killed
  clients can ghost-join on Admit (rig hygiene: one "QA Guest" ghost polluted 4b's native-key
  first events; web-key events unaffected).

## How to re-run

```bash
# Teams native baseline (product binary)
MSD_DETECTOR_BIN=<snapshot> TEAMS_MEETING_URL=<url> \
  QA_CONFIG=qa/qa.teams.config.mjs qa/run_autonomous_qa.sh --skip-review

# Phase-3 scenarios (one per session)
MSD_DETECTOR_BIN=<snapshot> TEAMS_MEETING_URL=<url> \
  node qa/teams-live/run-teams-live-qa.mjs --throttle-live|--ring-continuity|--wake-accel|--web-cold-start|--probe

# Meet regression closing gate
MSD_DETECTOR_BIN=<snapshot> QA_CONFIG=qa/qa.live.config.mjs qa/run_autonomous_qa.sh --skip-review
```
