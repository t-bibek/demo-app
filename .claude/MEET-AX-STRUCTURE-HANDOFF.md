# Google Meet — macOS Accessibility (AX) structure handoff

Everything learned about reading Google Meet from the **macOS Accessibility tree** (for a
native speaker/participant detector). Written to be fed to another agent cold. Verified
live 2026-07-03 (Chrome 149) with a fake-audio rig + `AXSnapshot` + the running
`MeetSpeakerDetector` app.

---

## 0. TL;DR
- **Two surfaces:** the **DOM** (content-script/CDP/webview) and the **AX tree** (what a native
  macOS app reads). They expose *different* things. Don't assume DOM findings hold in AX.
- **Who is speaking (AX):** `kssMZb` active-speaker ring (3+ people) + tile **geometry** do the real
  work live. The **equalizer level-class** speaking signal *exists* in AX but a live polling detector
  doesn't reliably read it yet (see §6, the #1 open problem).
- **Who is in the call (AX):** **roster rows** (People panel) + **video-tile captions**, gated by a
  **structural allowlist** (§4) — never a CSS class, never a hardcoded pixel size.
- **Host ≠ Guest:** per-tile name-bearing controls are **host-only + panel-open-only**. The detector
  runs on whoever's machine, so participant extraction must use viewer-independent signals (§3).
- **Capture is fragile:** the full AX tree + live speaking state only materialize when the Chrome
  window is **genuinely frontmost** via `NSRunningApplication.activate` — AX flags alone aren't enough (§5).

---

## 1. AX signal inventory (Meet)

**IN the AX tree:**
| Signal | Where | Notes |
|---|---|---|
| `kssMZb` active-speaker ring | `AXDOMClassList` on the active tile's ancestor | **3+ people only** (absent in 2-person); sticky-last-active → VAD-gate it |
| Equalizer level classes | `AXDOMClassList` on a `DYfzY`/`IisKdb` node | `gjg47c`(silent) ↔ `HX2H7`/`Oaajhc`/`wEsLMd`/`OgVli`(speaking). Real but hard to read live — §6 |
| Participant **names** | tile `AXStaticText.AXValue`; roster row `AXDescription` | the durable, viewer-independent name source |
| Roster container | `AXList` / `AXSubrole=AXContentList` / `AXDescription="Participants"` | present only when the People panel is open; **0 `AXList` when closed** = clean signal |
| Per-tile/row controls | `AXPopUpButton`/`AXButton` `AXDescription` | `"More options for <Name>"`, `"Pin <Name> to your main screen"`, `"Mute <Name>'s microphone"` — **HOST-ONLY + panel-open-only** |
| Mute state | roster mic `AXButton.AXDescription` | host: `"Mute <Name>'s microphone"` / muted `"You can't unmute someone else"`; guest: disabled `"You can't remotely mute <Name>'s microphone"` |
| Self markers | roster row | `AXStaticText "(You)"` + `"Meeting host"` (build-dependent — `(You)` is sometimes absent) |
| Tile geometry | `AXFrame` | **relative only** — varies with zoom/window/layout/count; never hardcode pixels |
| Presentation state | aria-live / `"You are presenting"` / an `AXPopUpButton` | cleaner than text-scanning |

**NOT in the AX tree:**
- `data-participant-id`, `data-ssrc`, `data-audio-level` (all `data-*` attrs are stripped from AX).
- The equalizer's animating bar sub-structure (pruned; only the class token on the node flips).
- `AXFocused` is **not** a speaker signal — 64/70 `AXFocused=true` nodes are the page root / buttons /
  popups; only 6/70 are tiles and they don't correlate with speech. Treat it as keyboard/window focus.

---

## 2. Concrete AX evidence (exact roles/strings another agent will grep for)
- **Roster (panel open):** `AXList` · `AXSubrole=AXContentList` · `AXRoleDescription="content list"` ·
  `AXDescription="Participants"`. Direct children = rows: `AXGroup` whose `AXDescription` **is** the
  participant name (e.g. `"Bibek Thapa"`), containing a mic `AXButton` and a `"More actions"` `AXPopUpButton`.
- **Tile (any layout):** a tile-sized `AXGroup` under `AXGroup[AXSubrole=AXLandmarkMain]`. Name =
  `AXStaticText.AXValue` in a ~36px **bottom strip**; a **~24×24 corner node** = the persistent mic/
  audio indicator (becomes the equalizer when speaking).
- **Equalizer `AXDOMClassList` per state (live-proven, host page):**
  - SILENCE `["DYfzY","cYKTje","gjg47c"]`
  - GUEST speaking `["DYfzY","cYKTje","Oaajhc","sxlEM"]`
  - HOST speaking `["IisKdb","GF8M7d","HX2H7","KUNJSe","x9nQ6","VeFZv"]`
  - OVERLAP → both nodes carry `"wEsLMd"`
- **kssMZb** rides on the promoted/active tile's ancestor, e.g. `.dkjMxf.i8wGAe.kssMZb.WX1kx.MVbbRb.tSl2vc`.
- Durable-vs-volatile: **stable** = `jsname="QgSmzd"`, base `IisKdb`, silence `gjg47c`, `kssMZb`; the
  **level tokens rotate** (they're a loudness ladder, not a speaking class) → anchor on absence-of-`gjg47c`,
  never a specific level token.

---

## 3. Host vs Guest (critical — the detector runs on either)
Verified with each Chrome pid **individually activated** to a full tree:
| Anchor | Host | Guest |
|---|---|---|
| `More options for <Name>` | present (panel open) | **absent** — overflow is a nameless `"More actions"` |
| `Pin <Name>` | present | **absent** |
| `Mute <Name>'s microphone` | present (host privilege) | **absent** — disabled `"You can't remotely mute <Name>'s microphone"` |
| Roster (`AXContentList "Participants"`) | present | **present** ✅ |
| Tile caption `AXStaticText` | present | **present** ✅ |

**Rule:** never anchor participant identity on the per-tile control labels — they're host-only. Use the
**roster + tile captions + mic-indicator** (viewer-independent). The guest's disabled mute label
(`"You can't remotely mute <Name>'s microphone"`) is a fallback name source if ever needed.

---

## 4. Participant extraction — the structural allowlist (implemented)
Goal: kill false positives (`"More actions"`, `"Camera is off"`, `"Adjust view"`, layout-menu labels,
chrome) **without** a hardcoded class or pixel size, and without missing real people.

A caption name is accepted as a participant only if **corroborated** (union of allowlist patterns):
- **P1 roster:** the name is in the `AXContentList "Participants"` list (viewer-independent, panel-open).
- **P2 tile evidence:** its tile subtree contains a per-tile **mic/audio indicator** (an equalizer-anchor
  node `{DYfzY,IisKdb,QgSmzd}`) **or** a **name-embedding control** (`meetParticipantNameFromControl` fires).
- **Graceful fallback:** if *no* structural signal exists anywhere (empty roster + no tile evidence —
  e.g. a partial/pruned tree), accept the legacy way so we never regress to **zero** participants.

Chrome has none of these → rejected structurally. Blocklist (`NameParsing.swift`) is now belt-and-suspenders.

**Live-QA result (11/11 layout×size cells):** exactly `{Bibek, Alpha, Bravo}` in Auto/Tiled/Spotlight/
Sidebar/Pinned × default/small/maximized/zoom — zero misses, zero steady-state false positives, list
stable across size+zoom (geometry not leaking).

**Known edge (open):** during a *simultaneous* layout-panel-open + window reflow, the graceful fallback
can transiently admit the "Adjust view" menu labels (`Auto`/`Tiled`/`Sidebar`/…). Cosmetic (join+leave,
no persistence). Interim: exact-match blocklist for that bounded set. **Durable fix = fallback
hysteresis** (hold each name's last-known evidence across a few ticks so a momentary reflow can't
trigger admit-all).

---

## 5. Capture requirements (why so many prior captures were wrong)
1. **Full tree:** set `AXManualAccessibility` + `AXEnhancedUserInterface` on the Chrome **pid** (app AX element).
2. **Genuinely frontmost:** `NSRunningApplication(processIdentifier: pid).activate()`.
   `System Events … set frontmost` / `AXRaise` **do NOT stick** for a background same-bundle Chrome
   (snaps back to the user's personal Chrome; `AXSnapshot` then prints "No meeting tab found").
3. **Capture *while speaking*:** the level class is transient per audio burst — gate on the DOM equalizer
   animating (or drive known speech) at capture time.
4. **Tree size sanity:** a partial/background 2-person tree is ~146–252 nodes (this is the *natural full
   size* of a small call, not a truncation — but deep widgets only appear frontmost + speaking). A
   GitHub/code-viewer page in another Chrome window is ~148k nodes and will pollute raw text greps with
   the repo's own source strings — **always parse structured `AXDOMClassList`, never raw text**, and
   filter to `meet.google.com` captures.

---

## 6. Open problems / next work (ranked)
1. **Equalizer live-read (the big one).** The level-class signal is *real in AX* (§2) but the shipped
   detector's `.equalizer` path fired **0×** live. Two diagnosed causes: (a) STRUCTURAL — the host's own
   `IisKdb` meter is **not nested under an `.oZRSLe` tile** (it hangs under `jb1oQc/VeFZv…cxdMu/KV1GEc`),
   so a per-tile descendant walk misses it; a working read must scan the **whole tree** for equalizer
   nodes and attribute by **geometry** to the nearest tile (like the DOM detector's `tileOf`). (b) TIMING —
   `AXSnapshot` proved it by activate→settle→dump as separate steps; a detector that activates + reads in
   the **same 500ms tick** reads the pre-materialization tree. Fix = whole-tree scan + geometry attribution
   + an activate→settle→read (not same-tick).
2. **`forceActivateForCapture` is a UX blocker.** It pins Chrome frontmost every 500ms tick (thrashes
   windows; user can't keep another app focused) and **cannot** detect a lone *minimized* Meet window.
   Needs a non-intrusive materialization strategy before ship.
3. **Fallback hysteresis** (§4) to retire the transient panel-label blocklist.
4. **"Someone" in 2-person gallery / non-frontmost windows** is unavoidable until #1 lands (kssMZb is
   3+-only; geometry only names a *dominant* tile; `someoneGrace` only debounces the onset lag).

---

## 7. What's implemented (as of commits on branch `meet-structural-speaker-detection`)
- **`.equalizer` prototype signal** (leads the resolver) + `meetNodeIsSpeakingEqualizer` — *works in unit
  tests, unproven live* (see #1).
- **`meetParticipantNameFromControl`** — class-free/geometry-free name extractor from control `AXDescription`.
- **Structural participant allowlist** (`meetTileHasParticipantEvidence` + roster + graceful fallback).
- **`someoneGrace` (750ms)** debounce on the Someone floor — *live-validated: 0 Someone across 60 speech_on*.
- **`forceActivateForCapture`** (NSRunningApplication.activate) — needed for capture, but UX-blocking (#2).
- Config (remote-config overridable): `equalizerAnchorClasses`, `equalizerSilenceClass`,
  `participantControlPrefixes`, `rosterContainerDescription`.
- Chrome-leak blocklist guards (interim).

## 8. Code map
| Concern | File |
|---|---|
| Fused speaker resolver (VAD→equalizer→kssMZb→AXFocused→geometry→Someone) | `macos/Sources/SpeakerCore/MeetActiveSpeaker.swift` |
| Rules + config + pure extractors (`meetNodeIsSpeakingEqualizer`, `meetParticipantNameFromControl`) | `macos/Sources/SpeakerCore/MeetSpeakerRules.swift` |
| Name parsing + chrome blocklist | `macos/Sources/SpeakerCore/NameParsing.swift` |
| AX reads: tiles, roster (`meetPanelRoster`), evidence gate, equalizer walk, `forceActivateForCapture` | `macos/Sources/MeetSpeakerDetector/Engine/AccessibilityScanner.swift` |
| Engine: per-tick resolution, `someoneGrace`, Someone emission, speech events | `macos/Sources/MeetSpeakerDetector/Engine/DetectionEngine.swift` |
| Dependency-free self-tests (`swift run SpeakerCoreSelfTest` from `macos/`) | `macos/Sources/SpeakerCoreSelfTest/main.swift` |
| Autonomous QA (`qa/run_autonomous_qa.sh`; 23/23 + 34/34 + review gate) | `qa/` + `QA_AUTOMATION_FLOW.md` |
| DOM detector (the *other* surface — reference) | `research/meet-dom-detector/` |

## 9. Reproduce / capture
- **Rig (3 participants):** `cd research/meet-dom-detector/live && node roster-rig-3p.js`
  (host + Guest Alpha + Guest Bravo, distinct fake voices, ports 9224/9226/9227; reuses signed-in
  `.rig-profiles`/`.live-profile`, never wipes). Device-free single-guest: `node fake-audio-rig.js new "Guest"`.
- **Run the detector for logs:** `cd macos && MSD_AUTOSTART=1 swift run MeetSpeakerDetector` (auto-starts;
  prints `[event] {json}`; appends to `~/Library/Application Support/MeetSpeakerDetector/sessions.ndjson`).
- **AX dump (frontmost):** activate the pid via a compiled `NSRunningApplication.activate` helper, then
  `cd macos && swift run AXSnapshot chrome --url <meeting-code>`. Use the `.json` (has attribute VALUES);
  the `.txt` shows class lists only.
- **Dumps on disk:** `macos/ax-dumps/<timestamp>/chrome-meet-*.{json,txt}` (host=`-1`, guests=`-2/-3`);
  curated diff set: `ax-pattern-diff/`; fresh equalizer proof: session scratchpad `ax-capture-fresh/`.
- **Rig gotchas:** guests can't be muted by a guest; the "Adjust view" panel (⋮ More options) holds the
  layout radios (no separate "Change layout" dialog in Chrome 149); admit is two-step (toast then
  People-panel row); Chrome pins the mic device at admit.

## 10. Related persistent memory (this project)
`~/.claude/projects/-Users-bibekthapa-projects-work-demo-app/memory/`:
`meet-ax-speaker-signals-3person.md` (the corrected equalizer-in-AX finding + capture caveats),
`meet-dom-speaking-indicator.md` (the DOM surface), `speaker-detection-research-2026-07.md`.
