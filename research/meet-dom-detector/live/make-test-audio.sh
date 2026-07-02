#!/usr/bin/env bash
# Generate canonical PCM WAVs (mono/48k/Int16, no metadata chunks) of synthesized
# speech, one per fake participant.
#
# IMPORTANT (validated 2026-07-02, Chrome 149): --use-file-for-fake-audio-capture
# does NOT play these files (headless OR headful) — it yields silence, while the
# fake-DEVICE tone (--use-fake-device-for-media-stream, no file) DOES produce audio
# (RMS ~0.03). So the rig uses the tone as its audio source. These WAVs are kept
# for (a) a future Chrome that fixes the flag, or (b) routing through a virtual
# audio device (e.g. BlackHole) as a real mic.
set -euo pipefail
cd "$(dirname "$0")/audio"
gen() { # name text
  say -o "/tmp/$1.aiff" "$2"
  ffmpeg -y -loglevel error -i "/tmp/$1.aiff" -map_metadata -1 -flags +bitexact -fflags +bitexact \
    -ar 48000 -ac 1 -c:a pcm_s16le "$1.wav"
  rm -f "/tmp/$1.aiff"
  echo "  wrote $1.wav"
}
gen Alice "Alice here, one two three four five six seven eight nine ten."
gen Bob   "This is Bob talking now, testing one two three four five."
gen Carol "Carol speaking, the quick brown fox jumps over the lazy dog."
echo "done."
