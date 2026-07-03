#!/usr/bin/env bash
# Generate the DISTINCT host/guest speech WAVs the fake-audio rig serves as each
# Chrome's microphone (via the getUserMedia override in fake-mic-override.js).
# Format: 48kHz mono 16-bit PCM — decodeAudioData-friendly. Distinct voices +
# distinct words so the two speakers are unmistakable to a human and to Meet's VAD.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p fake-audio
gen() { # name voice text
  local name="$1" voice="$2" text="$3"
  say -v "$voice" -o "/tmp/$name.aiff" "$text" 2>/dev/null || say -o "/tmp/$name.aiff" "$text"
  ffmpeg -y -loglevel error -i "/tmp/$name.aiff" -ar 48000 -ac 1 -c:a pcm_s16le -map_metadata -1 "fake-audio/$name.wav"
  rm -f "/tmp/$name.aiff"
  echo "  wrote fake-audio/$name.wav"
}
gen host  Daniel   "This is the host speaking. Host host host. One two three four five. The host is talking now clearly."
gen guest Samantha "Guest here, this is the guest speaking. Guest guest guest. Six seven eight nine ten. The guest is talking clearly."
# Third DISTINCT voice for the 3-party rig's second guest (Guest Bravo).
# Karen is a clearly different timbre from Samantha so a human + Meet's VAD can tell
# Alpha (guest.wav) and Bravo (guest2.wav) apart during rapid swaps/overlap. The rig
# prefers guest2.wav for Bravo and falls back to the older guestb.wav if it's absent.
gen guest2 Karen    "Bravo speaking here, this is the second guest. Bravo bravo bravo. Eleven twelve thirteen fourteen fifteen. Bravo is talking clearly."
echo "done."
