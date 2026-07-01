# Meeting Speaker Logger

Live **active-speaker logging** for **Google Meet, Zoom (desktop & web) and Microsoft Teams** on **Windows** — see who is speaking and for how long, in real time, with no server backend. Works with the meeting window **in the background**, and **does not require captions** or any meeting-settings changes.

Built with **Electron + React + TypeScript**. Modeled on [Recall.ai's](https://docs.recall.ai/docs/desktop-recording-sdk-faq) desktop-SDK approach ("*uses the operating system's accessibility APIs to ... detect ... who's speaking*"), using **Windows UI Automation** (the Windows analogue of the macOS AX API) — plus **WASAPI audio metering** for the *when*.

> **Deep dive:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — folder structure, the full detection pipeline (window discovery → audio meters → UIA scan → per-platform parsers → mute gating → fallback aggregation → sessions → UI), every event type, the capability matrix, and the dump-driven repair workflow for when platforms change their UI.

```
>> [Zoom] Bidheyak Thapa started speaking (10:14:26)
[] [Zoom] Bidheyak Thapa spoke for 12.3s (10:14:26 -> 10:14:38)
```

## How detection works (hybrid: audio + accessibility)

Two independent signals are combined every 500 ms:

1. **Audio meters (WASAPI)** — answer "*is someone speaking right now?*", per application:
   - **Playback peak** of `zoom.exe` / `ms-teams.exe` / your browser → a **remote** participant is speaking (you hear them). Works minimized or in the background, no settings needed.
   - **Mic-capture peak** of that same app → **you** are speaking *into that app*. This is measured per-application (the exact mic stream Zoom/Teams/Chrome pulls), so it is reliable regardless of which microphone is your system default and isn't fooled by the remote participant's audio. An 800 ms hangover bridges the gaps between words so one utterance isn't split into many tiny sessions.
2. **UI Automation** — answers "*who?*"

| Platform | Name source (via UIA) |
|---|---|
| **Zoom desktop** | Video tile accessible names — verified on Zoom 7.x they carry the participant name, the **`(me)`** self marker, mute state and an **`, Active speaker`** suffix (e.g. `"Bidheyak Thapa(Host, me), Computer audio unmuted,Video off, Active speaker"`). The self tile's badge is gated by **your mic-capture** and a remote tile's badge by **playback**, so you're tracked by your real name whether or not the other person's mic is on, and the lingering "last speaker" highlight can't inflate durations. Works in the background. |
| **Google Meet** (browser) | Speaking-indicator CSS classes on participant tiles (Chromium exposes HTML `class` as UIA ClassName) + the name in the tile. Caption rows are used as a *bonus* signal if you happen to have CC on — never required. |
| **Microsoft Teams** | The voice-level ring class (`vdi-frame-occlusion`) on the speaking tile + nearby name; captions as bonus. |
| **Zoom web** (browser tab) | Tab classified by title (`Zoom Meeting…` / `… - Zoom -`); roster names via the participants panel; speaker names via generic labels when exposed. |

3. **Mute-aware self tracking.** App-level mute (clicking mute in Zoom/Meet) does **not** stop the OS mic-capture stream, so mic audio alone can't tell "speaking" from "speaking while muted". The engine therefore logs *you* only when the UI **confirms your mic is unmuted** — Meet's `Turn off microphone` button, Zoom's `(me)` tile / web `mute my microphone` button, Teams' `Mute` button. If your mute state can't be read (e.g. a Meet tab in the background with no accessibility tree), you are **not** logged, rather than logged falsely.
4. **Never miss the time**: when audio says a *remote* is speaking but no per-speaker name is readable, the engine logs **`Someone`** (or the one remote's name in a 1:1 call), so durations are always captured and names attach whenever available.

This is the same UI-scraping reality Recall.ai lives with — when platforms change their UI, selectors need refreshing. The **dump mode** (below) makes that a minutes-long fix.

## Getting started

Requirements: Windows 10/11, Node.js 20+. Nothing else.

```powershell
npm install
npm start          # build + launch
```

Speaker events appear in the **terminal**, the **app window** (live cards + log + talk-time totals), and the app's **DevTools console** (Ctrl+Shift+I).

> If `npm start` fails with `Cannot read properties of undefined (reading 'whenReady')`, your shell has `ELECTRON_RUN_AS_NODE` set (some IDE terminals do this). Clear it: `Remove-Item Env:\ELECTRON_RUN_AS_NODE` and retry.

## How to verify everything

### 1. No-meeting checks

```powershell
npm test                  # 19 unit tests: session tracking, NDJSON, formatting
npm run engine:selftest   # 51 fixture tests: classifiers + every detector (incl. real Zoom 7.x dump strings)
npm run engine:once       # one real poll; prints engine status + visible meeting windows
npm run simulate          # full pipeline with synthetic speakers — watch start/stop + durations flow
```

### 2. Audio metering check (10 seconds)

```powershell
npm run dump
```

Look for `Audio peaks now: playback[ chrome=0.013 ] mic-capture[ zoom=0.220 ]`. Play meeting audio (moves a `playback` number) and speak into the mic during a call (moves that app's `mic-capture` number). This is the layer that makes background + caption-free detection work.

### 3. Live: Zoom desktop (verifiable solo)

1. `npm start`, start a Zoom meeting in the desktop client. The Zoom chip turns `● live` (a `♪` appears whenever meeting audio is flowing).
2. **Speak** — your own tile carries the "Active speaker" badge, so you should see `>> [Zoom] <Your Name> started speaking` while your mic is hot, and a `spoke for Xs` line when you stop.
3. Minimize Zoom or put it behind other windows — detection keeps working (no foreground requirement, no hotkeys).
4. With a second participant: whoever Zoom marks as active speaker gets logged by name.

### 4. Live: Google Meet

1. `npm start`, join a Meet in Chrome/Edge, keep the Meet tab the **active tab** in its window (the window itself can be behind other windows — that's fine; only minimizing/switching tabs kills the tab's accessibility tree).
2. Speak / have someone speak. Named events come from the tile speaking-indicator; if the tree is empty (chip shows `⚠ names n/a`), you still get `Someone` / `You` events from audio.
3. If `⚠ names n/a` persists: relaunch the browser with `--force-renderer-accessibility`, or use Edge.

### 5. Live: Teams / Zoom web

Same procedure — Teams desktop needs nothing special; Zoom web is detected from the tab title (`Zoom Meeting`). Expect named speakers on Teams via the speaking ring; on Zoom web, names depend on what the web client exposes — `Someone`/`You` + durations always work.

### 6. When names don't appear: dump the UIA tree

```powershell
npm run dump
```

- Lists **every top-level window** (title/class/process) — check your meeting window was classified at all (this is how the Zoom `", Active speaker"` badge was discovered).
- Writes each meeting window's full accessibility tree to `logs\uia-dump-*.ndjson`. Search it for a participant's name, note the surrounding `c` (class) values, and update the class constants at the top of the detectors in [engine/uia-engine.ps1](engine/uia-engine.ps1) (`MeetSpeakingClasses`, `MeetNameClasses`, `TeamsSpeakingClass`, `ZoomTilePattern`).
- Also prints current audio peaks.

## Tuning

Engine parameters (pass to `engine/uia-engine.ps1`, or edit the spawn args in [src/main/engine.ts](src/main/engine.ts)):

| Param | Default | Meaning |
|---|---|---|
| `-PollMs` | 500 | Poll interval |
| `-RemoteAudioThreshold` | 0.02 | Output peak above which an app counts as "voice playing" |
| `-MicAudioThreshold` | 0.04 | Mic peak above which you count as speaking |
| `-ZoomProbe` | off | Legacy Ctrl+2 foreground probe (not needed on Zoom 7.x) |

## Limitations (honest ones)

- **Attribution beats captions, but isn't audio fingerprinting**: names come from what the meeting UI exposes. When it exposes nothing, you get `Someone`/`You` with correct timing rather than a name.
- **Browser audio is per-process, not per-tab**: a YouTube tab blasting in the same browser as your Meet counts as meeting audio (the meter can't tell tabs apart).
- **Mic without headphones**: with loud speakers, remote voices can trip the mic threshold; `You` is suppressed while remote audio is active to compensate.
- **Background limits for browser tabs**: Chromium drops a background *tab's* accessibility tree (names pause; audio detection continues). Zoom/Teams desktop have no such limit.
- **English UI strings** for Zoom tile states (`Computer audio unmuted`…) and call markers; other locales need pattern additions.
- Meet labels the local user **"You"**; class-based selectors rotate with platform releases (dump mode = quick re-tune).

## Scripts

| Script | What it does |
|---|---|
| `npm start` | Build everything and launch the app |
| `npm run simulate` | Launch with synthetic speakers (pipeline demo/test) |
| `npm test` | Vitest unit tests |
| `npm run engine:selftest` | Engine detector/classifier fixture tests (51) |
| `npm run engine:once` | One real UIA+audio poll, print results, exit |
| `npm run dump` | List all windows + dump meeting UIA trees + audio peaks |
| `npm run typecheck` | Typecheck main + renderer |
