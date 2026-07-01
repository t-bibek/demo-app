# Architecture & Code Flow

How **meeting-speaker-logger** detects who is speaking in Google Meet / Zoom / Microsoft Teams on Windows, and how a detection travels from the meeting window to your screen.

> Companion to the [README](../README.md) (setup, verification, limitations). This document covers internals: folder structure, the detection pipeline, every event type, and how to repair detection when a platform changes its UI.

---

## 1. The big picture

The app is three processes connected by two streams:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  uia-engine.ps1  (PowerShell 5.1 hosting C#, compiled in-process)       │
│                                                                          │
│   every 500 ms:                                                          │
│   ① enumerate top-level windows → classify meet/zoom/teams               │
│   ② sample WASAPI audio meters  → who-ish is speaking RIGHT NOW          │
│   ③ scan each meeting window's UIA accessibility tree → WHO by name      │
│   ④ combine, mute-gate, aggregate → emit pulses                          │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │ stdout: NDJSON, one JSON event per line
                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Electron MAIN process  (src/main)                                       │
│                                                                          │
│   engine.ts  — spawns/supervises the engine, parses NDJSON               │
│   main.ts    — feeds pulses into the SessionTracker,                     │
│                console-logs ">> X started speaking" / "[] X spoke 12s",  │
│                retains state, forwards events to the renderer            │
│   sessionTracker.ts — turns per-poll pulses into sessions with durations │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │ IPC channel "app-event" (via preload bridge)
                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Electron RENDERER  (src/renderer, React)                                │
│                                                                          │
│   platform chips · "Now speaking" live cards · session log · talk totals │
└─────────────────────────────────────────────────────────────────────────┘
```

**Design philosophy** (modeled on Recall.ai's desktop SDK, which "uses the operating system's accessibility APIs to … detect … who's speaking"):

- **Audio answers *when*** — WASAPI per-application meters work with windows in the background, need no captions and no meeting-settings changes.
- **Accessibility (UIA) answers *who*** — meeting UIs render participant names and states; the accessibility tree exposes them as text.
- **Never trust one signal alone** — audio can't name people; the UI can't tell if sound is actually flowing (Zoom's "Active speaker" badge lingers after speech). Each gates the other.
- **Degrade honestly** — if a name can't be read, log the time anyway (`Someone` / `You`); if the local mute state can't be *confirmed unmuted*, never log the local user (apps keep the mic stream open while app-muted, so audio alone can't tell speaking from muted-speaking).

No server backend. Nothing leaves the machine.

---

## 2. Folder structure

```
meeting-speaker-logger/
├── package.json              npm scripts (start/simulate/test/dump/…) + deps
├── tsconfig.main.json        TS config: main + preload + shared (CommonJS → out/)
├── tsconfig.renderer.json    TS config: renderer (type-check only; Vite bundles)
├── vite.config.ts            Vite (renderer build) + Vitest (unit tests) config
├── README.md                 Setup, verification guide, limitations
├── docs/
│   └── ARCHITECTURE.md       ← this file
│
├── engine/
│   └── uia-engine.ps1        THE DETECTION ENGINE. PowerShell wrapper + ~2.2k
│                             lines of C# compiled in-process via Add-Type
│                             (no SDK needed — uses Windows' built-in .NET).
│                             Contains: window discovery, WASAPI audio
│                             metering, all per-platform detectors, the
│                             fallback aggregator, and four extra modes
│                             (-Simulate, -Dump, -SelfTest, -Once).
│
├── src/
│   ├── shared/               Code used by BOTH main and renderer
│   │   ├── types.ts          Every event type (engine + tracker + IPC),
│   │   │                     platform labels, formatDuration/formatClock
│   │   ├── sessionTracker.ts SessionTracker: pulses → sessions (state machine)
│   │   └── ndjson.ts         Incremental NDJSON stream parser
│   │
│   ├── main/                 Electron main process
│   │   ├── main.ts           App entry: wires engine → tracker → renderer,
│   │   │                     console logging, state retention + replay
│   │   └── engine.ts         UiaEngine: spawn powershell.exe, supervise,
│   │                         restart with budget, surface failures
│   │
│   ├── preload/
│   │   └── preload.ts        contextBridge: exposes window.speakerLog.onEvent
│   │
│   └── renderer/             React UI
│       ├── index.html        Entry HTML
│       ├── main.tsx          React bootstrap
│       ├── App.tsx           The whole UI (chips, cards, log, totals)
│       ├── styles.css        Styling
│       └── global.d.ts       Types window.speakerLog
│
├── tests/                    Vitest unit tests (19)
│   ├── sessionTracker.test.ts  session state machine
│   ├── ndjson.test.ts          stream parsing edge cases
│   └── format.test.ts          duration formatting
│
├── logs/                     Created by `npm run dump`: uia-dump-*.ndjson
│                             (accessibility-tree snapshots for tuning)
└── out/                      Build output (tsc → out/main, out/preload;
                              Vite → out/renderer). electron loads out/.
```

The engine also ships **93 self-tests** (`npm run engine:selftest`) inside `uia-engine.ps1` — fixture tests for every classifier and parser, many built from *exact strings captured from live meetings* via dump mode.

---

## 3. The engine: one poll tick, end to end

`Engine.Run()` in [engine/uia-engine.ps1](../engine/uia-engine.ps1) loops every `PollMs` (500 ms). Each tick:

### 3.1 Window discovery → `FindTopWindows()`

One cached UIA query lists all top-level windows (title, class, process id). Each is classified by `ClassifyWindow(title, processName, className)`:

| Result | Rule (in order) |
|---|---|
| `zoom` (desktop) | process `zoom*` + window class `ZPContentViewWndClass` or title contains "Zoom Meeting"/"Zoom Webinar" |
| `teams` (desktop) | process `ms-teams` |
| `teams` (web) | browser process + title contains **"Microsoft Teams"** — checked **before** Meet patterns, because Teams' web meeting tab is titled *"Meet App \| … \| Microsoft Teams"* and would otherwise be claimed by Meet |
| `meet` | browser + "Google Meet" in title, or title starts `Meet`, or meeting-code pattern `xxx-xxxx-xxx` + "Meet" |
| `zoom` (web) | browser + "Zoom Meeting/Webinar/Workplace" or "… - Zoom" titles |
| (side-channels) | Zoom's `zPlistWndClass` (popped-out participants) and `zBubbleBaseClass` (alert bubbles) are collected separately |

Per-window state (caption baselines, document handles, roster memory) is keyed by `platform#hwnd` and pruned when windows disappear (`PruneWindowState`).

### 3.2 Audio metering → `SampleAudio()`

Minimal WASAPI COM interop (NAudio-style interface declarations). Two independent per-application readings:

- **`RenderPeaks[proc]`** — output peak of each app's playback session. `zoom.exe` playing sound ⇒ a **remote** participant is speaking. Works minimized/background.
- **`CapturePeaks[proc]`** — microphone level **that specific app is capturing**. `chrome` capture peak high ⇒ the local user is speaking **into Chrome's meeting**. Per-app capture is what makes self-detection independent of which mic is the system default, and immune to remote audio.

Each crossing of a threshold (`RemoteAudioThreshold` 0.02 / `MicAudioThreshold` 0.04) opens an **800 ms hangover window** (`Bump`/`ActiveWithin`) so the natural gaps between words don't fragment one utterance into many sessions. Audio devices are re-acquired every ~60 s (default-device changes) and any COM failure degrades gracefully to UI-only signals.

### 3.3 Accessibility scan → `ScanMeetingWindow()`

- **Zoom desktop**: scan the window subtree directly (its whole tree is only ~25 nodes).
- **Browser/WebView2 windows** (Meet, Zoom web, Teams): find the web `Document` element and scan only that subtree — far smaller than the window, and excludes browser chrome. The *first* UIA query against a Chromium window is itself what switches Chromium's accessibility on (tiny tree on first contact, full tree next poll).

`ScanNodes` does a single bulk `FindAll(Descendants)` under a `CacheRequest` (Name, ClassName, AutomationId, ControlType, `AutomationElementMode.None`) — one cross-process round-trip, ~100 ms for a populated web tree. The result is a flat `List<UiNode>` that every detector below works on. Chromium maps HTML `class` → UIA ClassName and HTML `id` → AutomationId, which is what makes web detection possible; `data-*` attributes are **not** exposed.

### 3.4 Per-platform detection → `Detect(platform, nodes, stateKey, remoteActive, selfActive)`

Produces a `Detection`: `Speakers` (talking *right now*, by name), `Participants`, `SelfName`, `MicState` (Unknown/Muted/Unmuted), `RemoteNames`.

**Zoom desktop** — richest source. Video tile accessible names carry everything (verified live on Zoom 7.x):

```
"Bidheyak Thapa(Host, me), Computer audio unmuted,Video off, Active speaker"
"Video content Sabitri, Computer audio unmuted,Video off"
```

`ParseZoomVideoTiles` regex-parses name, `(me)` self marker, mute state, and the **", Active speaker"** badge. The badge *lingers on the last speaker during silence*, so it only becomes a Speaker when the matching audio stream is live: **self tile gated by mic-capture, remote tile by playback**. The participants-list pane (`ParseZoomRoster`, battle-tested row grammar) and popped-out panel add roster names. Works fully in the background.

**Zoom web** — thin tree, no speaking badge. `ParseZoomWeb` reads: tile names (`video-avatar__avatar-img` class **plus** plain text leaves in the tile region after the footer controls — camera-on tiles have no class), self mute from the footer button (`"unmute my microphone"` present ⇒ muted), participant count from the participants button (`",2 particpants"` — Zoom's own typo). Self-identification uses the title-host heuristic: *"NAME's Zoom Meeting"* ⇒ NAME is self if present in the roster.

**Teams (desktop & web)** — gated by call markers first (`hangup-button` AutomationId / Leave button), so Teams **chat** windows can never produce phantom speakers. Then `ParseTeamsTiles` parses two comma-grammars (verified live):

```
"Myself video, BIDHEYAK THAPA, Unmuted, Has context menu"   ← self tile
"Test Unverified, Context menu is available"                 ← remote, UNMUTED (no mute token!)
"Test Unverified, muted, Context menu is available"          ← remote, muted
```

Self marker = leading "Myself"; name = token before the mute token (or first token); per-tile mute state feeds `MicState`. The `vdi-frame-occlusion` ring class is checked as a speaking indicator (`DetectTeamsTileSpeakers`); captions rows (`fui-ChatMessageCompact` author+text pairs) are a bonus signal when enabled.

**Google Meet** — gated by call markers ("Leave call", mic/caption buttons). `DetectMeetMicState` reads the mic button (*"Turn off microphone"* = currently ON). `ParseMeetRoster` collects names from tile containers (`oZRSLe` groups) and the People list; self = the one roster member without a *"Mute X's microphone"* host button. Speaking names come from tile speaking-classes (`Oaajhc/HX2H7/wEsLMd/OgVli` — Vexa's list) and caption rows when CC is on. **Constraint:** Chromium drops a *background tab's* accessibility tree, so Meet names need the meeting tab active (window can be behind others).

Caption extraction (both Meet and Teams) is **change-gated** via `CaptionSpeakers`: the newest caption block's author is "speaking" only when its text changed since the last poll; the first sighting just sets a baseline so stale captions never produce a phantom on engine start. The generic *"X is speaking"* label detector runs **only on Zoom** (on Meet/Teams those words can occur inside caption/chat text and would phantom-pulse).

All names pass hygiene: `CleanName` strips `(You)`/`(Host, me)`-style suffixes; `IsLikelyPersonName` rejects UI badges (`HOST`), sentences, chat lines — a bug class even Recall.ai shipped fixes for.

### 3.5 Sticky roster + per-platform fallback aggregation

Per `platform#hwnd`, a `RosterMem` remembers the resolved self-name and participants — a momentarily thin tree (panel redraw, brief focus loss) can no longer flip a named speaker back to "You"/"Someone".

Each window's outcome becomes a `WinResult`; then **fallbacks are aggregated per platform** (not per window — the same meeting joined from two browsers shares one physical mic and would double-log):

- **Self**: if any window of the platform has mic-capture active **and** UI-confirmed `Unmuted` (and the self wasn't already a named Speaker), emit **one** pulse — preferring the window that knows the real name; else `You`. *Unknown or Muted mic state ⇒ nothing* — the no-false-positives guarantee.
- **Remote**: if no window named a speaker and playback is active, emit **one** pulse — the single known remote's name in a 1:1, else `Someone`.

### 3.6 Emission

`EmitPulse` writes one NDJSON line per detection with speakers/participants/source/title/timestamp. A `windows` snapshot (title, nodeCount, `treeOk`, audioPeak) is emitted on change and every ~5 s. `status` lines carry diagnostics — including the one-time hint when a browser meeting window's tree stays empty (names unavailable; audio still works) with concrete remedies.

---

## 4. Electron main: supervision, sessions, retention

### 4.1 `engine.ts` — process supervision

Spawns `powershell.exe` (absolute path under `%SystemRoot%` — PATH can be stripped) with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File engine/uia-engine.ps1`. Robustness rules learned the hard way:

- All cleanup/restart logic hangs on **`close`**, not `exit` — spawn failures emit `error`+`close` but never `exit`, and `close` also guarantees stdout is fully drained.
- Crash budget: 5 restarts (2 s apart). A child that survived 60 s resets the budget (sporadic crashes hours apart must not exhaust it). Exhaustion emits a loud terminal status — never silent death.
- stderr is forwarded as error statuses; the Group-Policy "running scripts is disabled" message gets a targeted, actionable status.

### 4.2 `sessionTracker.ts` — pulses → sessions

A deterministic state machine (time injected, fully unit-tested):

```
pulse(platform, name, ts):  no session for platform::name → open + emit speaker-start
                            session exists               → refresh lastSeen
update(now), every 500 ms:  now - lastSeen > endSilenceMs(1800) → close + emit speaker-end
                            else                                → emit speaker-tick (live timer)
duration = lastSeen - start + pulseWidthMs(300)
```

The engine pulses every poll while audio is active and already applies its own 800 ms hangover, so 1800 ms of true silence ends a turn promptly without splitting continuous speech.

### 4.3 `main.ts` — wiring, logging, retention

- Engine `pulse` → `tracker.pulse()` per speaker; `windows`/`status` → renderer + console.
- Tracker events → console (`>> [Zoom] Name started speaking`, `[] [Zoom] Name spoke for 12.3s …`) and renderer.
- **Retention + replay**: main keeps the last 500 completed sessions, last 8 statuses, last windows snapshot. On every renderer load (`did-finish-load` — including Ctrl+R) the state is replayed, so a reload can't wipe the log. Events fired before the page finished loading aren't lost either.
- Engine exit ⇒ `tracker.endAll()` (open sessions get closed, nothing dangles) + an empty windows snapshot (chips can't show a stale "● live").
- `before-quit` flushes open sessions so the meeting's last utterance is logged.

### 4.4 `preload.ts` — the only main↔renderer surface

`contextBridge` exposes exactly one API: `window.speakerLog.onEvent(cb)` subscribing to the `app-event` IPC channel. Context isolation on, node integration off.

---

## 5. Renderer: how it shows

[App.tsx](../src/renderer/App.tsx) holds four pieces of state, all fed by `onEvent`:

| State | Updated by | Rendered as |
|---|---|---|
| `windows` | `windows` snapshots | Header chips: `● live` / `○` none / `⚠ names n/a` (browser tree empty → audio-only) / `♪` when that app's audio is flowing |
| `active` (Map) | `speaker-start` creates, `speaker-tick` updates (and re-creates after a reload), `speaker-end` removes | "Now speaking" cards with a live duration timer |
| `sessions` | `speaker-end` prepends (cap 500) | The speaking log table (time, platform, speaker, duration) |
| `statuses` | `status` (cap 8) | Collapsible "Engine status" footer; auto-opens on warnings |

`totals` is derived per render: per-name sum of completed sessions + currently-running durations — the talk-time leaderboard. Start/end events are also `console.log`-ged in DevTools, mirroring the terminal.

---

## 6. Event reference

### Engine → main (NDJSON on stdout)

```jsonc
{"type":"pulse","platform":"zoom","speakers":["Bidheyak Thapa"],
 "participants":["Bidheyak Thapa","Sabitri"],"windowTitle":"Zoom Meeting",
 "source":"zoom-tiles","ts":1781190083885}

{"type":"windows","windows":[{"platform":"teams","title":"…","nodeCount":83,
 "treeOk":true,"audioPeak":0.031}],"ts":…}

{"type":"status","level":"info|warn|error","message":"…","ts":…}
```

`source` values tell you which detector fired: `zoom-tiles`, `zoom-web`, `zoom-roster-panel`, `zoom-bubble`, `teams-tiles`, `teams-captions`, `meet-tiles`, `meet-captions`, `mic-audio` (self by mic), `audio-roster` (remote named via 1-remote rule), `audio` (remote, unnamed → "Someone"), `simulate`.

### Main → renderer (IPC `app-event`)

`speaker-start {platform,name,startTs}` · `speaker-tick {…,durationMs}` · `speaker-end {…,endTs,durationMs}` · plus forwarded `windows` and `status`.

---

## 7. Detection capability matrix

| Capability | Zoom desktop | Zoom web | Teams (desktop/web) | Google Meet |
|---|---|---|---|---|
| Detected in background | ✅ | tab must be active for names; audio always | desktop ✅ / web: tab active for names | tab active for names; audio always |
| Participant names | ✅ tiles+roster | ✅ tiles/roster | ✅ tiles (both grammars) | ✅ tiles+People list |
| Who is speaking (named) | ✅ "Active speaker" badge, audio-gated | 1:1 via roster+audio | ring class when present; 1:1 via roster+audio; captions if on | tile classes; 1:1 via roster+audio; captions if on |
| Self identification | ✅ `(me)` marker | title-host heuristic | ✅ "Myself" tile | ✅ host roster heuristic |
| Local mute respected | ✅ tile state | ✅ footer button | ✅ tile/button | ✅ mic button |
| No name available | logs `Someone`/`You` with correct timing — never silent, never false-self | ← same | ← same | ← same |

---

## 8. Operating modes & scripts

| Command | What runs |
|---|---|
| `npm start` | Build (tsc + Vite) and launch Electron; engine in real mode |
| `npm run simulate` | Engine `-Simulate`: scripted synthetic speakers exercise the full pipeline with no meeting |
| `npm run engine:once` | One real poll: prints status + window snapshot, exits (quick diagnostics) |
| `npm run engine:selftest` | 93 fixture tests inside the engine (classifiers, every parser, gating) — exit 0 = pass |
| `npm run dump` | **The repair tool.** Lists every top-level window (catch misclassification), snapshots current audio peaks, writes each meeting window's full UIA tree to `logs/uia-dump-*.ndjson` |
| `npm test` | 19 Vitest unit tests (tracker, NDJSON, formatting) |
| `npm run typecheck` | tsc over main + renderer without emitting |

Engine parameters (edit spawn args in `src/main/engine.ts` or run the .ps1 directly): `-PollMs 500`, `-MaxNodes 8000`, `-RemoteAudioThreshold 0.02`, `-MicAudioThreshold 0.04`, `-ZoomProbe` (legacy Ctrl+2 prober, off by default), `-ZoomGlobalHotkey`.

---

## 9. When a platform changes its UI (and it will)

This is UI scraping — the same fragility Recall.ai lives with ("when video conferencing platforms change their UI, we must ship a change immediately"). The repair loop that built every detector in this project:

1. Reproduce: join a meeting, get into the state that fails (e.g. *remote person mid-sentence*).
2. `npm run dump` — the window list catches classification misses; the tree file shows the new node grammar.
3. Search the dump for a participant's name / caption text; note the surrounding `c` (ClassName), `a` (AutomationId), `t` (ControlType) and the accessible-name grammar.
4. Update the matching constants/parsers in `engine/uia-engine.ps1` — they're grouped and commented: `ClassifyWindow`, `ZoomTilePattern`, `ParseZoomWeb`, `ParseTeamsTiles`, `MeetSpeakingClasses`/`MeetNameClasses`, `ExtractMeetCaptionBlocks`/`ExtractTeamsCaptionBlocks`, `ZoomAlertPatterns`.
5. Add a self-test with the **exact dumped string** (the suite is full of them) and run `npm run engine:selftest`.

Hard-won platform facts worth keeping in mind are recorded inline next to each parser, including: Zoom 7.x tiles expose `", Active speaker"` (older research said Zoom exposed nothing); an *unmuted* Teams-web remote has **no** mute token; app-level mute does **not** stop the OS mic stream (hence UI-confirmed-unmute gating); Chromium drops background-*tab* accessibility but background *windows* are fine; Zoom desktop's 25-node tree is normal, not broken.

## 10. Known limitations

- **Multi-party (3+) unnamed remotes** on Meet/Teams-web/Zoom-web log as `Someone` until a speaking-indicator node for the current platform build is captured in a dump (the 1:1 case is fully named).
- **Browser audio is per-process, not per-tab** — a YouTube tab in the same browser as the meeting counts as meeting audio.
- **Dual-join testing** (same meeting in two browsers on one machine) creates echo: the second client genuinely *plays* your voice, which audio-level logic correctly-but-confusingly attributes to the remote side. Doesn't occur with one client per person.
- **English UI strings** for state grammars (mute labels, Zoom roster states); other locales need pattern additions.
- Caption-derived timing trails speech ~1 s; durations are honest estimates, not waveform truth.
