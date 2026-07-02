# HANDOFF — Google Meet speaker-detection investigation

**For:** the next agent picking this up. **Date:** 2026-07-03. **Repo:** `demo-app` (research sandbox;
production code is `bubbles-meet-detector`, feature/desktop-app). **Full report:**
`~/.claude/google-meet-speaking-detection-analysis.md`. **Companion docs:**
[meet-dom-speaking-detection.md](meet-dom-speaking-detection.md) (DOM),
[meet-active-speaker-no-hardcoded-css.md](meet-active-speaker-no-hardcoded-css.md) (AX + Recall RE).

---

## 0. Mission & the ONE mental model you need

Replace the fragile, ~6-week-rotating CSS class `kssMZb` used to detect the Meet active speaker.
Everything hinges on **which surface your code reads**:

| Surface | Who uses it | Sees the speaking signal? |
|---|---|---|
| **Accessibility tree** (macOS `AXUIElement`/`AXDOMClassList`, Windows UIA `ClassName`) | the shipping product | **NO** — the speaking indicator is pruned from AX |
| **Raw DOM** (content script / CDP / embedded webview) | not shipped yet | **YES** — the durable structural signal lives here |

**Do not conflate them.** A finding on one surface usually does NOT transfer to the other.

---

## 1. Settled findings (treat as established; re-verify only if suspicious)

### DOM surface (proven live end-to-end, 2026-07-03)
- **Speaking = the audio-level equalizer bars animate.** Class-independent read:
  `[data-participant-id]` tile → `[jsname="QgSmzd"]` (or structurally, a div with ≥3 tiny bar children)
  → `getComputedStyle(bar).animationName === 'stripeJiggleAnimation'` (silent state = `animation-name:none`).
- **STRUCTURE-FIRST signature (session 3, live-measured):** the equalizer is a VISIBLE small circle —
  in-tile **28×28** + People-panel row **24×24**, `display:flex`, `border-radius:50%` — holding exactly
  **3 leaf-div bars of 4×16px**. `stripeJiggleAnimation` animates ONLY `background-size/position`, so
  bar rects are stable while animating. Token-free find: visible div (0<w,h≤80) whose div-children are
  ≥3 leaf divs (0<w≤12). Matched exactly the real widgets page-wide, zero FPs. **A MUTED participant's
  widget stays in the DOM as `display:none`/0×0** → the visibility guard is mandatory. The detector
  (`browser-qa/dom-detector.js`) is now structure-first with jsname as a supplemental anchor
  (`__ctx.structOnly` disables jsname entirely; `__ctx.holdMs` bridges animation render gaps).
- **Anchor on `jsname`/structure, NEVER on the volatile bits.** Observed rotating in the wild:
  `jscontroller` (`tae9tc`→`ES310d`→`YQvg8b` on the self-meter), bar classes, and the speaking class
  (`HX2H7`/`Oaajhc`/`wEsLMd`/`OgVli` — these are audio-LEVEL states). Held constant: `jsname="QgSmzd"`,
  base class `IisKdb`, silence class `gjg47c`.
- **Widget variants (session 3):** (a) in-tile 3-bar `IisKdb` equalizer on the VIDEO STAGE — **the signal
  the detector uses**; (b) People-panel row 24×24 equalizer — **NOT used** (the panel is usually closed;
  depending on it would tie detection to an optional overlay). The detector scopes everything to stage
  tiles (`stageTiles`/`inPanel` exclude `[role=list|listitem|dialog|complementary]`/`aside`), so the
  panel being open or closed gives the SAME result; (c) `DYfzY` self-meter — 0×0, ZERO children, never
  animates; only its class swaps `gjg47c`→level classes (last-resort read); (d) the control-bar mic
  button holds an equalizer too — it sits OUTSIDE any tile (no owner → harmless; 0-width bars while muted).
- **DO NOT DEPEND ON THE PEOPLE PANEL** — participant enumeration (`window.__meetParticipants()`) and
  speaking detection both read stage tiles only. Everyone in the call has a stage tile (grid, or the
  spotlight filmstrip), so the stage is a complete-enough roster; the panel is never required. Two QA
  scenarios lock this in (`people-panel-open-same-result`, `people-panel-only-ignored`).
- **`data-audio-level` is ABSENT** in the current build (Vexa's selector) — don't rely on it.
- **`kssMZb` is NOT a real-time speaking signal** — it's a last-active/focus marker; present on a muted,
  silent tile and gone minutes later. Dropped from the detector (it false-named the muted host).
- **Captions are intentionally NOT used** (product requirement).
- **Live proof:** with real speech (BlackHole) into a guest, the real detector on the host's live DOM
  named the guest turn-wise **81–94%** of each utterance, quiet 67–83% in gaps, camera-off remote.

### AX surface (proven live, 2026-07-03)
- **Speaking is PRUNED from the AX tree** — silent-vs-speaking AX diff is EMPTY; `QgSmzd`/`IisKdb`/
  `gjg47c`/`Oaajhc`/`stripeJiggle` = 0 AX nodes. So the DOM signal above is **unreachable from AX/UIA**.
- **AX speaking MUST come from audio VAD** (+ geometry + roster) — exactly the shipped design & Recall's.
- **AX DOES expose:** participant names (`AXStaticText`), tile containers (`.oZRSLe` + `AXFrame`
  geometry), self mic state (button title "Turn on/off microphone"), and screen-share
  (`"You are presenting"`/`"Stop presenting"` → `MeetPresentationActive`).
- **AX availability by window state (host-only, verified):** foreground ✅ / **background TAB ❌ gone**
  (Chrome drops AX for non-active tabs) / background APP ✅ / minimized ✅ / maximized ✅. Audio VAD is
  window-state-independent, so fusion floors to VAD-only ("Someone", no name) only in the background-tab case.
- Recall's binary uses **zero DOM selectors** for Meet (calibrated `nm`+`strings`): it's audio-VAD +
  geometry (`MixedVideoRect`) + AX roster.

---

## 2. RUNBOOK — stand up a live 2-person Meet (host → guest → admit → speak → measure)

This is the fiddly part. Every step below has a gotcha that cost hours; follow exactly.

**Prereqs:** Node 20; Google Chrome; `SwitchAudioSource` (`brew install switchaudio-osx`); **BlackHole 2ch**
(`brew install blackhole-2ch` then `sudo installer -pkg "$(ls ~/Library/Caches/Homebrew/downloads/*BlackHole2ch*.pkg)" -target /` and `sudo killall coreaudiod`); Accessibility permission granted to your Terminal (for the AX tools). All scripts live in `research/meet-dom-detector/live/`.

1. **START HOST** — `node live/open-clean.js`
   - Opens a fresh **empty-profile** Chrome (`.live-profile`) on debug port **9222** → `meet.google.com/new`.
   - **MANUAL:** sign into Google in that window (Meet needs auth to create a room). Empty profile ⇒ no
     cookie/Keychain pinning issues. *(Do NOT copy the user's real profile — macOS Keychain-binds cookies;
     it lands on the account chooser. This was tried and failed.)*
2. **HOST JOINS** — `node live/watch-meeting.js`
   - Waits for the green room, clicks "Join now", writes the meeting URL to `live/.meeting-url`.
3. **JOIN A GUEST** — `node live/bh-full-test.js` (does join+measure) OR reuse the join logic:
   - Launches a **headful** guest Chrome (`meet-guest` profile, port 9318/9320/9321) with
     `--use-fake-ui-for-media-stream` (real mic, auto-grant).
   - **GOTCHA:** set the guest name with the **React-proper value setter**
     (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set`) — a plain `input.value=`
     leaves "Ask to join" **disabled**.
4. **ADMIT THE GUEST — TWO STEPS**
   - The toast "**Admit 1 guest**" is NOT enough. You must also click the People-panel **row** button:
     `button[jsname="OYykWd"]` (aria-label `"Admit <name>"`). Use a **real CDP mouse click**
     (`Input.dispatchMouseEvent` at the element's rect) — `el.click()` often no-ops on Meet controls.
   - Fully-admitted check: the guest's own page has a `button[aria-label*="Leave call"]` / sees the host name.
5. **MAKE THE GUEST SPEAK (recognized speech)**
   - **GOTCHA:** the **fake-device tone is NOT treated as speech** by Meet. Use real speech via BlackHole.
   - **GOTCHA:** Meet **pins the mic device at admit time**; changing the system default later does nothing.
     In the **guest window**: ⋮ More options → Settings → Audio → Microphone → **"BlackHole 2ch"**.
   - Route audio: `SwitchAudioSource -t input -s "BlackHole 2ch"; SwitchAudioSource -t output -s "BlackHole 2ch"`,
     then `afplay live/audio/Alice.wav` (7s clips) → loops into the guest mic → Meet transmits real speech.
     Play ONE clip at a time (overlapping `afplay` = garbled).
6. **MEASURE / DETECT** — `node live/bh-final-confirm.js`
   - Injects the real detector (`browser-qa/dom-detector.js`) into the host, plays clips turn-wise,
     reports the named speaker per utterance. **GOTCHA:** detect speaking by ANY `[jsname="QgSmzd"]` bar
     animating — there are **multiple** QgSmzd elements per tile; check them all (the real detector does).
7. **CLEANUP** — always restore audio: `SwitchAudioSource -t input -s "MacBook Pro Microphone";
   SwitchAudioSource -t output -s "MacBook Pro Speakers"`; `pkill -f meet-guest`. Host + `.live-profile`
   persist (user asked to keep the session; it's gitignored). To wipe: kill the :9222 Chrome + `rm -rf live/.live-profile`.

> There are many one-purpose `bh-*.js` scripts from the debugging journey (see §4). The clean path is
> `open-clean.js` → `watch-meeting.js` → `bh-full-test.js` → (set BlackHole mic) → `bh-final-confirm.js`.

---

## 3. Reproduce the non-live results (no meeting needed)

```bash
cd research/meet-dom-detector
node test.js                       # Node logic harness → 20/20
node browser-qa/run-browser-qa.js  # SIMULATOR in headless Chrome (real getComputedStyle) → 25/25
node cdp-capture.js 9222 > x.html  # dump a live tab's DOM (Chrome started with --remote-debugging-port=9222)

# AX tools (macOS; needs Accessibility permission)
cd ../../macos
swift build
swift run AXDump chrome            # quick AX tree of the meeting tab
swift run AXSnapshot chrome        # full diffable AX dump → macos/ax-dumps/<ts>/
swift run AXSnapshot chrome --watch 20   # print AX tokens appearing/disappearing (watch during speech)
node ../research/meet-dom-detector/live/ax-state.js {front|newtab|minimize|restore|closetabs}  # window-state driver
```
CI already wires the two harnesses: `.github/workflows/meet-detector-qa.yml` (Node 20/20 + browser 18/18 baselines — bump to 25 after review).

---

## 4. File map

**Detector + QA** (`research/meet-dom-detector/`):
- `detector.js` — Node fallback-chain detector + `DEFAULT_CONFIG` (dataAudioLevel → audioIndicator → geometry → Someone; kssMZb removed).
- `browser-qa/dom-detector.js` — the REAL class-independent DOM detector (`findIndicators`/`indicatorSpeaking`); this is the one injected live.
- `browser-qa/meet-sim.html` — faithful Meet-DOM simulator (real CSS animation) with 25 scenarios (grid, spotlight, PiP, sidebar, 3-people, turn-wise, overlapping…).
- `browser-qa/run-browser-qa.js` — CDP runner (headless Chrome).
- `fixtures.js`, `test.js` — Node scenario harness.
- `cdp-capture.js` — zero-dep CDP DOM dumper.
- `package.json` — `npm test` / `test:browser`.

**Live rig** (`research/meet-dom-detector/live/`): `cdp-lib.js` (shared CDP helpers), `open-clean.js`,
`watch-meeting.js`, `bh-full-test.js`, `bh-final-confirm.js` (the confirmed end-to-end), `ax-state.js`
(window-state driver), `mic-check.js` (audio-path check), `make-test-audio.sh` + `audio/*.wav`.
The many `bh-*.js` (admit/unmute/measure variants) are debugging steps kept for reference — `bh-final-confirm.js` is the good one.

**AX tools** (`macos/Sources/`): `AXDump`, `AXSnapshot` (`--watch`), `AXObserve`, `MeetProbe` (per-tile
speech-oracle scorer), plus the shipped engine in `MeetSpeakerDetector` / `SpeakerCore`
(`MeetActiveSpeaker.swift`, `MeetSpeakerRules.swift`). Windows mirror: `window/engine/cs/meet.cs`.

**Old evidence:** `ax-dumps/20260625-*` (static, solo/silent — weak); the golden DOM diff is
`ax-dumps/20260625-135929/meet-snippet.html`.

---

## 5. Live environment state (as of handoff)
- Host Chrome alive on **:9222** (`.live-profile`, signed in as **bibekthapa922@gmail.com**, room
  `meet.google.com/jvf-icyo-nzg`). The guest has **left** (1-person call now).
- **BlackHole 2ch installed**; audio defaults restored (MacBook mic/speakers).
- `.live-profile` is **4.2 GB and holds a live Google session** — gitignored, **keep** (user's request); wipe with `rm -rf` when done.
- **Uncommitted:** `.github/` (CI), `research/`, `docs/meet-dom-speaking-detection.md`, `docs/meet-speaker-detection-HANDOFF.md`, edits to `.gitignore` + `docs/meet-active-speaker-no-hardcoded-css.md`. (Two other untracked docs — `desktop-app-integration-plan.md`, `speaker-detection-improvement-plan-2026-07.md` — were NOT created by this investigation.)

---

## 6. Gotchas (hard-won — read before touching the live rig)
1. **Fake-device tone ≠ speech** to Meet (self meter stays silent). Real speech only (BlackHole / humans).
2. **Meet pins the mic device at admit** — must pick BlackHole in the guest's Meet Settings→Audio.
3. **Two-step admit** — toast `Admit`, THEN People-panel row `button[jsname="OYykWd"]`.
4. **React-proper name entry** or "Ask to join" stays disabled.
5. **Multiple `[jsname="QgSmzd"]` per tile** — check all bars, not the first.
6. **`el.click()` unreliable on Meet controls** — use CDP `Input.dispatchMouseEvent` at the rect.
7. **Multiple Chrome instances confound AX/CDP** — the guest instance also has the meeting; kill guests before AX window-state tests.
8. **AX dies for a background TAB** (not for minimize/background-app) — Chrome only builds AX for the active tab.
9. **Copying the user's Chrome profile fails** (Keychain-bound cookies → account chooser) — use a fresh empty profile + manual sign-in.
10. **overlapping `afplay` = garbled** — one clip at a time; clips are ~7s.
11. **Detection is ~81–94%, not 100%** — render/animation latency → add a debounce/hold.

---

## 6b. Session-3 additions (2026-07-03, this agent)
- **STRUCTURE-FIRST detector shipped** in `browser-qa/dom-detector.js`: `isEqualizerShape` finds the
  equalizer by shape (visible div, aspect 0.5–2, 3–8 leaf div bars `0<w≤12`, `barH≥barW`), scoped
  INSIDE `[data-participant-id]` tiles; speaking = bar computed-animation **or** a running WAAPI
  animation in the subtree; jsname is a supplement (`__ctx.structOnly` disables it, `__ctx.holdMs`
  bridges gaps). `window.__meetParticipants()` = pid-keyed roster with token-free **self** detection
  (mirrored `<video>` + no-equalizer). Node **23/23**, real-browser **33/33**.
- **Adversarial panel (5 agents, 51 findings)** hardened it: closed a Node silent-widget false-positive
  (bars now decide, no class fall-through), the square-dot/segmented-strip predicate holes, the
  WAAPI-migration blind spot, and hold-state leakage. Full triage in
  `scratchpad/panel-findings.json` (regenerate: the challenge workflow).
- **LIVE structure-only proof (jsname disabled)**: on the first clean-rig round, the detector named
  each solo speaker **0.88–0.92** turn-wise and **BOTH overlapping speakers 0.81/0.88** on real Meet.
  Overlap **worked**; the only unmet bar (clean gaps / no cross-leak) was the **shared-single-BlackHole
  echo** the panel predicted — a rig confound, not a detector fault.
- **Rig lessons (hard-won, this session):**
  - **Two guests on ONE virtual mic self-confound** (echo/feedback + can't prove independent audio).
    Real overlap needs **2 independent virtual mics** (BlackHole 2ch **+** BlackHole 16ch), driven with
    **explicit-device** playback (`ffmpeg -f audiotoolbox -audio_device_index N`), NOT `afplay`+default-switch.
  - **`afplay` binds its output device at spawn** and default-switching races → detection dropped to 0;
    use explicit-device ffmpeg. `live/find-audio-index.js` discovers+caches the device's audiotoolbox
    index via a pure-CoreAudio record oracle (also proves the loopback works).
  - **BlackHole's loopback can WEDGE system-wide** (every player → silence at its capture side); only
    `sudo killall coreaudiod` clears it (needs a password — blocks headless runs).
  - **Chrome pins the "default" mic alias at process start** and does NOT follow live OS default-input
    changes → set the OS default to the virtual mic **before launching** each guest (`join-guest.js`
    does this); `"Microsoft Teams Audio"` won't hold as an OS **input** default (output-side device).
  - **Guest mic toggle:** CDP coordinate clicks don't land on the guest windows; **`el.click()` works**;
    verify via `data-is-muted`; the guest page has decoy disabled "You can't remotely mute …" mic buttons.
  - **Two-step admit is reusable now**: `live/admit-guest.js` (`admit()`), `live/join-guest.js`
    (`VIRT_MIC=… node join-guest.js "<name>" <port>`).
- **Swift (research mirror):** `SpeakerCore/MeetActiveSpeaker.swift` doc now records the cross-surface
  finding (structure exists but is DOM-only, unreachable from AX — don't re-add a structural AX rule).
  `SpeakerCoreSelfTest` gained a **speech_on/speech_off** validation section proving the event pipeline
  matches the DOM detector's live semantics (turn-wise + overlap + self-vs-remote); `swift build` +
  `swift run SpeakerCoreSelfTest` green. (`swift test`/XCTest is unavailable in this CLI toolchain — the
  self-test harness is the gate, by design.)

## 7. Open questions & prioritized next steps
1. **Add a debounce/hold (~300–500ms) to the DOM detector** so "speaking" bridges animation render gaps (81–94% → ~100%). Easiest high-value win.
2. **3-people + overlapping, LIVE** — needs ≥2 independent virtual mics (BlackHole 2ch + BlackHole 16ch, or Aggregate/Multi-Output) so two guests speak different audio simultaneously. The simulator already covers the LOGIC (25/25); this is the live confirmation.
3. **Screen-share + 3-people live dump** — mechanical repeat; confirm names/geometry scale + presentation region (presentation markers already verified in AX).
4. **Characterize the `kssMZb`/last-active signal** — exactly when it sets/clears; whether a non-class handle tracks it (could be a useful secondary continuity signal — see report §2.7 in the DOM doc).
5. **Productionize the DOM detector** — MutationObserver-driven (not polling), remote-config token loading, vote-then-lock name↔track mapping (à la Vexa), telemetry on `cssClass`/`someoneFloor`.
6. **Decide the surface for the product** — AX (ship-now: VAD + geometry + roster, no speaking selector; background-tab floor) vs adding a DOM capture surface (CDP/embedded webview) to get the durable per-tile signal. See report §6.A vs §6.B.
7. **Windows parity** — `window/engine/cs/meet.cs` UIA path; reconcile the class list (macOS strict `kssMZb` vs Windows 5 tokens) into one source of truth; Teams `vdi-frame-occlusion` is shipped as PRIMARY but unproven (demote).
8. **Commit** the CI + detector + docs (all non-sensitive) once reviewed.

---

## 8. Sources / provenance
- Open-source Meet bots verified via code-search: Vexa (`vexa-bot/.../googlemeet/selectors.ts`), recall.ai ×2, TranscripTonic, meeto, zuko, DeepGaurd, hermes-agent, alcaprar, neelance, CrankyHippo.
- `jsname`/`jscontroller` = Google **Wiz** framework wiring (Closure+JsAction) — why they outlast CSS classes (but jscontroller DID rotate for this widget; jsname held).
- Recall RE + the "speaking is audio, not AX" conclusion: `docs/meet-active-speaker-no-hardcoded-css.md`.
- Everything in this handoff was verified live on 2026-07-03 unless marked structural/inferred.
