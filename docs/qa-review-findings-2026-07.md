# QA-suite review — findings, adopted fixes, and deferred follow-ups (2026-07-03)

An independent agent audited the **quality of the QA checks themselves** (not just their
pass/fail) across the three suites that gate Meet active-speaker detection:

- Node logic harness — `research/meet-dom-detector/{test.js,fixtures.js,detector.js}`
- Real-browser QA — `research/meet-dom-detector/browser-qa/{run-browser-qa.js,dom-detector.js,meet-sim.html}`
- Swift self-test — `macos/Sources/SpeakerCoreSelfTest/main.swift` → `SpeakerCore/MeetActiveSpeaker.swift`

Baseline before this pass: Node **23/23**, browser **33/33**, Swift **ALL PASSED**. All green —
but green substantially overstated confidence. The review found one **real latent defect** and a
set of dark/weak paths.

---

## 1. Real defect found and fixed — Swift ring path named `self`

**`MeetActiveSpeaker.swift` ring step** filtered `tiles.filter { $0.classSpeaking }` with **no
`!$0.isMe`** — unlike the focused path (`$0.isFocused && !$0.isMe`) and the geometry path
(`?.isMe != true`), which both exclude self. The doc comment *asserts* "your own tile never gets
the ring," and the whole design attributes self via the mic separately — but the resolver leaned
entirely on that empirical claim. If a self tile ever carried `kssMZb` (or a remote-config rule
matched a self class), the resolver would name the **local user** as the active speaker, and **no
test covered it**.

**Fix:** `ringNames = tiles.filter { $0.classSpeaking && !$0.isMe }` — defense-in-depth, now
consistent with the other two attribution paths and overlap-safe (a self ring alongside a remote
ring still returns the remote).

**Regression guard:** `ring on SELF only -> not named (falls to Someone floor)` — this assertion
**fails against the pre-fix code** (returned `["Me"]`), so it locks the fix.

---

## 2. Adopted improvements (reflected in the suite now)

Suite counts after this pass: Node **23/23**, browser **34/34**, Swift **ALL PASSED (+12)**.

**Swift `SpeakerCoreSelfTest` — 12 new assertions:**
- `ring on SELF only -> not named` + `-> via someoneFloor` (the P0 guard above)
- `ring on self + remote -> only remote named` (overlap self-exclusion)
- `concurrent rings -> both remotes named (overlap)` — the set-return at the ring line; every
  prior fixture had exactly one ring tile
- `geometry 1.49x (below 1.5x) -> Someone floor` **and** `geometry exactly 1.5x -> promoted` +
  `-> via geometry` — both sides of the promote-ratio boundary (only 20× was tested before, so a
  Meet tile-sizing change could slip through silently)
- `self is the dominant tile -> geometry skips self -> Someone floor` — the self-geometry
  exclusion branch, previously uncovered

**Browser QA — 1 new scenario (`waapi-only-animation`):**
- Bars animate via `element.animate()` (Web Animations API) instead of CSS `@keyframes`, so
  `getComputedStyle(bar).animationName === 'none'`. **Only** the detector's
  `getAnimations({subtree:true})` union catches it. This guards against a *silent total failure*
  if Google migrates Meet's equalizer to WAAPI — the branch (`dom-detector.js` speaking read) had
  zero coverage despite being added specifically to prevent that failure mode. Speaking Alice is
  named; the un-animated Bob is not.

Baseline references bumped 33/33 → 34/34 in the README, the CI workflow, and both docs.

---

## 3. Findings documented but deliberately NOT adopted (with rationale)

These are real observations, but "fixing" each would either change shipping behavior in a way that
isn't clearly correct, or expand a harness beyond what this pass should touch. Recorded as
prioritized follow-ups rather than silently adopted.

| # | Finding | Why deferred |
|---|---|---|
| a | **No-bars widget + rotated `gjg47c` could false-name** (`detector.js` `speakingIfNotIdle`, and `dom-detector.js` `SILENCE_CLASSES` last-resort). If the silence token rotates, absence-of-`gjg47c` reads as speaking. | A **documented design trade-off**, not a bug: the DYfzY no-bars self-meter has no other signal. Making it safe removes that capability. The **bars-present** silent case *is* already guarded (`detector.js` "BARS DECIDE" + `structural-anchor-no-tokens-silent`). Needs a product decision, not a unilateral test-lock. |
| b | **`holdMs` speech-hold logic is untested** (`dom-detector.js` hold-state map, expiry, "hold off → drop stale" branch). | Stateful cross-poll logic — the thing most likely to leak a stale name. Testing it needs injectable time (`Date.now()`) in the sim harness; worth doing next, but a harness change, not a scenario add. **P1 follow-up.** |
| c | **`window.__meetParticipants()` roster fn + `isSelfTile` mirror-video / no-bar-widget discriminators are entirely uncovered.** | The QA harness only exercises `__meetDetect`, never the roster fn. The "strongest" (token-free, locale-free) self discriminators are dark. Requires extending `run-browser-qa.js` to assert roster output. **P1 follow-up.** |
| d | **`isEqualizerShape` thresholds only tested at their comfortable center** (bars 3×12, container 28×28). No boundary probe (13px bar, 81px container, 3:1 strip). | Detector already rejects these correctly; adding boundary-FP scenarios is pure hardening. **P2 follow-up.** |
| e | **`kssmzb-not-a-signal` (Node) passes trivially** — `detector.js` has no kssMZb strategy, so the token is simply unreferenced; the fixture is documentation, not a regression guard. | True, but harmless. Could be strengthened to give the ring node a real speaking-looking signal (e.g. `computed.outlineWidth`) and assert it's still not named. **P3 follow-up.** |
| f | **`data-audio-level` browser scenario asserts an ordering artifact** — Alice's widget is silent, so it passes only because stage 1 fires before the structural stage. | Correct behavior, weak reasoning. **P3.** |

None of (a)–(f) represents a behavior the shipping code gets *wrong* today (unlike §1); they are
coverage/robustness gaps. The single highest-value item — §1 — is fixed and guarded.

---

## 4. Bottom line

- One real defect (self-naming on the ring path) **fixed + regression-guarded**.
- Highest-value dark path (WAAPI migration) now covered.
- Boundary/overlap/self-exclusion assertions added to the Swift resolver.
- Remaining gaps are documented above as ranked follow-ups; none are shipping-behavior bugs.
