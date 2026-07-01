# How Speaker Name & Timing Work (the simple version)

A plain-English walkthrough of **how the app figures out _who_ is speaking and _for how long_**.
For the full deep-dive see [ARCHITECTURE.md](docs/ARCHITECTURE.md); this file is the friendly summary.

---

## 1. The one big idea

The app answers two separate questions with two separate signals:

| Question | Signal used | Source |
|---|---|---|
| **WHEN** is someone speaking? | **Audio** — how loud each app is playing/recording | Windows audio meters (WASAPI) |
| **WHO** is that someone? | **Names on screen** — read from the meeting window | Windows accessibility tree (UI Automation) |

> 🔑 **Audio tells the timing. The accessibility tree tells the name.** Neither is trusted alone.
> If audio says "someone is talking" but no name can be read, the app still logs the time — just as **`You`** or **`Someone`**.

This is the same approach Recall.ai's desktop SDK uses (read the OS accessibility APIs to see who's speaking). No microphone recording, no server, nothing leaves your machine.

---

## 2. The journey of one speaking event

Every **500 ms** (one "poll"), a background PowerShell engine ([engine/uia-engine.ps1](engine/uia-engine.ps1)) does this loop:

```
┌──────────────────────────────────────────────────────────────────────┐
│  ENGINE  (engine/uia-engine.ps1)  — runs every 500 ms                  │
│                                                                        │
│  1. Find meeting windows   → is Zoom/Meet/Teams open?                  │
│  2. Read audio meters      → which app is making mic/speaker sound?    │
│  3. Read the window's text → what names are on the tiles?              │
│  4. Combine + safety-check → who is REALLY speaking right now?         │
│  5. Print a "pulse" line   → {"speakers":["Bidheyak Thapa"], ...}      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │  one JSON line per poll (stdout)
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  ELECTRON APP  (src/main)                                              │
│                                                                        │
│  • SessionTracker turns repeated "X is speaking" pulses into a         │
│    single session:  start time → live timer → end time + duration     │
│  • Prints  ">> X started speaking"  /  "[] X spoke for 12.3s"          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │  IPC
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  WINDOW UI  (src/renderer, React)                                      │
│  Live "Now speaking" cards · speaking log table · talk-time totals     │
└──────────────────────────────────────────────────────────────────────┘
```

So a name travels: **meeting window → engine pulse → session tracker → your screen.**

---

## 3. How the NAME is fetched (per platform)

The engine reads the meeting window's accessibility tree — a flat list of on-screen elements, each with a **Name**, a **ClassName**, and a **type**. For web apps, Chromium helpfully exposes each element's HTML CSS class as the "ClassName", which is the hook the detectors latch onto.

| Platform | Where the name comes from | Code |
|---|---|---|
| **Zoom desktop** ⭐ | The video-tile label literally spells everything out (see below). Best source — works in the background. | `ParseZoomVideoTiles` — [engine/uia-engine.ps1:1056](engine/uia-engine.ps1#L1056) |
| **Google Meet** | A CSS "speaking" class lights up on the talking tile (`Oaajhc`/`HX2H7`/…); the nearby name label is read off. | `DetectMeetTileSpeakers` / `ParseMeetRoster` — [engine/uia-engine.ps1:1139](engine/uia-engine.ps1#L1139) |
| **Microsoft Teams** | A voice-level "ring" CSS class (`vdi-frame-occlusion`) marks the speaker; the nearby name is read. | `DetectTeamsTileSpeakers` / `ParseTeamsTiles` — [engine/uia-engine.ps1:1227](engine/uia-engine.ps1#L1227) |
| **Zoom web** | Thin page, no speaking badge — only names + mute state are read; timing leans on audio. | `ParseZoomWeb` — [engine/uia-engine.ps1:1349](engine/uia-engine.ps1#L1349) |
| **Captions (bonus)** | If you have CC on (Meet/Teams), the newest caption's author is a backup speaker signal. | `CaptionSpeakers` — [engine/uia-engine.ps1:974](engine/uia-engine.ps1#L974) |

### The Zoom desktop example (the clearest one)

Zoom puts a full description on each video tile that Windows can read even when minimized:

```
"Bidheyak Thapa(Host, me), Computer audio unmuted, Video off, Active speaker"
   └─── name ───┘ └─ "me" = you ─┘  └── mic state ──┘            └ speaking badge ┘
```

One regex ([`ZoomTilePattern`, line 1049](engine/uia-engine.ps1#L1049)) pulls out four things:

- **Name** → `Bidheyak Thapa`
- **`me`** present → this tile is **you** (otherwise it's a remote person)
- **`unmuted`** → your mic is on
- **`Active speaker`** → Zoom thinks this tile is the current speaker

> ⚠️ **The "Active speaker" badge is _not_ trusted on its own** — Zoom leaves it stuck on the last speaker even during silence. It only counts as "speaking" when **audio agrees** (see §4).

### Telling "you" apart from everyone else

- **Zoom desktop**: the `(me)` marker on your tile.
- **Teams**: your tile starts with `Myself`.
- **Meet**: you're the one person the host *can't* "Mute …'s microphone" (only works when **you** are the host).
- **Zoom web**: only guessable in a 1-person call, or from a `"Name's Zoom Meeting"` title.

Every name is cleaned up (`(Host, me)` suffixes stripped — [`CleanName`, line 764](engine/uia-engine.ps1#L764)) and sanity-checked so UI labels like `HOST` or chat sentences never get logged as people ([`IsLikelyPersonName`, line 786](engine/uia-engine.ps1#L786)).

---

## 4. How the TIMING works

There are **two timing layers** stacked on top of each other.

### Layer A — the engine decides "is sound happening right now?"

The engine reads two audio meters per app, every poll ([`SampleAudio`, line 387](engine/uia-engine.ps1#L387)):

- **Playback loudness** (`zoom.exe` playing sound) → a **remote** person is talking. Threshold **0.02**.
- **Mic-capture loudness** (the app pulling your mic) → **you** are talking. Threshold **0.04**.

**The 800 ms "hangover"** ([`Bump` / `ActiveWithin`, line 433](engine/uia-engine.ps1#L433)): once an app crosses the threshold, it stays counted as "active" for **800 ms more**. People pause between words — without this cushion, every tiny pause would chop one sentence into many separate sessions. The hangover bridges the gaps, but is kept short so it doesn't pad durations.

### Layer B — the app turns repeated pulses into one session

The engine fires a "X is speaking" pulse every poll while they talk. [`SessionTracker`](src/shared/sessionTracker.ts) stitches those into a single session:

```
First pulse for a name        → OPEN a session, emit "speaker-start"
More pulses for that name      → keep refreshing "last seen" time
No pulse for 1800 ms           → CLOSE the session, emit "speaker-end"

duration = (last seen − start) + 300 ms
```

The numbers actually used (set in [src/main/main.ts:90](src/main/main.ts#L90)):

| Setting | Value | Meaning |
|---|---|---|
| Poll interval | **500 ms** | how often the engine checks |
| Audio hangover | **800 ms** | bridges gaps between words (engine side) |
| End-of-turn silence | **1800 ms** | this much quiet ends a speaking turn |
| Pulse width pad | **300 ms** | added to each duration (a single poll ≈ this much speech) |

So: the engine bridges word-gaps with 800 ms, and the app only declares a turn "over" after 1800 ms of true silence — promptly, without splitting one sentence in two.

---

## 5. The safety rules (why it never lies)

These two rules are the heart of the design:

1. **Never log a false "You."** Your mic stream stays *open* even when you click mute in the app — so loud audio alone can't tell "speaking" from "speaking while muted." The app logs **you** only when the **UI confirms your mic is unmuted**. If it can't read your mute state, it logs **nothing** rather than guess.
   *(The check is literally `selfActive && MicState == Unmuted` — [engine/uia-engine.ps1:1809](engine/uia-engine.ps1#L1809). "Unknown" mute state does not pass.)*

2. **Never miss the timing.** If audio says someone is talking but no name can be read, it still logs the time:
   - remote sound, name unknown → **`Someone`** (or the one other person's name in a 1:1 call)
   - your mic, name unknown → **`You`**

   *(This fallback runs once per platform per poll — [engine/uia-engine.ps1:1790](engine/uia-engine.ps1#L1790) — so the same voice from two browser windows isn't double-counted.)*

---

## 6. Worked example

You're in a Zoom call and say "Hi everyone, quick update…" for 12 seconds, then stop.

1. Your mic-capture meter crosses 0.04 → engine marks `zoom.exe` mic-active (+800 ms hangover).
2. Your Zoom tile reads `...(me)... unmuted, Active speaker` → name **Bidheyak Thapa**, mic confirmed on.
3. Both agree → engine prints a pulse every 500 ms: `{"speakers":["Bidheyak Thapa"],"source":"zoom-tiles",...}`
4. First pulse → app prints `>> [Zoom] Bidheyak Thapa started speaking (10:14:26)` and starts a live timer.
5. You stop. After 1800 ms of silence the session closes:
   ```
   [] [Zoom] Bidheyak Thapa spoke for 12.3s (10:14:26 -> 10:14:38)
   ```
6. The window UI shows the card disappearing, a new log row, and your name's total talk-time going up.

---

## 7. Where to look in the code

| What | File |
|---|---|
| **All detection** (windows, audio, name parsers, fallbacks) | [engine/uia-engine.ps1](engine/uia-engine.ps1) — the main loop is [`Run`, line 1643](engine/uia-engine.ps1#L1643) |
| Pulses → sessions (the timing state machine) | [src/shared/sessionTracker.ts](src/shared/sessionTracker.ts) |
| Wires engine → tracker → UI, console logging | [src/main/main.ts](src/main/main.ts) |
| Spawns & restarts the PowerShell engine | [src/main/engine.ts](src/main/engine.ts) |
| Event shapes (`pulse`, `speaker-start/tick/end`) | [src/shared/types.ts](src/shared/types.ts) |
| The window UI (cards, log, totals) | [src/renderer/App.tsx](src/renderer/App.tsx) |

**The `source` field** on each pulse tells you which detector fired: `zoom-tiles`, `zoom-web`, `meet-tiles`, `meet-captions`, `teams-tiles`, `teams-captions`, `mic-audio` (the "You" fallback), `audio-roster` (one named remote), `audio` (the "Someone" fallback).

**If names ever stop appearing** (a platform changed its UI), run `npm run dump`, find the participant's name in `logs/uia-dump-*.ndjson`, and update the class/regex constants near the top of the detectors in [engine/uia-engine.ps1](engine/uia-engine.ps1). That's the whole repair loop.
