# Microsoft Teams Active-Speaker — Recall's mechanism + our state + plan

> Companion to `zoom-native-detection.md` and `meet-active-speaker-no-hardcoded-css.md`.
> Synthesized from 5 independent sub-agents (2× Recall-binary, 1× demo-app source, 1× improvement design, 1× external/forum), 2026-06-22.
> Evidence tags: **[proven]** = literal symbol/string in the shipping binary or source `file:line`; **[inferred]** = deduced from those; **[opaque]** = compiled, not recoverable from the binary.

---

## 0. TL;DR

- Teams (new client `com.microsoft.teams2`) is a **React/Chromium WebView app** → its DOM is exposed via the macOS AX tree. So unlike native **Zoom** (Metal, opaque), Teams **does** expose a readable "is-speaking" signal — it behaves like **Meet**.
- Recall derives Teams active-speaker by a **structural AX scan** (`TeamsScraper.scrapeMeetingParticipants → [(participant, isSpeaking)]`) over the PIP + main-stage overlay tiles, **fused with audio VAD** through the same `LibbotBridge` engine as Zoom/Meet. **[proven]**
- The scan keys on **stable Teams `aria_*`/`calling_*` localization tokens** (e.g. `aria_calling_roster_unmuted`, `calling_is_me_video`), matched structurally via `UiElementSelector` against AX attributes — **NOT** an obfuscated rotating CSS class like Meet's `kssMZb`. It even localizes per-locale (`Found new MS Teams locale:`). This is *more* rotation-robust than Meet. **[proven]**
- **No Teams/Microsoft SDK, no Graph, no MSAL** is used for capture. **[proven]** Microsoft confirms there is **no public API** that hands a passive observer the active speaker — the only first-party speaker signals (real-time media bots, ACS Calling SDK) require *joining the call*. **[external, sourced]**
- Recall records Teams **native-app only** — there is no Teams *browser-tab* recorder (Meet has Chromium/Safari variants; Teams does not). **[proven]**
- **Our demo-app today: zero Teams who-is-speaking logic.** Teams is detected and labeled, but always collapses to an anonymous `"Someone"` audio pulse; no names, no is-speaking, no VAD, no roster, no mute read. **[proven — source]**

---

## 1. What Recall's binary does for Teams [verified — symbols/strings]

Binaries under `…/node_modules/@recallai/desktop-sdk/`: `desktop_sdk_macos_exe` (Swift), `Frameworks/liblibbot_desktop_rs.dylib` (Rust core/VAD), `Frameworks/libui_recorder.dylib` (Rust AX + leveldb reader).

### 1.1 Classes & lifecycle
```
TeamsRecorder            — poller. TEAMS_BUNDLE_ID, micMonitor: MicActivityDetector,
                           teams_loop_timer: PollerWithMouseDetection, bundle_observer
                           "Polling teams for meeting…"  "Mic turned on, recording Teams UI tree…"
TeamsTopLevelScraper     — process-wide AX window/element discovery; caches structural lookups:
                           teamsCache : [UiElementSelector : ([AXUIWrapper], cachedAt: Date)]
TeamsMeetingRecorder     — per-meeting capture + active-speaker sync (peer of LibbotMeetingRecorder)
TeamsScraper             — per-window AX scraper (the is-speaking scan lives here)
```
Bundle IDs: `com.microsoft.teams2` (new / WebView2) and `com.microsoft.teams` (classic). **Native only** — there is no `TeamsChromium*`/`TeamsSafari*` recorder, whereas Meet ships `GoogleMeetChromiumRecorder`/`GoogleMeetSafariRecorder`. **[proven]**

### 1.2 Capture — identical stack to Zoom/Meet
`TeamsMeetingRecorder` conforms to `SystemAudioCapturerDelegate`, `MicDeviceDelegate`, `MeetingAppMediaCapturerDelegate`, `ScreenShareDelegate`:
```
mediaCapturers:[MediaCapturer]  shouldUseCoreAudio:Bool  audioDeviceRecorder:MicDeviceRecorder?
handleSpeakerAudioBuffer(…)     ← system/far audio
handleDeviceAudioBuffer(…)      ← local mic
CoreAudioSystemAudioCapturer → AudioHardwareCreateProcessTap / RecallAISystemAudioAggregateDevice
MeetingAppMediaCapturer       → ScreenCaptureKit (SCStream) per-window video + audio fallback
```
Only Apple frameworks + GStreamer + CoreML linked (`otool -L`). **[proven]**

### 1.3 Meeting detection — leveldb scrape, not an API
Detected by **native bundle id** + polled. The meeting URL/title is read by parsing the new Teams' **WebView2 IndexedDB leveldb off disk** (requires **Full Disk Access**):
```
Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/EBWebView
   WV2Profile_tfw/IndexedDB/https_teams.microsoft.com_0.indexeddb.leveldb
   WV2Profile_tfl/IndexedDB/https_teams.live.com_0.indexeddb.leveldb
" … requires Full Disk Access in order to retrieve meeting URLs for Teams."
```
Regexes (verbatim) harvest `meetingJoinUrl`/`meetingCode`/`callStartTime`/`passcode` from the persisted `MeetingInformation` JSON:
```
"meetingJoinUrl":"(https://teams\.[^"]*?/meet/([0-9]+)\?p=[A-Za-z0-9]+)"
"startTime":"(\d{4}-…)"[^{}]*?"meetingJoinUrl":"(https://teams\.microsoft\.com/l/meetup-join/[^"]+?)"[^{}]*?"__typename":"MeetingInformation"
\{"conversationUrl".*?"callStartTime":"(…)".*?"meetingCode":"([0-9]+)".*?"passcode":"[A-Za-z0-9]+"\}
```
**[proven]**

### 1.4 The AX "is-speaking" scan — how the speaking tile is found
Owning method: `TeamsScraper.scrapeMeetingParticipants(root: AXUIWrapper) -> [(MeetingParticipant, Bool)]` — the **`Bool` is the per-tile "is speaking now"** flag. Trace-span labels inside it:
```
TEAMS - PIP discovery
TEAMS - PIP is-speaking scan
TEAMS - PIP overlay tile scan
TEAMS - main overlay precompute
" is active speaker"           ← emitted when a tile's indicator marks it speaking
```
It scans **two layouts**: the small always-on-top **compact/PIP** window *and* the **main meeting-stage** overlay (`isWindowCompact(root:)` exists). **[proven]**

**Mechanism = structural element lookup keyed on stable Teams tokens** (not a CSS-class `.contains()`, not geometry-only, not audio):
- The work is done by `UiScrapingService.findElements(root:name:selector:depth:maxElements:)` + `UiElementSelector` (a structural AX query). **[proven calls]**
- The literal Teams DOM/aria tokens it matches (grouped in `__cstring`): `aria_announce_video_on`, `aria_calling_roster_muted`, `aria_calling_roster_unmuted`, `calling_is_me_video`, `calling_mute_aria_label`, `calling_unmute_aria_label`, `aria_has_context_menu` / `calling_aria_has_context_menu`, `vdi-frame-occlusion`. **[proven]**
- These are **stable semantic / localization keys**, and Recall **localizes** them: `TEAMS - determine locale`, `Found new MS Teams locale:`. So the handle survives Google-style obfuscation churn — the opposite of Meet's rotating `kssMZb`. **[proven]**
- AX attributes the bridge batch-reads (`libui_recorder`, `AXUIElementCopyMultipleAttributeValues`): `AXRole, AXSubrole, AXTitle, AXDescription, AXDOMClassList, AXDOMIdentifier, AXFrame, AXPosition, AXSize, AXChildren, AXWindowNumber`. **[proven]** Each `UiElementSelector` pairs an `attr:` (one of these) with `values:` (the tokens above) + a `MatchType`.

### 1.5 Tile → participant id, and mute
`TeamsMeetingRecorder.syncClientFramesAndActiveSpeaker()` ("Syncing client frames and active speaker"):
```
getIdForString(group:str:)  → stable Int id per name
MeetingParticipant.init(id:…:isActiveSpeaker:mixedRect:)   ← isActiveSpeaker = scraper Bool
syncParticipants(participants:) / syncParticipantsAndIsHost
```
Local mute (3 strategies): `TEAMS - isCurrentUserMuted anchor / button / fallback`, `TeamsScraper.isCurrentUserMuted(root:) -> Bool`, `syncAudioMuted()`. **[proven]**

### 1.6 Fusion (AX is-speaking ⊕ audio VAD)
```
TeamsMeetingRecorder.lastAxActiveSpeakerSet : Set<Int>   ← AX-only speaking set from the scrape
                     .activeSpeakers : Set<Int>  .lastActiveSpeakerId : Int?
LibbotMeetingRecorder.handleActiveSpeakerSetChange(source: Int32, participantIds: Set<Int>)
LibbotMeetingRecorder.pickBestGuessSpeaker(from:lastReported:prevSet:) -> Int?   (+ resetActiveSpeakerDedupeState)
→ Rust: Callbacks::on_active_speaker_set_change → State::compute_resolved_active_set / resolve_speaker_id
source-tag enum variant: AxVad (alongside Tentative / NeedsAction)   alignment key: ax_lag_s
VAD engine: libbot-plugin-desktop-active-speaker-detection — WebRTC MonoVad + fvad + RMS/LogOfEnergy,
            dsdk_vad_tick / legacy_vad_tick, gated by DSDK_VAD_IMPROVEMENT / DSDK_DIARIZATION_V2
```
The AX-derived set is reported **tagged as a source** and fused with the VAD set inside libbot. **[proven existence]** The exact set algebra (AX∪VAD vs AX-gated-by-VAD, debounce/hangover, thresholds) is **[opaque]** — compiled Rust.

### 1.7 What it is NOT [verified — absence]
- **No Teams/Microsoft SDK, Graph, MSAL, teamsjs** linked or called. `com.microsoft.*` in libbot = **ONNX Runtime operator namespaces**. The `MicrosoftTeams { azure_credentials, … }` / `MicrosoftTeamsData` serde structs are Recall's **cloud-bot** config schema, **dormant** in the desktop path. **[proven]**
- **No browser-tab Teams recorder** (native-only). **[proven]**
- **No `"Someone"` label** anywhere — Recall uses a numeric `UNKNOWN_ACTIVE_SPEAKER_ID`. **[proven]**

---

## 2. External reality check [sourced]

- **No public passive API.** Microsoft (MS Q&A): *"we did not find such APIs that could get the active speaker ID"* / *"Currently there is no such API to provide active speaker."* Graph **call records** are historical only (hours of delay). [MS Q&A](https://learn.microsoft.com/en-us/answers/questions/438372/to-get-active-speaker-in-teams-online-meeting), [call records](https://learn.microsoft.com/en-us/graph/api/resources/callrecords-api-overview?view=graph-rest-1.0)
- First-party speaker signals **require joining the call**: real-time media bots ([real-time-media-concepts](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts)) and the ACS Calling SDK `DominantSpeakers`/`dominantSpeakersChanged` ([ACS](https://learn.microsoft.com/en-us/azure/communication-services/how-tos/calling-sdk/dominant-speaker)) — neither is available to a passive observer.
- New Teams is **React/Chromium web UI** ([architecture blog](https://techcommunity.microsoft.com/blog/microsoftteamsblog/microsoft-teams-advantages-of-the-new-architecture/3775704)); Chromium exposes its a11y tree to macOS AX on demand (`AXWebArea`, set via `AXEnhancedUserInterface`/`AXManualAccessibility`) ([Chromium Mac a11y](https://www.chromium.org/developers/accessibility/mac-accessibility/)). This is why Recall needs the **accessibility** permission ([Recall docs](https://docs.recall.ai/docs/desktop-sdk)).
- The Teams "speaking" ring is a **visual/AX-node** signal; screen readers do **not** get an announced active-speaker message ([screen-reader meetings](https://support.microsoft.com/en-us/office/use-a-screen-reader-to-manage-microsoft-teams-meetings-4883a5ee-1d41-48eb-b684-74f1eefd7f57)).

**Cross-platform placement:**
| Platform | UI tech | AX speaking signal? | Recall's "who" |
|---|---|---|---|
| Zoom native | Metal (opaque) | ❌ none | VAD + diarization only; AX for names |
| Google Meet | Chromium | ✅ readable | structural "active speaker indicator" + geometry + VAD |
| **MS Teams (new)** | React/Chromium webview | ✅ readable | **structural `aria_*` token scan (PIP + main) + VAD** |

---

## 3. What our demo-app does today [verified — source]

Teams is recognized end-to-end but has **no who-is-speaking logic of its own.**
- **Detection works:** `nativeApps` maps `com.microsoft.teams2 / .teams / .teams2.helper → .teams` (`AccessibilityScanner.swift:41-46`); `platformForURL` `teams.microsoft.com`/`teams.live.com` (`PlatformDetection.swift:26`); `platformForBrowserTitle` (`:12`); `Platform.teams` (`Types.swift:8`).
- `platformExposesSpeakerNames(.teams)` → **false** (`PlatformDetection.swift:36-42`), comment *"Teams: not yet verified — still audio-only 'Someone'."* It's **dead at runtime** — the engine uses a parallel hardcoded `directSpeakerRead = false` (`AccessibilityScanner.swift:127-132`).
- **No Teams pass:** the platform switch has `if .meet` (per-tile) and `else if .zoom && isNative` (roster) but **no `.teams` branch** (`AccessibilityScanner.swift:106-132`). Teams gets only the generic `walk()` + `classify()` + `isSpeakingMarker()`.
- **No Teams is-speaking format:** `isSpeakingMarker` matches only Zoom-web/Meet/generic strings (`NameParsing.swift:49-57`). And `"teams"` is in `rejectSubstrings` (`:80`) → Teams names get dropped.
- **No Teams mute read:** `classify()` recognizes Zoom/Meet mute phrasing only (`AccessibilityScanner.swift:208-214`) → `localUserUnmuted` stays `nil` for Teams.
- **No VAD:** `SystemAudioMeter`/`MicMeter` are raw peak meters; activity is a threshold (`micPeak>0.04`, `systemPeak>0.02`, `DetectionEngine.swift:106-109`).
- **Net result:** every Teams window falls to the final `else` (`DetectionEngine.swift:185-198`): remote audio present → **`"Someone"`**; local user → `"You"` only if mic peak clears AND `localUserUnmuted == true` (rarely true) → **usually nothing but anonymous "Someone"; no real names ever.**

### Gaps
- No `.teams` scanner branch / Teams analog of the Meet per-tile pass or Zoom roster.
- No recognized Teams is-speaking signal; no Teams probe to derive it.
- No Teams roster / per-participant mute reader (so the mute-gate name path is unreachable).
- No Teams name decorations; `"teams"` is reject-listed.
- No Teams local-mute detection → "You" gate almost never fires.
- No VAD — peak threshold only, can't separate speakers.

---

## 4. How we can improve (phased, each shippable) [design]

Goal: mirror Recall — **structural AX is-speaking scan (stable `aria_*`/`calling_*` tokens) + real VAD fusion + roster**, with audio fallback. Teams is the *favorable* case (web UI, stable tokens).

**Phase 0 — Probe / ground truth (no app change).** Extend `MeetProbe` (or add `TeamsProbe`) to dump the AX tree of `com.microsoft.teams2`'s **main AND compact/PIP windows** (`AXWebArea`, per-tile `AXRole/AXSubrole/AXDOMClassList/AXDOMIdentifier/AXDescription/AXFrame`), run the speaking-vs-silent co-variance hunt against a narrated call, and pin the real structural is-speaking handle + locale tokens. (Same workflow that produced `MeetSpeakerRules`.)

**Phase 1 — Structural Teams is-speaking lookup (mirror the PIP scan).**
- New `SpeakerCore/TeamsActiveSpeaker.swift` (mirror `MeetActiveSpeaker.swift`): `TeamsTileObservation { name, area, orderIndex, isSpeaking, isMe, muted }` + resolver `teamsActiveSpeaker(tiles:prevAreas:vadSpeechActive:)` (VAD gate → structural indicator → geometry-dominant overlay → floor).
- New `SpeakerCore/TeamsSpeakerRules.swift` (mirror `MeetSpeakerRules`): `Codable`, remote-config'able, keyed on **stable `aria_*`/localized tokens + subrole/structure** (not one obfuscated class). Ship `builtin` + `resolved()` from `teams-rules.json`.
- `AccessibilityScanner.swift`: add `teamsTiles` to `ScannedWindow`; add `teamsTileObservations(in:)` (model on `meetTileObservations`, reuse `meetTileAncestor` geometry; self via `calling_is_me_video`); add a `platform == .teams` branch and set `directSpeakerRead = true` when found; flip `platformExposesSpeakerNames(.teams)` once verified.
- `DetectionEngine.tick()`: add a `.teams` branch (parallel to Meet) calling `teamsActiveSpeaker(...)`; tag pulses `"teams-structural"` / `"teams-vad"` via `EnginePulse.source`.

**Phase 2 — Real VAD backbone + source-tagged fusion + mute gate.**
- Promote the peak meter to a lightweight **RMS VAD** with hysteresis/hangover (200–300 ms on / ~500 ms off) + energy floor, exposing `isSpeechActive` (faithful follow-up: vendor WebRTC/Silero VAD behind the same interface).
- Keep `lastTeamsAxSpeakerSet`; fuse **AX structural set gated by VAD**; when VAD-speech but AX empty → mute-gated audio fallback (reuse `zoomMuteGateSpeakers`); when no speech → emit nothing (closes the current false-`"Someone"` hole).
- Extend `classify()` mute needles to Teams' localized Mute/Unmute labels (mirror `isCurrentUserMuted` trio).

**Phase 3 — Teams roster / names (mirror `TeamsScraper`).** New `SpeakerCore/TeamsRoster.swift` reading People-panel rows (name from `AXDescription`, mute from `aria_calling_roster_(un)muted`, self from `calling_is_me_video`); strip status suffixes; extend `NameParsing` (and remove the `"teams"` blanket reject). Feeds the mute-gated named fallback (1:1 → real name; 0 or 2+ unmuted remotes → "Someone").

**Phase 4 — Web vs native + PIP window.** Native teams2 (WebView2) → Phases 1–3 apply; **also scan the compact/PIP always-on-top window** (iterate all `AXWindows`, detect PIP by small size + overlay structure — Recall's "PIP discovery"). Web `teams.microsoft.com`/`teams.live.com` → same `teamsTileObservations` on the browser `AXWebArea` (foreground-tab only; Chromium freezes background tabs).

**Phase 5 — Telemetry + honest limits.** Counters `teamsAx/teamsVad/teamsSomeone` (mirror Meet's). Limits identical to Zoom/Meet: **overlap** (mixed stream can't split 2+ simultaneous remotes → "Someone"); **echo** (keep local pulse gated on a positive unmuted read); **naming** (locale/structure-fragile → must be remote-config'd); **permissions** (structural needs Accessibility; remote VAD needs Screen Recording).

### Files to touch
New: `SpeakerCore/TeamsActiveSpeaker.swift`, `TeamsSpeakerRules.swift`, `TeamsRoster.swift`; optional `Sources/TeamsProbe/`.
Edit: `AccessibilityScanner.swift` (`ScannedWindow` + `teamsTileObservations` + `.teams` branch), `DetectionEngine.swift` (`.teams` tick + fusion + telemetry), `SystemAudioMeter.swift`/`MicMeter.swift`/`AudioPeak.swift` (RMS + `isSpeechActive`), `PlatformDetection.swift` (flip `.teams`), `NameParsing.swift` (Teams suffixes; drop blanket `"teams"` reject). Reuse `zoomMuteGateSpeakers`.

### Rollout
0 (probe) → 2a (RMS VAD; helps Zoom/Meet too) → 1 (structural is-speaking → names) → 3 (roster → named 1:1) → 4 (PIP + web) → 5 (telemetry + real VAD).

---

## 5. Re-derivation / verification

```bash
SDK=…/node_modules/@recallai/desktop-sdk
EXE="$SDK/desktop_sdk_macos_exe"; UIREC="$SDK/Frameworks/libui_recorder.dylib"

# Teams classes + the is-speaking scan
nm "$EXE" | swift demangle | grep -iE "Teams(Scraper|MeetingRecorder|Recorder|TopLevelScraper)|scrapeMeetingParticipants|syncClientFramesAndActiveSpeaker"
strings -a "$EXE" | grep -iE "TEAMS - |is active speaker| is me video|aria_calling_roster|calling_(mute|unmute|is_me)|determine locale|Found new MS Teams locale"

# capture + detection + leveldb regexes
strings -a "$EXE" "$UIREC" | grep -iE "RecallAISystemAudioAggregateDevice|EBWebView|https_teams|meetingJoinUrl|MeetingInformation|Full Disk Access"

# fusion + VAD (libbot) + absence of Teams SDK
strings -a "$SDK/Frameworks/liblibbot_desktop_rs.dylib" | grep -iE "AxVad|compute_resolved_active_set|dsdk_vad_tick|MonoVad|ax_lag_s"
{ nm "$EXE"; strings -a "$EXE"; } | grep -icE "msal|graph\.microsoft|teamsjs"   # expect 0

# our app's current Teams handling
grep -rinE "teams" demo-app/Sources/SpeakerCore/PlatformDetection.swift demo-app/Sources/MeetSpeakerDetector/Engine/AccessibilityScanner.swift
```

## 6. Provenance
5 independent sub-agents, 2026-06-22: 2× Recall-binary (mechanism + capture/detection cross-check), 1× demo-app source audit, 1× improvement design, 1× external/forum. Binary: `@recallai/desktop-sdk` v2.0.19. Key correction vs Meet: **Teams hardcodes *stable* `aria_*`/`calling_*` localization tokens (rotation-robust), not an obfuscated CSS class.** Exact fusion algebra + selector chains remain **[opaque]** (compiled Rust/Swift data).

---

## 7. FINAL VERDICT — investigation closed (2026-06-23)

> Everything in §1–6 about an AX **is-speaking** signal for Teams is **SUPERSEDED**. After live probing the native client (`com.microsoft.teams2`) and re-decoding the binary, the conclusion reversed. The mute/name/self/geometry findings stand; the *speaking* claim does not.

**Microsoft Teams exposes NO who-is-speaking signal to a passive observer — via the macOS AX tree or any other passive channel.** Established by FIVE independent lines of evidence:

1. **Live AX probing** (MeetProbe, native Teams, `AXEnhancedUserInterface` ON): the per-tile/oracle diff over the FULL attribute surface + class + role-shape + **geometry** found NOTHING co-varying with narrated speech. The only dynamic per-tile AX state is **mute** (`…, muted`/`…, unmuted`) and **camera** (`…, video is on`).
2. **Needle hunt**: the exact string Recall matches — `" is active speaker"` — does **not** appear in ANY AX attribute anywhere in the live tree (full tree, 60s).
3. **Announcement listener** (`AXObserver` for `AXAnnouncementRequested`, no VoiceOver needed): Teams announces **only the local user's** `"Your microphone is muted/unmuted"` / `"Your camera is turned on/off"` — **never** `"<name> is active speaker"` and nothing about remotes.
4. **Binary re-decode** (3 agents): `TeamsScraper.scrapeMeetingParticipants -> [(MeetingParticipant, Bool)]` sets the speaking `Bool` by matching `" is active speaker"` — but that string is **inert on current Teams** (it's neither a persistent attribute nor an announcement). Recall therefore derives speaking from **VAD**, tagged `Vad` and fused with the `Ax` set (`{Ax,Vad}` source enum, 3.2 s hangover). The cluster→name binding is **`WeightedMapper`** = time-windowed **AX-state correlation** (`ax_state_at` + `credit_now`, keyed to diarized words) — **NOT voiceprints** (`grep` for `voiceprint`/`enroll`/`speaker-profile`/NN = empty; the only ONNX audio model is a VAD). *(An earlier note in this repo claiming voiceprint enrollment + nearest-match was WRONG — corrected here.)*
5. **External research** (3 agents, forums/docs/vendors): no official MS passive API (ACS `dominantSpeakers` needs **joining**; teamsjs `isSpeakingDetected` is a name-less boolean; Graph is post-call); screen readers get **no** active-speaker announcement (the ring is CSS-only); and **every** production botless desktop notetaker (Recall, Krisp, Granola, Otter, …) + OSS (pyannote, FluidAudio, WhisperX) attributes speakers by **audio diarization**, never by accessibility.

### What IS readable from Teams AX (passive, native client)
- Participant **names** (cleaned: drop `Myself video,` / `(Guest)`).
- Per-participant **mute/unmute** (`aria_calling_roster_*` → AXDescription text), like Zoom native.
- **Local** mic + camera state (roster text AND real-time `AXAnnouncementRequested` events).
- Tile **geometry** (`AXFrame`) + DOM order.

### What is NOT readable
- Who is speaking. No is-speaking attribute, class, geometry change, or announcement. Period.

### The only path to map an anonymous speaker → a name
**Audio diarization**, exactly as every real tool does:
1. Capture mixed remote audio (ScreenCaptureKit — already wired) + local mic.
2. **VAD + speaker-embedding diarization** → anonymous voice clusters. On-device Swift option: **FluidAudio** (pyannote/CAM++ via CoreML/ANE). Local user = mic source.
3. **Bind cluster → name** via the AX state we *can* read — Recall's `WeightedMapper` approach: credit each cluster to the participant the roster shows unmuted/active when it speaks (**mute-gated / UI-supervised diarization** — undocumented elsewhere; our contribution). Single unmuted remote → direct label; 2+ → accumulate credit over time.

### Shipping stance
- **Single active talker** (common, esp. push-to-talk): **VAD + mute-gate** already names them in the engine's `.teams` branch — no diarization needed. This is Recall's correlation reduced to one active participant.
- **Simultaneous multi-talker**: requires the diarization pipeline above (a real subsystem; even Recall diarizes — partly server-side). Until built, the honest output is `"Someone"` — the documented ceiling, identical to Zoom native.
- `TeamsSpeakerRules.speakingClasses` stays **empty** (no confirmed AX class); the rules carry only the verified mute/self tokens.
