# AX Research

> Live AX findings while probing meeting apps. Started 2026-06-25.
> Tool: `swift run AXSnapshot <target>` (`Sources/AXSnapshot`) = what macOS AX exposes.

---

## Summary — what macOS AX exposes per platform

| Platform | Participant name | is-speaking | Mute / unmute | How we get the speaker |
|---|---|---|---|---|
| **Meet** (web) | ✅ | ✅ `kssMZb` class on tile (`AXDOMClassList`) | ✅ local · ⚠️ remote (needs panel) | AX class + VAD |
| **Zoom native** (`us.zoom.xos`) | ✅ | ✅ `", active speaker"` text on tile `AXDescription` | ✅ per-participant (tile + roster) | AX text marker (+ VAD timing) |
| **Zoom web** (`app.zoom.us`) | ✅ | ❌ | ❌ (not on tiles) | audio diarization only |
| **Teams native** (`com.microsoft.teams2`) | ✅ | ❌ (DOM `data-is-speaking`, not in AX) | ✅ local · ⚠️ remote (roster panel, absence-coded) | VAD + mute-gate |
| **Teams web** (`teams.microsoft.com`) | ✅ | ❌ (DOM `data-is-speaking`, not in AX) | ✅ local · ⚠️ remote (roster panel, absence-coded) | VAD + mute-gate |

✅ = readable from the macOS AX tree · ❌ = not in AX (DOM/visual only) · ⚠️ = conditional / unconfirmed.

**Names are always readable. Only Meet and Zoom-native expose who-is-speaking directly in AX** (a CSS class and a text marker respectively); Zoom-web and both Teams clients give names + mute but need audio VAD for the timeline. Per-platform detail below.

> **The speaker read on the two marker platforms is independent of how many participants are unmuted.** Meet/Zoom-native mark the single *active* tile regardless of mute count (verified: 3 simultaneously-unmuted remotes on Zoom-native, AX named the one talking and tracked the hand-off). The **mute-gate** — the only speaker hint on Teams/Zoom-web — is different: it names the speaker only when **exactly one** remote is unmuted; 2+ unmuted needs audio diarization. (The marker is still single-valued, so genuinely *simultaneous* talkers show only the app-promoted dominant one.)

---

## Teams web — mute/unmute is readable, is-speaking is not (2026-06-25)

Capture: Chrome tab on `teams.microsoft.com`, local "bibek thapa" + remote "David Thapa (Guest)".

**What Teams provides**

| Signal | In macOS AX? | How |
|---|---|---|
| Participant name | ✅ | `AXStaticText` / descriptor |
| Mute/unmute (remote) | ✅ | roster `AXDescription` — `, Muted` present/absent |
| Mute/unmute (local) | ✅ | own tile `AXDescription` carries `Unmuted`/`Muted` |
| **is-speaking** | ❌ | only in the DOM (`data-is-speaking`), not in AX |

**Why mute/unmute works** — it rides on a *named, accessible* node, so the state is baked into `AXDescription`:

```
description="David Thapa (Guest), Context menu is available"        # remote, UNMUTED (no "Muted")
description="Myself video, bibek thapa, Unmuted, Has context menu"  # local, explicit
description="Mute mic"                                              # local mic button
```

**Why is-speaking fails** — Teams *does* track it, but on the one surface AX can't see. In the DOM:

```html
<div data-tid="voice-level-stream-outline" data-is-speaking="true"  class="… ___1vvhwjq …"></div>
<div data-tid="voice-level-stream-outline" data-is-speaking="false" class="… ___dv8x4j0 …"></div>
```

It's invisible to AX for two reasons:
1. **`data-*` is never bridged to macOS AX** (only `class`/`id`/ARIA are). Grep of the AX dump: `data-is-speaking` / `voice-level-stream-outline` = **0 hits**.
2. The node is an **empty decorative `<div>`** (no role/name) → Chrome marks it `ignored` and prunes it from the platform tree.

One line: *mute is on a meaningful named element; speaking is on a presentational element via a non-bridged attribute.* That asymmetry is the whole reason we get mute but not speaking.

**Consequence** — desktop/AX route: Teams gives **roster + mute/unmute only**; who-is-speaking must come from **audio VAD + the mute-gate**. The only way to read `data-is-speaking` directly is an **in-browser extension** (web Teams only).

---

## Teams native (`com.microsoft.teams2`) — identical to web: mute readable, is-speaking not (2026-06-25)

Capture: `swift run AXSnapshot teams` (`ax-dumps/20260625-202855`, 128 nodes). Teams native is a Chromium webview, so it behaves exactly like Teams web.

| Signal | In macOS AX? | How |
|---|---|---|
| Participant name | ✅ | tile / roster `AXDescription` |
| Camera on/off | ✅ | `", video is on"` in the description |
| Mute/unmute (local) | ✅ | own tile desc + mic button (`Unmute mic` / `Mute mic`) |
| Mute/unmute (remote) | ✅ | roster desc — `, Muted` present/absent |
| **is-speaking** | ❌ | nothing in AX (exhaustively checked) |

```
description="Myself video, Bibek Thapa, Muted, Has context menu"        # local, MUTED
description="bidheyak (Guest), video is on, Context menu is available"  # remote, unmuted (no "Muted"), cam on
description="David Thapa (Guest), Context menu is available"            # remote, unmuted
description="Unmute mic"                                                # mic button ⇒ you're muted
```

**Why is-speaking fails (exhaustive check)** — across all 128 nodes: every attribute type read, **555 class tokens**, and a raw grep for `voice-level`/`stream-outline`/`is-speaking`/`active-speaker`/`talking` → **0 hits**. The tiles carry no `AXValue`/`AXSelected`/speaking class. Same root cause as web: the speaking ring is the `ignored` `voice-level-stream-outline` div + `data-is-speaking` (`data-*` not bridged).

**Live-observer test — SETTLED (2026-06-25).** Ran `swift run AXObserve teams 20` (`Sources/AXObserve`, an event-driven `AXObserver`, not a snapshot) during narrated speech. The observer works — it caught David's tile description flip to `", video is on"` (camera toggle) and focus changes — but across ~40s of speech fired **no speaking signal**: the `AXARIALive` regions stayed silent, no `AXAnnouncementRequested`, and tile descriptions mutate for **camera/mute only, never speaking**. So who-is-speaking is **not in AX live either**, not just statically. (Residual: `AXAnnouncementRequested` can be gated on VoiceOver being active — re-run with VoiceOver (⌘F5) to close that one sub-channel; the tile + live-region *change* events, which fire regardless, are a confirmed negative.)

**Consequence** — Teams (native **and** web): roster + mute only; who-is-speaking = **audio VAD + mute-gate**. Recall ships a structural PIP is-speaking scan (`TeamsScraper.scrapeMeetingParticipants`) but it's **inert on current builds → falls to VAD**, and binds VAD clusters to names by correlating with the AX mute timeline (not voiceprints). See `teams-active-speaker-detection.md`.

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
