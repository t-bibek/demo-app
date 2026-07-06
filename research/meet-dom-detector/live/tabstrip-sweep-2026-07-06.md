# M2 measurement sweep — Meet tab-away keep-alive (tab-strip S1 + mic S2)

**Date:** 2026-07-06 · **Repo:** demo-app @ `82e85f70bf` (adds `AXSnapshot chrome-window --skip-webarea/--no-wake`)
**Environment:** screen unlocked (`IOConsoleLocked=false`), `caffeinate` running, AX trust = TRUSTED for the driving terminal.

Two signals measured per cell:
- **S1 — tab-strip per-tab AXTitles**: `swift run AXSnapshot chrome-window --skip-webarea` (from `macos/`).
  Per-tab title lives on `AXRadioButton [AXTabButton] .Tab` nodes under `AXTabGroup .HorizontalTabStripRegionView`,
  carried in the node's **`AXDescription`** (NOT `AXTitle`); the active tab has `AXSelected=true`.
- **S2 — mic state**: the existing `bubbles-mic-detector` binary, run ONCE for the whole sweep, timestamped.
  Line protocol: `MIC_ACTIVE [app=.. bundle=.. pid=N]` / `MIC_IDLE` / `LOG ..`; state-transition-driven.

**Rig setup deltas vs the usual Meet rig (per plan):** rig Chrome launched with `--use-fake-ui-for-media-stream`
(auto-grant getUserMedia) and **WITHOUT** `--use-fake-device-for-media-stream`, so Chrome captured the **REAL**
`MacBook Pro Microphone`. Isolated `--user-data-dir` on debugging port 9333; a separate PERSONAL Chrome (pid 89036)
stayed running throughout and was never touched. Tab control (activate / new tab / minimize / leave / mute) driven
over CDP. Reused `research/meet-dom-detector/live/cdp-lib.js` (launch + WS + evalJs) and the `create-meeting.js`
signed-in-auth-copy join flow, adapted to the real-mic flags.

**Meeting:** `https://meet.google.com/vor-sjpu-jga` · **code `vor-sjpu-jga`** (host-created fresh room, 1 participant).

> Attribution note: per-PID mic attribution WAS available — the driving terminal holds microphone TCC, so the
> detector reported `bundle="com.google.Chrome" pid=48584` on the ACTIVE transition (not a bare `MIC_ACTIVE`).

---

## Verbatim tab titles (the load-bearing strings)

- **In-call (cells 2–5), Meet tab:** `Meet - vor-sjpu-jga`
  Dash style: all three `-` are **U+002D HYPHEN-MINUS** (NOT en-dash `–`/em-dash `—`). Window title:
  `Meet - vor-sjpu-jga - Google Chrome - Bibek922`.
- **Post-leave (cells 7–8), Meet tab:** `Meet - vor-sjpu-jga - Memory usage - 342 MB`
  (Chrome appended a per-tab memory badge on the now-idle tab; the code `vor-sjpu-jga` is still cleanly present.)
- **Post-leave + `--no-wake` (cell 10), Meet tab:** `Google Meet` — **generic, NO code** (see S1 findings).

---

## Per-cell results

| # | Cell | Dump (staged) | Meet tab AXTitle (verbatim) | code? | strip nodes / depth | mic log excerpt |
|---|------|---------------|-----------------------------|-------|---------------------|-----------------|
| 1 | Control (non-Meet tabs) | `cell1-control.json/.txt` | *(no Meet tab)* — `Example Domain`, `Wikipedia` | **N** (FP check: no false code) | 54 / 9 | `20:12:51 MIC_IDLE` |
| 2 | In-call, Meet tab ACTIVE | `cell2-incall-active.*` | `Meet - vor-sjpu-jga` (SELECTED) | **Y** `vor-sjpu-jga` | 43 / 9 | `20:17:00 MIC_ACTIVE app="Google Chrome" bundle="com.google.Chrome" pid=48584` |
| 3 | In-call, Meet tab BACKGROUND (KEY) | `cell3-incall-background.*` (+ `cell3-paired-chrome-webarea-*`) | `Meet - vor-sjpu-jga` (not selected) | **Y** `vor-sjpu-jga` | 53 / 9 | still `MIC_ACTIVE` (no transition) |
| 4 | In-call, window MINIMIZED | `cell4-incall-minimized.*` | `Meet - vor-sjpu-jga` (SELECTED) · note `minimized=true` | **Y** `vor-sjpu-jga` | 42 / 9 | still `MIC_ACTIVE` |
| 5 | In-call, MUTED in Meet | `cell5-incall-muted.*` | `Meet - vor-sjpu-jga` (SELECTED) | **Y** `vor-sjpu-jga` | 43 / 9 | still `MIC_ACTIVE` — **no MIC_IDLE after in-app mute** |
| 6 | 2nd app grabs mic concurrently | — | — | — | — | **NOT-RUN** (no no-TCC-prompt path) |
| 7 | After LEAVE, tab foreground | `cell7-postleave-foreground.*` | `Meet - vor-sjpu-jga - Memory usage - 342 MB` (SELECTED) | **Y** `vor-sjpu-jga` | 43 / 9 | `20:27:38 MIC_IDLE` (leave clicked 20:27:37 → **~1s**) |
| 8 | After leave, tab backgrounded | `cell8-postleave-background.*` | `Meet - vor-sjpu-jga - Memory usage - 342 MB` (not selected) | **Y** `vor-sjpu-jga` | 53 / 9 | `MIC_IDLE` |
| 9 | Remote end while backgrounded | — | — | — | — | **NOT-RUN** (single-participant rig; no cheap 2nd/host party to end from) |
| 10 | `--no-wake` repeat of cell 3 | `cell10-nowake-background.*` | `Google Meet` (passive-reader tree) | **N** — code absent | 53 / 9 | `MIC_IDLE` (post-leave) |

*strip nodes = `nodeCount` of the rig window's `chrome-window` root (native chrome only; web area recorded but not
descended). All Meet-tab bounds were stable at `@(550,26 256x41)` across cells 2/3/4/7/8 — geometry survives even
`minimized=true` (the AX node keeps its layout coordinates when the window is off-screen).*

---

## S1 verdict checks (tab-strip)

- **Background titles readable:** ✅ cell 3 — with the Meet tab backgrounded, its `AXTabButton` description is still
  present and code-bearing in the strip. The `chrome-window` tab strip enumerates ALL tabs regardless of which is active.
- **Minimized titles readable:** ✅ cell 4 — window note `minimized=true`, all 3 tab titles (incl. the code-bearing
  Meet tab, still `AXSelected`) survive. Bounds remain valid (`@(550,26 256x41)`).
- **code == URL code per the 3-[3,4]-3 regex:** ✅ `vor-sjpu-jga` = `vor(3)-sjpu(4)-jga(3)`;
  `re.fullmatch(r'[a-z]{3}-[a-z]{3,4}-[a-z]{3}')` PASS; equals the URL path segment exactly.
- **Bounds actuals:** ✅ Meet tab tile `@(550,26 256x41)` (256-px fixed-width tabs; strip at y=26). Stable across
  active / background / minimized / post-leave.
- **Control false-positive check:** ✅ cell 1 — `Example Domain` and `Wikipedia` yielded NO code match (code=-).
  The 3-[3,4]-3 regex did not false-fire on non-Meet titles.

**S1 conclusion:** the tab-strip AXTitle is a robust tab-away keep-alive signal — it survives the Meet tab being
**backgrounded** AND the window being **minimized**, which the alternative (per-tab web-area URL) does NOT (below).

### Paired `chrome` (web-area) dump — the contrast that motivates S1

Cell 3 paired plain `chrome` dump (`AXSnapshot chrome --url vor-sjpu-jga`): **the backgrounded Meet tab's AXWebArea
is ABSENT** — `--url vor-sjpu-jga` matched **no web area** across either Chrome process; a full-tree grep for the code
across every exposed web area returned nothing (`cell3-paired-chrome-webarea-chrome-other{1..4}` are the only web
areas Chrome exposed: the personal Chrome's active docs/chatgpt tabs + the rig's now-active example.com). So the
web-area/URL detection path **goes blind for a backgrounded tab**, while the `chrome-window` tab-strip path retains
the code. This is the core justification for measuring the tab strip.

### `--no-wake` caveat (cell 10)

With the a11y wake force OFF (passive-reader tree), the strip still enumerates the tabs, but the Meet tab title
degrades to the generic **`Google Meet`** with **no code**. The woken tree (default, cells 2–8) is what materializes
the specific code-bearing per-tab title. **The S1 signal REQUIRES the `AXManualAccessibility` /
`AXEnhancedUserInterface` wake** — a passive reader alone cannot extract the meeting code from the strip.
(Cell 10 was captured post-leave; the generic-title-without-wake result is the takeaway regardless.)

---

## S2 findings (mic)

Full timeline (`tabstrip-captures-2026-07-06/mic-sweep.log`):

```
20:12:51 LOG watching audio devices: [BlackHole 2ch, MacBook Pro Microphone, Microsoft Teams Audio]
20:12:51 LOG bubbles root pid: 48276
20:12:51 MIC_IDLE
20:17:00 LOG device "MacBook Pro Microphone" in-use users=[Google Chrome (pid 48584)]
20:17:00 MIC_ACTIVE app="Google Chrome" bundle="com.google.Chrome" pid=48584
20:27:38 LOG device "MacBook Pro Microphone" idle
20:27:38 MIC_IDLE
```

- **Active on join:** ✅ Meet grabbing the real mic on join flipped `MIC_IDLE → MIC_ACTIVE` at 20:17:00.
- **Attribution available:** ✅ full `app` / `bundle=com.google.Chrome` / `pid=48584` (terminal has mic TCC).
- **Active persists while backgrounded / minimized:** ✅ no transition through cells 3 and 4.
- **Active persists through in-app MUTE (cell 5):** ✅ **muting in the Meet UI did NOT emit MIC_IDLE** — Meet holds
  the OS input device open (the getUserMedia stream stays live) while client-side muted. An in-app mute is therefore
  **invisible** to the OS mic-device signal.
- **IDLE latency on LEAVE (cell 7):** Leave clicked **20:27:37** → `MIC_IDLE` **20:27:38** = **~1 second** for Chrome
  to release the mic device after the call ends.

**S2 conclusion:** `MIC_ACTIVE/IDLE` is a clean, low-latency (~1s) "is a mic-using call live" signal that S1 alone
cannot provide — critically, it disambiguates *left the call* from *still on the meeting URL* (see open item below).
It cannot see an in-app mute (by design — the device stays open).

---

## Synthesis for the keep-alive design

- **S1 (tab strip)** answers "is there a Meet-code tab in this window" and survives background + minimize + no-wake
  enumeration — but the code **persists in the title after you leave** (cells 7/8: URL stays `meet.google.com/<code>`,
  title still code-bearing on Meet's post-call landing page). Title alone cannot tell in-call from just-left.
- **S2 (mic)** disambiguates: mic ACTIVE ⇒ a call is live capturing audio; mic IDLE (arriving ~1s after leave) ⇒ the
  call ended even though the code tab lingers. The two signals are complementary: **S1 for identity/persistence,
  S2 for liveness.** (Caveat: S2 can't see an in-app mute, and S2 attribution needs mic TCC on the responsible app.)

---

## Open items

1. **Post-leave title persistence** (cells 7/8): the meeting code stays in the tab title on Meet's post-call landing
   page, so an S1-only keep-alive would falsely read "still in a Meet" after leaving. The mic S2 signal (or a Meet
   web-area "Return to home screen" / call-ended DOM probe) is required to close this. Recommend gating keep-alive on
   S1 ∧ S2.
2. **`--no-wake` gives generic `Google Meet` title, no code:** the S1 signal depends on the a11y wake force being
   applied (as the product detector already does). Confirm the product's keep-alive reader forces
   `AXManualAccessibility`/`AXEnhancedUserInterface` before reading the strip.
3. **Chrome `- Memory usage - N MB` title suffix:** appeared on the idle/backgrounded tab post-leave; a build-specific
   Chrome badge. Code extraction is unaffected (regex still isolates the 3-[3,4]-3 segment), but the title-parse must
   tolerate arbitrary suffixes rather than exact-matching `Meet - <code>`.
4. **Cell 6 (concurrent 2nd mic grabber): NOT-RUN** — no path to grab the mic from a second process without risking a
   new microphone TCC prompt on the user's machine (forbidden by the plan). Needs a pre-authorized helper to measure
   how the detector attributes/reports two concurrent mic users.
5. **Cell 9 (remote end while backgrounded): NOT-RUN** — this sweep is single-participant by design; there is no cheap
   second/host party to end the meeting remotely. Would need the 3-party roster rig (`roster-rig-3p.js`) to script a
   remote host-ends-call and observe S1/S2 on the backgrounded tab. Deferred.
6. **Edge/Brave live-Meet repeat (part of cell 10): NOT-RUN.** Both are installed
   (`/Applications/Microsoft Edge.app`, `/Applications/Brave Browser.app`) and AXSnapshot already recognizes their
   bundle IDs (`com.microsoft.edgemac`, `com.brave.Browser`), so the `chrome-window` target should work unchanged, but
   spinning a full real-mic Meet in each is out of the single-rig scope. Deferred to a follow-up cross-browser pass.

---

## Artifacts

- Per-cell dumps (JSON + readable TXT) + mic log: `research/meet-dom-detector/live/tabstrip-captures-2026-07-06/`
  (non-gitignored staging; to be promoted to product fixtures in Phase B).
- Source dumps originate from `macos/ax-dumps/<timestamp>/` (gitignored); the rig-window root was copied out per cell.
