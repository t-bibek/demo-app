#!/usr/bin/env bash
# BlackHole loopback health check — pure CoreAudio, no Meet.
# Plays a 1.5s tone INTO "BlackHole 2ch" (audiotoolbox output) while capturing
# FROM "BlackHole 2ch" (avfoundation input), and reports the captured dB.
# PASS  => loopback carries signal (max_volume > -50 dB)
# FAIL  => wedged at ~-91 dB  -> run the sudo reload in bh-fix.sh
set -uo pipefail
TMP="${TMPDIR:-/tmp}"
CAP="$TMP/bh-loopback-$$.wav"

# resolve audiotoolbox OUTPUT index for "BlackHole 2ch"
# lines look like: [AudioToolbox @ 0x..] [1]  BlackHole 2ch, UID  -> take the LAST [n]
IDX=$(ffmpeg -hide_banner -f lavfi -i "sine=frequency=440:duration=0.05" \
        -f audiotoolbox -list_devices true - 2>&1 \
      | grep 'BlackHole 2ch' | grep -oE '\[[0-9]+\]' | tr -d '[]' | head -1)
if [ -z "${IDX:-}" ]; then echo "FAIL: BlackHole 2ch not enumerated by CoreAudio"; exit 2; fi

# resolve avfoundation INPUT index for "BlackHole 2ch"
AVF=$(ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 \
      | grep 'audio devices' -A20 | grep 'BlackHole 2ch' | grep -oE '\[[0-9]+\]' | tr -d '[]' | head -1)
AVF="${AVF:-0}"

ffmpeg -hide_banner -loglevel error -f avfoundation -i ":$AVF" -t 2.0 -y "$CAP" 2>/dev/null &
REC=$!
sleep 0.25
ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=880:duration=1.5" \
  -f audiotoolbox -audio_device_index "$IDX" - 2>/dev/null
wait $REC
DB=$(ffmpeg -hide_banner -i "$CAP" -af volumedetect -f null - 2>&1 | awk -F': ' '/max_volume/{print $2}')
rm -f "$CAP"
echo "BlackHole loopback: audiotoolbox_out_idx=$IDX avf_in_idx=$AVF captured max_volume=${DB:-<none>}"
NUM=$(printf '%s' "${DB:-'-91.0 dB'}" | grep -oE '\-?[0-9.]+' | head -1)
if [ -n "$NUM" ] && awk "BEGIN{exit !($NUM > -50)}"; then
  echo "PASS: BlackHole loopback carries signal."
  exit 0
fi
echo "FAIL: BlackHole loopback is wedged (silence). Run:  bash bh-fix.sh"
exit 1
