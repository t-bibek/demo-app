#!/bin/bash
# stuckfix-1to1-bursts.sh — FIX-PROOF driver for the 765s stuck-segment defect
# (app smoke 2026-07-05): 1:1 Meet rig (host + Guest Alpha, Bravo already left),
# guest speaks 2 bursts (~8s) with ~20s silence gaps while the PRODUCT detector
# binary runs directly (no Electron). Scratch script; safe to delete.
cd "$(dirname "$0")" || exit 1
echo "[stuckfix] start $(date -u +%FT%TZ)"
sleep 15   # detector discovery + baseline silence window
for i in 1 2; do
  echo "[stuckfix] burst $i ON  $(date -u +%FT%TZ)"
  node p8-ctl.js speak alpha on
  sleep 8
  echo "[stuckfix] burst $i OFF $(date -u +%FT%TZ)"
  node p8-ctl.js speak alpha off
  echo "[stuckfix] probe-at-off $(date -u +%FT%TZ)"
  node p8-ctl.js probe
  sleep 20
  echo "[stuckfix] probe-silent-$i $(date -u +%FT%TZ)"
  node p8-ctl.js probe
done
echo "[stuckfix] long-silence tail (60s) $(date -u +%FT%TZ)"
sleep 60
echo "[stuckfix] probe-final $(date -u +%FT%TZ)"
node p8-ctl.js probe
echo "[stuckfix] complete $(date -u +%FT%TZ)"
