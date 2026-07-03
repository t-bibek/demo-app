#!/usr/bin/env bash
# End-to-end virtual-mic -> Meet validation.
#
# ROOT CAUSE (2026-07-03): the BlackHole 2ch loopback is WEDGED (playback into it
# reaches the driver but 0 audio crosses to its capture side => ~-91 dB), while the
# machine's CoreAudio loopback is otherwise healthy (the "Microsoft Teams Audio"
# virtual device loops fine at ~-18 dB). BlackHole needs a privileged reload
# (`bash bh-fix.sh`, one sudo). The Teams Audio device is a working drop-in NOW,
# with no sudo — so this script defaults to it.
#
#   VIRT_MIC="Microsoft Teams Audio" bash bh-validate-e2e.sh   # works today (default)
#   VIRT_MIC="BlackHole 2ch"         bash bh-validate-e2e.sh   # after `bash bh-fix.sh`
#
# Prereqs: a signed-in HOST already in the meeting on CDP :9222 (reuse .live-profile;
# do NOT run open-clean.js — it WIPES the profile). Launch Chrome with the existing
# profile + the meeting URL, click Join, then run this.
set -uo pipefail
cd "$(dirname "$0")"
DEV="${VIRT_MIC:-Microsoft Teams Audio}"
export VIRT_MIC="$DEV"

echo "== [1/4] loopback gate for \"$DEV\" =="
if [ "$DEV" = "BlackHole 2ch" ]; then
  bash bh-loopback-check.sh || { echo "ABORT: BlackHole wedged. Run: bash bh-fix.sh (needs sudo)"; exit 1; }
fi

echo "== [2/4] cache audiotoolbox index -> \"$DEV\" =="
node find-audio-index.js "$DEV" || { echo "ABORT: \"$DEV\" loopback broken or missing"; exit 1; }
cat .audio-device-index; echo

echo "== [3/4] host presence check on :9222 =="
if ! curl -s http://127.0.0.1:9222/json | grep -q 'meet.google.com'; then
  echo "ABORT: no Meet tab on CDP :9222. Start the signed-in host (reuse .live-profile) and join the meeting first."
  exit 1
fi
echo "host tab present."

echo "== [4/4] join 2 guests + run structural HOST/GUEST/OVERLAP loop (mic=$DEV) =="
node join-guest.js "BH Speaker" 9318 || { echo "ABORT: guest 1 join failed"; exit 1; }
node join-guest.js "BH Two"     9320 || { echo "ABORT: guest 2 join failed"; exit 1; }
node struct-live-loop.js 4 600
