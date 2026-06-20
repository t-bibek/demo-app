# How we detect "who is speaking, when" in Google Meet (macOS, AX-only)

**Status:** working & verified — 2026-06-20. Meet now logs the active speaker **by
name** (previously it could only log `Someone`). This doc explains the mechanism,
how we proved it, how it's wired into the app, and how to maintain it when Google
changes Meet (the signal rotates ~6 weeks).

> Companion docs: [recall-and-demo-extraction.md](recall-and-demo-extraction.md)
> (Recall SDK comparison + the §4 experiment that kicked this off) and
> [README.md](../README.md) (the app itself).

---

## 0. TL;DR

- Google Meet does **not** expose a clean "active speaker" attribute (no AX role /
  state / aria-live). The speaking ring is CSS-only. The Windows original read it
  from the page DOM; we can't do that natively.
- **But** Chrome surfaces each web element's **CSS class list** through a
  non-standard AX attribute, **`AXDOMClassList`**. Meet adds a class to the
  **speaking participant's tile**. So we read the *class*, not a label.
- The signal is **per-tile and layout-dependent** — different class depending on
  whether the tile is a thumbnail vs the spotlight, and self vs remote. We match a
  **union** of verified classes (ANY present ⇒ speaking).
- We verified it against **ground truth** (narrated turns), **cross-tile**
  (self + remote), and **disambiguated it from mute** (a muted+silent participant
  is correctly *not* logged).
- "**When**" comes from polling those tiles ~2×/sec and aggregating into sessions
  (`SessionTracker`): each speaker turn gets a start time + duration.

---

## 1. The problem

`platformExposesSpeakerNames(.meet)` used to be `false`: Meet's per-tile speaking
indicator is a visual CSS animation with **no** accessible role/state/aria-live, so
our text-based `isSpeakingMarker` (which works for Zoom — it writes
`"…, active speaker"` into an `AXDescription`) found nothing. Meet remote speech
fell back to the anonymous `"Someone"`.

The open question (see [recall-and-demo-extraction.md §4](recall-and-demo-extraction.md)):
*does Meet expose a **structural** active-speaker signal in AX that a per-tile diff
can detect?* Prior tests used a flat, whole-tree token set that is structurally
blind to per-tile changes, so the question was genuinely unresolved.

---

## 2. Method: measure per-tile, don't guess

We built a dedicated probe instead of guessing: [Sources/MeetProbe](../Sources/MeetProbe)
(`swift run MeetProbe`). It:

1. Finds the Meet `AXWebArea` (Chrome exposes `AXURL` as an **NSURL**, not a
   String — an early bug; we match `meet.google.com` from the URL or a text
   fallback).
2. Locates each **participant tile** by anchoring on the name `AXStaticText` and
   climbing to a tile-sized ancestor (geometry-bounded).
3. Per tile, samples ~4×/sec: geometry (`AXFrame`), DOM order, the tile's
   **`AXDOMClassList`** tokens (subtree union + name-pill subset), focus/selected,
   and a heuristic mic state.
4. At the end, auto-reports each tile's **intermittent** (toggling) tokens with
   their **on-windows**, after stripping hover/control chrome — so a narrated run
   is directly readable.

Supporting tool: [Sources/AXDump](../Sources/AXDump) (`swift run AXDump meet --attrs`)
dumps every AX attribute per node, which is how we discovered `AXDOMClassList` is
even available on Meet's web nodes.

Key reframe that unblocked everything: the live detector's `walk()` flattens the
tree into deduped name lists, discarding per-tile identity/geometry/class — so it
**cannot measure** for a structural signal even if one exists. The probe keeps a
**per-tile model**, which is the whole point.

---

## 3. What we found

Chrome exposes Meet's obfuscated CSS classes per node via `AXDOMClassList`
(e.g. `VYBDae-Bz112c-RLmnJb`, `OFfHfd`, `kssMZb`, …). Meet toggles specific classes
on the **speaking** tile. The classes are **layout-dependent**:

| Situation | Class that appears on the speaking tile |
|---|---|
| Active speaker on a **thumbnail-strip** tile (self or remote) | **`kssMZb`** |
| **Your own** tile while you speak (incl. as the **spotlight**) | cluster `eT1oJ, hk9qKe, nn1vQb, s4hFTd, tWDL4c, yHy1rc` |
| Silent / idle tile | `FTMc0c` (complement) |
| Remote participant as the **spotlight** tile | ⚠️ not yet observed (likely another class) |

So no single token generalizes. We match a **union** (ANY present ⇒ speaking).

Noise we learned to strip:
- **Hover/control chrome** (`VYBDae-Bz112c-*`, `LgbsSe`, `MSqqjf`, …) appears when
  the cursor is over a tile — *keep the mouse parked* during measurement.
- **Join/leave toasts** ("Wedding Thapas joined") and **control labels**
  ("Share screen", "Present now") leak in as fake tiles — filtered by name.

---

## 4. How we verified it (this is the important part)

Detection claims are only trustworthy against **ground truth**. We ran narrated
captures and matched the class on-windows to who actually spoke.

**Run A — self speaking, ground truth "Bibek spoke 0–35s":**
| token on `Bibek Thapa` | ON during 0–35s | ON during 35–45s |
|---|---|---|
| cluster `eT1oJ…` | 112 samples | 8 |
| `kssMZb` | 101 | 7 |
| `FTMc0c` (complement) | mostly off | on |
→ speaking classes ON ≈ 7–37s ≈ the spoken window (≈2s hangover). ✅

**Run B — remote speaking, ground truth "Wedding spoke 5–25s, Bibek silent":**
- `Wedding Thapas`: `kssMZb` ON **8–30** ✅ ; `FTMc0c` ON 0–5 (before talking).
- `Bibek Thapa`: never `kssMZb`; `FTMc0c` ON the whole time ✅ (silent).
→ proves the signal marks **whoever is talking**, self *or* remote, and is absent
on the silent participant. (Run B is also why we learned the `eT1oJ…` cluster is
self-only and `kssMZb` is the cross-tile one.)

**Run C — mute disambiguation, 4 phases (mouse parked):**
| A: unmuted+silent | B: unmuted+**talk** | C: **muted** | D: unmuted+silent |
|---|---|---|---|
| off | **ON 12–20** | off | off |
→ speaking class fires **only** on unmuted+talking — **not** on unmuted-silent and
**not** on muted. So it's *actual speech*, not mic state. ✅

**Run D — self as the large spotlight tile:** `kssMZb` did **not** fire, but the
`eT1oJ…` cluster did (9.8–14) — which is how we learned the signal is
layout-dependent and switched to the **union** rule.

---

## 5. The final rule

[Sources/SpeakerCore/MeetSpeakerRules.swift](../Sources/SpeakerCore/MeetSpeakerRules.swift)
— a **config object** (these obfuscated names rotate, so treat it as remote
config, never permanent):

```swift
MeetSpeakerRules.builtin = MeetSpeakerRules(
    speakingClasses: ["kssMZb", "eT1oJ", "hk9qKe", "nn1vQb", "s4hFTd", "tWDL4c", "yHy1rc"],
    silentClasses:   ["FTMc0c"],
    version: "2026-06-20")

// ANY speakingClass present in the tile's AXDOMClassList ⇒ that tile is speaking.
meetTileIsSpeaking(classTokens:) -> Bool
```

Unit-tested in [SpeakerCoreSelfTest](../Sources/SpeakerCoreSelfTest/main.swift)
(`swift run SpeakerCoreSelfTest`): thumbnail speaker, self-spotlight cluster,
silent state, control-label rejection, custom-ruleset.

---

## 6. How it's wired into the app

Detecting **who** (per poll):
- [PlatformDetection.swift](../Sources/SpeakerCore/PlatformDetection.swift):
  `platformExposesSpeakerNames(.meet) → true` (engine now trusts names; no
  `Someone` fallback when the tree is readable).
- [AccessibilityScanner.swift](../Sources/MeetSpeakerDetector/Engine/AccessibilityScanner.swift):
  for a Meet window, `meetSpeakingNames(in:)` runs a **per-tile pass** — find name
  nodes → `meetTileAncestor` (climb to a tile-sized box) → `tileClassTokens`
  (subtree `AXDOMClassList` union) → `meetTileIsSpeaking`. Returns the names whose
  tile is speaking. (New AX helpers: `axClassList`, `axFrame`, `axParent`.)
- [NameParsing.swift](../Sources/SpeakerCore/NameParsing.swift): `cleanParticipantName` /
  `isLikelyPersonName` reject meeting codes, clock, join/leave toasts, and control
  labels (`Share screen`, `Present now`, …) so they can't become fake tiles.

Detecting **when** (across polls):
- [DetectionEngine.swift](../Sources/MeetSpeakerDetector/Engine/DetectionEngine.swift)
  polls every **500 ms**, feeds each speaking name into
  [SessionTracker](../Sources/SpeakerCore/SessionTracker.swift) as a pulse.
- `SessionTracker` aggregates pulses into **sessions** (start time + duration),
  with an 800–2000 ms hangover so brief indicator flicker doesn't split one turn.
  This is the **speaker timeline**: `speech_on` (first pulse) → ticks →
  `speech_off` (after silence) — emitted to the UI and the NDJSON session log.
- On name-capable platforms we **don't** also log `You` from the mic, because your
  own tile is already named via the speaking class (avoids double-logging).

So "who is speaking when" = per-tile class read (who) × 2 Hz poll + session
aggregation (when).

---

## 7. Caveats & maintenance

- **Class names rotate (~6 weeks).** When detection degrades, re-derive (§8) and
  update `MeetSpeakerRules`. This is the same maintenance cost Recall absorbs via
  its S3-hosted scraping rules.
- **Foreground tab only.** Chromium freezes/drops the AX tree of **background
  tabs** — the Meet tab must be the active Chrome tab.
- **Remote-spotlight unverified.** A remote participant shown as the large
  spotlight tile may use a different class; if one shows `·` while clearly talking,
  capture it and add its class to the rule.
- **Mic mute is not in AX.** Meet doesn't expose per-participant mute as readable
  text/class, so the probe's `mic=` column is unreliable. We don't need it — the
  speaking classes only fire on actual (unmuted) speech.
- **Timing granularity = the 500 ms poll** (+ hangover). For frame-accurate
  `speech_on/off` and a fallback when AX is unreadable, see Phase 5 below.

---

## 8. Re-derivation playbook (when Meet changes)

```bash
# 1) Narrated capture (gallery view, 2-3 cameras on, MOUSE PARKED):
#    talk in known windows, e.g. you 0-10s, other 10-20s, silent 20-30s.
swift run MeetProbe 40 250 | tee log.md

# 2) Read SESSION ANALYSIS: the CANDIDATE token whose on-windows match who you
#    narrated is the new speaking class. Cross-check self vs remote, and a
#    mute phase, exactly like §4.

# 3) Raw inspection if needed:
swift run AXDump meet --attrs            # every attr per node (find AXDOMClassList)

# 4) Update Sources/SpeakerCore/MeetSpeakerRules.swift speakingClasses + version,
#    then: swift run SpeakerCoreSelfTest  (keep the unit tests green)
```

---

## 9. Per-platform status

| Platform | Active-speaker source | Status |
|---|---|---|
| **Zoom (web)** | `"…, active speaker"` in `AXDescription` (`isSpeakingMarker`) | working (labeled read) |
| **Google Meet** | per-tile `AXDOMClassList` class (`MeetSpeakerRules`, this doc) | working (verified), layout-dependent, rotates |
| **Microsoft Teams** | none verified | audio-only `Someone` (candidate for Phase 5) |

---

## 10. Next: Phase 5 — audio-VAD spine (not yet built)

AX gives **who**; audio gives precise **when** and a fallback when AX is
unreadable (background tab, remote-spotlight, Teams). Run VAD on the captured
system audio for exact `speech_on/off` boundaries and fuse with the AX
active-speaker name — the same two-signal fusion Recall ships. This makes the
timeline robust regardless of Meet's layout quirks.
