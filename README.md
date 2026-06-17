# Meeting Speaker Logger — macOS

A native macOS port of [bidheyakthapa/meet-speaker-detector](https://github.com/bidheyakthapa/meet-speaker-detector)
(originally a Windows Electron + PowerShell app).

It logs **who is speaking, and for how long**, in **Google Meet, Zoom, and
Microsoft Teams** in real time — no server, no captions, and no meeting-window
focus required. Built with **Swift + SwiftUI**.

> The original detects speakers on Windows with **WASAPI** audio metering and
> **UI Automation**. This port keeps the exact same architecture and data model,
> swapping in the macOS-native equivalents.

## How it maps to the original

| Concern | Windows original | macOS port |
| --- | --- | --- |
| "Is anyone speaking?" — remote audio | WASAPI playback peak | **ScreenCaptureKit** system-audio capture ([`SystemAudioMeter`](Sources/MeetSpeakerDetector/Engine/SystemAudioMeter.swift)) |
| "Is anyone speaking?" — your mic | WASAPI capture peak | **AVAudioEngine** input tap ([`MicMeter`](Sources/MeetSpeakerDetector/Engine/MicMeter.swift)) |
| "Who is speaking?" — names | Windows UI Automation tree | **Accessibility API / AXUIElement** ([`AccessibilityScanner`](Sources/MeetSpeakerDetector/Engine/AccessibilityScanner.swift)) |
| Merge loop (500 ms) + thresholds | PowerShell engine | [`DetectionEngine`](Sources/MeetSpeakerDetector/Engine/DetectionEngine.swift) |
| Pulses → sessions | `SessionTracker` (TS) | [`SessionTracker`](Sources/SpeakerCore/SessionTracker.swift) (ported 1:1) |
| Types / formatting / NDJSON | `src/shared/*.ts` | [`Sources/SpeakerCore`](Sources/SpeakerCore) (ported 1:1) |
| UI (React) | `src/renderer/App.tsx` | SwiftUI [`Views/`](Sources/MeetSpeakerDetector/Views) |

The two signals are merged every poll exactly as before: **audio decides *whether*
someone is speaking; the accessibility scan decides *who***. When a name can't be
read, the session is logged as `Someone` (the original's fallback). Your own mic
is logged as `You`, and only when the UI doesn't show you muted (mute-aware).

Tuning matches the original defaults: poll interval **500 ms**, remote audio
threshold **0.02**, mic threshold **0.04**, and an end-of-session silence window
of **2000 ms** so indicator flicker doesn't split one utterance.

## Build & run

Requires macOS 13+ and the Swift toolchain (Xcode or Command Line Tools).

```bash
# Build a runnable, ad-hoc-signed .app bundle
./scripts/build-app.sh
open build/MeetSpeakerDetector.app

# Or run directly during development
swift run MeetSpeakerDetector
```

> Launching via the `.app` bundle (not bare `swift run`) is recommended so macOS
> can remember the permission grants against a stable bundle identity.

### Hot reload / dev loop

There's no built-in state-preserving hot reload without Xcode (this is a SwiftPM
app). Two options:

**1. Save → auto rebuild & relaunch (works now, zero installs):**

```bash
./scripts/dev.sh
```

Watches `Sources/` and `Resources/` and rebuilds + relaunches the signed `.app`
on every save (so permission grants persist). In-app state resets each reload.
`brew install fswatch` makes change detection instant instead of polled.

For the fastest pure-UI iteration you can skip the bundle and run the binary
directly (permissions won't persist):

```bash
swift run MeetSpeakerDetector
```

**2. True hot reload (state-preserving, sub-second) via InjectionIII:**

Requires the free [InjectionIII](https://github.com/johnno1962/InjectionIII) app
(or `brew install --cask injectioniii`). Then:

1. Launch InjectionIII and point it at this project directory.
2. Add the [Inject](https://github.com/krzysztofzablocki/Inject) package to
   `Package.swift` and depend on it from the `MeetSpeakerDetector` target.
3. Add the interposable linker flag to that target (debug):
   `linkerSettings: [.unsafeFlags(["-Xlinker", "-interposable"])]`.
4. In each view: `import Inject`, add `@ObserveInjection var inject` and end the
   `body` with `.enableInjection()`.
5. Run with `swift run MeetSpeakerDetector` (InjectionIII watches and injects
   recompiled views live).

### Permissions

On first run the app requests, and the UI nudges you to grant:

- **Microphone** — to detect when *you* are speaking (prompted automatically).
- **Screen Recording** — ScreenCaptureKit uses this to meter system audio; grant
  it in **System Settings ▸ Privacy & Security ▸ Screen Recording**, then relaunch.
- **Accessibility** — to read participant names from meeting windows; grant it in
  **System Settings ▸ Privacy & Security ▸ Accessibility**.

With no permissions the app still runs; it just degrades (e.g. audio-only
detection logging `Someone`, or idle when nothing is detectable).

#### Newly-granted permissions need a relaunch

This is macOS behavior, not a bug: **Screen Recording and (usually)
Accessibility grants do not reach the already-running process** — only the
microphone updates live. After you flip a toggle in System Settings, the app
shows a **Relaunch** button (⌘R) that cleanly restarts it so the new grant takes
effect immediately. The app detects the change and surfaces this automatically.

#### Grants resetting on every rebuild

TCC ties a grant to the app's exact code signature. The default **ad-hoc**
signature changes on every build, so each rebuild looks like a new app and your
grant is forgotten. Two helpers fix this:

```bash
# 1) Clear stale/orphaned grants for this app, then re-prompt cleanly:
./scripts/reset-permissions.sh

# 2) Create a STABLE signing identity once, then build with it so grants persist:
./scripts/make-dev-cert.sh
MSD_SIGN_ID="MeetSpeakerDetector Dev" ./scripts/build-app.sh
# (dev loop: MSD_SIGN_ID="MeetSpeakerDetector Dev" ./scripts/dev.sh)
```

## Verify

```bash
swift run SpeakerCoreSelfTest   # dependency-free checks (no Xcode needed)
swift test                      # XCTest suite (requires a full Xcode install)
```

`SpeakerCoreSelfTest` mirrors `npm run engine:selftest` from the original and
covers `formatDuration`, `SessionTracker`, and the NDJSON parser.

## Output

Completed speaking sessions stream into the UI and are appended as NDJSON to:

```
~/Library/Application Support/MeetSpeakerDetector/sessions.ndjson
```

Each line is one `speaker-end` record: `{platform, name, startTs, endTs, durationMs}`.

## Project layout

```
Sources/
  SpeakerCore/            Pure, UI-free logic ported from src/shared/* (unit-tested)
    Types.swift           Platform, EnginePulse/Windows/Status, TrackerEvent, AppEvent
    SessionTracker.swift  Pulses -> speaking sessions (1:1 port)
    Formatting.swift      formatDuration / formatClock (1:1 port)
    Ndjson.swift          Incremental NDJSON parser + session log writer
  MeetSpeakerDetector/    The macOS app
    App.swift             SwiftUI @main entry
    Engine/               MicMeter, SystemAudioMeter, AccessibilityScanner, DetectionEngine
    ViewModel/AppModel.swift   Observable state (mirrors App.tsx)
    Views/                Header, Now speaking, Speaking log, Talk time, Status footer
  SpeakerCoreSelfTest/    XCTest-free check runner
Tests/SpeakerCoreTests/   XCTest suite
Resources/Info.plist      Bundle metadata + microphone usage string
scripts/build-app.sh      Assembles + signs the .app
```

## Known limitations

Inherited from the original's approach, plus macOS specifics:

- System-audio metering is **combined**, not per-app/per-tab; the "is anyone
  speaking" signal is attributed to whichever meeting window is visible.
- Name extraction from accessibility trees is **best-effort and heuristic** —
  meeting apps change their trees across versions and locales (English-oriented).
  When names aren't exposed, sessions are logged as `Someone`.
- Background browser tabs may drop their accessibility tree (as on Windows);
  audio detection still works.
- No audio fingerprinting — attribution relies on what the UI exposes.
