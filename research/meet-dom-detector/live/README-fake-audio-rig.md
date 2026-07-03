# Device-free fake-audio Meet rig (Agent B / "Blackbox")

A re-runnable harness that injects **distinct HOST and GUEST synthetic speech** into
a live Google Meet and validates active-speaker detection — with **no virtual audio
device, no AEC, no BlackHole**.

## Why not `--use-file-for-fake-audio-capture`?
That flag (the "obvious" way to feed a WAV as the mic) is **broken in Chrome 149**:
it yields silence in every format (48k/16k/mono/stereo), headless *and* headful.
Reproduce: `node fake-file-probe.js fake-audio/host_48k_mono.wav headful` → `maxRMS:0`.
Control (fake-device tone works): `node mic-check.js beep` → `maxRMS ~0.036`. So the
file route is a dead end on this build.

## How this rig injects audio instead
A CDP-installed **getUserMedia override** (`fake-mic-override.js`) runs before Meet
touches the mic (`Page.addScriptToEvaluateOnNewDocument`, survives navigations). It:
1. base64-embeds a real speech WAV, decodes it with `decodeAudioData`,
2. loops it through `BufferSource -> GainNode -> MediaStreamDestination`,
3. monkeypatches `navigator.mediaDevices.getUserMedia({audio})` to return that stream.

Each Chrome gets its OWN WAV, so HOST and GUEST are distinct speakers. Real decoded
voice (not a pure tone) → Meet's VAD registers it as speech. Turns are gated two
ways per seat: `window.__fakeMicSpeak(true|false)` (in-page speech gain) **and** the
Meet mic mute button.

Self-check the audio path (no Meet): `node fake-mic-selfcheck.js host` → decodes,
`rms_speak ~0.23`. `node gum-override-probe.js 440` proves the override yields a live
mic RMS (~0.24).

## Run
```bash
cd research/meet-dom-detector/live

# 0) one-time setup (idempotent)
./make-fake-speech.sh          # -> fake-audio/host.wav, fake-audio/guest.wav (distinct voices)
./make-rig-profile.sh          # -> .rig-profiles/host = lean COPY of signed-in .live-profile

# 1) run the full rig (host + guest join, admit, drive turns, validate)
node fake-audio-rig.js new "Fake Guest"     # host CREATES a fresh room (recommended)
#    or against an existing room:
node fake-audio-rig.js "https://meet.google.com/xxx-xxxx-xxx" "Fake Guest"
#    (defaults: meeting = ./.meeting-url, guest name = "Fake Guest")
```
Prints each turn's cross-observed detection and a final `VERDICT: PASS|REVIEW`; also
writes `fake-audio-rig-results.json`. Ports: **9224** (host) / **9225** (guest) —
chosen to avoid Agent A on 9222/9223. Use `new` when another seat of the same Google
account is already in the target room (a duplicate host seat shows "Join here too"
and muddies attribution); a fresh room sidesteps it.
The host uses the signed-in profile; the guest is a fresh anonymous temp profile
that types a distinct name ("Fake Guest") and is admitted from the host window.
Windows stay open at the end for inspection (Ctrl-C to tear down). Results are
written to `fake-audio-rig-results.json`.

## Validation model (important)
Validate by **cross-observation**: the HOST detector names the GUEST tile, and the
GUEST detector names the HOST tile. Meet renders **no** strong equalizer on your OWN
self-tile, so a seat cannot reliably detect *itself* — always read the other side.
Injected oracle = the real DOM detector (`../browser-qa/dom-detector.js`,
`window.__meetDetect()`).

### Last validated result — committed rig, one command, fresh room (2026-07-03)
`node fake-audio-rig.js new "Fake Guest"` → **VERDICT: PASS**

| Turn | host names GUEST | guest names HOST |
|------|:--:|:--:|
| SILENCE | 0.0 | 0.0 |
| HOST speaks | 0.0 | **1.0** |
| GUEST speaks | **1.0** | 0.0 |
| OVERLAP | **1.0** | **1.0** |
| SILENCE | 0.0 | 0.0 |

Each speaker's fake WAV is transmitted to the far side and named by the detector;
turns gate cleanly on/off; overlap names both; silence is quiet on both sides.
Pass `new` as the meeting arg to have the host create its own fresh room (avoids
contention when another seat of the same account is already in a shared meeting);
otherwise pass a meeting URL.

## Files
- `fake-audio-rig.js` — the harness (launch → join → admit → turns → validate).
- `fake-mic-override.js` — builds the WAV-backed getUserMedia override.
- `make-fake-speech.sh` — generates `fake-audio/host.wav` + `guest.wav`.
- `make-rig-profile.sh` — builds `.rig-profiles/host` from `.live-profile` (lean copy).
- `fake-mic-selfcheck.js` / `gum-override-probe.js` — prove the audio path (no Meet).
- `fake-file-probe.js` — demonstrates `--use-file-for-fake-audio-capture` is silent.

## Gotchas encoded in the code (learned live)
- **HOST** window: join via **real CDP mouse click** (`Input.dispatchMouseEvent`);
  `el.click()` no-ops on Meet's join/host controls.
- **GUEST** window: the reverse — coordinate CDP clicks do NOT land; use `el.click()`.
- Same Google account joining twice collapses to ONE `data-participant-id` ("Join
  here too" companion mode) → indistinguishable. Use an **anonymous** guest with a
  distinct typed name for two real identities.
- Anonymous "Ask to join" is rejected if the host is not yet fully in the call —
  join the host and confirm `leave call` before the guest asks.
