# AX Research

> Live AX findings while probing meeting apps. Started 2026-06-25.
> Tool: `swift run AXSnapshot <target>` (`Sources/AXSnapshot`) = what macOS AX exposes.

---

## Summary — what macOS AX exposes per platform

| Platform | Participant name | is-speaking | Mute / unmute | PIP / compact layout |
|---|---|---|---|---|
| **Meet** (web) | ✅ tile caption; compact tile → `"Pin <Name>"` button † | ✅ `kssMZb` class on tile (`AXDOMClassList`) | ✅ local · ⚠️ remote (needs panel) | document-PIP = **separate window** (its `AXWebArea` has no `meet.google.com` URL); compact/spotlight drops the caption → name only via the `"Pin <Name>"` button (forced-tree †), but `kssMZb` ring still readable |
| **Zoom native** (`us.zoom.xos`) | ✅ | ✅ `", active speaker"` text on tile `AXDescription` | ✅ per-participant (tile + roster) | PIP thumbnail (subrole `AXSystemDialog`) names the speaker — `"Talking: <name>"` (Zoom's own VAD) → `pipSpeaker` |
| **Zoom web** (`app.zoom.us`) | ✅ | ✅ `speaker-bar-container__video-frame--active` class on tile (`AXDOMClassList`) | ❌ (not on tiles) | no separate PIP surface — filmstrip `--active` covers the dominant speaker inline |
| **Teams native** (`com.microsoft.teams2`) | ✅ | ✅ per-tile speaking-class set in `AXDOMClassList` (anchor `vdi-frame-occlusion`; rotating hashes → remote-config) + VAD | ✅ local · ✅ remote (tile `AXMenuItem` desc — `, muted` present/absent) | compact / pop-out view names the speaker — `"<name> is speaking"` `AXDocumentNote` → `teamsSpeakingNote` |
| **Teams web** (`teams.microsoft.com`) | ✅ | ✅ same class set as native | ✅ local · ✅ remote (tile `AXMenuItem` desc — `, muted` present/absent) | same as native (compact `"<name> is speaking"` note) |

✅ = readable from the macOS AX tree · ❌ = not in AX (DOM/visual only) / not needed · ⚠️ = conditional / unconfirmed. (†  forced-tree caveat at the bottom.)

**Names are always readable, and EVERY platform now exposes who-is-speaking directly in AX** (2026-07-01 — Zoom web was the last holdout). Two mechanisms: a **per-tile CSS class in `AXDOMClassList`** (Meet `kssMZb`; Teams native+web `vdi-frame-occlusion` + rotating Griffel hashes → remote-config; Zoom **web** `speaker-bar-container__video-frame--active`), or a **`", active speaker"` text marker** in `AXDescription` (Zoom native). No platform now requires audio VAD for attribution — VAD is fused only for precise on/off timing. The **self/local user is always the mic**, never a tile — the speaking ring is drawn only on *remote* tiles. Per-platform detail below.

> **The AX speaker read is independent of mute count.** Every platform marks the active tile(s) regardless of how many are unmuted (verified: 3-unmuted Zoom-native; Teams handoff across speakers, camera on AND off; Zoom-web `--active` moves tile→tile). Teams' class is **per-tile** — each speaking tile lights independently → genuine *simultaneous* multi-speaker — whereas Meet / Zoom-native / Zoom-web expose only the single *dominant* speaker. The mute-gate (name a speaker only when exactly one remote is unmuted) is now a **last-resort fallback**, not the primary path for any platform.

---

## Teams web — mute readable, AND is-speaking via a per-tile class (2026-06-29)

Capture: Chrome tab on `teams.microsoft.com`, local "bibek thapa" + remotes. **Same handle as native** (confirmed live: `vdi-frame-occlusion`/`___1vvhwjq` light the speaking tile, camera on AND off).

**What Teams provides**

| Signal | In macOS AX? | How |
|---|---|---|
| Participant name | ✅ | `AXStaticText` / descriptor |
| Mute/unmute (remote) | ✅ | tile `AXMenuItem` ancestor desc — `, Muted` present/absent (no roster panel needed) |
| Mute/unmute (local) | ✅ | own tile `AXDescription` carries `Unmuted`/`Muted` |
| **is-speaking** (remote) | ✅ | per-tile speaking-class set in `AXDOMClassList` (the `data-is-speaking` *attribute* stays DOM-only) |
| is-speaking (self) | ❌→mic | self-tile never rings (ring is for remote streams) → use mic + mute |

**Mute/unmute** rides on a named, accessible node (`"David Thapa (Guest), …"` / `"Mute mic"`), so it's in `AXDescription`.

**Why is-speaking IS readable.** The speaking ring is `<div data-tid="voice-level-stream-outline" data-is-speaking="true" class="… ___1vvhwjq vdi-frame-occlusion …">`. The `data-*` attrs never bridge to AX — **but the `class` on that same node does** (`class` → `AXDOMClassList`), and the ring carries a distinct set when active:

```
SPEAKING:  ___1vvhwjq  vdi-frame-occlusion  fn8mz29  f1ky4vpe  frwhdur  ftevtku  f1qyaz97  f14rmoke  fm03cl5  f3ve9t9
SILENT:    ___dv8x4j0  f1429bq1  f9pox2d
```

It toggles **per tile, following the speaker** — verified live on a 3-person handoff (the set moved speaker→speaker, cleared in silence), **camera on AND off**, never on the self-tile. `vdi-frame-occlusion` is the durable semantic anchor; the rest are rotating Griffel hashes → remote-config.

**Why earlier dumps said "not in AX" — false negative.** A static snapshot taken during *silence* shows only the non-speaking classes; the speaking variants are obfuscated hashes (keyword grep can't find them); and `AXObserve` saw nothing because Chromium toggles `AXDOMClassList` **without posting an AX notification**. Only a high-frequency **per-tile interval diff** (`swift run MeetProbe teams … oracle=…`) surfaces it.

**Consequence** — who-is-speaking IS in AX: read the speaking-class set per tile (anchor `vdi-frame-occlusion`, ≥K of the set, remote-config'd), fuse VAD for precise on/off. **Self → mic + mute** (the ring is for remote streams only). No extension needed.

---

## Teams native (`com.microsoft.teams2`) — same as web: is-speaking IS in AX (2026-06-29)

Teams native is a Chromium webview, so it behaves exactly like Teams web — including the speaking-class signal (confirmed live on native: 3-person handoff, camera on/off, multi-speaker).

| Signal | In macOS AX? | How |
|---|---|---|
| Participant name | ✅ | tile / roster `AXDescription` |
| Camera on/off | ✅ | `", video is on"` in the description |
| Mute/unmute (local) | ✅ | own tile desc + mic button (`Unmute mic` / `Mute mic`) |
| Mute/unmute (remote) | ✅ | tile `AXMenuItem` ancestor desc — `, Muted` present/absent (no roster panel needed) |
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

**Roster & remote-mute structure (2026-07-01).** Two structural gotchas surfaced while building the Teams roster:
- **Anchor the roster on the tile, not on free text.** Each participant tile is an `AXMenuItem` whose description matches `"context menu"` **and** a video-state token (`"video is on/off"` / `"myself video"`). Harvesting *any* text node instead produced false positives — bare name fragments and pre-join **lobby chrome** ("Bibek" on the lobby, toast text). Collect participants **only** from `AXMenuItem` nodes passing that structural test (`isTeamsParticipantTile`).
- **The remote-mute token lives on the `AXMenuItem` ancestor, not in the tile subtree.** `", muted"` sits on the menu-item container that *wraps* the video frame — outside the subtree a naive per-tile text read walks. Fix: from the tile, **climb up to ~8 ancestors**, folding each ancestor's `AXDescription` + classes into the tile blob until the `"context menu"` node, so the mute token is captured. A remote with **no** mute token present is inferred **unmuted** (unmuted-by-absence) — Teams omits the token rather than emitting `", unmuted"`.

```
AXMenuItem  description="BIDHEYAK THAPA, video is on, muted, Context menu is available"   ◀ mute token on the MenuItem ancestor
  … video frame … (AXDOMClassList carries vdi-frame-occlusion when speaking) …
```

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

**Compact / PIP layouts & the forced-tree caveat (2026-07-01).** In the normal grid/gallery every tile carries a visible caption, so names read straight off the UNFORCED foreground tree alongside the `kssMZb` ring. Two Meet-specific layouts change that:
- **Compact / spotlight-self** — the small remote tile **drops its caption**; the name then lives ONLY in the per-tile `"Pin <Name> to your main screen"` button, which is absent from the unforced tree, so a caption-less remote is detectable (ring) but resolves to **"Someone"** unless the tree is forced. The engine handles it by resolving the `kssMZb` **ring before geometry** (geometry would return the big self tile) and gating remotes on **system audio**, not the local mic.
- **Document Picture-in-Picture** pops the tiles into a **separate top-level window** whose `AXWebArea` carries no `meet.google.com` URL.

Tile extraction is scoped to the page's `AXLandmarkMain` so DevTools / browser chrome can't leak in as fake tiles. Full detail in "Browser window & the degraded vs forced AX tree" and "Picture-in-Picture & compact layouts" at the bottom.

---

## Zoom native (`us.zoom.xos`) — active speaker IS in AX (2026-06-25)

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

## Zoom web (`app.zoom.us/wc`) — is-speaking IS in AX via `--active` tile class (2026-07-01)

Capture: Chrome/PWA on `app.zoom.us/wc/…`, speaker-bar (filmstrip) visible. The earlier "names only, no is-speaking" verdict was a **false negative** — the active speaker's tile carries a distinct `--active` modifier class in `AXDOMClassList`, exactly the Meet/Teams pattern (a `class`, which bridges to AX; the old grep looked for `"active speaker"` *text*, which the web client never emits).

| Signal | In macOS AX? | How |
|---|---|---|
| Participant name | ✅ | tile — avatar-img `AXDescription` (camera off) **or** footer `AXStaticText` value (camera on) |
| **is-speaking** (active speaker) | ✅ | `speaker-bar-container__video-frame--active` class on the tile → `AXDOMClassList` |
| Per-participant mute | ❌ | not on the tiles |

**The class.** The non-speaking tile is `class="speaker-bar-container__video-frame"`; when that participant becomes the active speaker Zoom appends the `--active` modifier:

```
SILENT:    speaker-bar-container__video-frame
SPEAKING:  speaker-bar-container__video-frame  speaker-bar-container__video-frame--active
```

It toggles **per tile, following the dominant speaker** (verified live), and `--active` is the durable semantic anchor. A sibling fallback `speaker-active-container__video-frame` (the spotlight/big-stage variant) is also matched.

**Name extraction — anchor on the tile STRUCTURE, not free text** (else you harvest "Text"/chrome fragments):
- **Camera OFF** → the avatar node `video-avatar__avatar` / avatar-img carries the name in its `AXDescription`.
- **Camera ON** → there is no avatar-img (the `<video-player>` replaces it), but the tile **footer** always renders the name as an `AXStaticText`; read its **value**. `--active` is present in both camera states, so the footer read is what makes camera-on speakers nameable.

**PWA detection (the reason web Zoom was being missed entirely).** An installed Zoom PWA (`app.zoom.us/wc/<id>/join?...&fromPWA=1`) has **no address bar**, so title/URL-bar classification skipped it and no meeting was registered. Fix (ported from the desktop-app's approach): read the meeting URL straight off the **`AXWebArea`'s `AXURL` attribute** (address-bar-independent), classify platform from that URL **first**, then fall back to title/app-name. Chrome PWAs bundle as `com.google.Chrome.app.<hash>`.

**Why the earlier probe missed it** — same false-negative pattern as Teams: the old matcher searched for the `", active speaker"` *text* fixture (native-Zoom format, which the web client never emits); a single-speaker snapshot during silence shows only the base class; and the `--active` toggle posts no AX notification. A fresh per-tile class dump on a live meeting surfaced it. The lone structural lead noted previously (`speaker-active-container` vs `speaker-bar-container`) turned out to be the *big-stage vs filmstrip* container distinction — the real speaker signal is the `--active` **modifier**, present on whichever container holds the dominant speaker.

**Consequence** — Zoom web: who-is-speaking IS in AX (tile `--active` class, name from avatar-desc/footer-value), fuse VAD for on/off timing; **self → mic + mute**. Implemented in both the engine (`AccessibilityScanner.zoomWebSpeakerBar` → `DetectionEngine` source `zoom.web_active`) and the command probe (`ZoomWebProbe`, printed by `swift run ZoomProbe` as `🌐 ZOOM-WEB 🔊 ACTIVE`). Note Recall's binary has no browser-Zoom detector — this is a capability we have that its SDK does not.

> The old "for Zoom, native is AX-rich and web is blind" framing is **retired**: both Zoom clients now expose the active speaker in AX — native via the `", active speaker"` *text* marker, web via the `--active` *class*. The web/Chromium surface carries the signal here too, consistent with Meet/Teams.

---

† **Forced-tree caveat.** The per-tile **control buttons** (`"Pin <Name> to your main screen"`, `"More options for <Name>"`) — the only name source for a *compact tile that has dropped its caption* — appear ONLY when the Chromium tree is forced (`AXManualAccessibility`/`AXEnhancedUserInterface`). Production does **not** force it (memory + irreversibility), so a caption-less compact/PIP remote resolves to **"Someone"**. Tiles, the `kssMZb`/`--active`/`vdi-frame-occlusion` **ring**, and normal captions are all readable **unforced** on the foreground tab. Full detail in "Browser window & the degraded vs forced AX tree" below.

## Browser window & the degraded vs forced AX tree (all Chromium platforms) (2026-07-01)

Chromium (Chrome, Edge, the new Teams / WebView2, Electron) serves assistive tech
a **degraded, passive-reader tree** until a client sets `AXManualAccessibility`
and/or `AXEnhancedUserInterface` on the app element — the "an AT is here" flag
VoiceOver and Recall's recorder set. What that means for detection:

**Visible on the FOREGROUND tab UNFORCED** (verified live — the production scanner
reads this and does NOT force):
- Participant **tiles** (`oZRSLe` / `dkjMxf`) and their geometry.
- The **speaking-ring class** (`kssMZb`, Teams `vdi-frame-occlusion`, Zoom-web
  `--active`) in `AXDOMClassList`.
- Tile **captions** (`AXStaticText`) — self, and remotes in normal grid/gallery.

**Only present once the tree is FORCED** (the unforced tree's only `AXButton`s are
browser chrome — "View site information", "Back to tab"):
- Per-tile **control buttons** (`"Pin <Name> to your main screen"`, `"More
  options for <Name>"`). These carry a participant's name in **compact / PIP
  layouts that drop the visible caption** — so a caption-less speaking remote is
  detectable (ring) but **not nameable** without forcing.

**Decision — production does NOT force the tree.** Forcing makes Chromium build the
full tree (~18k nodes vs ~425 for a collapsed Meet window) — a real memory cost —
and it is **irreversible** (no way to clear it; the browser stays in accessibility
mode until it restarts, same footprint as VoiceOver). So the app reads the
already-sufficient unforced foreground tree; the trade-off is that a caption-less
compact/PIP remote resolves to **"Someone"**, not a name. The probe tools
(`MeetProbe`, `AXSnapshot`, `AXObserve`) DO force it — which is why a probe dump
shows the full tree (control buttons, every name) while a plain scan does not.
Historic flakiness ("sometimes named, sometimes not") traced to exactly this:
detection only saw the full tree while a probe or VoiceOver had *already* flipped
the flag.

## Structural scoping — the meeting `<main>` landmark (Meet) (2026-07-01)

The Meet video stage is the page's `<main>` region → `AXGroup [AXLandmarkMain]`,
found INSIDE the `meet.google.com` `AXWebArea`. Scope tile/name extraction to that
node, **not** the whole window: the address bar, other tabs, and an open
**DevTools panel** (its own `AXWebArea` + a `desc="DOM tree explorer"`
`AXLandmarkMain`) all sit OUTSIDE it. Scanning the whole window instead let
DevTools chrome (`"DevTools is docked to right"`) pass `isLikelyPersonName`,
become a fake tile, win the geometry contest, and get logged as the speaker. The
URL match on the web area distinguishes the Meet `<main>` from DevTools'. Within
the landmark, tiles are resolved by **geometry** — no dependency on the rotating
`oZRSLe`/`kssMZb` class for *tile* detection.

## Picture-in-Picture & compact layouts — per platform (2026-07-01)

**Meet — document-PIP is a SEPARATE top-level window.** Popping a call out
(document Picture-in-Picture) moves the tiles into a new always-on-top window
whose `AXWebArea` carries **no `meet.google.com` URL** (its own document), so
URL/title classification skips it — a tab-rooted scan (and `AXSnapshot chrome`,
which roots at a meeting *tab*) misses it. `AXSnapshot` now also dumps non-tab /
PIP windows for diagnosis.

**Meet — the compact / spotlight-self layout drops captions.** When you pin
yourself (large tile, camera off) a talking remote sits in a small tile that
**omits its caption** — the name survives ONLY in the `"Pin <Name> to your main
screen"` button (needs the forced tree; see above). The `kssMZb` ring is still on
that small tile, so who-is-speaking is known even when the name is not. Two engine
consequences:
- Resolve the **ring BEFORE geometry** — geometry only knows tile *size* and
  returns the big self tile (wrong). The ring only ever marks the speaking remote
  (never self), so it is the direct read; geometry is the no-ring fallback and
  never returns the self tile.
- Gate remote attribution on **system audio**, not the local mic — a muted
  meeting mic still moves the physical mic meter, so mixing it in pinned your own
  muted speech onto the remote tile.

**Zoom native — PIP thumbnail names the speaker.** The minimized Zoom PIP is a
floating window (subrole `AXSystemDialog`) with a `"Talking: <name>"` indicator
(Zoom's own VAD) — read directly (`ScannedWindow.pipSpeaker` via
`zoomPipContent`), so PIP-only mode names the speaker instead of "Someone".

**Teams — compact / pop-out view names the speaker.** The Teams "Meeting compact
view" is a secondary PIP-like window with no participant tiles, but Teams writes
`"<name> is speaking"` as an `AXDocumentNote` there — read directly
(`teamsSpeakingNote`), the same role as the Zoom PIP indicator.

**Zoom web** has no separate PIP surface on this build — the filmstrip `--active`
class covers the dominant speaker inline.
