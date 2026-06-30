# AX Research

> Live AX findings while probing meeting apps. Started 2026-06-25.
> Tool: `swift run AXSnapshot <target>` (`Sources/AXSnapshot`) = what macOS AX exposes.

---

## Summary — what macOS AX exposes per platform

| Platform | Participant name | is-speaking | Mute / unmute |
|---|---|---|---|
| **Meet** (web) | ✅ | ✅ `kssMZb` class on tile (`AXDOMClassList`) | ✅ local · ⚠️ remote (needs panel) |
| **Zoom native** (`us.zoom.xos`) | ✅ | ✅ `", active speaker"` text on tile `AXDescription` | ✅ per-participant (tile + roster) |
| **Zoom web** (`app.zoom.us`) | ✅ | ❌ | ❌ (not on tiles) |
| **Teams native** (`com.microsoft.teams2`) | ✅ | ✅ per-tile speaking-class set in `AXDOMClassList` (anchor `vdi-frame-occlusion`; rotating hashes → remote-config) + VAD | ✅ local · ⚠️ remote (roster panel, absence-coded) |
| **Teams web** (`teams.microsoft.com`) | ✅ | ✅ same class set as native | ✅ local · ⚠️ remote (roster panel, absence-coded) |

✅ = readable from the macOS AX tree · ❌ = not in AX (DOM/visual only) · ⚠️ = conditional / unconfirmed.

**Names are always readable. Meet, Zoom-native, AND Teams (native + web) expose who-is-speaking directly in AX** — Meet and Teams via a **per-tile CSS class in `AXDOMClassList`** (Teams' classes are obfuscated, rotating Griffel hashes → remote-config; `vdi-frame-occlusion` is the durable anchor), Zoom-native via a `", active speaker"` text marker. Only Zoom-web needs audio VAD for the timeline. The **self/local user is always the mic**, never a tile — the speaking ring is drawn only on *remote* tiles. Per-platform detail below.

> **The AX speaker read is independent of mute count.** Meet/Zoom-native/Teams mark the active tile(s) regardless of how many are unmuted (verified: 3-unmuted Zoom-native; Teams handoff across speakers, camera on AND off). Teams' class is **per-tile** — each speaking tile lights independently → genuine *simultaneous* multi-speaker — whereas Meet/Zoom-native expose only the single *dominant* speaker. Only **Zoom-web** falls back to the mute-gate (names a speaker only when exactly one remote is unmuted; 2+ needs audio).

---

## Teams web — mute readable, AND is-speaking via a per-tile class (CORRECTED 2026-06-29)

Capture: Chrome tab on `teams.microsoft.com`, local "bibek thapa" + remotes. **Same handle as native** (confirmed live: `vdi-frame-occlusion`/`___1vvhwjq` light the speaking tile, camera on AND off).

**What Teams provides**

| Signal | In macOS AX? | How |
|---|---|---|
| Participant name | ✅ | `AXStaticText` / descriptor |
| Mute/unmute (remote) | ✅ | roster `AXDescription` — `, Muted` present/absent |
| Mute/unmute (local) | ✅ | own tile `AXDescription` carries `Unmuted`/`Muted` |
| **is-speaking** (remote) | ✅ | per-tile speaking-class set in `AXDOMClassList` (the `data-is-speaking` *attribute* stays DOM-only) |
| is-speaking (self) | ❌→mic | self-tile never rings (ring is for remote streams) → use mic + mute |

**Mute/unmute** rides on a named, accessible node (`"David Thapa (Guest), …"` / `"Mute mic"`), so it's in `AXDescription`.

**Why is-speaking IS readable (the correction).** The speaking ring is `<div data-tid="voice-level-stream-outline" data-is-speaking="true" class="… ___1vvhwjq vdi-frame-occlusion …">`. The `data-*` attrs never bridge to AX — **but the `class` on that same node does** (`class` → `AXDOMClassList`), and the ring carries a distinct set when active:

```
SPEAKING:  ___1vvhwjq  vdi-frame-occlusion  fn8mz29  f1ky4vpe  frwhdur  ftevtku  f1qyaz97  f14rmoke  fm03cl5  f3ve9t9
SILENT:    ___dv8x4j0  f1429bq1  f9pox2d
```

It toggles **per tile, following the speaker** — verified live on a 3-person handoff (the set moved speaker→speaker, cleared in silence), **camera on AND off**, never on the self-tile. `vdi-frame-occlusion` is the durable semantic anchor; the rest are rotating Griffel hashes → remote-config.

**Why earlier dumps said "not in AX" — false negative.** A static snapshot taken during *silence* shows only the non-speaking classes; the speaking variants are obfuscated hashes (keyword grep can't find them); and `AXObserve` saw nothing because Chromium toggles `AXDOMClassList` **without posting an AX notification**. Only a high-frequency **per-tile interval diff** (`swift run MeetProbe teams … oracle=…`) surfaces it.

**Consequence** — who-is-speaking IS in AX: read the speaking-class set per tile (anchor `vdi-frame-occlusion`, ≥K of the set, remote-config'd), fuse VAD for precise on/off. **Self → mic + mute** (the ring is for remote streams only). No extension needed.

---

## Teams native (`com.microsoft.teams2`) — same as web: is-speaking IS in AX (CORRECTED 2026-06-29)

Teams native is a Chromium webview, so it behaves exactly like Teams web — including the speaking-class signal (confirmed live on native: 3-person handoff, camera on/off, multi-speaker).

| Signal | In macOS AX? | How |
|---|---|---|
| Participant name | ✅ | tile / roster `AXDescription` |
| Camera on/off | ✅ | `", video is on"` in the description |
| Mute/unmute (local) | ✅ | own tile desc + mic button (`Unmute mic` / `Mute mic`) |
| Mute/unmute (remote) | ✅ | roster desc — `, Muted` present/absent |
| **is-speaking** (remote) | ✅ | per-tile speaking-class set in `AXDOMClassList` (same handle as web) |
| is-speaking (self) | ❌→mic | self-tile never rings → mic + mute |

```
description="Myself video, Bibek Thapa, Muted, Has context menu"        # local, MUTED
description="bidheyak (Guest), video is on, Context menu is available"  # remote, unmuted (no "Muted"), cam on
description="David Thapa (Guest), Context menu is available"            # remote, unmuted
description="Unmute mic"                                                # mic button ⇒ you're muted
```

**Why is-speaking IS readable** — same as Teams web: the `data-is-speaking` attr stays DOM-only, but the **speaking-ring class set** (`vdi-frame-occlusion`/`___1vvhwjq`/…) on that node IS in `AXDOMClassList` and toggles per tile with the speaker. Detection rule: a tile is speaking iff `AXDOMClassList` contains `vdi-frame-occlusion` (anchor) or ≥4 of the set. Verified live on native — handoff across speakers, camera on/off, multi-speaker, never on self.

> **The earlier "SETTLED — not in AX" verdict was a FALSE NEGATIVE** (the static `AXSnapshot` + `AXObserve` runs). Three reasons it missed: the snapshot was captured during *silence* (only non-speaking classes present); the speaking variants are obfuscated hashes (grep-proof); and Chromium toggles `AXDOMClassList` with **no AX notification**, so the event observer was blind. The per-tile interval diff (`MeetProbe`) is the method that found it. Lesson: an obfuscated, transient, migrating class needs a high-freq per-tile diff — not a snapshot, not a notification listener.

**Consequence** — Teams (native + web): who-is-speaking IS in AX (per-tile class set, remote-config'd anchor `vdi-frame-occlusion`) + VAD for timing; **self → mic + mute**. This corrects `speaker-detection-platform-summary.md` (which lists Teams active-speaker as audio-only) and the open question in `TeamsSpeakerRules.swift` (a camera-independent AX signal — now found). Recall's own `TeamsScraper` PIP scan is inert on its build → it uses VAD; we have a working class handle on this build.

---

## Meet web — both is-speaking AND local mic on/off are readable (2026-06-25)

Capture: `swift run AXSnapshot meet` (`chrome-meet.json/.txt`) + DevTools. Unlike Teams, Meet is the AX-friendly case.

**What Meet provides**

| Signal | In macOS AX? | How |
|---|---|---|
| Participant name | ✅ | tile caption / `aria-label="More options for <Name>"` |
| **is-speaking** (active speaker) | ✅ | class `kssMZb` on the tile → `AXDOMClassList` |
| **Local mic on/off** | ✅ | mic button `AXDescription` (`Turn on/off microphone`) |
| Local camera on/off | ✅ | button `AXDescription` (`Turn on/off camera`) |
| Participant id | ❌ | `data-participant-id` (`data-*`), DOM-only |
| Per-button `data-is-muted` | ❌ | `data-*`, DOM-only |
| Remote per-participant mute | ⚠️ TBD | needs the People panel open |

**Why is-speaking works (unlike Teams)** — Meet marks the speaking tile with a CSS **class** (`kssMZb`), and `class` → `AXDOMClassList` *is* bridged. Nesting:

```
main.axUSnc
  div.dkjMxf … kssMZb …                                  ← tile, kssMZb = active speaker   (AX ✅, 2 hits)
    div.oZRSLe data-participant-id="spaces/…/devices/70" ← who                              (AX ❌, data-*)
```

**Mic on/off through AX** — the control-bar mic button is a *named, accessible* button, so its label flips and rides into `AXDescription` (read the action to infer state):

```
description="Turn off microphone"   → mic is ON  (unmuted)    # chrome-meet.txt:225
description="Turn on microphone"    → mic is OFF (muted)
```

(Camera mirrors it: `Turn on/off camera`.) The DOM also carries `data-is-muted="true"` + a `mic_off` glyph on that button, but those are `data-*`/icon-text → **0 hits in AX**; we read the **description**, not the data attr. This is the **local** user only — remote per-participant mute needs the People panel open. (The per-tile audio-level indicator `IisKdb`/`HX2H7` is *not* in AX — 0 hits — so the reliable speaking signal is `kssMZb`, not that equalizer.)

**Consequence** — Meet exposes **who-is-speaking (`kssMZb`) AND local mic on/off** straight from macOS AX (fuse with VAD). Only the stable participant-id and remote-mute-while-panel-closed need DOM access. This is exactly why Meet is AX-trackable and Teams (which hides speaking behind `data-*`) is not.

---

## Zoom native (`us.zoom.xos`) — active speaker IS in AX (correction) (2026-06-25)

Earlier captures (1–2 participants, nobody designated speaker) showed no speaking marker → we wrongly concluded "Zoom native has none." A **3-participant capture with someone talking** (`ax-dumps/20260625-200432`) proves otherwise — Zoom appends **`, active speaker`** to the speaking tile's `AXTabGroup` description:

```
AXTabGroup description="David's Iphone, Computer audio unmuted, active speaker"   ◀ active speaker
AXTabGroup description="David Thapa, Computer audio unmuted"
AXTabGroup description="bidheyak, Computer audio unmuted"
```

| Signal | In macOS AX? | How |
|---|---|---|
| Participant name | ✅ | `AXTabGroup` description / `View <name>'s profile` button |
| **is-speaking** (active speaker) | ✅ | `, active speaker` suffix on the speaking tile's `AXTabGroup` description |
| Per-participant mute | ✅ | tile description (`Computer audio muted/unmuted`) + People-panel roster `AXImage` desc |

**Why it's readable (unlike Teams):** it's not a class or a `data-*` attr — it's plain **text in `AXDescription`**, the *same* format Zoom **web** uses. So the existing matcher already handles it end-to-end:
- `isSpeakingMarker` matches `"active speaker"` → [NameParsing.swift:62](../Sources/SpeakerCore/NameParsing.swift#L62)
- `cleanParticipantName(…)` strips the decoration → `"David's Iphone"`
- `platformExposesSpeakerNames(.zoom) == true` → the engine trusts the label and pulses the speaker (no `"Someone"` fallback).

The core matcher already handles it (`isSpeakingMarker` + `cleanParticipantName` + `platformExposesSpeakerNames(.zoom)`), locked with a self-test (`SpeakerCoreSelfTest`).

**Live-verified end-to-end.** A narrated 3-person `ZoomProbe` run (`ax-dumps/20260625-20*`) traced the marker against who actually spoke:

```
bidheyak         → 0.0–9.8s
David's Iphone   → 10.1–17.8s, 40.1–45.1s
(no marker)      → 18–40s   (silence)
```

`swift run ZoomProbe` now prints the current 🔊 ACTIVE speaker per tick from this marker.

**Notes / gotchas**
- The `, active speaker` suffix is **dynamic** — it moves to whichever tile is the current speaker (poll + diff).
- **A participant appears as SEVERAL tiles** (large spotlight + small thumbnail + panel row), and the marker sits on the **small active thumbnail**, *not* the largest box. So you must read state **per tile and merge by name** — keeping only the largest tile per name silently drops the marker (this was a real `ZoomProbe` bug, now fixed).
- The marker rides on the **tiles** (always in AX), so the People panel need NOT be open for *speaker* detection (only for the per-participant roster mute rows).
- The whole native window is tiny (~tens of nodes), so do **not** climb to a "row" ancestor — it returns the whole window and every tile's text matches the marker for everyone (also a fixed `ZoomProbe` bug).
- Caveat: with the panel open, roster `AXImage description="Computer audio unmuted"` / `"Video on"` and panel chrome (`Button`, `Pop out`, `Participants list`) can leak as fake names (never flagged speaking) — now filtered.

**This corrects `speaker-detection-platform-summary.md`**, which lists Zoom-native active-speaker as "❌ none (Metal grid opaque)". The Metal grid is opaque for *video*, but the per-tile `AXTabGroup` carries name + mute + the active-speaker text.

---

## Zoom web (`app.zoom.us/wc`) — names only; no is-speaking, no tile mute (prior probe)

Source: earlier live probe (not re-captured via `AXSnapshot` this round — see `speaker-detection-platform-summary.md` §3). Worth a fresh `AXSnapshot chrome` capture to re-confirm on the current client.

| Signal | In macOS AX? | How |
|---|---|---|
| Participant name | ✅ | tile |
| **is-speaking** | ❌ | no text marker, no toggling class |
| Per-participant mute | ❌ | not on the tiles |

**Why** — the opposite of native Zoom. Native Zoom (AppKit) bakes `", active speaker"` into the tile's `AXDescription`; the **web** client puts nothing speaking-related into AX — `"active speaker"` appears **nowhere**, and no class rotated in a single-speaker run. (The old `isSpeakingMarker` `"…, active speaker"` string was an unverified fixture from the initial commit, **disproved live** on the web client. A lone structural lead — `speaker-active-container` vs the filmstrip `speaker-bar-container` — stayed put, so it's unconfirmed.)

**Consequence** — Zoom web → **audio diarization only**. **Recall does NOT support Zoom web** (no browser-Zoom detector in its binary), so this is parked.

> Counter-intuitive but important: for Zoom, **native is the AX-rich client and web is the blind one** — the reverse of Meet/Teams, where the web/Chromium surface is what carries the signal.
