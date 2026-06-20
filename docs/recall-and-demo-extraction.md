# Meeting Data Extraction — Recall Desktop SDK vs. our demo-app

**Audience:** engineers and AI agents working on local meeting capture / speaker
detection. This is a *knowledge + re-derivation* doc: it records what we verified,
marks **[verified]** vs **[inferred]**, and — crucially — tells you **how to
re-prove every claim yourself** (commands + file refs), because the underlying
artifacts (Recall's shipping binary, Google Meet's DOM/AX tree) change over time.

_Last verified: 2026-06-20. Recall `@recallai/desktop-sdk@2.0.19` (commit `41a8616`), macOS arm64._

Two systems are compared:
- **Recall Desktop SDK** — a 3rd-party native SDK. Local copy to inspect:
  `/Users/bibekthapa/projects/work/recall-demos/dsdk-tutorial/node_modules/@recallai/desktop-sdk/`
  (a working integration lives in `recall-demos/dsdk-tutorial`).
- **demo-app** (this repo) — our own native macOS Accessibility-based speaker
  detector (`Sources/MeetSpeakerDetector`, `Sources/SpeakerCore`, `Sources/AXDump`).

---

## 0. TL;DR

- Recall's Desktop SDK captures Meet/Zoom/Teams **locally** by reading the meeting
  window's **macOS Accessibility tree** + capturing screen (ScreenCaptureKit) and
  system audio (CoreAudio process tap). **No browser extension, no CDP.** [verified — binary symbols]
- For **active speaker**, Recall **infers** it (per-tile container + indicator child,
  remote-updated scraping rules, **fused with on-device audio VAD/ONNX diarization**).
  The verb is *infer*, not *read*. [verified — binary symbols `inferActiveSpeaker`, `active speaker container/indicator`, `lastAxActiveSpeakerSet`, `transcriptspeakerannotator`]
- Our **demo-app reads a labeled text attribute** (`isSpeakingMarker`). That works
  for **Zoom web** (it writes `"…, active speaker"` into an `AXDescription`) but **not
  for Meet/Teams** (no such label → fallback to anonymous `"Someone"`). [verified — demo-app code]
- The gap is an **approach gap, not an access gap**. Whether Meet exposes a
  *structural* active-speaker signal in AX (tile geometry/order/class/indicator-child)
  is **unresolved** — our prior test used a flat token metric that is structurally
  blind, and the live scanner flattens too. See §4.

---

## 1. Recall Desktop SDK — what you can extract

### 1.1 Architecture [verified]
The npm package is a thin Node shim (`index.js`) that `spawn()`s the native
`desktop_sdk_macos_exe` and talks over a newline-delimited JSON stdio protocol
(messages prefixed `recall_ai_command|`). Events flow up; commands flow down.
Native binary links **ScreenCaptureKit, CoreAudio, AVFoundation, ApplicationServices
(Accessibility), JavaScriptCore**, + bundled GStreamer. The 75 MB Rust core
(`liblibbot_desktop_rs.dylib`) does media pipeline + diarization + egress.

### 1.2 Public JS API — events (subscribe via `addEventListener`)
| Event | Payload | Fires |
|---|---|---|
| `meeting-detected` / `meeting-updated` / `meeting-closed` | `{ window:{id,title?,url?,platform?} }` | meeting found / metadata changes / ends |
| `recording-started` / `recording-ended` | `{ window }` | capture begins/stops |
| `media-capture-status` | `{ window, type:'video'\|'audio', capturing }` | our capture state |
| `participant-capture-status` | `{ window, type:'video'\|'audio'\|'screenshare', capturing }` | participant capture state |
| `realtime-event` | `{ window, event:string, data:any }` | live transcript/participant data (see 1.5) |
| `permissions-granted` / `permission-status` | `{}` / `{permission,status}` | permission flow |
| `network-status` | `{ status:'reconnected'\|'disconnected' }` | connectivity (may auto-stop) |
| `error` / `shutdown` | `{type,message,window?}` / `{code,signal}` | failures / process exit |
| `upload-progress`, `sdk-state-change` | — | **deprecated** in 2.x |

### 1.3 Public JS API — commands
`init(config)`, `startRecording({windowId, uploadToken})`, `stopRecording`,
`pauseRecording`, `resumeRecording`, `prepareDesktopAudioRecording()` (→ `Promise<string>`;
the in-person/adhoc audio path), `requestPermission(p)`, `dumpAXTree(procName)` /
`dumpAllApplications()` (named exports only — **raw AX tree dump**, useful for R&D),
`shutdown()`. `uploadRecording` is a deprecated no-op.

Config: `RecallAiSdkConfig { apiUrl|api_url, acquirePermissionsOnStartup: Permission[], restartOnError, dev, [k]:any }`.
`Permission = 'accessibility' | 'screen-capture' | 'microphone' | 'system-audio' | 'full-disk-access'`.
Env: any `RECALL_*` var is forwarded to the native process; `RECALLAI_DESKTOP_SDK_DEV=1` enables verbose native logs.

### 1.4 Post-call artifacts (`media_shortcuts` on the Recording, once `status:done`)
| Shortcut | Contents |
|---|---|
| `video_mixed` | combined MP4 (`video_separate_mp4` for per-participant — opt in) |
| `audio_mixed` | combined audio (`audio_separate_raw` for per-participant — opt in) |
| `transcript` | diarized JSON: `[{participant, language_code, words:[{text,start/end_timestamp{relative,absolute}}]}]` + `provider_data_download_url` |
| `participant_events` | 3 sub-URLs: `participant_events_download_url`, `speaker_timeline_download_url`, `participants_download_url` |
| `meeting_metadata` | `{title}` (Zoom+Meet), `zoom_meeting_uuid` (Zoom). Teams/Webex: none |

- **participant_events** actions [verified docs + binary]: `join, leave, update, speech_on, speech_off, webcam_on/off, screenshare_on/off, chat_message`. (`data:{text,to}` only on `chat_message`.)
- **speaker_timeline**: `[{participant, start_timestamp, end_timestamp}]` — who spoke when.
- **participants**: `[{id, name, is_host, platform, extra_data, email}]`. `id` is per-meeting (not stable).

### 1.5 Real-time vs post-call
Configure `recording_config.realtime_endpoints` (types `webhook`, `websocket`,
**`desktop_sdk_callback`** = delivered locally via the `realtime-event` SDK event).
- **Live:** `transcript.partial_data` (interim), `transcript.data` (final), `participant_events.*`, raw media (`audio_mixed_raw` base64 PCM 16kHz, `video_separate_png` ~2fps). Live payload is **doubly nested** (`data.data.words`), words carry only `relative` ts.
- **Only post-`done`:** `video_mixed`/`audio_mixed` files, full diarized `transcript`, `speaker_timeline`, `participants`, `meeting_metadata`.

### 1.6 Transcription providers (`recording_config.transcript.provider`)
| Provider | key | 3rd-party key | notes |
|---|---|---|---|
| Recall native | `recallai_streaming` | no | `prioritize_low_latency` (1–3s, **English only**) / `prioritize_accuracy` (40+ langs, delayed mins) |
| AssemblyAI | `assembly_ai_v3_streaming` | yes | ⚠️ use **v3**; `assembly_ai_streaming` fails on DSDK |
| Deepgram | `deepgram_streaming` | yes (Member+ role) | `nova-3`, `language:"multi"` |
| Speechmatics | `speechmatics_streaming` | yes | `language` mandatory, no detection in streaming |

### 1.7 Per-platform identity (extra_data) [verified docs]
| Platform | stable ID |
|---|---|
| Zoom | `conf_user_id` ✅ (cross-meeting); `user_guid` not stable |
| Teams | `user_id` ✅ + `tenant_id`, `role` |
| Webex | `webex_id` ✅ |
| **Google Meet** | ❌ **none** — `extra_data` null. Key on `name`/`email` |

### 1.8 Native-binary capabilities NOT in the public API [verified — symbols; mostly internal]
- **Per-platform scrapers**: `GoogleMeetScraper`, `GoogleMeetSafariScraper`, `ZoomScraper`, `TeamsScraper` (+ `ZoomScraperScripts` JS run via JavaScriptCore over the AX tree). Scraping rules are **versioned, fetched from S3** (`recallai-desktop-sdk-scraping.s3…/manifest.json`) — that's how they survive Meet's ~6-week DOM churn.
- **Active speaker (Meet)**: `active speaker container`, `active speaker indicator`, `inferActiveSpeakerCallCount`, `lastAxActiveSpeakerSet`, `ActiveSpeakerDetectionMode` + audio-VAD path (`AxVad`, `AudioLevelMessage{rms}`).
- **Per-participant attributes**: `is_host` ("is potentially host"), mute, camera, screenshare, `platform`, `email`.
- **Chat**: inbound `chat_message`; outbound `ChatSender` (drives the chat UI via AX) — internal.
- **Identity/URL readers**: Chrome/Meet **IndexedDB (LevelDB)**, Teams IndexedDB, Safari `SafariTabs.db` — needs **Full Disk Access**.
- **Mic/camera in-use** via macOS Control Center `sensor-indicators` unified-log predicate (no AX needed).
- **On-device diarization**: WebRTC VAD + **ONNX speaker embeddings** (`transcriptspeakerannotator`, auto-diarization *learning*).
- **Bot-control FFI** (bot product, not DSDK): `admit_participant`, `kick_participant`, `pin_participant`, `toggle_camera/microphone/screenshare`, `output_video_frame`.
- **Diagnostics**: `dumpAXTree`/`dumpAllApplications` → `ax_tree` + `window_screenshots` + `diag_*` fields.

### 1.9 What this does NOT give you (Meet) [verified]
No stable per-participant ID; active-speaker for Meet is **inferred** (marginal, high-maintenance), not a clean read; in-person/adhoc mode yields **no names and no speaker timeline** (mic="Host", others="Guest", anonymous machine-diarization labels) — proving names come from the **platform UI**, not audio.

### 1.10 Reverse-engineering deep dive (from the shipping binary)
All items below are **[verified — literal symbols/strings]** in the unstripped binaries
(exe ≈48k symbols, libbot ≈170k, ui_recorder ≈7k). The *logic* that combines them is
compiled and **[inferred]**. Reproduce with the `strings` commands in §5.

**(a) Class map — who does what**
- `desktop_sdk_macos_exe` (Swift/ObjC): `GoogleMeetScraper`, `GoogleMeetSafariScraper`,
  `GoogleMeetChromiumRecorder`, `GoogleMeetMeetingRecorder`, `GoogleMeetProbe`,
  `ZoomScraper`, `TeamsScraper` (+ `*TopLevelScraper`), `JSUIScrapingService` /
  `UiScrapingService`, `ZoomScraperScripts`, `ChatSender`, `MeetingAppMediaCapturer`,
  `MicLogStreamMonitor`.
- `liblibbot_desktop_rs.dylib` (Rust, 75MB): event engine, GStreamer pipeline,
  diarization, egress.
- `libui_recorder.dylib` (Rust): AX-tree dumper + screenshots + IndexedDB readers
  (exports `ui_recorder_dump_for_pid`, `ui_recorder_dump_for_pid_diagnostics`).

**(b) `GoogleMeetScraper` methods** — `scrapeMeetingParticipants`, `scrapeLocalUserName`
(sidepanel/tile/first-participant strategies), `scrapeMeetingTitle`,
`hasActiveCallControls`, `active speaker container`, `active speaker indicator`,
`isActiveSpeaker`, `"Active speaker changed to "`, `lastAxActiveSpeakerSet`,
`inferActiveSpeakerCallCount`, `isNotMuted - mic button/descriptor`, `is muted`,
`is potentially host`, `is screensharing locally`, `remote screen share`, `video renders`.

**(c) ⭐ AX attributes Recall actually reads** (`libui_recorder`): `AXRole`, `AXSubrole`,
`AXTitle`, `AXDescription`, `AXValue`, **`AXDOMClassList`, `AXDOMIdentifier`,
`AXWindowNumber`, `AXFrame`, `AXPosition`, `AXSize`, `AXChildren`, `AXDocument`**;
events via **`AXObserver` + `kAXTitleChangedNotification`**; web area located by
`"AXURL search for meet.google.com"` / `"AXDocument search for meet.google.com"`.
→ **ACTIONABLE for demo-app:** this is exactly the attribute set the per-tile experiment
(§4) should read. Recall reads **geometry (`AXFrame`/`AXPosition`/`AXSize`) + `AXDOMClassList`
per node** and uses `AXObserver` (not brute-force polling). It does **not** depend on a
labeled "speaking" attribute for Meet — confirming §2.3/§4.

**(d) Methodology — AX snapshots at state transitions** — Recall writes
`google_meet_ax_tree_{start,mic_on,close}.json` (+ `safari_`/`teams_`/`zoom_` variants),
logs `"Recording Google Meet UI tree to"`, and snapshots the tree on mic-on
(`MicLogStreamMonitor`, `"Mic turned on, recording ... UI tree"`). → This is the same
"dump AX at transitions" methodology we recommend for the experiment.

**(e) Scraping rules = versioned JS run over the AX tree** — `JSUIScrapingService` runs
JS via **JavaScriptCore** (`evaluateScript:`) with `root` = the AX-tree root;
`ZoomScraperScripts.scrapeJS(root)`; rules fetched from an S3 `manifest.json`
(`recallai-desktop-sdk-scraping.s3.us-east-1.amazonaws.com`, `"Loading scraping logic
manifest from"`, `"Loading scraping JS logic for Zoom Version …"`). This is **not** a
browser extension and **not** page injection — JS evaluates the captured AX node tree.
It's why they survive Meet's ~6-week DOM churn (and the recurring maintenance cost).

**(f) Active-speaker fusion** — AX path (`lastAxActiveSpeakerSet`) **+** audio VAD
(`AxVad`, `voice_activity_detector`, `webrtc-vad`, `AudioLevelMessage{rms}`,
`DSDK_VAD_IMPROVEMENT`) **+** mode switches (`ActiveSpeakerDetectionMode`,
`ToggleManualActiveSpeakerDetection`, `SetActiveSpeakerDetectionMode`,
`exclude_null_active_speaker`). Confirms *infer-by-fusion* with manual/auto modes.

**(g) Full internal event enum** (`RealtimeEventData`, beyond the 12 public actions):
`ParticipantEnriched`, `SelfParticipantUpdate`, `InboundParticipantInWaitingRoom`,
`ParticipantAudio/Video/Screen On/Off`, `ActiveSpeakerChange`, `ActiveSpeakerSetChangeset`,
`FarStreamActiveChanged`, `BreakoutRoomOpened/Closed/Entered` (+ `ParticipantJoin/Leave`),
`CaptionData`, `RecordingPermissionRequested/Allowed/Denied`, `PinParticipant`,
`ParticipantEventSynced`. (Internal; some surface via `realtime-event`.)

**(h) Participant model + per-platform `extra_data`** —
`Participant{id,name,is_host,platform,extra_data,email}`,
`ParticipantPlatform{mobile_app,desktop,dial_in,unknown}`. Variants:
`ZoomData{conf_user_id,user_guid,guest,os,audio}`,
`MicrosoftTeamsData{role,meeting_role,participant_type,user_id,tenant_id,client_version}`,
**`GoogleMeetData{static_participant_id}`** ← a Meet id field *exists in the binary*
even though the public API/docs report none for Meet (likely unpopulated/unreliable —
worth probing), `WebexData{webex_id}`, `SlackParticipantData{email}`.

**(i) On-device diarization stack** — GStreamer `transcriptspeakerannotator`
(`smart_annotator`/`legacy_smart_annotator`), `webrtc-vad`, **ONNX Runtime + CoreML**
(generic `virtual_model.onnx`), `SpeakerTransition` (8-field), **auto-diarization with
LEARNING** (`auto-diarization-enabled`/`-learning`, `"Learning: machine-diarized speaker"`),
cosine clustering. Audio: `S16LE 48k/2ch` → resampled `24k` + `16k` (16k feeds VAD/ASR).
Output formats: `audio_mixed_{mp3,raw}`, `audio_separate_{mp3,raw,speech_only_ogg}`,
`video_mixed_{mp4,flv}`, `video_separate_{mp4,png,h264}`.

**(j) Identity/URL readers (need Full Disk Access)** — Safari `SafariTabs.db` (via
`sqlite3`), Meet `IndexedDB/https_meet.google.com_0.indexeddb.leveldb`, Teams IndexedDB
regexes (`meetingJoinUrl`/`conversationUrl`/`meetingCode`/`passcode`), `ChromeSessionParser`,
browser profiles (Chrome/Brave/Arc/Dia). Mic/cam in-use also via macOS **Control Center**
unified-log predicate (`subsystem == "com.apple.controlcenter" AND category ==
"sensor-indicators"`) — no AX needed.

**(k) Egress + control-plane endpoints** — GStreamer S3 sinks (`dsdks3sink`,
`filebuffereds3sink`, `seekables3sink`, `S3Unmixed{Audio,Video}PartSink`, multipart
`data.json.zst`); realtime sinks (`rtewebsocketsink`, `rtewebhooksink`); base
`api.recall.ai/api/v2/_internal/desktop-sdk-upload/{artifact_presigned_urls,
streaming_presigned_urls, transcriber_credentials, status, streaming_heartbeat,
customer_visible_log, debug_file_presigned_url}`; CloudWatch log group `from-bots`;
Sentry + Datadog telemetry baked in.

**(l) Hidden bot-control FFI** (the *bot* product, not the DSDK form factor):
`join_call`, `leave_call`, `send_chat_message`, `admit_participant`, `kick_participant`,
`hold_participant`, `pin_participant`, `toggle_camera/microphone/screenshare`,
`request_recording_permission`, `output_video_frame`, `get_screenshot`,
`get_dom_snapshot`, `configure_platform`.

**What we could NOT determine [inferred/unknown]** — the compiled fusion weighting
(AX vs VAD) that decides final `speech_on/off`; the speaker-embedding model architecture
(shipped as generic `virtual_model.onnx`); the exact S3 bucket/URL of the scraping
manifest (loaded at runtime); whether hand-raise/reaction/co-host are derived (no
dedicated strings → likely not first-class).

> **Single most useful takeaway for demo-app:** Recall's own AX dumper reads
> `AXFrame`/`AXPosition`/`AXSize`/`AXDOMClassList`/`AXChildren` per node and snapshots the
> tree at mic-on. That is direct evidence the per-tile *structural* signal (geometry +
> class + subtree) is what their Meet inference keys on — so build the demo-app
> experiment (§4) to read exactly those attributes via `AXObserver`, not a labeled string.

---

## 2. demo-app — what OUR detector extracts

Native macOS AX scraper. Entry: `Sources/MeetSpeakerDetector`. Shared, unit-tested
parsing: `Sources/SpeakerCore`. AX inspector: `Sources/AXDump`.

### 2.1 What it extracts [verified — code]
| Data | How | Works on |
|---|---|---|
| Participant **roster** (names) | walk AX tree, `cleanParticipantName` + `isLikelyPersonName` | Meet, Zoom, Teams (best-effort) |
| **Active speaker** | `isSpeakingMarker(combined)` — string grep for `"active speaker"`, `"is speaking"`, `", speaking"`, `"speaking,"`, `"voice level"`, `"is talking"` | **Zoom web only** |
| Local **mute state** | `classify` matches "unmute my"/"turn on microphone" etc. | Zoom, Meet |
| Page URL / platform | scraped from AX node text; `platformForURL`/`platformForBrowserTitle` | all |

### 2.2 Mechanism + key files [verified]
- `Sources/MeetSpeakerDetector/Engine/AccessibilityScanner.swift`
  - `walk(_:depth:into:)` (`:118`) recurses the AX tree into a **flat** `TreeCollector { speakers:[String], participants:[String], localUserUnmuted, url }`.
  - `classify(...)` (`:151`) reads `AXTitle`/`AXDescription`/`AXValue`, joins them, runs `isSpeakingMarker(combined)` (`:165`), extracts a name, appends to the flat lists.
- `Sources/SpeakerCore/NameParsing.swift:49` — `isSpeakingMarker` (the speaking grep).
- `Sources/SpeakerCore/PlatformDetection.swift:34` — `platformExposesSpeakerNames`: **`.zoom → true`, `.meet → false`, `.teams → false`** (comment: *"their indicator is visual/CSS only"*).
- `Sources/MeetSpeakerDetector/Engine/DetectionEngine.swift:117` — `canReadSpeakers = treeOk && platformExposesSpeakerNames(platform)`; when false (Meet/Teams) and the remote side is active, logs anonymous **`"Someone"`** (audio-only fallback).

### 2.3 Why Zoom works and Meet doesn't [verified]
Zoom web writes the active speaker into an `AXDescription` like
`"Bidheyak Thapa, Computer audio unmuted, active speaker"` → the grep matches.
Meet writes **no equivalent labeled string** → grep returns nothing →
`platformExposesSpeakerNames(.meet)=false` is hardcoded. This is **only true in the
"labeled-attribute" sense.** Recall proves a structural-inference path exists (§1.8).

### 2.4 Known limitation — structurally blind to Meet's likely signal [verified]
`walk()` flattens to deduped name lists, discarding **per-tile identity, order,
geometry (AXSize/AXPosition), and subtree shape** — exactly what an
`inferActiveSpeaker`-style detector would key on. So today the detector *cannot
measure* for a structural Meet signal even if one exists. No per-tile model exists
in `Sources` yet (only SwiftUI `GeometryReader` in views).

### 2.5 Tooling already present
`swift run AXDump <meet|zoom|teams>` dumps the AX subtree; `--attrs` dumps **every
attribute name/value per node** (`Sources/AXDump/main.swift:16,92`). This is the
inspection primitive for the experiment in §4. Note: `--attrs` surfaces *whatever*
attributes exist — it does not guarantee `AXDOMClassList`/`AXSelected` are present;
that's the empirical question.

---

## 3. Recall vs demo-app — side by side
| | Recall DSDK | demo-app |
|---|---|---|
| Capture | AX tree + ScreenCaptureKit + CoreAudio tap | AX tree only (+ system mic for the host) |
| Roster names | yes (all platforms) | yes (best-effort) |
| Zoom active speaker | yes (audio VAD + AX) | **yes** (labeled `AXDescription`) |
| Meet active speaker | **yes — inferred** (structure + VAD + remote rules) | **no** (falls back to `"Someone"`) |
| Speaker timeline | yes (`speaker_timeline` artifact) | partial (Zoom only, live) |
| Transcript/diarization | yes (on-device VAD+ONNX + cloud providers) | none |
| Stable identity | Zoom/Teams yes; Meet no | no (names only) |
| Maintenance | high (remote-config scraping rules) | low today (stable labels), high if Meet-structural added |

---

## 4. The open question + the decisive experiment

**Question:** does today's Google Meet expose a *structural* active-speaker signal in
the macOS AX tree that we can detect with a **per-tile** diff? (Recall's symbols say
they infer one; our own `in-browser-meeting-ax.md` research found Meet's indicator is
CSS-only and *not* mirrored to AX as role/state/aria-live. **Genuinely unresolved** —
prior tests measured the wrong thing.)

**Why prior "nothing toggled" tests don't settle it:** a flat unioned token set (and
the live `walk()`) are blind to reordering, geometry, focus-migration, and a per-tile
indicator child — a shared class that merely *migrates* tile A→B leaves the global set
identical.

**The experiment to run (build a `--watch`-style per-tile structural diagnostic):**
1. In **gallery view**, 2–3 people on video, scripted turns (A talks ~8s, B talks ~8s — log ground truth).
2. Locate participant tiles in the `AXWebArea`. Per tile, track over time: **name, DOM order index, AXSize/AXPosition, descendant count, the tile's own class set, a role-shape signature, selected/focused descendant, per-tile mic node** (mute ≠ speaking — narrow only).
3. Also capture a raw `swift run AXDump meet --attrs` snapshot at each A→B transition and eyeball it (don't trust a single automated metric).
4. **If any per-tile feature moves in lockstep with speech →** that's the signal; build `MeetSpeakerTracker` on it, fuse audio VAD for precise on/off timing, and ship the selectors as **remote config** (Meet's DOM rotates ~6 wks). **If all features stay flat across a clean talk/silence cycle →** it genuinely isn't in AX on this build; the timeline must lean on audio diarization.

Either outcome is a real answer instead of an inherited assumption.

---

## 5. Re-derivation playbook (prove it yourself)

```bash
# --- Recall SDK: confirm AX-based, no extension/CDP ---
SDK=/Users/bibekthapa/projects/work/recall-demos/dsdk-tutorial/node_modules/@recallai/desktop-sdk
strings -a "$SDK/desktop_sdk_macos_exe" | grep -iE 'GoogleMeetScraper|active speaker (container|indicator)|inferActiveSpeaker|AXWebArea'
strings -a "$SDK/Frameworks/liblibbot_desktop_rs.dylib" | grep -iE 'transcriptspeakerannotator|ParticipantEventAction|speech_on|recallai_streaming'
# Deep dive — AX attrs Recall reads + per-platform extra_data + versioned scraping rules:
strings -a "$SDK/Frameworks/libui_recorder.dylib" | grep -iE 'AXDOMClassList|AXFrame|AXPosition|AXSize|AXChildren|ui_recorder_dump'
strings -a "$SDK/desktop_sdk_macos_exe" | grep -iE 'GoogleMeetData|static_participant_id|scraping logic manifest|google_meet_ax_tree'
strings -a "$SDK/Frameworks/liblibbot_desktop_rs.dylib" | grep -iE 'conf_user_id|user_id|auto-diarization-(enabled|learning)|virtual_model'
# expect MATCHES above; expect NOTHING below (no CDP / no injected extension):
strings -a "$SDK/desktop_sdk_macos_exe" | grep -iE 'remote-debugging|:9222|chrome.debugger|--load-extension|content_script' || echo "none → not CDP/extension"
# Public API surface:
cat "$SDK/index.d.ts"        # events, commands, config, Permission union

# --- demo-app: confirm the labeled-attribute approach + the flat-walk limit ---
cd /Users/bibekthapa/projects/work/demo-app
sed -n '49,57p' Sources/SpeakerCore/NameParsing.swift          # isSpeakingMarker patterns
sed -n '30,40p' Sources/SpeakerCore/PlatformDetection.swift     # .meet → false
sed -n '110,182p' Sources/MeetSpeakerDetector/Engine/AccessibilityScanner.swift  # flat walk + classify
swift run SpeakerCoreSelfTest                                   # asserts meet=false, zoom=true, marker logic

# --- inspect live AX (needs a live call + Accessibility permission) ---
swift run AXDump meet --attrs   # dump every attribute per node — look for any per-tile speaking signal

# --- §4 experiment: per-tile STRUCTURAL watch (the decisive instrument) ---
# Models each Meet tile and reports which per-tile features (geometry / DOM order /
# AXDOMClassList / subtree role-shape / focus / mic) actually move during a call.
# Run on a scripted gallery call (A talks ~8s, then B) and compare the change
# counts to your ground truth. Writes timeline.jsonl + raw subtree dumps at transitions.
swift run MeetProbe 45 250      # durationSeconds intervalMs
```

Official docs (authoritative for the data model): docs.recall.ai →
`desktop-sdk`, `desktop-recording-sdk-event-types`, `media-shortcuts`,
`download-schemas`, `dsdk-realtime-transcription`, `speaker-timeline`, `diarization`,
`identify-meeting-participants-uniquely`, `meeting-metadata`, `real-time-event-payloads`.

---

## 6. Confidence / provenance
- **[verified]** items: read directly from the shipping binary strings, the installed
  `index.d.ts`/`index.js`, official docs, or demo-app source on 2026-06-20.
- **[inferred]** the *exact* internal fusion logic for Meet active-speaker (AX vs VAD
  weighting) is compiled and not string-inspectable; and whether Meet's per-tile
  structural signal is present in AX **today** is unmeasured (§4).
- If a claim here drives a decision, re-run §5 — binaries and Meet's DOM change.
