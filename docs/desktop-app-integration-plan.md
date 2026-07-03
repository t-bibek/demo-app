# Integrating demo-app detection into `bubbles-dev/packages/desktop`

**Date:** 2026-07-03. Target: `/Users/bibekthapa/projects/work/bubbles-dev/packages/desktop`
(branch `feature/desktop-app-backend`), native helper
`native/bubbles-meet-detector/` (Swift macOS + C++ Windows).
Goal: restructure demo-app so its AX code is **source-identical** to the product helper —
develop/test here, sync files there.

---

## 1. What the product has today (verified)

- **Helper binary** `bubbles-meet-detector` (~2,000 lines Swift), spawned by
  `src/main/capture/meet-detector.ts` (`spawn(bin)`, line-buffered NDJSON parse, EventEmitter).
  Built by `macos/build.sh` = `swiftc -O *.swift` → `dist/darwin/`; packaged via
  `forge.config.mjs` `extraResource`. Windows mirror in C++ (`windows/*.cpp`, same module names).
- **Protocol (NDJSON stdout):** `{"event":"meet-active", key, platform, kind, sourceApp,
  sourceBundle, browser, title, url, participants:[names]}` on change, `{"event":"meet-idle", key}`,
  `{"event":"error", message}`. Key = URL (browser) or `platform|sourceApp|title` (native).
  Poll = 3 s, whole-system sweep (`detectAllActiveMeetings()` in `Platforms.swift`).
- **Scope: meeting-active + roster names only.** No speaking, no mute, no `AXDOMClassList`
  in the production path. `Filters.swift` even strips `" is speaking"` off names and discards it.
- **Module layout (macos/):** `main.swift` (loop+emit) · `Platforms.swift` (Platform table +
  `Detection` struct + dispatcher) · `Browsers.swift` (`BROWSER_BUNDLE_IDS`, `webAreasFor`) ·
  `WindowList.swift` (CGWindowList pre-filter) · `AXKit.swift` (generic AX helpers) ·
  `Filters.swift` (`cleanCandidate`/`isPlausibleName`/`isLooseName`) · `MeetExtractor.swift` ·
  `ZoomExtractor.swift` · `TeamsExtractor.swift` · `Dump.swift` (`--dump`) ·
  `Watch.swift` (`--watch`, per-tile structural diagnostic — **currently uncommitted/untracked!**).
- **TS side:** `MeetActiveEvent`/`MeetingSession` types in `src/shared/ipc/contracts.ts`
  (participants map + `trigger: ['ax'|'mic']`), but **no subscribers yet** — detection events
  are emitted into the void. Schema changes are cheap *now*.
- **Two latent bugs to fix regardless:**
  1. Full accessibility tree is forced only in the Teams path
     (`TeamsExtractor.swift:143`, `AXManualAccessibility`). Chrome/Meet path never sets
     `AXEnhancedUserInterface` → Chromium may serve the degraded tree → `AXDOMClassList`
     (and sometimes names) absent. Demo-app has the same gap in its scanner (only AXSnapshot
     forces it). Any speaking work is unreliable until this is hoisted into shared init.
  2. `Watch.swift` + the `--watch` arm in `main.swift` are uncommitted on the branch.

## 2. Gap table: demo-app capability → product location it must land in

| Capability (demo-app) | Demo-app source | Lands in (product file) |
|---|---|---|
| Meet speaking: `kssMZb` ring + corner-widget/gauge (`IisKdb`/`gjg47c`) structural read | `AccessibilityScanner.swift` meetTileObservations/tileClassTokens + `MeetActiveSpeaker.swift` | `MeetExtractor.swift` (new `meetActiveSpeakers(in:)`) |
| Meet remote-config class rules + rotation telemetry | `MeetSpeakerRules.swift` | new shared `SpeakerRules.swift` (or env/flag-fed) |
| Meet roster via tile captions + "Pin <name>"/"More options for <name>" mining | `AccessibilityScanner.swift:704-794` | `MeetExtractor.swift` (extend `extractMeetParticipants`) |
| Meet meeting-id from URL | `MeetingIdentity.swift` | `Platforms.swift` (enrich `Detection`) |
| Teams roster **mute** parsing + PIP "<name> is speaking" note | scanner `teamsRosterEntries`/`teamsSpeakingNote` | `TeamsExtractor.swift` |
| Zoom native panel mute (`"Computer audio muted/unmuted"`) + `(me)` self-hint | scanner `zoomNativeRoster`/`zoomSelfNameHint` | `ZoomExtractor.swift` |
| Zoom web active-speaker class (`speaker-bar-container__video-frame--active`) | scanner `zoomWebSpeakerBar` | `ZoomExtractor.swift` |
| Name cleaning/reject lists | `NameParsing.swift` | `Filters.swift` (merge; keep one canonical list) |
| AX class/geometry helpers (`axClassList`, frames) | scanner privates + `AXSnapshot` | `AXKit.swift` (add `axClassList`, `axFrame`, `axParent`, `forceFullAXTree(pid:)`) |
| Audio meters / VAD / fusion / SessionTracker / UI | Engine + SpeakerCore | **stays demo-app-only** (product fuses in TS later; mic side = `bubbles-mic-detector`) |

## 3. Changes to make in demo-app FIRST (parity restructure)

The point: make demo-app compile **the exact product files**, so testing here = testing the product.

1. **Vendor the product core as a new SwiftPM executable target.**
   Copy the 11 files from `packages/desktop/native/bubbles-meet-detector/macos/` verbatim into
   `demo-app/macos/Sources/BubblesMeetDetector/` and add an executable target
   (`bubbles-meet-detector`) in `Package.swift`. The product's `build.sh` is just
   `swiftc *.swift`, so file additions need no build-config changes on their side.
2. **Add a sync script + drift gate.** `macos/scripts/sync-detector.sh` with `push` / `pull` /
   `--check` (diff both trees, exit non-zero on drift). Workflow: edit in demo-app → test →
   `sync-detector.sh push` → PR in bubbles-dev. Document in both READMEs which repo is canonical
   (demo-app = dev bench, bubbles-dev = source of truth once merged).
3. **Refactor demo-app to consume the shared core.** Two steps:
   a. Short term: keep `AccessibilityScanner` but delegate per-platform extraction to the shared
      extractor functions (kill the duplicated logic file by file).
   b. End state: the SwiftUI app *spawns the built `bubbles-meet-detector` binary* and consumes
      its NDJSON exactly like `meet-detector.ts` does — demo-app becomes a live harness of the
      product binary, layering its audio/VAD/SessionTracker/UI on top and logging both streams
      for comparison.
4. **Port the improvements INTO the shared files** (per the gap table), preserving existing
   function signatures. New capabilities go in as *new* functions + additive `Detection` fields,
   never signature breaks — the C++ Windows port must stay signature-mappable.
5. **Protocol: extend additively, gated by a flag.**
   - Keep `participants: [String]` unchanged (back-compat).
   - Add `participantDetails: [{name, isMuted?, isSelf?}]`, `meetingId`, and
     `activeSpeakers: [{name, source}]` to `meet-active`.
   - Speaking wants ~500 ms–1 s cadence vs the 3 s roster sweep: add a `--speakers` CLI flag that
     enables a fast targeted loop (re-scan ONLY the active meeting's tile widgets, bounded walk),
     emitting a light `{"event":"speaker", key, names:[...], source}` line on change. Product
     opts in when ready; default behavior identical to today.
6. **Fix the full-tree bug in the shared core:** `forceFullAXTree(pid:)` in `AXKit.swift`
   (set the enhanced-accessibility flag on the app element once per pid) — call it from every
   browser probe and the Teams probe (replacing the local hack). This also fixes demo-app's own
   scanner reliability.
   - **Verified against Recall's shipping binary (`@recallai/desktop-sdk`):** Recall forces the
     tree with **`AXEnhancedUserInterface`** — `AXManualAccessibility` is absent from all three
     of its binaries. Chromium honors *both* attributes, so either works. The product's Teams
     path currently uses only `AXManualAccessibility` (`TeamsExtractor.swift:143`); demo-app's
     `AXSnapshot` sets both. Recommend setting both (belt-and-suspenders); at minimum add
     `AXEnhancedUserInterface` to the Chrome/Meet probe, which today forces nothing → why
     `AXDOMClassList` is unreliable there.
7. **Testing infrastructure (the reason demo-app exists):**
   - Extract pure decision logic (speaking-token predicates, corner-widget geometry matcher,
     name filters) into a UI-free file testable in `SpeakerCoreTests` with fixtures built from
     `ax-dumps/*.json` (speaking + silent tiles + negative controls).
   - Keep `--dump`/`--watch` as the shared diagnostics; retire demo-app's overlapping AXDump in
     favor of the product's `Dump.swift` (AXSnapshot stays — full-fidelity JSON is the fixture
     source).
   - Add a replay comparison: run old binary vs new binary side by side in a live meeting; diff
     NDJSON streams.
8. **Do NOT port into the shared core:** MicMeter, SystemAudioMeter, DetectionEngine fusion,
   SessionTracker, NDJSON session log, SwiftUI — product composes those differently
   (mic = `bubbles-mic-detector`, fusion belongs in TS/`MeetingSession.trigger`).

## 4. Integration sequence in bubbles-dev (after parity)

- **P0 (hygiene, this week):** commit `Watch.swift`/`--watch`; hoist `forceFullAXTree`;
  merge unified `Filters.swift`. No schema change, no TS change.
- **P1 (roster quality):** sync improved extractors (Meet control-label mining, Teams/Zoom mute
  parsing feeding `participantDetails`, Zoom self-hint). TS: extend `MeetActiveEvent` type +
  parser in `meet-detector.ts` (fields are additive; no subscribers exist yet, so zero breakage).
- **P2 (speaker events):** enable `--speakers` in the spawn args; TS subscribes and folds into
  `MeetingSession` (participants map already keyed for stable iteration; add
  `speakingNow`/`speech` timeline). Source-tag every attribution (`meet.kssMZb`,
  `meet.structural`, `teams.pip`, `zoom.web_active`) so the backend can weigh them.
- **P3 (fusion):** gate speaker events with audio (product already captures audio; VAD in the
  capture pipeline or TS-side gating with `bubbles-mic-detector` for self) — mirrors demo-app's
  DetectionEngine semantics.
- **Windows:** every Swift change needs a matching `windows/*.cpp` change (same module names).
  Demo-app's `window/` (Electron+PS) is a *research* mirror, not the product's C++ — treat the
  C++ port as its own task; protocol stays identical so it can lag safely.
- **Packaging/permissions:** no forge changes needed (same binary name/path; `swiftc *.swift`
  picks up new files). Accessibility TCC rides on the host app as today.

## 5. Order of work (checklist)

1. [ ] Copy product `macos/` files → `demo-app/macos/Sources/BubblesMeetDetector/`; add target.
2. [ ] `sync-detector.sh` (push/pull/--check).
3. [ ] `forceFullAXTree` in AXKit + call sites (fixes both repos' reliability).
4. [ ] Merge `NameParsing.swift` ↔ `Filters.swift` into one canonical Filters.
5. [ ] Port Meet roster upgrades into `MeetExtractor.swift`; verify vs product output live.
6. [ ] Port Teams/Zoom mute + self-hint into extractors; `participantDetails` in `Detection`+emit.
7. [ ] Add `--speakers` fast loop + `speaker` event (Meet kssMZb/structural first; Teams PIP;
       Zoom web class) behind the flag.
8. [ ] Fixture tests from ax-dumps for the pure predicates; side-by-side NDJSON diff harness.
9. [ ] Sync to bubbles-dev in the P0→P2 order above; TS type/parser updates per phase.
