# Agent orchestration playbook — live-gated feature delivery

Distilled from the Meet/Teams/Zoom tab-away keep-alive rollout (2026-07-06/07): ~30 gated
commits across two repos, 3 measurement sweeps, 8 live gate runs, 6 challenger reports —
orchestrated as parallel background agents. Follow this and the next rollout skips a day
of rediscovery.

## The pipeline shape (per platform/feature)

```
MEASURE (sandbox sweep, GO/NO-GO gate)          — screen-bound
  → BUILD DARK (flag OFF, per-commit quartet)   — parallel with next sweep
    → CHALLENGER + REVIEWER pair (read-only)    — parallel with next build
      → answer challenges IN WRITING (challenges log; OVERTURN/NEEDS-EVIDENCE block un-gates, not progress)
        → LIVE GATE (rig, real vocabulary)      — screen-bound
          → UN-GATE (one-line flip, pre-built + HELD, lands on green)
```

Rules that earned their keep:
- **Measure before build.** Every premise flip-flop in this rollout traced to an unmeasured assumption or a rig bug (see traps).
- **Flag OFF until the live gate.** Disabled = byte-identical, proven per commit. Un-gates are one-line flips pre-built in HELD detached worktrees so landing takes minutes.
- **Quartet per commit** (from bubbles-meet-detector/): `./macos/build.sh` (selftest gates on ALL PASSED) + `node qa-review.mjs` + `npx tsc --noEmit` + `npx vitest run` — node ≥22.13 required for vitest 4 (use ~/.nvm/versions/node/v22.22.1/bin; the .nvmrc 22.12.0 is too old).
- **Challenger ≠ reviewer.** The reviewer verifies execution; the challenger attacks the decision (charter: `.claude/agents/challenger.md`). Every substantive commit gets BOTH, in parallel, read-only. Log files at bubbles-dev root: `.speaker-integration-review-log.md`, `.speaker-integration-challenges.md`.
- **Falsification-test every new gate pin**: break → FAIL loud → restore → green, recorded in the report.

## Parallelism map (what can overlap)

The SCREEN is the only serialized resource (one live meeting/AX session at a time).
- Screen-bound: sweeps, live gates.
- Everything else in parallel: builders (worktree-isolated if the main checkout is busy), challenger/review pairs, un-gate pre-builds, rig-scenario builders (different repo).
- Same-branch commits serialize — use `isolation: worktree` (or a manual detached worktree) + cherry-pick landing when two builders would race.
- Extend an in-flight agent with SendMessage instead of spawning a successor (used for: review-hazard handoffs, scope additions mid-build, un-stalling).

## Agent brief templates (load-bearing clauses)

**Every live-run agent MUST get this paragraph** (agents stalled on "armed a monitor, waiting for notifications" 5+ times across two runs):
> FOREGROUND-LEG DISCIPLINE: drive everything yourself; NEVER arm monitors or wait for
> notifications. To wait on a process use a single blocking Bash call:
> `while pgrep -f <proc> >/dev/null; do sleep 15; done` (generous timeout), then read results.

**Builder briefs**: repo+branch+tip hash; HARD RULES block (no Co-Authored-By; no research-repo references in product comments; do NOT push; flag-gated OFF); READ FIRST list (the pattern files); measured facts written self-contained; the quartet gate command block; falsification requirement; "return file map + gate tails + commit hash + deviations".

**Sweep briefs**: cell table with verbatim-label capture requirement; paired dumps (tab-strip via `AXSnapshot chrome-window --skip-webarea` + plain `chrome` for web-area blindness); mic log via the product mic binary alongside every cell; explicit GO/NO-GO criteria; commit findings doc + curated captures.

**Challenger briefs**: point at the charter file; "attack whether the RIGHT decision was made"; enumerate the specific decisions as a floor; require verdicts UPHELD/OVERTURN/NEEDS-EVIDENCE with settling experiments; append to the challenges log. Answer every OVERTURN/NEEDS-EVIDENCE in the log before the related un-gate.

## Live-gate infrastructure (paths that exist today)

- Drivers: `research/meet-dom-detector/live/meet-tabaway-live.mjs` (v3.3 pattern — the reference),
  `research/teams-web/teams-tabaway-live.mjs`, `research/zoom-web/zoom-tabaway-live.mjs`.
- Command shape: `MSD_DETECTOR_BIN=<worktree dist binary> MSD_MIC_BIN=<mic helper dist> node <driver> --tabaway`
  (drivers set their own MSD_*_TABSTRIP=1; product binaries build in the FEATURE worktree —
  `~/projects/work/bubbles-dev-tabaway/...` — never the main checkout, whose branch may differ).
- Hosting automation: `qa/zoom-live/zoom-host-lib.mjs` (bootstrapMeeting/harvestInvite/admitLoop/
  endMeeting with the quit-confirm fallback/reallyInMeeting); `qa/teams-live/teams-host-lib.mjs`
  (same shape, if the 2026-07-07 automation attempt succeeded — check its existence).
- Persistent signed-in Chrome profile: `research/meet-dom-detector/live/.rig-profiles/host`
  — launch IN PLACE with `--user-data-dir`, CLEAN-QUIT (CDP Browser.close → SIGTERM), NEVER
  SIGKILL/rm (copied/temp profiles = Google passkey challenge every run: device-bound sessions).
- Real-mic Chrome flags: `--use-fake-ui-for-media-stream` WITHOUT the fake-device flag.
- Preflights: `ioreg -n Root -d1 | grep IOConsoleLocked` must be No; caffeinate running;
  `strings <binary> | grep <logTag>` fragment check (interpolated tags only match fragments);
  no stale native meeting (`reallyInMeeting()`), no profile SingletonLock.
- Raw evidence: drivers persist stderr.log / wire.ndjson / driver.log per run under gitignored
  `logs/`; results ndjson append-only (never clobber — reconcile if a runner reseeds).

## Rig assertion traps (each cost a full run — bake into new drivers)

1. CDP `/json/new` needs **PUT** (Chrome 110+ rejects GET with 405) — silent vacuous phases: the tab never actually backgrounds. Use cdp-lib `httpJsonPut`.
2. **No-churn recovery**: keep-alive Detections compare == by design → recovery emits NO fresh
   active event. Assert released-reason + no-idle, tolerate 0..1 actives (>1 = churn FAIL).
3. **Foreground leave can never fire released reason=left|gone** — the readable pass releases
   (reason=readable) before the click lands. Engaged-end needs the meeting to die while
   BACKGROUNDED (host-side end from the host lib).
4. **Solo meetings emit no speaking events** — release-to-[] assertions must gate on someone
   having spoken pre-hold.
5. **Chrome exempts AUDIBLE tabs from throttling** — a speaking guest defeats blindness; quiet
   sub-cells are the load-bearing ones (Teams/Zoom web measured blind even audible; Meet not).
6. **Throttle is non-deterministic** on long holds — phase logic needs a no-throttle tolerance
   branch (zero-idle + zero stray lines), with the deterministic engage proof in a fresh-background phase.
7. **Wire key selection**: co-resident native apps emit on the same unified wire — filter to the
   platform-prefixed browser key (`zoom:<digits>`), never last-wins.
8. **Phase-boundary drains**: a tabBack's release lands on the NEXT probe cycle — drain (bounded
   wait + settle) before stamping the next phase's window.
9. Stale native meetings wedge bootstraps — guard with reallyInMeeting → endMeeting (quit-confirm
   fallback surfaces the named "End meeting for all" button when toolbars auto-hide) → abort loudly if unkillable.
10. Walk-stats/flush: SIGTERM the detector, never SIGKILL.

## Shell/tooling gotchas

`git checkout -- .` destroys in-progress tracked edits (use `git rm --cached` + rm for staged
fixtures); zsh `echo ===` expands; `git diff HEAD~1 HEAD` not `HEAD~1`; disk fills from worktree
node_modules (symlink from the main checkout instead of installing); fixtures live on branch
`active-speaker-fixtures` (selftest replay skip-if-absent); ScheduleWakeup for status cadence
only — completed background agents re-invoke automatically.

## Where things live

Product branch: bubbles-dev `feature/meet-tabaway-keepalive` (worktree `~/projects/work/bubbles-dev-tabaway`).
Sandbox: demo-app (rigs, sweeps, this doc). Memory index: `MEMORY.md` in the Claude project dir.
Challenger charter: `demo-app/.claude/agents/challenger.md`.

## Addenda (2026-07-07, from the consumer-Teams close-out)

11. **Builders and gate-runners must never share a worktree.** A gate run compiled a binary
    while a builder had uncommitted edits in the same tree — the gate agent had to prove the
    delta inert after the fact. Run-only agents verify `git status --untracked-files=no` is
    EMPTY + tip hash before building; builders get their own detached worktree when a run
    overlaps.
12. **`git add <directory>` sweeps restored fixtures into commits.** Fixtures-present test
    runs leave `Fixtures/` on disk; a later directory-level `git add` committed 178k lines of
    them. Add by explicit file path on the feature branch, and `rm -rf` the fixtures dir right
    after the fixtures-present leg (the tree must end clean).
13. **Title-derived identity needs a mutation audit.** SPA page titles mutate structurally
    (panel prefixes like `People | …`) — key on the stable segment (last-before-suffix), and
    pin key-stability in the live gate (toggle the mutating UI mid-call, assert the wire key
    holds).
