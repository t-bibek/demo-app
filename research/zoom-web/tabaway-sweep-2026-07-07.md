# G3a — Zoom-WEB tab-away measurement sweep (bridge-build gate)

**Date:** 2026-07-07 · **Repo:** demo-app @ `4f095f5` (the additive AXSnapshot PID-disambig fix from the Teams G2a sweep is already in `main`; see §Tooling)
**Environment:** screen UNLOCKED (`IOConsoleLocked=false` — AX tree valid), `caffeinate`/system awake, AX trust = TRUSTED for the driving terminal (holds mic TCC → per-PID device attribution).
**Gate question:** should a Zoom-web bridge adapter be built AT ALL? Decided by the green-light criteria in §Verdict.

## What was measured, and how

Two signals per cell, same rig template as the Teams G2a sweep (`research/teams-web/tabaway-sweep-2026-07-07.md`):

- **S1 — tab-strip per-tab label**: `swift run AXSnapshot chrome-window --skip-webarea` (from `macos/`).
  Per-tab label lives on `AXRadioButton [AXTabButton]` nodes' **`AXDescription`** under the tab strip;
  the active tab has `AXSelected=true`. Chrome appends a ` - Memory usage - NNN MB` badge to non-hovered tabs —
  the meeting-tab PREFIX (`<host>'s Zoom Meeting`) is the load-bearing part.
- **S1b — paired web-area readability**: `swift run AXSnapshot chrome --url app.zoom.us` — the ALTERNATIVE
  (per-tab AXWebArea/URL) detection path. Whether it goes blind for a backgrounded tab is the GO/NO-GO premise.
- **S2 — mic state**: the product `bubbles-mic-detector`, streamed for the whole sweep, timestamped
  (`tabaway-captures-2026-07-07/mic-sweep.log`). Line protocol: `MIC_ACTIVE/MIC_IDLE` + per-device in-use user list.

**Rig setup (per plan):**
- **Host** = the NATIVE Zoom app (`us.zoom.xos`, signed in as **"David Thapa"**, FREE tier — `us04web`), hosting an
  instant meeting bootstrapped + invite-harvested via the proven ZoomDrive flow (`qa/zoom-live/zoom-host-lib.mjs`:
  `bootstrapMeeting`/`harvestInvite`/`admitLoop`). Web guests joined via the `/wc/join/<id>?pwd=<pwd>&un=<name>`
  web-client link as guests and were admitted from the waiting room by the native host.
- **Measured web tab** = the rig's PERSISTENT signed-in Chrome profile
  `research/meet-dom-detector/live/.rig-profiles/host`, launched IN PLACE on CDP port 9371 with
  `--use-fake-ui-for-media-stream` and **NO** `--use-fake-device-for-media-stream` → captured the **REAL**
  `MacBook Pro Microphone` (so the OS mic-device signal genuinely flips — needed for Z5). Clean-quit only
  (Browser.close → SIGTERM); the persistent profile was NEVER SIGKILLed or rm'd and is intact.
- **Audible sub-cell** — one EXTRA fake-audio guest (ephemeral /tmp profile, SIGKILL ok, WAV-backed gUM override
  on port 9372) that speaks a looping voice buffer on demand, so the MEASURED tab RECEIVES remote speech (= Chrome
  throttle exemption) without injecting audio into anyone's real mic. Quiet sub-cell = extra guest silent.
- A separate PERSONAL Chrome (pid 89036) stayed running throughout and was **never touched** (its windows +
  its `chrome-other*` web areas are REDACTED / removed from the committed captures).

Driver: `research/zoom-web/tabaway-sweep-driver.mjs` (reuses `cdp-lib.js` launch/WS/evalJs + `fake-mic-override.js`;
command-file REPL, mirror of the Teams `tabaway-sweep-driver.mjs`); native host driven by
`macos/.build/debug/ZoomDrive` via `research/zoom-web/host-bootstrap.mjs`. Helpers: `zw.sh` (send cmd + await seq),
`cap.sh` (AXSnapshot + curate), `extract-tabs.py` (tab-strip label/selected extractor). Meeting secrets
(meeting id / passcode / wpk / routing tokens) are REDACTED from all committed captures.

## Verbatim labels (the load-bearing strings)

- **In-call web tab (Z2–Z4, Z8, Z9), all states:** `David Thapa's Zoom Meeting`
  (= `<host display name>'s Zoom Meeting` — Zoom's default instant-meeting topic). Chrome appends
  ` - Memory usage - NNN MB` on non-hovered tabs. **No `(n)` unread prefix. No mutation across background /
  minimize / `--no-wake`.** The `document.title` matches the tab-strip `AXDescription` exactly (minus the badge).
- **app.zoom.us HOME tab (Z1 control / Z9 second tab):** bare **`Zoom`** (both tab-strip label and title).
- **Wikipedia FP tab (Z1 control):** `Zoom Communications - Wikipedia` — contains "Zoom" but NOT "`Zoom Meeting`".
- **POST-LEAVE (Z6/Z7):** the meeting tab NAVIGATES to `https://app.zoom.us/wc/` and its label reverts to bare
  **`Zoom`** — the `... Zoom Meeting` subject is GONE the instant you leave (unlike Meet/Teams, whose subject
  label survives leave).
- **Join-screen transient:** `Zoom meeting on web` (only while on the pre-join `/wc/.../join` screen before admit).

## Per-cell results

| # | Cell | Curated dump(s) | Verbatim tab label | AXSelected | blindness / notes | mic |
|---|------|-----------------|--------------------|-----------|-------------------|-----|
| **Z1** | Control: app.zoom.us home tab + others, no call | `Z1-control--*pid86305-2` | home=`Zoom`; also `Example Domain`, `Zoom Communications - Wikipedia`, `about:blank` | wiki=True | **FP baseline:** bare token `Zoom` ⇒ **2+ matches** (home `Zoom` + loose substring in `Zoom Communications - Wikipedia`). `Zoom Meeting` token ⇒ **0** (no call). The home tab is indistinguishable from a post-leave meeting tab. | IDLE (only native host, no web guest yet) |
| **Z2** | In-call, web tab FOREGROUND | `Z2-incall-fg--*pid86305-2` + `Z2-incall-fg-webarea--chrome-zoom-web` | `David Thapa's Zoom Meeting` | **True**, frame `@(74,26 256x41)` | web-area READABLE (baseline): paired `chrome --url app.zoom.us` = `chrome-zoom-web` **162 nodes** at `app.zoom.us/wc/…/join` | Chrome (pid 86499 audio-service) grabs REAL mic → device users=[zoom.us, **Google Chrome**] |
| **Z2b** | In-call, CUSTOM topic attempt | (driver.log seq 9) | rename **NOT DRIVABLE** from the web guest (`info-opened-no-topic-field`) — topic edit is host-only and absent from the live-meeting web UI. Default topic `David Thapa's Zoom Meeting` **carries the `Zoom Meeting` token.** | — | **Existence-fallback caveat:** a HOST who renames to a bare custom topic (e.g. "Standup") would produce a tab label with **NO Zoom token at all** — so the existence-fallback (any "Zoom" token) is BLIND to a custom-topic meeting. Only a remembered exact-subject match is topic-agnostic. See §Verdict note. | — |
| **Z3-quiet** | In-call, web tab BACKGROUND >10s, silent **(KEY)** | `Z3-quiet-bg--*pid86305-2` + `Z3-quiet-bg-paired-webarea--STDOUT` | `David Thapa's Zoom Meeting` (**PERSISTS** verbatim, no mutation) | False (blank tab selected) | **BLIND CONFIRMED:** paired `chrome --url app.zoom.us` ⇒ *"matched no web area across N Chrome process(es)… No meeting tab found"*; the `app.zoom.us/wc` web area is ABSENT from the AX tree when backgrounded | Chrome still holds device |
| **Z3-audible** | Same, but remote speech PLAYING in tab (2nd guest speaking) | `Z3-audible-bg--*pid86305-2` + `Z3-audible-bg-paired-webarea--STDOUT` (+ guest-own-FG `pid86824`) | label persists (`David Thapa's Zoom Meeting`); `audible? anyPlaying:true, mediaEls:4` | False | **STILL BLIND:** the `app.zoom.us/wc` web area is ABSENT even when the tab is audible; only the 2nd guest's OWN FOREGROUND tab (`pid86824`, its own `David Thapa's Zoom Meeting` tab) exposed a readable tree. Audibility does NOT lift the backgrounded-tab AX blindness. | ACTIVE |
| **Z4** | In-call, window MINIMIZED | `Z4-minimized--*pid86305-1` | `David Thapa's Zoom Meeting` (**survives**) | **True** (window `AXMinimized=True`) | label + AXSelected survive minimize; tab geometry retained | ACTIVE |
| **Z5** | In-call, in-app MUTE via Zoom WEB UI **(mic-termination decision point)** | (driver.log seq 23–25 + mic log) | — (mute confirmed: button flips to `unmute my microphone`; idempotent re-mute reports `already:unmute my microphone`) | — | — | **NO MIC_IDLE / NO device drop.** Device stayed `users=[zoom.us, Google Chrome (pid 86499)]` through the web-UI mute — **Zoom web HOLDS the OS input device through an in-app mute; it does NOT stop the getUserMedia tracks.** The mic-termination premise (Zoom web STOPS tracks on mute) is **FALSE** — Zoom web behaves like Meet and Teams-web here. |
| **Z6** | Post-leave, tab FOREGROUND **(navigation terminator)** | `Z6-postleave-fg--*pid86305-2` | tab NAVIGATES: URL `/wc/…/join` → **`app.zoom.us/wc/`**; title `David Thapa's Zoom Meeting` → **`Zoom`**; tab-strip label = bare `Zoom` (SELECTED) | True | **BETTER terminator than Meet/Teams:** leaving the meeting **navigates the tab off the `/wc/…/join` URL** and the strip label reverts to bare `Zoom`. A `tabGone`/URL-change/label-revert ends the bridge NATURALLY — no reliance on the mic signal to tell in-call from just-left (Meet/Teams keep their subject label post-leave). | **Chrome released:** a fresh mic-detector snapshot post-leave shows ONLY `zoom.us (pid 32498)` holding the device — the measured Chrome dropped it. (The long-running mic-sweep log only re-emits the device-user line on set CHANGES, so the release lacks its own line; the fresh probe is the release evidence.) |
| **Z6b** | Free-tier countdown in title? | (all Z2–Z8 dumps) | **NO countdown token** ever appeared in the tab title / tab-strip label across the full ~15-min in-call span — always `David Thapa's Zoom Meeting` (only the ` - Memory usage - NNN MB` badge varied). | — | The free-tier 40-min limit is an IN-MEETING banner, NOT reflected in the tab title — so there is **no title-level countdown cadence** and no label mutation to key off. | — |
| **Z7** | Post-leave, tab BACKGROUND | `Z7-postleave-bg--*pid86305-2` | bare `Zoom` (persists; same as the home tab) | False | post-leave the tab is INDISTINGUISHABLE from a plain Zoom home tab (`Zoom`) — the remembered `... Zoom Meeting` subject is gone, which is exactly the terminator signal | Chrome released (host still holds device) |
| **Z8** | `--no-wake` repeat of Z3 (never-woken passive tree) | `Z8-nowake-bg--*pid86305-2` | `David Thapa's Zoom Meeting` — **FULL subject present, 65 nodes** | False | **Like Teams (not Meet):** the strip label does NOT degrade without the AX wake force — the subject-specific label is readable in the PASSIVE-reader tree. **No `AXManualAccessibility` wake needed.** | — |
| **Z9** | TWO tabs (meeting + app.zoom.us home), meeting BACKGROUND | `Z9-two-tabs-meeting-bg--*pid86305-2` | meeting=`David Thapa's Zoom Meeting` (sel=False); home=`Zoom` (present); + `Example Domain`, wiki, `about:blank`×N | meeting=False | **Remembered exact-subject matcher (`David Thapa's Zoom Meeting`, captured while FG/in-call) ⇒ single-match (picks the meeting).** Bare-token existence-fallback (`Zoom`) ⇒ **3 matches** (meeting + `Zoom` home + `Zoom Communications - Wikipedia`), ambiguous. | ACTIVE (rejoined) |

## Full mic timeline (`tabaway-captures-2026-07-07/mic-sweep.log`)

```
00:53:07 MIC_ACTIVE app="zoom.us" bundle="us.zoom.xos" pid=32498                                        # native host in meeting
00:54:46 device "MacBook Pro Microphone" in-use users=[zoom.us (pid 32498), Google Chrome (pid 86499)]  # Z2 web guest admitted → REAL mic grab
00:55:04 device "MacBook Pro Microphone" in-use users=[zoom.us (pid 32498), Google Chrome (pid 86499)]  # held through Z5 web-UI MUTE (no drop)
   … Z6 leave 00:58:55 → running-log emits NO change line; a FRESH mic probe shows only zoom.us (pid 32498) → Chrome RELEASED …
01:00:31 device "MacBook Pro Microphone" in-use users=[zoom.us (pid 32498), Google Chrome (pid 86499)]  # Z8/Z9 REJOIN → mic re-grabbed
```

Per-PID mic ATTRIBUTION was available (the driving terminal holds mic TCC), so Chrome's grab/release is visible in
the device user-list even though the native host keeps the global device open (no bare `MIC_IDLE` until both leave).
NOTE on the release line: `bubbles-mic-detector` re-emits the device-user line only on a set CHANGE; at Z6-leave the
set change (Chrome removed) was not captured as a distinct line in the long-running instance, so release was verified
with a fresh short-lived detector run that showed only `zoom.us (pid 32498)`.

## <a name="login"></a>Login-wall status

**NOT blocked.** Hosting from the native Zoom app (free tier) and sharing the `/wc/join/<id>?pwd=<pwd>` web-client
link let the rig Chrome join via the **anonymous name → Join → Join Audio by Computer** guest path with **no Zoom
sign-in wall** (the meeting allows web-client guests; the guest waited in the waiting room and was ADMITTED from the
native host). The guest display name was accepted as "QA Web Guest".

## <a name="verdict"></a>GO / NO-GO verdict — **GO**

Green-light criteria (all must hold; any red = NO-GO):

| Criterion | Result | Evidence |
|-----------|--------|----------|
| **Z3(a)** background label stable-or-normalizable | ✅ **STABLE** — `David Thapa's Zoom Meeting` persists verbatim through background (Z3 quiet + audible), minimize (Z4), and the `--no-wake` passive tree (Z8). No `(n)` unread mutation, no countdown mutation (Z6b). | Z3/Z4/Z8 dumps |
| **Z3(b)** blindness confirmed (≥ quiet sub-cell) | ✅ **CONFIRMED in BOTH sub-cells** — the backgrounded Zoom `app.zoom.us/wc` AXWebArea is ABSENT from the paired `chrome --url app.zoom.us` dump when quiet AND when audible. The web-area/URL path goes blind; the tab-strip path retains the subject. | `Z3-quiet-bg-paired-webarea--STDOUT.txt`, `Z3-audible-bg-paired-webarea--STDOUT.txt` |
| **Z5** mic posture recorded | ✅ Zoom web **HOLDS** the OS input device through an in-app mute (no `MIC_IDLE`, no device drop) — it does NOT terminate the getUserMedia tracks on mute (premise refuted). Releases on LEAVE (fresh probe). Mic-device signal disambiguates *left* from *still-on-URL* but is blind to in-app mute (identical posture to Meet + Teams-web). | mic-sweep.log + driver.log seq 23–25 |
| **Z9** single-match feasible | ✅ A remembered exact-subject matcher picks EXACTLY the meeting tab (1) among meeting + `Zoom` home + others; the bare-token existence-fallback (`Zoom`) multi-matches (3). | `Z9-two-tabs-meeting-bg--*pid86305-2` |

**All four green. → GO: build the Zoom-web bridge adapter.**

### Design guidance for the bridge (falls out of the sweep)

1. **Primary signal = the tab-strip `AXTabButton` AXDescription**, matched against a **remembered exact meeting-tab
   subject** captured while the tab is foreground/in-call (e.g. `David Thapa's Zoom Meeting`). It survives background +
   minimize + `--no-wake` (like Teams-web, needs **no `AXManualAccessibility` wake**). The paired web-area/URL path is
   NOT usable for a backgrounded tab (goes blind), which is the whole reason the strip path is needed.
2. **Zoom's terminator is BETTER than Meet's/Teams' — exploit it.** On leave the tab NAVIGATES off `/wc/…/join` to
   `app.zoom.us/wc/` and the strip label reverts to bare `Zoom` (Z6/Z7). So the bridge can end cleanly on EITHER of two
   independent signals: (a) the remembered subject label disappearing from the strip, OR (b) the tab's URL leaving
   `/wc/…/join` / the tab closing. This is a stronger end-of-call signal than Meet/Teams, whose subject label survives
   leave and require the mic-release to disambiguate.
3. **The existence-fallback is DOUBLY weak on Zoom — do not rely on it to pick THE meeting tab.** (a) Bare token `Zoom`
   FALSE-matches the app.zoom.us home tab and loosely the Wikipedia FP (Z1, Z9). (b) The `Zoom Meeting` token only
   appears in the DEFAULT topic — a host who renames to a bare custom topic (Z2b) yields a label with NO Zoom token at
   all, so the existence-fallback goes fully blind to a custom-topic meeting. Use the existence-fallback SOLELY to
   detect "some Zoom tab exists", never to pick the meeting; the remembered exact-subject match is the only
   topic-agnostic picker.
4. **Pair with the mic-device signal for in-app-mute liveness.** In-app mute does NOT release the device (Z5), so a
   muted-but-in-call user still reads as mic-active (correct for "is a call live"). The strip-label revert + URL-change
   (Z6) already disambiguate in-call from just-left, so on Zoom the mic signal is a secondary confirmation rather than
   the sole terminator it is on Meet/Teams.

## <a name="tooling"></a>Tooling note

The additive AXSnapshot PID-disambiguation fix (the `chrome-window` root label carries the owning PID:
`chrome-window-Google Chrome-pid<PID>-<i>`) landed with the Teams G2a sweep and is in `main` — it was load-bearing
here too (two Chrome processes: the personal Chrome pid 89036 + the rig Chrome pid 86305 both share the "Google Chrome"
`localizedName`, so without the PID the measured window's dump would have collided on disk with the personal one).
No new tooling changes were needed for this Zoom-web sweep.
