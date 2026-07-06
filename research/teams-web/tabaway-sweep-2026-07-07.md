# G2a — Teams-WEB tab-away measurement sweep (bridge-build gate)

**Date:** 2026-07-07 · **Repo:** demo-app @ `01fbf1f` (+ additive AXSnapshot PID-disambig fix, see §Tooling)
**Environment:** screen UNLOCKED (`IOConsoleLocked=false` — AX tree valid), `caffeinate` running, AX trust = TRUSTED for the driving terminal.
**Gate question:** should a Teams-web bridge adapter be built AT ALL? Decided by the green-light criteria in §Verdict.

## What was measured, and how

Two signals per cell, same rig template as the Meet M2 sweep (`research/meet-dom-detector/live/tabstrip-sweep-2026-07-06.md`):

- **S1 — tab-strip per-tab label**: `swift run AXSnapshot chrome-window --skip-webarea` (from `macos/`).
  Per-tab label lives on `AXRadioButton [AXTabButton] .Tab` nodes' **`AXDescription`** under the tab strip;
  the active tab has `AXSelected=true`. Chrome appends a ` - Memory usage - NNN MB` badge to non-hovered tabs and
  ` - Audio playing` to audible tabs — the meeting SUBJECT prefix is the load-bearing part.
- **S1b — paired web-area readability**: `swift run AXSnapshot chrome --url teams.live.com` — the ALTERNATIVE
  (per-tab AXWebArea/URL) detection path. Whether it goes STUB/blind for a backgrounded tab is the GO/NO-GO premise.
- **S2 — mic state**: the product `bubbles-mic-detector`, run for the whole sweep, timestamped
  (`tabaway-captures-2026-07-07/mic-sweep.log`). Line protocol: `MIC_ACTIVE/MIC_IDLE` + per-device in-use user list.

**Rig setup (per plan):**
- **Host** = the NATIVE Teams app (`com.microsoft.teams2`, signed in as "Bibek Thapa", Profile 3), hosting a
  `teams.live.com` (consumer) meeting — link harvested via the Meet page → meeting card → "Share link" (clipboard).
  Consumer `teams.live.com` allows **anonymous web-guest join** — NO Microsoft login wall was hit (see §Login).
- **Measured web tab** = the rig's PERSISTENT signed-in Chrome profile
  `research/meet-dom-detector/live/.rig-profiles/host`, launched IN PLACE on CDP port 9351 with
  `--use-fake-ui-for-media-stream` and **NO** `--use-fake-device-for-media-stream` → captured the **REAL**
  `MacBook Pro Microphone` (so the OS mic-device signal genuinely flips). Clean-quit only (Browser.close→SIGTERM);
  the persistent profile was NEVER SIGKILLed or rm'd and is intact.
- **Audible sub-cell only** — one EXTRA fake-audio guest (ephemeral /tmp profile, SIGKILL ok, WAV-backed gUM
  override on port 9352) that speaks a looping voice buffer on demand, so the MEASURED tab RECEIVES remote speech
  (= Chrome throttle exemption) without needing to inject audio into anyone's real mic.
- A separate PERSONAL Chrome (pid 89036) stayed running throughout and was **never touched** (it produced the
  `chrome-other*` github/chatgpt web areas — their URLs are REDACTED from the committed STDOUT evidence).

Driver: `research/teams-web/tabaway-sweep-driver.mjs` (reuses `cdp-lib.js` launch/WS/evalJs + `fake-mic-override.js`);
native host driven by `macos/.build/debug/TeamsDrive` (press/find/admit). Meeting secrets (passcode / meeting id)
are REDACTED from all committed captures.

## Verbatim labels (the load-bearing strings)

- **In-call web tab (T2–T7), all states:** `Meeting with Bibek Thapa | Microsoft Teams`
  (= the meeting SUBJECT + literal ` | Microsoft Teams` suffix). **No `(n)` unread prefix. No mutation across
  background / minimize / leave.** All three pipes/spaces exact; the subject is whatever the organizer named the
  meeting.
- **Teams CHAT tab (control / T9 second tab):** `Chat | Test | Microsoft Teams` — a DIFFERENT subject, same suffix.
- **Wikipedia FP tab (T1):** `Microsoft Teams - Wikipedia` — contains "Microsoft Teams" but **NOT** "`| Microsoft Teams`".
- Window title (in-call): `Meeting with Bibek Thapa | Microsoft Teams - Google Chrome - Bibek922`.

## Per-cell results

| # | Cell | Curated dump(s) | Verbatim tab label | AXSelected | blindness / notes | mic |
|---|------|-----------------|--------------------|-----------|-------------------|-----|
| **T1** | Control: Teams CHAT tab + others, no call | `T1-control-chat.*` | chat=`Chat \| Test \| Microsoft Teams`; also `Microsoft Teams - Wikipedia`, `Example Domain`, `about:blank` | chat=True | **FP baseline:** `\| Microsoft Teams` pipe-anchored ⇒ **1 match** (chat). Loose `Microsoft Teams` ⇒ **2** (chat + Wikipedia FP). | IDLE (no call) |
| **T2** | In-call, web tab FOREGROUND | `T2-incall-fg-tabstrip.*` + `T2-incall-fg-webarea.*` | `Meeting with Bibek Thapa \| Microsoft Teams` | **True**, frame `@(74,26 256x41)` | web-area READABLE (baseline): paired `chrome` dump = `chrome-teams-web` **151 nodes** at `teams.live.com/v2/` | Chrome (pid 81714) grabs real mic → device users=[Teams, **Chrome**] |
| **T3-quiet** | In-call, web tab BACKGROUND >10s, everyone muted **(KEY)** | `T3-quiet-bg-tabstrip.*` + `T3-quiet-bg-paired-webarea-STDOUT.txt` | `Meeting with Bibek Thapa \| Microsoft Teams` (label **PERSISTS**, no unread mutation) | False (blank tab selected) | **BLIND CONFIRMED:** paired `chrome --url teams.live.com` ⇒ *"matched no web area … No meeting tab found"*; `v2` web area ABSENT | still ACTIVE (no transition) |
| **T3-audible** | Same, but remote speech PLAYING in tab (2nd guest speaking) | `T3-audible-*` | label persists (`label` cmd: `Meeting with Bibek Thapa \| Microsoft Teams`); `audible? anyPlaying:true` | — | **STILL BLIND:** measured `v2` web area ABSENT even when audible; only the 2nd guest's own FOREGROUND tab exposed a web area. Bonus: Chrome tags an audible tab ` - Audio playing` in the strip. | ACTIVE |
| **T4** | In-call, window MINIMIZED | `T4-incall-minimized-tabstrip.*` | `Meeting with Bibek Thapa \| Microsoft Teams` (**survives**) | **True** (window `AXMinimized=True`) | label + AXSelected survive minimize; tab geometry retained | ACTIVE |
| **T5** | In-call, in-app MUTE via Teams WEB UI | (mic log) | — (mute confirmed in web DOM: `aria-label="Unmute mic"`, `Myself … Muted`) | — | — | **NO MIC_IDLE.** Device stayed `users=[Teams, Chrome]` through mute — **Teams-web HOLDS the OS input device through an in-app mute** (like Meet). Mute is invisible to the mic-device signal. |
| **T6** | Post-leave, tab FOREGROUND | `T6-postleave-fg-tabstrip.*` | `Meeting with Bibek Thapa \| Microsoft Teams` (**UNCHANGED** post-leave) | True | label does NOT change on leave — strip alone cannot tell in-call from just-left | **Release ≈ <1s:** Leave 00:34:40 → device drops to `users=[Teams]` at 00:34:40 (Chrome pid 81714 released) |
| **T7** | Post-leave, tab BACKGROUND | `T7-postleave-bg-tabstrip.*` | `Meeting with Bibek Thapa \| Microsoft Teams` (persists) | False | same as T3 — strip label survives regardless of call state | Chrome released (host still holds device) |
| **T8** | `--no-wake` repeat of T3 (never-woken baseline) | `T8-nowake-bg-tabstrip.*` | `Meeting with Bibek Thapa \| Microsoft Teams` — **FULL subject present, 59 nodes** | False | **Differs from Meet:** the strip label does NOT degrade without the AX wake force (Meet degraded to generic "Google Meet"). Teams-web label is readable in the PASSIVE-reader tree — no `AXManualAccessibility` needed. | — |
| **T9** | TWO Teams tabs (meeting + chat), meeting BACKGROUND | `T9-two-tabs-meeting-bg-tabstrip.*` | meeting=`Meeting with Bibek Thapa \| Microsoft Teams` (sel=False); chat=`Chat \| Test \| Microsoft Teams` (sel=True) | meeting=False | **Remembered-label matcher (exact subject) ⇒ single-match (picks the meeting).** Existence-fallback (`\| Microsoft Teams`) ⇒ **2 matches** (meeting + chat, ambiguous). | ACTIVE (rejoined) |

## Full mic timeline (`tabaway-captures-2026-07-07/mic-sweep.log`)

```
00:15:07 MIC_ACTIVE app="Microsoft Teams" bundle="com.microsoft.teams2" pid=81187   # native host joins
00:18:31 device "MacBook Pro Microphone" in-use users=[Microsoft Teams (pid 81187), Google Chrome (pid 81714)]  # T2 web guest joins (real mic)
   … T5 web-UI mute at 00:32:48 → NO transition (device held) …
00:34:40 device "MacBook Pro Microphone" in-use users=[Microsoft Teams (pid 81187)]  # T6 web guest leaves → Chrome released (<1s)
00:37:16 device "MacBook Pro Microphone" in-use users=[Microsoft Teams (pid 81187), Google Chrome (pid 81714)]  # T9 rejoin
00:39:37 device "MacBook Pro Microphone" idle → MIC_IDLE   # teardown (host + guest released)
```

Per-PID mic ATTRIBUTION was available (the driving terminal holds mic TCC), so Chrome's grab/release is visible in
the device user-list even though the native host keeps the global device open (no bare `MIC_IDLE` until both leave).

## <a name="login"></a>Login-wall status

**NOT blocked.** Hosting from native Teams and sharing a `teams.live.com` (consumer) link let the rig Chrome join
via the anonymous **"Continue on this browser" → name → Join now** path with **no Microsoft sign-in wall**. The guest
landed in the meeting LOBBY and was ADMITTED from the native host ("Admit participant in lobby"). Guest display name
fell back to the profile name ("bibek thapa") rather than the typed "QA Web Guest" on this consumer flow — cosmetic,
does not affect any measured signal.

## <a name="verdict"></a>GO / NO-GO verdict — **GO**

Green-light criteria (all must hold; any red = NO-GO):

| Criterion | Result | Evidence |
|-----------|--------|----------|
| **T3(a)** background label stable-or-normalizable | ✅ **STABLE** — `Meeting with Bibek Thapa \| Microsoft Teams` persists verbatim through background (T3), minimize (T4), leave (T6/T7), and even the `--no-wake` passive tree (T8). No `(n)` unread mutation observed. | T3/T4/T7/T8 dumps |
| **T3(b)** blindness confirmed (≥ quiet sub-cell) | ✅ **CONFIRMED in BOTH sub-cells** — the backgrounded Teams `AXWebArea` (`teams.live.com/v2`) is ABSENT from the paired `chrome` dump when quiet AND when audible. The web-area/URL path goes blind; the tab-strip path retains the subject. | `T3-quiet-bg-paired-webarea-STDOUT.txt`, `T3-audible-paired-webarea-STDOUT.txt` |
| **T5** mic posture recorded | ✅ Teams-web HOLDS the OS input device through an in-app mute (no `MIC_IDLE`); releases in ≈ <1s on leave. Mic-device signal disambiguates *left* from *still-on-URL* but is blind to in-app mute (identical to Meet). | mic-sweep.log |
| **T9** single-match feasible | ✅ A remembered exact-subject matcher picks EXACTLY the meeting tab (1) among meeting+chat; the existence-fallback `\| Microsoft Teams` multi-matches (2). | `T9-two-tabs-meeting-bg-tabstrip.*` |

**All four green. → GO: build the Teams-web bridge adapter.**

### Design guidance for the bridge (falls out of the sweep)

1. **Primary signal = the tab-strip `AXTabButton` AXDescription**, matched against a **remembered exact meeting-tab
   subject** captured while the tab is foreground/in-call. It survives background + minimize + `--no-wake`, and — unlike
   Meet — needs **no `AXManualAccessibility` wake** to stay subject-specific. The paired web-area/URL path is NOT
   usable for a backgrounded tab (goes blind), which is the whole reason the strip path is needed.
2. **Existence-fallback (`| Microsoft Teams`) is a WEAK secondary only** — it false-matches the Teams CHAT tab (T1,
   T9) and cannot distinguish meeting from chat. Use it solely to detect "some Teams tab exists", never to pick THE
   meeting tab. Anchor on the pipe (`| Microsoft Teams`), not bare "Microsoft Teams" (the latter FP's on e.g.
   `Microsoft Teams - Wikipedia`).
3. **Pair with the mic-device signal for liveness** — the strip label is IDENTICAL in-call vs just-left (T6). Only the
   Chrome mic-device grab/release disambiguates an active call from a stale post-call tab. In-app mute does NOT release
   the device, so a muted-but-in-call user still reads as mic-active (correct for "is a call live").

## <a name="tooling"></a>Tooling note (additive AXSnapshot fix, needed for a reliable sweep)

Two Chrome PROCESSES (the personal Chrome + the `--user-data-dir` rig Chrome) share the "Google Chrome"
`localizedName`, so `chrome-window` dumps collided on disk (`chrome-window-Google Chrome-1.json` from a later window
clobbered an earlier same-labeled one — the MINIMIZED measured window was silently lost on the first T4 attempt).
Fixed additively in `macos/Sources/AXSnapshot/main.swift`: the `chrome-window` root label now includes the owning
**PID** (`chrome-window-Google Chrome-pid<PID>-<i>`) so every window gets a unique filename. Only the `chrome-window`
label string changed; all other targets/labels are unchanged.
