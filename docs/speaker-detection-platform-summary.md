# Who‑is‑speaking across Meet / Zoom / Teams — platform summary

**Status as of 2026-06-23.** This is the high‑level summary of what each meeting
platform exposes to the macOS Accessibility (AX) tree for *who is speaking* and
*who is muted*, what we built, and what's next. Per‑platform deep dives:
[meet-speaker-detection.md](meet-speaker-detection.md),
[zoom-native-detection.md](zoom-native-detection.md),
[teams-active-speaker-detection.md](teams-active-speaker-detection.md).

---

## TL;DR

| Platform | Participant names | Per‑participant mute/unmute | Active speaker (who's talking) | How we get the speaker |
|---|---|---|---|---|
| **Google Meet** (Chrome web) | ✅ AX | ⚠️ local only — remote TBD | ✅ **CSS class** (`kssMZb`) via `AXDOMClassList` | read the class, fuse with VAD |
| **Zoom native** (`us.zoom.xos`) | ✅ AX (panel) | ✅ **from AX** (panel rows, remote incl.) | ❌ none (Metal grid opaque) | mute‑gate + audio VAD |
| **Zoom web** (`app.zoom.us/wc`) | ✅ AX | ❌ not on tiles | ❌ **none** (no text, no class) | audio diarization only |
| **Teams** (native + web) | ✅ AX | ✅ **mute/unmute exposed** (roster + announcements) | ❌ none (CSS‑only ring, pruned) | mute/unmute events → backend diarization |

**The unifying conclusion:** only **Meet** exposes who‑is‑speaking directly (a CSS
class). Everyone else gives us **names + mute state** but *not* speech — so the
speaker timeline must come from **audio diarization**, with the AX **mute/unmute
events as the hint** that binds an anonymous voice cluster to a real name. This is
exactly Recall's architecture (see last section).

---

## Per‑platform

### 1. Google Meet — Chrome web ✅ speaker known
- **Done:** active speaker read from a **known CSS class name** (`kssMZb`) on the
  speaking tile via `AXDOMClassList`, per‑tile, fused with audio VAD + geometry.
  Local mute is readable.
- **Next week:** **re‑check whether per‑participant (remote) mute/unmute is
  readable from the tile structure** — today we only have local mute; remote mute
  per tile is not yet extracted.

### 2. Zoom native — `us.zoom.xos` ✅ mute from AX
- **Done:** **extracted per‑participant mute/unmute from the AX tree** — the
  Participants‑panel rows read `"<Name>, computer audio muted/unmuted"` (remote
  participants included). No active‑speaker signal exists (the video grid is
  Metal/GPU‑rendered → opaque to AX). Speaker = **mute‑gated attribution + audio
  VAD**. Needs the Participants panel open.
- **Next:** audio‑VAD fusion (backend) for multi‑talker.

### 3. Zoom web — `app.zoom.us/wc` ❌ nothing usable
- **Found (live probe, this build):** **no active‑speaker signal at all** — no
  text marker (`active speaker` appears nowhere in AX) and **no toggling class**.
  Tiles carry only the **name**; per‑participant mute is **not on the tiles**.
  - The old code claimed a `"…, active speaker"` text marker — that was an
    **unverified fixture inherited from the initial commit**, and the live probe
    **disproved it** on the current client.
  - One structural lead — a `speaker-active-container` class (vs the filmstrip
    `speaker-bar-container`) — exists but **did not rotate** in a single‑speaker
    run, so it is **unconfirmed** as an active‑speaker signal.
- **Recall does NOT support Zoom web** (their binary has *no* browser‑Zoom
  detector — see last section). So this is **low priority**.
- **Next:** if ever needed, treat like Teams — audio diarization. Otherwise park.

### 4. Microsoft Teams — native (`com.microsoft.teams2`) + web ✅ mute/unmute exposed
- **Found:** **no active‑speaker signal** in AX (the speaking ring is CSS‑only and
  pruned from the tree). But **mute/unmute IS exposed** on both clients:
  - **Per‑participant remote mute** from the **People/Participants‑panel roster
    rows** (panel must be open). Native: `"<Name>, …, Muted/Unmuted"`. Web:
    `"<Name>, [muted,] Context menu is available"` — and the **unmuted form drops
    the mic word entirely** (fixed in `parseTeamsRosterRow`).
  - **Local** mic/camera changes also fire on the AX **announcement** channel.
- **Done:** roster parser (native + web), mute‑gate attribution, live probe with a
  RAW dump.
- **Plan (the main one):** **export the mute/unmute events to the backend** and
  **bind participant names to diarized voice clusters by weighted correlation** of
  the cluster's active windows against the mute timeline. This stays reliable even
  when **several people are unmuted at once** (the weighting disambiguates; a
  single unmuted talker is the easy case).

---

## The shared design (what we ship)

The native app is a **producer of a post‑call bundle**; diarization runs in the
**backend**:

1. **Audio** — two tracks, `local-mic` + `remote-mixed` (system audio), 16 kHz
   mono 16‑bit WAV (the format VAD/diarizers consume).
2. **`manifest.json`** — the AX **event timeline** we *can* read: per‑participant
   **mute/unmute edges**, roster membership, local‑mic activity, and (Meet only)
   speaking hints.
3. **Backend** — diarizes `remote-mixed` into anonymous clusters, then **binds each
   cluster → a name** by **weighted correlation** with the mute timeline (a cluster
   active while exactly one remote was unmuted ⇒ that remote; weighted when 2+ are
   unmuted). `local-mic` is the local user.

---

## How Recall does this (from their shipping binary)

Decoded from `@recallai/desktop-sdk` (`otool`/`strings`/`nm | swift demangle`;
see [zoom-native-detection.md §5–6](zoom-native-detection.md) and
[recall-and-demo-extraction.md](recall-and-demo-extraction.md)). The same shape we
arrived at:

- **Active speaker is sourced PER PLATFORM**, fused via `ActiveSpeakerSetSource {Ax, Vad}`:
  | Platform | Recall's AX speaking scanner | Source |
  |---|---|---|
  | Meet | `GoogleMeetScraper - active speaker container` / `… indicator`, `inferActiveSpeaker` | **AX** |
  | Teams | `TEAMS - PIP is-speaking scan` | **AX** (inert on current builds → falls to VAD) |
  | Zoom native | *none* | **audio VAD** |
  | Zoom web | *not detected at all* | — |
- **Name binding = AX‑state correlation, NOT voiceprints.** `WeightedMapper`
  (`ax_state_at` / `credit_now`) ties a diarized cluster to a participant by
  correlating it with that participant's **AX state over time** (mute, presence) —
  weighted. There is **no voiceprint enrollment / speaker DB** in the binary
  (only generic CoreML/ONNX embedding used for VAD). This is exactly the
  "diarize locally, bind by the mute/state hint" approach above.
- **VAD stack:** `webrtc-vad` / `voice_activity_detector-0.2.1`, `AudioLevelMessage{rms}`,
  events `ParticipantSpeechOn/Off` / `ActiveSpeakerChange` / `ActiveSpeakerSetChangeset`,
  ~3.2 s hangover; diarization behind `DSDK_DIARIZATION_V2`.
- **Capture:** `mediaCapturers` = **ScreenCaptureKit** (video) + **CoreAudio
  process tap** (audio); **no Zoom/Teams SDK linked** — pure OS‑level capture.
- **Zoom specifics:** `ZoomScraper` runs **versioned JS scraping rules over the AX
  tree** (per Zoom release) for roster/mute/title; meeting URL parsed from
  `/Library/Logs/zoom.us`. **No browser‑Zoom scanner exists** → the **Zoom web
  client is unsupported by Recall**, matching our finding above.

---

## Next steps

- [ ] **Meet:** re‑check per‑participant (remote) mute/unmute from tile structure — *next week*.
- [ ] **Build the backend export bundle** — `manifest.json` (mute/unmute event timeline) + `local-mic`/`remote-mixed` WAVs.
- [ ] **Backend:** diarize `remote-mixed`; **weighted name‑binding** of clusters via the mute/unmute hints (robust to multiple unmuted at once).
- [ ] **Teams:** the mute/unmute event export is the priority path (both native + web ready).
- [ ] **Zoom web:** parked (Recall doesn't support it); revisit only if required.
