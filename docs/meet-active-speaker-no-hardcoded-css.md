# Meet Active-Speaker Without Hardcoded CSS — Recall's mechanism + our migration plan

**Goal:** stop depending on Google Meet's obfuscated, ~6-week-rotating CSS class
(`kssMZb` …) for active-speaker detection, by adopting the strategy Recall's shipping
binary actually uses. This doc records **everything we reverse-engineered about Recall's
Meet logic** (so you can build on it) and gives a **phased plan** to get the demo-app off
the hardcoded class.

_Verified 2026-06-21 against `@recallai/desktop-sdk@2.0.19` (commit `41a8616`, macOS arm64).
Tags: **[verified]** = read from the unstripped binary / our source; **[inferred]** =
compiled logic we reason about but can't read directly._

---

## 0. TL;DR

- **Recall does NOT use a CSS class for Meet active-speaker — hardcoded or remote.** [verified]
  - 0 hits for our classes (`kssMZb,eT1oJ,hk9qKe,nn1vQb,s4hFTd,tWDL4c,yHy1rc,FTMc0c`) in all 3 binaries.
  - No Meet `scrapeJS`/class-list strings. The remote scraping rules (S3 manifest) are **Zoom-version-keyed → Zoom-only**.
- **Recall infers Meet active-speaker** from **tile geometry + an AX speaker-set + audio VAD**, keyed by participant **ID** (`Set<Int>`), then syncs it with the video rects. [verified symbols; exact inputs inferred]
- **Our app today depends on the rotating obfuscated class** (`MeetSpeakerRules.builtin`) — the brittle part.
- **Plan:** make **audio VAD** ("is anyone speaking, when") + **geometry** ("which tile is promoted") the durable backbone; demote the class to a **remote-config'd, telemetered fallback** for the gallery-view multi-party case. You can't 100% delete a per-tile signal for 3+ people in gallery view (neither did Recall) — but you can stop *shipping a build* every rotation.

---

## 2026-07-01 — SETTLED against Recall's ground truth: Meet speaking is AUDIO, not AX

We built an automated harness that scores our AX detection against **Recall's own
speaker timeline** (the real product's output) and ran a live co-run. This settles
the question.

### How we compared
- `RECALLAI_DESKTOP_SDK_DEV=1 npm run start:debug 2>&1 | tee recall.log` in the
  `recall-demos/dsdk-tutorial` app emits per-participant `participant_events.speech_on/off`
  with absolute timestamps (`src/server/lib/initializeRecallAiSdk.ts:147`, console-only — must `tee`).
- `MeetProbe` now stamps each tick with `wall` (epoch); `scripts/compare_recall_vs_ax.py`
  aligns the two on the absolute clock and scores our `kssMZb` vs Recall's intervals.
- Run both in the SAME call, then:
  `python3 scripts/compare_recall_vs_ax.py recall.log <meet-probe>/timeline.jsonl --map "Host=Bibek Thapa"`

### Result (clean 2-person gallery co-run, 57s overlap)
| participant | our `kssMZb` precision | recall |
|---|---|---|
| remote (Wedding) | 83% | 89% |
| self (Bibek) | 77% | **14%** |
| anyone-speaking | 91% | 40% |

- **`kssMZb` cannot see self** (14% recall) — your own tile never gets the speaking
  ring. Self MUST come from the mic.
- **`kssMZb` is decent-precision but low-recall for a remote** — corroboration, not a
  primary source. (The earlier "17%" was a confounded pinned+screenshare+hover cell.)
- **Recall's ground truth has every id tagged `VAD-audio` (0,1,2…)** with names from
  the **AX roster** (ids ≥32766). i.e. Recall decides *who's talking* from **audio
  VAD**, and only uses AX for **names**. No AX speaking signal is involved.

### Why Recall works for 2 participants when there's NO UI signal
The remote's **voice physically plays out of your speakers**, so it's present in the
meeting app's audio output **whenever they talk** — independent of any tile/ring/class.
Recall taps that stream (CoreAudio process-tap / ScreenCaptureKit) and runs VAD. With
one remote, attribution is unambiguous (mic = you, system audio = the one remote; name
from roster). No active-speaker UI needed.

**"My speakers are muted — how do they hear it?"** The tap is on the **audio stream
inside the OS**, *before* the output device. Speaker volume/mute, or wearing headphones,
is applied at the very last stage and doesn't affect the tap:
```
Meet renders remote voice → OS audio stream → [TAP] → output device (volume/mute) → speaker
```
So muted speakers / headphones / volume 0 are all fine. Only **missing Screen-Recording
permission** makes the tap silent (`systemPeak = 0`). Exceptions: muting the Meet *tab*
in the browser or dragging Meet's in-app volume to 0 *does* zero the rendered stream.

### Decision (and code state)
- **Production path for Meet = audio VAD + per-participant mute-gate + roster names**
  (identical to Teams-native / Zoom-native), **self via mic**. `kssMZb` stays only as
  weak remote corroboration / a rotation monitor.
- **A structural AX indicator was hunted exhaustively and PROVEN ABSENT** (no
  subrole / DOM-id / description / role-shape / state surface co-varies with speech —
  the active-tile border is pure CSS / a pruned node). So the structural scaffolding
  (`MeetStructuralRules`, `MeetTileStructuralFacts`, `structuralSpeaking`) was
  **removed** as dead code. The discovery harness that proved it is kept:
  `MeetProbe`'s oracle scorer + `scripts/compare_recall_vs_ax.py`.

---

## 2026-07-02 — CROSS-SURFACE: a durable speaking signal DOES exist, but only in the RAW DOM

> **Full write-up in its own doc:** [meet-dom-speaking-detection.md](meet-dom-speaking-detection.md)
> (DOM signals, ranking, config, real-browser QA, Recall re-check, live rig). Summary below.

The "structural indicator PROVEN ABSENT" result above is correct **for the accessibility
surface** (macOS AX / Windows UIA). A separate investigation this date found that Meet's
durable speaking signal lives one layer up — in the **raw DOM**, which the AX/UIA scanners
cannot read (Chromium strips `jsname`/`jscontroller`/`data-*` from AX; `window/docs/ARCHITECTURE.md:146`
says UIA exposes only `class`→`ClassName`/`id`→`AutomationId`). So this is a *different capture
surface*, not a reversal.

**Durable raw-DOM speaking signals (caption-free, most→least stable):**
1. `[data-audio-level]:not([data-audio-level="0"])` on the tile — semantic attr (Vexa's primary).
2. The per-participant audio widget: anchor **`jsname="QgSmzd"` + base class `IisKdb`**; speaking =
   **absence of silence class `gjg47c`** (triple-confirmed) and/or the equalizer bars animating.
3. Tile identity `data-participant-id` (→ `data-requested-participant-id` → `data-ssrc`); name from
   `span.notranslate`. **No captions** (product requirement).
4. `.kssMZb` ring as remote-config'd fallback. Gate on VAD; "Someone" floor.

**Durability evidence (rotation observed in the wild):** between the 2026-06-25 capture and current
open-source snapshots the widget's `jscontroller` rotated `tae9tc`→`ES310d` and its bar child-classes
changed, while `jsname="QgSmzd"`/`IisKdb`/`gjg47c` held. Anchor on jsname/IisKdb/data-*, never on
jscontroller or the obfuscated speaking class. (`tae9tc` now = 0 GitHub Meet hits.)

**Reachability:** needs a CDP / content-script / embedded-webview surface on BOTH platforms — the
shipping AX/UIA app can't see any of these. On the AX surface, caption-free gallery multi-party still
needs `kssMZb`.

Full analysis: `~/.claude/google-meet-speaking-detection-analysis.md`. Runnable, dependency-free
detector + 20/20 scenario harness (3 real captured-DOM + 2 real current-widget + 15 synthetic) + a
zero-dep CDP capture driver: `research/meet-dom-detector/` (`detector.js`, `fixtures.js`, `test.js`,
`cdp-capture.js`).

---

## 2026-07-03 — LIVE AX VERIFICATION (real 2-person call + BlackHole speaker)

Re-verified the **accessibility-tree** side against a live Meet with a controllable real speaker
(guest mic = BlackHole loopback). Tooling: `swift run AXSnapshot chrome` / `--watch` (forces the full
a11y tree, like Recall). This is the AX-surface complement to the DOM findings above.

### 1. Speaking is NOT in the AX tree — confirmed LIVE (not just static dumps)
Captured the meeting AX tree SILENT vs the guest SPEAKING (real recognized speech) and diffed:
**class tokens added/removed = none; descriptions = none; nothing toggles with speech.** The
speaking-indicator widget (`jsname="QgSmzd"`/`IisKdb`, classes `gjg47c`/`Oaajhc`, the
`stripeJiggleAnimation` bars) is **entirely PRUNED from Chrome's AX tree** — `gjg47c`/`Oaajhc`/`QgSmzd`/
`IisKdb`/`stripeJiggle` = **0 nodes**. So the durable DOM signal (§ the RAW-DOM doc) is **DOM-only and
invisible to AX/UIA**. On the AX surface, who-is-speaking MUST come from **audio VAD** (+ geometry +
roster) — exactly the shipped design. `kssMZb` appears transiently in AX (a 24×24 node, and absent
minutes later) — the last-active/focus marker, never a real-time speaking state.

### 2. What the AX tree DOES expose (the usable detection surface) [verified live]
- **Participant names** — `AXStaticText` ("Bibek Thapa", "BH speaker") → the roster for naming.
- **Tile containers** — `.oZRSLe` with `AXFrame` geometry → geometry attribution.
- **Self mic state** — button `AXTitle` "Turn on/off microphone".
- **Screen-share / presentation** — `AXStaticText` **"You are presenting" / "Stop presenting"** appears
  when sharing (auto-shared via `--use-fake-ui-for-media-stream`) → `MeetPresentationActive` works in AX.
- NOT exposed: the speaking equalizer, `data-*`, `jsname`/`jscontroller`, CSS animations.

### 3. AX availability by WINDOW STATE — the operational risk [verified live, host-only]
| State | Meeting AX tree |
|---|---|
| Foreground (active tab, Chrome frontmost) | ✅ present (166 nodes) |
| **Background TAB** (user switched tabs in that window) | ❌ **GONE** — Chrome drops AX for a non-active tab |
| Background APP (another app frontmost, meeting still the active tab) | ✅ present (166) |
| Minimized window | ✅ present (166) |
| Maximized window | ✅ present (146) |

**Takeaway:** AX name/geometry detection **survives minimize, maximize, and app-backgrounding** (the
common "meeting open, working elsewhere" cases) but **dies when the meeting is a background TAB**. Audio
VAD is window-state-independent (system audio), so the fusion degrades to VAD-only ("Someone", no name)
in the background-tab case — a known, acceptable floor.

### 4. Screen-share & multi-party [verified / structural]
Screen-share: presenting markers are in AX (above); the shared surface adds a large region that would be
the biggest `AXFrame` — hence geometry is suppressed under `presentationActive` (already implemented).
Multi-party: the roster (`AXStaticText` names) and `.oZRSLe` tiles scale per participant; speaking stays
absent from AX regardless. (Full live 3-people+share capture is a mechanical repeat — names/geometry
scale, presentation markers appear, no speaking token.)

**Net (AX product):** speaking = **audio VAD**; names = AX roster; geometry = AX `AXFrame`; presentation
= AX "presenting" text — all window-state-robust except a background TAB. Rig: `research/meet-dom-detector/live/`
(`ax-state.js` window-state driver; AX tools in `macos/Sources/AXSnapshot`).

---

## Implementation status (2026-06-22)

> **Update — CORRECTED finding (2026-06-22, narrated run 2).** The earlier
> "class = hover, not speech" was true only for the **self-cluster**
> (`eT1oJ, nn1vQb, s4hFTd, yHy1rc, tWDL4c, hk9qKe`) — that's the hover/self-focus
> highlight, and it was the false-positive source. **Isolating `kssMZb` shows it
> IS a working per-tile active-speaker class:** in a narrated run it fired on the
> **remote 1.3–16.0** and on **self 19.5–31.5**, only while each actually spoke,
> nothing in silence, and **not on hover**. `kssMZb` is the **cross-tile** token
> (fires on self AND remote); `ACcyyc/tC2Wod/t9yCsb` toggle with speech too but
> are **self-only**.
>
> So the plan is **not** "drop the class for a structural indicator" — there is
> **no separate indicator node** in Chrome's AX (the role/subrole/identifier
> structure hunt found nothing toggling; the class *is* the state). Recall reads
> that same element by a rotation-stable property (or its Safari pixel path) not
> exposed to us. The corrected plan:
>
> **Narrow the class to `kssMZb`, keep it config-loadable + telemetered, and FUSE
> with VAD** — VAD-gate → `kssMZb` per-tile (precise *who*, incl. multi-remote) →
> audio-direction fallback when `kssMZb` is absent. `kssMZb` still rotates (~6 wks)
> and Meet sometimes drops it, so VAD + audio fallback + config-load are the
> **mandatory** robustness floor. Per-tile `kssMZb` is the capability Zoom can
> never give (Metal UI) — it solves the multi-remote "which one" that mixed audio
> can't. **Pending:** confirm the speaking order, and validate across
> spotlight/pinned / 3+ remotes / screenshare / gallery-scroll before treating as
> fully settled.

Phases 1–3 + the fused resolver are **implemented** (feasibility study first; see
the per-phase ✅/⏳ markers in §4). Summary:

- ✅ **Fused resolver** — [SpeakerCore/MeetActiveSpeaker.swift](../Sources/SpeakerCore/MeetActiveSpeaker.swift):
  `meetActiveSpeaker(tiles:prevAreas:vadSpeechActive:)` → VAD-gate → class →
  geometry → `Someone` floor, returning a `MeetSpeakerSignal` for telemetry.
- ✅ **Phase 1 — VAD gate (soft)** — gated on the existing `SystemAudioMeter` peak,
  but **only when audio capture is actually running** (no Screen-Recording
  permission ⇒ no gating, so Meet still works Accessibility-only). Real
  Silero/WebRTC VAD is the later **R1** upgrade.
- ✅ **Phase 2 — geometry attribution** — a clearly-dominant tile (auto
  speaker/spotlight view) is attributed without the class; gallery (equal tiles)
  correctly defers. Built on the `AXFrame` area we already read.
- ✅ **Phase 3 — class demoted + config-loadable + telemetered** —
  `MeetSpeakerRules.resolved()` loads an override JSON (Application Support) with
  `builtin` fallback; the engine counts class/geometry/`Someone` decisions and
  warns on stop when speech had floors but **no** class hits (the rotation signal).
- ⏳ **Phase 4 — indicator-child (C)** — *deferred pending live verification* that a
  non-class child node marks the speaker (MeetProbe already captures `roleCounts`).
- ⏳ **Phase 5 — `AXObserver` event-drive** and **R1 — real VAD** — deferred.

Honest limit (unchanged from the plan): this **demotes** the class, it doesn't
delete it — **gallery-view multi-party attribution still needs the class** until
Phase 4 verifies an indicator-child. The win is durability: a rotation is now a
config drop + a telemetry warning, not a silent failure, and speaker-view +
"is anyone talking" no longer depend on the class.

---

## 1. What Recall's binary actually does for Meet [verified — symbols]

### 1.1 The active-speaker code path (demangled `nm`)
```
GoogleMeetMeetingRecorder.inferActiveSpeaker(...)                 ← "infer", not "read"
GoogleMeetSafariMeetingRecorder.inferActiveSpeaker(windowId: UInt32) -> ()
GoogleMeetMeetingRecorder.syncClientFramesAndActiveSpeaker() -> ()  ← sorts MixedVideoRect (tile GEOMETRY) + maps MeetingParticipant
GoogleMeetMeetingRecorder.lastActiveSpeakerId : Int?               ← result keyed by participant ID
GoogleMeetMeetingRecorder.lastAxActiveSpeakerSet : Set<Int>        ← AX-derived speaker set (IDs, not class strings)
inferActiveSpeakerCallCount                                        ← called repeatedly (polled/observed)
"active speaker container" / "active speaker indicator"           ← it locates a container + indicator node
```
Read this as: Recall **derives a set of speaking participant IDs** (`lastAxActiveSpeakerSet`)
via a compiled `inferActiveSpeaker` routine, then **correlates it with the video-tile
rectangles** (`syncClientFramesAndActiveSpeaker` over `MixedVideoRect`) — i.e. **geometry is
in the loop**, and the output is an **ID**, not a class match.

### 1.2 What it is NOT [verified — absence]
- **No hardcoded obfuscated classes** — `grep` for our 8 classes across exe+libbot+ui_recorder = **0**.
- **No Meet remote rules** — the only remote ruleset (`recallai-desktop-sdk-scraping.s3…/manifest.json`)
  is keyed by **Zoom client versions** (`5.16.x … 6.5.9.61929`) and drives `ZoomScraperScripts.scrapeJS`. Meet isn't in it.
- **No Meet `scrapeJS`** — JS-over-AX scraping exists only for Zoom.

### 1.3 The AX attributes it reads per node (`libui_recorder`) [verified]
`AXRole, AXSubrole, AXTitle, AXDescription, AXValue,` **`AXDOMClassList, AXDOMIdentifier,
AXWindowNumber, AXFrame, AXPosition, AXSize, AXChildren, AXDocument`**.
→ It *can* see the class list (`AXDOMClassList`) **and** geometry (`AXFrame/Position/Size`) +
subtree (`AXChildren`). It chose to key on **geometry + structure + an ID set**, not the class string.

### 1.4 Event model + fusion [verified]
- **Event-driven:** `AXObserver` + `kAXTitleChangedNotification` (not brute-force polling).
- **Audio fusion:** `AxVad`, `voice_activity_detector`, `webrtc-vad`, `AudioLevelMessage{rms}`,
  `DSDK_VAD_IMPROVEMENT`, `exclude_null_active_speaker`.
- **Modes:** `ActiveSpeakerDetectionMode`, `ToggleManualActiveSpeakerDetection`,
  `SetActiveSpeakerDetectionMode` — an auto/manual switch over the fusion.

### 1.5 Honest boundary [inferred]
The **exact inputs** to `inferActiveSpeaker` (geometry-only? geometry + a non-class indicator
child? geometry + VAD weighting?) are **compiled and not string-inspectable**. What's certain:
(a) it does **not** depend on the obfuscated class name, and (b) geometry (`MixedVideoRect`) and
audio VAD are part of the decision, output as a participant **ID set**.

---

## 2. What our app does today [verified — source]

- `Sources/SpeakerCore/MeetSpeakerRules.swift` — `builtin.speakingClasses = ["kssMZb",…7]`,
  `meetTileIsSpeaking(classTokens:)` = "any of these classes present ⇒ speaking".
- `Sources/MeetSpeakerDetector/Engine/AccessibilityScanner.swift`
  - `meetSpeakingNames(in:)` — collect `AXStaticText` names → climb to tile via `meetTileAncestor`
    (already **geometry-based**: `AXFrame` area 8k–1.8M, aspect ≤ 4) → read `axClassList(tile)` →
    `meetTileIsSpeaking`.
  - We **already read `AXFrame` and `AXDOMClassList`** — the primitives for the durable approach exist.
- `platformExposesSpeakerNames(.meet) == true` (we closed the earlier gap).
- `Sources/MeetProbe/*` — the per-tile structural probe used to discover the classes (ground-truthed).

**The single dependency to remove:** `meetTileIsSpeaking` keys *only* on the obfuscated class set.
That string rotates ~6 weeks (and is layout-dependent, and the remote-spotlight case is unverified).

---

## 3. Target architecture — three signals, fused (build upon Recall)

Mirror Recall: **derive a per-participant "speaking" decision from durable signals, with the class
demoted to a remote-config fallback.** None of these alone is sufficient across all Meet layouts —
the point is the *fusion* degrades gracefully.

| Signal | What it gives | Durable? | Best for |
|---|---|---|---|
| **A. Audio VAD** (on captured system audio) | *someone* is speaking + precise on/off timing | ✅ rotation-proof, view-independent | gating; "Someone" floor; timing |
| **B. Tile geometry** (`AXFrame/Position/Size`, DOM order) | *which* tile is promoted/enlarged/spotlighted | ✅ in speaker/spotlight view | attribution when layout reacts |
| **C. Per-tile structure** (`AXChildren` shape: a speaking-indicator child node) | *which* tile gained an indicator subtree | ⚠️ needs MeetProbe verification | gallery view, class-independent |
| **D. CSS class** (`AXDOMClassList` vs `MeetSpeakerRules`) | *which* tile is speaking (today's signal) | ❌ rotates ~6 wks | gallery view fallback **only**, remote-config'd |

**Fusion rule (per scan/observer tick):**
1. **VAD** decides *if* anyone is speaking. If silent → no speaker. (Kills false positives from a stale class.)
2. If speaking, attribute to a tile using the **highest-confidence available** of B → C → D:
   - speaker/spotlight view → **geometry** (largest/most-recently-promoted tile).
   - gallery view → **indicator-child (C)** if verified, else **class (D)**.
3. If no tile attributable but VAD says speech → emit **`"Someone"`** (named-floor, like Recall's `exclude_null_active_speaker` handling).
4. Map tile → name via the existing `AXStaticText` roster; key the timeline on a **stable per-tile ID** (DOM order + name), not the class.

This is exactly Recall's shape: VAD + geometry + AX → a participant **ID** set, class-independent at the core.

---

## 4. Migration plan (phased, each shippable)

**Phase 0 — instrument (done / `MeetProbe`).** Keep `MeetProbe` as the ground-truth harness; add a
per-tile feature dump (frame, order, class set, child-role signature, mic node) sampled on a scripted
call. This is how you verify B/C and re-derive D when it rotates.

**Phase 1 — Audio VAD backbone. ✅ (soft peak-gate done; Silero/WebRTC = R1)** Run a VAD (Silero/WebRTC) on the system audio you already capture
(`SystemAudioMeter`). Produce `speechActive: Bool` + on/off timestamps. Gate all attribution on it.
*Immediately* removes false speakers and gives a rotation-proof "Someone" floor. **No class needed for this.**

**Phase 2 — Geometry attribution. ✅** From the per-tile model, detect the **promoted/spotlit tile**
(largest `AXFrame` area, or the tile whose area grew across ticks, or moved to spotlight position).
Attribute the VAD speech to that tile. Covers speaker/spotlight view with **zero class dependency**.

**Phase 3 — Demote the class to remote-config fallback. ✅ (local override + telemetry; URL fetch later)** Keep `MeetSpeakerRules` but:
- only consult it in **gallery view** when geometry can't decide;
- load it from **remote config** (it's already `Codable` with a `version` field — fetch URL, ETag-cache,
  fall back to `builtin`);
- add **telemetry**: count `VAD speech AND a tile is attributable by geometry/child BUT class-set matched 0`
  → that's your "Meet rotated the class" signal → refresh remote config / alert. No app release.

**Phase 4 — Per-tile indicator-child (C) to cut the last class dependency. ⏳ (deferred — verify live first)** Use MeetProbe to test
whether the speaking tile gains a **non-class** child node (an indicator/equalizer element) detectable via
`AXChildren` role-shape. If yes → use it for gallery-view attribution and the class becomes pure backup.

**Phase 5 — `AXObserver` + event-drive. ⏳ (deferred)** Replace the polling `walk()` with `AXObserver` notifications
(Recall uses `kAXTitleChangedNotification`) on the Meet web area; lower CPU, precise transitions.

> Realistic end-state: **VAD + geometry handle speaker-view and the "is anyone talking" question with no
> class at all; gallery-view multi-party attribution still needs a per-tile signal (indicator-child or
> class), but the class is now remote-config'd + telemetered, so a rotation is a config push, not a release.**
> Recall hit the same wall — that's why its remote ruleset exists (for Zoom) and its Meet path leans on
> geometry + VAD.

---

## 5. Concrete shapes (Swift sketch)

```swift
struct MeetTile {                       // built from AXChildren of the Meet AXWebArea
    let name: String?                   // AXStaticText descendant, cleanParticipantName
    let frame: CGRect                   // AXFrame  (geometry — durable)
    let orderIndex: Int                 // DOM order among tiles (stable-ish per layout)
    let classTokens: Set<String>        // AXDOMClassList (fallback signal only)
    let childRoleSig: String            // hash of child roles/subroles (indicator-child probe)
    let micMuted: Bool?                 // per-tile mic aria (narrow candidates; mute ≠ speaking)
}

enum SpeakingSignal { case geometry, indicatorChild, cssClass, none }

func activeSpeaker(tiles: [MeetTile], prev: [MeetTile], vadSpeechActive: Bool,
                   rules: MeetSpeakerRules) -> (name: String?, via: SpeakingSignal) {
    guard vadSpeechActive else { return (nil, .none) }              // 1) VAD gate
    if let t = promotedTile(tiles, prev) { return (t.name, .geometry) }      // 2) speaker view
    if let t = tiles.first(where: { gainedIndicatorChild($0, prev) }) {       // 3) gallery, class-free
        return (t.name, .indicatorChild)
    }
    if let t = tiles.first(where: { meetTileIsSpeaking(classTokens: $0.classTokens, rules: rules) }) {
        return (t.name, .cssClass)                                  // 4) class fallback (remote-config)
    }
    return ("Someone", .none)                                       // 5) VAD floor
}
```
`promotedTile` = the tile whose `frame.area` is largest *or* grew most vs `prev`; `gainedIndicatorChild`
= `childRoleSig` changed in the way MeetProbe verified corresponds to speaking. Emit telemetry whenever the
chosen `via` is `.cssClass` (you're on the brittle path) or `.none` while VAD is active (attribution gap).

---

## 6. Verification / re-derivation

```bash
# --- Recall: prove NO Meet class, geometry+VAD inference instead ---
SDK=/Users/bibekthapa/projects/work/recall-demos/dsdk-tutorial/node_modules/@recallai/desktop-sdk
for c in kssMZb eT1oJ hk9qKe nn1vQb s4hFTd tWDL4c yHy1rc FTMc0c; do        # expect 0 each
  echo "$c $(strings -a "$SDK"/desktop_sdk_macos_exe "$SDK"/Frameworks/*.dylib | grep -c "$c")"; done
nm "$SDK/desktop_sdk_macos_exe" | swift demangle | grep -iE 'GoogleMeet.*(inferActiveSpeaker|syncClientFramesAndActiveSpeaker|lastAxActiveSpeakerSet)'
curl -s https://recallai-desktop-sdk-scraping.s3.us-east-1.amazonaws.com/manifest.json | head   # Zoom versions → Zoom-only

# --- our app: the dependency to remove + the primitives we already have ---
cd /Users/bibekthapa/projects/work/demo-app
sed -n '42,52p' Sources/SpeakerCore/MeetSpeakerRules.swift                 # the hardcoded class union
sed -n '222,300p' Sources/MeetSpeakerDetector/Engine/AccessibilityScanner.swift  # axClassList + axFrame + meetTileAncestor
swift run MeetProbe 45 250                                                  # ground-truth per-tile watch
```

## 7. Provenance
- **[verified]**: §1.1–1.4, §2 — read from the unstripped binary / our source on 2026-06-21.
- **[inferred]**: §1.5 — the exact `inferActiveSpeaker` inputs are compiled. The *certain* facts are the
  absence of class dependence and the presence of geometry (`MixedVideoRect`) + VAD in the path.
- Re-run §6 before trusting any specific claim — binaries and Meet's DOM rotate.
- Companion: `recall-and-demo-extraction.md` (full SDK extraction surface + Zoom-native recording).
