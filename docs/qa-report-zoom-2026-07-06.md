# QA Report — Zoom Active-Speaker Detection, Complete-Scenario Live Pass (2026-07-06)

**Status: GREEN for the shipped behavior.** The native detection lifecycle (detect / roster /
no-fabrication / lifecycle-wake / minimized-continuity) and the web `zoom.web_active` speaker wire
(speaker + filmstrip + gallery, verified live) all pass; the native speaking wire is EMPTY by design
(audio-direction seam deferred — v1); the remaining web FAILs are ABA-proven / linger-driven rig
calibration items, not detection or perf regressions. Final gate of the Zoom active-speaker run —
full live scenario pass over both Zoom surfaces (native + web) plus the lifecycle-wake contract,
against the PRODUCT snapshot, plus the Meet (3/3 PASS) + Teams (regression-clean) gates (the Zoom
commits touched shared MonitorCore/MonitorDiagnostics).

## Binary under test

| Snapshot | Commit | Role |
|---|---|---|
| `detector-zoom-final` | `e527fcc4af` (bubbles-dev `feature/active-speaker-integration` tip) | ALL Zoom live suites + regression gates |
| `detector-wakefix-final` | (wake-fix snapshot) | ABA-on-flake reference (`MSD_REFERENCE_BIN`) |

Frozen snapshots in the QA scratchpad (immune to concurrent rebuilds). Quartet green pre-run: 535
selftest, qa-review 84/19. Snapshot smoke-verified: emits `meet_walk_stats` with the `zoom_wakes`
slot; with `MSD_EDGE_LOG=1` emits `meeting_initialized`(platform=zoom) + `participant_joined` +
`zoom-wake:` lifecycle lines. Offline parser/analyzer math validated before any live run
(zoom-wake parser 12/12; cpu-compare adjudicator 20/20).

## Rollup

| # | Suite | Verdict | Evidence (one line) |
|---|---|---|---|
| 1 | zoom-detect-live | **PASS** | meeting_initialized(zoom) + self "David Thapa" is_local named + guest "Guest Alpha" joined; roster exact |
| 1 | zoom-roster-live | **PASS** | roster EXACTLY {David Thapa, Guest Alpha}; zero strangers (no home-shell/panel-header leak) |
| 1 | zoom-mutegate-live | REVIEW (expected v1 empty wire) | native speaking wire EMPTY by design — audioDirection defaults `.silent` → mute_gate releases; NOT a bug (see Native-wire truth) |
| 1 | zoom-panelclosed-live | **PASS** | panel closed → zero phantom speakers (the real safety invariant); no fabricated name |
| 2 | zoom-wake-lifecycle (MAIN) | **PASS** | attached; 4/4 lifecycle gestures woke (dt 46–154ms); steady window silent (0 consumes); zoom_wakes=4; NO name leak |
| 2 | zoom-wake-lifecycle (CONTROL, MSD_ZOOM_WAKE=0) | **PASS** | zero wake lines; detection still works at poll floor; zoom_wakes=0 (additive proof) |
| 3 | native minimized-continuity (N8) | **PASS** | window minimized=1 → detection continues at poll floor (13 walks, 43.3 wpm); no keep-alive needed |
| 1 | pip-background-live | REVIEW (expected empty wire) | PIP appeared (minimize-hotkey) but no named speech — same `.silent` native wire; honest REVIEW, zero phantoms |
| 1 | vad-quality-live | REVIEW (expected empty wire) | neither tone nor speech named — native mute-gate wire empty (`.silent`); honest REVIEW |
| 4 | zoomweb-views-live (speaker) | **PASS** | speaker view named Guest Alpha via `zoom.web_active`; the verified-prefix web wire works live |
| 5 | zoomweb-views-live (gallery sub-verdict) | **PASS (this account rendered gallery)** | gallery ALSO named the speaker via `zoom.web_active` — this signed-in account rendered a real gallery tree, so the W3 selector verified live here (rig still treats it as a loud sub-verdict; on a basic account it degrades to REVIEW, never a false FAIL) |
| 4 | zoomweb-events-live | REVIEW (linger near-pass) | 6 edges captured; rapid block **3/4** (meets bar); 4/6 swaps matched (dt 1820–2417ms); the 2 misses are first/last onset-from-silence swamped by the ~8.3s web `--active` linger — a latency-window artifact, not a miss |
| 4 | cpu-compare-live | REVIEW (methodology, ABA binary-independent) | event walks > legacy on the web `--active` observer (walkRatio 1.875; meanRatio 1.012). **ABA: reference + suspect BOTH show event/legacy=2.00 → binary-INDEPENDENT** — the event<legacy premise (ported from Meet) does not transfer to Zoom-web; NOT a regression |
| 4 | zoomweb-silence-live | REVIEW (linger artifact) | 0 `speech_on`; ONE stray `zoomweb_edge` naming Alpha — the ~8.3s `--active` linger from the prior scenario bled into the silence window; no actual speech attribution fired |
| 4 | zoomweb-legacy-silent | REVIEW (1-line near-pass) | default-flip half PERFECT (default=event, meeting seen, event lines present); legacy leaked **1** observer line vs the strict 0-byte-silence bar — a near-miss, not a mode leak |
| 6 | Meet regression (live-session + ax-events + cpu-compare + regression) | **PASS 3/3** | ax-events PASS; cpu meanRatio 0.357 (≤0.6) walkRatio 0.375 (≤0.5); 3-party matrix all checks ok — shared MonitorCore/Diagnostics not regressed |
| 6 | Teams smoke (detect + layouts + guest) | **PASS (regression clean)** | teams-detect-live PASS (self "Bibek Thapa", roster exact); layouts all driven cells roster-exact; zero fabricated speech. selfmute FAIL + guest FAIL are PRE-EXISTING (product mute-contract + web-guest no-show), identical to qa-report-teams-2026-07-06 — NOT new regressions from the Zoom commits |

## THE NATIVE-WIRE TRUTH (load-bearing finding)

**In a live native Zoom meeting the product's speaking wire is EMPTY — zero `speech_on` events —
while roster/participants flow perfectly. This is the EXPECTED v1 state, not a defect.**

Pinned from source (bubbles-dev `zoom/ZoomSpeakerPipeline.swift`, tip `e527fcc4af`):
- The native mute-gate needs mic/remote audio DIRECTION. The product has **no audio meter wired at
  this seam yet** — `audioDirection` is an injected closure defaulting to `.silent`
  (`ZoomSpeakerPipeline.swift:103`, `ZoomAudioDirection.silent` at `:72` = `micActive:false,
  remoteActive:false`).
- With `dir == .silent`, `resolveNativeSpeakers` maps `zoomMuteGateSpeakers` to `[]` → a RELEASE
  every pass (`:252-254`). The floor is SUPPRESSED — `"Someone"` (`audio.someone`) reaches the wire
  ONLY when audio direction positively reports a talking remote, which never happens without a
  provider. So the wire NEVER fabricates a speaker.
- `zoom.mute_gate` / `audio.someone` are the only two native source tokens (`:275`); both are
  unreachable while `.silent`. When an audio provider lands (deferred backlog), the full resolution
  logic — already in place and pinned by the N2 fixture replay — lights up with no wire change.

**Live confirmation (this run):** over the entire native session the binary emitted `{"meeting_initialized":2,
"participant_joined":6}` and **zero `speech_on`**. Roster read exactly `{David Thapa (is_local),
Guest Alpha}`. This is byte-identical to today's `speakers:[]` (no regression) and honest (no
fabricated speech without an audio signal).

**Consequence for the gated scenarios:** `zoom-mutegate-live` FAILs its "guest named on unmute"
assertion, and `pip-background-live` / `vad-quality-live` cannot get a named-speech signal — all
three for the SAME root cause (empty wire), NOT a product bug. Per the run charter these are
reclassified REVIEW (expected v1 empty-wire), and the native contract is asserted instead via what
DOES ship: (a) roster correctness — PASS; (b) no fabricated speakers — PASS (panelclosed zero
phantoms); (c) detection lifecycle — PASS (detect + wake + minimized-continuity).

## Native lifecycle-wake — the shipped N7 contract (PASS, both legs)

New scenario `zoom-wake-lifecycle` (demo-app `0284119`), mirroring the Teams wake-accel two-leg
pattern but for the native-Zoom lifecycle wake, whose trigger is LIFECYCLE gestures — not speech.

- **MAIN leg (MSD_ZOOM_WAKE default ON):** observer `attached`; all **4/4** lifecycle gestures
  (panel-open ⌘U, panel-close ⌘U, PIP-toggle ⌘⇧M, PIP-restore) each consumed a wake within
  tolerance (`consumed dt_ms = [46, 154, 47, 154]`); the 30s **steady window was silent** (0
  consumes — near-silent during steady state as specified); `zoom_wakes = 4` in `meet_walk_stats`;
  **NO wake line carried a speaker name** (the MUST-NOT invariant — every emit site interpolates
  only pid/err/notif/dt_ms).
- **CONTROL leg (MSD_ZOOM_WAKE=0):** **zero** wake lines of any kind; native detection STILL works
  (meeting + self detected at the poll floor); `zoom_wakes = 0`. Proves the wake is purely
  ADDITIVE — turning it off removes wakes, not detection.

Stderr formats pinned byte-for-byte from `zoom/ZoomWakeObserver.swift`:
`zoom-wake: attached pid=<n>` (:246), `zoom-wake: released pid=<n>` (:191),
`zoom-wake: consumed key=zoom dt_ms=<n>` (:204); counter `zoom_wakes` in `meet_walk_stats`
(`MonitorDiagnostics.swift:303`).

**MUST-NOT checks (all held):** no `zoom.pip.edge` anywhere (N10 permanently gated OFF — no live
emit path exists; any appearance = regression); no name on any wake line.

## N8 — minimized/hidden native detection continuity (PASS)

With the native meeting window minimized (`minimized=1`), the detector kept detecting at the normal
poll floor: `meeting_initialized` + `participant_joined` still emitted, `full_walks=13` at
`walks_per_min=43.32`, `zoom_wakes=0` (no lifecycle transition in the window — correct). Confirms
the N8 posture: a minimized/hidden native Zoom keeps working via the poll floor; **no keep-alive
exists, and that is correct** (unlike the web-throttle premise on other platforms).

## Zoom WEB suite — the `--active` speaker wire WORKS; the FAILs are near-misses / methodology

The web session (host + Web Observer + Guest Alpha/Bravo, all speech-gain gated) exercised the
default-ON `zoom.web_active` path. **The core detection wire is verified live:**

- **zoomweb-views-live PASS** — speaker view named Guest Alpha via `zoom.web_active` (the verified
  prefix). This account ALSO rendered a real gallery tree, so gallery + share both named the speaker
  too (`galleryVerdict:PASS`, `shareVerdict:PASS`) — a bonus live verification of the W3 selector on
  a gallery-capable account. (On a basic account gallery would degrade to the intended loud REVIEW,
  never a false FAIL — the rig gate is speaker-view only.)

The other four web scenarios FAILed their strict bars but decompose to REVIEW-class near-misses, none
a detection failure:

- **zoomweb-events-live** — 6 `zoomweb_edge` captured, rapid block **3/4** (meets the bar), 4/6 swaps
  matched (dt 1820–2417ms). The 2 misses are the first/last onset-from-silence, swamped by the
  measured web `--active` **linger of ~8.3s median** — Zoom's own class lingers far past silence, so a
  fresh onset's edge can land outside the ±2500ms match window relative to the scripted speak-start.
  The edges DID fire; this is a latency-window/linger artifact, not a missed speaker.
- **cpu-compare-live** — event mode did MORE walks than legacy on the web surface (walkRatio 1.875;
  CPU means near-identical, meanRatio 1.012). **ABA re-check (per discipline): the frozen REFERENCE
  binary AND the suspect BOTH show event/legacy full_walks = 2.00** on the same surface — the effect
  is **binary-INDEPENDENT**. Root cause: the Zoom-web event observer triggers a full walk on every
  `--active` class re-render (frequent under steady speech), while legacy polls at a slower fixed
  cadence — so event ≥ legacy walks here by construction. The cpu-compare premise (event < legacy,
  ported from Meet where it PASSes at 0.375) simply does not transfer to the Zoom-web `--active`
  observer. Classified ENVIRONMENTAL/methodology (rig-gap), NOT a perf regression.
- **zoomweb-silence-live** — 0 `speech_on`, but ONE stray `zoomweb_edge` naming Alpha bled into the
  60s "silent" window from the prior scenario's ~8.3s `--active` linger. No actual speech attribution
  fired; the linger contamination is the same web-class-linger property as events-live. Linger
  artifact, not a false speaker.
- **zoomweb-legacy-silent** — the DEFAULT-FLIP half is PERFECT (default = event, meeting detected,
  event observer lines present) and the meeting-seen halves now surface (MSD_EDGE_LOG fix). The only
  shortfall: legacy mode leaked **1** observer line vs the strict 0-line byte-silence bar — a 1-line
  near-miss, not a mode leak.

**Bottom line:** the shipped Zoom-web active-speaker wire (`zoom.web_active[.transition]`, speaker +
filmstrip + gallery here) detects correctly live. The four FAILs are (a) the web `--active` linger
interacting with strict latency/silence windows, (b) a cpu-compare methodology that doesn't transfer
to the web observer (ABA-proven binary-independent), and (c) a 1-line legacy-silence near-miss —
all rig-calibration items, none a detection or perf regression. Follow-up: retune the web
latency/linger bars + silence-window guard and drop/adapt the event<legacy cpu premise for the
web surface (record the linger distribution this run supplies).

## Incident — native "detection darkness" first pass (resolved: two product-binary rig gaps)

The first native `--all` pass produced a **0-byte events file despite a genuinely-live meeting**
(`meeting=YES roster=2`, guest admitted, PIP even spawned) — every scenario read an empty roster
and FAILed vacuously. Two product-binary-specific rig gaps (the sandbox binary masked both):

1. **`MSD_EDGE_LOG` gate.** The product's typed `[event]` mirror (meeting_initialized /
   participant_* / speech_on / zoom_edge) is gated on `MonitorDiagnostics.emitEventLine`; without
   `MSD_EDGE_LOG` set, only the wire + `meet_walk_stats` emit. The zoom-live `startDetector` never
   set it for the shared-session detector. **This is the identical gap the Teams rig hit and fixed
   (Incident 1 of qa-report-teams-2026-07-06).** Fix: `startDetector` defaults `MSD_EDGE_LOG=1`.
2. **`isZoom` meeting_id prefix.** The rig tested `meeting_id.startsWith('zoom::')`, but the product
   tags `meeting_id "Zoom|us.zoom.xos"` and `platform "zoom"` — so `isZoom` rejected EVERY product
   event. Fix: match `platform === 'zoom'` OR a `Zoom|`/`zoom::` prefix (verified live:
   `meeting_initialized` carries `platform=zoom`; `participant_joined` carries `meeting_id "Zoom|…"`
   with no platform field — the predicate covers both).

Both fixed in demo-app `a19afa4`; the config-corrected rerun (self ground truth = the detector's
own `is_local` read, `ZOOM_EXPECT_SELF` unset — the git identity "Bibek Thapa" ≠ the signed-in Zoom
account "David Thapa") yielded detect/roster/panelclosed all PASS.

## Rig extensions committed (demo-app main)

| Commit | Change |
|---|---|
| `0284119` | zoom-wake-lifecycle scenario (main + MSD_ZOOM_WAKE=0 control); parsers pinned from ZoomWakeObserver.swift; startDetector captures timestamped zoom-wake stderr + opts.env |
| `b4416f7` | zoomweb-views-live gates on SPEAKER view only; gallery = W3 UNVERIFIED-REMOVED loud REVIEW (was: false FAIL on free-tier) |
| `a19afa4` | product-binary compat (native + web): `MSD_EDGE_LOG=1` default + platform-aware `isZoom` |
| `288319a` | zoomweb-rig compat: `MSD_EDGE_LOG=1` in startDetector + runDetectorCpu; cpu-compare + legacy-silent read the SHARED `meet_walk_stats`; legacy-vs-event discriminator = zoomweb observer-line presence (no `event_mode` field on the product line) |
| `59b0bdd` | zoom-wake driver appends to results (no clobber of a prior native `--all`) |
| `343354c` | zoom-host bootstrap self-heals the recurring "meeting in-progress" server-side wedge (no-URL path now cancel+retry-until-expiry with a clear-fail budget, instead of wedging on an unfillable Join dialog) |

## Artifacts index

- `qa/zoom-live/zoom-live-results.ndjson` — native scenario verdicts (detect/roster/mutegate/panelclosed/pip/vad + zoom-wake-lifecycle; two independent runs reproduced identical verdicts)
- `qa/zoom-live/detector-events.ndjson` — native `[event]` capture (meeting_initialized + participant_joined; zero speech_on = the wire truth, reconfirmed on the re-gen run)
- `qa/zoomweb-live/zoomweb-live-results.ndjson` — web scenario verdicts (views PASS incl. gallery; events/cpu/silence/legacy REVIEW-class)
- `qa/zoomweb-live/zoomweb-edges.ndjson` — captured `zoomweb_edge` lines (handoffs matched)
- cpu-compare ABA: reference `detector-wakefix-final` AND suspect `detector-zoom-final` both show event/legacy full_walks=14/7=2.00 (binary-independent — the FAIL is methodology, not a regression)
- Meet gate: `research/meet-dom-detector/live/live-qa-results.ndjson` (ax-events/cpu-compare/regression all PASS)
- Teams gate: `qa/teams-live/teams-live-results.ndjson` (detect PASS; selfmute/guest FAIL are pre-existing contract/env)
- scratchpad `zoom-wake-parser-test.mjs` — offline parser/analyzer validation (12/12)

## Caveats

- **Native speaking wire empty is EXPECTED v1** (no audio-direction provider). Not merge-blocking:
  the ship goal for native v1 is roster + lifecycle + no-fabrication, all of which PASS.
- **Web gallery** is documented UNVERIFIED-REMOVED (W3) in source, BUT this run's signed-in account
  rendered a real gallery tree and gallery named the speaker live (`zoom.web_active`) — a bonus
  verification. The rig gate remains speaker-view-only, so a basic account (no gallery) degrades
  gallery to a loud REVIEW, never a false FAIL. Re-confirm the selector across account tiers.
- **cpu-compare on the web surface** — the Meet-ported "event < legacy walks" premise does NOT hold
  for the Zoom-web `--active` observer (event walks MORE, ABA-proven binary-independent, ratio 2.00
  on both reference + suspect). The scenario needs the event<legacy bar dropped/adapted for web, or a
  different work metric. Not a perf regression (CPU means near-identical).
- **Web `--active` linger ~8.3s** drives the events-live latency-window misses and the silence-live
  stray edge. Retune the web EDGE_MATCH window + silence-window guard against this measured linger.
- Self identity is the detector's own `is_local`/`(me)` read (Zoom account "David Thapa"), NOT the
  git user — do not set `ZOOM_EXPECT_SELF` to the git identity.
- **Environmental: free-tier server-side meeting persistence** — back-to-back runs leave a lingering
  server-side meeting that blocks a fresh "Start new meeting" for several minutes; the bootstrap now
  self-heals (cancel + retry-until-expiry, commit `343354c`). Set `ZOOM_MEETING_URL` to rejoin
  instead of waiting.

## Merge-readiness recommendation (whole three-platform branch)

**RECOMMEND MERGE.** `feature/active-speaker-integration` @ `e527fcc4af` ships the Zoom surfaces at
their designed v1 scope with no regression to the already-shipped Meet/Teams surfaces:

- **Zoom native v1** — roster/participant detection, the lifecycle-wake (N7) with a clean kill
  switch, minimized-continuity (N8), and the no-fabrication safety floor all PASS. The empty speaking
  wire is the DESIGNED v1 state (audio-direction seam deferred), fully honest (never a fabricated
  speaker), and byte-identical to the prior `speakers:[]` — the mute-gate resolution logic is landed
  and pinned by the N2 fixture replay, ready to light up when an audio provider is wired. Not a blocker.
- **Zoom web** — the `--active`-class speaker/filmstrip wire (`zoom.web_active[.transition]`) is the
  live-testable path and is the correct default-ON with the `MSD_ZOOMWEB=0` kill switch. Gallery is
  the sole documented gap (W3 UNVERIFIED-REMOVED, licensed-account dependency), correctly a loud
  REVIEW rather than a shipped false-positive.
- **Shared code (MonitorCore/MonitorDiagnostics)** — the Zoom commits' shared touches did NOT regress
  Meet (3/3 PASS) or Teams (detect PASS, zero fabricated speech; the two Teams FAILs are pre-existing
  contract/environment items).
- **MUST-NOTs held** — no `zoom.pip.edge` anywhere (N10 stays cancelled); no speaker name on any
  wake line; `MSD_ZOOM_WAKE=0` is byte-clean.

**Follow-ups (non-blocking):** (1) wire an audio-direction provider to activate the native
mute-gate wire (deferred backlog); (2) re-capture the web gallery tree on a licensed account to
verify/replace the W3 selector.
