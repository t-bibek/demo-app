# Meet DOM active-speaker detector (research)

Class-name-independent, **caption-free** Google Meet active-speaker detection with a
configurable fallback chain. Companion to `~/.claude/google-meet-speaking-detection-analysis.md`
and `docs/meet-active-speaker-no-hardcoded-css.md`.

## Why
`kssMZb` (the current speaking-class) is an obfuscated CSS class Google rotates ~6 weeks.
This explores durable replacements. Key finding: the stable speaking signal lives in the
**raw DOM** (not the accessibility tree the native app reads today):

1. `[data-audio-level]:not([data-audio-level="0"])` — semantic attr (most durable).
2. audio widget `jsname="QgSmzd"` + `IisKdb`, speaking = **absence of `gjg47c`** / bars animate.
3. tile id `data-participant-id` (→ `data-requested-participant-id` → `data-ssrc`); name `span.notranslate`.
4. `.kssMZb` ring → remote-config fallback. Gate on VAD; "Someone" floor. **No captions.**

Anchor on `jsname`/`IisKdb`/`data-*`, **never** `jscontroller` (observed rotating `tae9tc`→`ES310d`)
or the obfuscated speaking class.

## Files
- `detector.js` — the configurable fallback-chain detector (`detectActiveSpeaker`, `DEFAULT_CONFIG`).
- `fixtures.js` — REAL (captured `meet-snippet.html`) + REAL-EXT (current live widget) + SYNTHETIC scenarios.
- `test.js` — Node scenario matrix → **23/23**.
- `cdp-capture.js` — zero-dependency CDP driver to dump a live Meet DOM for verification.
- `browser-qa/` — **real-browser QA**: `meet-sim.html` (faithful Meet-DOM simulator with real CSS
  animations), `dom-detector.js` (the real DOM detector), `run-browser-qa.js` (headless-Chrome CDP
  runner) → **33/33** with real `getComputedStyle`/`getBoundingClientRect`.
- `live/` — **live multi-party rig** (fake-audio tone + observer/speaker instances). See `live/README.md`.

## Run
```bash
node research/meet-dom-detector/test.js                       # Node logic harness (23/23)
node research/meet-dom-detector/browser-qa/run-browser-qa.js  # real-browser QA (33/33)
# live capture (Chrome started with --remote-debugging-port=9222):
node research/meet-dom-detector/cdp-capture.js 9222 > live-meet.html
```

## Status
Validated in a **real browser** across all layouts (33/33) and against real captured DOM incl. a real
class **and** jscontroller rotation. Real-browser QA caught + fixed a genuine bug (a generic
computed-outline ring read that false-fired on every tile). **Pending:** a live 2-person call
(captions OFF) via `live/` to confirm `data-audio-level` / the QgSmzd widget per-tile across
gallery/spotlight/PiP — see report §10.4.
