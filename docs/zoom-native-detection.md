# How we approached "who is speaking, when" for **native Zoom** (macOS)

**Status:** investigated & verified — 2026-06-21. Outcome: native Zoom's
Accessibility tree exposes the **roster + per-participant mute/unmute state
(including remote participants)** — but **no active-speaker signal**. So Zoom's
"who is speaking" must come from **audio VAD** (Phase 5), fused with the AX
roster+mute we *can* read. This is exactly how Recall's Desktop SDK does it; we
confirmed that from their shipping binary (§5–6).

> Companion docs: [meet-speaker-detection.md](meet-speaker-detection.md) (the
> AX-class signal that *does* work for Google Meet) and
> [recall-and-demo-extraction.md](recall-and-demo-extraction.md) (the full Recall
> teardown this builds on).

---

## 0. TL;DR

- **Native Zoom ≠ Zoom web.** It's a separate AppKit app (`us.zoom.xos`), not a
  Chrome tab. There is **no `AXDOMClassList`** (that's a Chrome-web attribute),
  and the **video grid is Metal-rendered → opaque to Accessibility**.
- We built **[`ZoomProbe`](../Sources/ZoomProbe)** — the native-Zoom analog of
  `MeetProbe` — to measure (not guess) what the AX tree exposes.
- **What IS in AX (verified live):** the **Participants panel** carries each
  participant's name + mic state as text: `"<Name>, computer audio muted"` /
  `"…unmuted"`. This works for the **remote** participant too — better than Zoom
  web, which exposes nothing reliable.
- **What is NOT in AX:** any *speaking* signal. No "is speaking", no audio-level
  node, no per-row active-speaker glyph toggled with actual speech. The green
  audio meter you see is a Metal/CALayer animation, not an AX value.
- **Mute ≠ speaking.** An unmuted-but-silent participant reads identically to an
  unmuted-talking one (we caught a participant unmuted during a silence phase).
- **Conclusion:** native-Zoom "who is speaking when" = **audio VAD** for *when*
  + **AX roster/mute** for *who is eligible* (mute-gated attribution). That's
  Recall's architecture, confirmed from its binary.

---

## 1. The problem

The app already handles **Zoom *web*** via a labeled `AXDescription`
(`isSpeakingMarker` → `"…, active speaker"`) and **Google Meet** via a per-tile
`AXDOMClassList` class ([meet-speaker-detection.md](meet-speaker-detection.md)).
**Native Zoom** is a third case with none of those affordances:

- It's `us.zoom.xos`, a native AppKit app — **no web area, no DOM, no
  `AXDOMClassList`**.
- Its participant grid is **Metal-rendered**, so the tiles are an opaque
  rectangle to the AX tree — you cannot read tile geometry/labels/indicators the
  way you can on Meet (Chrome).

So the question for native Zoom is the same one we asked for Meet, but on a
totally different surface: *does anything in the AX tree move with who is
speaking?* We answer it by **measuring**, exactly as for Meet.

---

## 2. Method: the `ZoomProbe` instrument

[`Sources/ZoomProbe`](../Sources/ZoomProbe) (`swift run ZoomProbe [seconds] [intervalMs]`).
Because there are no CSS classes, the probe fingerprints each **named row** by
its AppKit structure instead:

1. Find the `us.zoom.xos` app via `NSWorkspace`, enumerate its windows
   ([ZoomRoster.swift](../Sources/ZoomProbe/ZoomRoster.swift) `zoomWindows()`).
2. Locate **named rows**: any node whose `AXTitle`/`AXDescription`/`AXValue`
   cleans to a person name (shared `cleanParticipantName` +
   [NameParsing.swift](../Sources/SpeakerCore/NameParsing.swift) rejects).
3. Climb to the **row container** — the *highest* ancestor whose subtree is still
   small (`rowMaxNodes = 40`), so we model the row, not the whole window.
4. Per row, sample ~4×/sec a **fingerprint** of its subtree:
   - `r:<role>` presence and `rc:<role>=<n>` **counts** (an extra speaking glyph
     would show as `rc:AXImage=2` replacing `=1`),
   - `t:<text>` for each text attr (name-stripped, digits → `#` so audio-level
     numbers don't churn),
   - `sel`/`foc` state, plus a tri-state **mic** read (`on`/`off`/`?`).
5. Also collect **whole-window** tokens each tick — to catch a speaking signal
   that lives *outside* the rows (a spotlight banner / toolbar).
6. At the end, print which per-row and whole-window tokens **toggled** and their
   **on-windows**, so a narrated run is directly readable against ground truth.

`swift run ZoomProbe 30 250` = watch 30 s, sample every 250 ms (4 Hz).

This mirrors `MeetProbe`'s "measure per-tile, don't guess" discipline; only the
*fingerprint* differs (AppKit roles + text + counts, vs Chrome's
`AXDOMClassList`).

---

## 3. What we found (live, against ground truth)

**Run 1 — Participants panel CLOSED.** Useless for per-row data: both
participants collapsed to *identical* fingerprints dominated by toolbar chrome
(`rc:AXButton=371`). The whole-window scan still showed only the **local user's**
mute state. Lesson: the names came from grid overlays (Metal grid → only text
overlays are visible), and the panel must be **open** to get per-participant
structure.

**Run 2 — Participants panel OPEN, unmuted, narrated** ("Bibek 0–10s, David
10–20s, silence 20–30s"). The panel exposes each participant's mic state as text,
**including the remote participant**:

| Participant | `…computer audio muted` | `…computer audio unmuted` |
|---|---|---|
| **Bibek** (local) | `0.0–1.5, 10.8–30.0` | (unmuted `1.5–10.8`) |
| **David's iPhone** (**remote**) | `0.0–13.3, 21.0–24.0` | `13.5–20.8, 24.3–30.0` |

The unmuted windows line up with the narrated turns (Bibek `1.5–10.8`, David
`13.5–20.8`) — so it *looks* like a speaker signal. **It isn't:**

- **David is unmuted `24.3–30.0` — during the "silence" phase.** Unmuted-and-silent
  is indistinguishable from unmuted-and-talking. It's **mic state, not speech.**
- In real meetings people stay unmuted continuously, so mute state carries
  **no** turn information most of the time.
- **No speaking token anywhere** — not per-row, not whole-window. The only
  dynamic tokens were toolbar auto-hide chrome and the mute-state text above.

So: **roster ✅, per-participant mute/unmute ✅ (remote included), active speaker ❌.**

---

## 4. The conclusion + the design it implies

Native Zoom's AX gives us **who is in the call and who is unmuted**, but **not
who is speaking**. The robust path is **two-signal fusion** (Phase 5):

```
audio VAD   → WHEN speech happens (speech_on / speech_off), frame-accurate
AX roster   → the participant names
AX mute     → who is ELIGIBLE to be the source (unmuted) right now
```

**Mute-gated attribution:** during a VAD speech segment, if exactly **one**
participant is unmuted → attribute the speech to them **by name**, no diarization
needed (covers most 1-on-1 / one-speaker-at-a-time calls). If several are
unmuted → fall back to on-device diarization (speaker embeddings) or log
`Someone`. This is precisely Recall's design — see §5.

---

## 5. Recall's native-Zoom architecture (what it does)

From the shipping `@recallai/desktop-sdk` binary (teardown in
[recall-and-demo-extraction.md §1.11](recall-and-demo-extraction.md), re-verified
2026-06-21 — commands in §6):

- **It does NOT use Zoom's SDK.** `otool -L` shows **no Zoom framework linked**;
  `0` `MobileRTC`/`ZoomSDK`/`ZoomVideoSDK` symbols. Recall records native Zoom the
  **same OS-level way as Meet**, just pointed at the Zoom *app window*.
- **Detect:** `getZoomMeetingWindows` enumerates the `us.zoom.xos` app's windows.
  (No browser `zoom.us` scanner exists → the **Zoom *web* client is not
  detected** by Recall at all; `search for zoom` = `0` matches.)
- **Meeting URL:** parsed from Zoom's **local logs** `/Library/Logs/zoom.us`
  (`zoom.us/j/<id>`) — which is why Recall's docs say *"restart Zoom"* (it must
  re-write logs after the SDK is installed).
- **The recorder** is `ZoomMeetingRecorder`, whose fields (demangled) tell the
  whole story:
  - `.app : AXUIWrapper?` → reads the Zoom app's **Accessibility tree**.
  - `.zoomScraper : ZoomScraper` → **versioned JS scraping rules** run over the AX
    tree via JavaScriptCore (`"Loading scraping JS logic for Zoom Version …"`),
    fetched from an S3 manifest — keyed per Zoom release because the native UI
    changes. This is the roster/mute/title/share scraper.
  - `.mediaCapturers : [MediaCapturer]` → **ScreenCaptureKit** (window video) +
    **CoreAudio process tap** (audio). No Zoom SDK.
  - `.audioDeviceRecorder : MicDeviceRecorder?`, `.handleSpeakerAudioBuffer(…)`,
    `.handleDeviceAudioBuffer(…)`, `.shouldUseCoreAudio`, `.isAudioOnlyRecording`
    → the Zoom recorder is built around **capturing and processing audio
    buffers** — that's the active-speaker spine for Zoom.
  - `.lastAxActiveSpeakerSet : Set<Int>` / `.lastActiveSpeakerId : Int?` →
    **generic** active-speaker cache fields present on *every* recorder. The name
    has "Ax" in it, but **for Zoom no AX scraper fills them from a speaking
    indicator** (see the per-platform contrast next).

- **Active speaker is sourced PER PLATFORM — and only Zoom relies on audio.** The
  binary has explicit AX speaking *scanners* for Meet and Teams, but **none** for
  Zoom (`grep -ciE 'zoom.*speak'` = `0`):

  | Platform | AX active-speaker scanner (literal symbol) | From AX? |
  |---|---|---|
  | Meet | `GoogleMeetScraper - active speaker container` / `… indicator`, `inferActiveSpeaker` | **yes** |
  | Teams | `TEAMS - PIP is-speaking scan` | **yes** |
  | **Zoom (native)** | *none* | **no → audio VAD** |

  Active-speaker-set changes carry a **`source` tag**
  (`on_active_speaker_set_change: … source tag`); for Zoom that source is the VAD
  stack — `AxVad`, `AudioLevelMessage{rms}`, `webrtc-vad` /
  `voice_activity_detector-0.2.1` — with modes `ActiveSpeakerDetectionMode` /
  `ToggleManualActiveSpeakerDetection` and events `ParticipantSpeechOn/Off`,
  `ActiveSpeakerChange`, `ActiveSpeakerSetChangeset`.
  → **This independently confirms our probe: native Zoom has no AX speaking
  signal; Recall reads Zoom's speaker from audio, exactly as we must.**

**Caveat Recall lives with (and so do we):** Zoom's grid is Metal-opaque, so the
AX active-speaker read is marginal; the **audio VAD path is what makes it work**.
Per-Zoom-version JS scraping rules exist precisely because the native UI (and thus
the panel scrape) shifts between releases.

---

## 6. How we extracted that from the binary (reproducible)

The SDK ships unstripped Swift/Rust binaries. We read symbols/strings — no
running, no network. Local copy:

```bash
SDK=/Users/bibekthapa/projects/work/recall-demos/dsdk-tutorial/node_modules/@recallai/desktop-sdk
#   $SDK/desktop_sdk_macos_exe              (Swift/ObjC orchestrator)
#   $SDK/Frameworks/liblibbot_desktop_rs.dylib   (Rust core: media, VAD, egress)
#   $SDK/Frameworks/libui_recorder.dylib    (Rust: AX dumper + IndexedDB readers)
```

**(a) No Zoom SDK — it's OS-level capture.**
```bash
otool -L "$SDK/desktop_sdk_macos_exe" | grep -iE 'zoom|mobilertc|rtc'   # → "no Zoom framework linked"
strings -a "$SDK/desktop_sdk_macos_exe" | grep -ciE 'mobilertc|zoomsdk|zoomvideosdk'   # → 0
```

**(b) Native detection + URL-from-logs (and NO Zoom-web detector).**
```bash
strings -a "$SDK/desktop_sdk_macos_exe" | grep -iE 'getZoomMeetingWindows|/Applications/zoom.us.app|/Library/Logs/zoom.us'
#   /Applications/zoom.us.app
#   /Library/Logs/zoom.us
#   Zoom - getZoomMeetingWindows - standard results
strings -a "$SDK/desktop_sdk_macos_exe" | grep -ciE 'search for zoom|AX(URL|Document).*zoom'   # → 0  (no browser-Zoom scan)
```

**(c) The recorder internals — demangle Swift symbols.** This is the key evidence
that native Zoom = AX scrape + capture + AX/VAD active speaker:
```bash
nm "$SDK/desktop_sdk_macos_exe" | swift demangle | grep -iE 'ZoomMeetingRecorder\.(app|zoomScraper|mediaCapturers|lastAxActiveSpeakerSet)' | sort -u
#   ZoomMeetingRecorder.app            : AXUIWrapper?              ← reads Zoom AX tree
#   ZoomMeetingRecorder.zoomScraper    : ZoomScraper              ← versioned JS scrape
#   ZoomMeetingRecorder.mediaCapturers : [MediaCapturer]          ← ScreenCaptureKit + CoreAudio
#   ZoomMeetingRecorder.lastAxActiveSpeakerSet : Set<Int>         ← AX active-speaker guess
```

**(d) The VAD fusion (in the Rust core).**
```bash
strings -a "$SDK/desktop_sdk_macos_exe"            | grep -iE 'lastAxActiveSpeakerSet|inferActiveSpeaker|ActiveSpeakerDetectionMode'
strings -a "$SDK/Frameworks/liblibbot_desktop_rs.dylib" | grep -iE 'AxVad|webrtc-vad|voice_activity|AudioLevelMessage'
#   …/webrtc/modules/audio_processing/vad/voice_activity_detector.cc
#   …/voice_activity_detector-0.2.1/src/vad.rs
#   AxVad … AudioLevelMessage{rms} … ParticipantSpeechOn/Off … ActiveSpeakerChange … ActiveSpeakerSetChangeset
```

Method, in one line: **`otool -L`** for linkage (proves no Zoom SDK), **`strings -a`**
for literal symbols/paths/log strings, **`nm | swift demangle`** for the typed
class/field structure that reveals how the pieces connect. The *combining logic*
is compiled (so it's `[inferred]`), but the components are literal `[verified]`.

---

## 7. How it's wired into the app (B1 + B2 — IMPLEMENTED)

The probe's findings are now live in the engine, in two changes:

**B2 — native Zoom no longer goes silent.** The bug: the engine gated on
platform-level `platformExposesSpeakerNames(.zoom)`, which is `true` (for Zoom
*web's* marker), so for native Zoom it neither read a name (no marker exists) nor
fell back to `Someone` → it logged **nothing**. Fix: the scanner now computes a
**per-window `directSpeakerRead`** flag —
[AccessibilityScanner.swift](../Sources/MeetSpeakerDetector/Engine/AccessibilityScanner.swift):
`true` for Meet (kssMZb) + Zoom-web (marker), `false` for native Zoom + Teams. The
engine branches on it, so native Zoom always resolves to a name or `Someone`.

**B1 — native Zoom mute-gated attribution.**
- [ZoomNativeAttribution.swift](../Sources/SpeakerCore/ZoomNativeAttribution.swift)
  (SpeakerCore, pure + unit-tested) — `ZoomRosterEntry` + `zoomMuteGateSpeakers(...)`.
- `zoomNativeRoster(in:)` in the scanner reads the Participants-panel rows
  (`"<Name>, Computer audio muted/unmuted"`, with `(me)` detection) and **skips the
  Zoom Workplace home/shell window** (an empty roster + no meeting controls + no
  "meeting" title ⇒ not a meeting).
- [DetectionEngine.swift](../Sources/MeetSpeakerDetector/Engine/DetectionEngine.swift)
  fuses **audio direction** with mute state:

  | Condition | Logged |
  |---|---|
  | `micActive` (your mic) + you unmuted | **your name** (roster `(me)`, else "You") |
  | `remoteActive` (system audio) + exactly **one** remote unmuted | **that name** |
  | `remoteActive` + **0 or 2+** remotes unmuted | **`Someone`** (ambiguous) |
  | silence | nothing |

  The split that makes this work: the **mic captures only your voice**, the
  **system tap only remote voices** — so a 1:1 where *both* stay unmuted still
  resolves (mic→you, system→them).

**Important — the "audio level" is mixed, not per-participant.** The header's
`AudioLevelBar` / `audioPeak` is the **`SystemAudioMeter`** peak — a single
combined system-output level (all remote voices mixed), captured via
ScreenCaptureKit. It is *not* a per-participant level (Zoom exposes none in AX; the
panel meter is Metal-drawn). That one mixed level is what drives `remoteActive` in
the mute-gate.

**Limits (by design, = Recall's desktop ceiling):** named attribution needs the
**Participants panel open** (that's where the mute text lives); panel closed →
`Someone` on meeting audio (B2). And it's mute-gated, not true VAD — multiple
unmuted simultaneous talkers → `Someone`. **R1** (real VAD) + **B3** (one shared
resolver) lift that later.

---

## 8. Engineering log — bugs we hit building the probe

Captured so the re-derivation doesn't repeat them:

- **Toolbar leaked as fake participants** (`Audio options`, `Mute my audio`,
  `Stop video`, `Upgrade to Pro`, …). The Zoom toolbar auto-shows; its buttons
  cleaned to "names." Fixed with control-label rejects in `NameParsing`
  (`options`, `upgrade to`, `my notes`, `my audio`, `stop video`, `start video`).
- **Run overran its duration** (asked 40 s, ran to 49 s). The loop counted a fixed
  number of *ticks*, but heavy AX scans make some ticks > the interval. Fixed:
  stop on **elapsed time**, not tick count.
- **Per-row fingerprints were identical** (`rc:AXButton=371`). `rowAncestor`
  over-climbed to the whole-window container. Fixed: climb only while the subtree
  stays small (`rowMaxNodes = 40`).
- **False `🔇 muted`.** The live glyph flipped to muted if *any* node contained
  the substring "muted" — a stray "Mute" button / "unmute my audio" label masked
  unmuted participants. Fixed: key on the explicit phrase, `audio unmuted` wins
  over `audio muted`.

---

## 9. Re-derivation playbook

```bash
# 1) Live narrated capture — be IN a native Zoom meeting, OPEN the Participants
#    panel, Gallery view, stay UNMUTED, narrate turns, mouse still:
swift run ZoomProbe 30 250 | tee zoom-native-log.md
#    Live line: 🎙️on = unmuted (candidate speaker) / 🔇off = muted / · unknown.

# 2) Read SESSION ANALYSIS. A token whose on-windows MATCH who you narrated
#    speaking would be a real speaking signal. (To date: none — only mute state.)

# 3) Raw AX inspection of the Zoom app if needed:
swift run AXDump zoom --attrs

# 4) Re-verify Recall's approach from the binary: §6 commands.
```

---

## 10. Per-platform status

| Platform | Roster | Active speaker — source | Status |
|---|---|---|---|
| **Zoom (web)** | best-effort | `"…, active speaker"` in `AXDescription` | working (labeled read) |
| **Google Meet** | yes | per-tile `AXDOMClassList` class ([doc](meet-speaker-detection.md)) | working (verified), rotates |
| **Zoom (native)** | **yes + mute (remote incl.)** | **none in AX** → mute-gate now; audio VAD next | **B1+B2 live: named when one unmuted, else `Someone`; true VAD = R1** |
| **Microsoft Teams** | best-effort | none verified | audio-only (Phase 5) |

> Bottom line: for native Zoom we *verified* the readable AX surface (roster +
> per-participant mute, remote included) and *ruled out* an AX speaking signal —
> so the speaker timeline is an **audio-VAD** problem, fused with the AX
> roster/mute, exactly as Recall ships it.
