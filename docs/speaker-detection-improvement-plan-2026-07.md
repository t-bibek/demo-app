# Improving speaker detection & participant extraction — research synthesis and plan

**Date:** 2026-07-02. Produced from a multi-agent research sweep: a code-grounded audit of this
repo (docs treated as unverified claims, everything checked against source + `ax-dumps/`), plus
verified external research on shipping products (Granola, Fathom, Krisp, Otter, Limitless,
screenpipe, Recall.ai), open-source meeting bots (Attendee, Vexa, meet-teams-bot), Chrome
extensions, official platform APIs (Zoom RTMS/SDK, MS Graph, Meet REST/Media API), WebRTC
internals, diarization tooling, and the privacy/legal landscape. Sources cited inline.

---

## 0. TL;DR — ranked improvements

1. **Audio layer (all platforms, zero rot risk):** replace whole-system ScreenCaptureKit peak
   metering with **per-app Core Audio process taps** (macOS 14.4+) + **Silero VAD (CoreML)** +
   **VoiceProcessingIO AEC** on the mic leg. Windows mirror: per-process WASAPI loopback.
2. **Fix live engine gaps found in the audit:** the Teams roster is read but not used to build
   the names list in the `.teams` tick branch; `teamsActiveSpeaker()`/`TeamsSpeakerRules` are
   dead code. Wire the roster mute-gate properly or delete the dead path.
3. **Meet roster ground truth via the official REST API:** any attendee can poll the live
   participant list (user-consentable scope). Solves names, join/leave, dedup, and the
   background-tab AX loss for the roster half.
4. **Attribution engine upgrade:** move from "exactly-one-unmuted-or-Someone" to an
   **evidence-matrix binder** (mute = hard negative, solo-active intervals dominate, overlap
   discounted, Hungarian assignment with commit-on-margin). Overlap is 10–17% of meeting speech —
   it is not an edge case.
5. **On-device diarization to split multi-talker audio:** FluidAudio (pyannote community-1
   CoreML offline re-pass; LS-EEND streaming for provisional labels). Metadata-only binding —
   **no persisted voiceprints** (BIPA/GDPR litigation wave targets exactly that).
6. **Zoom authorized tier:** RTMS delivers `ACTIVE_SPEAKER_CHANGE` + per-participant unmixed
   audio — the only platform where an official API fully replaces AX today.
7. **Meet structural signal hardening:** the `IisKdb`+`gjg47c` audio-widget signal and
   `div[role="listitem"][data-participant-id]` roster hooks are independently confirmed by
   shipping extensions; probe whether they surface in `AXDOMClassList`, and adopt the
   class-*churn* observation trick as a name-agnostic fallback.

---

## 1. What the code actually does today (audit, doc-independent)

Verified against source and `ax-dumps/` (not `docs/`):

| Platform | Active speaker | Roster / names | Mute |
|---|---|---|---|
| Meet (Chrome) | `kssMZb` class via `AXDOMClassList` (confirmed in dumps; remote-config via `MeetSpeakerRules`), geometry ≥1.5× fallback, self = mic+local-unmute only | tile captions + "Pin <Name>" control labels | local only |

> **Correction to the repo's rotation assumption:** dated external evidence shows `kssMZb`
> stable since **Oct 2020** (uBlock filter in kgallimore/meetCleanup) and `gjg47c` since
> **Feb 2021** (alcaprar/meet-speaking-time) — ~5–6 years each, still in use by 2026 repos.
> Meet's compiled class names change on component *rewrites* (redesign waves: 2020, May 2021,
> Jul/Aug 2024, Sep 2025), not per-build. Keep remote config + telemetry, but the realistic
> threat is structural redesign and localized aria strings, not weekly class rotation.
| Zoom native | none (Metal grid opaque) → mute-gate + audio direction | Participants panel rows (`"<Name>, Computer audio muted/unmuted"`, English-only), panel must be open | roster rows |
| Zoom web | `speaker-bar-container__video-frame--active` class, VAD-gated | avatar alt / footer label per tile | not on tiles |
| Teams | **none live** — `teamsActiveSpeaker()` defined but never invoked; `TeamsSpeakerRules.speakingClasses` empty; PIP "<name> is speaking" note works | People-panel roster rows; **read but not fully wired into the `.teams` tick branch** | roster + announcements |

Cross-cutting weaknesses (all confirmed in code): raw peak metering (no VAD) on *mixed*
system audio; ~50 English-only reject strings in `NameParsing.swift`; `participant_id =
meetingId::name` (rename/collision fragility); "Someone" whenever ≥2 remotes unmuted;
background tabs drop the AX tree; panels must be open.

Doc claims contradicted by code/dumps: Teams `aria_*` speaking tokens (not implemented,
disproven by live probe); Zoom-web "active speaker" text marker (disproven); Recall's
"weighted cluster correlation" (their *documented* behavior is direct speaker-timeline
attribution; the weighted-correlation reading of the binary is folklore — treat as unverified).

## 2. What the industry actually ships (verified)

**Nobody ships bot-free per-name active-speaker detection.** Granola/Notion/Rewind = mic-vs-system
"Me/Them"; Otter/MacWhisper/Circleback/ChatGPT Record = post-hoc "Speaker N" diarization;
Krisp = on-device diarization + calendar names (auto-названия 1:1 only, Voice Embeddings since
v2.23); Otter is the only one with workspace-shared voiceprints (and is being sued over them).
Recall's Desktop SDK is the only commercial product doing what this repo does — its macOS
permission triple (Mic + **Accessibility** + Screen Recording) is the tell.
Sources: docs.granola.ai, notion.com/help/ai-meeting-notes, help.otter.ai, docs.recall.ai/docs/desktop-sdk,
techcrunch.com/2026/04/15 (Fathom 3.0 bot-free, mechanism undisclosed — worth a TCC teardown).

**Capture stack convergence** (screenpipe code-verified, MacWhisper release notes): Core Audio
process tap (`CATapDescription`, macOS 14.4+, "System Audio Recording Only" TCC — no purple
indicator, per-app isolation, `kAudioHardwarePropertyProcessIsAudible` as a free is-audible
signal) with ScreenCaptureKit fallback for 13.0–14.3 (+ watchdog — SCK streams die silently),
VoiceProcessingIO for AEC on the mic. Reference: github.com/insidegui/AudioCap,
screenpipe `crates/screenpipe-audio/src/core/process_tap.rs`. Windows:
`ActivateAudioInterfaceAsync` + `PROCESS_LOOPBACK` (include-tree covers Electron children).
Limit confirmed from Apple docs: taps deliver the app's **mix** — never per-participant.

**In-page (bot/extension) signals — what actually works:**
- Meet: `getContributingSources().audioLevel` per CSRC (Meet mixes into 3 fixed SSRC slots;
  CSRC identifies the true speaker; Google's own sample client uses magic CSRC 42 =
  loudest-speaker). CSRC→name comes from the `collections` data-channel protobuf
  (`streamId → deviceId → fullName`). Proven in Attendee
  (`google_meet_chromedriver_payload.js`) and meet-teams-bot. Captions arrive pre-attributed
  (`deviceId` per caption). DOM-side: `IisKdb` widget with speaking = absence of `gjg47c`
  (speaker-timer extension), People-panel `div[role="listitem"][data-participant-id]` for
  names (talk-time extension), `[data-self-name]` (talk-o-meter). talk-time's durable trick:
  MutationObserver on **any** class change of the talk-icon subtree + visibility check
  (bars hidden = muted) — no specific class name needed.
- Teams web: `getContributingSources()` CSRC presence matched against Teams' internal
  `participant.hasAudioSource()` model + a dominant-speaker-history data channel (Attendee).
- Zoom web: **no WebRTC media at all** (WASM + WebSocket/DataChannel) — DOM is the only
  in-browser signal; our class-prefix approach is the right one. Recall doesn't support
  Zoom web either.
- Vexa (docs.vexa.ai/speaker-identification): explicitly "DOM-based speaker correlation — not
  audio diarization" (pyannote rejected for latency), vote-and-lock: name locked after 2 votes
  at ≥70% confidence.

**Official APIs (verified against vendor docs):**
- **Zoom RTMS** (GA 6/2025): `ACTIVE_SPEAKER_CHANGE {user_id, user_name, timestamp}`,
  join/leave events, per-participant unmixed audio (`AUDIO_MULTI_STREAMS`), speaker-tagged
  transcript frames. Needs: user-managed OAuth app, public webhook (small backend), paid
  Developer Pack; host-org policy can block; visible banner. Lighter companion: Zoom Apps SDK
  `onActiveSpeakerChange {users:[{participantUUID, screenName}]}` (no stop event by design).
- **Meet REST v2**: `spaces.get` → `conferenceRecords.participants.list` filter
  `latest_end_time IS NULL` = live roster, **works for any attendee**, scope
  `meetings.space.readonly` (Sensitive, user-consentable). No speaker signal. Test: latency,
  @gmail-hosted meetings. **Meet Media API** has the real signal
  (`AudioFrame.is_from_loudest_speaker` + CSRC → `MediaEntry` → participant) but is
  Developer-Preview-gated with *all participants enrolled* — not shippable.
- **Teams: structurally closed.** Local WebSocket API discontinued ~Dec 2025; Graph live roster
  is app-only + admin consent; bots need Azure/Windows-Server/C# hosting. Watch
  `OnlineMeetingActiveSpeaker.Read.Chat` RSC (exists, no consuming API yet).

**Why single-speaker signals fail:** dominant-speaker algorithms (Volfin-Cohen in
Jitsi/mediasoup, Twilio, 100ms) elect ONE speaker; Meet forwards only the 3 loudest; Meet/Teams
active-speaker events are **change-driven** (no event for the second simultaneous talker).
Overlap prevalence: ~12–16% of speaking time in ICSI/NIST, ~19–20% AMI, 30–55% of
pause-delimited stretches contain overlap. Industry fix = per-participant streams (RTMS, Media
API, Recall "perfect diarization"). Mute state is exclusion-only evidence.

**Diarization tooling (Apple Silicon, production-viable):** FluidAudio
(github.com/FluidInference/FluidAudio, Apache-2.0) — pyannote community-1 recipe as
CoreML/ANE (offline) + LS-EEND streaming (100 ms updates); Silero VAD CoreML (~2 MB, <1 ms);
sherpa-onnx (offline, Swift bindings); Argmax SpeakerKit (MIT OSS tier). Streaming Sortformer
collapses ≥5 speakers (DER 42.6%). Cloud with word-level RT labels: Speechmatics (only vendor
with realtime channel+speaker mode AND enrollment), Deepgram multichannel+diarize, Soniox
(price floor). Apple's SpeechAnalyzer (macOS 26): no diarization.

**Binding literature:** no published work binds diarized clusters to meeting-roster identities
via mute/active-speaker timelines — production systems capture identity at the source or do
greedy interval attribution (Recall speaker-timeline, Vexa `mapWordsToSpeakers`). Nearest
analog: Adobe patent US12125501B2 (Hungarian assignment of clusters to face tracks). Our
planned binder is novel ground.

**Privacy:** voiceprint = enumerated BIPA identifier; EDPB says voice identification is GDPR
Art. 9 requiring explicit consent. Otter (In re Otter.AI Privacy Litigation, N.D. Cal.),
Fireflies, and Microsoft face voiceprint suits. Teams/Zoom-Rooms enrollment (explicit opt-in,
tenant storage, auto-expiry) is the compliance bar. **Per-meeting metadata binding creates no
biometric template — keep it the default.**

---

## 3. The plan

### P0 — foundations (no platform rot risk, immediate accuracy wins)
1. **Per-app audio capture:** `CATapDescription(processes:)` tap on the meeting app (and
   Chrome), SCK fallback 13.0–14.3 with liveness watchdog; keep mic separate; use
   `kAudioHardwarePropertyProcessIsAudible` as a cheap wake signal. Softer permission story
   ("System Audio Recording Only", no purple dot). Mirror on Windows via process loopback.
2. **Real VAD + AEC:** Silero VAD (CoreML) on both tracks; VoiceProcessingIO on the mic leg so
   speaker bleed stops producing false "You". Replaces the 0.02/0.04 peak thresholds.
3. **Engine fixes:** wire Teams roster into the `.teams` names path or delete the dead
   `teamsActiveSpeaker`/`TeamsSpeakerRules` scaffolding; key `participant_id` to stable IDs
   where available; start localizing/structuring the English-only parsers.

### P1 — attribution correctness
4. **Meet REST roster integration:** OAuth (user-level), poll live participants during detected
   Meet meetings; roster becomes ground truth for names/join/leave; AX handles the speaker
   half. Empirically test latency + consumer-account support first.
5. **Evidence-matrix binder** (replaces the binary mute-gate): `E[cluster][participant]`;
   mute = hard negative (×w_hard); Meet ring / PIP note = strong positive extended to next
   event (change-driven semantics); solo-unmuted intervals ×3–5; overlap frames ×0.1–0.3;
   caption time-IoU anchor when captions on; calendar attendees as prior + cluster-count cap;
   Hungarian assignment, commit only on margin (Vexa-style lock), else "Speaker N";
   many-to-one allowed (headset switch), one-to-many flagged "Room" (shared mic).
6. **On-device diarization:** mic track = "me" by construction; remote track through
   FluidAudio LS-EEND live (provisional) + pyannote community-1 offline re-pass post-meeting;
   re-run binding against final clusters. Kills the "Someone when 2+ unmuted" ceiling.

### P2 — platform-specific upgrades
7. **Meet structural hardening:** live-probe whether tile `AXDOMClassList` exposes
   `IisKdb`/`gjg47c` tokens (if yes: speaking = IisKdb ∧ ¬gjg47c — the pair survived widget
   updates that rotated `jscontroller`, and `gjg47c` has 5 years of dated stability); add
   Vexa's speaking-class set (`Oaajhc`, `HX2H7`, `wEsLMd`, `OgVli`) to the remote-config
   rules as candidates; add the class-churn heuristic (token-set changes on the talk-icon
   subtree, visibility-gated — talk-time's proven trick) as a name-agnostic fallback; keep
   `kssMZb` under remote config + telemetry.
7b. **Teams web structural speaker (new lead):** the cross-generation Teams web speaking
   signal is `data-tid="voice-level-stream-outline"` + ancestor class `vdi-frame-occlusion`
   (used by Vexa, MeetingBaaS, AWS LMA; survived classic→new Teams). The Windows port
   already keys on `vdi-frame-occlusion`; on macOS, `data-tid` won't surface in AX but the
   **class** may appear in Chromium's `AXDOMClassList` — populate
   `TeamsSpeakerRules.speakingClasses = ["vdi-frame-occlusion"]` and live-probe Teams web
   in Chrome. (Teams *native* likely still exposes nothing — it prunes the ring.)
   Caption fallback: Meet's caption region (`role="region"` + `aria-label="Captions"`,
   speaker name = first static text per caption group) and Teams caption author text are
   AX-visible — a caption-anchored speaker path when captions are on. Caveats: Meet replaces
   the region node on CC toggle (re-attach observers), Teams virtualizes/recycles caption
   nodes, and Zoom web captions often show only an avatar/initials (name needs a roster join).
7c. **Zoom native caption-anchored speaker (new lead):** Zoom desktop's built-in
   **Transcript panel is AX-readable** — name + text rows via the Accessibility API
   (proven by Xiaoniu86/Zoom_transcript_grabber's AppleScript
   `table 1 of scroll area 1 of window "Transcript"`). If the user enables live
   transcription, this gives Zoom native a real per-name speaker signal — the platform where
   we currently have none. Probe with `AXDump` against the Transcript window.
8. **Zoom RTMS tier** (authorized/paid users): webhook backend + `ACTIVE_SPEAKER_CHANGE` +
   optionally per-participant audio → perfect attribution incl. overlap. Zoom Apps SDK
   `onActiveSpeakerChange` as the no-backend companion. AX mute-gate stays as fallback.
9. **Optional DOM surface for Meet** (extension or CDP alongside the AX app): unlocks
   `getContributingSources().audioLevel` + `collections` CSRC→name and pre-attributed
   captions — the exact Attendee/meet-teams-bot pipeline, strictly better than any AX signal.
10. **Teams:** stay AX (no official path exists for consumer apps); keep PIP note; watch the
    `OnlineMeetingActiveSpeaker.Read.Chat` RSC for a consuming API.
11. **Voiceprints:** only ever as explicit opt-in enrollment modeled on Teams (retention
    limits, deletion), and only after the metadata binder ships.

### Addendum — Meet DOM-hook survey refinements
- Meet `data-participant-id` values are stable `spaces/<meeting>/devices/<n>` device IDs,
  continuously valid 2020→2026 (al-caughey attendance ext., trakers33, meeto) — the correct
  `participant_id` key wherever a DOM surface exists; they also map to Media API
  `MediaEntry`/caption `deviceId`.
- Definitive negative: across every surveyed extension/bot 2020→2026, **no "is speaking"
  aria-label exists in Meet** — the speaking state is exclusively class toggling (`gjg47c`
  removal, `kssMZb`/2021-era `HX2H7`-family presence) on `jsname="QgSmzd"`/`IisKdb` nodes.
  Chromium's `AXDOMClassList` is therefore the *only* AX-side route to it (our current path).
- Speaking-indicator timeline: 2020 = no DOM signal (extensions hooked `getVolume()`
  internals); Feb 2021 = `QgSmzd` + `HX2H7/OgVli/Oaajhc/wEsLMd`; ~Aug 2022→now =
  `IisKdb` gauge with `gjg47c`=silent, indicator carries `atLQQ`/`tC2Wod` + `kssMZb`.
  The `IisKdb`/`gjg47c` signal itself never broke 2022→2026; name-label *wrappers* churn
  (~annual), which is what kills naive scrapers.
- Name mining from control labels ("Pin <name> to your main screen", "More options for
  <name>") is the same technique our `meetNameFromControlLabel()` uses — but it's
  locale-dependent; the attendance extension shipped a localized-strings table for this.

### Key empirical tests before committing
- Meet REST: live-roster latency; @gmail-hosted meetings.
- Meet AX: are `IisKdb`/`gjg47c`/`data-audio-level` visible via `AXDOMClassList`/AX attributes
  on current Chrome? (The DOM detector proved them in raw DOM; AX visibility unproven.)
- Zoom RTMS: behavior in externally-hosted meetings (host-org gate).
- Fathom teardown: their bot-free real-name claim — check TCC prompts + AX permission.
