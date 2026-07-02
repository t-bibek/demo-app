# Live multi-party Meet test rig

Prepares a **real** Google Meet multi-party call so the detector is tested against
live DOM instead of assumptions. Caption-free. macOS + Chrome.

## What's autonomous vs. what needs you
| Step | Status |
|------|--------|
| Fake-audio source | ✅ validated — fake-device **tone** produces a real mic signal (`mic-check.js` → RMS ~0.03) |
| Detector correctness across layouts | ✅ validated in a real browser — `../browser-qa/run-browser-qa.js` (33/33) |
| Joining a real meeting + admitting participants | ⚠️ **needs you**: a meeting URL + clicking "Admit" (Google requires sign-in to *create* a meeting and blocks headless joins) |

## Fake-audio finding (Chrome 149, 2026-07-02)
- `--use-fake-device-for-media-stream` (built-in **tone**) → real mic signal (RMS ~0.03). **Use this.**
- `--use-file-for-fake-audio-capture=<wav>` → **silence**, headless *and* headful, even with a
  bare canonical `RIFF/WAVE/fmt/data` file. Broken in this Chrome build. `make-test-audio.sh`
  still generates WAVs for a future fix or a virtual audio device (BlackHole) route.

## Run
```bash
# 0) (optional) regenerate speech WAVs for a virtual-cable route
./make-test-audio.sh

# 1) prove the audio path (no Meet needed)
node mic-check.js beep                      # -> {"PASS": true}  (fake-device tone; the working source)
node mic-check.js                           # -> {"PASS": false} (file mode is silent in Chrome 149, by design)

# 2) live run — supply your meeting link, then Admit the joiners in your host window
MEETING_URL="https://meet.google.com/xxx-xxxx-xxx" DUR=90 ./run-live-qa.sh
#   -> writes observe-timeline.jsonl  (t, names, via)  every 500ms
```
`join-meet.js` = a speaker (fake tone, camera off). `observe-and-score.js` = the observer that
injects the real detector and logs the who-is-speaking timeline. Diff the timeline against the
order you had speakers join/leave (or mute/unmute) to score detection across grid/spotlight/PiP.

## Live turn-wise test with RECOGNIZED speech (BlackHole)
The fake tone is NOT treated as speech by Meet (validated), so a live speaking test needs real
recognized audio. `blackhole-live-test.js` streams speech WAVs into a guest's mic via a BlackHole
loopback device and confirms the detector tracks speaking/silent live.

```bash
# 1) install the virtual audio driver (needs your password), then make it active:
sudo installer -pkg /opt/homebrew/Caskroom/blackhole-2ch/*/BlackHole2ch-*.pkg -target /
sudo killall coreaudiod

# 2) have a host in the meeting (open-clean.js -> sign in -> watch-meeting.js), then:
node blackhole-live-test.js     # routes audio to BlackHole, joins a guest, plays clips turn-wise, scores
```
It saves/restores your default input+output devices. One BlackHole device = one recognized-speech
source → validates the real-time on/off transition for a single speaker; true multi-participant OVERLAP
needs a 2nd virtual device (BlackHole 16ch) — the simulator QA covers the overlap logic meanwhile.

## Files
- `cdp-lib.js` — shared zero-dep CDP launch/attach/eval helpers.
- `mic-check.html` / `mic-check.js` — fake-audio path validator.
- `join-meet.js` — join as a speaker and stay resident.
- `observe-and-score.js` — join as observer, inject detector, log timeline.
- `run-live-qa.sh` — orchestrate observer + 2 speakers.
- `make-test-audio.sh` + `audio/*.wav` — synthesized speech (for the file/virtual-cable route).
