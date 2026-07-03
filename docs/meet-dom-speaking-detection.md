# Google Meet speaking detection via the RAW DOM — findings, QA, and live rig

**Date:** 2026-07-02–03 · **Status:** class-independent structural detector; real browser 25/25 + Node 20/20; **LIVE end-to-end CONFIRMED** — real speech via BlackHole → host DOM → detector names the turn-wise speaker 81–94% on real Meet
**Scope:** a caption-free replacement for the fragile `kssMZb` speaking class, for a **DOM-based**
detector (content script / CDP / embedded webview). The accessibility-tree path is unchanged — see
[meet-active-speaker-no-hardcoded-css.md](meet-active-speaker-no-hardcoded-css.md).
**Code:** [`research/meet-dom-detector/`](../research/meet-dom-detector) · **Full report:** `~/.claude/google-meet-speaking-detection-analysis.md`

---

## 1. Two capture surfaces (why this doc is separate)

| Surface | Reads | Sees the durable speaking handle? |
|---------|-------|:--:|
| **Accessibility tree** — macOS `AXDOMClassList`, Windows UIA `ClassName` (what the app ships today) | HTML `class`/`id` only | ❌ `jsname`/`jscontroller`/`data-*` are **stripped** (verified; `window/docs/ARCHITECTURE.md:146`) |
| **Raw DOM** — content script / Chrome DevTools Protocol / embedded webview | everything | ✅ this doc |

On the AX surface a stable structural speaking indicator does **not** exist (proven in prior work and
re-verified) — you fuse audio-VAD + geometry + `kssMZb`-fallback. This doc is the **raw-DOM** story,
where a materially more stable signal exists.

---

## 2. The DOM speaking signals (caption-free)

**Captions are intentionally NOT used** (requirement: detection must work with CC off). Naming comes
from the tile roster.

Ranked most → least durable:

1. **`[data-audio-level]:not([data-audio-level="0"])`** on the participant tile — a *semantic* data
   attribute (Vexa's rotation-proof primary). Best "is this participant producing audio now" signal.
2. **The per-participant audio-level widget** — anchor **`jsname="QgSmzd"` + base class `IisKdb`**;
   speaking = **absence of the silence class `gjg47c`** (triple-confirmed: `speaking = !hasClass('gjg47c')`)
   and/or the equalizer bars animating (`getComputedStyle(bar).animationName !== 'none'`).
3. **Tile identity** — `data-participant-id` (fallbacks `data-requested-participant-id`, `data-ssrc`);
   name from `span.notranslate`.
4. **`.kssMZb`** tile ring — remote-config'd, telemetered **fallback only**.

All gated by **audio VAD** with a **"Someone"** floor.

### What rotates vs what holds (real evidence)
Between the 2026-06-25 capture and current open-source snapshots, the audio widget changed:

| Handle | 2026-06-25 | current | verdict |
|--------|-----------|---------|---------|
| `jsname` | `QgSmzd` | `QgSmzd` | **held** ✅ |
| base class | `IisKdb` | `IisKdb` | **held** ✅ |
| silence class | `gjg47c` | `gjg47c` | **held** ✅ |
| `jscontroller` | `tae9tc` | `ES310d` | **rotated** ❌ |
| bar child-classes | `UBNDXc/HPxjXe/DwvCqe` | `p21yBf/iitYmd` | **rotated** ❌ |
| speaking class | `HX2H7` | `HX2H7`/`Oaajhc`/… | **rotates** ❌ |

→ **Anchor on `jsname="QgSmzd"` + `IisKdb`; read speaking as absence of `gjg47c`.** Never anchor on
`jscontroller` (it rotated) or the obfuscated speaking class. (`tae9tc` is now stale: 0 GitHub Meet hits.)

`jsname`/`jscontroller` are Google **Wiz-framework** wiring (Closure + JsAction), runtime-load-bearing —
which is why they outlast the per-build obfuscated CSS classes.

---

## 2.5 LIVE VALIDATION on a real 2-person Meet (2026-07-03)

Driven end-to-end with a signed-in host + a joined guest (`live/` rig). Findings against the LIVE DOM:

- ✅ **Core signal CONFIRMED.** When a participant actually produced audio, its tile rendered the
  `IisKdb`/`jsname="QgSmzd"` widget (3 bars) and **dropped `gjg47c`**; silent/muted tiles carry
  `gjg47c`. So **speaking = the QgSmzd/`IisKdb` widget present AND not `.gjg47c`** — proven live.
  `jscontroller="ES310d"` confirmed (the `tae9tc`→`ES310d` correction was right); the other classes
  had rotated again (`KUNJSe x9nQ6`) → anchoring on `IisKdb`/`gjg47c` is correct.
- ✅ **Identity + naming CONFIRMED.** Both tiles carried `data-participant-id`; names read cleanly
  from `span.notranslate` ("Bibek Thapa", "QA Bob tone"). Caption-free naming works live.
- ❌ **`data-audio-level` ABSENT** on every tile in this build → **demoted** (kept only as an
  opportunistic first check; it no-ops when absent). It is NOT the reliable primary here.
- ❌ **`kssMZb` DROPPED as a speaking signal.** Live, `.kssMZb` was present on the **silent, muted
  host** tile and **absent on the remote** — a persistent structural class, not per-speech. It
  false-named the muted participant, so it is **removed from the detector's positive chain**
  (`detector.js` / `browser-qa/dom-detector.js`; tests updated; both harnesses still green).
- ⚠️ **Rig learning:** the fake-device **tone can get participants into a call but Meet does not treat
  a constant tone as speech** — only a real human voice exercised the indicator. And the guest join
  button stays `disabled` until the name field registers (fill name → then the button enables).

Net: the recommended primary (§2 item 2) is now **live-confirmed**; the chain below reflects the
corrections (no `data-audio-level` reliance, no `kssMZb` positive).

## 2.6 STRUCTURE instead of hardcoded class names (the durable read)

Live probing (`live/struct-probe.js`) showed the speaking read can be **fully class-independent**:

- **Anchor the tile:** `[data-participant-id]` (semantic, not a visual class).
- **Anchor the indicator (no class):** `[jsname="QgSmzd"]` — the stable framework handle shared by
  *both* widget variants (`jscontroller` differs: `ES310d` for the main equalizer, `YQvg8b` for the
  self-preview). Class-free fallback: **a `div` whose children are ≥3 tiny leaf `div` "bars"** (the
  equalizer shape).
- **Read SPEAKING structurally:** the bars carry a CSS keyframe **`animationName: "stripeJiggleAnimation"`**
  while talking, and the silent state sets **`animation-name: none`**. So
  **speaking = `getComputedStyle(bar).animationName !== 'none'`.** This survives class rotation — the
  silence *class* was observed live as `gjg47c` **and** `Oaajhc` on the same widget at different times,
  so reading any class token is fragile; the animation/structure is stable.
- **Geometry is gated:** it only runs when **no** indicator widget is observable (all pruned). If
  indicators are present but none animate, nobody is speaking → don't guess via the biggest tile
  (prevents false-firing on a pinned, silent main tile in sidebar/spotlight).

The detector (`browser-qa/dom-detector.js`) implements exactly this — `findIndicators()` +
`indicatorSpeaking()` use `jsname`/structure/computed-animation, no `IisKdb`/`gjg47c`. Real-browser QA
exercises it across **25 scenarios** including 3-people, **turn-wise** (sequential), **overlapping**
(2 and 3 simultaneous), and **sidebar/tiled** layouts (all green).

### Live findings this round (2026-07-03, session 2)
- ✅ **`stripeJiggleAnimation` / `[jsname="QgSmzd"]` / `[data-participant-id]` confirmed** as live,
  class-independent anchors.
- ⚠️ **`kssMZb` re-checked and rejected as real-time**: it was present on the self-preview tile at one
  moment and **absent (0/12)** minutes later on the same silent host — it comes and goes and never
  tracks live speech (fits the "sticky to focus/last-active, not per-utterance" theory). Stays dropped.
- ⚠️ **The fake-device TONE does not register as speech to Meet**: a clean mic-toggle test kept the
  widget silent (`gjg47c`, no bar animation) even when unmuted. So a true **live turn-wise/overlapping**
  test needs *recognized* speech — real humans, or a virtual-audio driver (BlackHole on macOS)
  streaming speech WAVs into each participant's mic.

### ✅ STRUCTURE-FIRST, token-free (2026-07-03, session 3 — live-measured)
Re-probed the live equalizer at 4 Hz through silent → real-speech → silent, on the
host's view of a speaking remote, and pinned the **exact structural signature** so the
detector can anchor on SHAPE with **no Google token at all**:
- **Widget:** a VISIBLE small **circle** — in-tile **28×28**, People-panel row **24×24**
  (`display:flex`, `border-radius:50%`) — holding **exactly 3 leaf `<div>` bars of 4×16px**.
- **`stripeJiggleAnimation` animates only `background-size`/`background-position`** (dumped
  from the live stylesheet), so the **bar boxes never change size while animating** — which is
  what lets the predicate require `barHeight ≥ barWidth` and reject square loading-dots.
- **Token-free predicate (`isEqualizerShape`)**: a displayed div, `0<w,h≤80`, aspect 0.5–2,
  **all** children are divs, **3–8** of them, each a leaf bar `0<barW≤12` and `barH≥barW`.
  Scanned **inside `[data-participant-id]` tiles only** (cheap + no owner-less matches).
  Live: matched **exactly** the real equalizers, **zero page-wide false positives** across
  silent/speaking/after (~44 scans).
- **Speaking read** = any bar's computed `animationName!=='none'` **OR** a running
  Web-Animations-API animation in the widget subtree (`element.animate()` never reflects into
  `getComputedStyle().animationName` — proven in Chrome 149 — so this guards a future WAAPI
  migration). When bars exist and none animate, the widget is **silent** (bars decide; the
  class read is only for the bars-less `DYfzY` self-meter variant).
- **Visibility is load-bearing:** a MUTED participant's widget stays in the DOM as
  `display:none`/0×0 (bars 0×0), and a hidden 0×0 junk div with several leaf children exists
  page-wide — both are excluded; hidden `jsname` widgets never name anyone (computed styles
  still resolve inside `display:none` subtrees, so a stale speaking class there could otherwise
  false-name).
- **Self tile (token-free):** the self `<video>` is **mirrored** (`transform: matrix(-1,…)`)
  and the self tile carries **no 3-bar equalizer** (only the empty meter) — either identifies
  self without a class or locale string. Exposed as `window.__meetParticipants()` (pid-keyed
  roster with `isSelf`).
- **jsname is now only a SUPPLEMENT** — `__ctx.structOnly` disables it entirely; `__ctx.holdMs`
  bridges the sub-second animation render gaps that cap raw per-poll detection at ~82–92%.

Hardened after an **adversarial review panel** (5 agents, 51 findings): fixed a Node
false-positive (silent token-free widget named via the class fall-through), tightened the
predicate (square-dot/segmented-strip/icon-font classes closed), added the WAAPI read, made
bars authoritative over the silence-class, and fixed hold-state hygiene. Node **23/23** and
real-browser **34/34** now include six structure-first scenarios (token-free discovery,
hidden-muted widget, out-of-tile animating lookalike, no-bars level-class, hidden-junk vs
geometry, and a **WAAPI-only** animation guard) plus a silent-token-free and a
hidden-stale-class regression. (2026-07-03 QA-review pass: added the WAAPI-only browser
scenario + hardened the Swift resolver — see §4.)

### ✅ LIVE END-TO-END CONFIRMED via BlackHole (2026-07-03)
Closed the live audio leg. With BlackHole 2ch as a virtual mic streaming speech clips into a guest,
and the **real class-independent detector** (`browser-qa/dom-detector.js`) injected into the **host's
live Meet DOM**, the detector correctly **named the guest as the turn-wise speaker 81–94%** of each
utterance and stayed quiet in the gaps — on a **camera-off remote**, zero class-name dependence:
```
Alice 94% · Bob 88% · Carol 81%  (detected_frac);  quiet_in_gap 0.67–0.83
```
The host-side diff (silent→speaking) of the remote tile:
`animEls: [] → ["stripeJiggleAnimation" ×3]`, silence class `gjg47c` removed / `Oaajhc` added — i.e. the
equalizer bars animate on the host's view of a speaking remote, exactly as the detector expects.
Pipeline proven: real speech → guest speaks → host DOM `[data-participant-id]` → `[jsname="QgSmzd"]`
bars `animationName==='stripeJiggleAnimation'` → detector names the speaker. Run:
`live/bh-final-confirm.js` (rig setup in `live/README.md`; requires the guest's Meet mic set to BlackHole).
Detection is ~81–94% (not 100%) due to render/animation latency — a short debounce/hold smooths it.

## 2.7 The "last active speaker" signal — useful, but NOT real-time

`kssMZb` is not a per-utterance speaking state, but it is not noise either — live it behaved like a
**last / recently-active speaker (or focus/spotlight) marker**:

- It **persists** on a tile after that person stops (does not clear per-utterance), and comes/goes with
  focus — present on the self-preview at one moment, absent (0/12) on the same silent host minutes
  later. So it lags speech and can sit on an "old" participant.
- Therefore it must **never** be a standalone real-time positive (that's the bug we removed). But as a
  **secondary/continuity signal it is genuinely useful**:
  - *Continuity between utterances:* when VAD says someone is speaking but no widget animates this exact
    tick (brief gap / render lag), the last-active tile is the best guess for "who's still holding the
    floor."
  - *Spotlight / pin / "current speaker" UI:* it tracks who Meet is emphasizing.
  - *Tie-break* among candidates.
- **How to use it safely:** VAD-gated, lowest priority, only to *sustain* or *disambiguate* an
  already-established speaker — never to originate one. Pseudocode:
  `speaker = structuralSpeaker() ?? (vadActive ? lastActive() : none)`.
- **Durable handle caveat:** `kssMZb` itself is an obfuscated, rotating class. If this signal is adopted,
  prefer a structural read of "last active" (e.g. the tile Meet keeps promoted/focused, or a persistent
  `aria`/geometry state) and keep `kssMZb` only as a remote-config'd hint. Marked as a **candidate
  secondary signal — not yet wired into the detector** (it needs its own live characterization: exactly
  when it sets/clears, and whether a non-class handle tracks it).

## 3. Fallback strategy (configurable; a rotation is a config edit)

Reference implementation: [`research/meet-dom-detector/detector.js`](../research/meet-dom-detector/detector.js).

```jsonc
{ "version": "2026-07-02", "vadGate": true, "someoneFloor": true,
  // Captions intentionally omitted.
  "strategies": [
    { "id": "dataAudioLevel", "anchor": { "dataAttrAny": ["data-audio-level"] },
      "speakingBy": { "dataAudioLevel": true } },
    { "id": "audioIndicator",
      "anchor": { "jsnameAny": ["QgSmzd"], "classAny": ["IisKdb"], "jscontrollerAny": ["ES310d","tae9tc"] },
      "speakingBy": { "computedAnimation": true, "barsAnimating": true,
                      "speakingIfNotIdle": true, "idleClassAny": ["gjg47c"],
                      "stateClassAny": ["HX2H7","Oaajhc","wEsLMd","OgVli"] } },
    { "id": "tileRing",   // ring MARKER only — a generic computed-outline read was rejected (see §4)
      "anchor": { "tileClassAny": ["oZRSLe"], "dataAttrAny": ["data-participant-id","data-requested-participant-id","data-ssrc"] },
      "speakingBy": { "classAny": ["kssMZb"] } },
    { "id": "cssClass", "classAny": ["kssMZb","Oaajhc","HX2H7","wEsLMd","OgVli"] },
    { "id": "geometry", "promotedRatio": 1.5, "suppressWhenPresenting": true }
  ],
  "tileIdentity": { "keyAttrs": ["data-participant-id","data-requested-participant-id","data-ssrc"],
                    "nameSelectors": ["span.notranslate",".zWGUib",".XWGOtd","[data-self-name]"] } }
```
Resolution: `VAD → dataAudioLevel → audioIndicator → tileRing → cssClass → geometry → "Someone"`.
Emit telemetry when the deciding signal is `cssClass` (brittle) or `someoneFloor` while VAD is active
(attribution gap → likely a rotation).

---

## 4. QA — tested in a real browser before implementing

Two levels; both green.

- **Node logic harness** — [`research/meet-dom-detector/test.js`](../research/meet-dom-detector/test.js): **23/23**
  (5 real captured-DOM + 2 real external current-widget + 15 synthetic), incl. surviving a class rotation,
  the real `jscontroller` rotation, and **structure-only anchoring with every token rotated away**
  (plus hidden-widget-not-anchored).
- **Real-browser QA** — [`research/meet-dom-detector/browser-qa/run-browser-qa.js`](../research/meet-dom-detector/browser-qa/run-browser-qa.js): **34/34**
  in headless Chrome against a faithful Meet-DOM simulator with **real `getComputedStyle`/`getBoundingClientRect`**
  (so the class-independent structural read — §2.6 — is genuinely exercised). Covers grid, spotlight
  (indicator + geometry), PiP, full-screen, muted (no FP), nobody-speaking, screen-share
  (suppress + with-indicator), join/leave, data-audio-level, two rotation proofs, `kssMZb`-not-a-signal,
  **3-people turn-wise (×3), overlapping (×2), sidebar/tiled (speaker + silent-no-FP)**, and the five
  **structure-first scenarios** (token-free discovery, hidden-muted widget, out-of-tile animating
  lookalike, no-bars level-class variant, hidden-junk-must-not-block-geometry).

**The real-browser QA caught a genuine bug the Node harness missed.** A *generic* "rotation-proof
computed outline / box-shadow" ring read false-fired on **every** tile in a real browser (default
styling has a non-`none` computed outline/shadow), wrongly returning all participants in four
scenarios. **Fix:** `tileRing` keys on the ring marker element (`.kssMZb`) only; the generic
computed-outline idea is rejected. This is exactly why real-browser testing was done before shipping.

---

## 5. Recall binary re-check ("check the Recall binary too")

Calibrated scan (`nm`+`swift-demangle` for symbols, per-file `strings`; calibrated against
`GoogleMeet` 3482 syms / `inferActiveSpeaker` 23) of Recall's shipping binary:

```
DOM tokens (strings AND symbols): data-audio-level 0 · QgSmzd 0 · ES310d 0 · IisKdb 0 · gjg47c 0
  kssMZb 0 · tae9tc 0 · data-participant-id 0 · data-ssrc 0 · tgaKEf 0 · NWpY1d 0 · oZRSLe 0
present: webrtc 72 · vad 31 · AXDOMClassList 1 · MixedVideoRect 2 · AXChildren 2
```
**Recall does NO DOM scraping for Meet** — not the old class, not captions, and **not the new
candidates here**. It uses audio-VAD + geometry (`MixedVideoRect`) + AX roster. So Recall validates the
**audio/geometry backbone**; the **DOM heads** above are validated by in-page bots (Vexa's
`data-audio-level`/`QgSmzd`). (An earlier uncalibrated `strings` pass wrongly read 0 for everything —
superseded.)

---

## 6. Live multi-party test rig

[`research/meet-dom-detector/live/`](../research/meet-dom-detector/live) — a turnkey rig so the live run
needs only a meeting URL + admitting joiners.
- `join-meet.js` — a speaker instance (headful; camera off; fake-device tone as mic).
- `observe-and-score.js` — an observer that injects the real detector and logs a who-is-speaking JSONL
  timeline against the live Meet DOM.
- `run-live-qa.sh` — orchestrates 1 observer + 2 speakers. `mic-check.{js,html}` — audio-path validator.

**Fake-audio finding (Chrome 149, validated):** `--use-fake-device-for-media-stream` (the built-in
**tone**) drives a real mic signal (`mic-check.js beep` → RMS ≈ 0.03). But
`--use-file-for-fake-audio-capture=<wav>` yields **silence** headless *and* headful even with a bare
canonical WAV — broken in this Chrome build. The rig uses the tone; who-speaks-when is controlled by
join/leave/mute. **Still manual:** creating a Meet needs Google sign-in and Meet blocks headless joins,
so joiners run headful and the host clicks *Admit*.

---

## 7. Does the accessibility tree expose these? (No.)

Verified in both AX dumps: `data-participant-id`, `data-ssrc`, `data-requested-participant-id`,
`data-audio-level`, `QgSmzd`, `IisKdb` → **0 hits**. `span.notranslate` is not selectable in AX (the
captured name leaf even had an empty class list). **But the name TEXT is exposed** as an `AXStaticText`
value — so caption-free naming still works on the AX surface via the text leaf + geometry climb, just
not via those selectors. The DOM signals in §2 therefore require a DOM capture surface on **both**
platforms.

---

## 8. Known limitations

1. **No live multi-party Meet run yet** — validated in a real browser against a faithful simulator +
   real captured DOM; the simulator is grounded in captured/external DOM but is not Google's live server
   DOM. The rig (§6) closes this with a meeting URL.
2. **DOM signals need a DOM surface** — unreachable by the shipping AX/UIA app without CDP/embedded-webview.
3. **2025 "Dynamic layouts"** made tiles non-uniform/cropped (`Auto` vs `Tiled`) → geometry is less
   reliable; two DOM shapes possible.
4. **Durable ≠ immortal** — we observed `jscontroller` rotate; even `jsname`/`data-*` could change. The
   design is a *chain* with runtime-config'd tokens + telemetry, not a lone selector.
5. **`kssMZb` semantics ambiguous** (stage background layer vs per-tile ring) — fallback only.
6. **`--use-file-for-fake-audio-capture` broken** in Chrome 149 — rig uses the tone.

---

## 9. Next steps
1. Run the rig (§6) on a live 2-person call (CC off); promote captured speaking/silent pairs into
   `fixtures.js` as `[REAL]` cases; re-run both harnesses.
2. If adopting on-platform: add a DOM capture surface (CDP / embedded webview) and wire the config in §3.
3. Keep `kssMZb` remote-config'd + telemetered; alert on `cssClass`/`someoneFloor` decisions.
